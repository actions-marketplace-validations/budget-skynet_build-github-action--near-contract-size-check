async function buildContractWasm(contractDir) {
  core.startGroup('📦 Building NEAR contract WASM');

  const absoluteDir = path.resolve(contractDir);
  if (!fs.existsSync(absoluteDir)) {
    throw new Error(`contract_path '${absoluteDir}' does not exist.`);
  }
  const cargoToml = path.join(absoluteDir, 'Cargo.toml');
  if (!fs.existsSync(cargoToml)) {
    throw new Error(`No Cargo.toml found in '${absoluteDir}'.`);
  }

  // Parse the package name so we know what the wasm file will be called.
  const cargoContent = fs.readFileSync(cargoToml, 'utf8');
  const nameMatch = cargoContent.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (!nameMatch) {
    throw new Error(`Cannot determine package name from ${cargoToml}`);
  }
  const packageName = nameMatch[1].replace(/-/g, '_');

  let buildStdout = '';
  let buildStderr = '';

  const buildOptions = {
    cwd: absoluteDir,
    listeners: {
      stdout: (data) => { buildStdout += data.toString(); },
      stderr: (data) => { buildStderr += data.toString(); },
    },
  };

  // Install wasm32 target if not already present (idempotent).
  core.info('Ensuring wasm32-unknown-unknown target is installed …');
  await exec.exec('rustup', ['target', 'add', 'wasm32-unknown-unknown'], buildOptions);

  core.info(`Building ${packageName} …`);
  const exitCode = await exec.exec(
    'cargo',
    ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { ...buildOptions, ignoreReturnCode: true },
  );

  if (exitCode !== 0) {
    core.error('cargo build stderr:\n' + buildStderr);
    throw new Error(`cargo build failed with exit code ${exitCode}`);
  }

  // Canonical output path produced by cargo.
  const wasmPath = path.join(
    absoluteDir,
    'target',
    'wasm32-unknown-unknown',
    'release',
    `${packageName}.wasm`,
  );

  if (!fs.existsSync(wasmPath)) {
    // Fallback: search for any .wasm file under target/wasm32-unknown-unknown/release/
    const releaseDir = path.join(absoluteDir, 'target', 'wasm32-unknown-unknown', 'release');
    if (!fs.existsSync(releaseDir)) {
      throw new Error(`Expected release directory not found: ${releaseDir}`);
    }
    const wasmFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.wasm') && !f.endsWith('.d'));
    if (wasmFiles.length === 0) {
      throw new Error(`No .wasm file found in ${releaseDir} after successful build.`);
    }
    core.warning(`Expected ${packageName}.wasm but found: ${wasmFiles.join(', ')}. Using first match.`);
    const foundPath = path.join(releaseDir, wasmFiles[0]);
    core.info(`✅ WASM built successfully: ${foundPath}`);
    core.endGroup();
    return { wasmPath: foundPath, buildOutput: buildStdout + buildStderr };
  }

  core.info(`✅ WASM built successfully: ${wasmPath}`);
  core.endGroup();
  return { wasmPath, buildOutput: buildStdout + buildStderr };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Check size against limits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the WASM file size and evaluates it against the configured limit and
 * warning threshold.
 *
 * Returns an object:
 * {
 *   sizeBytes: number,
 *   sizeLimitBytes: number,
 *   warningThresholdBytes: number,
 *   sizePercentage: number,      // e.g. 72.3
 *   isOverLimit: boolean,
 *   isWarning: boolean,
 *   status: 'ok' | 'warning' | 'over_limit',
 * }
 */
function checkSizeAgainstLimits(wasmPath, sizeLimitBytes, warningThresholdPercent) {
  core.startGroup('📏 Checking WASM size against NEAR limits');

  const stats = fs.statSync(wasmPath);
  const sizeBytes = stats.size;
  const warningThresholdBytes = Math.floor((warningThresholdPercent / 100) * sizeLimitBytes);
  const sizePercentage = (sizeBytes / sizeLimitBytes) * 100;

  const sizeKb = (sizeBytes / 1024).toFixed(2);
  const limitKb = (sizeLimitBytes / 1024).toFixed(2);
  const warningKb = (warningThresholdBytes / 1024).toFixed(2);

  core.info(`Contract size : ${sizeBytes.toLocaleString()} bytes (${sizeKb} KB)`);
  core.info(`NEAR limit    : ${sizeLimitBytes.toLocaleString()} bytes (${limitKb} KB)`);
  core.info(`Warning at    : ${warningThresholdBytes.toLocaleString()} bytes (${warningKb} KB) — ${warningThresholdPercent}%`);
  core.info(`Usage         : ${sizePercentage.toFixed(2)}%`);

  const isOverLimit = sizeBytes > sizeLimitBytes;
  const isWarning   = !isOverLimit && sizeBytes >= warningThresholdBytes;
  const status      = isOverLimit ? 'over_limit' : isWarning ? 'warning' : 'ok';

  if (isOverLimit) {
    const excess = sizeBytes - sizeLimitBytes;
    core.error(
      `❌ Contract size exceeds NEAR limit by ${excess.toLocaleString()} bytes ` +
      `(${(excess / 1024).toFixed(2)} KB).`,
    );
  } else if (isWarning) {
    core.warning(
      `⚠️  Contract size is ${sizePercentage.toFixed(1)}% of the NEAR limit. ` +
      `Consider optimizing before approaching the ${sizeLimitBytes.toLocaleString()}-byte ceiling.`,
    );
  } else {
    core.info(`✅ Contract size is within safe limits (${sizePercentage.toFixed(1)}% used).`);
  }

  core.endGroup();
  return {
    sizeBytes,
    sizeLimitBytes,
    warningThresholdBytes,
    sizePercentage,
    isOverLimit,
    isWarning,
    status,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Compare with previous builds (baseline branch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempts to get the WASM size from the baseline branch by:
 *   1. Stashing current changes (non-destructive).
 *   2. Fetching + checking out the baseline branch.
 *   3. Building it in a temp directory.
 *   4. Returning to the original branch / restoring work-tree.
 *
 * If anything fails (branch doesn't exist, build fails, etc.) we log a warning
 * and return null so the pipeline continues.
 *
 * Returns { baselineSizeBytes: number, deltaBytes: number } or null.
 */
async function compareWithBaseline(contractDir, currentSizeBytes, compareBranch) {
  core.startGroup(`🔀 Comparing with baseline branch '${compareBranch}'`);

  // We work in a temp clone to avoid disturbing the working tree.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'near-size-baseline-'));
  core.info(`Using temp directory: ${tmpDir}`);

  let baselineSizeBytes = null;

  try {
    // Get the remote URL so we can do a shallow clone.
    let remoteUrl = '';
    await exec.exec('git', ['remote', 'get-url', 'origin'], {
      listeners: { stdout: (d) => { remoteUrl += d.toString(); } },
      ignoreReturnCode: true,
    });
    remoteUrl = remoteUrl.trim();

    if (!remoteUrl) {
      core.warning('Could not determine git remote URL — skipping baseline comparison.');
      core.endGroup();
      return null;
    }

    // Shallow clone of only the baseline branch.
    core.info(`Cloning branch '${compareBranch}' …`);
    const cloneCode = await exec.exec(
      'git',
      ['clone', '--depth', '1', '--branch', compareBranch, remoteUrl, tmpDir],
      { ignoreReturnCode: true },
    );

    if (cloneCode !== 0) {
      core.warning(`Branch '${compareBranch}' could not be cloned — skipping baseline comparison.`);
      core.endGroup();
      return null;
    }

    // Determine the relative path from the repo root to contract_path.
    let repoRoot = '';
    await exec.exec('git', ['rev-parse', '--show-toplevel'], {
      listeners: { stdout: (d) => { repoRoot += d.toString(); } },
    });
    repoRoot = repoRoot.trim();

    const relativeContractPath = path.relative(repoRoot, path.resolve(contractDir));
    const baselineContractDir  = path.join(tmpDir, relativeContractPath);

    if (!fs.existsSync(baselineContractDir)) {
      core.warning(
        `Contract path '${relativeContractPath}' does not exist on branch '${compareBranch}'. ` +
        'Skipping baseline comparison.',
      );
      core.endGroup();
      return null;
    }

    // Build the baseline.
    core.info(`Building baseline contract in ${baselineContractDir} …`);
    const { wasmPath: baselineWasmPath } = await buildContractWasm(baselineContractDir);
    const baselineStats = fs.statSync(baselineWasmPath);
    baselineSizeBytes = baselineStats.size;

  } catch (err) {
    core.warning(`Baseline comparison failed: ${err.message} — continuing without delta.`);
    core.endGroup();
    return null;
  } finally {
    // Always clean up the temp clone.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  const deltaBytes = currentSizeBytes - baselineSizeBytes;
  const deltaKb    = (Math.abs(deltaBytes) / 1024).toFixed(2);
  const sign       = deltaBytes > 0 ? '+' : deltaBytes < 0 ? '-' : '±';

  core.info(`Baseline size : ${baselineSizeBytes.toLocaleString()} bytes`);
  core.info(`Current size  : ${currentSizeBytes.toLocaleString()} bytes`);
  core.info(`Delta         : ${sign}${Math.abs(deltaBytes).toLocaleString()} bytes (${sign}${deltaKb} KB)`);

  if (deltaBytes > 0) {
    core.warning(`⚠️  Contract grew by ${Math.abs(deltaBytes).toLocaleString()} bytes vs '${compareBranch}'.`);
  } else if (deltaBytes < 0) {
    core.info(`✅ Contract shrank by ${Math.abs(deltaBytes).toLocaleString()} bytes vs '${compareBranch}'.`);
  } else {
    core.info(`✅ No size change vs '${compareBranch}'.`);
  }

  core.endGroup();
  return { baselineSizeBytes, deltaBytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Suggest optimizations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyses the WASM binary to produce concrete, actionable optimization
 * suggestions based on the contract's actual size and percentage usage.
 *
 * Returns a formatted string report.
 */
async function suggestOptimizations(wasmPath, sizeBytes, sizeLimitBytes, sizePercentage, contractDir) {
  core.startGroup('💡 Generating optimization suggestions');

  const suggestions = [];

  // ── 1. wasm-opt ────────────────────────────────────────────────────────────
  suggestions.push({
    priority: 'HIGH',
    title: 'Run wasm-opt (Binaryen)',
    description:
      'wasm-opt -Oz often reduces WASM size by 10–30%.\n' +
      '  cargo install wasm-opt\n' +
      `  wasm-opt -Oz ${wasmPath} -o ${wasmPath}`,
  });

  // ── 2. Cargo.toml profile settings ─────────────────────────────────────────
  const cargoToml = path.join(path.resolve(contractDir), 'Cargo.toml');
  const cargoContent = fs.existsSync(cargoToml) ? fs.readFileSync(cargoToml, 'utf8') : '';
  const hasLtoFat    = /lto\s*=\s*true|lto\s*=\s*"fat"/i.test(cargoContent);
  const hasOpt3      = /opt-level\s*=\s*3/.test(cargoContent);
  const hasPanic     = /panic\s*=\s*"abort"/.test(cargoContent);

  if (!hasLtoFat) {
    suggestions.push({
      priority: 'HIGH',
      title: 'Enable Link-Time Optimisation (LTO)',
      description:
        'Add to Cargo.toml under [profile.release]:\n' +
        '  lto = true\n' +
        'LTO allows the linker to dead-strip unused code across crates.',
    });
  }
  if (!hasOpt3) {
    suggestions.push({
      priority: 'MEDIUM',
      title: 'Set opt-level = "z" (size-optimised)',
      description:
        'Add to Cargo.toml under [profile.release]:\n' +
        '  opt-level = "z"\n' +
        '"z" aggressively optimises for size; "s" is a lighter alternative.',
    });
  }
  if (!hasPanic) {
    suggestions.push({
      priority: 'MEDIUM',
      title: 'Set panic = "abort"',
      description:
        'Add to Cargo.toml under [profile.release]:\n' +
        '  panic = "abort"\n' +
        'Removes the panic unwinding machinery, saving several KB.',
    });
  }

  // ── 3. codegen-units ───────────────────────────────────────────────────────
  if (!/codegen-units\s*=\s*1/.test(cargoContent)) {
    suggestions.push({
      priority: 'MEDIUM',
      title: 'Set codegen-units = 1',
      description:
        'Add to Cargo.toml under [profile.release]:\n' +
        '  codegen-units = 1\n' +
        'A single codegen unit enables better inlining and dead-code removal.',
    });
  }

  // ── 4. Dependency audit ─────────────────────────────────────────────────────
  suggestions.push({
    priority: 'MEDIUM',
    title: 'Audit dependencies for size',
    description:
      'Run: cargo bloat --release --target wasm32-unknown-unknown -n 20\n' +
      'Identify the largest contributors and replace or feature-gate them.\n' +
      'Common culprits: serde_json (use near-sdk built-ins), regex, chrono.',
  });

  // ── 5. near-sdk features ────────────────────────────────────────────────────
  suggestions.push({
    priority: 'MEDIUM',
    title: 'Disable unused near-sdk features',
    description:
      'Example: near-sdk = { version = "5", default-features = false, features = ["legacy"] }\n' +
      'Only enable the feature flags your contract actually uses.',
  });

  // ── 6. twiggy / wasm-snip for dead code ─────────────────────────────────
  suggestions.push({
    priority: 'LOW',
    title: 'Remove dead code with wasm-snip',
    description:
      'cargo install wasm-snip\n' +
      `wasm-snip --snip-rust-panicking-code ${wasmPath} -o ${wasmPath}\n` +
      'Replaces unreachable functions with a single `unreachable` instruction.',
  });

  // ── 7. Strip debug sections ─────────────────────────────────────────────
  suggestions.push({
    priority: 'LOW',
    title: 'Strip debug sections',
    description:
      'Add to Cargo.toml under [profile.release]:\n' +
      '  debug = false\n' +
      '  strip = "debuginfo"\n' +
      'Removes DWARF debug information from the binary.',
  });

  // ── 8. Contract architecture ─────────────────────────────────────────────
  if (sizePercentage > 60) {
    suggestions.push({
      priority: 'HIGH',
      title: 'Consider splitting into multiple contracts',
      description:
        `At ${sizePercentage.toFixed(1)}% of the NEAR limit, consider a factory/component pattern.\n` +
        'Split business logic across multiple smaller contracts that call each other via cross-contract calls.',
    });
  }

  // ── Format report ───────────────────────────────────────────────────────────
  const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const lines = [
    '═══════════════════════════════════════════════════════════',
    '  NEAR CONTRACT SIZE OPTIMIZATION REPORT',
    '═══════════════════════════════════════════════════════════',
    `  Current size  : ${sizeBytes.toLocaleString()} bytes (${(sizeBytes / 1024).toFixed(2)} KB)`,
    `  NEAR limit    : ${sizeLimitBytes.toLocaleString()} bytes (${(sizeLimitBytes / 1024).toFixed(2)} KB)`,
    `  Usage         : ${sizePercentage.toFixed(2)}%`,
    '',
    `  ${suggestions.length} optimization suggestion(s):`,
    '───────────────────────────────────────────────────────────',
  ];

  suggestions.forEach((s, i) => {
    lines.push(`  [${String(i + 1).padStart(2)}] [${s.priority.padEnd(6)}] ${s.title}`);
    s.description.split('\n').forEach(line => lines.push(`         ${line}`));
    lines.push('');
  });

  lines.push('═══════════════════════════════════════════════════════════');

  const report = lines.join('\n');
  core.info(report);
  core.endGroup();
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Post a rich summary (GitHub Step Summary + PR comment)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes a formatted Markdown summary to $GITHUB_STEP_SUMMARY and, when
 * running in a pull-request context, posts or updates a PR comment via the
 * GitHub REST API.
 */
async function postSummary(params) {
  const {
    wasmPath, sizeBytes, sizeLimitBytes, sizePercentage, status,
    deltaBytes, baselineSizeBytes, compareBranch,
    optimizationReport, isOverLimit, isWarning,
  } = params;

  core.startGroup('📊 Posting size report summary');

  const statusEmoji = isOverLimit ? '❌' :