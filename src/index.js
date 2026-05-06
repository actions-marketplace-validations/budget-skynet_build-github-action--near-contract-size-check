async function stepBuildContract(contractPath, optimizationLevel) {
  core.startGroup('📦 Step 1 – Build contract WASM');

  const resolvedPath = path.resolve(contractPath);
  core.info(`Contract path: ${resolvedPath}`);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`contract_path does not exist: ${resolvedPath}`);
  }

  // Determine if the path is a .rs file or a directory (Cargo project)
  let projectDir;
  if (fs.statSync(resolvedPath).isFile() && resolvedPath.endsWith('.rs')) {
    projectDir = path.dirname(resolvedPath);
    // Walk up to find Cargo.toml
    let dir = projectDir;
    while (dir !== path.parse(dir).root) {
      if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
        projectDir = dir;
        break;
      }
      dir = path.dirname(dir);
    }
  } else {
    projectDir = resolvedPath;
  }

  core.info(`Project directory: ${projectDir}`);

  if (!fs.existsSync(path.join(projectDir, 'Cargo.toml'))) {
    throw new Error(`No Cargo.toml found in ${projectDir}`);
  }

  // Read Cargo.toml to extract package name
  const cargoTomlContent = fs.readFileSync(path.join(projectDir, 'Cargo.toml'), 'utf8');
  const nameMatch = cargoTomlContent.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (!nameMatch) throw new Error('Could not determine crate name from Cargo.toml');
  const crateName = nameMatch[1];
  core.info(`Crate name: ${crateName}`);

  // Ensure Rust / cargo is available
  if (!commandExists('cargo')) {
    throw new Error('cargo is not installed or not on PATH');
  }
  const rustVersion = execOrThrow('rustc --version');
  core.info(`Rust version: ${rustVersion}`);

  // Ensure wasm32 target is installed
  core.info('Ensuring wasm32-unknown-unknown target is installed…');
  execOrThrow('rustup target add wasm32-unknown-unknown');

  // Build flags
  let buildCmd;
  if (optimizationLevel === 'release') {
    buildCmd = `cargo build --target wasm32-unknown-unknown --release`;
  } else {
    // custom flags passed verbatim (e.g. "--release -Z build-std")
    buildCmd = `cargo build --target wasm32-unknown-unknown ${optimizationLevel}`;
  }

  core.info(`Build command: ${buildCmd}`);
  const buildResult = exec(buildCmd, { cwd: projectDir });
  if (buildResult.status !== 0) {
    throw new Error(
      `Cargo build failed (exit ${buildResult.status}):\n${buildResult.stderr}\n${buildResult.stdout}`
    );
  }

  // Locate produced WASM
  const wasmName = crateName.replace(/-/g, '_') + '.wasm';
  const wasmCandidates = [
    path.join(projectDir, 'target', 'wasm32-unknown-unknown', 'release', wasmName),
    path.join(projectDir, 'target', 'wasm32-unknown-unknown', 'debug', wasmName),
    path.join(projectDir, 'res', wasmName),
    path.join(projectDir, wasmName),
  ];

  let wasmPath = null;
  for (const candidate of wasmCandidates) {
    if (fs.existsSync(candidate)) {
      wasmPath = candidate;
      break;
    }
  }

  // Also try a glob-like search under target/
  if (!wasmPath) {
    const targetDir = path.join(projectDir, 'target', 'wasm32-unknown-unknown');
    if (fs.existsSync(targetDir)) {
      const found = findFiles(targetDir, '.wasm');
      if (found.length > 0) {
        wasmPath = found[0];
        core.warning(`Primary wasm path not found; using first match: ${wasmPath}`);
      }
    }
  }

  if (!wasmPath) {
    throw new Error(
      `Could not locate built WASM file. Searched:\n${wasmCandidates.join('\n')}`
    );
  }

  // Validate magic bytes
  const header = Buffer.alloc(4);
  const fd = fs.openSync(wasmPath, 'r');
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  if (!header.equals(WASM_MAGIC)) {
    throw new Error(`File at ${wasmPath} does not appear to be a valid WASM binary`);
  }

  core.info(`WASM artifact: ${wasmPath}`);
  core.endGroup();
  return { wasmPath, projectDir, crateName };
}

function findFiles(dir, ext) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

// ─── Step 2 – Check size against limits ──────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitBytes, warningThresholdPercent, failOnExceeded) {
  core.startGroup('📏 Step 2 – Check WASM size against limits');

  const stat = fs.statSync(wasmPath);
  const currentSize = stat.size;
  const warningThreshold = Math.floor((warningThresholdPercent / 100) * sizeLimitBytes);

  core.info(`Current WASM size : ${formatBytes(currentSize)} (${currentSize} bytes)`);
  core.info(`Size limit        : ${formatBytes(sizeLimitBytes)} (${sizeLimitBytes} bytes)`);
  core.info(`Warning threshold : ${formatBytes(warningThreshold)} (${warningThresholdPercent}% of limit)`);
  core.info(`NEAR protocol max : ${formatBytes(NEAR_MAX_CONTRACT_SIZE)}`);

  // Set outputs
  core.setOutput('wasm_size_bytes', String(currentSize));
  core.setOutput('wasm_size_human', formatBytes(currentSize));
  core.setOutput('size_limit_bytes', String(sizeLimitBytes));

  let status = 'ok';

  if (currentSize > NEAR_MAX_CONTRACT_SIZE) {
    const msg =
      `🚨 WASM size (${formatBytes(currentSize)}) exceeds the NEAR protocol hard limit ` +
      `of ${formatBytes(NEAR_MAX_CONTRACT_SIZE)}! Deployment will fail.`;
    core.error(msg);
    core.setOutput('size_status', 'exceeded_protocol_limit');
    if (failOnExceeded) {
      throw new Error(msg);
    }
    status = 'exceeded_protocol_limit';
  } else if (currentSize > sizeLimitBytes) {
    const msg =
      `❌ WASM size (${formatBytes(currentSize)}) exceeds configured limit ` +
      `of ${formatBytes(sizeLimitBytes)} (${formatPercent(currentSize, sizeLimitBytes)}).`;
    core.error(msg);
    core.setOutput('size_status', 'exceeded');
    if (failOnExceeded) {
      throw new Error(msg);
    }
    status = 'exceeded';
  } else if (currentSize >= warningThreshold) {
    core.warning(
      `⚠️  WASM size (${formatBytes(currentSize)}) is ${formatPercent(currentSize, sizeLimitBytes)} ` +
      `of the limit — approaching the ${warningThresholdPercent}% warning threshold.`
    );
    core.setOutput('size_status', 'warning');
    status = 'warning';
  } else {
    core.info(`✅ WASM size is within acceptable bounds (${formatPercent(currentSize, sizeLimitBytes)} of limit).`);
    core.setOutput('size_status', 'ok');
    status = 'ok';
  }

  core.endGroup();
  return { currentSize, sizeLimitBytes, warningThreshold, status };
}

// ─── Step 3 – Compare with main branch ───────────────────────────────────────

async function stepCompareWithMain(projectDir, wasmPath, currentSize, crateName) {
  core.startGroup('🔀 Step 3 – Compare with main branch');

  let mainSize = null;
  let delta = null;
  let deltaSign = '';

  try {
    // Check if we are inside a git repo
    const gitRoot = exec('git rev-parse --show-toplevel', { cwd: projectDir });
    if (gitRoot.status !== 0) throw new Error('Not a git repository');

    const repoRoot = gitRoot.stdout.trim();

    // Fetch main branch (silently)
    core.info('Fetching main branch from origin…');
    const fetchResult = exec('git fetch origin main --depth=1 2>&1', { cwd: repoRoot });
    if (fetchResult.status !== 0) {
      core.warning('Could not fetch origin/main. Skipping comparison.');
      core.endGroup();
      return { mainSize: null, delta: null, deltaPercent: null };
    }

    // Stash current changes so we can checkout main cleanly
    const stashResult = exec('git stash --include-untracked 2>&1', { cwd: repoRoot });
    const didStash = stashResult.stdout.includes('Saved working directory');

    // Save current HEAD
    const currentBranch = exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot }).stdout.trim();

    try {
      // Checkout main
      execOrThrow('git checkout origin/main -- .', { cwd: repoRoot });

      // Rebuild on main
      core.info('Building contract on main branch…');
      const mainBuildResult = exec(
        `cargo build --target wasm32-unknown-unknown --release 2>&1`,
        { cwd: projectDir }
      );

      if (mainBuildResult.status === 0) {
        const wasmName = crateName.replace(/-/g, '_') + '.wasm';
        const mainWasmPath = path.join(
          projectDir,
          'target',
          'wasm32-unknown-unknown',
          'release',
          wasmName
        );

        if (fs.existsSync(mainWasmPath)) {
          mainSize = fs.statSync(mainWasmPath).size;
          delta = currentSize - mainSize;
          deltaSign = delta >= 0 ? '+' : '';
          core.info(`Main branch size  : ${formatBytes(mainSize)} (${mainSize} bytes)`);
          core.info(
            `Size delta        : ${deltaSign}${formatBytes(Math.abs(delta))} ` +
            `(${deltaSign}${delta} bytes)`
          );

          if (delta > 0) {
            core.warning(
              `⚠️  Contract grew by ${formatBytes(delta)} compared to main branch.`
            );
          } else if (delta < 0) {
            core.info(`✅ Contract shrank by ${formatBytes(Math.abs(delta))} compared to main branch.`);
          } else {
            core.info('✅ Contract size unchanged compared to main branch.');
          }

          core.setOutput('main_branch_size_bytes', String(mainSize));
          core.setOutput('size_delta_bytes', String(delta));
        } else {
          core.warning('Main branch WASM artifact not found after build. Skipping comparison.');
        }
      } else {
        core.warning('Main branch build failed. Skipping comparison.');
      }
    } finally {
      // Restore working tree
      exec(`git checkout ${currentBranch} -- . 2>&1`, { cwd: repoRoot });
      if (didStash) {
        exec('git stash pop 2>&1', { cwd: repoRoot });
      }
    }
  } catch (err) {
    core.warning(`Comparison with main branch skipped: ${err.message}`);
  }

  const deltaPercent =
    mainSize !== null && mainSize > 0
      ? ((delta / mainSize) * 100).toFixed(2)
      : null;

  core.endGroup();
  return { mainSize, delta, deltaPercent };
}

// ─── Step 4 – Suggest optimizations ──────────────────────────────────────────

async function stepSuggestOptimizations(wasmPath, currentSize, sizeLimitBytes, status, projectDir) {
  core.startGroup('💡 Step 4 – Optimization suggestions');

  const suggestions = [];

  // Always useful tips based on size
  const usagePercent = (currentSize / sizeLimitBytes) * 100;

  if (usagePercent > 60) {
    suggestions.push({
      priority: 'high',
      tip: 'Run `wasm-opt -Oz` (from the `binaryen` package) on the WASM output to reduce size by 10–30%.',
      command: `wasm-opt -Oz ${wasmPath} -o ${wasmPath}`,
    });

    suggestions.push({
      priority: 'high',
      tip: 'Add `opt-level = "z"` and `lto = true` to your `[profile.release]` in Cargo.toml.',
      snippet: `[profile.release]\nopt-level = "z"\nlto = true\ncodegen-units = 1\npanic = "abort"`,
    });

    suggestions.push({
      priority: 'high',
      tip: 'Enable `panic = "abort"` in release profile — it removes panic unwinding code.',
    });
  }

  if (usagePercent > 40) {
    suggestions.push({
      priority: 'medium',
      tip: 'Use `near-sdk` features selectively. Disable unused features in Cargo.toml to reduce bloat.',
    });

    suggestions.push({
      priority: 'medium',
      tip: 'Avoid pulling in large Rust standard library components. Prefer `#![no_std]` where feasible.',
    });

    suggestions.push({
      priority: 'medium',
      tip: 'Minimize use of `String` formatting and `serde` derived impls — they add significant code size.',
    });
  }

  suggestions.push({
    priority: 'low',
    tip: 'Use `cargo bloat --release --target wasm32-unknown-unknown` to identify the largest functions.',
  });

  suggestions.push({
    priority: 'low',
    tip: 'Consider splitting the contract into multiple smaller contracts using cross-contract calls.',
  });

  suggestions.push({
    priority: 'low',
    tip: 'Strip custom sections from the WASM: `wasm-strip contract.wasm` (from wabt tools).',
  });

  // Check if wasm-opt is available and run it as a suggestion demo
  if (commandExists('wasm-opt')) {
    core.info('wasm-opt is available. Running size estimate with -Oz…');
    const tmpOptimized = path.join(os.tmpdir(), 'contract_optimized.wasm');
    try {
      execOrThrow(`wasm-opt -Oz "${wasmPath}" -o "${tmpOptimized}"`);
      const optimizedSize = fs.statSync(tmpOptimized).size;
      const savings = currentSize - optimizedSize;
      if (savings > 0) {
        core.info(
          `✨ wasm-opt -Oz would reduce size from ${formatBytes(currentSize)} to ` +
          `${formatBytes(optimizedSize)} (saving ${formatBytes(savings)}).`
        );
        core.setOutput('optimized_size_bytes', String(optimizedSize));
        core.setOutput('optimized_size_savings_bytes', String(savings));
        suggestions.unshift({
          priority: 'critical',
          tip: `Running \`wasm-opt -Oz\` would save ${formatBytes(savings)} immediately!`,
          command: `wasm-opt -Oz ${wasmPath} -o ${wasmPath}`,
        });
      }
      fs.unlinkSync(tmpOptimized);
    } catch (e) {
      core.debug(`wasm-opt estimate failed: ${e.message}`);
    }
  } else {
    core.info('wasm-opt not found. Install binaryen for automatic optimization.');
  }

  // Check Cargo.toml for missing optimizations
  const cargoToml = fs.readFileSync(path.join(projectDir, 'Cargo.toml'), 'utf8');
  if (!cargoToml.includes('opt-level')) {
    suggestions.unshift({
      priority: 'critical',
      tip: 'No opt-level found in Cargo.toml [profile.release]. Add `opt-level = "z"` for maximum size reduction.',
    });
  }
  if (!cargoToml.includes('lto')) {
    suggestions.push({
      priority: 'high',
      tip: 'No `lto` setting found. Add `lto = true` to [profile.release] for link-time optimization.',
    });
  }

  // Print suggestions
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  suggestions.sort((a, b) => (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99));

  core.info('\n━━━ Optimization Suggestions ━━━');
  for (const s of suggestions) {
    const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[s.priority] || '⚪';
    core.info(`${icon} [${s.priority.toUpperCase()}] ${s.tip}`);
    if (s.command) core.info(`   Command: ${s.command}`);
    if (s.snippet) core.info(`   Snippet:\n${s.snippet.split('\n').map((l) => '   ' + l).join('\n')}`);
  }

  core.setOutput('optimization_suggestions', JSON.stringify(suggestions));
  core.endGroup();
  return { suggestions };
}

// ─── Step 5 – Generate summary report ────────────────────────────────────────

async function stepGenerateSummary(
  wasmPath,
  currentSize,
  sizeLimitBytes,
  warningThreshold,
  warningThresholdPercent,
  status,
  mainSize,
  delta,
  deltaPercent,
  suggestions,
  crateName
) {
  core.startGroup('📊 Step 5 – Generate summary report');

  const usageBar = buildProgressBar(currentSize, sizeLimitBytes, 30);
  const statusEmoji = { ok: '✅', warning: '⚠️', exceeded: '❌', exceeded_protocol_limit: '🚨' }[status] || '❓';

  const lines = [
    `## ${statusEmoji} NEAR Contract Size Report`,
    '',
    `**Contract:** \`${crateName}\``,
    `**WASM Path:** \`${wasmPath}\``,
    '',
    '### Size Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Current Size | **${formatBytes(currentSize)}** (${currentSize.toLocaleString()} bytes) |`,
    `| Size Limit | ${formatBytes(sizeLimitBytes)} (${sizeLimitBytes.toLocaleString()} bytes) |`,
    `| Usage | ${formatPercent(currentSize, sizeLimitBytes)} ${usageBar} |`,
    `| Warning Threshold | ${warningThresholdPercent}% (${formatBytes(warningThreshold)}) |`,
    `| NEAR Protocol Max | ${formatBytes(NEAR_MAX_CONTRACT_SIZE)} |`,
    `| Status | ${statusEmoji} ${status.replace(/_/g, ' ').toUpperCase()} |`,
  ];

  if