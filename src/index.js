async function stepBuildContract(contractPath) {
  core.startGroup('Step 1 — Build Contract WASM');

  // If the input is already a .wasm file, skip building
  if (contractPath.endsWith('.wasm') && fs.existsSync(contractPath)) {
    core.info(`Contract path points directly to a WASM file — skipping build step.`);
    core.info(`  File: ${contractPath}`);
    core.endGroup();
    return {
      wasmPath: path.resolve(contractPath),
      built: false,
      projectType: 'prebuilt',
    };
  }

  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract path does not exist: ${contractPath}`);
  }

  const stat = fs.statSync(contractPath);
  if (!stat.isDirectory()) {
    throw new Error(`Contract path must be a directory or a .wasm file: ${contractPath}`);
  }

  const projectType = detectProjectType(contractPath);
  core.info(`Detected project type: ${projectType}`);

  let wasmPath = null;

  // ── Rust / near-sdk-rs ──────────────────────────────────────────────────
  if (projectType === 'rust') {
    if (!commandExists('cargo')) {
      throw new Error('cargo is not installed. Please add a Rust toolchain setup step.');
    }

    // Ensure wasm32 target is installed
    try {
      runCommand(
        'rustup target add wasm32-unknown-unknown',
        contractPath,
        'Install wasm32 target'
      );
    } catch (e) {
      core.warning(`Could not install wasm32 target automatically: ${e.message}`);
    }

    // Read package name from Cargo.toml to find the output file
    let crateName = null;
    try {
      const cargoToml = fs.readFileSync(path.join(contractPath, 'Cargo.toml'), 'utf8');
      const nameMatch = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (nameMatch) crateName = nameMatch[1].replace(/-/g, '_');
    } catch {
      /* non-fatal */
    }

    // Build with release profile targeting wasm32
    runCommand(
      'cargo build --target wasm32-unknown-unknown --release',
      contractPath,
      'cargo build --release (wasm32)'
    );

    // Locate the produced wasm
    const targetDir = path.join(contractPath, 'target', 'wasm32-unknown-unknown', 'release');
    if (crateName && fs.existsSync(path.join(targetDir, `${crateName}.wasm`))) {
      wasmPath = path.join(targetDir, `${crateName}.wasm`);
    } else {
      // Search for any .wasm in release dir
      const candidates = fs
        .readdirSync(targetDir)
        .filter((f) => f.endsWith('.wasm') && !f.includes('deps'));
      if (candidates.length === 0) {
        throw new Error(`No WASM file found in ${targetDir} after build.`);
      }
      // Prefer the largest one (most likely the contract, not a dep)
      candidates.sort((a, b) => {
        const sa = fs.statSync(path.join(targetDir, a)).size;
        const sb = fs.statSync(path.join(targetDir, b)).size;
        return sb - sa;
      });
      wasmPath = path.join(targetDir, candidates[0]);
      core.info(`  Resolved WASM: ${candidates[0]}`);
    }

    // Optional: run wasm-opt if available (mirrors what near-cli does)
    if (commandExists('wasm-opt')) {
      const optimisedPath = wasmPath.replace('.wasm', '_opt.wasm');
      try {
        runCommand(
          `wasm-opt -Oz --strip-debug --output "${optimisedPath}" "${wasmPath}"`,
          contractPath,
          'wasm-opt -Oz'
        );
        const origSize = fs.statSync(wasmPath).size;
        const optSize = fs.statSync(optimisedPath).size;
        core.info(
          `  wasm-opt: ${formatSize(origSize)} → ${formatSize(optSize)} ` +
            `(saved ${formatSize(origSize - optSize)})`
        );
        wasmPath = optimisedPath;
      } catch (e) {
        core.warning(`wasm-opt failed, using unoptimised WASM: ${e.message}`);
      }
    } else {
      core.info('  wasm-opt not found — skipping post-build optimisation.');
    }
  }

  // ── JavaScript / near-sdk-js ────────────────────────────────────────────
  else if (projectType === 'js') {
    const pkg = JSON.parse(fs.readFileSync(path.join(contractPath, 'package.json'), 'utf8'));

    // Install deps
    const hasYarnLock = fs.existsSync(path.join(contractPath, 'yarn.lock'));
    const installCmd = hasYarnLock ? 'yarn install --frozen-lockfile' : 'npm ci';
    try {
      runCommand(installCmd, contractPath, 'Install JS dependencies');
    } catch {
      runCommand('npm install', contractPath, 'Install JS dependencies (fallback)');
    }

    // Run build script
    const buildScript = pkg.scripts?.build || pkg.scripts?.compile;
    if (!buildScript) {
      throw new Error(
        'No "build" or "compile" script found in package.json. ' +
          'Please add one that outputs a .wasm file.'
      );
    }
    const buildCmd = hasYarnLock ? 'yarn build' : 'npm run build';
    runCommand(buildCmd, contractPath, `${buildCmd}`);

    // Find produced wasm
    const wasmFiles = findWasmFiles(contractPath).filter(
      (f) => !f.includes('node_modules')
    );
    if (wasmFiles.length === 0) {
      throw new Error('No WASM files found after JS build.');
    }
    // Pick largest
    wasmFiles.sort(
      (a, b) => fs.statSync(b).size - fs.statSync(a).size
    );
    wasmPath = wasmFiles[0];
    core.info(`  Selected WASM: ${wasmPath}`);
  }

  // ── AssemblyScript ──────────────────────────────────────────────────────
  else if (projectType === 'assemblyscript') {
    runCommand('npm install', contractPath, 'Install AS dependencies');
    runCommand('npm run asbuild', contractPath, 'asbuild');

    const wasmFiles = findWasmFiles(path.join(contractPath, 'build'));
    if (wasmFiles.length === 0) {
      throw new Error('No WASM files found after AssemblyScript build.');
    }
    wasmFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    wasmPath = wasmFiles[0];
  }

  // ── Unknown — search for existing WASM ─────────────────────────────────
  else {
    core.warning(
      'Could not detect project type. Searching for pre-built WASM files in the directory…'
    );
    const wasmFiles = findWasmFiles(contractPath);
    if (wasmFiles.length === 0) {
      throw new Error(
        'No WASM files found and could not determine how to build the project. ' +
          'Please supply the path to a pre-built .wasm file via contract_path.'
      );
    }
    wasmFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    wasmPath = wasmFiles[0];
    core.info(`  Using existing WASM: ${wasmPath}`);
  }

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at expected location: ${wasmPath}`);
  }

  if (!isWasmFile(wasmPath)) {
    throw new Error(`File does not appear to be a valid WASM binary: ${wasmPath}`);
  }

  const size = fs.statSync(wasmPath).size;
  core.info(`✅ Build complete — WASM: ${wasmPath} (${formatSize(size)})`);
  core.endGroup();

  return { wasmPath: path.resolve(wasmPath), built: true, projectType };
}

// ─── Step 2: Check size against limits ───────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitKB, warningThresholdKB) {
  core.startGroup('Step 2 — Check Size Against Limits');

  const sizeLimitBytes = sizeLimitKB * 1024;
  const warningThresholdBytes = warningThresholdKB * 1024;

  const stat = fs.statSync(wasmPath);
  const actualBytes = stat.size;
  const actualKB = actualBytes / 1024;

  core.info(`Contract WASM size : ${formatSize(actualBytes)} (${actualBytes.toLocaleString()} bytes)`);
  core.info(`Warning threshold  : ${formatSize(warningThresholdBytes)} (${warningThresholdKB} KB)`);
  core.info(`Hard size limit    : ${formatSize(sizeLimitBytes)} (${sizeLimitKB} KB)`);
  core.info(`NEAR protocol max  : ${formatSize(NEAR_MAX_CONTRACT_SIZE_BYTES)} (4096 KB)`);

  // Derive absolute max
  const absoluteMax = Math.min(sizeLimitBytes, NEAR_MAX_CONTRACT_SIZE_BYTES);

  const usagePercent = percentOf(actualBytes, absoluteMax);
  core.info(`Usage vs limit     : ${usagePercent}%`);

  let sizeStatus = 'ok'; // 'ok' | 'warning' | 'exceeded'

  if (actualBytes > absoluteMax) {
    sizeStatus = 'exceeded';
    core.error(
      `❌ Contract size (${formatSize(actualBytes)}) EXCEEDS the limit ` +
        `of ${formatSize(absoluteMax)}!`
    );
  } else if (actualBytes > warningThresholdBytes) {
    sizeStatus = 'warning';
    const headroom = absoluteMax - actualBytes;
    core.warning(
      `⚠️  Contract size (${formatSize(actualBytes)}) exceeds warning threshold ` +
        `(${formatSize(warningThresholdBytes)}). Only ${formatSize(headroom)} of headroom remains.`
    );
  } else {
    const headroom = absoluteMax - actualBytes;
    core.info(`✅ Contract size is within acceptable limits. ${formatSize(headroom)} of headroom remaining.`);
  }

  // Set outputs for later steps
  core.setOutput('contract_size_bytes', actualBytes.toString());
  core.setOutput('contract_size_kb', actualKB.toFixed(2));
  core.setOutput('size_limit_bytes', absoluteMax.toString());
  core.setOutput('size_status', sizeStatus);
  core.setOutput('usage_percent', usagePercent);

  core.endGroup();

  return {
    actualBytes,
    actualKB,
    sizeLimitBytes: absoluteMax,
    warningThresholdBytes,
    sizeStatus,
    usagePercent,
  };
}

// ─── Step 3: Compare with previous build ─────────────────────────────────────

async function stepCompareWithBaseline(wasmPath, baselineWasmPath, actualBytes) {
  core.startGroup('Step 3 — Compare With Previous Build');

  if (!baselineWasmPath || baselineWasmPath.trim() === '') {
    core.info('No baseline WASM path provided — skipping comparison.');
    core.endGroup();
    return { hasBaseline: false, delta: 0, deltaKB: 0, deltaPercent: 0 };
  }

  if (!fs.existsSync(baselineWasmPath)) {
    core.warning(`Baseline WASM not found at: ${baselineWasmPath} — skipping comparison.`);
    core.endGroup();
    return { hasBaseline: false, delta: 0, deltaKB: 0, deltaPercent: 0 };
  }

  if (!isWasmFile(baselineWasmPath)) {
    core.warning(`Baseline file does not appear to be a valid WASM binary — skipping.`);
    core.endGroup();
    return { hasBaseline: false, delta: 0, deltaKB: 0, deltaPercent: 0 };
  }

  const baselineBytes = fs.statSync(baselineWasmPath).size;
  const delta = actualBytes - baselineBytes;
  const deltaKB = delta / 1024;
  const deltaPercent = ((delta / baselineBytes) * 100).toFixed(2);

  core.info(`Baseline size : ${formatSize(baselineBytes)}`);
  core.info(`Current size  : ${formatSize(actualBytes)}`);

  if (delta === 0) {
    core.info('📊 Size unchanged from baseline.');
  } else if (delta > 0) {
    core.warning(
      `📈 Contract GREW by ${formatSize(Math.abs(delta))} (+${deltaPercent}%) compared to baseline.`
    );
  } else {
    core.info(
      `📉 Contract SHRANK by ${formatSize(Math.abs(delta))} (${deltaPercent}%) compared to baseline.`
    );
  }

  // Build a human-readable comparison table
  const rows = [
    ['Metric', 'Baseline', 'Current', 'Delta'],
    ['Size (bytes)', baselineBytes.toLocaleString(), actualBytes.toLocaleString(), (delta >= 0 ? '+' : '') + delta.toLocaleString()],
    ['Size (KB)', bytesToKB(baselineBytes), bytesToKB(actualBytes), (deltaKB >= 0 ? '+' : '') + deltaKB.toFixed(2)],
    ['Size (MB)', bytesToMB(baselineBytes), bytesToMB(actualBytes), (deltaKB >= 0 ? '+' : '') + bytesToMB(Math.abs(delta))],
  ];

  const colWidths = rows[0].map((_, ci) => Math.max(...rows.map((r) => String(r[ci]).length)));
  const separator = colWidths.map((w) => '-'.repeat(w + 2)).join('+');

  core.info('');
  core.info('Size Comparison:');
  core.info(separator);
  for (const row of rows) {
    const line = row.map((cell, ci) => String(cell).padEnd(colWidths[ci])).join(' | ');
    core.info(`  ${line}`);
  }
  core.info(separator);

  core.setOutput('baseline_size_bytes', baselineBytes.toString());
  core.setOutput('size_delta_bytes', delta.toString());
  core.setOutput('size_delta_kb', deltaKB.toFixed(2));
  core.setOutput('size_delta_percent', deltaPercent);

  core.endGroup();

  return { hasBaseline: true, baselineBytes, delta, deltaKB: parseFloat(deltaKB.toFixed(2)), deltaPercent };
}

// ─── Step 4: Suggest optimizations ───────────────────────────────────────────

async function stepSuggestOptimizations(
  wasmPath,
  projectType,
  sizeStatus,
  actualBytes,
  sizeLimitBytes,
  delta
) {
  core.startGroup('Step 4 — Optimization Suggestions');

  const suggestions = [];

  // Always-applicable suggestions
  if (!commandExists('wasm-opt')) {
    suggestions.push({
      priority: 'high',
      category: 'Tooling',
      title: 'Install and run wasm-opt',
      detail:
        'wasm-opt (from the Binaryen toolchain) can significantly reduce WASM size. ' +
        'Run: `wasm-opt -Oz --strip-debug -o output.wasm input.wasm`. ' +
        'This can often reduce size by 10–30%.',
    });
  }

  if (projectType === 'rust') {
    suggestions.push(
      {
        priority: 'high',
        category: 'Rust Cargo',
        title: 'Enable LTO and size optimisations in Cargo.toml',
        detail:
          'Add to Cargo.toml:\n' +
          '  [profile.release]\n' +
          '  codegen-units = 1\n' +
          '  opt-level = "z"     # Optimise for size\n' +
          '  lto = true\n' +
          '  panic = "abort"\n' +
          '  strip = true',
      },
      {
        priority: 'medium',
        category: 'Rust',
        title: 'Use #[no_std] where possible',
        detail:
          'Avoiding the standard library removes substantial overhead. ' +
          'near-sdk-rs contracts can often use no_std mode.',
      },
      {
        priority: 'medium',
        category: 'Rust',
        title: 'Minimise dependencies',
        detail:
          'Each crate you depend on adds to binary size. ' +
          'Audit with `cargo bloat --release --crates` to see per-crate contributions.',
      },
      {
        priority: 'low',
        category: 'Rust',
        title: 'Remove unused features from dependencies',
        detail:
          'Use `default-features = false` on dependencies and only enable the features you need.',
      },
      {
        priority: 'low',
        category: 'Rust',
        title: 'Use twiggy to analyse WASM symbol sizes',
        detail:
          '`twiggy top -n 20 contract.wasm` lists the largest functions/sections so you can target reduction effort.',
      }
    );
  }

  if (projectType === 'js') {
    suggestions.push(
      {
        priority: 'high',
        category: 'JS/TS',
        title: 'Enable Rollup/webpack tree-shaking',
        detail:
          'Ensure your bundler is tree-shaking unused exports. ' +
          'For near-sdk-js projects, use the official `near-sdk-js` build toolchain which is pre-configured.',
      },
      {
        priority: 'medium',
        category: 'JS/TS',
        title: 'Use `near-sdk-js` decorators and avoid heavy runtime libs',
        detail:
          'Avoid importing large npm packages inside contract code. ' +
          'Prefer pure JS utilities over frameworks.',
      }
    );
  }

  if (actualBytes > 0.8 * sizeLimitBytes) {
    suggestions.push({
      priority: 'critical',
      category: 'Architecture',
      title: