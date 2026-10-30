---
name: run-rom-weaver
description: Build and exercise the rom-weaver native CLI or browser webapp with the repository's smoke-test harnesses.
---

# Run rom-weaver

Use the committed harnesses to test the real CLI and webapp. Run all commands from the repository root unless a section says otherwise.

## Set up a clean checkout

Use the Node.js and Rust versions pinned in [`.config/mise.toml`](../../../.config/mise.toml). Install the system tools, including WASI SDK, from the [development guide](../../../docs/development/development.md#prerequisites). Then install dependencies and build the browser WASM artifact:

```bash
mise trust
mise install
npm ci
npm ci --prefix packages/rom-weaver-webapp
npm --prefix packages/rom-weaver-webapp exec playwright -- install chromium
mise run build-wasm
```

## Test the native CLI

Build the CLI, then run its smoke test:

```bash
cargo build -p rom-weaver-cli --release
.agents/skills/run-rom-weaver/cli-smoke.sh
```

The script uses `target/release/rom-weaver`, falls back to the debug binary, and accepts `RW_BIN=/path/to/rom-weaver` as an override. It checks extraction, checksums, compression, and an xdelta patch round trip against committed test fixtures.

For one-off commands, use each subcommand's named arguments:

```bash
target/release/rom-weaver checksum \
  --input tests/fixtures/vcdiff/secondary-source.bin --algo crc32
target/release/rom-weaver extract \
  --input packages/rom-weaver-webapp/tests/fixtures/archives/one-rom.zip \
  --output /tmp/rom-weaver-extract --checksum-rom crc32
target/release/rom-weaver patch apply \
  --input tests/fixtures/vcdiff/secondary-source.bin \
  --patch tests/fixtures/vcdiff/secondary-djw.xdelta \
  --output /tmp/rom-weaver-patched.bin --no-compress
```

## Test the webapp

Build the webapp, then start its HTTPS preview server from the webapp package:

```bash
cd packages/rom-weaver-webapp
npm run build
node scripts/dev-server.mjs preview --port 5191
```

In another shell, from the same package directory, run:

```bash
node ../../.agents/skills/run-rom-weaver/webapp-driver.mjs load
node ../../.agents/skills/run-rom-weaver/webapp-driver.mjs apply
```

Both commands open the Apply route (`apply-rom-patches`) under the server URL. `load` checks that the app starts and saves a screenshot. `apply` uploads the committed source and xdelta fixtures, runs **Apply & download**, and checks that a file was downloaded. Output goes to `/tmp/rw-driver/` by default.

Environment overrides:

- `RW_URL`: server base URL; default `https://localhost:5191/`
- `RW_OUT`: screenshot and download directory
- `RW_HEAD=1`: show the browser window

## Run the full regression gate

Run `mise run test-e2e-fast` from the repository root. It builds production WASM and the webapp once, checks the worker chunk guard, then runs the CLI, Chromium, WASM, and E2E suites against that one build. See [Run release regressions](../../../docs/development/reproduce-ci-locally.md#run-release-regressions) for coverage and the larger nightly matrix.

## Troubleshooting

- Missing Playwright package: run `npm ci --prefix packages/rom-weaver-webapp`.
- Missing WASM file: run `mise run build-wasm`.
- Browser startup timeout: confirm the server URL returns HTTP 200 with `curl -sk https://localhost:5191/ -o /dev/null -w '%{http_code}'`.
- CLI output-extension error: add `--no-compress` for a raw file, or use a supported compressed extension.
- Missing CLI binary: run `cargo build -p rom-weaver-cli --release`.
- Old behavior after a rebuild: restart the preview server. It caches `dist` for the whole session.

The bundled server supplies the COOP/COEP headers needed by `SharedArrayBuffer`. A plain static server does not reproduce the real runtime.
