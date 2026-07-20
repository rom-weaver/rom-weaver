# rom-weaver WASM JavaScript APIs (Browser)

This folder contains ESM wrappers for browser execution of `rom-weaver-app.wasm`.

<!-- START doctoc -->
## Table of contents

- [Files](#files)
- [Runtime Requirements](#runtime-requirements)
- [Quick Use (Dedicated Worker)](#quick-use-dedicated-worker)
- [Notes](#notes)
- [Browser Benchmark Wrapper](#browser-benchmark-wrapper)

<!-- END doctoc -->

## Files

- `rom-weaver-runtime-utils.mjs`: shared WASM environment imports

The browser OPFS + WASI `/work` runner and the WASI thread worker now live only as TypeScript
in the webapp package's wasm layer (`packages/rom-weaver-webapp/src/wasm/rom-weaver-browser-opfs-api.ts`
and `src/workers/browser-wasi-thread-worker.ts`); import them from the package rather than from
forked `.mjs` copies.

## Runtime Requirements

- Secure-context Dedicated Worker runtime
- `rom-weaver-app.wasm` artifact from `mise run build-wasm`
- Browser support for OPFS + `FileSystemSyncAccessHandle`
- Cross-origin isolation and `SharedArrayBuffer` when using `rom-weaver-app.wasm`
- `@bjorn3/browser_wasi_shim`

## Quick Use (Dedicated Worker)

```js
import { createRomWeaverBrowserOpfs } from './src/wasm/rom-weaver-browser-opfs-api.ts';

const runner = await createRomWeaverBrowserOpfs({
  wasmUrl: '/wasm/rom-weaver-app.wasm',
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

const result = await runner.runJson({
  type: 'checksum',
  args: {
    source: '/work/game.bin',
    algo: ['crc32'],
    no_extract: true,
  },
});

console.log(result.exitCode, result.ok);
```

## Notes

- WASI sees one preopened directory: `/work`.
- Browser picker handles/files should be copied into OPFS before calling `run()`.
- Known output paths from typed commands are created in OPFS before `_start()` because WASI syscalls are synchronous.
- Dynamic files created during a run are flushed back to OPFS after `_start()` returns; arbitrary async browser filesystem access is still unavailable during WASI execution.
- Node.js, Electron, and Capacitor backends are intentionally out of scope for this browser wrapper.

## Browser Benchmark Wrapper

For smoke runs that need real browser wasm execution, use:

```bash
node scripts/wasm/run-browser-cli.mjs --wasm-module packages/rom-weaver-webapp/src/wasm/rom-weaver-app.wasm -- checksum /path/to/input.bin --algo crc32 --no-extract
```

`scripts/bench-command-paths.py` can route `rom-weaver-wasm` cases through this wrapper with:

```bash
python3 scripts/bench-command-paths.py ... --archive-tools rom-weaver-wasm --wasm-runner scripts/wasm/run-browser-cli.mjs
```

This wrapper starts Vite and Chromium per command, so it is not the parity timing harness. Use the Vitest browser benchmark suites for OPFS timings; they cache 128 MiB fixtures in OPFS and time only worker commands against `/work` guest paths.
