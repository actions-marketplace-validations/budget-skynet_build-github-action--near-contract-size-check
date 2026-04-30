async function stepBuildContract(contractPath) {
  core.startGroup('Step 1 — Build contract WASM');
  let wasmPath = null;

  const absContractPath = path.resolve(contractPath);

  // If the caller pointed directly at a .wasm file, skip building
  if (absContractPath.endsWith('.wasm') && fs.existsSync(absContractPath)) {
    log(`Contract path is already a WASM file: ${absContractPath}`);
    if (!isWasmFile(absContractPath)) {
      throw new Error(`File ${absContractPath} does not appear to be a valid WASM binary.`);
    }
    wasmPath = absContractPath;
    core.endGroup();
    return wasmPath;
  }

  if (!fs.existsSync(absContractPath)) {
    throw new Error(`Contract path does not exist: ${absContractPath}`);
  }

  const stat = fs.statSync(absContractPath);
  if (!stat.isDirectory()) {
    throw new Error(`Contract path is not a directory or .wasm file: ${absContractPath}`);
  }

  // Detect contract type and build accordingly
  const files = fs.readdirSync(absContractPath);
  const hasCargoToml = files.includes('Cargo.toml');
  const hasPackageJson = files.includes('package.json');
  const hasAssemblyScript = files.includes('asconfig.json') || files.includes('assembly');

  if (hasCargoToml) {
    log('Detected Rust contract (Cargo.toml found)');
    wasmPath = await buildRustContract(absContractPath);
  } else if (hasAssemblyScript || hasPackageJson) {
    log('Detected AssemblyScript/JS contract');
    wasmPath = await buildAssemblyScriptContract(absContractPath);
  } else {
    // Last resort: search for existing wasm files
    log('No recognised build system found — searching for existing WASM files');
    const found = findWasmFiles(absContractPath).filter(isWasmFile);
    if (found.length === 0) {
      throw new Error(
        `No Cargo.toml, package.json, or .wasm files found under ${absContractPath}. ` +
          'Provide a valid contract directory or a pre-built .wasm file path.'
      );
    }
    // Prefer release artefacts
    const release = found.filter((f) => f.includes('release'));
    wasmPath = release.length > 0 ? release[0] : found[0];
    log(`Using existing WASM: ${wasmPath}`);
  }

  core.endGroup();
  return wasmPath;
}

async function buildRustContract(contractDir) {
  // Ensure toolchain prerequisites
  const cargoCheck = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (cargoCheck.error || cargoCheck.status !== 0) {
    throw new Error('cargo is not installed. Please add a Rust toolchain setup step before this action.');
  }

  // Add wasm32 target if not present
  try {
    execCommand('rustup target add wasm32-unknown-unknown', contractDir);
  } catch {
    log('Warning: could not run rustup target add (may already be installed)');
  }

  // Check for cargo-near
  const cargoNearCheck = spawnSync('cargo', ['near', '--version'], { encoding: 'utf8' });
  if (!cargoNearCheck.error && cargoNearCheck.status === 0) {
    log('Using cargo-near for optimised build');
    execCommand('cargo near build --no-abi', contractDir);
  } else {
    log('Using standard cargo build --target wasm32-unknown-unknown --release');
    execCommand(
      'cargo build --target wasm32-unknown-unknown --release',
      contractDir,
      { RUSTFLAGS: '-C link-arg=-s' }
    );
  }

  // Find the produced wasm
  const wasmFiles = findWasmFiles(path.join(contractDir, 'target')).filter(
    (f) => f.includes('release') && isWasmFile(f)
  );
  if (wasmFiles.length === 0) {
    throw new Error('Build succeeded but no .wasm file found under target/');
  }
  // Prefer the smallest release wasm (cargo-near may produce multiple)
  wasmFiles.sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  log(`Built WASM: ${wasmFiles[0]}`);
  return wasmFiles[0];
}

async function buildAssemblyScriptContract(contractDir) {
  // Install deps if needed
  if (!fs.existsSync(path.join(contractDir, 'node_modules'))) {
    log('Installing npm dependencies');
    execCommand('npm install', contractDir);
  }

  // Try common build scripts
  let built = false;
  for (const script of ['build', 'build:release', 'compile']) {
    try {
      const pkgRaw = fs.readFileSync(path.join(contractDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw);
      if (pkg.scripts && pkg.scripts[script]) {
        log(`Running npm run ${script}`);
        execCommand(`npm run ${script}`, contractDir);
        built = true;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!built) {
    // Try direct asc invocation
    log('Attempting direct AssemblyScript compile');
    execCommand('npx asc assembly/index.ts --target release', contractDir);
  }

  const wasmFiles = findWasmFiles(contractDir).filter(isWasmFile);
  if (wasmFiles.length === 0) {
    throw new Error('AssemblyScript build produced no .wasm files.');
  }
  wasmFiles.sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  log(`Built WASM: ${wasmFiles[0]}`);
  return wasmFiles[0];
}

// ─── Step 2: Check size against limits ───────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('Step 2 — Check size against limits');

  const stats = fs.statSync(wasmPath);
  const sizeBytes = stats.size;
  const sizeKb = sizeBytes / 1024;
  const limitBytes = sizeLimitKb * 1024;
  const warningBytes = limitBytes * (warningThresholdPercent / 100);
  const usagePercent = (sizeBytes / limitBytes) * 100;

  log(`WASM file   : ${wasmPath}`);
  log(`Size        : ${formatBytes(sizeBytes)} (${sizeKb.toFixed(2)} KB)`);
  log(`Limit       : ${formatBytes(limitBytes)} (${sizeLimitKb} KB)`);
  log(`Warning at  : ${formatBytes(warningBytes)} (${warningThresholdPercent}% of limit)`);
  log(`Usage       : ${usagePercent.toFixed(1)}%`);

  const status = sizeBytes > limitBytes
    ? 'EXCEEDED'
    : sizeBytes > warningBytes
    ? 'WARNING'
    : 'OK';

  if (status === 'EXCEEDED') {
    core.error(
      `❌ Contract size ${formatBytes(sizeBytes)} EXCEEDS limit of ${formatBytes(limitBytes)}!`
    );
  } else if (status === 'WARNING') {
    core.warning(
      `⚠️  Contract size ${formatBytes(sizeBytes)} is above ${warningThresholdPercent}% ` +
        `of the ${formatBytes(limitBytes)} limit (${usagePercent.toFixed(1)}% used).`
    );
  } else {
    log(`✅ Contract size is within limits (${usagePercent.toFixed(1)}% used).`);
  }

  // Emit outputs
  core.setOutput('contract_size_bytes', String(sizeBytes));
  core.setOutput('contract_size_kb', sizeKb.toFixed(2));
  core.setOutput('size_limit_kb', String(sizeLimitKb));
  core.setOutput('usage_percent', usagePercent.toFixed(1));
  core.setOutput('size_status', status);

  core.endGroup();
  return { sizeBytes, sizeKb, limitBytes, warningBytes, usagePercent, status };
}

// ─── Step 3: Compare with previous builds ────────────────────────────────────

async function stepCompareWithBaseline(currentSizeBytes, baselineWasmUrl) {
  core.startGroup('Step 3 — Compare with previous build');

  let delta = null;
  let baselineSizeBytes = null;
  let comparisonSummary = 'No baseline provided — skipping comparison.';

  if (!baselineWasmUrl) {
    log(comparisonSummary);
    core.setOutput('baseline_size_bytes', '');
    core.setOutput('size_delta_bytes', '');
    core.setOutput('size_delta_kb', '');
    core.endGroup();
    return { delta, baselineSizeBytes, comparisonSummary };
  }

  try {
    let baselinePath;

    if (baselineWasmUrl.startsWith('http://') || baselineWasmUrl.startsWith('https://')) {
      // Download remote baseline
      baselinePath = path.join(os.tmpdir(), `near_baseline_${Date.now()}.wasm`);
      await downloadFile(baselineWasmUrl, baselinePath);
    } else {
      // Local path
      baselinePath = path.resolve(baselineWasmUrl);
      if (!fs.existsSync(baselinePath)) {
        throw new Error(`Baseline WASM path does not exist: ${baselinePath}`);
      }
    }

    const baselineStats = fs.statSync(baselinePath);
    baselineSizeBytes = baselineStats.size;
    delta = currentSizeBytes - baselineSizeBytes;
    const deltaKb = delta / 1024;
    const sign = delta >= 0 ? '+' : '';

    comparisonSummary =
      `Baseline : ${formatBytes(baselineSizeBytes)}\n` +
      `Current  : ${formatBytes(currentSizeBytes)}\n` +
      `Delta    : ${sign}${formatBytes(Math.abs(delta))} (${sign}${deltaKb.toFixed(2)} KB)`;

    log(comparisonSummary);

    if (delta > 0) {
      core.warning(`⚠️  Contract grew by ${formatBytes(delta)} compared to baseline.`);
    } else if (delta < 0) {
      log(`✅ Contract shrank by ${formatBytes(Math.abs(delta))} compared to baseline.`);
    } else {
      log('Contract size is unchanged from baseline.');
    }

    core.setOutput('baseline_size_bytes', String(baselineSizeBytes));
    core.setOutput('size_delta_bytes', String(delta));
    core.setOutput('size_delta_kb', deltaKb.toFixed(2));

    // Clean up downloaded baseline
    if (baselineWasmUrl.startsWith('http://') || baselineWasmUrl.startsWith('https://')) {
      try { fs.unlinkSync(baselinePath); } catch { /* ignore */ }
    }
  } catch (err) {
    core.warning(`Could not complete baseline comparison: ${err.message}`);
    comparisonSummary = `Baseline comparison failed: ${err.message}`;
    core.setOutput('baseline_size_bytes', '');
    core.setOutput('size_delta_bytes', '');
    core.setOutput('size_delta_kb', '');
  }

  core.endGroup();
  return { delta, baselineSizeBytes, comparisonSummary };
}

// ─── Step 4: Suggest optimizations ───────────────────────────────────────────

async function stepSuggestOptimizations(wasmPath, sizeBytes, sizeLimitBytes, status, enableSuggestions) {
  core.startGroup('Step 4 — Optimization suggestions');

  if (!enableSuggestions) {
    log('Optimization suggestions disabled via input.');
    core.setOutput('optimization_suggestions', '');
    core.endGroup();
    return [];
  }

  const suggestions = [];

  // Always relevant suggestions
  suggestions.push({
    priority: 'HIGH',
    title: 'Strip debug symbols',
    detail:
      'Ensure your release build strips symbols. ' +
      'Add `RUSTFLAGS="-C link-arg=-s"` to your build command or ' +
      'add `[profile.release] strip = true` to Cargo.toml.',
  });

  suggestions.push({
    priority: 'HIGH',
    title: 'Enable LTO (Link Time Optimization)',
    detail:
      'Add to Cargo.toml:\n' +
      '  [profile.release]\n' +
      '  lto = true\n' +
      '  codegen-units = 1\n' +
      'This can reduce binary size by 20-40%.',
  });

  suggestions.push({
    priority: 'HIGH',
    title: 'Use cargo-near for optimised builds',
    detail:
      '`cargo near build` applies NEAR-specific optimisations automatically. ' +
      'Install: `cargo install cargo-near`',
  });

  suggestions.push({
    priority: 'MEDIUM',
    title: 'Apply wasm-opt post-processing',
    detail:
      'Run `wasm-opt -Oz --strip-debug -o output.wasm input.wasm` after building. ' +
      'Install via: `npm install -g wasm-opt` or `apt install binaryen`.',
  });

  suggestions.push({
    priority: 'MEDIUM',
    title: 'Minimise dependencies',
    detail:
      'Audit Cargo.toml for heavy dependencies. ' +
      'Prefer `no_std` crates. Remove unused features with `default-features = false`.',
  });

  suggestions.push({
    priority: 'MEDIUM',
    title: 'Use opt-level = "z" (size-optimised)',
    detail:
      'Add to Cargo.toml:\n' +
      '  [profile.release]\n' +
      '  opt-level = "z"\n' +
      'This optimises for binary size over speed.',
  });

  suggestions.push({
    priority: 'LOW',
    title: 'Avoid large static data / string literals',
    detail:
      'Large inline strings, lookup tables, or embedded assets inflate WASM size significantly. ' +
      'Consider storing large data on-chain or in IPFS and loading at runtime.',
  });

  suggestions.push({
    priority: 'LOW',
    title: 'Split into multiple contracts',
    detail:
      'If your contract is complex, consider splitting logic across multiple contracts ' +
      'and using cross-contract calls to coordinate.',
  });

  // Inspect WASM sections for additional hints
  try {
    const wasmObjDump = spawnSync('wasm-objdump', ['-h', wasmPath], { encoding: 'utf8' });
    if (!wasmObjDump.error && wasmObjDump.status === 0) {
      const output = wasmObjDump.stdout || '';
      if (output.includes('name')) {
        suggestions.push({
          priority: 'HIGH',
          title: 'Strip WASM name section',
          detail:
            'Your WASM contains a "name" debug section. ' +
            'Strip it with: `wasm-strip your_contract.wasm` (install wabt) or ' +
            '`wasm-opt --strip-debug -o out.wasm in.wasm`.',
        });
      }
      if (output.includes('producers')) {
        suggestions.push({
          priority: 'MEDIUM',
          title: 'Remove producers section',
          detail:
            'Your WASM has a "producers" custom section (compiler metadata). ' +
            'Remove with: `wasm-opt --strip-producers -o out.wasm in.wasm`.',
        });
      }
    }
  } catch {
    // wasm-objdump not available — skip
  }

  // Size-specific urgent suggestions
  const usagePercent = (sizeBytes / sizeLimitBytes) * 100;
  if (usagePercent > 90) {
    suggestions.unshift({
      priority: 'CRITICAL',
      title: '🚨 Contract is critically close to or over the size limit',
      detail:
        'Immediate action required. Apply HIGH priority optimizations above. ' +
        'Consider architectural changes such as splitting the contract.',
    });
  }

  // Print suggestions
  const bySeverity = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const sorted = [...suggestions].sort(
    (a, b) => bySeverity.indexOf(a.priority) - bySeverity.indexOf(b.priority)
  );

  log('\n📋 Optimization Recommendations:\n');
  for (const [i, s] of sorted.entries()) {
    const icon = s.priority === 'CRITICAL' ? '🚨' : s.priority === 'HIGH' ? '🔴' : s.priority === 'MEDIUM' ? '🟡' : '🟢';
    log(`${i + 1}. [${icon} ${s.priority}] ${s.title}`);
    log(`   ${s.detail.replace(/\n/g, '\n   ')}`);
    log('');
  }

  const summaryText = sorted
    .map((s) => `[${s.priority}] ${s.title}: ${s.detail}`)
    .join('\n\n');
  core.setOutput('optimization_suggestions', summaryText);

  core.endGroup();
  return sorted;
}

// ─── Step 5: Fail if over limit ───────────────────────────────────────────────

async function stepFailIfOverLimit(status, sizeBytes, limitBytes, failOnLimitExceeded) {
  core.startGroup('Step 5 — Enforce size limit');

  const sizeKb = (sizeBytes / 1024).toFixed(2);
  const limitKb = (limitBytes / 1024).toFixed(2);

  if (status === 'EXCEEDED') {
    const msg =
      `Contract size ${formatBytes(sizeBytes)} (${sizeKb} KB) ` +
      `exceeds the configured limit of ${formatBytes(limitBytes)} (${limitKb} KB).`;

    if (failOnLimitExceeded) {
      core.endGroup();
      throw new Error(`❌ ${msg} Apply the suggested optimizations and rebuild.`);
    } else {
      core.error(`❌ ${msg} (fail_on_limit_exceeded is false — continuing anyway)`);
    }
  } else if (status === 'WARNING') {
    core.warning(
      `