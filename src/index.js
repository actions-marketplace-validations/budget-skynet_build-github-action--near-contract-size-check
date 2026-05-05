async function stepBuildContract(contractPath) {
  core.startGroup('Step 1: Build Contract WASM');

  const resolved = path.resolve(contractPath);
  core.info(`Contract path: ${resolved}`);

  // If it's already a .wasm file, skip building
  if (resolved.endsWith('.wasm')) {
    if (!fs.existsSync(resolved)) {
      throw new Error(`WASM file not found: ${resolved}`);
    }
    core.info(`Direct WASM file provided, skipping build.`);
    core.endGroup();
    return { wasmPath: resolved, builtFromSource: false };
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Contract directory not found: ${resolved}`);
  }

  // Detect project type
  const hasCargoToml = fs.existsSync(path.join(resolved, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(resolved, 'package.json'));

  let wasmPath = null;

  if (hasCargoToml) {
    core.info('Detected Rust/NEAR contract. Building with cargo...');

    // Ensure wasm32 target is available
    const targetCheck = exec('rustup target list --installed');
    if (!targetCheck.stdout.includes('wasm32-unknown-unknown')) {
      core.info('Adding wasm32-unknown-unknown target...');
      const addTarget = exec('rustup target add wasm32-unknown-unknown');
      if (addTarget.code !== 0) {
        throw new Error('Failed to add wasm32-unknown-unknown target');
      }
    }

    // Try cargo-near first, then fall back to standard cargo build
    const cargoNearCheck = exec('cargo near --version');
    if (cargoNearCheck.code === 0) {
      core.info('Building with cargo-near...');
      const buildResult = exec('cargo near build', { cwd: resolved });
      if (buildResult.code !== 0) {
        core.warning(`cargo-near build failed, falling back to cargo build`);
      }
    }

    // Standard cargo build with WASM target
    core.info('Building with cargo build --release --target wasm32-unknown-unknown...');
    const cargoResult = exec(
      'cargo build --release --target wasm32-unknown-unknown',
      { cwd: resolved }
    );
    if (cargoResult.code !== 0) {
      throw new Error(`Cargo build failed.\nOutput: ${cargoResult.stdout}\nError: ${cargoResult.stderr}`);
    }

    // Find the produced WASM
    const targetDir = path.join(resolved, 'target', 'wasm32-unknown-unknown', 'release');
    const wasmFiles = findWasmFiles(targetDir);

    // Filter out test/deps wasm
    const contractWasms = wasmFiles.filter(
      (f) => !f.includes('/deps/') && !f.endsWith('-test.wasm')
    );

    if (contractWasms.length === 0) {
      // Also check res/ directory (common NEAR pattern)
      const resDir = path.join(resolved, 'res');
      const resWasms = fs.existsSync(resDir) ? findWasmFiles(resDir) : [];
      if (resWasms.length > 0) {
        wasmPath = resWasms[0];
      } else {
        throw new Error(`No WASM file found after build in ${targetDir}`);
      }
    } else {
      // Pick the largest one (most likely the main contract)
      contractWasms.sort((a, b) => fileSize(b) - fileSize(a));
      wasmPath = contractWasms[0];
    }
  } else if (hasPackageJson) {
    core.info('Detected JavaScript/TypeScript NEAR contract. Building with npm...');

    const installResult = exec('npm install', { cwd: resolved });
    if (installResult.code !== 0) {
      throw new Error(`npm install failed: ${installResult.stderr}`);
    }

    // Try common build scripts
    const pkg = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};

    let buildCmd = null;
    for (const s of ['build', 'compile', 'build:release']) {
      if (scripts[s]) { buildCmd = s; break; }
    }

    if (buildCmd) {
      const buildResult = exec(`npm run ${buildCmd}`, { cwd: resolved });
      if (buildResult.code !== 0) {
        throw new Error(`npm run ${buildCmd} failed: ${buildResult.stderr}`);
      }
    } else {
      // Try near-sdk-js or assemblyscript
      const asCheck = exec('npx asc --version');
      if (asCheck.code === 0) {
        const asResult = exec('npx asc assembly/index.ts --target release -o build/contract.wasm', { cwd: resolved });
        if (asResult.code !== 0) {
          throw new Error(`AssemblyScript build failed: ${asResult.stderr}`);
        }
      }
    }

    // Find produced WASM
    const wasmFiles = findWasmFiles(resolved);
    const filtered = wasmFiles.filter((f) => !f.includes('node_modules'));
    if (filtered.length === 0) {
      throw new Error(`No WASM file found after JS build in ${resolved}`);
    }
    filtered.sort((a, b) => fileSize(b) - fileSize(a));
    wasmPath = filtered[0];
  } else {
    // Try to find existing WASM
    const wasmFiles = findWasmFiles(resolved);
    if (wasmFiles.length > 0) {
      wasmFiles.sort((a, b) => fileSize(b) - fileSize(a));
      wasmPath = wasmFiles[0];
      core.info(`Found pre-built WASM: ${wasmPath}`);
    } else {
      throw new Error(
        `Cannot determine project type in ${resolved}. ` +
        `No Cargo.toml, package.json, or .wasm files found.`
      );
    }
  }

  core.info(`✅ WASM artifact: ${wasmPath} (${formatBytes(fileSize(wasmPath))})`);
  core.endGroup();
  return { wasmPath, builtFromSource: true };
}

// ─── Step 2: Check Size Against Limits ──────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitKB, warningThresholdPercent) {
  core.startGroup('Step 2: Check Contract Size Against Limits');

  const sizeBytes = fileSize(wasmPath);
  const sizeKB = bytesToKB(sizeBytes);
  const limitBytes = sizeLimitKB * 1024;
  const warningBytes = limitBytes * (warningThresholdPercent / 100);
  const usagePercent = (sizeBytes / limitBytes) * 100;

  core.info(`Contract WASM: ${wasmPath}`);
  core.info(`Size:          ${formatBytes(sizeBytes)} (${sizeKB.toFixed(2)} KB)`);
  core.info(`Limit:         ${formatBytes(limitBytes)} (${sizeLimitKB} KB)`);
  core.info(`Warning at:    ${formatBytes(warningBytes)} (${warningThresholdPercent}% of limit)`);
  core.info(`Usage:         ${usagePercent.toFixed(1)}% ${bar(usagePercent)}`);

  const isOverLimit = sizeBytes > limitBytes;
  const isNearLimit = sizeBytes > warningBytes;

  // Set outputs
  core.setOutput('contract_size_bytes', sizeBytes.toString());
  core.setOutput('contract_size_kb', sizeKB.toFixed(2));
  core.setOutput('size_limit_kb', sizeLimitKB.toString());
  core.setOutput('usage_percent', usagePercent.toFixed(1));
  core.setOutput('is_over_limit', isOverLimit.toString());
  core.setOutput('is_near_limit', isNearLimit.toString());

  if (isOverLimit) {
    const excess = sizeBytes - limitBytes;
    core.error(
      `❌ Contract size ${formatBytes(sizeBytes)} EXCEEDS limit of ${formatBytes(limitBytes)} ` +
      `(over by ${formatBytes(excess)})`
    );
  } else if (isNearLimit) {
    const remaining = limitBytes - sizeBytes;
    core.warning(
      `⚠️  Contract size ${formatBytes(sizeBytes)} is approaching limit ` +
      `(${usagePercent.toFixed(1)}% used, ${formatBytes(remaining)} remaining)`
    );
  } else {
    const remaining = limitBytes - sizeBytes;
    core.info(`✅ Contract size is within limits (${formatBytes(remaining)} remaining)`);
  }

  core.endGroup();
  return { sizeBytes, sizeKB, usagePercent, isOverLimit, isNearLimit, limitBytes, warningBytes };
}

// ─── Step 3: Compare With Previous Builds ───────────────────────────────────

async function stepCompareWithMain(wasmPath, sizeBytes, compareWithMain) {
  core.startGroup('Step 3: Compare With Previous Builds');

  if (!compareWithMain) {
    core.info('Comparison with main branch disabled, skipping.');
    core.endGroup();
    return { delta: null, deltaKB: null, previousSizeBytes: null };
  }

  let previousSizeBytes = null;
  let delta = null;
  let deltaKB = null;

  try {
    // Check if we're in a git repo
    const gitCheck = exec('git rev-parse --is-inside-work-tree');
    if (gitCheck.code !== 0) {
      core.info('Not in a git repository, skipping comparison.');
      core.endGroup();
      return { delta: null, deltaKB: null, previousSizeBytes: null };
    }

    // Get current branch
    const branchResult = exec('git rev-parse --abbrev-ref HEAD');
    const currentBranch = branchResult.stdout.trim();
    core.info(`Current branch: ${currentBranch}`);

    if (currentBranch === 'main' || currentBranch === 'master') {
      core.info('Already on main/master branch. Comparing with previous commit...');

      // Compare with previous commit on main
      const prevCommit = exec('git rev-parse HEAD~1');
      if (prevCommit.code !== 0) {
        core.info('No previous commit found.');
        core.endGroup();
        return { delta: null, deltaKB: null, previousSizeBytes: null };
      }

      const stashResult = exec('git stash');
      const checkoutResult = exec(`git checkout HEAD~1 -- ${wasmPath} 2>/dev/null || true`);

      if (fs.existsSync(wasmPath)) {
        previousSizeBytes = fileSize(wasmPath);
      }

      // Restore
      exec(`git checkout HEAD -- ${wasmPath} 2>/dev/null || true`);
      if (stashResult.stdout.includes('Saved')) {
        exec('git stash pop');
      }
    } else {
      // Try to fetch and compare with main/master
      const fetchMain = exec('git fetch origin main:refs/remotes/origin/main 2>/dev/null || git fetch origin master:refs/remotes/origin/master 2>/dev/null || true');
      core.info('Fetched remote branches.');

      // Try to get the WASM from main branch using git show
      const relativeWasm = path.relative(process.cwd(), wasmPath);

      // Check if file exists on main
      const mainFileCheck = exec(`git show origin/main:${relativeWasm} > /tmp/main_contract.wasm 2>/dev/null || git show origin/master:${relativeWasm} > /tmp/main_contract.wasm 2>/dev/null`);

      if (mainFileCheck.code === 0 && fs.existsSync('/tmp/main_contract.wasm')) {
        previousSizeBytes = fileSize('/tmp/main_contract.wasm');
        core.info(`Found WASM on main branch: ${formatBytes(previousSizeBytes)}`);
      } else {
        // Try GitHub API to get artifact size from last successful run
        core.info('WASM not found in git history. Trying GitHub Actions artifacts...');

        const token = process.env.GITHUB_TOKEN;
        const repo = process.env.GITHUB_REPOSITORY;

        if (token && repo) {
          try {
            const apiUrl = `https://api.github.com/repos/${repo}/actions/runs?branch=main&status=success&per_page=1`;
            const response = await httpGet(apiUrl);

            if (response.status === 200) {
              const runs = JSON.parse(response.body);
              if (runs.workflow_runs && runs.workflow_runs.length > 0) {
                core.info(`Found previous successful run: ${runs.workflow_runs[0].id}`);
                // Store in output for reference
                core.setOutput('previous_run_id', runs.workflow_runs[0].id.toString());
              }
            }
          } catch (apiErr) {
            core.info(`GitHub API call failed: ${apiErr.message}`);
          }
        }

        // Check for cached size file
        const cachePath = '/tmp/near_contract_size_cache.json';
        if (fs.existsSync(cachePath)) {
          try {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cache.main_size_bytes) {
              previousSizeBytes = cache.main_size_bytes;
              core.info(`Using cached main branch size: ${formatBytes(previousSizeBytes)}`);
            }
          } catch (e) {
            core.info('Cache file unreadable.');
          }
        }
      }
    }

    if (previousSizeBytes !== null) {
      delta = sizeBytes - previousSizeBytes;
      deltaKB = bytesToKB(delta);
      const sign = delta >= 0 ? '+' : '';

      core.info(`Previous size: ${formatBytes(previousSizeBytes)}`);
      core.info(`Current size:  ${formatBytes(sizeBytes)}`);
      core.info(`Delta:         ${sign}${formatBytes(Math.abs(delta))} (${sign}${deltaKB.toFixed(2)} KB)`);

      if (delta > 0) {
        core.warning(`⚠️  Contract grew by ${formatBytes(delta)} compared to main branch`);
      } else if (delta < 0) {
        core.info(`✅ Contract shrank by ${formatBytes(Math.abs(delta))} compared to main branch`);
      } else {
        core.info(`✅ Contract size unchanged from main branch`);
      }

      core.setOutput('size_delta_bytes', delta.toString());
      core.setOutput('size_delta_kb', deltaKB.toFixed(2));
      core.setOutput('previous_size_bytes', previousSizeBytes.toString());
    } else {
      core.info('No previous build found for comparison. This may be the first build.');
      core.setOutput('size_delta_bytes', '0');
      core.setOutput('size_delta_kb', '0');
      core.setOutput('previous_size_bytes', '0');
    }
  } catch (err) {
    core.warning(`Comparison step encountered an error: ${err.message}`);
  }

  core.endGroup();
  return { delta, deltaKB, previousSizeBytes };
}

// ─── Step 4: Suggest Optimizations ──────────────────────────────────────────

async function stepSuggestOptimizations(wasmPath, sizeBytes, isOverLimit, isNearLimit, includeOptimizations) {
  core.startGroup('Step 4: Optimization Suggestions');

  if (!includeOptimizations) {
    core.info('Optimization suggestions disabled, skipping.');
    core.endGroup();
    return { suggestions: [] };
  }

  const suggestions = [];
  const sizeKB = bytesToKB(sizeBytes);

  core.info(`Analyzing WASM file for optimization opportunities...`);

  // Check if wasm-opt is available
  const wasmOptCheck = exec('wasm-opt --version');
  const hasWasmOpt = wasmOptCheck.code === 0;

  // Check if wasm-snip is available
  const wasmSnipCheck = exec('wasm-snip --version 2>/dev/null');
  const hasWasmSnip = wasmSnipCheck.code === 0;

  // Try to run wasm-opt to see potential savings
  let optimizedSize = null;
  if (hasWasmOpt) {
    core.info('Running wasm-opt analysis (dry run)...');
    const optOutput = '/tmp/contract_optimized.wasm';
    const optResult = exec(`wasm-opt -Oz --strip-debug --strip-producers ${wasmPath} -o ${optOutput}`);

    if (optResult.code === 0 && fs.existsSync(optOutput)) {
      optimizedSize = fileSize(optOutput);
      const savings = sizeBytes - optimizedSize;
      const savingsPercent = (savings / sizeBytes) * 100;

      if (savings > 0) {
        suggestions.push({
          priority: 'HIGH',
          title: 'Run wasm-opt',
          description: `wasm-opt -Oz can reduce size by ~${formatBytes(savings)} (${savingsPercent.toFixed(1)}%)`,
          command: `wasm-opt -Oz --strip-debug --strip-producers ${path.basename(wasmPath)} -o ${path.basename(wasmPath)}`,
          savings_bytes: savings,
        });
      }
      // Clean up
      fs.unlinkSync(optOutput);
    }
  } else {
    suggestions.push({
      priority: 'HIGH',
      title: 'Install and run wasm-opt',
      description: 'wasm-opt from binaryen toolkit can significantly reduce WASM size (often 20-40%)',
      command: 'apt-get install -y binaryen && wasm-opt -Oz --strip-debug contract.wasm -o contract.wasm',
      savings_bytes: null,
    });
  }

  // Check Cargo.toml for optimization settings
  const contractDir = path.dirname(wasmPath);
  let cargoTomlPath = path.join(contractDir, 'Cargo.toml');

  // Walk up to find Cargo.toml
  let searchDir = contractDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(searchDir, 'Cargo.toml');
    if (fs.existsSync(candidate)) {
      cargoTomlPath = candidate;
      break;
    }
    searchDir = path.dirname(searchDir);
  }

  if (fs.existsSync(cargoTomlPath)) {
    const cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');

    if (!cargoContent.includes('opt-level')) {
      suggestions.push({
        priority: 'HIGH',
        title: 'Add release profile optimizations to Cargo.toml',
        description: 'Configure Cargo release profile for size optimization',
        command: null,
        code: `[profile.release]
codegen-units = 1
opt-level = "z"
lto = true
debug = false
panic = "abort"
strip = "symbols"`,
        savings_bytes: null,
      });
    } else {
      // Check if opt-level is set to "z" or "s"
      if (!cargoContent.includes('opt-level = "z"') && !cargoContent.includes("opt-level = 's'") && !cargoContent.includes('opt-level = "s"')) {
        suggestions.push({
          priority: 'MEDIUM',
          title: 'Use opt-level = "z" for minimum size',
          description: 'opt-level = "z" optimizes specifically for size (smaller than "s")',
          command: null,
          code: `[profile.release]\nopt-level = "z"`,
          savings_bytes: null,
        });
      }

      if (!cargoContent.includes('