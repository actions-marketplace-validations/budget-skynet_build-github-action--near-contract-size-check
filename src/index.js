async function stepBuildContract(inputs) {
  core.startGroup('Step 1 — Build / locate contract WASM');

  const { contractPath } = inputs;
  const resolvedPath = path.resolve(contractPath);

  if (!fileExists(resolvedPath)) {
    throw new Error(`contract_path does not exist: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);

  // Case A: caller pointed directly at a .wasm file
  if (stat.isFile()) {
    if (!resolvedPath.endsWith('.wasm')) {
      throw new Error(`contract_path points to a file but it is not a .wasm: ${resolvedPath}`);
    }
    core.info(`Using pre-built WASM: ${resolvedPath}`);
    core.endGroup();
    return resolvedPath;
  }

  // Case B: caller pointed at a directory — try to build
  if (!stat.isDirectory()) {
    throw new Error(`contract_path is neither a file nor a directory: ${resolvedPath}`);
  }

  core.info(`Building NEAR contract in: ${resolvedPath}`);

  // Determine build tool
  const hasCargoToml = fileExists(path.join(resolvedPath, 'Cargo.toml'));
  const hasPackageJson = fileExists(path.join(resolvedPath, 'package.json'));

  let wasmPath = null;

  if (hasCargoToml) {
    core.info('Detected Rust/Cargo project.');

    // Ensure wasm32 target is available
    try {
      execCommand('rustup target add wasm32-unknown-unknown', resolvedPath, 'rustup');
    } catch (e) {
      core.warning(`rustup target add failed (may already be installed): ${e.message}`);
    }

    // Try cargo-near first, then fall back to plain cargo build
    const cargoNearAvailable = spawnSync('cargo near --version', { shell: true }).status === 0;

    if (cargoNearAvailable) {
      core.info('Using cargo-near to build optimised WASM.');
      execCommand('cargo near build --release', resolvedPath, 'cargo-near');
    } else {
      core.info('cargo-near not found — using cargo build --target wasm32-unknown-unknown.');
      execCommand(
        'cargo build --target wasm32-unknown-unknown --release',
        resolvedPath,
        'cargo-build',
      );
    }

    // Locate the produced wasm file
    const candidates = findWasmFiles(path.join(resolvedPath, 'target'));
    // Prefer release builds and the closest match to the project name
    const releaseWasms = candidates.filter(
      (f) => f.includes('/release/') && !f.includes('/deps/'),
    );
    if (releaseWasms.length === 0) {
      throw new Error(
        `Build succeeded but no .wasm found under ${path.join(resolvedPath, 'target')}. ` +
          `All WASM found: ${candidates.join(', ') || 'none'}`,
      );
    }

    // Pick largest (most likely the main contract, not a dep stub)
    releaseWasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    wasmPath = releaseWasms[0];
    core.info(`Found release WASM: ${wasmPath}`);
  } else if (hasPackageJson) {
    core.info('Detected Node.js project (AssemblyScript / near-sdk-js).');

    // Install dependencies
    execCommand('npm ci --prefer-offline || npm install', resolvedPath, 'npm-install');

    // Try standard build scripts
    const pkg = JSON.parse(fs.readFileSync(path.join(resolvedPath, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};

    if (scripts.build) {
      execCommand('npm run build', resolvedPath, 'npm-build');
    } else if (scripts['build:release']) {
      execCommand('npm run build:release', resolvedPath, 'npm-build-release');
    } else {
      throw new Error(
        'No "build" or "build:release" script found in package.json. ' +
          'Cannot build the contract automatically.',
      );
    }

    // Locate wasm
    const candidates = findWasmFiles(resolvedPath);
    if (candidates.length === 0) {
      throw new Error(
        `Build succeeded but no .wasm file found under ${resolvedPath}.`,
      );
    }
    // Prefer build/ or out/ directories
    const preferred = candidates.filter(
      (f) => f.includes('/build/') || f.includes('/out/') || f.includes('/res/'),
    );
    const sorted = (preferred.length > 0 ? preferred : candidates).sort(
      (a, b) => fs.statSync(b).size - fs.statSync(a).size,
    );
    wasmPath = sorted[0];
    core.info(`Found WASM: ${wasmPath}`);
  } else {
    // Last resort: scan for any existing wasm
    core.warning(
      'No Cargo.toml or package.json found — scanning for pre-built WASM files.',
    );
    const candidates = findWasmFiles(resolvedPath);
    if (candidates.length === 0) {
      throw new Error(
        `No recognisable build system found and no .wasm files present in ${resolvedPath}.`,
      );
    }
    candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    wasmPath = candidates[0];
    core.info(`Using largest existing WASM: ${wasmPath}`);
  }

  core.endGroup();
  return wasmPath;
}

// ─── Step 2 – Check size against limits ──────────────────────────────────────

function stepCheckSize(wasmPath, inputs) {
  core.startGroup('Step 2 — Check WASM size against limits');

  const { sizeLimitBytes, warningThresholdPercent } = inputs;
  const stats = fs.statSync(wasmPath);
  const contractSizeBytes = stats.size;

  const warningThresholdBytes = Math.round((warningThresholdPercent / 100) * sizeLimitBytes);
  const percentOfLimit = (contractSizeBytes / sizeLimitBytes) * 100;

  core.info(`WASM file        : ${wasmPath}`);
  core.info(`Contract size    : ${formatBytes(contractSizeBytes)} (${contractSizeBytes} bytes)`);
  core.info(`Size limit       : ${formatBytes(sizeLimitBytes)} (${sizeLimitBytes} bytes)`);
  core.info(`Warning threshold: ${warningThresholdPercent}% → ${formatBytes(warningThresholdBytes)}`);
  core.info(`Usage            : ${formatPercent(contractSizeBytes, sizeLimitBytes)}% of limit`);

  const isOverLimit = contractSizeBytes > sizeLimitBytes;
  const isNearLimit = contractSizeBytes >= warningThresholdBytes && !isOverLimit;

  if (isOverLimit) {
    core.error(
      `❌ Contract size ${formatBytes(contractSizeBytes)} exceeds limit of ${formatBytes(sizeLimitBytes)} ` +
        `(${formatPercent(contractSizeBytes, sizeLimitBytes)}% — over by ${formatBytes(contractSizeBytes - sizeLimitBytes)})`,
    );
  } else if (isNearLimit) {
    core.warning(
      `⚠️  Contract size ${formatBytes(contractSizeBytes)} is ${formatPercent(contractSizeBytes, sizeLimitBytes)}% of the ` +
        `${formatBytes(sizeLimitBytes)} limit (threshold: ${warningThresholdPercent}%).`,
    );
  } else {
    core.info(
      `✅ Contract size ${formatBytes(contractSizeBytes)} is within limits ` +
        `(${formatPercent(contractSizeBytes, sizeLimitBytes)}% of ${formatBytes(sizeLimitBytes)}).`,
    );
  }

  core.endGroup();
  return { contractSizeBytes, sizeLimitBytes, warningThresholdBytes, percentOfLimit, isOverLimit, isNearLimit };
}

// ─── Step 3 – Compare with previous / baseline build ─────────────────────────

async function stepCompareBaseline(currentSizeBytes, inputs) {
  core.startGroup('Step 3 — Compare with previous build');

  const { baselineArtifact } = inputs;
  let baselineSizeBytes = null;
  let delta = null;
  let source = 'none';

  // Sub-step 3a: Try reading a local baseline file
  if (baselineArtifact && fileExists(baselineArtifact)) {
    try {
      const raw = fs.readFileSync(baselineArtifact, 'utf8').trim();
      // Support plain number OR JSON {"size": N}
      let parsed;
      try {
        parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.size === 'number') {
          baselineSizeBytes = parsed.size;
        } else if (typeof parsed === 'number') {
          baselineSizeBytes = parsed;
        }
      } catch {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) baselineSizeBytes = n;
      }
      if (baselineSizeBytes !== null) {
        source = `local file: ${baselineArtifact}`;
        core.info(`Loaded baseline size from ${baselineArtifact}: ${formatBytes(baselineSizeBytes)}`);
      }
    } catch (e) {
      core.warning(`Could not read baseline file ${baselineArtifact}: ${e.message}`);
    }
  }

  // Sub-step 3b: Try GitHub Actions artifact API if we have a token and name
  if (baselineSizeBytes === null && baselineArtifact && !fileExists(baselineArtifact)) {
    core.info(`Attempting to fetch artifact "${baselineArtifact}" from GitHub Actions API…`);
    try {
      const fetched = await tryFetchArtifactSize(baselineArtifact);
      if (fetched !== null) {
        baselineSizeBytes = fetched;
        source = `GitHub artifact: ${baselineArtifact}`;
        core.info(`Fetched baseline size from artifact "${baselineArtifact}": ${formatBytes(baselineSizeBytes)}`);
      }
    } catch (e) {
      core.warning(`Artifact fetch failed: ${e.message}`);
    }
  }

  // Sub-step 3c: Try reading a conventionally named size file in the workspace
  if (baselineSizeBytes === null) {
    const conventionalPath = path.resolve('.near-size-baseline.json');
    if (fileExists(conventionalPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(conventionalPath, 'utf8'));
        if (typeof raw.size === 'number') {
          baselineSizeBytes = raw.size;
          source = `conventional file: ${conventionalPath}`;
          core.info(`Loaded baseline from ${conventionalPath}: ${formatBytes(baselineSizeBytes)}`);
        }
      } catch (e) {
        core.warning(`Could not parse ${conventionalPath}: ${e.message}`);
      }
    }
  }

  if (baselineSizeBytes !== null) {
    delta = currentSizeBytes - baselineSizeBytes;
    const deltaSign = delta >= 0 ? '+' : '';
    const percentChange = ((delta / baselineSizeBytes) * 100).toFixed(2);
    core.info(`Baseline source  : ${source}`);
    core.info(`Baseline size    : ${formatBytes(baselineSizeBytes)}`);
    core.info(`Current size     : ${formatBytes(currentSizeBytes)}`);
    core.info(`Delta            : ${deltaSign}${formatBytes(Math.abs(delta))} (${deltaSign}${percentChange}%)`);

    if (delta > 0) {
      core.warning(`📈 Contract grew by ${formatBytes(delta)} (${deltaSign}${percentChange}%) since baseline.`);
    } else if (delta < 0) {
      core.info(`📉 Contract shrank by ${formatBytes(Math.abs(delta))} (${percentChange}%) since baseline.`);
    } else {
      core.info('➡️  Contract size is unchanged since baseline.');
    }
  } else {
    core.info('No baseline available — skipping comparison.');
  }

  // Always write a new baseline file so subsequent runs can compare
  const newBaseline = { size: currentSizeBytes, timestamp: new Date().toISOString() };
  try {
    fs.writeFileSync('.near-size-baseline.json', JSON.stringify(newBaseline, null, 2));
    core.info('Wrote .near-size-baseline.json for future comparisons.');
  } catch (e) {
    core.warning(`Could not write .near-size-baseline.json: ${e.message}`);
  }

  core.endGroup();
  return { baselineSizeBytes, delta };
}

// ─── Step 3 helper: fetch artifact size via GitHub REST API ──────────────────

async function tryFetchArtifactSize(artifactName) {
  const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';

  if (!token) {
    core.info('GITHUB_TOKEN not set — cannot query artifacts API.');
    return null;
  }
  if (!repo) {
    core.info('GITHUB_REPOSITORY not set — cannot query artifacts API.');
    return null;
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    core.info(`Unexpected GITHUB_REPOSITORY format: "${repo}"`);
    return null;
  }

  // List artifacts and find the one matching our name
  const artifacts = await githubApiGet(
    `/repos/${owner}/${repoName}/actions/artifacts?per_page=100`,
    token,
  );

  if (!artifacts || !Array.isArray(artifacts.artifacts)) {
    core.info('Artifacts API returned unexpected shape.');
    return null;
  }

  // Find the most recent artifact with the matching name
  const matching = artifacts.artifacts
    .filter((a) => a.name === artifactName && !a.expired)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (matching.length === 0) {
    core.info(
      `Found ${artifacts.artifacts.length} artifacts but none named "${artifactName}" (non-expired).`,
    );
    return null;
  }

  const artifact = matching[0];
  core.info(
    `Found artifact "${artifact.name}" (id=${artifact.id}, size_in_bytes=${artifact.size_in_bytes}, ` +
      `created_at=${artifact.created_at})`,
  );

  // The artifact size_in_bytes is the compressed archive size; we want the WASM size.
  // We store it in a metadata JSON in the archive. If unavailable, return the archive size
  // with a warning so callers can decide whether it's useful.
  if (typeof artifact.size_in_bytes === 'number' && artifact.size_in_bytes > 0) {
    core.info(
      `Using artifact archive size as proxy baseline: ${formatBytes(artifact.size_in_bytes)} ` +
        `(note: this is the compressed archive — delta may not be exact).`,
    );
    return artifact.size_in_bytes;
  }

  return null;
}

// ─── Minimal GitHub REST GET helper (no Octokit dependency) ──────────────────

function githubApiGet(apiPath, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'User-Agent': 'near-contract-size-check-action/1.0',
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse GitHub API response: ${e.message}`));
          }
        } else {
          reject(new Error(`GitHub API returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('GitHub API request timed out after 15 s'));
    });
    req.end();
  });
}

// ─── Step 4 – Suggest optimisations ──────────────────────────────────────────

function stepSuggestOptimisations(wasmPath, sizeInfo, inputs) {
  core.startGroup('Step 4 — Optimisation suggestions');

  if (!inputs.optimizationSuggestions) {
    core.info('optimization_suggestions is disabled — skipping.');
    core.endGroup();
    return [];
  }

  const { contractSizeBytes, sizeLimitBytes, percentOfLimit, isOverLimit, isNearLimit } = sizeInfo;
  const suggestions = [];

  // Only emit suggestions when warranted
  if (!isOverLimit && !isNearLimit) {
    core.info('Contract is well within limits — no optimisation suggestions needed.');
    core.endGroup();
    return suggestions;
  }

  core.info(`Analysing WASM for optimisation opportunities…`);

  // ── Wasm-opt check ──────────────────────────────────────────────────────────
  const wasmOptAvailable = spawnSync('wasm-opt --version', { shell: true }).status === 0;
  if (wasmOptAvailable) {
    // Measure what wasm-opt would produce
    const tmpOut = wasmPath + '.opt-check.wasm';
    try {
      const result = spawnSync(
        `wasm-opt -Oz --strip-debug --strip-producers "${wasmPath}" -o "${tmpOut}"`,
        { shell: true, encoding: 'utf8' },
      );
      if (result.status === 0 && fileExists(tmpOut)) {
        const optSize = fs.statSync(tmpOut).size;
        const saving = contractSizeBytes - optSize;
        if (saving > 0) {
          suggestions.push({
            id: 'wasm-opt',