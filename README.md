# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and gives developers early feedback before pushing to mainnet.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `contract-path` | Yes | — | Path to the contract directory |
| `max-size-kb` | No | `4096` | Maximum allowed WASM size in KB |
| `warn-threshold-percent` | No | `80` | Warn when size exceeds this % of max |
| `compare-branch` | No | `main` | Branch to compare size against |
| `working-directory` | No | `.` | Root directory for the build |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled WASM size in KB |
| `size-percent` | Percentage of the maximum size used |
| `size-diff-kb` | Size difference compared to base branch |
| `status` | Result status: `ok`, `warn`, or `fail` |

## Usage

name: Contract Size Check

on:
  pull_request:
    branches: [main]

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

- **Fails** the job if WASM size exceeds `max-size-kb`
- **Warns** in the workflow log if size exceeds the warn threshold
- **Comments** on pull requests with size comparison and optimization suggestions
- Suggests running `wasm-opt` or enabling LTO if the contract is large