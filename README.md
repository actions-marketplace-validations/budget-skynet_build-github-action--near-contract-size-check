# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and gives early feedback on binary bloat.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `contract-path` | Yes | — | Path to the contract directory |
| `max-size-kb` | No | `4096` | Maximum allowed WASM size in KB |
| `warn-threshold-percent` | No | `80` | Warn when size exceeds this % of max |
| `compare-branch` | No | `main` | Branch to compare size against |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Built WASM size in KB |
| `size-percent` | Percentage of maximum size used |
| `size-diff-kb` | Size difference vs compare branch |
| `status` | `ok`, `warning`, or `failed` |

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
          warn-threshold-percent: 80
          compare-branch: main

## Behavior

- **Passes** when WASM size is below the warn threshold
- **Warns** when size exceeds the threshold percentage but stays under the limit
- **Fails** when size exceeds `max-size-kb`

## Optimization Tips

When the action warns or fails, consider:
- Enabling `opt-level = "z"` in `Cargo.toml`
- Running `wasm-opt` with `-Oz`
- Removing unused dependencies