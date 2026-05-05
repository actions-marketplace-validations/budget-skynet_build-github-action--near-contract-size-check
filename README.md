# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails CI if the contract exceeds the maximum size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Exceeding it causes deployment failures. This action catches size issues early in CI before they reach production.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `contract-path` | No | `.` | Path to the contract directory |
| `max-size-kb` | No | `4096` | Maximum allowed size in KB |
| `warn-threshold-percent` | No | `80` | Warn when size exceeds this % of max |
| `compare-base-branch` | No | `main` | Branch to compare size against |
| `fail-on-increase` | No | `false` | Fail if size increased vs base branch |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled WASM size in KB |
| `size-percent` | Percentage of limit used |
| `size-diff-kb` | Size difference vs base branch |
| `status` | `ok`, `warning`, or `exceeded` |

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
          compare-base-branch: main
          fail-on-increase: false

## Optimization Tips

When the action warns about size, consider:

- Enable `opt-level = "z"` in `Cargo.toml`
- Add `lto = true` under `[profile.release]`
- Remove unused dependencies
- Run `wasm-opt` with `-Oz` flag

## License

MIT