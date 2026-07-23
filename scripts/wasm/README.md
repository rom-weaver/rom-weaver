# WASM scripts

This directory contains the scripts that build, check, compress, and exercise
`rom-weaver-app.wasm`. Run the public tasks from the repository root:

```bash
mise run wasm-check
mise run build-wasm
mise run build-wasm-prod
```

Use `run-browser-cli.mjs` when a smoke test must run in a real browser. It is a
developer tool, not a supported application API. Use the native Rust CLI for
command-line work.

The [development guide](../../docs/development.md#build-and-run-the-webapp)
explains the toolchain and build flow. The
[browser WASM runtime guide](../../packages/rom-weaver-wasm/src/README.md)
documents the TypeScript worker and OPFS APIs. Keeping those API examples in
one place prevents the build-script notes from drifting away from the runtime.

<!-- START doctoc -->
## Table of contents

- [Browser command wrapper](#browser-command-wrapper)

<!-- END doctoc -->

## Browser command wrapper

This example runs a checksum command through the real browser WASM runtime:

```bash
node scripts/wasm/run-browser-cli.mjs \
  --wasm-module packages/rom-weaver-wasm/src/rom-weaver-app.wasm \
  -- checksum /path/to/input.bin --algo crc32 --no-extract
```

The wrapper starts Vite and Chromium for each command, so it is useful for
smoke tests but not performance measurements. Use the Vitest browser benchmark
suites described in the browser WASM runtime guide for timing work.
