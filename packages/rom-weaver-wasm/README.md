# rom-weaver-wasm

JavaScript wrappers and WASM artifacts for browser `rom-weaver` execution.

## What You Get

- Browser OPFS runner (`createRomWeaverBrowserOpfs`) for Dedicated Workers
- Browser WASI thread support for `rom-weaver-cli-threaded.wasm` when cross-origin isolation enables `SharedArrayBuffer`
- Dedicated browser worker client (`createBrowserWorkerClient`)
- First-party TypeScript declarations

Node.js, Electron, and Capacitor filesystem backends are intentionally omitted from this package.
Use the native `rom-weaver` CLI directly for Node workflows.

## Import Paths

- `rom-weaver-wasm` (main entry)
- `rom-weaver-wasm/browser-opfs`
- `rom-weaver-wasm/workers/browser-client`
- `rom-weaver-wasm/workers/protocol`

## Browser OPFS Runner Example

`createRomWeaverBrowserOpfs` must run in a secure-context Dedicated Worker so it can use `FileSystemSyncAccessHandle`.
It is not a main-thread API and will throw when called from `window`.

```js
import { createRomWeaverBrowserOpfs } from 'rom-weaver-wasm/browser-opfs';

const runner = await createRomWeaverBrowserOpfs({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

const result = await runner.runJson(
  ['checksum', '/work/game.bin', '--algo', 'crc32', '--no-extract'],
  {
    onEvent(event) {
      console.log(event);
    },
  },
);

console.log(result.exitCode, result.ok);
```

Runtime behavior:

- WASI sees a single mounted directory: `/work`.
- Threaded wasm must be selected explicitly with `threadedWasmUrl`/`preferThreadedWasm` or a threaded `wasmUrl`.
- `runner.threaded` and `runner.wasmUrl` report the loaded runtime.
- Browser picker handles/files should be staged into OPFS before `run()`.
- Known CLI output paths are created in OPFS before `_start()` because WASI Preview 1 filesystem calls are synchronous.
- Dynamic files created during a run are flushed back to OPFS after `_start()` returns.

## Dedicated Browser Worker Client Example

```js
import { createBrowserWorkerClient } from 'rom-weaver-wasm/workers/browser-client';

const worker = createBrowserWorkerClient();
await worker.init({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

const result = await worker.runJson(['checksum', '/work/game.bin', '--algo', 'crc32'], {
  onEvent(event) {
    console.log(event);
  },
});

console.log(result.exitCode, result.ok);
worker.terminate();
```

## Build And Package

Build artifacts are written to this package by default:

```bash
scripts/build-wasm-cli.sh
```

If you built artifacts to a custom directory, syncing into this package is explicit:

```bash
ARTIFACT_DIR="/path/to/wasm-artifacts"
npm run prepare:dist -- "$ARTIFACT_DIR"
npm run check
npm pack
```
