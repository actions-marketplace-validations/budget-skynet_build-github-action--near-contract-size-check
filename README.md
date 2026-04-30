# NEAR Contract Size Check

Builds your NEAR smart contract and checks the WASM binary size against protocol limits. Fails the workflow if the contract exceeds the maximum size and warns when approaching the threshold.

## Why It Matters

NEAR enforces a 4MB contract size limit. Catching oversized contracts in CI prevents failed deployments and gives developers early feedback on binary bloat.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `contract-path` | Yes | — | Path to the contract directory |
| `max-size-kb` | No | `4096` | Maximum allowed size in KB |
| `warn-threshold-percent` | No | `80` | Warn when size exceeds this % of limit |
| `compare-baseline` | No | `false` | Compare size against previous build artifact |
| `working-directory` | No | `.` | Root directory for the build |

## Outputs

| Name | Description |
|------|-------------|
| `wasm-size-kb` | Final WASM size in KB |
| `size-percent` | Percentage of the size limit used |
| `baseline-diff-kb` | Size change compared to previous build |
| `status` | Result: `ok`, `warning`, or `failed` |

## Usage

name: Contract Size Check

on: [push, pull_request]

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check NEAR contract size
        uses: your-org/near-contract-size-check@v1
        with:
          contract-path: ./contracts/my-contract
          max-size-kb: 4096
          warn-threshold-percent: 80
          compare-baseline: true

## Optimization Tips

When the action warns or fails, consider:

- Enable `opt-level = "z"` in `Cargo.toml`
- Add `wasm-opt` post-processing
- Remove unused dependencies
- Use `cargo bloat` to identify large code sections

## License

MIT