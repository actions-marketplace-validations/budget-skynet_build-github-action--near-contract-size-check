# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the build if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Discovering an oversized contract during deployment wastes time and breaks releases. This action catches size issues early in CI.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | Yes | `.` |
| `wasm-path` | Path to compiled WASM file | No | Auto-detected |
| `max-size-kb` | Maximum allowed size in KB | No | `4096` |
| `warn-size-kb` | Size threshold to trigger a warning | No | `3500` |
| `build-command` | Command used to build the contract | No | `cargo build --target wasm32-unknown-unknown --release` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled contract size in KB |
| `size-status` | `ok`, `warning`, or `exceeded` |
| `size-diff-kb` | Size difference compared to previous run |

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

      - name: Check NEAR Contract Size
        uses: your-org/near-contract-size-check@v1
        with:
          contract-path: ./contracts/my-contract
          max-size-kb: 4096
          warn-size-kb: 3500

## Behavior

- **Passes** when the contract is below the warning threshold
- **Warns** when the contract is between `warn-size-kb` and `max-size-kb`
- **Fails** when the contract exceeds `max-size-kb`

## Optimization Tips

When warned, consider enabling `wasm-opt`, removing unused dependencies, or enabling link-time optimization in your `Cargo.toml`.