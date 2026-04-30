# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails CI if the contract exceeds the maximum size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and gives developers early feedback with optimization suggestions.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `contract-path` | No | `.` | Path to the contract directory |
| `max-size-kb` | No | `4096` | Maximum allowed size in KB |
| `warn-threshold-kb` | No | `3072` | Size in KB to trigger a warning |
| `baseline-artifact` | No | `""` | Artifact name for previous build comparison |

## Outputs

| Output | Description |
|--------|-------------|
| `size-kb` | Compiled WASM size in KB |
| `size-exceeded` | `true` if size exceeds the maximum limit |
| `size-warning` | `true` if size exceeds the warning threshold |
| `size-diff-kb` | Difference from baseline build in KB |

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
        run: echo "Contract size is ${{ steps.size-check.outputs.size-kb }} KB"

## Optimization Tips

When the action warns or fails, consider:

- Enable `wasm-opt` in `Cargo.toml`
- Remove unused dependencies
- Use `panic = "abort"` in release profile
- Strip debug symbols

## License

MIT