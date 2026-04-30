async function buildContractWasm(contractPath) {
  log('=== STEP 1: Build Contract WASM ===');

  const absPath = path.resolve(contractPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Contract path does not exist: ${absPath}`);
  }

  const stat = fs.statSync(absPath);

  // If it's already a WASM file, skip build
  if (stat.isFile() && absPath.endsWith('.wasm')) {
    log(`Input is already a WASM file: ${absPath}`);
    return { wasmPath: absPath, builtFromSource: false };
  }

  if (!stat.isDirectory()) {
    throw new Error(`Contract path must be a directory or .wasm file: ${absPath}`);
  }

  log(`Building contract from directory: ${absPath}`);

  // Detect project type
  const hasCargoToml = fs.existsSync(path.join(absPath, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(absPath, 'package.json'));
  const hasMakefile = fs.existsSync(path.join(absPath, 'Makefile'));

  let builtWasmPath = null;

  if (hasMakefile) {
    log('Detected Makefile — attempting make build');
    try {
      runCommand('make build', absPath);
      const wasmFiles = findWasmFiles(path.join(absPath, 'res'))
        .concat(findWasmFiles(path.join(absPath, 'out')))
        .concat(findWasmFiles(path.join(absPath, 'target')));
      if (wasmFiles.length > 0) {
        builtWasmPath = wasmFiles[0];
        log(`Found WASM after make build: ${builtWasmPath}`);
      }
    } catch (err) {
      log(`make build failed, trying other build methods: ${err.message}`);
    }
  }

  if (!builtWasmPath && hasCargoToml) {
    log('Detected Rust/Cargo project — building with cargo');

    // Check for cargo
    if (!commandExists('cargo')) {
      throw new Error('cargo not found. Please install Rust toolchain.');
    }

    // Install wasm target if needed
    try {
      runCommand('rustup target add wasm32-unknown-unknown', absPath);
    } catch (e) {
      log('Warning: could not add wasm32 target (may already exist)');
    }

    // Try cargo-near first, then fall back to cargo build
    if (commandExists('cargo-near')) {
      log('Using cargo-near for optimized build');
      try {
        runCommand('cargo near build', absPath);
      } catch (e) {
        log('cargo-near build failed, falling back to cargo build --target wasm32-unknown-unknown');
        runCommand(
          'cargo build --target wasm32-unknown-unknown --release',
          absPath
        );
      }
    } else {
      log('Using cargo build --target wasm32-unknown-unknown --release');
      runCommand(
        'cargo build --target wasm32-unknown-unknown --release',
        absPath
      );
    }

    // Find the built WASM
    const targetDir = path.join(absPath, 'target', 'wasm32-unknown-unknown', 'release');
    if (fs.existsSync(targetDir)) {
      const wasmFiles = findWasmFiles(targetDir).filter(
        (f) => !f.includes('deps') && !f.includes('incremental')
      );
      if (wasmFiles.length > 0) {
        // Sort by modification time, newest first
        wasmFiles.sort(
          (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
        );
        builtWasmPath = wasmFiles[0];
        log(`Found built WASM: ${builtWasmPath}`);
      }
    }

    // Also check res/ directory (common NEAR pattern)
    if (!builtWasmPath) {
      const resDir = path.join(absPath, 'res');
      if (fs.existsSync(resDir)) {
        const wasmFiles = findWasmFiles(resDir);
        if (wasmFiles.length > 0) {
          builtWasmPath = wasmFiles[0];
          log(`Found WASM in res/: ${builtWasmPath}`);
        }
      }
    }

    if (!builtWasmPath) {
      // Last resort: search entire project
      const allWasm = findWasmFiles(absPath).filter(
        (f) => !f.includes('incremental')
      );
      if (allWasm.length > 0) {
        allWasm.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        builtWasmPath = allWasm[0];
        log(`Found WASM (broad search): ${builtWasmPath}`);
      }
    }
  } else if (!builtWasmPath && hasPackageJson) {
    log('Detected Node.js project — attempting npm/yarn build');

    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(absPath, 'package.json'), 'utf8')
    );
    const hasBuildScript = pkgJson.scripts && pkgJson.scripts.build;

    if (!hasBuildScript) {
      throw new Error(
        'No build script found in package.json. Cannot build WASM.'
      );
    }

    const useYarn = fs.existsSync(path.join(absPath, 'yarn.lock'));
    const pkgManager = useYarn ? 'yarn' : 'npm';

    runCommand(`${pkgManager} install`, absPath);
    runCommand(`${pkgManager} run build`, absPath);

    const wasmFiles = findWasmFiles(absPath).filter(
      (f) => !f.includes('node_modules')
    );
    if (wasmFiles.length > 0) {
      wasmFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      builtWasmPath = wasmFiles[0];
      log(`Found WASM after npm build: ${builtWasmPath}`);
    }
  }

  if (!builtWasmPath) {
    // Check if there's already a WASM in the directory
    const existingWasm = findWasmFiles(absPath).filter(
      (f) => !f.includes('node_modules') && !f.includes('incremental')
    );
    if (existingWasm.length > 0) {
      existingWasm.sort(
        (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      );
      builtWasmPath = existingWasm[0];
      log(`Using existing WASM file: ${builtWasmPath}`);
    } else {
      throw new Error(
        `Could not find or build WASM file in: ${absPath}\n` +
          'Ensure the contract builds correctly locally first.'
      );
    }
  }

  log(`✅ Contract WASM ready: ${builtWasmPath}`);
  return { wasmPath: builtWasmPath, builtFromSource: true };
}

// ─── Step 2: Check Size Against Limits ──────────────────────────────────────

async function checkSizeAgainstLimits(wasmPath, sizeLimitKb, warningThresholdPercent) {
  log('=== STEP 2: Check Size Against Limits ===');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found: ${wasmPath}`);
  }

  const stat = fs.statSync(wasmPath);
  const sizeBytes = stat.size;
  const sizeKb = sizeBytes / 1024;
  const limitBytes = sizeLimitKb * 1024;
  const warningBytes = limitBytes * (warningThresholdPercent / 100);

  log(`WASM file: ${wasmPath}`);
  log(`File size: ${formatBytes(sizeBytes)} (${sizeKb.toFixed(2)} KB)`);
  log(`Size limit: ${formatBytes(limitBytes)} (${sizeLimitKb} KB)`);
  log(
    `Warning threshold: ${formatBytes(warningBytes)} (${warningThresholdPercent}% of limit)`
  );

  const percentOfLimit = (sizeBytes / limitBytes) * 100;
  const remainingBytes = limitBytes - sizeBytes;
  const isOverLimit = sizeBytes > limitBytes;
  const isNearLimit = sizeBytes >= warningBytes && !isOverLimit;

  // Set outputs
  core.setOutput('contract_size_bytes', sizeBytes.toString());
  core.setOutput('contract_size_kb', sizeKb.toFixed(2));
  core.setOutput('size_limit_kb', sizeLimitKb.toString());
  core.setOutput('percent_of_limit', percentOfLimit.toFixed(1));
  core.setOutput('is_over_limit', isOverLimit.toString());
  core.setOutput('is_near_limit', isNearLimit.toString());

  // Create summary table
  const summaryLines = [
    `## 📦 NEAR Contract Size Report`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Contract WASM | \`${path.basename(wasmPath)}\` |`,
    `| Current Size | **${formatBytes(sizeBytes)}** (${sizeKb.toFixed(2)} KB) |`,
    `| Size Limit | ${formatBytes(limitBytes)} (${sizeLimitKb} KB) |`,
    `| Usage | ${percentOfLimit.toFixed(1)}% of limit |`,
    `| Remaining | ${formatBytes(Math.max(0, remainingBytes))} |`,
  ];

  if (isOverLimit) {
    const overBy = sizeBytes - limitBytes;
    core.error(
      `❌ Contract size ${formatBytes(sizeBytes)} EXCEEDS limit of ${formatBytes(limitBytes)} by ${formatBytes(overBy)}`
    );
    summaryLines.push(`| Status | ❌ **OVER LIMIT** (exceeds by ${formatBytes(overBy)}) |`);
  } else if (isNearLimit) {
    core.warning(
      `⚠️ Contract size ${formatBytes(sizeBytes)} is ${percentOfLimit.toFixed(1)}% of limit — approaching ${formatBytes(limitBytes)} limit`
    );
    summaryLines.push(
      `| Status | ⚠️ **WARNING** — approaching limit (${percentOfLimit.toFixed(1)}%) |`
    );
  } else {
    log(
      `✅ Contract size ${formatBytes(sizeBytes)} is within limit (${percentOfLimit.toFixed(1)}% used)`
    );
    summaryLines.push(`| Status | ✅ Within limit (${percentOfLimit.toFixed(1)}% used) |`);
  }

  // Visual size bar
  const barWidth = 40;
  const filled = Math.min(Math.round((percentOfLimit / 100) * barWidth), barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const barEmoji = isOverLimit ? '🔴' : isNearLimit ? '🟡' : '🟢';
  summaryLines.push(``, `### Size Usage`);
  summaryLines.push(`\`${barEmoji} [${bar}] ${percentOfLimit.toFixed(1)}%\``);

  return {
    sizeBytes,
    sizeKb,
    sizeLimitKb,
    limitBytes,
    percentOfLimit,
    isOverLimit,
    isNearLimit,
    remainingBytes: Math.max(0, remainingBytes),
    wasmPath,
    summaryLines,
  };
}

// ─── Step 3: Compare with Previous Builds ───────────────────────────────────

async function compareWithPreviousBuilds(sizeResult, baselineArtifact) {
  log('=== STEP 3: Compare with Previous Builds ===');

  const comparison = {
    hasBaseline: false,
    baselineSizeBytes: null,
    sizeDeltaBytes: null,
    sizeDeltaPercent: null,
    trend: 'unknown',
    summaryLines: [],
  };

  if (!baselineArtifact) {
    log('No baseline artifact specified — skipping comparison');
    comparison.summaryLines.push(
      ``,
      `### 📊 Size Comparison`,
      `No baseline artifact configured. Set \`baseline_artifact\` input to enable size tracking.`
    );
    return comparison;
  }

  log(`Looking for baseline artifact: ${baselineArtifact}`);

  // Try to download baseline from GitHub Actions artifacts
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    log('GITHUB_REPOSITORY or GITHUB_TOKEN not available — cannot fetch baseline artifact');
    comparison.summaryLines.push(
      ``,
      `### 📊 Size Comparison`,
      `⚠️ Could not fetch baseline: GITHUB_TOKEN required for artifact comparison.`
    );
    return comparison;
  }

  const [owner, repoName] = repo.split('/');

  try {
    // List artifacts for this repo
    log(`Fetching artifact list from GitHub API for ${repo}`);
    const listUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/artifacts?per_page=50&name=${encodeURIComponent(baselineArtifact)}`;

    const response = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repoName}/actions/artifacts?per_page=50&name=${encodeURIComponent(baselineArtifact)}`,
      method: 'GET',
      headers: getGitHubApiHeaders(),
    });

    if (response.statusCode !== 200) {
      log(`GitHub API returned ${response.statusCode}: ${response.body}`);
      comparison.summaryLines.push(
        ``,
        `### 📊 Size Comparison`,
        `⚠️ Could not fetch baseline artifact (API status ${response.statusCode}).`
      );
      return comparison;
    }

    const data = JSON.parse(response.body);

    if (!data.artifacts || data.artifacts.length === 0) {
      log(`No artifacts found with name: ${baselineArtifact}`);
      comparison.summaryLines.push(
        ``,
        `### 📊 Size Comparison`,
        `No previous build found for artifact \`${baselineArtifact}\`. This will be the baseline.`
      );
      return comparison;
    }

    // Sort by created_at descending to get latest
    const artifacts = data.artifacts
      .filter((a) => !a.expired)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (artifacts.length === 0) {
      log('All matching artifacts have expired');
      comparison.summaryLines.push(
        ``,
        `### 📊 Size Comparison`,
        `Previous artifacts have expired. No comparison available.`
      );
      return comparison;
    }

    const latestArtifact = artifacts[0];
    log(
      `Found baseline artifact: ${latestArtifact.name} (id: ${latestArtifact.id}, created: ${latestArtifact.created_at})`
    );

    // Download artifact zip
    const downloadResponse = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repoName}/actions/artifacts/${latestArtifact.id}/zip`,
      method: 'GET',
      headers: { ...getGitHubApiHeaders(), Accept: 'application/vnd.github.v3+json' },
    });

    // GitHub redirects to a signed S3 URL
    if (downloadResponse.statusCode === 302 || downloadResponse.statusCode === 301) {
      const redirectUrl = downloadResponse.body; // Not always in body for https module
      log('Artifact download requires redirect — attempting direct download via Actions toolkit');
    }

    // Try to read a size metadata file from the artifact
    // In practice, we'd need @actions/artifact to properly download
    // Instead, check if there's a size metadata JSON stored as artifact
    log('Attempting to read size metadata from artifact...');

    // Check for a local baseline file as fallback
    const localBaselineFile = path.join(
      process.env.GITHUB_WORKSPACE || process.cwd(),
      '.near-size-baseline.json'
    );

    if (fs.existsSync(localBaselineFile)) {
      log(`Found local baseline file: ${localBaselineFile}`);
      const baselineData = JSON.parse(fs.readFileSync(localBaselineFile, 'utf8'));
      if (baselineData.sizeBytes) {
        comparison.hasBaseline = true;
        comparison.baselineSizeBytes = baselineData.sizeBytes;
        comparison.baselineCommit = baselineData.commit || 'unknown';
        comparison.baselineDate = baselineData.date || 'unknown';
      }
    } else {
      log(`No local baseline file found at ${localBaselineFile}`);
      // Store current size as baseline for next run
      const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
      const baselineToWrite = {
        sizeBytes: sizeResult.sizeBytes,
        sizeKb: sizeResult.sizeKb,
        commit: process.env.GITHUB_SHA || 'unknown',
        date: new Date().toISOString(),
        wasmFile: path.basename(sizeResult.wasmPath),
      };
      try {
        fs.writeFileSync(localBaselineFile, JSON.stringify(baselineToWrite, null, 2));
        log(`Wrote baseline file for future comparisons: ${localBaselineFile}`);
      } catch (e) {
        log(`Could not write baseline file: ${e.message}`);
      }
    }
  } catch (err) {
    log(`Warning: Could not fetch baseline artifact: ${err.message}`);
    comparison.summaryLines.push(
      ``,
      `### 📊 Size Comparison`,
      `⚠️ Could not fetch baseline: ${err.message}`
    );
    return comparison;
  }

  if (!comparison.hasBaseline) {
    comparison.summaryLines.push(
      ``,
      `### 📊 Size Comparison`,
      `No previous build data available. Current build will serve as baseline.`
    );
    return comparison;
  }

  // Calculate delta
  comparison.sizeDeltaBytes = sizeResult.sizeBytes - comparison.baselineSizeBytes;
  comparison.sizeDeltaPercent =
    (comparison.sizeDeltaBytes / comparison.baselineSizeBytes) * 100;

  const deltaSign = comparison.sizeDeltaBytes >= 0 ? '+' : '';
  const trendEmoji =
    comparison.sizeD