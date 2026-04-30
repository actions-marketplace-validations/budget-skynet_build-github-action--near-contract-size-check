async function buildContractWasm(contractPath) {
  core.startGroup('Step 1 — Build Contract WASM');

  const resolvedPath = path.resolve(contractPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Contract path does not exist: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);

  // If user pointed directly at a WASM file, skip building
  if (stat.isFile() && resolvedPath.endsWith('.wasm')) {
    core.info(`Contract path is already a WASM file: ${resolvedPath}`);
    core.endGroup();
    return { wasmPath: resolvedPath, builtFromSource: false };
  }

  if (!stat.isDirectory()) {
    throw new Error(`Contract path must be a directory or a .wasm file: ${resolvedPath}`);
  }

  const projectType = detectProjectType(resolvedPath);
  core.info(`Detected project type: ${projectType}`);

  let wasmPath = null;

  if (projectType === 'rust') {
    wasmPath = await buildRustContract(resolvedPath);
  } else if (projectType === 'js') {
    wasmPath = await buildJsContract(resolvedPath);
  } else if (projectType === 'assemblyscript') {
    wasmPath = await buildAssemblyScriptContract(resolvedPath);
  } else {
    // Try to find an existing WASM in common output directories
    core.warning('Unknown project type — scanning for existing WASM files…');
    const found = findWasmFiles(resolvedPath);
    if (found.length === 0) {
      throw new Error(
        'Could not detect project type and no WASM files found. ' +
          'Please build manually and point contract_path at the .wasm file.'
      );
    }
    // Pick the largest one (most likely the release build)
    found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    wasmPath = found[0];
    core.info(`Using existing WASM: ${wasmPath}`);
  }

  core.endGroup();
  return { wasmPath, builtFromSource: true };
}

async function buildRustContract(dir) {
  core.info('Building Rust / NEAR contract…');

  if (!isRustInstalled()) {
    throw new Error('Rust toolchain not found. Please add a rust installation step.');
  }

  // Ensure wasm32 target is present
  execCommandSafe('rustup target add wasm32-unknown-unknown', dir);

  // Read Cargo.toml to get the package name
  const cargoToml = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
  const nameMatch = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  const packageName = nameMatch ? nameMatch[1] : null;

  let wasmPath = null;

  if (isCargoNearInstalled()) {
    core.info('Using cargo-near for optimised build…');
    try {
      execCommand('cargo near build --release', dir);
    } catch (_) {
      core.warning('cargo-near build failed, falling back to cargo build…');
    }
  }

  // Standard cargo build as primary / fallback
  if (!wasmPath) {
    execCommand('cargo build --target wasm32-unknown-unknown --release', dir);
  }

  // Locate the built WASM
  const releaseDir = path.join(dir, 'target', 'wasm32-unknown-unknown', 'release');
  let candidates = [];

  if (fs.existsSync(releaseDir)) {
    candidates = fs
      .readdirSync(releaseDir)
      .filter((f) => f.endsWith('.wasm'))
      .map((f) => path.join(releaseDir, f));
  }

  // Also check res/ or out/ directories (cargo-near output)
  for (const extra of ['res', 'out', 'target/near']) {
    const d = path.join(dir, extra);
    if (fs.existsSync(d)) {
      const extra_candidates = findWasmFiles(d);
      candidates.push(...extra_candidates);
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No WASM files found after build in ${dir}`);
  }

  // Prefer the package-name match, else take the largest
  if (packageName) {
    const named = candidates.find((c) =>
      path.basename(c).replace(/-/g, '_').startsWith(packageName.replace(/-/g, '_'))
    );
    if (named) {
      wasmPath = named;
      core.info(`Selected WASM by package name: ${wasmPath}`);
    }
  }

  if (!wasmPath) {
    candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    wasmPath = candidates[0];
    core.info(`Selected WASM (largest): ${wasmPath}`);
  }

  // Try wasm-opt if available
  const woPath = execCommandSafe('which wasm-opt') || execCommandSafe('where wasm-opt');
  if (woPath) {
    core.info('wasm-opt detected — running size optimisation (Oz)…');
    const optimised = wasmPath.replace('.wasm', '.opt.wasm');
    const optResult = spawnSync(
      `wasm-opt -Oz --strip-debug --strip-producers -o "${optimised}" "${wasmPath}"`,
      { shell: true, encoding: 'utf8' }
    );
    if (optResult.status === 0 && fs.existsSync(optimised)) {
      const orig = fs.statSync(wasmPath).size;
      const opt = fs.statSync(optimised).size;
      core.info(
        `wasm-opt reduced size: ${humanSize(orig)} → ${humanSize(opt)} (saved ${humanSize(orig - opt)})`
      );
      wasmPath = optimised;
    }
  }

  return wasmPath;
}

async function buildJsContract(dir) {
  core.info('Building JavaScript / TypeScript NEAR contract…');

  const hasYarn = execCommandSafe('yarn --version') !== null;
  const hasPnpm = execCommandSafe('pnpm --version') !== null;
  const pm = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm';

  // Install deps
  execCommand(`${pm} install`, dir);

  // Try common build scripts
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};

  const buildScript =
    scripts['build:release'] ||
    scripts['build'] ||
    scripts['compile'] ||
    null;

  if (buildScript) {
    execCommand(`${pm} run ${Object.keys(scripts).find((k) => scripts[k] === buildScript)}`, dir);
  } else if (fs.existsSync(path.join(dir, 'node_modules', '.bin', 'near-sdk-js'))) {
    execCommand('npx near-sdk-js build', dir);
  } else {
    throw new Error(
      'No build script found in package.json. ' +
        'Please add a "build" script that produces a .wasm file.'
    );
  }

  const found = findWasmFiles(dir);
  if (found.length === 0) {
    throw new Error('No WASM files found after JS build.');
  }
  found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return found[0];
}

async function buildAssemblyScriptContract(dir) {
  core.info('Building AssemblyScript NEAR contract…');

  const hasYarn = execCommandSafe('yarn --version') !== null;
  const pm = hasYarn ? 'yarn' : 'npm';

  execCommand(`${pm} install`, dir);
  execCommand(`${pm} run build`, dir);

  const found = findWasmFiles(dir);
  if (found.length === 0) {
    throw new Error('No WASM files found after AssemblyScript build.');
  }
  found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return found[0];
}

// ─── Step 2: Check Size Against Limits ──────────────────────────────────────

async function checkSizeAgainstLimits(wasmPath, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('Step 2 — Check Size Against Limits');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found: ${wasmPath}`);
  }

  const wasmStats = fs.statSync(wasmPath);
  const actualBytes = wasmStats.size;
  const actualKb = actualBytes / 1024;

  const limitBytes = sizeLimitKb * 1024;
  const warningBytes = limitBytes * (warningThresholdPercent / 100);

  const percentUsed = (actualBytes / limitBytes) * 100;
  const remainingBytes = limitBytes - actualBytes;
  const remainingKb = remainingBytes / 1024;

  core.info(`WASM file     : ${wasmPath}`);
  core.info(`Actual size   : ${humanSize(actualBytes)} (${actualKb.toFixed(2)} KB)`);
  core.info(`Size limit    : ${humanSize(limitBytes)} (${sizeLimitKb} KB)`);
  core.info(`Warning at    : ${humanSize(warningBytes)} (${warningThresholdPercent}% of limit)`);
  core.info(`Used          : ${percentUsed.toFixed(1)}%`);
  core.info(`Remaining     : ${humanSize(Math.max(0, remainingBytes))}`);

  const isOverLimit = actualBytes > limitBytes;
  const isWarning = !isOverLimit && actualBytes >= warningBytes;

  if (isOverLimit) {
    core.error(
      `❌ Contract size ${humanSize(actualBytes)} EXCEEDS limit of ${humanSize(limitBytes)} ` +
        `by ${humanSize(actualBytes - limitBytes)}`
    );
  } else if (isWarning) {
    core.warning(
      `⚠️  Contract size ${humanSize(actualBytes)} is ${percentUsed.toFixed(1)}% of the ` +
        `${humanSize(limitBytes)} limit — approaching the threshold`
    );
  } else {
    core.info(`✅ Contract size ${humanSize(actualBytes)} is within limits (${percentUsed.toFixed(1)}% used)`);
  }

  // Set outputs
  core.setOutput('contract_size_bytes', String(actualBytes));
  core.setOutput('contract_size_kb', actualKb.toFixed(2));
  core.setOutput('size_limit_kb', String(sizeLimitKb));
  core.setOutput('percent_used', percentUsed.toFixed(1));
  core.setOutput('is_over_limit', String(isOverLimit));
  core.setOutput('is_warning', String(isWarning));
  core.setOutput('remaining_kb', remainingKb.toFixed(2));

  core.endGroup();

  return {
    actualBytes,
    actualKb,
    limitBytes,
    sizeLimitKb,
    warningBytes,
    percentUsed,
    remainingBytes,
    remainingKb,
    isOverLimit,
    isWarning,
    wasmPath,
  };
}

// ─── Step 3: Compare With Previous Builds ────────────────────────────────────

async function compareWithPreviousBuilds(sizeInfo, baselineArtifact) {
  core.startGroup('Step 3 — Compare With Previous Builds');

  let comparison = {
    hasBaseline: false,
    baselineBytes: null,
    deltaBytes: null,
    deltaKb: null,
    deltaPercent: null,
    trend: 'unknown',
  };

  if (!baselineArtifact) {
    core.info('No baseline artifact specified — skipping size comparison.');
    core.endGroup();
    return comparison;
  }

  core.info(`Baseline reference: ${baselineArtifact}`);

  let baselineBytes = null;

  // Strategy 1: try to interpret as a local file path
  if (fs.existsSync(baselineArtifact) && baselineArtifact.endsWith('.wasm')) {
    baselineBytes = fs.statSync(baselineArtifact).size;
    core.info(`Loaded baseline from local file: ${baselineArtifact}`);
  }

  // Strategy 2: try reading a size-record JSON file dropped by a previous run
  if (baselineBytes === null && fs.existsSync(baselineArtifact)) {
    try {
      const record = JSON.parse(fs.readFileSync(baselineArtifact, 'utf8'));
      if (record && record.contract_size_bytes) {
        baselineBytes = Number(record.contract_size_bytes);
        core.info(`Loaded baseline size from JSON record: ${humanSize(baselineBytes)}`);
      }
    } catch (_) {
      core.warning(`Could not parse baseline file as JSON: ${baselineArtifact}`);
    }
  }

  // Strategy 3: GitHub API — look up artifact by run ID or name
  if (baselineBytes === null) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY; // owner/repo

    if (token && repo) {
      core.info('Attempting to fetch baseline size from GitHub Actions artifacts…');
      try {
        const apiBase = `https://api.github.com/repos/${repo}`;
        const headers = `Authorization: Bearer ${token}\nUser-Agent: near-contract-size-check\nAccept: application/vnd.github.v3+json`;

        // Fetch recent workflow runs to find a previous size record
        const runsUrl = `${apiBase}/actions/runs?per_page=10&status=completed`;
        const runsData = await fetchGitHubApi(runsUrl, token);
        const runs = JSON.parse(runsData).workflow_runs || [];

        const currentRunId = process.env.GITHUB_RUN_ID;

        for (const run of runs) {
          if (String(run.id) === String(currentRunId)) continue;

          const artsUrl = `${apiBase}/actions/runs/${run.id}/artifacts`;
          const artsData = await fetchGitHubApi(artsUrl, token);
          const arts = JSON.parse(artsData).artifacts || [];

          const sizeArt = arts.find(
            (a) =>
              a.name === 'near-contract-size-record' ||
              a.name === baselineArtifact ||
              a.name.includes('contract-size')
          );

          if (sizeArt) {
            core.info(
              `Found size artifact "${sizeArt.name}" from run #${run.run_number} (${run.head_sha.slice(0, 7)})`
            );
            // We cannot easily download ZIP artifacts without extra deps,
            // so we surface what we can from the metadata
            core.info('(Cannot auto-download artifact ZIP without @actions/artifact — record metadata only)');
            break;
          }
        }
      } catch (err) {
        core.warning(`GitHub API lookup failed: ${err.message}`);
      }
    } else {
      core.info('GITHUB_TOKEN not available — cannot fetch remote baseline.');
    }
  }

  // Strategy 4: git-based comparison using git notes or a tracked size file
  if (baselineBytes === null) {
    const sizeFile = path.join(process.env.GITHUB_WORKSPACE || '.', '.contract-sizes.json');
    if (fs.existsSync(sizeFile)) {
      try {
        const record = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
        const sha = baselineArtifact.match(/^[0-9a-f]{7,40}$/i) ? baselineArtifact : null;
        if (sha && record[sha]) {
          baselineBytes = record[sha];
          core.info(`Loaded baseline from .contract-sizes.json for ${sha}: ${humanSize(baselineBytes)}`);
        } else if (record.latest) {
          baselineBytes = record.latest;
          core.info(`Loaded latest baseline from .contract-sizes.json: ${humanSize(baselineBytes)}`);
        }
      } catch (_) {}
    }
  }

  if (baselineBytes !== null) {
    const deltaBytes = sizeInfo.actualBytes - baselineBytes;
    const deltaKb = deltaBytes / 1024;
    const deltaPercent = (deltaBytes / baselineBytes) * 100;

    comparison = {
      hasBaseline: true,
      baselineBytes,
      deltaBytes,
      deltaKb,
      deltaPercent,
      trend: deltaBytes > 0 ? 'growing' : deltaBytes < 0 ? 'shrinking' : 'stable',
    };

    const sign = deltaBytes >= 0 ? '+' : '';
    const emoji =
      deltaBytes > 0 ? '📈' : deltaBytes < 0 ? '📉' : '➡️';

    core.info(`${emoji} Size delta  : ${sign}${humanSize(Math.abs(deltaBytes))} (${sign}${deltaPercent.toFixed(1)}%)`);
    core.info(`   Baseline   : ${humanSize(baselineBytes)}`);
    core.info(`   Current    : ${humanSize(sizeInfo.actualBytes)}`);

    if (deltaBytes > 50 * 1024) {
      core.warning(
        `⚠️  Contract grew by more than 50 KB compared to baseline (${sign}${humanSize(Math.abs(deltaBytes))})`
      );
    }

    core.setOutput('baseline_size_bytes', String(baselineBytes));
    core.setOutput('size_delta_bytes', String(deltaBytes));
    core.setOutput('size_delta_percent', deltaPercent.toFixed(1));
  } else {
    core.info('Could not resolve a baseline size — no comparison available.');
  }

  // Save a size record for future runs
  try {
    const workspace = process.env.GITHUB_WORKSPACE || '.';
    const sizeRecordPath = path.join(workspace, 'near-contract-size-record.json');
    const record = {
      contract_size_bytes: sizeInfo.actualBytes,
      contract_size_kb: sizeInfo.actualKb.toFixed(2),
      wasm_path: sizeInfo.wasmPath,
      timestamp: new Date().toISOString(),
      commit_sha: process.env.GITHUB_SHA || 'unknown',
      run_id: process.env.GITHUB_RUN_ID || 'unknown',
    };
    fs.writeFileSync(sizeRecordPath, JSON.stringify(record, null, 2));
    core.info(`Size record saved to ${sizeRecordPath} (upload as artifact to enable future comparisons)`);
    core.setOutput('size_record_path', sizeRecordPath);
  } catch (err) {
    core.warning(`Could not save size record: ${err.message}`);
  }

  core.endGroup();