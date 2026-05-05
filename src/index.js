async function stepBuildContract(contractPath, sizeLimitKb) {
  core.startGroup('Step 1: Build Contract WASM');
  core.info(`Contract path input: ${contractPath}`);

  let resolvedPath = path.resolve(contractPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Contract path does not exist: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);

  // If the user pointed directly at a WASM file
  if (stat.isFile()) {
    if (!resolvedPath.endsWith('.wasm')) {
      throw new Error(`File is not a WASM file: ${resolvedPath}`);
    }
    if (!isWasmFile(resolvedPath)) {
      throw new Error(`File does not have a valid WASM magic header: ${resolvedPath}`);
    }
    core.info(`Using pre-built WASM file: ${resolvedPath}`);
    const fileSize = fs.statSync(resolvedPath).size;
    core.info(`WASM file size: ${formatBytes(fileSize)}`);
    core.endGroup();
    return { wasmPath: resolvedPath, wasBuilt: false };
  }

  // It's a directory – detect project type and build
  if (!stat.isDirectory()) {
    throw new Error(`Contract path is neither a file nor a directory: ${resolvedPath}`);
  }

  core.info(`Contract directory: ${resolvedPath}`);

  // Detect project type
  const hasCargoToml = fs.existsSync(path.join(resolvedPath, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(resolvedPath, 'package.json'));
  const hasAssemblyScript = fs.existsSync(path.join(resolvedPath, 'asconfig.json')) ||
    fs.existsSync(path.join(resolvedPath, 'assembly'));

  let wasmPath = null;
  let wasBuilt = true;

  if (hasCargoToml) {
    core.info('Detected Rust/Cargo project. Building with cargo…');
    wasmPath = await buildRustContract(resolvedPath);
  } else if (hasAssemblyScript) {
    core.info('Detected AssemblyScript project. Building…');
    wasmPath = await buildAssemblyScriptContract(resolvedPath);
  } else if (hasPackageJson) {
    core.info('Detected JavaScript/TypeScript project. Building…');
    wasmPath = await buildJsContract(resolvedPath);
  } else {
    // No known build system – search for existing WASM files
    core.warning('No recognised build system found. Searching for existing WASM files…');
    const wasms = findWasmFiles(resolvedPath);
    if (wasms.length === 0) {
      throw new Error(
        'No WASM files found and no supported build system detected. ' +
        'Please pre-build your contract or point contract_path at the WASM file directly.'
      );
    }
    if (wasms.length > 1) {
      core.warning(`Multiple WASM files found; using the largest one:`);
      wasms.forEach(w => core.warning(`  ${w} (${formatBytes(fs.statSync(w).size)})`));
      wasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    }
    wasmPath = wasms[0];
    wasBuilt = false;
  }

  if (!wasmPath || !fs.existsSync(wasmPath)) {
    throw new Error(`Build completed but WASM file not found at: ${wasmPath}`);
  }

  if (!isWasmFile(wasmPath)) {
    throw new Error(`Built file does not have a valid WASM magic header: ${wasmPath}`);
  }

  const fileSize = fs.statSync(wasmPath).size;
  core.info(`WASM path  : ${wasmPath}`);
  core.info(`WASM size  : ${formatBytes(fileSize)}`);
  core.endGroup();
  return { wasmPath, wasBuilt };
}

async function buildRustContract(dir) {
  // Check toolchain
  if (!toolExists('cargo')) {
    throw new Error('cargo is not installed. Please add a Rust toolchain setup step.');
  }

  // Try cargo-near first, then wasm-pack, then plain cargo build
  if (toolExists('cargo-near')) {
    core.info('Using cargo-near for building…');
    const res = execCommand('cargo near build --no-abi', { cwd: dir });
    if (!res.success) {
      core.warning(`cargo-near failed: ${res.stderr}. Falling back to cargo build…`);
    } else {
      // cargo-near outputs to target/near/<crate>.wasm
      const nearDir = path.join(dir, 'target', 'near');
      if (fs.existsSync(nearDir)) {
        const wasms = findWasmFiles(nearDir);
        if (wasms.length > 0) return wasms[0];
      }
    }
  }

  // Plain cargo build --target wasm32-unknown-unknown
  core.info('Running: cargo build --target wasm32-unknown-unknown --release');
  const res = execCommand(
    'cargo build --target wasm32-unknown-unknown --release',
    { cwd: dir }
  );
  if (!res.success) {
    throw new Error(`Cargo build failed:\n${res.stderr}`);
  }

  // Find the output WASM
  const targetDir = path.join(dir, 'target', 'wasm32-unknown-unknown', 'release');
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Expected target directory not found: ${targetDir}`);
  }
  const wasms = findWasmFiles(targetDir).filter(
    w => !w.endsWith('-metadata.wasm') && !w.endsWith('.d.wasm')
  );
  if (wasms.length === 0) {
    throw new Error(`No WASM file found in ${targetDir} after build.`);
  }
  // Pick the largest (most likely the main contract)
  wasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return wasms[0];
}

async function buildAssemblyScriptContract(dir) {
  const npmBin = path.join(dir, 'node_modules', '.bin');
  const ascPath = path.join(npmBin, 'asc');

  if (!fs.existsSync(ascPath)) {
    core.info('AssemblyScript compiler not found. Running npm install…');
    const install = execCommand('npm install', { cwd: dir });
    if (!install.success) {
      throw new Error(`npm install failed:\n${install.stderr}`);
    }
  }

  const res = execCommand('npm run build', { cwd: dir });
  if (!res.success) {
    throw new Error(`AssemblyScript build failed:\n${res.stderr}`);
  }

  const buildDir = path.join(dir, 'build');
  const wasms = findWasmFiles(fs.existsSync(buildDir) ? buildDir : dir);
  if (wasms.length === 0) {
    throw new Error('No WASM file found after AssemblyScript build.');
  }
  wasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return wasms[0];
}

async function buildJsContract(dir) {
  const res = execCommand('npm run build', { cwd: dir });
  if (!res.success) {
    throw new Error(`npm build failed:\n${res.stderr}`);
  }
  const wasms = findWasmFiles(dir);
  if (wasms.length === 0) {
    throw new Error('No WASM file found after npm build.');
  }
  wasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return wasms[0];
}

// ─── Step 2: Check size against limits ───────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('Step 2: Check Size Against Limits');

  const sizeLimitBytes = sizeLimitKb * 1024;
  const warningBytes = Math.floor(sizeLimitBytes * (warningThresholdPercent / 100));

  const actualBytes = fs.statSync(wasmPath).size;
  const actualKb = actualBytes / 1024;

  core.info(`WASM file              : ${wasmPath}`);
  core.info(`Actual size            : ${formatBytes(actualBytes)} (${actualBytes} bytes)`);
  core.info(`Size limit             : ${formatBytes(sizeLimitBytes)} (${sizeLimitBytes} bytes)`);
  core.info(`Warning threshold (${warningThresholdPercent}%): ${formatBytes(warningBytes)} (${warningBytes} bytes)`);
  core.info(`Usage                  : ${formatPercent(actualBytes, sizeLimitBytes)} of limit`);

  // Set outputs
  core.setOutput('contract_size_bytes', actualBytes.toString());
  core.setOutput('contract_size_kb', actualKb.toFixed(2));
  core.setOutput('size_limit_bytes', sizeLimitBytes.toString());
  core.setOutput('size_limit_kb', sizeLimitKb.toString());
  core.setOutput('usage_percent', formatPercent(actualBytes, sizeLimitBytes));

  const overLimit = actualBytes > sizeLimitBytes;
  const nearLimit = actualBytes >= warningBytes;

  if (overLimit) {
    const excess = actualBytes - sizeLimitBytes;
    core.error(
      `❌ Contract size (${formatBytes(actualBytes)}) EXCEEDS the ${formatBytes(sizeLimitBytes)} limit ` +
      `by ${formatBytes(excess)} (${formatPercent(excess, sizeLimitBytes)} over).`
    );
  } else if (nearLimit) {
    const remaining = sizeLimitBytes - actualBytes;
    core.warning(
      `⚠️  Contract size (${formatBytes(actualBytes)}) is approaching the ${formatBytes(sizeLimitBytes)} limit. ` +
      `Only ${formatBytes(remaining)} (${formatPercent(remaining, sizeLimitBytes)}) headroom remaining.`
    );
  } else {
    const remaining = sizeLimitBytes - actualBytes;
    core.info(
      `✅ Contract size (${formatBytes(actualBytes)}) is within limits. ` +
      `${formatBytes(remaining)} (${formatPercent(remaining, sizeLimitBytes)}) headroom available.`
    );
  }

  core.endGroup();
  return { actualBytes, sizeLimitBytes, warningBytes, overLimit, nearLimit };
}

// ─── Step 3: Compare with previous/baseline build ────────────────────────────

async function stepCompareBaseline(wasmPath, actualBytes, baselineArtifact, failOnIncrease) {
  core.startGroup('Step 3: Compare With Previous Build');

  const result = {
    hasBaseline: false,
    baselineBytes: 0,
    delta: 0,
    deltaPercent: '0%',
    increased: false,
  };

  if (!baselineArtifact) {
    core.info('No baseline_artifact provided; skipping size comparison.');
    core.setOutput('size_delta_bytes', '0');
    core.setOutput('size_delta_kb', '0');
    core.setOutput('baseline_size_bytes', '0');
    core.endGroup();
    return result;
  }

  // Resolve baseline path
  let baselinePath = path.resolve(baselineArtifact);

  if (!fs.existsSync(baselinePath)) {
    core.warning(`Baseline file not found at ${baselinePath}; skipping comparison.`);
    core.endGroup();
    return result;
  }

  if (!isWasmFile(baselinePath)) {
    core.warning(`Baseline file is not a valid WASM file: ${baselinePath}; skipping comparison.`);
    core.endGroup();
    return result;
  }

  const baselineBytes = fs.statSync(baselinePath).size;
  const delta = actualBytes - baselineBytes;
  const deltaPercent = baselineBytes > 0
    ? ((delta / baselineBytes) * 100).toFixed(2) + '%'
    : 'N/A';

  result.hasBaseline = true;
  result.baselineBytes = baselineBytes;
  result.delta = delta;
  result.deltaPercent = deltaPercent;
  result.increased = delta > 0;

  core.info(`Baseline size : ${formatBytes(baselineBytes)} (${baselineBytes} bytes)`);
  core.info(`Current size  : ${formatBytes(actualBytes)} (${actualBytes} bytes)`);
  core.info(`Delta         : ${delta >= 0 ? '+' : ''}${formatBytes(Math.abs(delta))} (${delta >= 0 ? '+' : ''}${deltaPercent})`);

  core.setOutput('size_delta_bytes', delta.toString());
  core.setOutput('size_delta_kb', (delta / 1024).toFixed(2));
  core.setOutput('baseline_size_bytes', baselineBytes.toString());

  if (delta > 0) {
    const msg = `📈 Contract size increased by ${formatBytes(delta)} (${deltaPercent}) compared to baseline.`;
    if (failOnIncrease) {
      core.error(msg);
    } else {
      core.warning(msg);
    }
  } else if (delta < 0) {
    core.info(`📉 Contract size decreased by ${formatBytes(Math.abs(delta))} (${deltaPercent}) — great improvement!`);
  } else {
    core.info('📊 Contract size is unchanged from baseline.');
  }

  core.endGroup();
  return result;
}

// ─── Step 4: WASM analysis & optimization suggestions ────────────────────────

function parseWasmSections(wasmPath) {
  // Parse WASM binary format to extract section sizes
  const buf = fs.readFileSync(wasmPath);
  const sections = {};
  const sectionNames = [
    'custom', 'type', 'import', 'function', 'table', 'memory',
    'global', 'export', 'start', 'element', 'code', 'data',
    'data_count', 'tag',
  ];

  let offset = 8; // skip magic (4 bytes) + version (4 bytes)

  while (offset < buf.length) {
    if (offset >= buf.length) break;
    const sectionId = buf[offset];
    offset += 1;

    // Read LEB128 size
    let size = 0;
    let shift = 0;
    let byte;
    const sizeStart = offset;
    do {
      if (offset >= buf.length) break;
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);

    const name = sectionNames[sectionId] || `unknown_${sectionId}`;
    if (!sections[name]) sections[name] = 0;
    sections[name] += size;

    offset += size;
  }

  return sections;
}

function analyzeWasm(wasmPath) {
  const analysis = {
    sections: {},
    hasDebugInfo: false,
    hasNameSection: false,
    estimatedCodeSize: 0,
    estimatedDataSize: 0,
    totalSize: fs.statSync(wasmPath).size,
  };

  try {
    analysis.sections = parseWasmSections(wasmPath);
    analysis.estimatedCodeSize = analysis.sections['code'] || 0;
    analysis.estimatedDataSize = analysis.sections['data'] || 0;

    // Check for debug/name sections in custom sections (heuristic: large custom section)
    const customSize = analysis.sections['custom'] || 0;
    if (customSize > 1024) {
      analysis.hasDebugInfo = true;
    }

    // Check for name section using wasm-objdump if available
    if (toolExists('wasm-objdump')) {
      const res = execCommand(`wasm-objdump -h "${wasmPath}"`);
      if (res.success) {
        analysis.hasNameSection = res.stdout.includes('name');
        analysis.hasDebugInfo = res.stdout.includes('.debug') || analysis.hasDebugInfo;
      }
    }
  } catch (err) {
    core.debug(`WASM analysis error: ${err.message}`);
  }

  return analysis;
}

async function stepSuggestOptimizations(wasmPath, actualBytes, sizeLimitBytes, enableSuggestions) {
  core.startGroup('Step 4: Optimization Suggestions');

  if (!enableSuggestions) {
    core.info('Optimization suggestions disabled (enable_optimization_suggestions=false).');
    core.endGroup();
    return [];
  }

  const suggestions = [];
  const analysis = analyzeWasm(wasmPath);

  core.info(`Section breakdown:`);
  for (const [name, size] of Object.entries(analysis.sections)) {
    if (size > 0) {
      core.info(`  ${name.padEnd(16)}: ${formatBytes(size)} (${formatPercent(size, analysis.totalSize)})`);
    }
  }

  // ── Suggestion 1: wasm-opt ──────────────────────────────────────────────────
  if (toolExists('wasm-opt')) {
    core.info('wasm-opt is available. Testing optimization potential…');
    const tmpOptimized = path.join(os.tmpdir(), `optimized_${Date.now()}.wasm`);
    const optRes = execCommand(
      `wasm-opt -Os --strip-debug --strip-producers "${wasmPath}" -o "${tmpOptimized}"`
    );
    if (optRes.success && fs.existsSync(tmpOptimized)) {
      const optimizedSize = fs.statSync(tmpOptimized).size;
      const saving = actualBytes - optimizedSize;
      if (saving > 0) {
        suggestions.push({
          priority: 'HIGH',
          title: 'Run wasm-opt for size optimization',
          detail: `wasm-opt -Os --strip-debug can reduce size by approximately ${formatBytes(saving)} ` +
            `(${formatPercent(saving, actualBytes)} reduction). ` +
            `Optimized size would be ~${formatBytes(optimizedSize)}.`,
          command: `wasm-opt -Os --strip-debug --strip-producers "${path.basename(wasmPath)}" -o "${path.basename(wasmPath)}"`,
        });
      } else {
        core.info('wasm-opt would not significantly reduce size (already optimized or marginal gain).');
      }
      try { fs.unlinkSync(tmpOptimized); } catch { /* ignore */ }
    }
  } else {
    suggestions.push({
      priority: 'HIGH',
      title: 'Install wasm-opt (Binaryen) for size optimization',
      detail: 'wasm-opt is the most effective tool for reducing WASM size. Install binaryen and run: ' +
        'wasm-opt -Os --strip-debug contract.wasm -o contract.wasm',
      command: '# Install: npm install -g binaryen  OR  apt-get install binaryen',
    });
  }

  // ── Suggestion 2: Debug info ────────────────────────────────────────────────
  if (analysis.hasDebugInfo) {
    suggestions.push({
      priority: 'HIGH',
      title: 'Strip debug information',
      detail: 'Debug symbols detected in WASM. Strip them to reduce size significantly. ' +
        'For Rust: ensure you build with --release and add [profile.release] opt-level = "z" to Cargo.toml.',
      command: 'wasm-opt --strip-debug input.wasm -o output.wasm',
    });
  }

  // ── Suggestion 3: Cargo profile