# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the build if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Discovering an oversized contract during deployment wastes time and blocks releases. This action catches size issues early in CI, compares against previous builds, and suggests optimization steps.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | No | `.` |
| `max-size-kb` | Maximum allowed WASM size in KB | No | `4096` |
| `warn-threshold-kb` | Size in KB to trigger a warning | No | `3584` |
| `previous-size-kb` | Previous build size for comparison | No | `0` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Final WASM size in KB |
| `size-delta-kb` | Change in size compared to previous build |
| `status` | Result: `ok`, `warning`, or `failed` |

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
          warn-threshold-kb: 3500
          previous-size-kb: 3200

## Optimization Tips

When the action warns or fails, consider:

- Run `wasm-opt` with `-Oz` flag
- Enable `opt-level = "z"` in `Cargo.toml`
- Remove unused dependencies
- Enable LTO in your release profile

## License

MIT