# NEAR Contract Size Check

Automatically builds your NEAR smart contract and validates the WASM binary size against deployment limits, preventing size-related failures before they reach production.

## Why This Matters

NEAR enforces a 4MB contract size limit. This action catches bloated contracts in CI, compares sizes across builds, and suggests optimizations before deployment fails.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `contract-path` | Yes | `.` | Path to the contract directory |
| `warn-threshold-kb` | No | `3584` | Warning threshold in KB (default: 3.5MB) |
| `fail-threshold-kb` | No | `4096` | Hard limit in KB before action fails |
| `optimize` | No | `true` | Run `wasm-opt` before size check |
| `working-directory` | No | `.` | Root directory for the build |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Final WASM size in kilobytes |
| `wasm-path` | Path to the compiled WASM file |
| `size-status` | Result status: `ok`, `warning`, or `exceeded` |
| `size-diff-kb` | Size difference compared to previous build |

## Usage

name: Contract Size Check

on: [push, pull_request]

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check NEAR Contract Size
        uses: your-org/near-contract-size-check@v1
        with:
          contract-path: ./contracts/my-contract
          warn-threshold-kb: 3500
          fail-threshold-kb: 4096
          optimize: true

      - name: Print Size
        run: echo "Contract size ${{ steps.size-check.outputs.wasm-size-kb }}KB"

## Behavior

- **OK** — Size is below warn threshold, build passes
- **Warning** — Approaching limit, build passes with annotation
- **Exceeded** — Over fail threshold, build fails with optimization suggestions