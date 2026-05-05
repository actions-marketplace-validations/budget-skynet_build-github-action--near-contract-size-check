async function execCapture(cmd, args = [], options = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await exec.exec(cmd, args, {
    ...options,
    silent: options.silent !== false,
    listeners: {
      stdout: (data) => { stdout += data.toString(); },
      stderr: (data) => { stderr += data.toString(); },
    },
  });
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

// ---------------------------------------------------------------------------
// Utility – pretty-print bytes
// ---------------------------------------------------------------------------
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// STEP 1 – Resolve contract path and find / build WASM
// ---------------------------------------------------------------------------
async function stepBuildContract(contractPath) {
  core.startGroup('Step 1 – Build / locate contract WASM');

  const resolved = path.resolve(contractPath);
  core.info(`Contract path resolved: ${resolved}`);

  // If it's already a .wasm file, skip building
  if (resolved.endsWith('.wasm') && fs.existsSync(resolved)) {
    core.info('Provided path is a WASM file – skipping build step.');
    core.endGroup();
    return resolved;
  }

  // Determine if it's a Rust project
  const cargoToml = path.join(resolved, 'Cargo.toml');
  const isRust = fs.existsSync(cargoToml);

  if (isRust) {
    core.info('Detected Rust/Cargo project – building WASM...');

    // Ensure wasm target is installed
    try {
      await exec.exec('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
    } catch (e) {
      core.warning(`rustup target add failed (might already exist): ${e.message}`);
    }

    // Read Cargo.toml to get package name
    const cargoContent = fs.readFileSync(cargoToml, 'utf8');
    const nameMatch = cargoContent.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const packageName = nameMatch ? nameMatch[1].replace(/-/g, '_') : null;

    // Build release WASM
    await exec.exec('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'], {
      cwd: resolved,
    });

    // Locate WASM output
    const wasmDir = path.join(resolved, 'target', 'wasm32-unknown-unknown', 'release');
    if (!fs.existsSync(wasmDir)) {
      throw new Error(`Build output directory not found: ${wasmDir}`);
    }

    // Find the wasm file
    let wasmFile = null;
    if (packageName) {
      const candidate = path.join(wasmDir, `${packageName}.wasm`);
      if (fs.existsSync(candidate)) wasmFile = candidate;
    }

    if (!wasmFile) {
      const files = fs.readdirSync(wasmDir).filter((f) => f.endsWith('.wasm') && !f.includes('.d.'));
      if (files.length === 0) throw new Error('No WASM files found after build.');
      // Prefer the largest (most likely the contract, not deps)
      files.sort((a, b) => {
        const sA = fs.statSync(path.join(wasmDir, a)).size;
        const sB = fs.statSync(path.join(wasmDir, b)).size;
        return sB - sA;
      });
      wasmFile = path.join(wasmDir, files[0]);
    }

    core.info(`Built WASM: ${wasmFile}`);
    core.endGroup();
    return wasmFile;
  }

  // Try glob search for any .wasm file under the directory
  core.info('Not a Rust project – searching for pre-built WASM files...');
  const globber = await glob.create(path.join(resolved, '**/*.wasm'));
  const wasmFiles = await globber.glob();

  if (wasmFiles.length === 0) {
    throw new Error(
      `No WASM files found under "${resolved}". ` +
      'Provide a Cargo.toml project directory or a direct path to a .wasm file.'
    );
  }

  // Sort by size descending, take the largest
  wasmFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const wasmFile = wasmFiles[0];
  core.info(`Found WASM: ${wasmFile} (${wasmFiles.length} total)`);
  core.endGroup();
  return wasmFile;
}

// ---------------------------------------------------------------------------
// STEP 2 – Check size against limits
// ---------------------------------------------------------------------------
async function stepCheckSize(wasmFile, sizeLimitKb, warningThresholdPercent) {
  core.startGroup('Step 2 – Check contract size');

  if (!fs.existsSync(wasmFile)) {
    throw new Error(`WASM file not found: ${wasmFile}`);
  }

  const stats = fs.statSync(wasmFile);
  const sizeBytes = stats.size;
  const sizeKb = sizeBytes / 1024;

  const limitBytes = sizeLimitKb * 1024;
  const warningBytes = limitBytes * (warningThresholdPercent / 100);
  const percentUsed = (sizeBytes / limitBytes) * 100;

  core.info(`Contract WASM:     ${wasmFile}`);
  core.info(`Size:              ${fmtBytes(sizeBytes)} (${sizeKb.toFixed(2)} KB)`);
  core.info(`Size limit:        ${fmtBytes(limitBytes)} (${sizeLimitKb} KB)`);
  core.info(`Warning threshold: ${warningThresholdPercent}% = ${fmtBytes(warningBytes)}`);
  core.info(`Usage:             ${percentUsed.toFixed(1)}%`);

  // NEAR protocol hard limit check
  if (sizeKb > NEAR_HARD_LIMIT_KB) {
    core.error(
      `🚫 Contract size ${fmtBytes(sizeBytes)} exceeds NEAR protocol hard limit of ${NEAR_HARD_LIMIT_KB} KB!`
    );
  }

  const isOverLimit = sizeBytes > limitBytes;
  const isOverWarning = sizeBytes >= warningBytes && !isOverLimit;

  if (isOverLimit) {
    core.error(`❌ Contract size ${fmtBytes(sizeBytes)} exceeds the configured limit of ${fmtBytes(limitBytes)}`);
  } else if (isOverWarning) {
    core.warning(
      `⚠️ Contract size ${fmtBytes(sizeBytes)} is above ${warningThresholdPercent}% of the limit ` +
      `(${fmtBytes(limitBytes)}). Consider optimizing.`
    );
  } else {
    core.info(`✅ Contract size is within limits.`);
  }

  // Set outputs
  core.setOutput('contract_size_bytes', String(sizeBytes));
  core.setOutput('contract_size_kb', sizeKb.toFixed(2));
  core.setOutput('size_limit_kb', String(sizeLimitKb));
  core.setOutput('percent_of_limit', percentUsed.toFixed(1));
  core.setOutput('size_check_passed', String(!isOverLimit));

  core.endGroup();

  return {
    wasmFile,
    sizeBytes,
    sizeKb,
    limitBytes,
    limitKb: sizeLimitKb,
    warningBytes,
    warningThresholdPercent,
    percentUsed,
    isOverLimit,
    isOverWarning,
  };
}

// ---------------------------------------------------------------------------
// STEP 3 – Compare with previous builds (artifacts via GitHub API)
// ---------------------------------------------------------------------------
async function stepCompareWithPrevious(sizeInfo, token) {
  core.startGroup('Step 3 – Compare with previous builds');

  const { sizeBytes, wasmFile } = sizeInfo;
  const wasmName = path.basename(wasmFile);
  let previousSizeBytes = null;
  let delta = null;
  let deltaPercent = null;
  let trend = 'unknown';

  if (!token) {
    core.warning('No GITHUB_TOKEN provided – skipping artifact comparison.');
    core.endGroup();
    return { previousSizeBytes, delta, deltaPercent, trend };
  }

  try {
    const octokit = github.getOctokit(token);
    const { repo: { owner, repo }, runId } = github.context;

    // List artifacts from recent workflow runs
    core.info('Fetching recent workflow runs...');
    const { data: runsData } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      status: 'success',
      per_page: 10,
    });

    const runs = (runsData.workflow_runs || []).filter((r) => r.id !== runId);
    core.info(`Found ${runs.length} previous successful runs to search.`);

    for (const run of runs) {
      try {
        const { data: artifactsData } = await octokit.rest.actions.listWorkflowRunArtifacts({
          owner,
          repo,
          run_id: run.id,
        });

        const artifact = (artifactsData.artifacts || []).find(
          (a) => a.name === ARTIFACT_NAME && !a.expired
        );

        if (!artifact) continue;

        core.info(`Found size artifact in run #${run.run_number} (${run.created_at})`);

        // Download artifact zip
        const { data: zipData } = await octokit.rest.actions.downloadArtifact({
          owner,
          repo,
          artifact_id: artifact.id,
          archive_format: 'zip',
        });

        // Parse the zip to find the JSON size data
        // Since we can't use unzipper (external dep), we'll parse the zip buffer manually
        // using a lightweight approach
        const zipBuffer = Buffer.from(zipData);
        const sizeDataStr = extractJsonFromZip(zipBuffer);

        if (sizeDataStr) {
          const sizeData = JSON.parse(sizeDataStr);
          if (sizeData.sizeBytes && sizeData.wasmName === wasmName) {
            previousSizeBytes = sizeData.sizeBytes;
            break;
          }
        }
      } catch (artifactErr) {
        core.debug(`Error checking run ${run.id}: ${artifactErr.message}`);
      }
    }
  } catch (err) {
    core.warning(`Could not fetch previous size data: ${err.message}`);
  }

  // Also check local cache file as fallback
  if (previousSizeBytes === null) {
    const cacheFile = path.join(os.tmpdir(), SIZE_CACHE_FILE);
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cache.sizeBytes && cache.wasmName === path.basename(wasmFile)) {
          previousSizeBytes = cache.sizeBytes;
          core.info(`Using local cache for comparison: ${fmtBytes(previousSizeBytes)}`);
        }
      } catch (e) {
        core.debug(`Cache read error: ${e.message}`);
      }
    }
  }

  if (previousSizeBytes !== null) {
    delta = sizeBytes - previousSizeBytes;
    deltaPercent = previousSizeBytes > 0 ? (delta / previousSizeBytes) * 100 : 0;

    if (delta > 0) {
      trend = 'increasing';
      core.warning(
        `📈 Contract grew by ${fmtBytes(Math.abs(delta))} (+${deltaPercent.toFixed(1)}%) ` +
        `compared to previous build (${fmtBytes(previousSizeBytes)} → ${fmtBytes(sizeBytes)})`
      );
    } else if (delta < 0) {
      trend = 'decreasing';
      core.info(
        `📉 Contract shrank by ${fmtBytes(Math.abs(delta))} (${deltaPercent.toFixed(1)}%) ` +
        `compared to previous build (${fmtBytes(previousSizeBytes)} → ${fmtBytes(sizeBytes)})`
      );
    } else {
      trend = 'stable';
      core.info(`📊 Contract size unchanged from previous build (${fmtBytes(sizeBytes)})`);
    }
  } else {
    core.info('No previous size data found – this appears to be the first run.');
  }

  // Save current size data for next comparison
  const sizeRecord = {
    sizeBytes,
    sizeKb: sizeBytes / 1024,
    wasmName: path.basename(wasmFile),
    timestamp: new Date().toISOString(),
    runId: github.context.runId,
    sha: github.context.sha,
  };

  const tmpDir = path.join(os.tmpdir(), 'near-size-artifact');
  await io.mkdirP(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'size-data.json'), JSON.stringify(sizeRecord, null, 2));

  // Set outputs for comparison
  core.setOutput('previous_size_bytes', previousSizeBytes !== null ? String(previousSizeBytes) : '');
  core.setOutput('size_delta_bytes', delta !== null ? String(delta) : '');
  core.setOutput('size_trend', trend);

  core.endGroup();
  return { previousSizeBytes, delta, deltaPercent, trend, artifactDir: path.join(os.tmpdir(), 'near-size-artifact') };
}

// ---------------------------------------------------------------------------
// Minimal ZIP parser to extract first JSON file content
// ---------------------------------------------------------------------------
function extractJsonFromZip(buffer) {
  try {
    // ZIP local file header signature: PK\x03\x04
    let offset = 0;
    while (offset < buffer.length - 30) {
      if (
        buffer[offset] === 0x50 &&
        buffer[offset + 1] === 0x4b &&
        buffer[offset + 2] === 0x03 &&
        buffer[offset + 3] === 0x04
      ) {
        const compressionMethod = buffer.readUInt16LE(offset + 8);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const filenameLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const filename = buffer.slice(offset + 30, offset + 30 + filenameLen).toString('utf8');
        const dataOffset = offset + 30 + filenameLen + extraLen;

        if (filename.endsWith('.json') && compressionMethod === 0) {
          // Stored (no compression)
          return buffer.slice(dataOffset, dataOffset + compressedSize).toString('utf8');
        }

        offset = dataOffset + compressedSize;
      } else {
        offset++;
      }
    }
  } catch (e) {
    // Ignore parse errors
  }
  return null;
}

// ---------------------------------------------------------------------------
// STEP 4 – Suggest optimizations
// ---------------------------------------------------------------------------
async function stepSuggestOptimizations(sizeInfo, comparisonInfo) {
  core.startGroup('Step 4 – Optimization suggestions');

  const { sizeBytes, limitBytes, isOverLimit, isOverWarning, wasmFile } = sizeInfo;
  const { delta, trend } = comparisonInfo;

  const suggestions = [];

  // Always check if wasm-opt is available and run it for analysis
  let wasmOptAvailable = false;
  try {
    await io.which('wasm-opt', true);
    wasmOptAvailable = true;
  } catch (e) {
    core.info('wasm-opt not found in PATH – skipping wasm-opt analysis.');
  }

  let wasmOptSize = null;
  if (wasmOptAvailable) {
    try {
      const optimizedPath = wasmFile.replace('.wasm', '.opt.wasm');
      const { exitCode } = await execCapture('wasm-opt', [
        wasmFile,
        '-Oz',
        '--strip-debug',
        '--strip-producers',
        '-o',
        optimizedPath,
      ]);
      if (exitCode === 0 && fs.existsSync(optimizedPath)) {
        wasmOptSize = fs.statSync(optimizedPath).size;
        const saving = sizeBytes - wasmOptSize;
        const savingPct = ((saving / sizeBytes) * 100).toFixed(1);
        core.info(`wasm-opt (-Oz) result: ${fmtBytes(wasmOptSize)} (saves ${fmtBytes(saving)}, ${savingPct}%)`);
        core.setOutput('wasm_opt_size_bytes', String(wasmOptSize));

        if (saving > 0) {
          suggestions.push(
            `🔧 **Run wasm-opt -Oz**: Could save ~${fmtBytes(saving)} (${savingPct}%). ` +
            `Install binaryen and add wasm-opt to your build pipeline.`
          );
        }
        // Clean up optimized file
        fs.unlinkSync(optimizedPath);
      }
    } catch (e) {
      core.debug(`wasm-opt analysis failed: ${e.message}`);
    }
  } else {
    suggestions.push(
      '🔧 **Install wasm-opt (binaryen)**: Add `wasm-opt -Oz --strip-debug -o contract.wasm contract.wasm` ' +
      'to your build. Typically reduces WASM size by 20-40%.'
    );
  }

  // Check for debug symbols in WASM
  try {
    const wasmContent = fs.readFileSync(wasmFile);
    const wasmStr = wasmContent.toString('binary');
    const hasDebugSections = wasmStr.includes('.debug_') || wasmStr.includes('name section');
    if (hasDebugSections) {
      suggestions.push(
        '🐛 **Strip debug symbols**: Debug sections detected. Use `wasm-opt --strip-debug` or ' +
        'add `[profile.release]\ndebug = false` to Cargo.toml.'
      );
    }
  } catch (e) {
    core.debug(`Debug symbol check failed: ${e.message}`);
  }

  // Cargo.toml optimization suggestions
  const contractDir = path.dirname(wasmFile).replace(/[\\/]target[\\/].*/, '');
  const cargoToml = path.join(contractDir, 'Cargo.toml');
  if (fs.existsSync(cargoToml)) {
    const cargoContent = fs.readFileSync(cargoToml, 'utf8');

    if (!cargoContent.includes('[profile.release]')) {
      suggestions.push(
        '📦 **Add release profile to Cargo.toml**:\n