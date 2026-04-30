async function stepResolvePath(contractPath) {
  core.startGroup('Step 1: Resolve contract path');

  const resolved = path.resolve(contractPath);
  core.info(`Resolved contract path: ${resolved}`);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Contract path does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  let wasmPath = null;
  let sourcePath = null;

  if (stat.isFile() && resolved.endsWith('.wasm')) {
    core.info('Contract path is a pre-built WASM file — skipping build step.');
    wasmPath = resolved;
  } else if (stat.isDirectory()) {
    core.info('Contract path is a directory — will build WASM from source.');
    sourcePath = resolved;

    // Check if there is a Cargo.toml (Rust) or package.json (AssemblyScript)
    const hasCargoToml = fs.existsSync(path.join(resolved, 'Cargo.toml'));
    const hasPkgJson = fs.existsSync(path.join(resolved, 'package.json'));

    if (!hasCargoToml && !hasPkgJson) {
      throw new Error(
        'Contract directory contains neither Cargo.toml nor package.json. ' +
          'Cannot determine build system.'
      );
    }
    core.info(
      hasCargoToml ? 'Detected Rust/Cargo contract.' : 'Detected AssemblyScript/npm contract.'
    );
  } else {
    throw new Error(`Contract path is not a directory or .wasm file: ${resolved}`);
  }

  core.endGroup();
  return { wasmPath, sourcePath };
}

// ─── Step 2: Build the WASM contract ─────────────────────────────────────────
async function stepBuildContract(sourcePath) {
  if (!sourcePath) {
    core.startGroup('Step 2: Build contract');
    core.info('Pre-built WASM provided — skipping build.');
    core.endGroup();
    return null; // wasmPath already known from step 1
  }

  core.startGroup('Step 2: Build contract');

  const hasCargoToml = fs.existsSync(path.join(sourcePath, 'Cargo.toml'));

  if (hasCargoToml) {
    // ── Rust / cargo-near build ─────────────────────────────────────────────
    core.info('Building Rust NEAR contract with cargo...');

    // Ensure target wasm32-unknown-unknown is installed
    if (commandExists('rustup')) {
      core.info('Ensuring wasm32-unknown-unknown target is installed...');
      runCommand('rustup target add wasm32-unknown-unknown', sourcePath);
    } else {
      core.warning('rustup not found — assuming wasm32-unknown-unknown is already installed.');
    }

    // Prefer cargo-near if available, fall back to plain cargo build
    if (commandExists('cargo-near')) {
      core.info('cargo-near detected — using `cargo near build`.');
      runCommand('cargo near build --release', sourcePath);
    } else {
      core.info('cargo-near not found — using plain `cargo build --target wasm32-unknown-unknown --release`.');
      runCommand('cargo build --target wasm32-unknown-unknown --release', sourcePath, {
        RUSTFLAGS: '-C link-arg=-s',
      });
    }

    // Locate the built WASM file
    // cargo-near places output in ./target/near/<name>.wasm
    // plain cargo places output in ./target/wasm32-unknown-unknown/release/<name>.wasm
    const cargoNearOut = path.join(sourcePath, 'target', 'near');
    const cargoReleaseOut = path.join(sourcePath, 'target', 'wasm32-unknown-unknown', 'release');

    let builtWasm = null;

    for (const dir of [cargoNearOut, cargoReleaseOut]) {
      if (fs.existsSync(dir)) {
        const wasmFiles = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.wasm') && !f.includes('deps'));
        if (wasmFiles.length > 0) {
          builtWasm = path.join(dir, wasmFiles[0]);
          break;
        }
      }
    }

    if (!builtWasm) {
      // Deep search under target/
      const targetDir = path.join(sourcePath, 'target');
      builtWasm = findWasmRecursive(targetDir);
    }

    if (!builtWasm) {
      throw new Error('Build succeeded but could not locate output .wasm file.');
    }

    core.info(`Built WASM: ${builtWasm}`);
    core.endGroup();
    return builtWasm;
  } else {
    // ── AssemblyScript / npm build ──────────────────────────────────────────
    core.info('Building AssemblyScript NEAR contract...');

    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(sourcePath, 'package.json'), 'utf8')
    );
    const buildScript =
      pkgJson.scripts && (pkgJson.scripts.build || pkgJson.scripts['build:release'])
        ? pkgJson.scripts.build
          ? 'build'
          : 'build:release'
        : null;

    if (!buildScript) {
      throw new Error(
        'No build or build:release script found in package.json. ' +
          'Please add a build script that produces a .wasm file.'
      );
    }

    const pkgMgr = fs.existsSync(path.join(sourcePath, 'yarn.lock')) ? 'yarn' : 'npm';
    core.info(`Using ${pkgMgr} to install dependencies...`);
    runCommand(`${pkgMgr} install`, sourcePath);

    core.info(`Running ${pkgMgr} run ${buildScript}...`);
    runCommand(`${pkgMgr} run ${buildScript}`, sourcePath);

    // Look for WASM in common AssemblyScript output locations
    const asBuildDirs = ['build', 'out', 'dist'];
    let builtWasm = null;

    for (const dir of asBuildDirs) {
      const fullDir = path.join(sourcePath, dir);
      if (fs.existsSync(fullDir)) {
        const wasmFiles = fs.readdirSync(fullDir).filter((f) => f.endsWith('.wasm'));
        if (wasmFiles.length > 0) {
          builtWasm = path.join(fullDir, wasmFiles[0]);
          break;
        }
      }
    }

    if (!builtWasm) {
      builtWasm = findWasmRecursive(sourcePath);
    }

    if (!builtWasm) {
      throw new Error('AssemblyScript build succeeded but could not locate output .wasm file.');
    }

    core.info(`Built WASM: ${builtWasm}`);
    core.endGroup();
    return builtWasm;
  }
}

// ─── Helper: find first .wasm file recursively ───────────────────────────────
function findWasmRecursive(dir, depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    // Skip hidden dirs, node_modules, .git
    if (entry.startsWith('.') || entry === 'node_modules' || entry === '.git') continue;
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && entry.endsWith('.wasm')) return fullPath;
    if (stat.isDirectory()) {
      const found = findWasmRecursive(fullPath, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ─── Step 3: Measure WASM size ────────────────────────────────────────────────
async function stepMeasureSize(wasmPath) {
  core.startGroup('Step 3: Measure WASM size');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at: ${wasmPath}`);
  }

  const stat = fs.statSync(wasmPath);
  const sizeBytes = stat.size;
  const sizeKb = sizeBytes / BYTES_PER_KB;

  core.info(`WASM file  : ${wasmPath}`);
  core.info(`Size (raw) : ${formatBytes(sizeBytes)}`);

  // Try wasm-opt to see if the binary is valid
  let isValidWasm = true;
  try {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(wasmPath, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    // WASM magic bytes: 0x00 0x61 0x73 0x6D
    if (
      head[0] !== 0x00 ||
      head[1] !== 0x61 ||
      head[2] !== 0x73 ||
      head[3] !== 0x6d
    ) {
      isValidWasm = false;
      core.warning('File does not start with WASM magic bytes — may not be a valid WASM module.');
    }
  } catch (e) {
    core.warning(`Could not verify WASM magic bytes: ${e.message}`);
  }

  // Extract section sizes using wasm-objdump if available
  let sectionInfo = {};
  if (commandExists('wasm-objdump')) {
    try {
      const dumpOutput = runCommand(`wasm-objdump -h "${wasmPath}"`, path.dirname(wasmPath));
      sectionInfo = parseWasmSections(dumpOutput);
      core.info('WASM sections:');
      for (const [name, size] of Object.entries(sectionInfo)) {
        core.info(`  ${name.padEnd(20)} ${formatBytes(size)}`);
      }
    } catch (e) {
      core.debug(`wasm-objdump failed: ${e.message}`);
    }
  }

  core.setOutput('wasm_size_bytes', String(sizeBytes));
  core.setOutput('wasm_size_kb', sizeKb.toFixed(2));
  core.setOutput('wasm_path', wasmPath);

  core.endGroup();
  return { sizeBytes, sizeKb, wasmPath, sectionInfo, isValidWasm };
}

// ─── Helper: parse wasm-objdump section output ────────────────────────────────
function parseWasmSections(output) {
  const sections = {};
  const lines = output.split('\n');
  for (const line of lines) {
    // Example line: "     Type start=0x0000000a end=0x00000021 (size=0x00000017) count: 4"
    const match = line.match(/^\s+(\S+)\s+start=.*size=(0x[0-9a-fA-F]+)/);
    if (match) {
      sections[match[1]] = parseInt(match[2], 16);
    }
  }
  return sections;
}

// ─── Step 4: Compare with baseline ───────────────────────────────────────────
async function stepCompareBaseline(currentSizeKb, baselineArtifact) {
  core.startGroup('Step 4: Compare with baseline');

  if (!baselineArtifact) {
    core.info('No baseline artifact specified — skipping comparison.');
    core.endGroup();
    return { hasPrevious: false, previousSizeKb: null, deltaKb: null, deltaPercent: null };
  }

  let previousSizeKb = null;

  // 1. Try to read as a local file path
  if (fs.existsSync(baselineArtifact)) {
    const stat = fs.statSync(baselineArtifact);
    if (stat.isFile()) {
      if (baselineArtifact.endsWith('.wasm')) {
        previousSizeKb = stat.size / BYTES_PER_KB;
        core.info(`Baseline WASM found at: ${baselineArtifact}`);
      } else {
        // Assume it's a JSON file with { "size_kb": number }
        try {
          const data = JSON.parse(fs.readFileSync(baselineArtifact, 'utf8'));
          if (data.size_kb) {
            previousSizeKb = parseFloat(data.size_kb);
            core.info(`Baseline size loaded from JSON: ${previousSizeKb.toFixed(2)} KB`);
          }
        } catch (e) {
          core.warning(`Could not parse baseline file as JSON: ${e.message}`);
        }
      }
    } else if (stat.isDirectory()) {
      // Look for .wasm or size.json inside
      const wasmFile = findWasmRecursive(baselineArtifact);
      if (wasmFile) {
        previousSizeKb = fs.statSync(wasmFile).size / BYTES_PER_KB;
        core.info(`Baseline WASM found in directory: ${wasmFile}`);
      }
      const jsonFile = path.join(baselineArtifact, 'size.json');
      if (!wasmFile && fs.existsSync(jsonFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
          previousSizeKb = parseFloat(data.size_kb);
        } catch (e) {
          core.warning(`Could not parse size.json: ${e.message}`);
        }
      }
    }
  }

  // 2. Try to download from GitHub Actions artifacts API
  if (previousSizeKb === null) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (token && repo) {
      core.info(`Attempting to fetch artifact "${baselineArtifact}" from GitHub Actions API...`);
      try {
        previousSizeKb = await fetchArtifactSizeKb(token, repo, baselineArtifact);
        if (previousSizeKb !== null) {
          core.info(`Baseline size from GitHub artifact: ${previousSizeKb.toFixed(2)} KB`);
        }
      } catch (e) {
        core.warning(`Could not fetch artifact from GitHub: ${e.message}`);
      }
    } else {
      core.warning('GITHUB_TOKEN or GITHUB_REPOSITORY not set — cannot fetch artifact from API.');
    }
  }

  if (previousSizeKb === null) {
    core.warning(`Could not resolve baseline artifact: ${baselineArtifact}`);
    core.endGroup();
    return { hasPrevious: false, previousSizeKb: null, deltaKb: null, deltaPercent: null };
  }

  const deltaKb = currentSizeKb - previousSizeKb;
  const deltaPercent = (deltaKb / previousSizeKb) * 100;

  const trend = deltaKb > 0 ? '📈 increased' : deltaKb < 0 ? '📉 decreased' : '➡️ unchanged';

  core.info(`Previous size  : ${previousSizeKb.toFixed(2)} KB`);
  core.info(`Current size   : ${currentSizeKb.toFixed(2)} KB`);
  core.info(`Delta          : ${deltaKb >= 0 ? '+' : ''}${deltaKb.toFixed(2)} KB (${deltaPercent >= 0 ? '+' : ''}${deltaPercent.toFixed(1)}%) — ${trend}`);

  core.setOutput('size_delta_kb', deltaKb.toFixed(2));
  core.setOutput('size_delta_percent', deltaPercent.toFixed(1));
  core.setOutput('previous_size_kb', previousSizeKb.toFixed(2));

  core.endGroup();
  return { hasPrevious: true, previousSizeKb, deltaKb, deltaPercent };
}

// ─── Helper: fetch artifact size from GitHub Actions API ─────────────────────
async function fetchArtifactSizeKb(token, repo, artifactName) {
  // List artifacts for the current run or recent runs
  const runId = process.env.GITHUB_RUN_ID;
  const baseUrl = `api.github.com`;
  const headers = `Authorization: token ${token}\r\nUser-Agent: near-contract-size-check\r\nAccept: application/vnd.github.v3+json`;

  // Use Node https module directly
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repo}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=10`,
      method: 'GET',
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'near-contract-size-check',
        Accept: 'application/vnd.github.v3+json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.artifacts || json.artifacts.length === 0) {
            resolve(null);
            return;
          }
          // Find the most recent artifact that is NOT from the current run
          const artifact = json.artifacts.find(
            (a) => String(a.workflow_run && a.workflow_run.id) !== String(runId)
          ) || json.artifacts[0];

          if (artifact && artifact.size_in_bytes) {
            // artifact.size_in_bytes is the zip size, not WASM size — use as proxy
            resolve(artifact.size_in_bytes / BYTES_PER_KB);
          } else {
            resolve(null);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ─── Step 5: Check size against limits ───────────────────────────────────────
async function stepCheckLimits(sizeKb, limitKb, warningThresholdPercent) {
  core.startGroup('Step 5: Check size against limits');

  const warningKb = limitKb * (warningThresholdPercent / 100);
  const usagePercent = (sizeKb / limitKb) * 100;
  const remainingKb = limitKb - sizeKb;

  core.info(`Size limit     : ${limitKb.toFixed(2)} KB (${formatBytes(limitKb * BYTES_PER_KB)})`);
  core.info(`Warning at     : ${warningKb.toFixed(2)} KB (${warningThresholdPercent}% of limit)`);
  core.info(`Current size   : ${sizeKb.toFixed(2)} KB`);
  core.info(`Usage          : ${usagePercent.toFixed(1)}%`);
  core.info(`Remaining      : ${remainingKb.toFixed(2)} KB`);

  let status = 'ok'; // 'ok' | 'warning' | 'exceeded'

  if (sizeKb > limitKb) {
    status = 'exceeded';
    const overBy = sizeKb - limitKb;
    core.error(
      `❌ Contract size EXCEEDS limit!\n` +
        `   Current: ${sizeKb.toFixed(2)} KB\n` +
        `   Limit:   ${limitKb.toFixed(2)} KB\n` +
        `   Over by: ${overBy.toFixed(2)} KB`
    );
  } else if (sizeKb >= warningKb) {
    status = 'warning';
    core.warning(
      `⚠️  Contract size is approaching the limit (${usagePercent.toFixed(1)}% used).\n` +
        `   Current:   ${sizeKb.toFixed(2)} KB\n` +
        `   Limit:     ${limitKb.toFixed(2)} KB\n` +
        `   Remaining: ${remainingKb.toFixed(2)} KB`
    );
  } else {
    core.info(
      `✅ Contract size is within limits (${usagePercent.toFixed(1)}% used, ` +
        `${remainingKb.toFixed(2)} KB remaining).`
    );
  }

  core.setOutput('size_status', status);
  core.set