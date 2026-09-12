# Browser WASM runtime

The browser runtime runs `rom-weaver` in dedicated workers. The webapp imports its TypeScript modules through relative paths.

<!-- START doctoc -->
## Table of contents

- [What you get](#what-you-get)
- [Import paths](#import-paths)
- [Browser OPFS runner example](#browser-opfs-runner-example)
- [Dedicated browser worker client example](#dedicated-browser-worker-client-example)
- [Build and package](#build-and-package)
- [Browser benchmarks](#browser-benchmarks)

<!-- END doctoc -->

## What you get

- Browser OPFS runner (`createRomWeaverBrowserOpfs`) for Dedicated Workers
- Browser WASI thread support for `rom-weaver-app.wasm` when cross-origin isolation enables `SharedArrayBuffer`
- Dedicated browser worker client (`createBrowserWorkerClient`)
- First-party TypeScript declarations

The native `rom-weaver` CLI provides filesystem access for Node workflows.

## Import paths

Import the TypeScript sources directly with relative paths, for example:

- `src/wasm/index.ts` (main entry: format metadata, command helpers, and type-only OPFS exports)
- `src/wasm/generated/rom-weaver-format-metadata.ts`
- `src/wasm/rom-weaver-browser-opfs-api.ts`
- `src/wasm/workers/browser-worker-client.ts`
- `src/wasm/workers/worker-protocol.ts`

## Browser OPFS runner example

`createRomWeaverBrowserOpfs` must run in a secure-context Dedicated Worker so it can use `FileSystemSyncAccessHandle`. It is not a main-thread API and will throw when called from `window`.

```js
import { createRomWeaverBrowserOpfs } from './rom-weaver-browser-opfs-api.ts';

const runner = await createRomWeaverBrowserOpfs({
  wasmUrl: '/wasm/rom-weaver-app.wasm',
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});
const game = await fetch('/game.bin').then((response) => response.blob());

const result = await runner.runJson(
  {
    type: 'checksum',
    args: {
      input: '/work/game.bin',
      algo: ['crc32'],
      no_extract: true,
    },
  },
  {
    virtualFiles: [{ path: '/work/game.bin', source: game }],
    onEvent(event) {
      console.log(event);
    },
  },
);

console.log(result.exitCode, result.ok);
await runner.dispose();
```

Runtime behavior:

- This example mounts the OPFS root at `/work`. `runtimeMounts` and `mountHandles` can configure additional mounts.
- The browser worker runtime requires `SharedArrayBuffer` plus `crossOriginIsolated` and loads `rom-weaver-app.wasm`.
- `runner.threaded` and `runner.wasmUrl` report the loaded runtime.
- Pass browser picker `File` or `Blob` inputs through `virtualFiles`; paths already produced in OPFS can be reused without copying.
- Guest file creation and writes go through the dedicated OPFS proxy during the run. The runner waits for spawned threads and flushes pending write buffers before it returns.
- WASI argv0 is fixed to `rom-weaver`; constructor-level `program`, `argv0`, and `env` configuration is not supported.
- Use the second argument to `run()` or `runJson()` for per-run `env` values when a command needs a supported runtime knob.

Format-specific creation metadata belongs on the typed command. For example, SOLID's extended seven-string header can be requested without ambient environment variables:

```js
await runner.runJson({
  type: 'patch',
  args: {
    type: 'create',
    args: {
      original: '/work/original.sfc',
      modified: '/work/translated.sfc',
      output: '/work/translation.solid',
      format: 'solid',
      solid_system: 'SNES',
      solid_game: 'Example Game',
      solid_hack: 'English Translation',
      solid_version: '1.0',
      solid_author: 'Example Team',
    },
  },
});
```

## Dedicated browser worker client example

This client can run on the main thread. Its worker opens the default OPFS root, so the caller does not need to access OPFS.

```js
import { createBrowserWorkerClient } from './workers/browser-worker-client.ts';

const worker = createBrowserWorkerClient();
await worker.init({
  wasmUrl: '/wasm/rom-weaver-app.wasm',
  workGuestPath: '/work',
});
const game = await fetch('/game.bin').then((response) => response.blob());

const result = await worker.runJson({
  type: 'checksum',
  args: {
    input: '/work/game.bin',
    algo: ['crc32'],
  },
}, {
  virtualFiles: [{ path: '/work/game.bin', source: game }],
  onEvent(event) {
    console.log(event);
  },
});

console.log(result.exitCode, result.ok);
worker.terminate();
```

## Build and package

The [development guide](../../../../docs/development/development.md#build-and-run-the-webapp) covers building and synchronizing WASM artifacts. The default output directory is `packages/rom-weaver-webapp/src/wasm/`.

## Browser benchmarks

The [performance guide](../../../../docs/development/performance.md#browser-benchmarks) contains the browser benchmark commands, suites, and environment variables.
