# NEAR Contract Size Check

Builds your NEAR smart contract and validates the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Discovering oversized contracts during CI prevents failed deployments and wasted gas fees.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `contract-path` | Yes | — | Path to the contract directory |
| `max-size-kb` | No | `4096` | Maximum allowed size in KB |
| `warn-threshold-percent` | No | `80` | Warn when size exceeds this % of max |
| `compare-baseline` | No | `false` | Compare size against previous build artifact |
| `working-directory` | No | `.` | Root directory for build commands |

## Outputs

| Name | Description |
|------|-------------|
| `wasm-size-kb` | Compiled WASM size in KB |
| `size-percent` | Percentage of the maximum limit used |
| `baseline-diff-kb` | Size difference from previous build (if enabled) |
| `optimization-hints` | Suggested optimizations if size exceeds warning threshold |

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
          compare-baseline: true

## Behavior

- **Pass** — contract is within the allowed limit
- **Warn** — contract exceeds the warning threshold percentage
- **Fail** — contract exceeds `max-size-kb`

When size warnings trigger, the action surfaces optimization hints such as enabling `wasm-opt`, removing unused dependencies, or enabling link-time optimization in `Cargo.toml`.