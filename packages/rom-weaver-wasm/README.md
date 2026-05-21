# rom-weaver-wasm

JavaScript wrappers and WASM artifacts for `rom-weaver`.

## What You Get

- Browser OPFS runner (`createRomWeaverZenFsBrowser`) for Dedicated Workers
- Dedicated browser worker client (`createBrowserWorkerClient`)
- First-party TypeScript declarations

Node.js integration is intentionally removed from this package.
Use the native `rom-weaver` CLI directly for Node workflows.

## Import Paths

- `rom-weaver-wasm` (main entry)
- `rom-weaver-wasm/zenfs`
- `rom-weaver-wasm/workers/browser-client`
- `rom-weaver-wasm/workers/protocol`
## Browser OPFS Runner Example

`createRomWeaverZenFsBrowser` must run in a secure-context Dedicated Worker if you want true zero-copy OPFS access (`FileSystemSyncAccessHandle`).

It is not a main-thread API and will throw when called from `window`.

```js
import { createRomWeaverZenFsBrowser } from 'rom-weaver-wasm/zenfs';

const opfsHandle = await navigator.storage.getDirectory();

const runner = await createRomWeaverZenFsBrowser({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsHandle,
  opfsGuestPath: '/opfs',
  runtimeMounts: ['/opfs', '/scratch'],
});

const result = await runner.runJson(
  ['checksum', '/opfs/game.bin', '--algo', 'crc32'],
  {
    onEvent(event) {
      console.log(event);
    },
  },
);

console.log(result.exitCode, result.ok);
```

Scratch temp behavior:

- Default scratch guest path is `/scratch`.
- Per run, `ROM_WEAVER_TMPDIR` is set to `/scratch/.rom-weaver-scratch/<run-id>`.
- `/opfs` remains read-only for runtime writes; temp output must go through `/scratch`.
- Scratch must be writable. Runner initialization fails if writable scratch cannot be established.
- Scratch namespaces are cleaned up best-effort after each run.
- If unset, browser runs default `ROM_WEAVER_MAX_BUFFERED_PATCH_BYTES=67108864` (64 MiB) to fail early on remaining full-buffer patch paths instead of risking worker OOM.

## Dedicated Browser Worker Client Example

```js
import { createBrowserWorkerClient } from 'rom-weaver-wasm/workers/browser-client';

const worker = createBrowserWorkerClient();
const opfsHandle = await navigator.storage.getDirectory();

await worker.init({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsHandle,
  opfsGuestPath: '/opfs',
  runtimeMounts: ['/opfs', '/scratch'],
});

const result = await worker.runJson(['checksum', '/opfs/game.bin', '--algo', 'crc32'], {
  onEvent(event) {
    console.log(event);
  },
});

console.log(result.exitCode, result.ok);
await worker.terminate();
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
