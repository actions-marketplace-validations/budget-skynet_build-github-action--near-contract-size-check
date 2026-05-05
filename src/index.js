async function step_build_contract(contract_path) {
  core.startGroup('Step 1 — Build Contract WASM');
  const abs = path.resolve(contract_path);

  // If already a WASM file, skip build
  if (contract_path.endsWith('.wasm') && fs.existsSync(abs)) {
    core.info(`Input is a prebuilt WASM file: ${abs}`);
    core.endGroup();
    return { built: false, contract_dir: path.dirname(abs) };
  }

  if (!fs.existsSync(abs)) {
    throw new Error(`Contract path does not exist: ${abs}`);
  }

  // Detect project type
  const has_cargo = fs.existsSync(path.join(abs, 'Cargo.toml'));
  const has_package_json = fs.existsSync(path.join(abs, 'package.json'));
  const has_build_sh = fs.existsSync(path.join(abs, 'build.sh'));
  const has_makefile = fs.existsSync(path.join(abs, 'Makefile'));

  if (has_build_sh) {
    core.info('Detected build.sh — using it');
    run_cmd(`chmod +x "${path.join(abs, 'build.sh')}" && "${path.join(abs, 'build.sh')}"`, {
      cwd: abs,
    });
  } else if (has_makefile) {
    const make_res = try_run_cmd('make build', { cwd: abs });
    if (!make_res.ok) {
      core.warning('make build failed, trying make');
      run_cmd('make', { cwd: abs });
    }
  } else if (has_cargo) {
    core.info('Detected Rust/Cargo project');

    // Ensure wasm32 target
    const rustup_check = try_run_cmd('rustup target list --installed');
    if (rustup_check.ok && !rustup_check.output.includes('wasm32-unknown-unknown')) {
      core.info('Adding wasm32-unknown-unknown target');
      run_cmd('rustup target add wasm32-unknown-unknown');
    }

    // Try cargo-near first, then plain cargo
    const cargo_near_check = try_run_cmd('cargo near --version');
    if (cargo_near_check.ok) {
      core.info('Using cargo-near build');
      const near_build_res = try_run_cmd('cargo near build --release', { cwd: abs });
      if (!near_build_res.ok) {
        core.warning('cargo-near build failed, falling back to cargo build');
        run_cmd('cargo build --target wasm32-unknown-unknown --release', { cwd: abs });
      }
    } else {
      core.info('Using cargo build --target wasm32-unknown-unknown --release');
      run_cmd('cargo build --target wasm32-unknown-unknown --release', { cwd: abs });
    }
  } else if (has_package_json) {
    core.info('Detected Node.js project (AssemblyScript / near-sdk-js)');
    const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};

    if (scripts.build) {
      const pm = fs.existsSync(path.join(abs, 'yarn.lock')) ? 'yarn' : 'npm';
      run_cmd(`${pm} install`, { cwd: abs });
      run_cmd(`${pm} run build`, { cwd: abs });
    } else {
      throw new Error(
        'No build script found in package.json. Add a "build" script or use a build.sh.'
      );
    }
  } else {
    throw new Error(
      `Cannot determine how to build contract at ${abs}. ` +
        'Expected Cargo.toml, package.json, build.sh, or Makefile.'
    );
  }

  core.info('Build completed successfully');
  core.endGroup();
  return { built: true, contract_dir: abs };
}

// ─── step 2: check size against limits ──────────────────────────────────────

async function step_check_size(contract_path, size_limit_kb, warning_threshold_percent) {
  core.startGroup('Step 2 — Check Contract Size Against Limits');

  const wasm_files = locate_wasm(contract_path);

  if (wasm_files.length === 0) {
    throw new Error(
      `No WASM files found for contract at: ${contract_path}\n` +
        'Make sure the contract builds successfully before running this action.'
    );
  }

  core.info(`Found ${wasm_files.length} WASM file(s):`);
  wasm_files.forEach(f => core.info(`  ${f}`));

  const limit_bytes = size_limit_kb * 1024;
  const warning_bytes = limit_bytes * (warning_threshold_percent / 100);

  const results = wasm_files.map(wasm_path => {
    const stat = fs.statSync(wasm_path);
    const size_bytes = stat.size;
    const size_kb = bytes_to_kb(size_bytes);
    const pct_of_limit = (size_bytes / limit_bytes) * 100;
    const over_limit = size_bytes > limit_bytes;
    const over_warning = size_bytes > warning_bytes;

    core.info(`\nFile: ${path.basename(wasm_path)}`);
    core.info(`  Size: ${format_size(size_bytes)} (${size_kb.toFixed(2)} KB)`);
    core.info(`  Limit: ${format_size(limit_bytes)} (${size_limit_kb} KB)`);
    core.info(`  Usage: ${pct_of_limit.toFixed(1)}% of limit`);
    core.info(`  Warning threshold: ${warning_threshold_percent}% (${format_size(warning_bytes)})`);

    if (over_limit) {
      core.error(`❌ OVER LIMIT: ${path.basename(wasm_path)} exceeds the ${size_limit_kb} KB limit`);
    } else if (over_warning) {
      core.warning(
        `⚠️  APPROACHING LIMIT: ${path.basename(wasm_path)} is at ${pct_of_limit.toFixed(1)}% of limit`
      );
    } else {
      core.info(`✅ Within limits (${pct_of_limit.toFixed(1)}% of limit)`);
    }

    return {
      wasm_path,
      size_bytes,
      size_kb,
      pct_of_limit,
      over_limit,
      over_warning,
    };
  });

  // Set outputs
  const primary = results[0];
  core.setOutput('contract_size_bytes', primary.size_bytes);
  core.setOutput('contract_size_kb', primary.size_kb.toFixed(2));
  core.setOutput('size_limit_kb', size_limit_kb);
  core.setOutput('size_percentage', primary.pct_of_limit.toFixed(1));
  core.setOutput('over_limit', primary.over_limit.toString());
  core.setOutput('over_warning', primary.over_warning.toString());
  core.setOutput('wasm_path', primary.wasm_path);

  core.endGroup();
  return { results, primary, limit_bytes, warning_bytes, size_limit_kb, warning_threshold_percent };
}

// ─── step 3: compare with previous builds ───────────────────────────────────

async function step_compare_with_branch(
  contract_path,
  compare_with_branch,
  current_size_bytes,
  fail_on_size_increase
) {
  core.startGroup(`Step 3 — Compare With Branch: ${compare_with_branch}`);

  const ctx = get_github_context();
  let baseline_size_bytes = null;
  let comparison_result = null;

  // Method 1: Try to fetch baseline via git stash / checkout approach
  const temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'near-baseline-'));

  try {
    // Check if the branch exists remotely
    const fetch_res = try_run_cmd(
      `git fetch origin ${compare_with_branch} --depth=1 2>&1`,
      { cwd: ctx.workspace }
    );

    if (!fetch_res.ok) {
      core.warning(`Could not fetch branch '${compare_with_branch}': ${fetch_res.error}`);
      core.info('Skipping size comparison — branch not available');
      core.endGroup();
      return { compared: false, reason: 'branch_not_found' };
    }

    // Get the WASM from the baseline branch by checking out into temp dir
    const clone_res = try_run_cmd(
      `git worktree add "${temp_dir}" origin/${compare_with_branch} 2>&1`,
      { cwd: ctx.workspace }
    );

    if (!clone_res.ok) {
      // Fallback: try sparse clone
      core.warning('git worktree failed, trying alternative approach');
      try_run_cmd(
        `git clone --depth=1 --branch ${compare_with_branch} ` +
          `"${ctx.server_url}/${ctx.repo}.git" "${temp_dir}" 2>&1`
      );
    }

    // Try to find existing wasm in the baseline (without building)
    const rel_contract = path.relative(ctx.workspace, path.resolve(contract_path));
    const baseline_contract_dir = path.join(temp_dir, rel_contract);

    let baseline_wasm_files = locate_wasm(baseline_contract_dir);

    // If no pre-built WASM exists in baseline, try to build it
    if (baseline_wasm_files.length === 0 && fs.existsSync(baseline_contract_dir)) {
      core.info('No pre-built WASM in baseline — attempting to build baseline contract');
      try {
        await step_build_contract(
          contract_path.endsWith('.wasm') ? baseline_contract_dir : baseline_contract_dir
        );
        baseline_wasm_files = locate_wasm(baseline_contract_dir);
      } catch (build_err) {
        core.warning(`Could not build baseline contract: ${build_err.message}`);
      }
    }

    if (baseline_wasm_files.length > 0) {
      const baseline_stat = fs.statSync(baseline_wasm_files[0]);
      baseline_size_bytes = baseline_stat.size;

      const delta_bytes = current_size_bytes - baseline_size_bytes;
      const delta_kb = bytes_to_kb(delta_bytes);
      const delta_pct = baseline_size_bytes > 0
        ? ((delta_bytes / baseline_size_bytes) * 100).toFixed(2)
        : 'N/A';

      comparison_result = {
        baseline_size_bytes,
        baseline_size_kb: bytes_to_kb(baseline_size_bytes).toFixed(2),
        delta_bytes,
        delta_kb: delta_kb.toFixed(2),
        delta_pct,
        increased: delta_bytes > 0,
        decreased: delta_bytes < 0,
        unchanged: delta_bytes === 0,
      };

      core.info(`\nBaseline (${compare_with_branch}): ${format_size(baseline_size_bytes)}`);
      core.info(`Current:                         ${format_size(current_size_bytes)}`);

      if (delta_bytes > 0) {
        core.warning(
          `📈 Size INCREASED by ${format_size(Math.abs(delta_bytes))} (+${delta_pct}%) ` +
            `compared to ${compare_with_branch}`
        );
      } else if (delta_bytes < 0) {
        core.info(
          `📉 Size DECREASED by ${format_size(Math.abs(delta_bytes))} (${delta_pct}%) ` +
            `compared to ${compare_with_branch}`
        );
      } else {
        core.info(`↔️  Size UNCHANGED compared to ${compare_with_branch}`);
      }

      core.setOutput('baseline_size_bytes', baseline_size_bytes);
      core.setOutput('baseline_size_kb', bytes_to_kb(baseline_size_bytes).toFixed(2));
      core.setOutput('size_delta_bytes', delta_bytes);
      core.setOutput('size_delta_kb', delta_kb.toFixed(2));
      core.setOutput('size_increased', comparison_result.increased.toString());
    } else {
      core.info('No baseline WASM found — this may be the first build');
    }
  } catch (err) {
    core.warning(`Comparison failed: ${err.message}`);
  } finally {
    // Cleanup worktree
    try {
      try_run_cmd(`git worktree remove "${temp_dir}" --force 2>&1`, { cwd: ctx.workspace });
    } catch {}
    try {
      fs.rmSync(temp_dir, { recursive: true, force: true });
    } catch {}
  }

  // Fail on size increase if configured
  if (
    fail_on_size_increase &&
    comparison_result &&
    comparison_result.increased
  ) {
    throw new Error(
      `Contract size increased by ${format_size(Math.abs(comparison_result.delta_bytes))} ` +
        `(${comparison_result.delta_pct}%) compared to ${compare_with_branch}. ` +
        'Set fail_on_size_increase=false to allow size increases.'
    );
  }

  core.endGroup();
  return { compared: true, comparison_result, baseline_size_bytes };
}

// ─── step 4: suggest optimizations ──────────────────────────────────────────

async function step_suggest_optimizations(
  check_results,
  comparison_result,
  contract_path,
  size_limit_kb,
  warning_threshold_percent
) {
  core.startGroup('Step 4 — Optimization Suggestions');

  const primary = check_results.primary;
  const suggestions = [];
  const wasm_path = primary.wasm_path;
  const size_bytes = primary.size_bytes;

  // ── Analyze WASM binary for patterns ──

  // Check if wasm-opt is available
  const wasm_opt_check = try_run_cmd('wasm-opt --version');
  const has_wasm_opt = wasm_opt_check.ok;

  // Check if wasm-strip/wasm-tools is available
  const wasm_strip_check = try_run_cmd('wasm-strip --version');
  const has_wasm_strip = wasm_strip_check.ok;

  // Try to get wasm-opt size estimate
  let optimized_estimate = null;
  if (has_wasm_opt) {
    const opt_out = path.join(os.tmpdir(), `optimized_${Date.now()}.wasm`);
    const opt_res = try_run_cmd(
      `wasm-opt -Oz --strip-debug --strip-producers -o "${opt_out}" "${wasm_path}"`
    );
    if (opt_res.ok && fs.existsSync(opt_out)) {
      const opt_stat = fs.statSync(opt_out);
      optimized_estimate = opt_stat.size;
      const savings = size_bytes - optimized_estimate;
      if (savings > 0) {
        suggestions.push({
          priority: 'HIGH',
          category: 'wasm-opt',
          title: 'Run wasm-opt for automatic size reduction',
          detail:
            `wasm-opt -Oz can reduce your contract by ~${format_size(savings)} ` +
            `(estimated ${format_size(optimized_estimate)} after optimization).\n` +
            'Add to your build script:\n' +
            '