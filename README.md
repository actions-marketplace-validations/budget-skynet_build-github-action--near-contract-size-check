# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the build if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Discovering an oversized contract at deployment wastes time and blocks releases. This action catches size issues early in CI.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | Yes | `.` |
| `wasm-path` | Path to compiled WASM file | No | Auto-detected |
| `max-size-kb` | Maximum allowed size in KB | No | `4096` |
| `warn-size-kb` | Warning threshold in KB | No | `3500` |
| `compare-baseline` | Compare size against previous build artifact | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled contract size in KB |
| `size-status` | `ok`, `warning`, or `exceeded` |
| `size-diff-kb` | Size difference from baseline build |

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
          max-size-kb: 4096
          warn-size-kb: 3500
          compare-baseline: true

## Behavior

- **OK** — Size is below the warning threshold
- **Warning** — Size is between `warn-size-kb` and `max-size-kb`; build passes with an annotation
- **Exceeded** — Size is above `max-size-kb`; build fails

## Optimization Tips

When the warning triggers, consider enabling `opt-level = "z"` in your `Cargo.toml`, removing unused dependencies, or using `wasm-opt` for additional compression.