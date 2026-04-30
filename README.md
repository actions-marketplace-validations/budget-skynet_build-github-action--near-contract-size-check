# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the build if the contract exceeds the maximum size and warns when approaching the threshold.

## Why This Matters

NEAR enforces a 4MB contract size limit. Discovering an oversized contract at deployment wastes time and blocks releases. This action catches size issues early in CI.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | Yes | `.` |
| `wasm-file` | Path to compiled WASM file | No | Auto-detected |
| `size-limit-kb` | Maximum allowed size in KB | No | `4096` |
| `warn-threshold-kb` | Warn when size exceeds this KB value | No | `3500` |
| `working-directory` | Directory to run build commands | No | `.` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled contract size in KB |
| `size-status` | Result status: `ok`, `warning`, or `failed` |
| `size-delta-kb` | Size change compared to previous run |
| `optimization-tips` | Suggestions when nearing the limit |

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
          size-limit-kb: 4096
          warn-threshold-kb: 3500

      - name: Print Size
        run: echo "Contract size ${{ steps.size-check.outputs.wasm-size-kb }} KB"

## Optimization Tips

When approaching the limit the action suggests:

- Enable `opt-level = 'z'` in `Cargo.toml`
- Run `wasm-opt` with `-Oz`
- Remove unused dependencies
- Enable link-time optimization

## License

MIT