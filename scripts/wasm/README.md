# rom-weaver WASM JavaScript APIs (Browser)

This folder contains ESM wrappers for browser execution of `rom-weaver-cli.wasm`.

## Files

- `rom-weaver-runtime-utils.mjs`: shared wasm import and JSON/trace parsing helpers
- `rom-weaver-browser-opfs-api.mjs`: browser OPFS + WASI `/work` runner
- `workers/browser-wasi-thread-worker.mjs`: browser WASI thread worker for `rom-weaver-cli-threaded.wasm`

## Runtime Requirements

- Secure-context Dedicated Worker runtime
- `rom-weaver-cli.wasm` artifact from `scripts/build-wasm-cli.sh`
- Browser support for OPFS + `FileSystemSyncAccessHandle`
- Cross-origin isolation and `SharedArrayBuffer` when using `rom-weaver-cli-threaded.wasm`
- `@bjorn3/browser_wasi_shim`

## Quick Use (Dedicated Worker)

```js
import { createRomWeaverBrowserOpfs } from './scripts/wasm/rom-weaver-browser-opfs-api.mjs';

const runner = await createRomWeaverBrowserOpfs({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

const result = await runner.runJson([
  'checksum',
  '/work/game.bin',
  '--algo',
  'crc32',
  '--no-extract',
]);

console.log(result.exitCode, result.ok);
```

## Notes

- WASI sees one preopened directory: `/work`.
- Browser picker handles/files should be copied into OPFS before calling `run()`.
- Known output paths passed by CLI flags are created in OPFS before `_start()` because WASI syscalls are synchronous.
- Dynamic files created during a run are flushed back to OPFS after `_start()` returns; arbitrary async browser filesystem access is still unavailable during WASI execution.
- Node.js, Electron, and Capacitor backends are intentionally out of scope for this browser wrapper.
