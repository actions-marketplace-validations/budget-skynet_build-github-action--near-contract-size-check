async function stepBuildContract(contractDir, packageName, optimizationLevel) {
  core.startGroup('📦 Step 1: Build Contract WASM');

  // Ensure Rust and wasm target are available
  core.info('Verifying Rust toolchain...');
  try {
    const rustVersion = execCommand('rustc --version').stdout.trim();
    core.info(`Rust version: ${rustVersion}`);
  } catch {
    core.info('Rust not found. Installing...');
    execCommand(
      'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable'
    );
    execCommand('source $HOME/.cargo/env && rustup default stable');
  }

  // Add wasm32 target
  core.info('Ensuring wasm32-unknown-unknown target is installed...');
  execCommand('rustup target add wasm32-unknown-unknown');

  // Determine cargo flags
  let cargoCmd;
  if (optimizationLevel === 'lto') {
    core.info('Building with LTO optimizations...');
    // Inject LTO flags via environment
    cargoCmd = `cd "${contractDir}" && RUSTFLAGS="-C link-arg=-s" cargo build --target wasm32-unknown-unknown --release`;
    // Also try to ensure LTO is in Cargo.toml profile, or use env
    cargoCmd = `cd "${contractDir}" && CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_OPT_LEVEL=z CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 RUSTFLAGS="-C link-arg=-s" cargo build --target wasm32-unknown-unknown --release`;
  } else {
    core.info('Building with release optimizations...');
    cargoCmd = `cd "${contractDir}" && RUSTFLAGS="-C link-arg=-s" cargo build --target wasm32-unknown-unknown --release`;
  }

  core.info(`Running: ${cargoCmd}`);
  const buildResult = execCommand(cargoCmd);
  if (buildResult.stderr) {
    core.debug(`Build stderr:\n${buildResult.stderr}`);
  }
  core.info('Build completed successfully.');

  // Locate output WASM
  const wasmDir = path.join(contractDir, 'target', 'wasm32-unknown-unknown', 'release');
  let wasmFiles = findWasmFiles(wasmDir).filter(
    (f) => !f.includes('.d') && f.endsWith('.wasm')
  );

  if (wasmFiles.length === 0) {
    throw new Error(`No WASM files found in ${wasmDir}`);
  }

  // Prefer package-named file if available
  let wasmFile = wasmFiles[0];
  if (packageName) {
    const pkgWasm = wasmFiles.find(
      (f) => path.basename(f) === `${packageName.replace(/-/g, '_')}.wasm`
    );
    if (pkgWasm) wasmFile = pkgWasm;
  }

  core.info(`WASM artifact: ${wasmFile}`);

  // Optional: run wasm-opt if available
  const wasmOptCheck = spawnSync('which', ['wasm-opt'], { encoding: 'utf8' });
  if (wasmOptCheck.status === 0) {
    core.info('wasm-opt found. Running additional optimization...');
    const optimizedPath = wasmFile.replace('.wasm', '_optimized.wasm');
    try {
      execCommand(`wasm-opt -Oz "${wasmFile}" -o "${optimizedPath}"`);
      if (fs.existsSync(optimizedPath)) {
        const origSize = fs.statSync(wasmFile).size;
        const optSize = fs.statSync(optimizedPath).size;
        core.info(
          `wasm-opt: ${formatBytes(origSize)} → ${formatBytes(optSize)} (saved ${formatBytes(origSize - optSize)})`
        );
        wasmFile = optimizedPath;
      }
    } catch (e) {
      core.warning(`wasm-opt failed (non-fatal): ${e.message}`);
    }
  } else {
    core.info('wasm-opt not found; skipping additional optimization.');
  }

  const wasmSize = fs.statSync(wasmFile).size;
  core.info(`Final WASM size: ${formatBytes(wasmSize)}`);
  core.endGroup();

  return { wasmFile, wasmSize, contractDir, packageName };
}

// ─── Step 2: Check Size Against Limits ───────────────────────────────────────

async function stepCheckSizeLimits(wasmSize, sizeLimitBytes, warningThresholdPercent) {
  core.startGroup('📏 Step 2: Check Size Against Limits');

  const percentUsed = (wasmSize / sizeLimitBytes) * 100;
  const warningThreshold = sizeLimitBytes * (warningThresholdPercent / 100);

  core.info(`Contract size : ${formatBytes(wasmSize)}`);
  core.info(`Size limit    : ${formatBytes(sizeLimitBytes)}`);
  core.info(`Warning at    : ${formatBytes(warningThreshold)} (${warningThresholdPercent}%)`);
  core.info(`Usage         : ${formatPercent(wasmSize, sizeLimitBytes)}%`);

  // Set outputs
  core.setOutput('contract_size_bytes', wasmSize.toString());
  core.setOutput('contract_size_human', formatBytes(wasmSize));
  core.setOutput('size_limit_bytes', sizeLimitBytes.toString());
  core.setOutput('percent_of_limit', formatPercent(wasmSize, sizeLimitBytes));

  let status = 'ok';
  if (wasmSize > sizeLimitBytes) {
    status = 'exceeded';
    core.setOutput('size_status', 'exceeded');
    core.error(
      `❌ Contract size ${formatBytes(wasmSize)} EXCEEDS the limit of ${formatBytes(sizeLimitBytes)} ` +
        `(${formatPercent(wasmSize, sizeLimitBytes)}% of limit)`
    );
  } else if (wasmSize >= warningThreshold) {
    status = 'warning';
    core.setOutput('size_status', 'warning');
    core.warning(
      `⚠️  Contract size ${formatBytes(wasmSize)} is approaching the limit ` +
        `(${formatPercent(wasmSize, sizeLimitBytes)}% of ${formatBytes(sizeLimitBytes)})`
    );
  } else {
    core.setOutput('size_status', 'ok');
    core.info(
      `✅ Contract size ${formatBytes(wasmSize)} is within limits ` +
        `(${formatPercent(wasmSize, sizeLimitBytes)}% of ${formatBytes(sizeLimitBytes)})`
    );
  }

  core.endGroup();
  return { status, percentUsed, sizeLimitBytes, warningThreshold };
}

// ─── Step 3: Compare With Previous Build ─────────────────────────────────────

async function stepCompareWithBaseline(wasmFile, wasmSize, baselineArtifact) {
  core.startGroup('🔍 Step 3: Compare With Previous Build');

  let deltaBytes = null;
  let deltaPercent = null;
  let baselineSize = null;
  let comparisonSource = 'none';

  if (!baselineArtifact || baselineArtifact.trim() === '') {
    core.info('No baseline artifact specified. Skipping comparison.');
    core.setOutput('size_delta_bytes', '');
    core.setOutput('size_delta_human', '');
    core.endGroup();
    return { deltaBytes, deltaPercent, baselineSize, comparisonSource };
  }

  core.info(`Baseline reference: ${baselineArtifact}`);

  // Strategy 1: local file path
  if (fs.existsSync(baselineArtifact)) {
    core.info(`Loading baseline from local file: ${baselineArtifact}`);
    if (baselineArtifact.endsWith('.json')) {
      try {
        const json = JSON.parse(fs.readFileSync(baselineArtifact, 'utf8'));
        baselineSize = parseInt(json.size_bytes || json.size || 0, 10);
        comparisonSource = 'local-json';
      } catch (e) {
        core.warning(`Failed to parse baseline JSON: ${e.message}`);
      }
    } else if (baselineArtifact.endsWith('.wasm')) {
      baselineSize = fs.statSync(baselineArtifact).size;
      comparisonSource = 'local-wasm';
    }
  }

  // Strategy 2: GitHub Actions artifact via API
  if (baselineSize === null) {
    const ghToken = process.env.GITHUB_TOKEN;
    const ghRepo = process.env.GITHUB_REPOSITORY;
    if (ghToken && ghRepo) {
      core.info(`Attempting to fetch baseline artifact '${baselineArtifact}' from GitHub API...`);
      try {
        const apiUrl = `https://api.github.com/repos/${ghRepo}/actions/artifacts`;
        const options = {
          hostname: 'api.github.com',
          path: `/repos/${ghRepo}/actions/artifacts?name=${encodeURIComponent(baselineArtifact)}&per_page=5`,
          headers: {
            Authorization: `Bearer ${ghToken}`,
            'User-Agent': 'near-contract-size-check',
            Accept: 'application/vnd.github+json',
          },
        };

        const apiResult = await new Promise((resolve, reject) => {
          https
            .get(options, (res) => {
              let data = '';
              res.on('data', (c) => (data += c));
              res.on('end', () => resolve({ status: res.statusCode, body: data }));
            })
            .on('error', reject);
        });

        if (apiResult.status === 200) {
          const parsed = JSON.parse(apiResult.body);
          if (parsed.artifacts && parsed.artifacts.length > 0) {
            const latest = parsed.artifacts[0];
            baselineSize = latest.size_in_bytes || null;
            comparisonSource = 'github-artifact-api';
            core.info(
              `Found artifact '${latest.name}' from ${latest.created_at}, size: ${formatBytes(baselineSize)}`
            );
          } else {
            core.info(`No artifacts named '${baselineArtifact}' found.`);
          }
        }
      } catch (e) {
        core.warning(`GitHub API lookup failed (non-fatal): ${e.message}`);
      }
    }
  }

  // Strategy 3: git stash + build from commit/branch reference
  if (baselineSize === null) {
    // Check if it looks like a git ref
    const gitRefPattern = /^[a-f0-9]{7,40}$|^(main|master|develop|HEAD[~^]\d*)$/;
    if (gitRefPattern.test(baselineArtifact.trim())) {
      core.info(`Attempting git-based comparison against ref: ${baselineArtifact}`);
      try {
        // Check if ref exists
        const refCheck = spawnSync('git', ['rev-parse', '--verify', baselineArtifact], {
          encoding: 'utf8',
        });
        if (refCheck.status === 0) {
          const currentSha = execCommand('git rev-parse HEAD').stdout.trim();
          core.info(`Stashing current changes to build baseline at ${baselineArtifact}...`);

          const stashResult = spawnSync('git', ['stash', '--include-untracked'], {
            encoding: 'utf8',
          });
          const stashed = stashResult.stdout.includes('Saved');

          try {
            execCommand(`git checkout ${baselineArtifact} -- .`);
            // Find the WASM file path relative to contract directory
            const baseWasmCmd = `cargo build --target wasm32-unknown-unknown --release 2>/dev/null`;
            execCommand(`cd "${path.dirname(wasmFile.replace('_optimized', '').replace('target/wasm32-unknown-unknown/release/', ''))}" && ${baseWasmCmd}`);

            if (fs.existsSync(wasmFile.replace('_optimized', ''))) {
              baselineSize = fs.statSync(wasmFile.replace('_optimized', '')).size;
              comparisonSource = 'git-ref-build';
            }
          } catch (buildErr) {
            core.warning(`Baseline build failed: ${buildErr.message}`);
          } finally {
            execCommand(`git checkout ${currentSha} -- .`);
            if (stashed) execCommand('git stash pop');
          }
        }
      } catch (e) {
        core.warning(`Git comparison failed (non-fatal): ${e.message}`);
      }
    }
  }

  // Compute delta
  if (baselineSize !== null && baselineSize > 0) {
    deltaBytes = wasmSize - baselineSize;
    deltaPercent = ((deltaBytes / baselineSize) * 100).toFixed(2);

    const sign = deltaBytes >= 0 ? '+' : '';
    core.info(`Baseline size  : ${formatBytes(baselineSize)} (source: ${comparisonSource})`);
    core.info(`Current size   : ${formatBytes(wasmSize)}`);
    core.info(`Delta          : ${sign}${formatBytes(Math.abs(deltaBytes))} (${sign}${deltaPercent}%)`);

    if (deltaBytes > 0) {
      core.warning(`⚠️  Contract grew by ${formatBytes(deltaBytes)} (${sign}${deltaPercent}%) since baseline.`);
    } else if (deltaBytes < 0) {
      core.info(`✅ Contract shrunk by ${formatBytes(Math.abs(deltaBytes))} (${deltaPercent}%) since baseline.`);
    } else {
      core.info(`✅ Contract size unchanged from baseline.`);
    }

    core.setOutput('size_delta_bytes', deltaBytes.toString());
    core.setOutput('size_delta_human', `${sign}${formatBytes(Math.abs(deltaBytes))}`);
    core.setOutput('baseline_size_bytes', baselineSize.toString());
  } else {
    core.info('Could not determine baseline size. No comparison available.');
    core.setOutput('size_delta_bytes', '');
    core.setOutput('size_delta_human', '');
    core.setOutput('baseline_size_bytes', '');
  }

  core.endGroup();
  return { deltaBytes, deltaPercent, baselineSize, comparisonSource };
}

// ─── Step 4: Suggest Optimizations ───────────────────────────────────────────

async function stepSuggestOptimizations(
  wasmFile,
  wasmSize,
  sizeLimitBytes,
  percentUsed,
  contractDir,
  optimizationLevel
) {
  core.startGroup('💡 Step 4: Optimization Suggestions');

  const suggestions = [];
  const cargoTomlPath = path.join(contractDir, 'Cargo.toml');
  let cargoContent = '';
  if (fs.existsSync(cargoTomlPath)) {
    cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');
  }

  // Analyze WASM sections if wasm-nm or similar tools available
  let symbolAnalysis = null;
  const wasmNmCheck = spawnSync('which', ['wasm-nm'], { encoding: 'utf8' });
  if (wasmNmCheck.status === 0) {
    try {
      const nmResult = execCommand(`wasm-nm "${wasmFile}" 2>/dev/null | head -50`);
      symbolAnalysis = nmResult.stdout;
    } catch {
      // non-fatal
    }
  }

  // Check for existing release profile optimizations
  const hasLTO = cargoContent.includes('lto = true') || cargoContent.includes('lto = "fat"');
  const hasCodegenUnits = cargoContent.includes('codegen-units = 1');
  const hasPanicAbort = cargoContent.includes('panic = "abort"');
  const hasOptZ = cargoContent.includes('opt-level = "z"') || cargoContent.includes("opt-level = 'z'");
  const hasOptS = cargoContent.includes('opt-level = "s"') || cargoContent.includes("opt-level = 's'");

  // Check for strip/link-arg
  const hasStripDebug =
    cargoContent.includes('strip = true') || cargoContent.includes('strip = "debuginfo"');

  core.info('Analyzing Cargo.toml for optimization opportunities...');

  if (!hasLTO && optimizationLevel !== 'lto') {
    suggestions.push({
      priority: 'high',
      title: 'Enable Link-Time Optimization (LTO)',
      description:
        'LTO can significantly reduce WASM size by eliminating dead code across crate boundaries.',
      fix: `Add to Cargo.toml:\n[profile.release]\nlto = true`,
      estimatedSaving: '10-30%',
    });
  }

  if (!hasCodegenUnits) {
    suggestions.push({
      priority: 'high',
      title: 'Set codegen-units = 1',
      description:
        'Using a single codegen unit enables better cross-function optimizations.',
      fix: `Add to Cargo.toml:\n[profile.release]\ncodegen-units = 1`,
      estimatedSaving: '5-15%',
    });
  }

  if (!hasPanicAbort) {
    suggestions.push({
      priority: 'high',
      title: 'Use panic = "abort"',
      description:
        'Abort on panic removes panic formatting machinery, which is large in WASM.',
      fix: `Add to Cargo.toml:\n[profile.release]\npanic = "abort"`,
      estimatedSaving: '5-20%',
    });
  }

  if (!hasOptZ && !hasOptS) {
    suggestions.push({
      priority: 'medium',
      title: 'Use size-optimized opt-level',
      description: '"z" optimizes for size (smallest), "s" balances size and speed.',
      fix: `Add to Cargo.toml:\n[profile.release]\nopt-level = "z"`,
      estimatedSaving: '5-15%',
    });
  }

  if (!hasStripDebug) {
    suggestions.push({
      priority: 'medium',
      title: 'Strip debug symbols',