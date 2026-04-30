# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the build if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching size issues in CI prevents failed deployments and gives early feedback on binary bloat before it becomes a problem.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | No | `.` |
| `wasm-file` | Path to the compiled WASM file | No | Auto-detected |
| `max-size-kb` | Maximum allowed size in KB | No | `4096` |
| `warn-size-kb` | Size in KB to trigger a warning | No | `3500` |
| `build-command` | Command used to build the contract | No | `cargo build --target wasm32-unknown-unknown --release` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled WASM size in KB |
| `size-status` | Result status: `ok`, `warning`, or `exceeded` |
| `size-diff-kb` | Size difference compared to previous run |

## Usage

name: Contract Size Check

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check NEAR Contract Size
        uses: your-org/near-contract-size-check@v1
        with:
          contract-path: ./contracts/my-contract
          max-size-kb: 4096
          warn-size-kb: 3500

## Behavior

- **Passes** when WASM size is below `warn-size-kb`
- **Warns** when size is between `warn-size-kb` and `max-size-kb`
- **Fails** when size exceeds `max-size-kb`

When the check warns or fails, the action prints optimization suggestions such as enabling LTO, removing unused dependencies, or using `wasm-opt`.