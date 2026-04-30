# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and gives early feedback during development.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `contract-path` | No | `.` | Path to the contract directory |
| `warn-threshold-kb` | No | `3500` | Warn when size exceeds this value (KB) |
| `max-size-kb` | No | `4096` | Fail when size exceeds this value (KB) |
| `suggest-optimizations` | No | `true` | Print optimization tips when size is large |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled WASM size in kilobytes |
| `wasm-path` | Path to the compiled WASM file |
| `size-status` | Result status: `ok`, `warn`, or `fail` |

## Usage

name: Contract Size Check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check NEAR contract size
        uses: your-org/near-contract-size-check@v1
        with:
          contract-path: ./contracts/my-contract
          warn-threshold-kb: 3500
          max-size-kb: 4096
          suggest-optimizations: true

## Optimization Tips

When size warnings appear, the action suggests:

- Enable `opt-level = "z"` in `Cargo.toml`
- Run `wasm-opt` with `-Oz` flag
- Remove unused dependencies
- Enable link-time optimization (`lto = true`)

## Requirements

- Rust toolchain with `wasm32-unknown-unknown` target
- `cargo` available in the runner environment