# @rom-weaver/wasm

Browser WebAssembly runtime for `rom-weaver`: a WASI + OPFS threaded worker
engine to inspect, extract, compress, and patch ROMs and disc images. Published
as the `@rom-weaver/wasm` npm package and consumed by `@rom-weaver/webapp`.

<!-- START doctoc -->
## Table of contents

- [What you get](#what-you-get)
- [Import paths](#import-paths)
- [Browser OPFS runner example](#browser-opfs-runner-example)
- [Dedicated browser worker client example](#dedicated-browser-worker-client-example)
- [Build and package](#build-and-package)
- [Browser benchmarks](#browser-benchmarks)
- [License](#license)

<!-- END doctoc -->

## What you get

- Browser OPFS runner (`createRomWeaverBrowserOpfs`) for Dedicated Workers
- Browser WASI thread support for `rom-weaver-app.wasm` when cross-origin isolation enables `SharedArrayBuffer`
- Dedicated browser worker client (`createBrowserWorkerClient`)
- First-party TypeScript declarations

Node.js, Electron, and Capacitor filesystem backends are intentionally omitted from this directory.
Use the native `rom-weaver` CLI directly for Node workflows.

## Import paths

Import from the package root or a granular subpath, for example:

- `@rom-weaver/wasm` (main entry: asset URLs, format metadata, command helpers, OPFS API, worker client, types)
- `@rom-weaver/wasm/generated/rom-weaver-format-metadata`
- `@rom-weaver/wasm/rom-weaver-browser-opfs-api`
- `@rom-weaver/wasm/workers/browser-worker-client`
- `@rom-weaver/wasm/workers/worker-protocol`

The wasm module and the three worker entrypoints resolve through
`getRomWeaverWasmAssetUrls()`, whose `new URL(..., import.meta.url)` literals
Vite, webpack 5, and Rollup all rewrite to copied asset URLs.

## Browser OPFS runner example

`createRomWeaverBrowserOpfs` must run in a secure-context Dedicated Worker so it can use `FileSystemSyncAccessHandle`.
It is not a main-thread API and will throw when called from `window`.

```js
import { createRomWeaverBrowserOpfs, getRomWeaverWasmAssetUrls } from '@rom-weaver/wasm';

const runner = await createRomWeaverBrowserOpfs({
  wasmUrl: getRomWeaverWasmAssetUrls().wasmUrl,
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

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
    onEvent(event) {
      console.log(event);
    },
  },
);

console.log(result.exitCode, result.ok);
await runner.dispose();
```

Runtime behavior:

- WASI sees a single mounted directory: `/work`.
- The browser worker runtime requires `SharedArrayBuffer` plus `crossOriginIsolated` and loads `rom-weaver-app.wasm`.
- `runner.threaded` and `runner.wasmUrl` report the loaded runtime.
- Browser picker handles/files should be staged into OPFS before `run()`.
- Known typed-command output paths are created in OPFS before `_start()` because WASI Preview 1 filesystem calls are synchronous.
- Dynamic files created during a run are flushed back to OPFS after `_start()` returns.
- WASI argv0 is fixed to `rom-weaver`; constructor-level `program`, `argv0`, and `env` configuration is not supported.
- Use the second argument to `run()` or `runJson()` for per-run `env` values when a command needs a supported runtime knob.

Format-specific creation metadata belongs on the typed command. For example,
SOLID's extended seven-string header can be requested without ambient
environment variables:

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

```js
import { createBrowserWorkerClient, getRomWeaverWasmAssetUrls } from '@rom-weaver/wasm';

const worker = createBrowserWorkerClient();
await worker.init({
  wasmUrl: getRomWeaverWasmAssetUrls().wasmUrl,
  opfsHandle: await navigator.storage.getDirectory(),
  workGuestPath: '/work',
});

const result = await worker.runJson({
  type: 'checksum',
  args: {
    input: '/work/game.bin',
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

## Build and package

The [development guide](../../docs/development.md#build-and-run-the-webapp)
owns the WASM build and dev-server procedure. The wasm binary is written to
`src/` by default; `scripts/build.mjs` bundles `src/` and the binary into
`dist/`, which is what consumers load.

If you built artifacts to a custom directory (`ROM_WEAVER_WASM_OUT_DIR`), `build-wasm`
syncs them in automatically. To sync a pre-built directory manually (run from
`packages/rom-weaver-webapp`):

```bash
ARTIFACT_DIR="/path/to/wasm-artifacts"
npm run prepare:dist -- "$ARTIFACT_DIR"
```

## Browser benchmarks

Run all browser-worker benchmarks with Vitest bench mode (from `packages/rom-weaver-webapp`):

```bash
npm run test:browser:wasm:bench
```

Run suites that mirror the Python benchmark scripts:

```bash
npm run test:browser:wasm:bench:command-paths
npm run test:browser:wasm:bench:checksum-threading
```

Optional environment knobs:

- Shared Vitest bench timing:
  - `ROM_WEAVER_WASM_BENCH_TIME_MS` (default `50`)
  - `ROM_WEAVER_WASM_BENCH_ITERATIONS` (default `1`)
  - `ROM_WEAVER_WASM_BENCH_WARMUP_TIME_MS` (default `0`)
  - `ROM_WEAVER_WASM_BENCH_WARMUP_ITERATIONS` (default `0`)
  - `ROM_WEAVER_WASM_BENCH_OUTPUT_JSON` (optional output JSON path)
  - `ROM_WEAVER_WASM_BENCH_CLEAR_FIXTURE_CACHE` (`1` clears the persistent OPFS fixture cache before setup)
- `bench-command-paths.py` parity suite (`tests/wasm/browser-worker-client.bench.mjs`):
  - `ROM_WEAVER_WASM_BENCH_COMMANDS` (default `compress,extract,checksum,patch-create,patch-apply`)
  - `ROM_WEAVER_WASM_BENCH_CONTAINER_FORMATS` (default `chd,rvz,7z,zip,tar,tar.gz,tar.bz2,tar.xz,z3ds,gz,bz2,xz,zst`)
  - `ROM_WEAVER_WASM_BENCH_PATCH_FORMATS` (default `all`)
  - `ROM_WEAVER_WASM_BENCH_CHECKSUM_ALGOS` (default `all`)
  - `ROM_WEAVER_WASM_BENCH_CHECKSUM_MODES` (default `raw`)
  - `ROM_WEAVER_WASM_BENCH_CHECKSUM_COMBO_ALGOS` (default `crc32,md5,sha1`, `none` to disable)
  - `ROM_WEAVER_WASM_BENCH_SOURCE_MIB` (default `128`)
  - `ROM_WEAVER_WASM_BENCH_PATCH_SOURCE_MIB` (default `128`)
  - `ROM_WEAVER_WASM_BENCH_THREADS` (default `4`)
- `bench-checksum-threading.py` parity suite (`tests/wasm/browser-checksum-threading.bench.mjs`):
  - `ROM_WEAVER_WASM_BENCH_THREADING_ALGORITHMS` (default `crc32c,crc16,adler32`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_SIZES_MIB` (default `128`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_SEQUENTIAL_THREADS` (default `1`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_PARALLEL_THREADS` (default `4`)
  - `ROM_WEAVER_WASM_BENCH_THREADING_STRIDE_MIB` (default `2`)

## License

Copyright (C) Brandon Casey

`@rom-weaver/wasm` is licensed under the GNU Affero General Public License,
version 3 or later ([AGPL-3.0-or-later](LICENSE.md)). Bundled third-party
components retain their own licenses; release artifacts ship a generated
attribution notice and third-party license inventory.

If the AGPL's obligations do not fit your product, separate commercial license
terms are available from the copyright holder — contact
Brandon Casey (<brandonocasey@gmail.com>).
