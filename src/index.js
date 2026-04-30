async function stepBuildContract(contractPath) {
  core.startGroup('Step 1 — Build Contract WASM');

  let wasmPath = null;

  // If the user pointed directly at a .wasm file, skip building
  if (contractPath.endsWith('.wasm') && fs.existsSync(contractPath)) {
    core.info(`Contract path is already a WASM file: ${contractPath}`);
    wasmPath = path.resolve(contractPath);
    core.endGroup();
    return wasmPath;
  }

  const absContractPath = path.resolve(contractPath);

  if (!fs.existsSync(absContractPath)) {
    throw new Error(`Contract path does not exist: ${absContractPath}`);
  }

  // ── Try cargo-near first ──
  if (commandExists('cargo-near')) {
    core.info('cargo-near detected — building with `cargo near build`');
    try {
      exec('cargo near build --no-docker', { cwd: absContractPath });
    } catch {
      core.warning('cargo near build failed, falling back to cargo build');
    }
  }

  // ── Fallback: standard cargo build for wasm32 target ──
  if (!wasmPath) {
    const cargoToml = path.join(absContractPath, 'Cargo.toml');
    if (fs.existsSync(cargoToml)) {
      core.info('Building with `cargo build --target wasm32-unknown-unknown --release`');

      // Ensure wasm32 target is installed
      tryExec('rustup target add wasm32-unknown-unknown');

      exec('cargo build --target wasm32-unknown-unknown --release', {
        cwd: absContractPath,
      });

      // Read package name from Cargo.toml to find the output wasm
      const cargoTomlContent = fs.readFileSync(cargoToml, 'utf8');
      const nameMatch = cargoTomlContent.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const pkgName = nameMatch ? nameMatch[1].replace(/-/g, '_') : null;

      const targetDir = path.join(
        absContractPath,
        'target',
        'wasm32-unknown-unknown',
        'release'
      );

      if (pkgName) {
        const candidate = path.join(targetDir, `${pkgName}.wasm`);
        if (fs.existsSync(candidate)) wasmPath = candidate;
      }

      // If we still don't have it, grab the first .wasm in the release dir
      if (!wasmPath && fs.existsSync(targetDir)) {
        const wasms = fs.readdirSync(targetDir).filter((f) => f.endsWith('.wasm'));
        if (wasms.length > 0) wasmPath = path.join(targetDir, wasms[0]);
      }
    }
  }

  // ── near-sdk-js / AssemblyScript ──
  if (!wasmPath) {
    const packageJson = path.join(absContractPath, 'package.json');
    if (fs.existsSync(packageJson)) {
      core.info('Node.js project detected — running `npm run build`');
      const hasYarn = fs.existsSync(path.join(absContractPath, 'yarn.lock'));
      exec(hasYarn ? 'yarn install --frozen-lockfile' : 'npm ci', {
        cwd: absContractPath,
      });
      exec(hasYarn ? 'yarn build' : 'npm run build', { cwd: absContractPath });

      // Common output locations for near-sdk-js / AssemblyScript
      const candidates = [
        'build/contract.wasm',
        'build/release/contract.wasm',
        'build/debug/contract.wasm',
        'out/contract.wasm',
        'dist/contract.wasm',
      ];
      for (const c of candidates) {
        const full = path.join(absContractPath, c);
        if (fs.existsSync(full)) {
          wasmPath = full;
          break;
        }
      }

      // Walk build/ for any .wasm
      if (!wasmPath) {
        const buildDir = path.join(absContractPath, 'build');
        if (fs.existsSync(buildDir)) {
          const found = [];
          (function walk(dir) {
            for (const entry of fs.readdirSync(dir)) {
              const full = path.join(dir, entry);
              if (fs.statSync(full).isDirectory()) walk(full);
              else if (entry.endsWith('.wasm')) found.push(full);
            }
          })(buildDir);
          if (found.length > 0) wasmPath = found[0];
        }
      }
    }
  }

  if (!wasmPath || !fs.existsSync(wasmPath)) {
    throw new Error(
      'Could not locate compiled WASM file. ' +
        'Please ensure your contract builds correctly or point contract_path directly at the .wasm file.'
    );
  }

  core.info(`WASM artifact: ${wasmPath}`);
  core.endGroup();
  return wasmPath;
}

// ─── Step 2: Check Size Against Limits ──────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('Step 2 — Check Size Against Limits');

  const stats = fs.statSync(wasmPath);
  const sizeBytes = stats.size;
  const sizeKb = bytesToKb(sizeBytes);
  const limitBytes = sizeLimitKb * 1024;
  const warningBytes = limitBytes * (warningThresholdPercent / 100);

  core.info(`Contract size : ${formatSize(sizeBytes)}`);
  core.info(`Size limit    : ${formatSize(limitBytes)}`);
  core.info(
    `Warning at    : ${warningThresholdPercent}% → ${formatSize(warningBytes)}`
  );

  const usagePercent = (sizeBytes / limitBytes) * 100;
  core.info(`Usage         : ${usagePercent.toFixed(1)}% of limit`);

  // Set outputs
  core.setOutput('contract_size_bytes', sizeBytes);
  core.setOutput('contract_size_kb', sizeKb.toFixed(2));
  core.setOutput('size_limit_kb', sizeLimitKb);
  core.setOutput('usage_percent', usagePercent.toFixed(1));

  let status = 'ok'; // 'ok' | 'warning' | 'over_limit'

  if (sizeBytes > limitBytes) {
    status = 'over_limit';
    core.error(
      `❌ Contract size ${formatSize(sizeBytes)} EXCEEDS limit of ${formatSize(limitBytes)}`
    );
  } else if (sizeBytes >= warningBytes) {
    status = 'warning';
    core.warning(
      `⚠️  Contract size ${formatSize(sizeBytes)} is within ${(100 - warningThresholdPercent).toFixed(0)}% of the ${formatSize(limitBytes)} limit`
    );
  } else {
    core.info(`✅ Contract size ${formatSize(sizeBytes)} is within limits`);
  }

  core.endGroup();
  return { sizeBytes, sizeKb, usagePercent, status, limitBytes, warningBytes };
}

// ─── Step 3: Compare With Previous Builds ───────────────────────────────────

async function stepCompareWithBaseline(wasmPath, sizeBytes, baselineArtifact, failOnIncrease) {
  core.startGroup('Step 3 — Compare With Previous Builds');

  let baselineBytes = null;
  let delta = null;
  let deltaPercent = null;
  let baselineSource = null;

  // ── Strategy A: explicit artifact path or URL ──
  if (baselineArtifact && baselineArtifact.trim() !== '') {
    const artifact = baselineArtifact.trim();

    if (artifact.startsWith('http://') || artifact.startsWith('https://')) {
      core.info(`Downloading baseline WASM from: ${artifact}`);
      try {
        const tmpFile = path.join(os.tmpdir(), 'baseline_contract.wasm');
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tmpFile);
          https.get(artifact, (res) => {
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
          }).on('error', reject);
        });
        baselineBytes = fs.statSync(tmpFile).size;
        baselineSource = `URL: ${artifact}`;
      } catch (e) {
        core.warning(`Failed to download baseline: ${e.message}`);
      }
    } else if (fs.existsSync(artifact)) {
      core.info(`Using local baseline artifact: ${artifact}`);
      baselineBytes = fs.statSync(artifact).size;
      baselineSource = `Local file: ${artifact}`;
    } else {
      core.warning(`Baseline artifact not found: ${artifact}`);
    }
  }

  // ── Strategy B: git history — compare with HEAD~ or branch ──
  if (baselineBytes === null) {
    core.info('Attempting to retrieve baseline from git history…');

    const isGitRepo = tryExec('git rev-parse --git-dir');
    if (isGitRepo) {
      // Try to get the wasm path relative to repo root
      const repoRoot = tryExec('git rev-parse --show-toplevel') || process.cwd();
      const relWasmPath = path.relative(repoRoot, path.resolve(wasmPath));

      // Check if this file is tracked in git
      const isTracked = tryExec(`git ls-files --error-unmatch "${relWasmPath}" 2>/dev/null`);

      if (isTracked !== null) {
        const tmpBaseline = path.join(os.tmpdir(), 'baseline_git.wasm');
        // Try HEAD~1 first, then main/master branch
        const refs = ['HEAD~1', 'origin/main', 'origin/master', 'main', 'master'];
        for (const ref of refs) {
          const result = spawnSync(
            `git show "${ref}:${relWasmPath}" > "${tmpBaseline}" 2>/dev/null`,
            { shell: true }
          );
          if (result.status === 0 && fs.existsSync(tmpBaseline)) {
            baselineBytes = fs.statSync(tmpBaseline).size;
            baselineSource = `git: ${ref}`;
            core.info(`Found baseline at git ref: ${ref}`);
            break;
          }
        }
      } else {
        core.info('WASM file not tracked in git — no git baseline available');
      }
    }
  }

  // ── Strategy C: GitHub Actions cache via size summary file ──
  if (baselineBytes === null) {
    const summaryFile = path.join(os.tmpdir(), 'near_size_baseline.json');
    const workspaceSummary = path.join(
      process.env.GITHUB_WORKSPACE || process.cwd(),
      '.near-size-baseline.json'
    );

    for (const f of [workspaceSummary, summaryFile]) {
      if (fs.existsSync(f)) {
        try {
          const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (saved.sizeBytes) {
            baselineBytes = saved.sizeBytes;
            baselineSource = `Cached baseline (${f})`;
            core.info(`Loaded cached baseline from: ${f}`);
            break;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // ── Compute delta ──
  if (baselineBytes !== null) {
    delta = sizeBytes - baselineBytes;
    deltaPercent = baselineBytes > 0 ? (delta / baselineBytes) * 100 : 0;

    core.info(`Baseline      : ${formatSize(baselineBytes)} (${baselineSource})`);
    core.info(`Current       : ${formatSize(sizeBytes)}`);

    if (delta > 0) {
      core.warning(
        `📈 Contract grew by ${formatSize(Math.abs(delta))} (+${deltaPercent.toFixed(2)}%)`
      );
    } else if (delta < 0) {
      core.info(
        `📉 Contract shrank by ${formatSize(Math.abs(delta))} (${deltaPercent.toFixed(2)}%)`
      );
    } else {
      core.info('↔️  Contract size unchanged');
    }

    core.setOutput('baseline_size_bytes', baselineBytes);
    core.setOutput('size_delta_bytes', delta);
    core.setOutput('size_delta_percent', deltaPercent.toFixed(2));

    if (failOnIncrease && delta > 0) {
      throw new Error(
        `Contract size increased by ${formatSize(delta)} (+${deltaPercent.toFixed(2)}%) from baseline. ` +
          'Set fail_on_increase=false to allow size increases.'
      );
    }
  } else {
    core.info('No baseline available — skipping size comparison');
    core.setOutput('baseline_size_bytes', '');
    core.setOutput('size_delta_bytes', '');
    core.setOutput('size_delta_percent', '');
  }

  // ── Persist current build as next baseline ──
  const baselineSaveFile = path.join(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    '.near-size-baseline.json'
  );
  writeJsonSummary(baselineSaveFile, {
    sizeBytes,
    wasmPath: path.resolve(wasmPath),
    timestamp: new Date().toISOString(),
    sha: tryExec('git rev-parse HEAD') || 'unknown',
  });
  core.info(`Saved current size as baseline → ${baselineSaveFile}`);

  core.endGroup();
  return { baselineBytes, delta, deltaPercent, baselineSource };
}

// ─── Step 4: Suggest Optimizations ──────────────────────────────────────────

async function stepSuggestOptimizations(wasmPath, sizeBytes, sizeLimitKb, usagePercent, status) {
  core.startGroup('Step 4 — Optimization Suggestions');

  const suggestions = [];
  const limitBytes = sizeLimitKb * 1024;

  // ── Static analysis: scan WASM binary for optimization hints ──
  core.info('Analyzing WASM binary for optimization opportunities…');

  // Check if wasm-opt is available
  const hasWasmOpt = commandExists('wasm-opt');
  const hasWasmStrip = commandExists('wasm-strip') || commandExists('llvm-strip');
  const hasTwiggy = commandExists('twiggy');

  // Heuristic: estimate how much wasm-opt could save (~10–30%)
  const estimatedOptSavings = sizeBytes * 0.15;
  const estimatedStrippedSize = sizeBytes * 0.9;

  if (status === 'over_limit' || usagePercent >= 50) {
    suggestions.push({
      priority: 'HIGH',
      tool: 'wasm-opt',
      description: 'Run wasm-opt -Oz to aggressively optimize the WASM binary',
      command: `wasm-opt -Oz --strip-debug --strip-producers -o contract_optimized.wasm ${path.basename(wasmPath)}`,
      estimatedSavingBytes: Math.round(estimatedOptSavings),
      available: hasWasmOpt,
    });

    suggestions.push({
      priority: 'HIGH',
      tool: 'Cargo profile',
      description: 'Add release profile optimizations to Cargo.toml',
      command: null,
      snippet: `[profile.release]
opt-level = "z"      # optimize for size
lto = true           # link-time optimization
codegen-units = 1    # single codegen unit
panic = "abort"      # smaller panic handler
overflow-checks = false`,
      estimatedSavingBytes: Math.round(sizeBytes * 0.1),
      available: true,
    });
  }

  if (usagePercent >= 30) {
    suggestions.push({
      priority: 'MEDIUM',
      tool: 'wasm-strip / wasm-tools',
      description: 'Strip debug symbols and custom sections from the WASM',
      command: 'wasm-strip contract.wasm',
      estimatedSavingBytes: Math.round(sizeBytes * 0.05),
      available: hasWasmStrip,
    });

    suggestions.push({
      priority: 'MEDIUM',
      tool: 'near-workspaces',
      description:
        'Use near_sdk::PanicOnDefault instead of custom Default impl to reduce code size',
      command: null,
      snippet: `#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct Contract { ... }`,
      estimatedSavingBytes: null,
      available: true,
    });

    suggestions.push({
      priority: 'MEDIUM',
      tool: 'Dependency audit',
      description:
        'Audit dependencies — large crates like serde_json can be replaced with near_sdk::serde_json',
      command: 'cargo bloat --release --target wasm32-unknown-unknown --crates',
      estimatedSavingBytes: null,
      available: commandExists('cargo-bloat'),
    });
  }

  suggestions.push({
    priority: 'LOW',
    tool: 'twiggy',
    description: 'Use twiggy to find the largest contributors to binary size',
    command: `twiggy top ${path.basename(wasmPath)} -n 20`,
    estimatedSavingBytes: null,
    available: hasTwiggy,
  });

  suggestions.push({
    priority: 'LOW',
    tool: 'cargo-bloat',
    description: 'Use cargo-bloat to identify large functions and crates',
    command:
      'cargo bloat --release --target wasm32-unknown-unknown -n 20',
    estimatedSavingBytes: null,
    available: commandExists('cargo-bloat'),
  });

  suggestions.push({
    priority: 'LOW',
    tool: 'Feature flags',
    description:
      'Disable unused near-sdk features (e.g., "legacy" or "unstable") in Cargo.toml',
    command: null,
    snippet: `near-sdk = { version = "5.x", default-features = false, features = ["abi"] }`,
    estimatedSavingBytes: null,
    available: true,
  });

  // ── Run wasm-opt in dry-run mode if available ──
  if (hasWasmOpt) {
    core.info('wasm-opt is available — running size estimation…');
    const tmpOpt = path.join(os.tmpdir(), 'contract_opt_estimate.wasm');
    try {
      exec(`wasm-opt -Oz --strip-debug --strip-producers -o "${tmpOpt}" "${wasmPath}"`);
      if (fs.existsSync(tmpOpt)) {
        const optSize = fs.statSync(tmpOpt).size;
        const actualSaving = sizeBytes - optSize;
        core.info(
          `wasm-opt result: ${formatSize(optSize)} (saves ${formatSize(actualSaving)}, ${((actualSaving / sizeBytes) * 100).toFixed(1)}%)`
        );
        // Update the estimate with real data
        const woptSuggestion = suggestions.find((s) => s.tool === 'wasm-opt');
        if (woptSuggestion) woptSuggestion.estimatedSavingBytes = actualSaving;
        core.setOutput('optimized_size_bytes', optSize);
        core.setOutput('optimized_size_kb', bytesToKb(optSize).toFixed(2));
      }
    } catch (e) {
      core.warning(`wasm-opt estimation failed: ${e.message}`);
    }
  }

  // ── Print suggestions ──
  if (suggestions.length > 0) {
    core.info('\n📋 Optimization Suggestions:');
    core.info('═'.repeat(60));

    for (const s of suggestions) {
      const icon = s.priority === 'HIGH' ? '🔴' : s.priority === 'MEDIUM' ? '🟡' : '🟢';
      const availTag = s.available ? '[installed]' : '[needs install]';
      core.info(`\n${icon} [${s.priority}] ${s.tool} ${availTag}`);
      core.info(`   ${s.description}`);
      if (s.command) core.info(`   Command: ${s.command}`);
      if (s.snippet)