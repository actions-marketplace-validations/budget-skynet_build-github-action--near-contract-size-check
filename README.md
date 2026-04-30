# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the build if the contract exceeds the maximum size and warns when approaching the threshold.

## Why This Matters

NEAR enforces a 4MB contract size limit. Catching size issues in CI prevents failed deployments and gives developers early feedback with optimization suggestions.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | No | `.` |
| `warn-threshold-kb` | Warn when size exceeds this value (KB) | No | `3072` |
| `max-size-kb` | Fail when size exceeds this value (KB) | No | `4096` |
| `previous-size-file` | Path to file storing previous build size | No | `.contract-size` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled WASM size in kilobytes |
| `size-diff-kb` | Size difference compared to previous build |
| `status` | Result status: `ok`, `warn`, or `fail` |
| `optimizations` | Suggested optimizations if size is high |

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
          warn-threshold-kb: 3072
          max-size-kb: 4096
          previous-size-file: .cache/contract-size

## Behavior

- **Pass** — Size is under the warn threshold
- **Warn** — Size is between warn threshold and max limit; posts a PR comment with optimization tips
- **Fail** — Size exceeds max limit; blocks merge

## Optimization Suggestions

When size is high the action recommends:

- Enable `opt-level = "z"` in `Cargo.toml`
- Remove unused dependencies
- Use `wasm-opt` post-processing