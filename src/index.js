const core = require('@actions/core');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

// ─── Helpers ────────────────────────────────────────────────────────────────

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
  });
}

function findWasmFiles(dir) {
  const results = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // skip node_modules, .git
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.wasm')) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function runCommand(command, cwd, label) {
  core.info(`▶ ${label}: ${command}`);
  const result = spawnSync(command, {
    cwd,
    shell: true,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env },
  });

  if (result.stdout) core.info(result.stdout);
  if (result.stderr) core.info(result.stderr); // cargo writes progress to stderr

  if (result.status !== 0) {
    const errMsg =
      result.stderr ||
      (result.error && result.error.message) ||
      `Command exited with code ${result.status}`;
    throw new Error(`${label} failed:\n${errMsg}`);
  }

  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}

function addSummaryTable(rows) {
  // rows: Array<{label, value}>
  const lines = rows.map((r) => `| ${r.label} | ${r.value} |`).join('\n');
  return `| Metric | Value |\n|--------|-------|\n${lines}`;
}

function generateOptimizationSuggestions(wasmPath, sizeBytes, limitBytes) {
  const suggestions = [];

  // Always useful suggestions
  suggestions.push(
    '**General WASM size reduction strategies:**',
    '- Add `opt-level = "z"` (optimize for size) in `[profile.release]` inside `Cargo.toml`',
    '- Add `lto = true` (Link-Time Optimization) in `[profile.release]`',
    '- Add `codegen-units = 1` in `[profile.release]` for better LTO',
    '- Add `panic = "abort"` in `[profile.release]` to remove panic unwinding',
    '- Strip symbols via `strip = true` (Rust ≥ 1.59) in `[profile.release]`',
    '',
    '**NEAR-specific optimizations:**',
    '- Run `wasm-opt -Oz --strip-debug --strip-producers -o output.wasm input.wasm` (from binaryen)',
    '- Use `near-sdk` with `wee_alloc` feature for a smaller allocator: `near-sdk = { features = ["wee_alloc"] }`',
    '- Avoid large dependencies; prefer `no_std` crates where possible',
    '- Remove unused contract methods',
    '- Use `#[allow(unused)]` and `cargo +nightly bloat` to audit large functions',
    '',
    '**Tooling:**',
    '- `cargo install cargo-bloat` → `cargo bloat --release --target wasm32-unknown-unknown -n 20` to find big functions',
    '- `cargo install twiggy` → `twiggy top target/wasm32-unknown-unknown/release/contract.wasm` for size profiling',
    '- `wasm-strip` from WABT to remove debug sections',
  );

  const usagePercent = (sizeBytes / limitBytes) * 100;
  if (usagePercent > 90) {
    suggestions.unshift(
      '⚠️ **Contract is critically large.** Consider splitting into multiple contracts or restructuring business logic.',
      '',
    );
  } else if (usagePercent > 75) {
    suggestions.unshift(
      '⚠️ **Contract is approaching the size limit.** Apply optimizations now to leave headroom for future growth.',
      '',
    );
  }

  return suggestions.join('\n');
}

// ─── Step 1: Build Contract WASM ────────────────────────────────────────────

async function stepBuildContract(contractPath, buildCommand) {
  core.startGroup('Step 1: Build Contract WASM');

  // Determine if contractPath is already a WASM file
  const isWasmFile =
    fs.existsSync(contractPath) &&
    fs.statSync(contractPath).isFile() &&
    contractPath.endsWith('.wasm');

  if (isWasmFile) {
    core.info(`Contract path is already a WASM file: ${contractPath}`);
    core.endGroup();
    return { wasmPath: contractPath, builtFromSource: false };
  }

  // contractPath is a source directory
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract path does not exist: ${contractPath}`);
  }

  const absContractPath = path.resolve(contractPath);
  core.info(`Building contract in: ${absContractPath}`);
  core.info(`Build command: ${buildCommand}`);

  runCommand(buildCommand, absContractPath, 'Build');

  // Locate produced WASM file(s)
  // Standard cargo output location
  const releaseDir = path.join(absContractPath, 'target', 'wasm32-unknown-unknown', 'release');
  let wasmFiles = [];

  if (fs.existsSync(releaseDir)) {
    wasmFiles = fs
      .readdirSync(releaseDir)
      .filter((f) => f.endsWith('.wasm') && !f.endsWith('.d.wasm'))
      .map((f) => path.join(releaseDir, f));
  }

  // Fallback: search entire target directory
  if (wasmFiles.length === 0) {
    const targetDir = path.join(absContractPath, 'target');
    if (fs.existsSync(targetDir)) {
      wasmFiles = findWasmFiles(targetDir).filter(
        (f) => f.includes('release') && !f.endsWith('.d.wasm'),
      );
    }
  }

  // Fallback: search entire contract directory
  if (wasmFiles.length === 0) {
    wasmFiles = findWasmFiles(absContractPath).filter((f) => !f.endsWith('.d.wasm'));
  }

  if (wasmFiles.length === 0) {
    throw new Error(
      `No WASM file found after build. Searched in ${absContractPath}. ` +
        `Ensure your build command produces a .wasm file.`,
    );
  }

  // Pick the largest WASM (most likely the main contract)
  wasmFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const wasmPath = wasmFiles[0];

  core.info(`Found WASM file: ${wasmPath}`);
  if (wasmFiles.length > 1) {
    core.info(`Other WASM files found (ignored):`);
    wasmFiles.slice(1).forEach((f) => core.info(`  ${f}`));
  }

  core.setOutput('wasm_path', wasmPath);
  core.endGroup();
  return { wasmPath, builtFromSource: true };
}

// ─── Step 2: Check Size Against Limits ──────────────────────────────────────

async function stepCheckSize(wasmPath, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('Step 2: Check Size Against Limits');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found: ${wasmPath}`);
  }

  const stats = fs.statSync(wasmPath);
  const sizeBytes = stats.size;
  const sizeKb = sizeBytes / 1024;
  const limitBytes = sizeLimitKb * 1024;
  const usagePercent = (sizeBytes / limitBytes) * 100;
  const warningThresholdBytes = limitBytes * (warningThresholdPercent / 100);

  core.info(`WASM file: ${wasmPath}`);
  core.info(`Contract size: ${humanSize(sizeBytes)} (${sizeBytes} bytes)`);
  core.info(`Size limit: ${humanSize(limitBytes)} (${limitBytes} bytes)`);
  core.info(`Usage: ${usagePercent.toFixed(2)}% of limit`);
  core.info(`Warning threshold: ${warningThresholdPercent}% (${humanSize(warningThresholdBytes)})`);

  // Set outputs
  core.setOutput('contract_size_bytes', sizeBytes.toString());
  core.setOutput('contract_size_kb', sizeKb.toFixed(2));
  core.setOutput('size_limit_kb', sizeLimitKb.toString());
  core.setOutput('usage_percent', usagePercent.toFixed(2));

  const overLimit = sizeBytes > limitBytes;
  const nearLimit = sizeBytes > warningThresholdBytes;

  core.setOutput('over_limit', overLimit.toString());
  core.setOutput('near_limit', nearLimit.toString());

  core.endGroup();
  return {
    sizeBytes,
    sizeKb,
    limitBytes,
    sizeLimitKb,
    usagePercent,
    warningThresholdBytes,
    warningThresholdPercent,
    overLimit,
    nearLimit,
  };
}

// ─── Step 3: Compare With Previous Build ────────────────────────────────────

async function stepCompareWithBaseline(wasmPath, baselineWasmUrl, currentSizeBytes) {
  core.startGroup('Step 3: Compare With Previous Build');

  let comparison = null;

  if (!baselineWasmUrl || baselineWasmUrl.trim() === '') {
    core.info('No baseline WASM provided, skipping comparison.');
    core.endGroup();
    return comparison;
  }

  const baselineUrl = baselineWasmUrl.trim();
  let baselinePath;

  try {
    if (baselineUrl.startsWith('http://') || baselineUrl.startsWith('https://')) {
      core.info(`Downloading baseline WASM from: ${baselineUrl}`);
      const tmpDir = os.tmpdir();
      baselinePath = path.join(tmpDir, `baseline_${Date.now()}.wasm`);
      await downloadFile(baselineUrl, baselinePath);
      core.info(`Baseline downloaded to: ${baselinePath}`);
    } else {
      // Treat as local file path
      baselinePath = path.resolve(baselineUrl);
      if (!fs.existsSync(baselinePath)) {
        core.warning(`Baseline WASM file not found at: ${baselinePath}. Skipping comparison.`);
        core.endGroup();
        return comparison;
      }
      core.info(`Using local baseline WASM: ${baselinePath}`);
    }

    const baselineSizeBytes = fs.statSync(baselinePath).size;
    const delta = currentSizeBytes - baselineSizeBytes;
    const deltaPercent = ((delta / baselineSizeBytes) * 100).toFixed(2);
    const increased = delta > 0;

    core.info(`Baseline size: ${humanSize(baselineSizeBytes)}`);
    core.info(`Current size:  ${humanSize(currentSizeBytes)}`);
    core.info(
      `Delta: ${increased ? '+' : ''}${humanSize(Math.abs(delta))} (${increased ? '+' : ''}${deltaPercent}%)`,
    );

    core.setOutput('baseline_size_bytes', baselineSizeBytes.toString());
    core.setOutput('size_delta_bytes', delta.toString());
    core.setOutput('size_delta_percent', deltaPercent);

    comparison = {
      baselineSizeBytes,
      delta,
      deltaPercent,
      increased,
    };

    if (increased && Math.abs(parseFloat(deltaPercent)) >= 5) {
      core.warning(
        `Contract grew by ${humanSize(Math.abs(delta))} (+${deltaPercent}%) compared to baseline!`,
      );
    } else if (!increased) {
      core.info(
        `✅ Contract shrank by ${humanSize(Math.abs(delta))} (${deltaPercent}%) vs baseline.`,
      );
    }

    // Clean up temp file if downloaded
    if (baselineUrl.startsWith('http://') || baselineUrl.startsWith('https://')) {
      try {
        fs.unlinkSync(baselinePath);
      } catch (_) {}
    }
  } catch (err) {
    core.warning(`Baseline comparison failed: ${err.message}`);
  }

  core.endGroup();
  return comparison;
}

// ─── Step 4: Suggest Optimizations ──────────────────────────────────────────

async function stepSuggestOptimizations(wasmPath, sizeBytes, limitBytes, nearLimit, overLimit) {
  core.startGroup('Step 4: Optimization Suggestions');

  if (!nearLimit && !overLimit) {
    core.info('✅ Contract size is well within limits. No optimizations urgently needed.');
    core.endGroup();
    return;
  }

  const suggestions = generateOptimizationSuggestions(wasmPath, sizeBytes, limitBytes);

  if (overLimit) {
    core.error('❌ Contract exceeds size limit! Optimizations required:');
  } else {
    core.warning('⚠️ Contract is approaching size limit. Consider these optimizations:');
  }

  // Print each suggestion line
  suggestions.split('\n').forEach((line) => {
    if (line.startsWith('⚠️') || line.startsWith('❌')) {
      core.warning(line);
    } else {
      core.info(line);
    }
  });

  core.setOutput('optimization_suggestions', suggestions);
  core.endGroup();
}

// ─── Step 5: Fail If Over Limit ─────────────────────────────────────────────

async function stepFailIfOverLimit(
  overLimit,
  nearLimit,
  sizeBytes,
  limitBytes,
  sizeLimitKb,
  warningThresholdPercent,
  usagePercent,
  comparison,
  failOnLimitExceeded,
) {
  core.startGroup('Step 5: Final Evaluation & Reporting');

  // Build summary
  const summaryRows = [
    { label: 'Contract Size', value: humanSize(sizeBytes) },
    { label: 'Size Limit', value: `${sizeLimitKb} KB (${humanSize(limitBytes)})` },
    { label: 'Usage', value: `${usagePercent.toFixed(2)}%` },
    { label: 'Warning Threshold', value: `${warningThresholdPercent}%` },
    { label: 'Status', value: overLimit ? '❌ OVER LIMIT' : nearLimit ? '⚠️ NEAR LIMIT' : '✅ OK' },
  ];

  if (comparison) {
    summaryRows.push(
      { label: 'Baseline Size', value: humanSize(comparison.baselineSizeBytes) },
      {
        label: 'Size Delta',
        value: `${comparison.increased ? '+' : ''}${humanSize(Math.abs(comparison.delta))} (${comparison.increased ? '+' : ''}${comparison.deltaPercent}%)`,
      },
    );
  }

  const table = addSummaryTable(summaryRows);

  // Write to GitHub Step Summary
  try {
    const summaryTitle = '## 📦 NEAR Contract Size Report\n\n';
    const summaryContent = summaryTitle + table + '\n';
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryContent);
    }
  } catch (err) {
    core.info(`Could not write step summary: ${err.message}`);
  }

  // Print summary to log
  core.info('\n=== NEAR Contract Size Report ===');
  summaryRows.forEach((r) => core.info(`  ${r.label}: ${r.value}`));
  core.info('=================================\n');

  if (overLimit) {
    const message =
      `❌ Contract size ${humanSize(sizeBytes)} exceeds limit of ${humanSize(limitBytes)} ` +
      `(${usagePercent.toFixed(2)}% of limit). ` +
      `Apply optimizations listed above to reduce WASM size.`;

    if (failOnLimitExceeded) {
      core.endGroup();
      core.setFailed(message);
      return;
    } else {
      core.error(message);
      core.warning('fail_on_limit_exceeded is set to false — continuing despite exceeding limit.');
    }
  } else if (nearLimit) {
    core.warning(
      `⚠️ Contract size ${humanSize(sizeBytes)} is at ${usagePercent.toFixed(2)}% of the ` +
        `${humanSize(limitBytes)} limit. Consider optimizing before you hit the limit.`,
    );
  } else {
    core.info(
      `✅ Contract size ${humanSize(sizeBytes)} is within the ${humanSize(limitBytes)} limit ` +
        `(${usagePercent.toFixed(2)}% used).`,
    );
  }

  core.endGroup();
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

async function run() {
  try {
    // ── Read Inputs ──────────────────────────────────────────────────────────
    const contractPath = core.getInput('contract_path', { required: true });
    const sizeLimitKb = parseFloat(core.getInput('size_limit_kb') || '4096');
    const warningThresholdPercent = parseFloat(
      core.getInput('warning_threshold_percent') || '80',
    );
    const baselineWasmUrl = core.getInput('baseline_wasm_url') || '';
    const buildCommand =
      core.getInput('build_command') ||
      'cargo build --target wasm32-unknown-unknown --release';
    const failOnLimitExceeded =
      (core.getInput('fail_on_limit_exceeded') || 'true').toLowerCase() !== 'false';

    // Validate numeric inputs
    if (isNaN(sizeLimitKb) || sizeLimitKb <= 0) {
      throw new Error(`Invalid size_limit_kb: "${core.getInput('size_limit_kb')}"`);
    }
    if (
      isNaN(warningThresholdPercent) ||
      warningThresholdPercent < 0 ||
      warningThresholdPercent > 100
    ) {
      throw new Error(
        `Invalid warning_threshold_percent: "${core.getInput('warning_threshold_percent')}"`,
      );
    }

    core.info('╔══════════════════════════════════════╗');
    core.info('║  NEAR Contract Size Check Action     ║');
    core.info('╚══════════════════════════════════════╝');
    core.info(`  contract_path:            ${contractPath}`);
    core.info(`  size_limit_kb:            ${sizeLimitKb} KB`);
    core.info(`  warning_threshold_percent: ${warningThresholdPercent}%`);
    core.info(`  baseline_wasm_url:         ${baselineWasmUrl || '(none)'}`);
    core.info(`  build_command:             ${buildCommand}`);
    core.info(`  fail_on_limit_exceeded:    ${failOnLimitExceeded}`);
    core.info('');

    // ── Step 1: Build ────────────────────────────────────────────────────────
    const { wasmPath } = await stepBuildContract(contractPath, buildCommand);

    // ── Step 2: Check Size ───────────────────────────────────────────────────
    const {
      sizeBytes,
      sizeKb,
      limitBytes,
      usagePercent,
      warningThresholdBytes,
      overLimit,
      nearLimit,
    } = await stepCheckSize(wasmPath, sizeLimitKb, warningThresholdPercent);

    // ── Step 3: Compare With Baseline ────────────────────────────────────────
    const comparison = await stepCompareWithBaseline(wasmPath, baselineWasmUrl, sizeBytes);

    // ── Step 4: Suggest Optimizations ────────────────────────────────────────
    await stepSuggestOptimizations(wasmPath, sizeBytes, limitBytes, nearLimit, overLimit);

    // ── Step 5: Fail If Over Limit ───────────────────────────────────────────
    await stepFailIfOverLimit(
      overLimit,
      nearLimit,
      sizeBytes,
      limitBytes,
      sizeLimitKb,
      warningThresholdPercent,
      usagePercent,
      comparison,
      failOnLimitExceeded,
    );
  } catch (err) {
    core.setFailed(`Action failed: ${err.message}`);
    if (err.stack) {
      core.debug(err.stack);
    }
  }
}

run();