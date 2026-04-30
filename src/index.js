async function stepBuildContract(contractPath) {
  core.startGroup('🔨 Step 1: Build Contract WASM');

  const project = detectProjectType(contractPath);
  core.info(`Detected project type: ${project.type}`);
  core.info(`Project directory: ${project.projectDir}`);

  let wasmPath = null;

  if (project.type === 'prebuilt_wasm') {
    core.info(`Using pre-built WASM: ${project.wasmPath}`);
    wasmPath = project.wasmPath;
    core.endGroup();
    return { wasmPath, projectDir: project.projectDir, projectType: project.type };
  }

  if (project.type === 'rust') {
    // Verify toolchain
    core.info('Checking Rust toolchain...');
    const rustupCheck = execCommand('rustup show');
    if (rustupCheck.status !== 0) {
      throw new Error('Rust/rustup not found. Please ensure the Rust toolchain is installed.');
    }

    // Add wasm32 target if needed
    core.info('Ensuring wasm32-unknown-unknown target is installed...');
    execCommandOrThrow('rustup target add wasm32-unknown-unknown');

    // Check for cargo-near or use plain cargo build
    const cargoNearCheck = execCommand('cargo near --version');
    if (cargoNearCheck.status === 0) {
      core.info('Building with cargo-near...');
      execCommandOrThrow('cargo near build', { cwd: project.projectDir });
    } else {
      core.info('cargo-near not found, building with cargo build --release...');
      execCommandOrThrow(
        'cargo build --target wasm32-unknown-unknown --release',
        { cwd: project.projectDir }
      );
    }

    // Locate the output wasm
    const targetDir = path.join(project.projectDir, 'target');
    const wasmFiles = findFilesWithExtension(targetDir, '.wasm').filter(
      (f) => f.includes('release') && !f.includes('deps') && !f.includes('incremental')
    );

    if (wasmFiles.length === 0) {
      throw new Error(
        `No WASM files found under ${targetDir} after build. ` +
          'Check that your Cargo.toml has [lib] crate-type = ["cdylib"].'
      );
    }

    // Pick the largest (most likely the actual contract)
    wasmPath = wasmFiles.sort(
      (a, b) => fs.statSync(b).size - fs.statSync(a).size
    )[0];
    core.info(`Built WASM: ${wasmPath}`);
  } else if (project.type === 'assemblyscript') {
    core.info('Building AssemblyScript NEAR contract...');
    const pkgPath = path.join(project.projectDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // Install deps
    execCommandOrThrow('npm ci --prefer-offline 2>/dev/null || npm install', {
      cwd: project.projectDir,
    });

    // Try common build scripts
    const buildScript = pkg.scripts?.build || pkg.scripts?.compile;
    if (buildScript) {
      execCommandOrThrow('npm run build', { cwd: project.projectDir });
    } else {
      execCommandOrThrow(
        'npx asc assembly/index.ts --target release --outFile build/contract.wasm',
        { cwd: project.projectDir }
      );
    }

    const buildDir = path.join(project.projectDir, 'build');
    const wasmFiles = findFilesWithExtension(buildDir, '.wasm');
    if (wasmFiles.length === 0) {
      const rootWasm = findFilesWithExtension(project.projectDir, '.wasm');
      if (rootWasm.length === 0) {
        throw new Error('No WASM files found after AssemblyScript build.');
      }
      wasmPath = rootWasm[0];
    } else {
      wasmPath = wasmFiles[0];
    }
    core.info(`Built WASM: ${wasmPath}`);
  } else if (project.type === 'near_sdk_js') {
    core.info('Building near-sdk-js contract...');
    execCommandOrThrow('npm ci --prefer-offline 2>/dev/null || npm install', {
      cwd: project.projectDir,
    });
    execCommandOrThrow('npm run build', { cwd: project.projectDir });

    const wasmFiles = findFilesWithExtension(project.projectDir, '.wasm');
    if (wasmFiles.length === 0) {
      throw new Error('No WASM files found after near-sdk-js build.');
    }
    wasmPath = wasmFiles[0];
    core.info(`Built WASM: ${wasmPath}`);
  } else {
    // Unknown — try a generic approach
    core.warning(
      `Unknown project type for: ${contractPath}. Attempting generic wasm search.`
    );
    const wasmFiles = findFilesWithExtension(project.projectDir, '.wasm');
    if (wasmFiles.length > 0) {
      wasmPath = wasmFiles.sort(
        (a, b) => fs.statSync(b).size - fs.statSync(a).size
      )[0];
      core.info(`Found existing WASM: ${wasmPath}`);
    } else {
      throw new Error(
        `Cannot determine how to build the contract at '${contractPath}'. ` +
          'Please provide a direct path to a .wasm file or a recognised project structure.'
      );
    }
  }

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at expected path: ${wasmPath}`);
  }

  core.endGroup();
  return { wasmPath, projectDir: project.projectDir, projectType: project.type };
}

// ─── Step 2: Check size against limits ───────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('📏 Step 2: Check Size Against Limits');

  const sizeLimitBytes = sizeLimitKb * 1024;
  const warningThresholdBytes = sizeLimitBytes * (warningThresholdPercent / 100);

  const stats = fs.statSync(wasmPath);
  const sizeBytes = stats.size;
  const sizeKb = sizeBytes / 1024;
  const percentOfLimit = (sizeBytes / sizeLimitBytes) * 100;

  core.info(`Contract: ${path.basename(wasmPath)}`);
  core.info(`Size: ${formatBytes(sizeBytes)} (${sizeKb.toFixed(2)} KB)`);
  core.info(`Limit: ${formatBytes(sizeLimitBytes)} (${sizeLimitKb} KB)`);
  core.info(`Usage: ${percentOfLimit.toFixed(2)}% of limit`);

  // Set outputs
  core.setOutput('contract_size_bytes', sizeBytes.toString());
  core.setOutput('contract_size_kb', sizeKb.toFixed(2));
  core.setOutput('size_limit_kb', sizeLimitKb.toString());
  core.setOutput('percent_of_limit', percentOfLimit.toFixed(2));

  let statusLevel = 'ok'; // ok | warning | exceeded

  if (sizeBytes > sizeLimitBytes) {
    statusLevel = 'exceeded';
    const overBy = sizeBytes - sizeLimitBytes;
    core.error(
      `❌ Contract size ${formatBytes(sizeBytes)} EXCEEDS limit of ${formatBytes(sizeLimitBytes)} ` +
        `(over by ${formatBytes(overBy)}, ${formatPercent(overBy, sizeLimitBytes)}%)`
    );
  } else if (sizeBytes >= warningThresholdBytes) {
    statusLevel = 'warning';
    const remaining = sizeLimitBytes - sizeBytes;
    core.warning(
      `⚠️  Contract size ${formatBytes(sizeBytes)} is ${percentOfLimit.toFixed(2)}% of limit. ` +
        `Only ${formatBytes(remaining)} remaining before limit (${sizeLimitKb} KB).`
    );
  } else {
    core.info(
      `✅ Contract size ${formatBytes(sizeBytes)} is within safe range ` +
        `(${percentOfLimit.toFixed(2)}% of limit).`
    );
  }

  core.setOutput('size_status', statusLevel);

  core.endGroup();
  return {
    sizeBytes,
    sizeKb,
    sizeLimitBytes,
    sizeLimitKb,
    warningThresholdBytes,
    percentOfLimit,
    statusLevel,
  };
}

// ─── Step 3: Compare with previous build ─────────────────────────────────────

async function stepCompareBaseline(wasmPath, sizeBytes, baselineArtifact) {
  core.startGroup('📊 Step 3: Compare With Previous Build');

  let comparison = {
    hasBaseline: false,
    baselineBytes: 0,
    delta: 0,
    deltaPercent: 0,
    deltaFormatted: 'N/A',
  };

  if (!baselineArtifact) {
    core.info('No baseline artifact specified — skipping size comparison.');
    core.endGroup();
    return comparison;
  }

  let baselineWasmPath = null;

  // Resolve the baseline: could be a local file path or a GitHub artifact path
  const resolvedBaseline = path.resolve(baselineArtifact);
  if (fs.existsSync(resolvedBaseline)) {
    if (resolvedBaseline.endsWith('.wasm')) {
      baselineWasmPath = resolvedBaseline;
    } else if (fs.statSync(resolvedBaseline).isDirectory()) {
      const wasmFiles = findFilesWithExtension(resolvedBaseline, '.wasm');
      if (wasmFiles.length > 0) {
        baselineWasmPath = wasmFiles.sort(
          (a, b) => fs.statSync(b).size - fs.statSync(a).size
        )[0];
      }
    }
  }

  // Try environment-provided artifact download path (actions/download-artifact)
  if (!baselineWasmPath) {
    const candidatePaths = [
      path.join(process.env.GITHUB_WORKSPACE || '.', baselineArtifact),
      path.join(process.env.RUNNER_TEMP || os.tmpdir(), baselineArtifact),
      baselineArtifact,
    ];
    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate)) {
        if (candidate.endsWith('.wasm')) {
          baselineWasmPath = candidate;
          break;
        } else if (fs.statSync(candidate).isDirectory()) {
          const wasmFiles = findFilesWithExtension(candidate, '.wasm');
          if (wasmFiles.length > 0) {
            baselineWasmPath = wasmFiles.sort(
              (a, b) => fs.statSync(b).size - fs.statSync(a).size
            )[0];
            break;
          }
        }
      }
    }
  }

  if (!baselineWasmPath) {
    core.warning(
      `Baseline artifact '${baselineArtifact}' not found locally. ` +
        'Ensure you have run actions/download-artifact before this step.'
    );
    core.endGroup();
    return comparison;
  }

  const baselineStats = fs.statSync(baselineWasmPath);
  const baselineBytes = baselineStats.size;
  const delta = sizeBytes - baselineBytes;
  const deltaPercent = baselineBytes > 0 ? (delta / baselineBytes) * 100 : 0;

  comparison = {
    hasBaseline: true,
    baselineBytes,
    baselineKb: baselineBytes / 1024,
    delta,
    deltaKb: delta / 1024,
    deltaPercent,
    deltaFormatted: formatBytes(Math.abs(delta)),
    baselinePath: baselineWasmPath,
  };

  core.info(`Current size:  ${formatBytes(sizeBytes)}`);
  core.info(`Baseline size: ${formatBytes(baselineBytes)}`);

  if (delta === 0) {
    core.info('✅ Contract size is unchanged from baseline.');
  } else if (delta > 0) {
    core.warning(
      `📈 Contract grew by ${formatBytes(delta)} (+${deltaPercent.toFixed(2)}%) compared to baseline.`
    );
  } else {
    core.info(
      `📉 Contract shrank by ${formatBytes(Math.abs(delta))} (${deltaPercent.toFixed(2)}%) compared to baseline.`
    );
  }

  // GitHub Step Summary table entry
  core.setOutput('size_delta_bytes', delta.toString());
  core.setOutput('size_delta_kb', (delta / 1024).toFixed(2));
  core.setOutput('size_delta_percent', deltaPercent.toFixed(2));

  core.endGroup();
  return comparison;
}

// ─── Step 4: Suggest optimizations ───────────────────────────────────────────

async function stepSuggestOptimizations(
  wasmPath,
  sizeBytes,
  sizeLimitBytes,
  projectDir,
  projectType,
  optimizationSuggestionsEnabled
) {
  core.startGroup('💡 Step 4: Optimization Suggestions');

  if (!optimizationSuggestionsEnabled) {
    core.info('Optimization suggestions are disabled.');
    core.endGroup();
    return { suggestions: [] };
  }

  const suggestions = [];
  const percentOfLimit = (sizeBytes / sizeLimitBytes) * 100;

  // ── Check if wasm-opt is available and apply it ──────────────────────────
  let optimizedSize = null;
  const wasmOptCheck = execCommand('wasm-opt --version');
  if (wasmOptCheck.status === 0) {
    core.info('wasm-opt found — running size optimization analysis...');
    const tmpOptimized = path.join(
      os.tmpdir(),
      `optimized_${Date.now()}_${path.basename(wasmPath)}`
    );
    try {
      execCommandOrThrow(
        `wasm-opt -Oz --enable-mutable-globals --strip-debug --strip-producers "${wasmPath}" -o "${tmpOptimized}"`
      );
      const optimizedStats = fs.statSync(tmpOptimized);
      optimizedSize = optimizedStats.size;
      const saving = sizeBytes - optimizedSize;
      if (saving > 0) {
        suggestions.push({
          level: saving > 50 * 1024 ? 'high' : 'medium',
          title: 'Run wasm-opt on your WASM binary',
          detail:
            `wasm-opt -Oz can reduce your binary by ~${formatBytes(saving)} ` +
            `(${formatPercent(saving, sizeBytes)}%). ` +
            `Expected size after optimisation: ${formatBytes(optimizedSize)}.`,
          command: `wasm-opt -Oz --enable-mutable-globals --strip-debug --strip-producers contract.wasm -o contract.wasm`,
        });
      }
    } catch (e) {
      core.debug(`wasm-opt analysis failed: ${e.message}`);
    } finally {
      if (fs.existsSync(tmpOptimized)) fs.unlinkSync(tmpOptimized);
    }
  } else {
    suggestions.push({
      level: 'medium',
      title: 'Install wasm-opt for binary size reduction',
      detail:
        'wasm-opt (from binaryen) can significantly reduce WASM binary size. ' +
        'Add it to your CI with: sudo apt-get install binaryen',
      command: 'sudo apt-get install binaryen',
    });
  }

  // ── Rust-specific suggestions ─────────────────────────────────────────────
  if (projectType === 'rust') {
    const cargoTomlPath = path.join(projectDir, 'Cargo.toml');
    if (fs.existsSync(cargoTomlPath)) {
      const cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');

      if (!cargoContent.includes('opt-level')) {
        suggestions.push({
          level: 'high',
          title: 'Add release profile optimizations to Cargo.toml',
          detail:
            'Setting opt-level = "z" and lto = true in [profile.release] produces smaller binaries.',
          command: `# Add to Cargo.toml:\n[profile.release]\nopt-level = "z"\nlto = true\ncodegen-units = 1\npanic = "abort"\nstrip = "symbols"`,
        });
      }

      if (!cargoContent.includes('panic = "abort"')) {
        suggestions.push({
          level: 'medium',
          title: 'Add panic = "abort" to Cargo.toml profile',
          detail:
            'Using panic = "abort" eliminates panic unwinding infrastructure, reducing binary size.',
          command: `# Add to [profile.release] in Cargo.toml:\npanic = "abort"`,
        });
      }

      if (!cargoContent.includes('strip')) {
        suggestions.push({
          level: 'medium',
          title: 'Strip debug symbols',
          detail: 'Add strip = "symbols" to your release profile to remove debug symbols.',
          command: `# Add to [profile.release] in Cargo.toml:\nstrip = "symbols"`,
        });
      }
    }

    // Check for near-sdk version
    const lockfilePath = path.join(projectDir, 'Cargo.lock');
    if (fs.existsSync(lockfilePath)) {
      const lockContent = fs.readFileSync(lockfilePath, 'utf8');
      const sdkMatch = lockContent.match(/name = "near-sdk"\nversion = "([^"]+)"/);
      if (sdkMatch) {
        core.info(`Detected near-sdk version: ${sdkMatch[1]}`);