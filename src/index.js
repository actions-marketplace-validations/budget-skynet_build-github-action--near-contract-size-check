```javascript
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

// ─── Single Source of Truth for Configuration ───────────────────────────────
const config = {
  NEAR_SIZE_LIMIT_BYTES: 4 * 1024 * 1024, // 4 MiB — actual NEAR protocol limit
  INPUT_CONTRACT_PATH: 'contract_path',
  INPUT_WASM_SIZE_LIMIT_KB: 'wasm_size_limit_kb',
  INPUT_WARNING_THRESHOLD_PERCENT: 'warning_threshold_percent',
  INPUT_BASELINE_ARTIFACT: 'baseline_artifact',
  INPUT_FAIL_ON_LIMIT_EXCEEDED: 'fail_on_limit_exceeded',
  INPUT_OPTIMIZATION_SUGGESTIONS: 'optimization_suggestions',
  OUTPUT_WASM_SIZE_BYTES: 'wasm_size_bytes',
  OUTPUT_WASM_SIZE_KB: 'wasm_size_kb',
  OUTPUT_SIZE_LIMIT_BYTES: 'size_limit_bytes',
  OUTPUT_USAGE_PERCENT: 'usage_percent',
  OUTPUT_STATUS: 'status',
  OUTPUT_BASELINE_SIZE_BYTES: 'baseline_size_bytes',
  OUTPUT_SIZE_DELTA_BYTES: 'size_delta_bytes',
  OUTPUT_WASM_PATH: 'wasm_path',
  OUTPUT_REPORT: 'report',
};

// ─── Utility helpers ─────────────────────────────────────────────────────────

function exec(cmd, opts = {}) {
  const defaults = { encoding: 'utf8', stdio: 'pipe' };
  try {
    const result = execSync(cmd, { ...defaults, ...opts });
    return { ok: true, stdout: result ? result.toString().trim() : '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? err.stdout.toString().trim() : '',
      stderr: err.stderr ? err.stderr.toString().trim() : '',
      status: err.status,
    };
  }
}

function findFiles(dir, extension) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, extension));
    } else if (entry.name.endsWith(extension)) {
      results.push(full);
    }
  }
  return results;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function parseBool(value, defaultVal = true) {
  if (typeof value !== 'string') return defaultVal;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return defaultVal;
}

function resolveCargoManifest(contractPath) {
  const abs = path.resolve(contractPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`contract_path does not exist: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isFile() && abs.endsWith('Cargo.toml')) {
    return abs;
  }
  if (stat.isDirectory()) {
    const candidate = path.join(abs, 'Cargo.toml');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No Cargo.toml found at: ${abs}`);
}

function readCargoPackageName(manifestPath) {
  const content = fs.readFileSync(manifestPath, 'utf8');
  const match = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (match) return match[1];
  return null;
}

function packageNameToLibName(name) {
  // Cargo converts hyphens to underscores for the lib file
  return name.replace(/-/g, '_');
}

// ─── Step 1: Parse & validate inputs ────────────────────────────────────────

function stepParseInputs() {
  core.startGroup('Step 1 — Parse & validate inputs');

  const contractPath = core.getInput(config.INPUT_CONTRACT_PATH, { required: true });
  const wasmSizeLimitKbRaw = core.getInput(config.INPUT_WASM_SIZE_LIMIT_KB) || '4096';
  const warningThresholdPercentRaw = core.getInput(config.INPUT_WARNING_THRESHOLD_PERCENT) || '80';
  const baselineArtifact = core.getInput(config.INPUT_BASELINE_ARTIFACT) || '';
  const failOnLimitExceededRaw = core.getInput(config.INPUT_FAIL_ON_LIMIT_EXCEEDED) || 'true';
  const optimizationSuggestionsRaw = core.getInput(config.INPUT_OPTIMIZATION_SUGGESTIONS) || 'true';

  const wasmSizeLimitKb = parseFloat(wasmSizeLimitKbRaw);
  if (isNaN(wasmSizeLimitKb) || wasmSizeLimitKb <= 0) {
    throw new Error(`Invalid wasm_size_limit_kb: "${wasmSizeLimitKbRaw}". Must be a positive number.`);
  }

  const warningThresholdPercent = parseFloat(warningThresholdPercentRaw);
  if (isNaN(warningThresholdPercent) || warningThresholdPercent < 0 || warningThresholdPercent > 100) {
    throw new Error(`Invalid warning_threshold_percent: "${warningThresholdPercentRaw}". Must be 0-100.`);
  }

  const wasmSizeLimitBytes = Math.round(wasmSizeLimitKb * 1024);
  const failOnLimitExceeded = parseBool(failOnLimitExceededRaw, true);
  const includeOptimizationSuggestions = parseBool(optimizationSuggestionsRaw, true);

  core.info(`contract_path               : ${contractPath}`);
  core.info(`wasm_size_limit_kb          : ${wasmSizeLimitKb} KB (${formatBytes(wasmSizeLimitBytes)})`);
  core.info(`warning_threshold_percent   : ${warningThresholdPercent}%`);
  core.info(`baseline_artifact           : ${baselineArtifact || '(none)'}`);
  core.info(`fail_on_limit_exceeded      : ${failOnLimitExceeded}`);
  core.info(`optimization_suggestions    : ${includeOptimizationSuggestions}`);
  core.info(`NEAR protocol hard limit    : ${formatBytes(config.NEAR_SIZE_LIMIT_BYTES)}`);

  if (wasmSizeLimitBytes > config.NEAR_SIZE_LIMIT_BYTES) {
    core.warning(
      `Configured wasm_size_limit_kb (${formatBytes(wasmSizeLimitBytes)}) exceeds the ` +
      `NEAR protocol hard limit of ${formatBytes(config.NEAR_SIZE_LIMIT_BYTES)}. ` +
      `Using NEAR hard limit instead.`
    );
  }

  core.endGroup();

  return {
    contractPath,
    wasmSizeLimitBytes: Math.min(wasmSizeLimitBytes, config.NEAR_SIZE_LIMIT_BYTES),
    warningThresholdPercent,
    baselineArtifact,
    failOnLimitExceeded,
    includeOptimizationSuggestions,
  };
}

// ─── Step 2: Build contract WASM ─────────────────────────────────────────────

function stepBuildContract(inputs) {
  core.startGroup('Step 2 — Build NEAR contract WASM');

  const { contractPath } = inputs;
  const manifestPath = resolveCargoManifest(contractPath);
  const manifestDir = path.dirname(manifestPath);

  core.info(`Cargo.toml: ${manifestPath}`);

  // Ensure wasm32 target is installed
  const targetCheck = exec('rustup target list --installed');
  const wasm32Installed = targetCheck.stdout.includes('wasm32-unknown-unknown');
  if (!wasm32Installed) {
    core.info('Installing wasm32-unknown-unknown target…');
    const install = exec('rustup target add wasm32-unknown-unknown');
    if (!install.ok) {
      throw new Error(`Failed to install wasm32 target:\n${install.stderr}`);
    }
  } else {
    core.info('wasm32-unknown-unknown target already installed.');
  }

  // Build with cargo
  const buildCmd = [
    'cargo build',
    '--target wasm32-unknown-unknown',
    '--release',
    `--manifest-path "${manifestPath}"`,
  ].join(' ');

  core.info(`Running: ${buildCmd}`);

  const buildResult = spawnSync('cargo', [
    'build',
    '--target', 'wasm32-unknown-unknown',
    '--release',
    '--manifest-path', manifestPath,
  ], {
    cwd: manifestDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  if (buildResult.status !== 0) {
    const stderr = buildResult.stderr || '';
    const stdout = buildResult.stdout || '';
    throw new Error(
      `cargo build failed (exit ${buildResult.status}):\n` +
      `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
    );
  }

  core.info('Build succeeded.');
  if (buildResult.stderr) {
    core.info('Cargo output:\n' + buildResult.stderr);
  }

  // Locate the built WASM — prefer res/ or target/wasm32-unknown-unknown/release/
  const packageName = readCargoPackageName(manifestPath);
  const libName = packageName ? packageNameToLibName(packageName) : null;

  const searchRoots = [
    path.join(manifestDir, 'res'),
    path.join(manifestDir, 'target', 'wasm32-unknown-unknown', 'release'),
    // workspace target
    path.join(manifestDir, '..', 'target', 'wasm32-unknown-unknown', 'release'),
    path.join(manifestDir, '..', '..', 'target', 'wasm32-unknown-unknown', 'release'),
  ];

  let wasmPath = null;

  // First try exact name match
  if (libName) {
    for (const root of searchRoots) {
      const candidate = path.join(root, `${libName}.wasm`);
      if (fs.existsSync(candidate)) {
        wasmPath = candidate;
        break;
      }
    }
  }

  // Fall back to any .wasm in release dirs (skip deps/)
  if (!wasmPath) {
    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      const wasms = fs.readdirSync(root)
        .filter(f => f.endsWith('.wasm') && !f.includes('-'))
        .map(f => path.join(root, f));
      if (wasms.length > 0) {
        // Pick largest (most likely the contract, not a small helper)
        wasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
        wasmPath = wasms[0];
        break;
      }
    }
  }

  // Broadest fallback — recursive search
  if (!wasmPath) {
    core.info('Doing recursive WASM search under target/…');
    const targetDir = path.join(manifestDir, 'target');
    const allWasms = findFiles(targetDir, '.wasm')
      .filter(f => f.includes('wasm32-unknown-unknown') && f.includes('release') && !f.includes('/deps/'));
    if (allWasms.length > 0) {
      allWasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
      wasmPath = allWasms[0];
    }
  }

  if (!wasmPath) {
    throw new Error(
      'Could not locate compiled WASM file. Searched:\n' +
      searchRoots.map(r => `  ${r}`).join('\n')
    );
  }

  core.info(`Found WASM at: ${wasmPath}`);
  core.endGroup();

  return { ...inputs, wasmPath, manifestPath, manifestDir, packageName };
}

// ─── Step 3: Check size against limits ───────────────────────────────────────

function stepCheckSize(state) {
  core.startGroup('Step 3 — Check WASM size against limits');

  const { wasmPath, wasmSizeLimitBytes, warningThresholdPercent } = state;

  const stat = fs.statSync(wasmPath);
  const wasmSizeBytes = stat.size;
  const wasmSizeKb = wasmSizeBytes / 1024;
  const usagePercent = (wasmSizeBytes / wasmSizeLimitBytes) * 100;
  const nearHardLimitPercent = (wasmSizeBytes / config.NEAR_SIZE_LIMIT_BYTES) * 100;

  const warningThresholdBytes = (warningThresholdPercent / 100) * wasmSizeLimitBytes;
  const isOverLimit = wasmSizeBytes > wasmSizeLimitBytes;
  const isOverNearHardLimit = wasmSizeBytes > config.NEAR_SIZE_LIMIT_BYTES;
  const isOverWarningThreshold = wasmSizeBytes > warningThresholdBytes;

  core.info(`WASM file          : ${wasmPath}`);
  core.info(`WASM size          : ${formatBytes(wasmSizeBytes)} (${wasmSizeBytes.toLocaleString()} bytes)`);
  core.info(`Configured limit   : ${formatBytes(wasmSizeLimitBytes)}`);
  core.info(`NEAR hard limit    : ${formatBytes(config.NEAR_SIZE_LIMIT_BYTES)}`);
  core.info(`Usage (configured) : ${usagePercent.toFixed(2)}%`);
  core.info(`Usage (NEAR limit) : ${nearHardLimitPercent.toFixed(2)}%`);
  core.info(`Warning threshold  : ${warningThresholdPercent}% (${formatBytes(warningThresholdBytes)})`);

  let sizeStatus;
  if (isOverNearHardLimit) {
    sizeStatus = 'over_near_limit';
    core.error(
      `❌ WASM size (${formatBytes(wasmSizeBytes)}) exceeds NEAR protocol hard limit ` +
      `(${formatBytes(config.NEAR_SIZE_LIMIT_BYTES)}). Deployment will FAIL.`
    );
  } else if (isOverLimit) {
    sizeStatus = 'over_configured_limit';
    core.error(
      `❌ WASM size (${formatBytes(wasmSizeBytes)}) exceeds configured limit ` +
      `(${formatBytes(wasmSizeLimitBytes)}).`
    );
  } else if (isOverWarningThreshold) {
    sizeStatus = 'warning';
    core.warning(
      `⚠️  WASM size (${formatBytes(wasmSizeBytes)}) is ${usagePercent.toFixed(1)}% of the ` +
      `configured limit. Warning threshold is ${warningThresholdPercent}%.`
    );
  } else {
    sizeStatus = 'ok';
    core.info(`✅ WASM size is within limits (${usagePercent.toFixed(1)}% of configured limit).`);
  }

  core.endGroup();

  return {
    ...state,
    wasmSizeBytes,
    wasmSizeKb,
    usagePercent,
    nearHardLimitPercent,
    isOverLimit,
    isOverNearHardLimit,
    isOverWarningThreshold,
    sizeStatus,
  };
}

// ─── Step 4: Compare with previous build (baseline) ─────────────────────────

function stepCompareBaseline(state) {
  core.startGroup('Step 4 — Compare with previous build baseline');

  const { baselineArtifact, wasmSizeBytes, wasmPath } = state;

  let baselineSizeBytes = null;
  let sizeDeltaBytes = null;
  let baselineSource = null;

  // --- Try to locate baseline WASM ---

  // Option A: baselineArtifact is a local file path
  if (baselineArtifact && fs.existsSync(baselineArtifact)) {
    const bStat = fs.statSync(baselineArtifact);
    baselineSizeBytes = bStat.size;
    baselineSource = `local file: ${baselineArtifact}`;
  }

  // Option B: baselineArtifact is an artifact name — try to download via gh cli
  if (baselineArtifact && baselineSizeBytes === null) {
    core.info(`Attempting to download artifact "${baselineArtifact}" via GitHub CLI…`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'near-baseline-'));
    const dlResult = exec(
      `gh artifact download "${baselineArtifact}" --dir "${tmpDir}"`,
      { stdio: 'pipe' }
    );
    if (dlResult.ok) {
      const wasms = findFiles(tmpDir, '.wasm');
      if (wasms.length > 0) {
        wasms.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
        const bStat = fs.statSync(wasms[0]);
        baselineSizeBytes = bStat.size;
        baselineSource = `GitHub artifact "${baselineArtifact}" → ${wasms[0]}`;
      } else {
        core.warning(`Artifact "${baselineArtifact}" downloaded but no WASM files found in it.`);
      }
    } else {
      core.info(`Could not download artifact (gh cli may not be authenticated or artifact missing): ${dlResult.stderr}`);
    }
  }

  // Option C: Look for a saved baseline size file in common locations
  if (baselineSizeBytes === null) {
    const sizeFile = path.join(path.dirname(wasmPath), 'baseline_size.txt');
    const altSizeFile = path.join(process.cwd(), '.near-contract-size-baseline');
    for (const sf of [sizeFile, altSizeFile]) {
      if (fs.existsSync(sf)) {
        const raw = fs.readFileSync(sf, 'utf8').trim();
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) {
          baselineSizeBytes = parsed;
          baselineSource = `size file: ${sf}`;
          break;
        }
      }
    }
  }

  if (baselineSizeBytes !== null) {
    sizeDeltaBytes = wasmSizeBytes - baselineSizeBytes;
    const deltaSign = sizeDeltaBytes >= 0 ? '+' : '';
    core.info(`Baseline source    : ${baselineSource}`);
    core.info(`Baseline size      : ${formatBytes(baselineSizeBytes)}`);
    core.info(`Current size       : ${formatBytes(wasmSizeBytes)}`);
    core.info(`Size delta         : ${deltaSign}${formatBytes(Math.abs(sizeDeltaBytes))} (${deltaSign}${sizeDeltaBytes} bytes)`);

    if (sizeDeltaBytes > 0) {
      core.warning(`⚠️  Contract grew by ${formatBytes(sizeDeltaBytes)} compared to baseline.`);
    } else if (sizeDeltaBytes < 0) {
      core.info(`✅ Contract shrank by ${formatBytes(Math.abs(sizeDeltaBytes))} compared to baseline.`);
    } else {
      core.info('Contract size is identical to baseline.');
    }
  } else {
    core.info('No baseline available for comparison. Skipping delta analysis.');
    if (baselineArtifact) {
      core.warning(`baseline_artifact was specified ("${baselineArtifact}") but could not be resolved.`);
    }
  }

  core.endGroup();

  return { ...state, baselineSizeBytes, sizeDeltaBytes };
}

// ─── Step 5: Suggest optimizations ───────────────────────────────────────────

function stepSuggestOptimizations(state) {
  core.startGroup('Step 5 — Optimization suggestions');

  const {
    includeOptimizationSuggestions,
    wasmSizeBytes,
    wasmSizeLimitBytes,
    isOverWarningThreshold,
    isOverLimit,
    manifestPath,
  } = state;

  const suggestions = [];

  if (!includeOptimizationSuggestions) {
    core.info('Optimization suggestions disabled (optimization_suggestions=false).');
    core.endGroup();
    return { ...state, suggestions };
  }

  // Always perform analysis; emphasise if over threshold
  const cargoContent = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8')
    : '';

  // 1. wasm-opt
  suggestions.push({
    priority: 'high',
    title: 'Run wasm-opt for additional binary optimization',
    detail:
      'wasm-opt from binaryen can reduce WASM size by 10-30%. ' +
      'Run: `wasm-opt -Oz --output optimized.wasm contract.wasm`\n' +
      'Add to CI: `cargo install wasm-opt && wasm-opt -Oz -o contract.wasm contract.wasm`',
  });

  // 2. Cargo profile settings
  const hasOptLevel = cargoContent.includes('opt-level');
  const hasLto = cargoContent.includes('lto');
  const hasCodegen = cargoContent.includes('codegen-units');
  const hasPanic = cargoContent.includes('panic');

  if (!hasOptLevel || !hasLto || !hasCodegen || !hasPanic) {
    suggestions.push({
      priority: 'high',
      title: 'Optimize Cargo release profile in Cargo.toml',
      detail:
        'Add/verify these settings in [profile.release]:\n' +
        '```toml\n' +
        '[profile.release]\n' +
        'opt-level = "z"      #