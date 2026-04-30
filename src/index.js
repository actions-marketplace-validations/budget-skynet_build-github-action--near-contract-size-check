async function stepResolveAndBuild(contractPath) {
  core.startGroup('🔨 Step 1: Resolve Contract & Build WASM');

  const absoluteContractPath = path.resolve(contractPath);
  core.info(`Resolved contract path: ${absoluteContractPath}`);

  if (!fs.existsSync(absoluteContractPath)) {
    throw new Error(`Contract path does not exist: ${absoluteContractPath}`);
  }

  const stat = fs.statSync(absoluteContractPath);

  // If it's already a WASM file, use it directly
  if (stat.isFile() && absoluteContractPath.endsWith('.wasm')) {
    core.info(`Contract path points directly to a WASM file.`);
    core.endGroup();
    return { wasmPath: absoluteContractPath, builtDuringRun: false };
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `Contract path must be a directory or a .wasm file: ${absoluteContractPath}`
    );
  }

  const projectType = detectProjectType(absoluteContractPath);
  core.info(`Detected project type: ${projectType}`);

  let wasmPath = null;
  let builtDuringRun = false;

  if (projectType === 'rust') {
    core.info('Building Rust NEAR contract with cargo...');

    // Check if cargo is available
    const cargoCheck = exec('cargo --version');
    if (!cargoCheck.success) {
      throw new Error(
        'cargo is not available. Please ensure Rust is installed in the runner.'
      );
    }
    core.info(`Cargo version: ${cargoCheck.stdout.trim()}`);

    // Add wasm32 target if not present
    const targetCheck = exec('rustup target list --installed');
    if (targetCheck.success && !targetCheck.stdout.includes('wasm32-unknown-unknown')) {
      core.info('Adding wasm32-unknown-unknown target...');
      const addTarget = exec('rustup target add wasm32-unknown-unknown');
      if (!addTarget.success) {
        throw new Error(`Failed to add wasm32 target: ${addTarget.stderr}`);
      }
    }

    // Parse Cargo.toml to get package name
    const cargoTomlPath = path.join(absoluteContractPath, 'Cargo.toml');
    const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    const nameMatch = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const packageName = nameMatch ? nameMatch[1] : null;

    // Build in release mode
    const buildResult = exec(
      'cargo build --target wasm32-unknown-unknown --release',
      { cwd: absoluteContractPath }
    );

    if (!buildResult.success) {
      core.error(`Build stdout: ${buildResult.stdout}`);
      core.error(`Build stderr: ${buildResult.stderr}`);
      throw new Error(`Cargo build failed: ${buildResult.error}`);
    }

    core.info('Cargo build succeeded.');

    // Find built WASM files
    const targetDir = path.join(
      absoluteContractPath,
      'target',
      'wasm32-unknown-unknown',
      'release'
    );

    if (!fs.existsSync(targetDir)) {
      throw new Error(`Expected build output directory not found: ${targetDir}`);
    }

    // Look for specific package wasm first, then any wasm
    if (packageName) {
      const candidateName = packageName.replace(/-/g, '_') + '.wasm';
      const candidatePath = path.join(targetDir, candidateName);
      if (fileExists(candidatePath)) {
        wasmPath = candidatePath;
      }
    }

    if (!wasmPath) {
      const wasmFiles = fs
        .readdirSync(targetDir)
        .filter((f) => f.endsWith('.wasm') && !f.includes('.d.'))
        .map((f) => path.join(targetDir, f));

      if (wasmFiles.length === 0) {
        throw new Error(`No WASM files found in ${targetDir} after build.`);
      }

      // Pick the largest one as primary artifact
      wasmFiles.sort((a, b) => getFileSize(b) - getFileSize(a));
      wasmPath = wasmFiles[0];
    }

    builtDuringRun = true;
    core.info(`Located built WASM: ${wasmPath}`);

  } else if (projectType === 'javascript' || projectType === 'assemblyscript') {
    core.info(`Building ${projectType} NEAR contract...`);

    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(absoluteContractPath, 'package.json'), 'utf8')
    );

    // Install dependencies
    const hasYarnLock = fileExists(path.join(absoluteContractPath, 'yarn.lock'));
    const hasPnpmLock = fileExists(
      path.join(absoluteContractPath, 'pnpm-lock.yaml')
    );

    let installCmd = 'npm install';
    if (hasYarnLock) installCmd = 'yarn install --frozen-lockfile';
    if (hasPnpmLock) installCmd = 'pnpm install --frozen-lockfile';

    core.info(`Installing dependencies: ${installCmd}`);
    const installResult = exec(installCmd, { cwd: absoluteContractPath });
    if (!installResult.success) {
      core.warning(
        `Dependency install warning: ${installResult.stderr}. Continuing...`
      );
    }

    // Try build scripts in order of preference
    const buildScripts = ['build:release', 'build', 'compile'];
    let buildSucceeded = false;

    for (const script of buildScripts) {
      if (pkgJson.scripts && pkgJson.scripts[script]) {
        core.info(`Running npm script: ${script}`);
        const buildResult = exec(`npm run ${script}`, {
          cwd: absoluteContractPath,
        });
        if (buildResult.success) {
          buildSucceeded = true;
          core.info(`Build script '${script}' succeeded.`);
          break;
        } else {
          core.warning(
            `Build script '${script}' failed: ${buildResult.stderr}`
          );
        }
      }
    }

    if (!buildSucceeded) {
      throw new Error(
        'No valid build script found or all build scripts failed. ' +
          'Expected scripts: build:release, build, or compile in package.json.'
      );
    }

    // Find WASM output
    const wasmFiles = findWasmFiles(absoluteContractPath);
    if (wasmFiles.length === 0) {
      throw new Error(
        `No WASM files found in ${absoluteContractPath} after build.`
      );
    }
    // Pick most recently modified
    wasmFiles.sort(
      (a, b) =>
        fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    );
    wasmPath = wasmFiles[0];
    builtDuringRun = true;
    core.info(`Located built WASM: ${wasmPath}`);

  } else {
    // Unknown project type — search for existing WASM files
    core.info(
      'Unknown project type. Searching for existing WASM files in directory...'
    );
    const wasmFiles = findWasmFiles(absoluteContractPath);
    if (wasmFiles.length === 0) {
      throw new Error(
        `Cannot determine how to build project at ${absoluteContractPath}. ` +
          'No Cargo.toml or package.json found, and no existing WASM files located.'
      );
    }
    wasmFiles.sort(
      (a, b) =>
        fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    );
    wasmPath = wasmFiles[0];
    core.warning(
      `Could not identify build system. Using existing WASM file: ${wasmPath}`
    );
  }

  core.endGroup();
  return { wasmPath, builtDuringRun };
}

// ─── Step 2: Check size against limits ───────────────────────────────────────
async function stepCheckSizeAgainstLimits(wasmPath, sizeLimitKB, warningThresholdPercent) {
  core.startGroup('📏 Step 2: Check Size Against Limits');

  if (!fileExists(wasmPath)) {
    throw new Error(`WASM file not found at path: ${wasmPath}`);
  }

  const sizeBytes = getFileSize(wasmPath);
  const sizeKB = bytesToKB(sizeBytes);
  const limitBytes = sizeLimitKB * BYTES_PER_KB;
  const usagePercent = (sizeBytes / limitBytes) * 100;
  const warningThresholdKB = (warningThresholdPercent / 100) * sizeLimitKB;

  core.info(`WASM file: ${wasmPath}`);
  core.info(`Contract size: ${formatSize(sizeBytes)} (${sizeBytes} bytes)`);
  core.info(`Size limit: ${formatSize(limitBytes)} (${limitBytes} bytes)`);
  core.info(
    `Usage: ${usagePercent.toFixed(2)}% of limit`
  );
  core.info(
    `Warning threshold: ${warningThresholdPercent}% = ${warningThresholdKB.toFixed(2)} KB`
  );

  const isOverLimit = sizeKB > sizeLimitKB;
  const isNearLimit = !isOverLimit && sizeKB >= warningThresholdKB;
  const remaining = sizeLimitKB - sizeKB;

  if (isOverLimit) {
    const overByKB = sizeKB - sizeLimitKB;
    core.error(
      `❌ Contract size ${sizeKB.toFixed(2)} KB exceeds limit of ${sizeLimitKB} KB ` +
        `(over by ${overByKB.toFixed(2)} KB)`
    );
  } else if (isNearLimit) {
    core.warning(
      `⚠️  Contract size ${sizeKB.toFixed(2)} KB is approaching the limit ` +
        `(${usagePercent.toFixed(2)}% used, ${remaining.toFixed(2)} KB remaining)`
    );
  } else {
    core.info(
      `✅ Contract size ${sizeKB.toFixed(2)} KB is within limits ` +
        `(${usagePercent.toFixed(2)}% used, ${remaining.toFixed(2)} KB remaining)`
    );
  }

  core.endGroup();

  return {
    sizeBytes,
    sizeKB,
    sizeLimitKB,
    limitBytes,
    usagePercent,
    warningThresholdKB,
    isOverLimit,
    isNearLimit,
    remaining,
  };
}

// ─── Step 3: Compare with previous/baseline build ────────────────────────────
async function stepCompareWithBaseline(currentSizeBytes, baselineWasmPath) {
  core.startGroup('📊 Step 3: Compare With Baseline Build');

  if (!baselineWasmPath) {
    core.info('No baseline WASM path provided. Skipping comparison.');
    core.endGroup();
    return { hasBaseline: false };
  }

  const absoluteBaselinePath = path.resolve(baselineWasmPath);

  if (!fileExists(absoluteBaselinePath)) {
    core.warning(
      `Baseline WASM file not found at: ${absoluteBaselinePath}. Skipping comparison.`
    );
    core.endGroup();
    return { hasBaseline: false };
  }

  const baselineSizeBytes = getFileSize(absoluteBaselinePath);
  const diffBytes = currentSizeBytes - baselineSizeBytes;
  const diffKB = bytesToKB(Math.abs(diffBytes));
  const diffPercent =
    baselineSizeBytes > 0
      ? (diffBytes / baselineSizeBytes) * 100
      : 0;

  const increased = diffBytes > 0;
  const decreased = diffBytes < 0;
  const unchanged = diffBytes === 0;

  core.info(`Current size:  ${formatSize(currentSizeBytes)}`);
  core.info(`Baseline size: ${formatSize(baselineSizeBytes)}`);

  if (unchanged) {
    core.info('📌 Size is unchanged from baseline.');
  } else if (increased) {
    const symbol = diffPercent > 10 ? '🔴' : diffPercent > 5 ? '🟡' : '🟢';
    core.info(
      `${symbol} Size INCREASED by ${formatSize(Math.abs(diffBytes))} ` +
        `(+${diffPercent.toFixed(2)}%) from baseline`
    );
    if (diffPercent > 10) {
      core.warning(
        `Contract grew by more than 10% compared to baseline. ` +
          `Consider reviewing recent changes.`
      );
    }
  } else if (decreased) {
    core.info(
      `✅ Size DECREASED by ${formatSize(Math.abs(diffBytes))} ` +
        `(${diffPercent.toFixed(2)}%) from baseline`
    );
  }

  // Generate comparison table for summary
  const comparisonData = {
    hasBaseline: true,
    baselineSizeBytes,
    baselineSizeKB: bytesToKB(baselineSizeBytes),
    diffBytes,
    diffKB,
    diffPercent,
    increased,
    decreased,
    unchanged,
  };

  core.endGroup();
  return comparisonData;
}

// ─── Step 4: Suggest optimizations ───────────────────────────────────────────
async function stepSuggestOptimizations(
  wasmPath,
  sizeInfo,
  comparisonData,
  enableSuggestions
) {
  core.startGroup('💡 Step 4: Optimization Suggestions');

  if (!enableSuggestions) {
    core.info('Optimization suggestions disabled via input.');
    core.endGroup();
    return { suggestions: [] };
  }

  const suggestions = [];
  const { sizeKB, sizeLimitKB, isOverLimit, isNearLimit, usagePercent } =
    sizeInfo;

  // Detect if wasm-opt is available
  const wasmOptCheck = exec('wasm-opt --version');
  const hasWasmOpt = wasmOptCheck.success;

  if (hasWasmOpt) {
    core.info(`wasm-opt detected: ${wasmOptCheck.stdout.trim()}`);
  }

  // Detect if wasm-snip is available
  const wasmSnipCheck = exec('wasm-snip --version 2>/dev/null || wasm-snip -V 2>/dev/null');
  const hasWasmSnip = wasmSnipCheck.success;

  // Check for debug symbols using wasm-objdump or wasm-nm if available
  let hasDebugSections = false;
  const wasmDumpCheck = exec(`wasm-objdump -h "${wasmPath}" 2>/dev/null || true`);
  if (wasmDumpCheck.stdout.includes('.debug_')) {
    hasDebugSections = true;
  }

  // Read wasm binary for heuristics
  let wasmBuffer = null;
  try {
    wasmBuffer = fs.readFileSync(wasmPath);
  } catch {
    core.warning('Could not read WASM file for analysis.');
  }

  // Heuristic: check for custom name section (debug names increase size)
  let hasNameSection = false;
  if (wasmBuffer) {
    const bufferStr = wasmBuffer.toString('binary');
    hasNameSection = bufferStr.includes('name');
  }

  // ── Build optimization suggestions ──────────────────────────────────────

  if (isOverLimit || isNearLimit || usagePercent > 70) {
    // General suggestions
    suggestions.push({
      priority: 'HIGH',
      title: 'Use wasm-opt for binary optimization',
      description:
        'Run `wasm-opt -Oz --output optimized.wasm input.wasm` to apply size optimizations. ' +
        'This can reduce WASM size by 10-40%.',
      command: hasWasmOpt
        ? `wasm-opt -Oz --strip-debug --output "${wasmPath}.opt.wasm" "${wasmPath}"`
        : 'Install binaryen: https://github.com/WebAssembly/binaryen',
      estimated_saving: '10-40%',
    });

    suggestions.push({
      priority: 'HIGH',
      title: 'Enable Link-Time Optimization (LTO) in Rust',
      description:
        'Add to Cargo.toml: [profile.release] lto = true, codegen-units = 1, opt-level = "z"',
      code_snippet: `[profile.release]\nlto = true\ncodegen-units = 1\nopt-level = "z"\npanic = "abort"`,
      estimated_saving: '5-25%',
    });

    suggestions.push({
      priority: 'HIGH',
      title: 'Use panic = "abort" instead of panic = "unwind"',
      description:
        'In Cargo.toml, set `panic = "abort"` under [profile.release] to eliminate unwinding code.',
      code_snippet: `[profile.release]\npanic = "abort"`,
      estimated_saving: '5-15%',
    });
  }

  if (hasDebugSections || hasNameSection) {
    suggestions.push({
      priority: 'MEDIUM',
      title: 'Strip debug information',
      description:
        'Your WASM appears to contain debug sections. Strip them to reduce size.',
      command: hasWasmOpt
        ? `wasm-opt --strip-debug --strip-producers -o "${wasmPath}.stripped.wasm" "${wasmPath}"`
        : `wasm-strip "${wasmPath}"`,
      estimated_saving: '5-20%',
    });
  }

  suggestions.push({
    priority: 'MEDIUM',
    title: 'Avoid std features and use no_std',
    description:
      'In Rust, use #![no_std] where possible or minimize std feature flags to reduce code bloat.',
    estimated_saving: '2-10%',
  });

  suggestions.push({
    priority: 'MEDIUM',
    title: 'Minimize dependencies',
    description:
      'Each dependency adds to WASM size. Review Cargo.toml for unused or heavyweight crates. ' +
      'Use `cargo bloat --release --target wasm32-unknown-unknown` to identify large contributors.',
    command: 'cargo bloat --release --target wasm32-unknown-unknown',
    estimated_saving: 'varies',
  });

  suggestions.push({
    priority: 'MEDIUM',
    title: 'Use near-sdk features selectively',
    description:
      'Import only required features from near-sdk. Disable default features if not needed.',
    code_snippet: `near-sdk = { version = "5.0", default-features = false, features = ["legacy"] }`,
    estimated_saving: '2-8%',
  });

  if (hasWasmSnip) {
    suggestions.push({
      priority: 'LOW',
      title: 'Use wasm-snip to remove