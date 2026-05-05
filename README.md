# NEAR Contract Size Check

Builds your NEAR smart contract and validates the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum allowed size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and gives early feedback on binary bloat before it becomes a problem.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `contract-path` | Path to the contract directory | No | `.` |
| `wasm-path` | Path to compiled WASM file | No | Auto-detected |
| `max-size-kb` | Maximum allowed size in KB | No | `4096` |
| `warn-threshold-percent` | Warn when size exceeds this % of limit | No | `80` |
| `working-directory` | Directory to run build commands | No | `.` |

## Outputs

| Output | Description |
|--------|-------------|
| `wasm-size-kb` | Compiled contract size in KB |
| `size-percent` | Percentage of the size limit used |
| `status` | Result: `ok`, `warning`, or `failed` |
| `optimization-tips` | Suggested steps to reduce binary size |

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

      - name: Print Size Result
        run: |
          echo "Size: ${{ steps.size-check.outputs.wasm-size-kb }} KB"
          echo "Status: ${{ steps.size-check.outputs.status }}"

## Optimization Tips

When the action detects an oversized contract it suggests:

- Enable `opt-level = "z"` in `Cargo.toml`
- Remove unused dependencies
- Enable `lto = true` and `codegen-units = 1`
- Strip debug symbols with `wasm-opt`