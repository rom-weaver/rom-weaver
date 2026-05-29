# rom-weaver-wasm

JavaScript wrappers and WASM artifacts for browser `rom-weaver` execution.

## What You Get

- Browser OPFS runner (`createRomWeaverBrowserOpfs`) for Dedicated Workers
- Browser WASI thread support for `rom-weaver-app-threaded.wasm` when cross-origin isolation enables `SharedArrayBuffer`
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
  wasmUrl: '/wasm/rom-weaver-app.wasm',
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

const result = await runner.runJson(
  {
    type: 'checksum',
    args: {
      source: '/work/game.bin',
      algo: ['crc32'],
      no_extract: true,
    },
  },
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
- When both `wasmUrl` and `threadedWasmUrl` are available, the runner auto-selects threaded wasm only when `SharedArrayBuffer` and `crossOriginIsolated` are available; otherwise it falls back to non-threaded wasm.
- `runner.threaded` and `runner.wasmUrl` report the loaded runtime.
- Browser picker handles/files should be staged into OPFS before `run()`.
- Known typed-command output paths are created in OPFS before `_start()` because WASI Preview 1 filesystem calls are synchronous.
- Dynamic files created during a run are flushed back to OPFS after `_start()` returns.

## Dedicated Browser Worker Client Example

```js
import { createBrowserWorkerClient } from 'rom-weaver-wasm/workers/browser-client';

const worker = createBrowserWorkerClient();
await worker.init({
  wasmUrl: '/wasm/rom-weaver-app.wasm',
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

const result = await worker.runJson({
  type: 'checksum',
  args: {
    source: '/work/game.bin',
    algo: ['crc32'],
  },
}, {
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
scripts/build-wasm-app.sh
```

If you built artifacts to a custom directory, syncing into this package is explicit:

```bash
ARTIFACT_DIR="/path/to/wasm-artifacts"
npm run prepare:dist -- "$ARTIFACT_DIR"
npm run check
npm pack
```

## Browser Benchmarks

Run all browser-worker benchmarks with Vitest bench mode:

```bash
npm run test:browser:bench
```

Run suites that mirror the Python benchmark scripts:

```bash
npm run test:browser:bench:command-paths
npm run test:browser:bench:checksum-threading
```

Optional environment knobs:

- Shared Vitest bench timing:
  - `ROM_WEAVER_WASM_BENCH_TIME_MS` (default `50`)
  - `ROM_WEAVER_WASM_BENCH_ITERATIONS` (default `1`)
  - `ROM_WEAVER_WASM_BENCH_WARMUP_TIME_MS` (default `0`)
  - `ROM_WEAVER_WASM_BENCH_WARMUP_ITERATIONS` (default `0`)
  - `ROM_WEAVER_WASM_BENCH_THREADED` (`1`/`0`, default `1`)
  - `ROM_WEAVER_WASM_BENCH_OUTPUT_JSON` (optional output JSON path)
  - `ROM_WEAVER_WASM_BENCH_CLEAR_FIXTURE_CACHE` (`1` clears the persistent OPFS fixture cache before setup)
- `bench-command-paths.py` parity suite (`tests/browser-worker-client.bench.mjs`):
  - `ROM_WEAVER_WASM_BENCH_COMMANDS` (default `compress,extract,checksum,patch-create,patch-apply`)
  - `ROM_WEAVER_WASM_BENCH_CONTAINER_FORMATS` (default `chd,rvz,7z,zip,tar,tar.gz,tar.bz2,tar.xz,z3ds,gz,bz2,xz,zst`)
  - `ROM_WEAVER_WASM_BENCH_PATCH_FORMATS` (default `all`)
  - `ROM_WEAVER_WASM_BENCH_CHECKSUM_ALGOS` (default `all`)
  - `ROM_WEAVER_WASM_BENCH_CHECKSUM_MODES` (default `raw`)
  - `ROM_WEAVER_WASM_BENCH_CHECKSUM_COMBO_ALGOS` (default `crc32,md5,sha1`, `none` to disable)
  - `ROM_WEAVER_WASM_BENCH_SOURCE_MIB` (default `128`)
  - `ROM_WEAVER_WASM_BENCH_PATCH_SOURCE_MIB` (default `128`)
  - `ROM_WEAVER_WASM_BENCH_THREADS` (default `4`)
- `bench-checksum-threading.py` parity suite (`tests/browser-checksum-threading.bench.mjs`):
  - `ROM_WEAVER_WASM_BENCH_THREADING_ALGORITHMS` (default `crc32c,crc16,adler32`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_SIZES_MIB` (default `128`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_SEQUENTIAL_THREADS` (default `1`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_PARALLEL_THREADS` (default `4`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_STRIDE_MIB` (default `2`)
