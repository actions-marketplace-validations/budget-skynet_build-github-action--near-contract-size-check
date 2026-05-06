# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and surfaces optimization opportunities early.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | No | `.` |
| `warn-threshold-kb` | Warn when size exceeds this value (KB) | No | `3500` |
| `max-size-kb` | Fail when size exceeds this value (KB) | No | `4096` |
| `baseline-branch` | Branch to compare size against | No | `main` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Final WASM size in kilobytes |
| `size-delta-kb` | Size change compared to baseline branch |
| `status` | Result: `ok`, `warning`, or `failed` |

## Usage

name: Contract Size Check

on: [push, pull_request]

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check NEAR contract size
        uses: your-org/near-contract-size-check@v1
        with:
          contract-path: ./contract
          warn-threshold-kb: 3500
          max-size-kb: 4096
          baseline-branch: main

## What It Does

1. Installs the Rust WASM toolchain
2. Builds the contract with `cargo build --target wasm32-unknown-unknown --release`
3. Measures the output WASM binary size
4. Compares against the baseline branch if available
5. Posts a summary with size delta to the workflow log
6. Exits with an error if the limit is exceeded

## Optimization Tips

When the warning threshold is hit, the action suggests running `wasm-opt` or enabling `lto = true` in your `Cargo.toml` release profile.