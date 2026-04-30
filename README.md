# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why This Matters

NEAR enforces a 4MB contract size limit. Discovering oversized contracts at deployment time wastes time and blocks releases. This action catches size issues early in CI.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | Yes | `.` |
| `wasm-path` | Path to the compiled WASM file | No | Auto-detected |
| `max-size-kb` | Maximum allowed size in KB | No | `4096` |
| `warn-size-kb` | Warning threshold in KB | No | `3500` |
| `build-command` | Command to build the contract | No | `cargo build --target wasm32-unknown-unknown --release` |

## Outputs

| Output | Description |
|--------|-------------|
| `size-kb` | Compiled contract size in KB |
| `size-bytes` | Compiled contract size in bytes |
| `status` | Result status: `ok`, `warning`, or `failed` |
| `delta-kb` | Size change compared to previous build |

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
          contract-path: ./contract
          max-size-kb: 4096
          warn-size-kb: 3500

## Optimization Tips

When the action reports a warning or failure, consider:

- Running `wasm-opt` with `-Oz` flag
- Enabling `strip` in your release profile
- Removing unused dependencies
- Enabling link-time optimization (`lto = true`)

## License

MIT