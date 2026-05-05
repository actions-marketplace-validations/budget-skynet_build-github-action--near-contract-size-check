# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why This Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and gives developers early feedback with optimization suggestions.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | No | `.` |
| `max-size-kb` | Maximum allowed size in KB | No | `4096` |
| `warn-threshold-kb` | Warning threshold in KB | No | `3072` |
| `baseline-artifact` | Artifact name for size comparison | No | `""` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Final WASM size in kilobytes |
| `size-delta-kb` | Size change compared to baseline build |
| `status` | Result status: `ok`, `warn`, or `fail` |
| `suggestions` | Optimization tips if size is large |

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
          warn-threshold-kb: 3072
          baseline-artifact: contract-size-baseline

      - name: Print Size
        run: echo "Contract size ${{ steps.size-check.outputs.wasm-size-kb }} KB"

## Behavior

- **Pass**: Size is below the warning threshold
- **Warn**: Size exceeds `warn-threshold-kb` but is under `max-size-kb`
- **Fail**: Size exceeds `max-size-kb`

When size is large, the action suggests optimizations such as enabling LTO, removing unused dependencies, or using `wasm-opt`.