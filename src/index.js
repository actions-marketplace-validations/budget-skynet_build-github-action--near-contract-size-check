async function buildContractWasm(contractPath) {
  core.startGroup('Step 1 — Build Contract WASM');

  const resolvedPath = path.resolve(contractPath);
  core.info(`Resolved contract path: ${resolvedPath}`);

  // Check if it already is a WASM file
  if (resolvedPath.endsWith('.wasm') && fs.existsSync(resolvedPath)) {
    core.info('Input is a pre-built WASM file — skipping build step.');
    core.endGroup();
    return { wasmPath: resolvedPath, builtFromSource: false };
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Contract path does not exist: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Contract path is not a directory and not a .wasm file: ${resolvedPath}`);
  }

  // Detect project type
  const hasCargoToml = fs.existsSync(path.join(resolvedPath, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(resolvedPath, 'package.json'));

  let wasmPath = null;

  if (hasCargoToml) {
    core.info('Detected Rust/Cargo project. Building with cargo...');

    // Ensure wasm32 target is installed
    runCommand('rustup target add wasm32-unknown-unknown', { ignoreError: true });

    // Try cargo-near first, then fall back to cargo build
    const cargoNearCheck = runCommand('which cargo-near', { ignoreError: true });
    if (cargoNearCheck.status === 0) {
      core.info('Using cargo-near for optimised build...');
      runCommand('cargo near build --no-docker 2>&1 || cargo near build', {
        cwd: resolvedPath,
        ignoreError: true,
      });
    }

    // Standard cargo build targeting wasm32
    core.info('Running cargo build --target wasm32-unknown-unknown --release...');
    runCommand(
      'cargo build --target wasm32-unknown-unknown --release 2>&1',
      { cwd: resolvedPath }
    );

    // Locate the produced WASM file
    const targetDir = path.join(resolvedPath, 'target', 'wasm32-unknown-unknown', 'release');
    if (!fs.existsSync(targetDir)) {
      throw new Error(`Expected build output directory not found: ${targetDir}`);
    }
    const wasmFiles = fs
      .readdirSync(targetDir)
      .filter((f) => f.endsWith('.wasm'))
      .map((f) => path.join(targetDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

    if (wasmFiles.length === 0) {
      throw new Error(`No WASM file found in ${targetDir} after build.`);
    }
    wasmPath = wasmFiles[0];
    core.info(`Built WASM (Rust): ${wasmPath}`);

    // Optional: run wasm-opt if available
    const wasmOptCheck = runCommand('which wasm-opt', { ignoreError: true });
    if (wasmOptCheck.status === 0) {
      core.info('wasm-opt found — running optimisation pass...');
      const optimisedPath = wasmPath.replace('.wasm', '.optimised.wasm');
      const optResult = runCommand(
        `wasm-opt -Oz --strip-debug --strip-producers -o "${optimisedPath}" "${wasmPath}"`,
        { ignoreError: true }
      );
      if (optResult.status === 0 && fs.existsSync(optimisedPath)) {
        core.info('wasm-opt optimisation applied successfully.');
        wasmPath = optimisedPath;
      } else {
        core.warning('wasm-opt optimisation failed or produced no output — using unoptimised build.');
      }
    }
  } else if (hasPackageJson) {
    core.info('Detected Node.js project. Looking for build script...');
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(resolvedPath, 'package.json'), 'utf8')
    );
    const buildScript =
      pkgJson.scripts && (pkgJson.scripts.build || pkgJson.scripts['build:wasm']);

    if (!buildScript) {
      throw new Error(
        'package.json found but no "build" or "build:wasm" script defined. Cannot build WASM.'
      );
    }

    // Install deps
    const hasYarnLock = fs.existsSync(path.join(resolvedPath, 'yarn.lock'));
    const installCmd = hasYarnLock ? 'yarn install --frozen-lockfile' : 'npm ci';
    core.info(`Installing dependencies: ${installCmd}`);
    runCommand(installCmd, { cwd: resolvedPath });

    // Run build
    const buildCmd = hasYarnLock ? 'yarn build' : 'npm run build';
    core.info(`Running build: ${buildCmd}`);
    runCommand(buildCmd, { cwd: resolvedPath });

    // Locate WASM
    const candidates = ['build', 'out', 'dist', 'res', '.'];
    let found = false;
    for (const dir of candidates) {
      const searchDir = path.join(resolvedPath, dir);
      if (!fs.existsSync(searchDir)) continue;
      const wasmFiles = fs
        .readdirSync(searchDir)
        .filter((f) => f.endsWith('.wasm'))
        .map((f) => path.join(searchDir, f));
      if (wasmFiles.length > 0) {
        wasmPath = wasmFiles[0];
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(
        'Build completed but no WASM file found in common output directories (build, out, dist, res).'
      );
    }
    core.info(`Built WASM (JS/AS): ${wasmPath}`);
  } else {
    throw new Error(
      `Cannot detect project type at ${resolvedPath}. Expected Cargo.toml (Rust) or package.json (AssemblyScript/JS).`
    );
  }

  core.endGroup();
  return { wasmPath, builtFromSource: true };
}

// ─── Step 2: Check Size Against Limits ────────────────────────────────────────
async function checkSizeAgainstLimits(wasmPath, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('Step 2 — Check Size Against Limits');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at: ${wasmPath}`);
  }

  const stats = fs.statSync(wasmPath);
  const sizeBytes = stats.size;
  const sizeKb = sizeBytes / BYTES_PER_KB;
  const sizeMb = sizeKb / 1024;

  const limitBytes = sizeLimitKb * BYTES_PER_KB;
  const warningThresholdKb = (sizeLimitKb * warningThresholdPercent) / 100;
  const percentOfLimit = (sizeKb / sizeLimitKb) * 100;

  core.info(`WASM file         : ${wasmPath}`);
  core.info(`Size (bytes)      : ${sizeBytes.toLocaleString()} bytes`);
  core.info(`Size (KB)         : ${sizeKb.toFixed(2)} KB`);
  core.info(`Size (MB)         : ${sizeMb.toFixed(4)} MB`);
  core.info(`Limit             : ${sizeLimitKb} KB (${(sizeLimitKb / 1024).toFixed(2)} MB)`);
  core.info(`Warning threshold : ${warningThresholdKb.toFixed(2)} KB (${warningThresholdPercent}% of limit)`);
  core.info(`Usage             : ${percentOfLimit.toFixed(1)}% of limit`);

  const isOverLimit = sizeKb > sizeLimitKb;
  const isNearLimit = sizeKb >= warningThresholdKb;

  // Progress bar
  const barWidth = 40;
  const filled = Math.min(Math.round((percentOfLimit / 100) * barWidth), barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  core.info(`\nSize: [${bar}] ${percentOfLimit.toFixed(1)}%`);

  // Emit GitHub summary info
  if (isOverLimit) {
    core.error(
      `🚨 CONTRACT SIZE EXCEEDED: ${sizeKb.toFixed(2)} KB / ${sizeLimitKb} KB limit ` +
        `(${percentOfLimit.toFixed(1)}% — over by ${(sizeKb - sizeLimitKb).toFixed(2)} KB)`
    );
  } else if (isNearLimit) {
    core.warning(
      `⚠️  Contract size approaching limit: ${sizeKb.toFixed(2)} KB / ${sizeLimitKb} KB ` +
        `(${percentOfLimit.toFixed(1)}%). Warning threshold: ${warningThresholdPercent}%.`
    );
  } else {
    core.info(
      `✅ Contract size OK: ${sizeKb.toFixed(2)} KB / ${sizeLimitKb} KB (${percentOfLimit.toFixed(1)}%)`
    );
  }

  // Set step outputs as Action outputs
  core.setOutput('contract_size_bytes', String(sizeBytes));
  core.setOutput('contract_size_kb', sizeKb.toFixed(2));
  core.setOutput('size_limit_kb', String(sizeLimitKb));
  core.setOutput('percent_of_limit', percentOfLimit.toFixed(1));
  core.setOutput('is_over_limit', String(isOverLimit));
  core.setOutput('is_near_limit', String(isNearLimit));

  core.endGroup();
  return {
    sizeBytes,
    sizeKb,
    sizeMb,
    limitBytes,
    sizeLimitKb,
    warningThresholdKb,
    percentOfLimit,
    isOverLimit,
    isNearLimit,
  };
}

// ─── Step 3: Compare with Previous Builds ─────────────────────────────────────
async function compareWithPreviousBuild(currentSizeBytes, baselineWasmUrl) {
  core.startGroup('Step 3 — Compare With Previous Build');

  if (!baselineWasmUrl) {
    core.info('No baseline WASM URL provided — skipping comparison.');
    core.endGroup();
    return { hasBaseline: false, deltaSizeBytes: null, deltaPercent: null };
  }

  let baselineBuffer = null;

  // Could be a local path or URL
  if (baselineWasmUrl.startsWith('http://') || baselineWasmUrl.startsWith('https://')) {
    core.info(`Fetching baseline WASM from URL: ${baselineWasmUrl}`);
    try {
      baselineBuffer = await fetchUrl(baselineWasmUrl);
    } catch (err) {
      core.warning(`Could not fetch baseline WASM: ${err.message}. Skipping comparison.`);
      core.endGroup();
      return { hasBaseline: false, deltaSizeBytes: null, deltaPercent: null };
    }
  } else {
    const localPath = path.resolve(baselineWasmUrl);
    if (!fs.existsSync(localPath)) {
      core.warning(`Baseline WASM local path not found: ${localPath}. Skipping comparison.`);
      core.endGroup();
      return { hasBaseline: false, deltaSizeBytes: null, deltaPercent: null };
    }
    baselineBuffer = fs.readFileSync(localPath);
  }

  const baselineSizeBytes = baselineBuffer.length;
  const baselineSizeKb = baselineSizeBytes / BYTES_PER_KB;
  const deltaSizeBytes = currentSizeBytes - baselineSizeBytes;
  const deltaKb = deltaSizeBytes / BYTES_PER_KB;
  const deltaPercent =
    baselineSizeBytes > 0 ? (deltaSizeBytes / baselineSizeBytes) * 100 : null;

  const direction = deltaSizeBytes > 0 ? 'increased' : deltaSizeBytes < 0 ? 'decreased' : 'unchanged';
  const sign = deltaSizeBytes > 0 ? '+' : '';
  const emoji = deltaSizeBytes > 0 ? '📈' : deltaSizeBytes < 0 ? '📉' : '➡️';

  core.info(`Baseline size  : ${baselineSizeBytes.toLocaleString()} bytes (${baselineSizeKb.toFixed(2)} KB)`);
  core.info(`Current size   : ${currentSizeBytes.toLocaleString()} bytes (${(currentSizeBytes / BYTES_PER_KB).toFixed(2)} KB)`);
  core.info(
    `${emoji} Delta         : ${sign}${deltaSizeBytes.toLocaleString()} bytes (${sign}${deltaKb.toFixed(2)} KB) — ${direction}` +
      (deltaPercent !== null ? ` by ${sign}${deltaPercent.toFixed(1)}%` : '')
  );

  if (deltaSizeBytes > 50 * BYTES_PER_KB) {
    core.warning(
      `⚠️  Contract size increased by more than 50 KB compared to baseline (${sign}${deltaKb.toFixed(2)} KB). ` +
        'This may indicate unintended dependency bloat.'
    );
  } else if (deltaSizeBytes < 0) {
    core.info(`✅ Contract is smaller than baseline — good optimisation!`);
  }

  core.setOutput('baseline_size_bytes', String(baselineSizeBytes));
  core.setOutput('delta_size_bytes', String(deltaSizeBytes));
  core.setOutput('delta_size_kb', deltaKb.toFixed(2));
  if (deltaPercent !== null) {
    core.setOutput('delta_percent', deltaPercent.toFixed(1));
  }

  core.endGroup();
  return { hasBaseline: true, deltaSizeBytes, deltaKb, deltaPercent, baselineSizeBytes };
}

// ─── Step 4: Suggest Optimisations ────────────────────────────────────────────
async function suggestOptimisations(wasmPath, sizeInfo, comparisonInfo, contractPath) {
  core.startGroup('Step 4 — Optimisation Suggestions');

  const { sizeKb, sizeLimitKb, percentOfLimit, isOverLimit, isNearLimit } = sizeInfo;
  const suggestions = [];

  // Always-applicable suggestions for NEAR Rust contracts
  const generalSuggestions = [
    {
      id: 'wasm-opt',
      title: 'Run wasm-opt with aggressive optimisation flags',
      detail:
        'Use `wasm-opt -Oz --strip-debug --strip-producers -o output.wasm input.wasm`. ' +
        'This can reduce WASM size by 10–40%.',
      saving: 'Medium–High',
      effort: 'Low',
    },
    {
      id: 'cargo-opt',
      title: 'Enable LTO and opt-level=z in Cargo.toml',
      detail:
        'Add to [profile.release]: `lto = true`, `opt-level = "z"`, `codegen-units = 1`, ' +
        '`panic = "abort"`. This can reduce binary size significantly.',
      saving: 'High',
      effort: 'Low',
    },
    {
      id: 'strip-debug',
      title: 'Strip debug symbols',
      detail:
        'Ensure you are building with `--release`. Add `strip = true` to [profile.release] in Cargo.toml (Rust 1.59+).',
      saving: 'Medium',
      effort: 'Low',
    },
    {
      id: 'no-std',
      title: 'Reduce standard library usage',
      detail:
        'Avoid pulling in large portions of std. Use `near-sdk` minimal features. ' +
        'Remove unused derives and traits.',
      saving: 'Medium',
      effort: 'Medium',
    },
    {
      id: 'dependency-audit',
      title: 'Audit and prune dependencies',
      detail:
        'Run `cargo bloat --release --crates` to identify which crates contribute most to size. ' +
        'Remove unused features with `default-features = false`.',
      saving: 'Variable',
      effort: 'Medium',
    },
  ];

  // Conditionally triggered suggestions
  if (isOverLimit || isNearLimit) {
    suggestions.push(...generalSuggestions);

    suggestions.push({
      id: 'near-sdk-features',
      title: 'Minimise near-sdk feature flags',
      detail:
        'In Cargo.toml: `near-sdk = { version = "...", default-features = false, features = ["legacy"] }`. ' +
        'Only enable features you actually use.',
      saving: 'Medium',
      effort: 'Low',
    });

    suggestions.push({
      id: 'split-contract',
      title: 'Consider splitting into multiple contracts',
      detail:
        'If the contract has distinct functional areas, split into separate contracts ' +
        'communicating via cross-contract calls. Each contract can then stay well under the limit.',
      saving: 'High',
      effort: 'High',
    });
  } else {
    // Still give generic advice even if under limit
    suggestions.push(generalSuggestions[0]); // wasm-opt
    suggestions.push(generalSuggestions[1]); // cargo profile
  }

  // Check if Cargo.toml has recommended settings
  const cargoTomlPath =
    contractPath && fs.existsSync(path.join(contractPath, 'Cargo.toml'))
      ? path.join(contractPath, 'Cargo.toml')
      : null;

  if (cargoTomlPath) {
    const cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');
    const checks = [
      { pattern: /opt-level\s*=\s*["']?z["']?/, label: 'opt-level = "z"', present: false },
      { pattern: /lto\s*=\s*true/, label: 'lto = true', present: false },
      { pattern: /panic\s*=\s*["']abort["']/, label: 'panic = "abort"', present: false },
      { pattern: /codegen-units\s*=\s*1/, label: 'codegen-units = 1', present: false },
    ];
    let missingSettings = [];
    for (const check of checks) {
      check.present = check.pattern.test(cargoContent);
      if (!check.present) missingSettings.push(check.label);
    }
    if (missingSettings.length > 0) {
      core.warning(
        `📋 Cargo.toml is missing recommended release profile settings:\n` +
          missingSettings.map((s) => `  • ${s}`).join('\n') +
          `\nAdd these under [profile.release] in Cargo.toml.`
      );
    } else {
      core.info('✅ Cargo.toml has recommended release profile settings.');
    }
  }

  // Print suggestions
  core.info(`\n${'─'.repeat(60)}`);
  core.info(`💡 Optimisation Suggestions (${suggestions.length} total):`);
  core.info(`${'─'.repeat(60)}`);
  suggestions.forEach((s, i) => {
    core.info(`\n${i + 1}. ${s.title}`);
    core.info(`   Potential saving : ${s.saving}`);
    core.info(`   Effort           : ${s.effort}`);
    core.info(`   Detail           : ${s.detail}`);
  });
  core.info(`${'─'.repeat(60)}\n`);

  // Write suggestions to a temp file for potential upload as artifact
  const suggestionsReport = {
    generatedAt: new Date().toISOString(),
    contractSizeKb: sizeKb.toFixed(2),
    limitKb: sizeLimitKb,
    percentOfLimit: percentOfLimit.toFixed(1),
    isOverLimit,
    isNearLimit,
    suggestions,
  };

  const reportPath = path.join(os.tmp