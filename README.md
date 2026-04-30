# NEAR Contract Size Check

Builds your NEAR smart contract and validates the WASM binary size against protocol limits. Fails CI if the contract exceeds the maximum size and warns when approaching the threshold.

## Why This Matters

NEAR enforces a 4MB contract size limit. Catching bloated contracts in CI prevents failed deployments and encourages optimization early in development.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `contract-path` | Yes | — | Path to the contract directory |
| `max-size-kb` | No | `4096` | Maximum allowed WASM size in KB |
| `warn-threshold-percent` | No | `80` | Warn when size exceeds this % of max |
| `compare-baseline` | No | `false` | Compare size against previous build artifact |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Final WASM size in KB |
| `size-percent` | Percentage of the maximum limit used |
| `status` | Result: `ok`, `warning`, or `failed` |
| `size-diff-kb` | Size change compared to baseline build |

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

## Optimization Tips

When the action warns or fails, consider:

- Enable `opt-level = "z"` in `Cargo.toml`
- Add `lto = true` under `[profile.release]`
- Remove unused dependencies
- Run `wasm-opt -Oz` as a post-build step

## Requirements

- Rust toolchain with `wasm32-unknown-unknown` target
- `cargo` available on the runner