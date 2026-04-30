async function fetchBaselineSize(baselineArtifact) {
  // 1. If a direct numeric value is given, treat it as baseline bytes
  if (baselineArtifact && /^\d+$/.test(baselineArtifact.trim())) {
    const bytes = parseInt(baselineArtifact.trim(), 10);
    core.info(`Using numeric baseline: ${formatBytes(bytes)}`);
    return bytes;
  }

  // 2. If it's a file path that exists locally
  if (baselineArtifact && fs.existsSync(baselineArtifact)) {
    if (baselineArtifact.endsWith('.wasm')) {
      const bytes = getFileSizeBytes(baselineArtifact);
      core.info(`Using local baseline WASM file: ${formatBytes(bytes)}`);
      return bytes;
    }
    if (baselineArtifact.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(baselineArtifact, 'utf8'));
        if (typeof data.size_bytes === 'number') {
          core.info(`Using local JSON baseline: ${formatBytes(data.size_bytes)}`);
          return data.size_bytes;
        }
      } catch {
        core.warning('Could not parse JSON baseline file.');
      }
    }
  }

  // 3. Attempt to load from the temp cache written by a previous run in the
  //    same job (e.g., when this action is called multiple times)
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (typeof cached.size_bytes === 'number') {
        core.info(`Loaded baseline from cache: ${formatBytes(cached.size_bytes)}`);
        return cached.size_bytes;
      }
    } catch {
      // ignore
    }
  }

  // 4. Try GitHub API — download artifact by name if GITHUB_TOKEN is set
  if (baselineArtifact && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    try {
      const bytes = await fetchArtifactSizeFromGitHub(baselineArtifact);
      if (bytes !== null) return bytes;
    } catch (err) {
      core.warning(`GitHub artifact fetch failed: ${err.message}`);
    }
  }

  core.info('No baseline found — skipping comparison.');
  return null;
}

// ---------------------------------------------------------------------------
// UTILITY: fetchArtifactSizeFromGitHub — queries the GitHub Actions API
// ---------------------------------------------------------------------------
function fetchArtifactSizeFromGitHub(artifactName) {
  return new Promise((resolve) => {
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
    if (!owner || !repo) { resolve(null); return; }

    const token = process.env.GITHUB_TOKEN;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=5`,
      method: 'GET',
      headers: {
        'User-Agent': 'near-contract-size-check-action',
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.artifacts && json.artifacts.length > 0) {
            // The artifact size_in_bytes is the zip size, not the WASM size,
            // so we record it as an approximate baseline indicator.
            const latest = json.artifacts[0];
            core.info(`Found GitHub artifact: ${latest.name} (${formatBytes(latest.size_in_bytes)})`);
            resolve(latest.size_in_bytes);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// UTILITY: saveCurrentSize — persists size data for downstream steps / caching
// ---------------------------------------------------------------------------
function saveCurrentSize(wasmPath, sizeBytes) {
  const data = {
    wasm_path: wasmPath,
    size_bytes: sizeBytes,
    size_kb: sizeBytes / 1024,
    timestamp: new Date().toISOString(),
    sha: process.env.GITHUB_SHA || 'unknown',
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  // Also write to workspace for upload-artifact convenience
  const workspacePath = path.join(process.env.GITHUB_WORKSPACE || '.', 'near-size-report.json');
  fs.writeFileSync(workspacePath, JSON.stringify(data, null, 2));
  core.info(`Size report written to: ${workspacePath}`);
  return workspacePath;
}

// ---------------------------------------------------------------------------
// UTILITY: generateOptimizationSuggestions
// ---------------------------------------------------------------------------
function generateOptimizationSuggestions(sizeBytes, limitBytes, wasmPath) {
  const suggestions = [];
  const sizeKb = sizeBytes / 1024;
  const limitKb = limitBytes / 1024;
  const usagePercent = (sizeBytes / limitBytes) * 100;

  suggestions.push({
    priority: 'HIGH',
    title: 'Enable wasm-opt',
    description:
      'Run `wasm-opt -Oz --strip-debug --strip-producers -o out.wasm in.wasm` to strip debug info and optimize. Can reduce size by 20–40%.',
    command: `wasm-opt -Oz --strip-debug --strip-producers -o ${wasmPath}.opt.wasm ${wasmPath}`,
  });

  suggestions.push({
    priority: 'HIGH',
    title: 'Build with release profile + opt-level=z',
    description:
      'Add to Cargo.toml:\n[profile.release]\nopt-level = "z"\nlto = true\ncodegen-units = 1\npanic = "abort"',
    command: 'cargo build --target wasm32-unknown-unknown --release',
  });

  suggestions.push({
    priority: 'MEDIUM',
    title: 'Strip debug symbols',
    description: 'Use `cargo build` with `strip = true` or run `wasm-strip` on the output.',
    command: `wasm-strip ${wasmPath}`,
  });

  if (sizeKb > 1024) {
    suggestions.push({
      priority: 'MEDIUM',
      title: 'Audit dependencies',
      description:
        'Large contracts often pull in heavy Rust crates. Run `cargo bloat --release --target wasm32-unknown-unknown` to identify the biggest contributors.',
      command: 'cargo bloat --release --target wasm32-unknown-unknown --crates',
    });
  }

  if (sizeKb > 2048) {
    suggestions.push({
      priority: 'HIGH',
      title: 'Consider contract splitting',
      description:
        `At ${sizeKb.toFixed(0)} KB your contract is approaching the ${limitKb.toFixed(0)} KB NEAR limit. ` +
        'Consider splitting logic into multiple factory contracts or using upgradeable patterns.',
      command: null,
    });
  }

  suggestions.push({
    priority: 'LOW',
    title: 'Remove unused features',
    description:
      'Disable default Cargo features you do not use: `near-sdk = { version = "...", default-features = false, features = ["..."] }`',
    command: null,
  });

  suggestions.push({
    priority: 'LOW',
    title: 'Use near-sdk macros efficiently',
    description:
      'Avoid deriving unnecessary traits (e.g., Debug, Clone) on storage types. Each derived impl adds code.',
    command: null,
  });

  return suggestions;
}

// ---------------------------------------------------------------------------
// UTILITY: buildSummaryTable — produces a Markdown summary string
// ---------------------------------------------------------------------------
function buildSummaryTable({ wasmPath, sizeBytes, limitBytes, baselineBytes, suggestions, warningTriggered, overLimit }) {
  const sizeKb = (sizeBytes / 1024).toFixed(2);
  const limitKb = (limitBytes / 1024).toFixed(2);
  const usagePct = formatPercent(sizeBytes, limitBytes);

  let statusEmoji = overLimit ? '❌' : warningTriggered ? '⚠️' : '✅';
  let statusText = overLimit ? 'OVER LIMIT' : warningTriggered ? 'WARNING' : 'OK';

  let md = `## NEAR Contract Size Check — ${statusEmoji} ${statusText}\n\n`;
  md += `| Field | Value |\n`;
  md += `|-------|-------|\n`;
  md += `| WASM File | \`${path.basename(wasmPath)}\` |\n`;
  md += `| Contract Size | **${sizeKb} KB** (${formatBytes(sizeBytes)}) |\n`;
  md += `| Size Limit | ${limitKb} KB |\n`;
  md += `| Usage | ${usagePct} of limit |\n`;

  if (baselineBytes !== null && baselineBytes !== undefined) {
    const diffBytes = sizeBytes - baselineBytes;
    const diffSign = diffBytes >= 0 ? '+' : '';
    const diffPct = ((diffBytes / baselineBytes) * 100).toFixed(2);
    const diffEmoji = diffBytes > 0 ? '📈' : diffBytes < 0 ? '📉' : '➡️';
    md += `| vs Baseline | ${diffEmoji} ${diffSign}${formatBytes(Math.abs(diffBytes))} (${diffSign}${diffPct}%) |\n`;
    md += `| Baseline Size | ${formatBytes(baselineBytes)} |\n`;
  }

  md += `\n`;

  if (overLimit) {
    md += `> ❌ **Contract exceeds the ${limitKb} KB size limit and cannot be deployed to NEAR mainnet/testnet.**\n\n`;
  } else if (warningTriggered) {
    md += `> ⚠️ **Contract is approaching the size limit. Consider optimizing before it becomes a blocker.**\n\n`;
  } else {
    md += `> ✅ Contract size is within acceptable limits.\n\n`;
  }

  if (suggestions && suggestions.length > 0) {
    md += `### 💡 Optimization Suggestions\n\n`;
    for (const s of suggestions) {
      const priorityIcon = s.priority === 'HIGH' ? '🔴' : s.priority === 'MEDIUM' ? '🟡' : '🟢';
      md += `**${priorityIcon} [${s.priority}] ${s.title}**\n\n`;
      md += `${s.description}\n\n`;
      if (s.command) {
        md += `\`\`\`bash\n${s.command}\n\`\`\`\n\n`;
      }
    }
  }

  return md;
}

// ---------------------------------------------------------------------------
// STEP 1: stepBuildContract
//   Reads contract_path; if it's a .wasm file, uses it directly.
//   If it's a directory, attempts `cargo build --target wasm32-unknown-unknown --release`.
//   Returns: { wasmPath: string }
// ---------------------------------------------------------------------------
async function stepBuildContract(contractPath) {
  core.startGroup('Step 1 — Build / Locate Contract WASM');

  const resolvedPath = path.resolve(contractPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`contract_path does not exist: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);

  // Case A: direct WASM file
  if (stat.isFile()) {
    if (!resolvedPath.endsWith('.wasm')) {
      throw new Error(`contract_path points to a file but it is not a .wasm file: ${resolvedPath}`);
    }
    core.info(`contract_path is a WASM file — skipping build step.`);
    core.endGroup();
    return { wasmPath: resolvedPath };
  }

  // Case B: directory — build with cargo
  core.info(`contract_path is a directory: ${resolvedPath}`);
  core.info('Checking for Cargo.toml...');

  const cargoToml = path.join(resolvedPath, 'Cargo.toml');
  if (!fs.existsSync(cargoToml)) {
    // Maybe it's a workspace — search one level up
    core.warning('No Cargo.toml found in contract_path directly. Searching for WASM files...');
    const wasmFiles = findWasmFiles(resolvedPath);
    if (wasmFiles.length === 0) {
      throw new Error(
        `No Cargo.toml found in ${resolvedPath} and no pre-built .wasm files found. ` +
        'Please provide the path to a Cargo project or a pre-built .wasm file.'
      );
    }
    core.info(`Found pre-built WASM files:\n${wasmFiles.join('\n')}`);
    // Pick the largest one (most likely the main contract)
    wasmFiles.sort((a, b) => getFileSizeBytes(b) - getFileSizeBytes(a));
    const chosen = wasmFiles[0];
    core.info(`Using: ${chosen}`);
    core.endGroup();
    return { wasmPath: chosen };
  }

  // Run cargo build
  core.info('Building contract with cargo...');
  const buildCmd =
    `cargo build --target wasm32-unknown-unknown --release 2>&1`;
  try {
    execCommand(buildCmd, { cwd: resolvedPath });
  } catch (err) {
    // Some environments may need RUSTFLAGS
    core.warning(`Initial build failed: ${err.message}`);
    core.info('Retrying with RUSTFLAGS=-C link-arg=-s...');
    execCommand(
      `RUSTFLAGS="-C link-arg=-s" cargo build --target wasm32-unknown-unknown --release 2>&1`,
      { cwd: resolvedPath }
    );
  }

  // Locate the built WASM
  const targetDir = path.join(resolvedPath, 'target', 'wasm32-unknown-unknown', 'release');
  let wasmFiles = findWasmFiles(targetDir);

  if (wasmFiles.length === 0) {
    // Broader search
    wasmFiles = findWasmFiles(path.join(resolvedPath, 'target'));
  }

  if (wasmFiles.length === 0) {
    throw new Error(
      `Build succeeded but no .wasm files found under ${resolvedPath}/target. ` +
      'Check that your Cargo.toml has `crate-type = ["cdylib"]`.'
    );
  }

  // Filter out .d files, prefer non-deps
  const nonDeps = wasmFiles.filter((f) => !f.includes('/deps/'));
  const candidates = nonDeps.length > 0 ? nonDeps : wasmFiles;

  // Pick largest
  candidates.sort((a, b) => getFileSizeBytes(b) - getFileSizeBytes(a));
  const chosenWasm = candidates[0];

  core.info(`Build complete. Using WASM: ${chosenWasm}`);
  core.info(`All WASM files found:\n${candidates.map((f) => `  ${f} (${formatBytes(getFileSizeBytes(f))})`).join('\n')}`);

  core.endGroup();
  return { wasmPath: chosenWasm };
}

// ---------------------------------------------------------------------------
// STEP 2: stepAnalyzeSize
//   Input:  { wasmPath }
//   Output: { sizeBytes, sizeKb, limitBytes, limitKb, warningThresholdBytes,
//             warningTriggered, overLimit, usagePercent }
// ---------------------------------------------------------------------------
async function stepAnalyzeSize({ wasmPath, sizeLimitKb, warningThresholdPercent }) {
  core.startGroup('Step 2 — Analyze Contract Size');

  const sizeBytes = getFileSizeBytes(wasmPath);
  const sizeKb = sizeBytes / 1024;

  // Clamp limit to NEAR's hard cap
  const effectiveLimitKb = Math.min(sizeLimitKb, NEAR_HARD_LIMIT_KB);
  const limitBytes = effectiveLimitKb * 1024;
  const warningThresholdBytes = limitBytes * (warningThresholdPercent / 100);
  const usagePercent = (sizeBytes / limitBytes) * 100;
  const warningTriggered = sizeBytes >= warningThresholdBytes;
  const overLimit = sizeBytes > limitBytes;

  core.info(`WASM file     : ${wasmPath}`);
  core.info(`Contract size : ${formatBytes(sizeBytes)} (${sizeKb.toFixed(2)} KB)`);
  core.info(`Size limit    : ${formatBytes(limitBytes)} (${effectiveLimitKb} KB)`);
  core.info(`Usage         : ${usagePercent.toFixed(2)}% of limit`);
  core.info(`Warning at    : ${warningThresholdPercent}% = ${formatBytes(warningThresholdBytes)}`);
  core.info(`Over limit    : ${overLimit}`);
  core.info(`Warning zone  : ${warningTriggered}`);

  // Set GitHub Action outputs
  core.setOutput('size_bytes', String(sizeBytes));
  core.setOutput('size_kb', sizeKb.toFixed(2));
  core.setOutput('limit_kb', String(effectiveLimitKb));
  core.setOutput('usage_percent', usagePercent.toFixed(2));
  core.setOutput('over_limit', String(overLimit));
  core.setOutput('warning_triggered', String(warningTriggered));
  core.setOutput('wasm_path', wasmPath);

  core.endGroup();
  return {
    sizeBytes,
    sizeKb,
    limitBytes,
    limitKb: effectiveLimitKb,
    warningThresholdBytes,
    warningTriggered,
    overLimit,
    usagePercent,
  };
}

// ---------------------------------------------------------------------------
// STEP 3: stepCompareDiff
//   Input:  { sizeBytes, baselineArtifact }
//   Output: { baselineBytes, diffBytes, diffPercent, diffDirection }
// ---------------------------------------------------------------------------
async function stepCompareDiff({ sizeBytes, baselineArtifact }) {
  core.startGroup('Step 3 — Compare with Baseline');

  if (!baselineArtifact) {
    core.info('No baseline_artifact configured — skipping diff.');
    core.setOutput('baseline_bytes', '');
    core.setOutput('diff_bytes', '');
    core.setOutput('diff_percent', '');
    core.endGroup();
    return { baselineBytes: null, diffBytes: null, diffPercent: null, diffDirection: null };
  }

  const baselineBytes =