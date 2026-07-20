# Environment variables

Every `ROM_WEAVER_*` runtime knob the workspace reads, in one place. Runtime
knobs parse through `rom_weaver_core::env` (`env_bool`/`env_u64`/`env_u64_opt`),
which logs a `warn!` on an unparseable value instead of silently using the
default.

> **Not an env var:** the generated `packages/rom-weaver-webapp/src/wasm/generated/rom-weaver-format-metadata.ts`
> exports compile-time data tables named `ROM_WEAVER_CONTAINER_FORMATS`,
> `ROM_WEAVER_FORMAT_METADATA`, etc. Despite the `ROM_WEAVER_` prefix these are
> TypeScript `export const`s, **not** environment variables - a `grep ROM_WEAVER_`
> will surface them alongside the real knobs below.

<!-- START doctoc -->
## Table of contents

- [Runtime knobs](#runtime-knobs)
- [Solid-patch metadata (`patch create --format solid`)](#solid-patch-metadata-patch-create---format-solid)
- [Test / build-only knobs](#test--build-only-knobs)
- [wasm CLI harness (`scripts/wasm/run-wasi-cli.mjs`)](#wasm-cli-harness-scriptswasmrun-wasi-climjs)
- [Browser / PWA runtime config (`window.*` globals)](#browser--pwa-runtime-config-window-globals)
- [Webapp build/test/bench tooling (`*.mjs`)](#webapp-buildtestbench-tooling-mjs)

<!-- END doctoc -->

## Runtime knobs

| Variable | Type | Default | Read at | Purpose |
| --- | --- | --- | --- | --- |
| `ROM_WEAVER_LOG` | filter string | unset | `rom-weaver-app/src/lib.rs` | Tracing filter spec (e.g. `rom_weaver_cli=trace`); also honored via `RUST_LOG` when no explicit CLI log level is selected. |
| `ROM_WEAVER_PATCH_IN_MEMORY_LIMIT` | u64 (bytes) | 256 MiB | `rom-weaver-patches/src/lib.rs` | Cap below which patch apply/create buffers in memory; above it the streaming path is used. Set to `0` to force streaming for benchmarks. |
| `ROM_WEAVER_DISC_TRACK_IN_MEMORY_LIMIT` | u64 (bytes) | 256 MiB | `rom-weaver-app/src/patch_apply_disc.rs` | Cap for buffering a single freshly produced disc track in memory during compression instead of a temp file (only ever bounds one track, never the whole disc). Set to `0` to force the on-disk path for regression/parity runs. |
| `ROM_WEAVER_ZIP_ZSTD_MEM_BUDGET_MB` | u64 (MiB) | physical RAM / 2 (1–2 GiB fallback) | `rom-weaver-containers/src/handlers/zip.rs` | Memory budget that caps zstd multi-thread job count for zip create. |
| `ROM_WEAVER_7Z_MEM_BUDGET_MB` | u64 (MiB) | physical RAM / 2 (1 GiB wasm / 2 GiB native fallback) | `rom-weaver-containers/src/handlers/sevenz.rs` | Memory budget that caps the LZMA2 multi-thread count for 7z create; sibling of `ROM_WEAVER_ZIP_ZSTD_MEM_BUDGET_MB`. |

## Solid-patch metadata (`patch create --format solid`)

These eight strings are currently the **only** way to populate Solid patch
header metadata - there is no equivalent CLI flag. Read in
`rom-weaver-patches/src/solid.rs`.

`ROM_WEAVER_SOLID_GAME`, `ROM_WEAVER_SOLID_HACK`, `ROM_WEAVER_SOLID_VERSION`,
`ROM_WEAVER_SOLID_AUTHOR`, `ROM_WEAVER_SOLID_CONTACT`, `ROM_WEAVER_SOLID_COMMENT`,
`ROM_WEAVER_SOLID_SYSTEM`, `ROM_WEAVER_SOLID_PATCH_INFO7`.

## Test / build-only knobs

Not for production use.

| Variable | Read at | Purpose |
| --- | --- | --- |
| `ROM_WEAVER_TEST_THREAD_POOL_FAIL` | `rom-weaver-core/src/threads.rs` | Forces a thread-pool build failure to exercise the single-thread fallback. |
| `ROM_WEAVER_TEST_TMPDIR` | container test harness | Overrides the temp dir used by container tests. |
| `ROM_WEAVER_WASI_THREADS` | crate `build.rs` scripts | Forces the `rom_weaver_wasi_threads` cfg on (otherwise gated on the `wasm32-wasip1-threads` target). |

## wasm CLI harness (`scripts/wasm/run-wasi-cli.mjs`)

Process env vars read **only** by the Node-hosted WASI CLI harness that runs the
threaded wasm module under `node` (the on-device/headless wasm test driver).
They do **not** affect the native CLI or the browser runtime.

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `ROM_WEAVER_WASM_SHARED_MEMORY_INITIAL_PAGES` | positive int | harness default | Initial pages for the shared `WebAssembly.Memory`. |
| `ROM_WEAVER_WASM_SHARED_MEMORY_MAX_PAGES` | positive int | harness default | Maximum pages for the shared `WebAssembly.Memory`; must be `>=` the initial pages or the harness throws. |
| `ROM_WEAVER_WASI_THREAD_DEBUG` | bool | off | Enables `[wasi-thread]` debug logging from the harness. |
| `ROM_WEAVER_WASI_THREAD_DEBUG_LOG_FILE` | path | unset | When `ROM_WEAVER_WASI_THREAD_DEBUG` is on, appends thread debug lines to this file instead of stderr. |

## Browser / PWA runtime config (`window.*` globals)

> **Not env vars:** these are `window` globals injected into / exposed by the
> webapp at runtime (page-level config and diagnostic handles), **not** process
> environment variables - same caveat as the TypeScript `export const`s above.
> A `grep ROM_WEAVER_` surfaces them under
> `packages/rom-weaver-webapp/src/webapp` alongside the real knobs.

| Global | Direction | Set/read at | Purpose |
| --- | --- | --- | --- |
| `window.ROM_WEAVER_APP_CONFIG` | read by app | `webapp/webapp.ts` | Page-injected `WebAppConfig` consumed at startup (empty object if absent). |
| `window.ROM_WEAVER_APP_BOOTSTRAP` | read by app | `webapp/webapp.ts` | Bootstrap hooks (`markMounted`, `showError`) the host page provides. |
| `window.ROM_WEAVER_CONSOLE_LOGS` | exposed by app | `webapp/console-log-capture.ts` | Console-log capture API (`getReport`/`copy`/`clear`/…) for debugging. |
| `window.ROM_WEAVER_SERVICE_WORKER` | exposed by app | `webapp/webapp.ts` | Service-worker cache controls (`forceCacheAndReload`/`getState`/…). |
| `window.ROM_WEAVER_BROWSER_DIAGNOSTICS` | exposed by app | `webapp/browser-runtime-diagnostics.ts` | Browser runtime diagnostics handle. |
| `window.ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS` | exposed by app | `webapp/browser-runtime-diagnostics.ts` | Mobile-Safari runtime diagnostics handle (alias of the same diagnostics API). |
| `window.ROM_WEAVER_IOS_SAFARI_MATRIX` | exposed by app | `webapp/mobile-safari-matrix.ts` | iOS-Safari format-matrix diagnostic harness API (diagnostic page only). |

`ROM_WEAVER_SERVICE_WORKER_URL_PATTERN`
(`webapp/pwa/pwa-service-worker-client.ts`) is **not** a knob - it is an
internal module-level regex `const` (service-worker script-URL matcher), not a
`window` global or configuration input. It is listed here only because a
`grep ROM_WEAVER_` matches it.

## Webapp build/test/bench tooling (`*.mjs`)

The webapp build/test/bench also reads a `ROM_WEAVER_*` family in `*.mjs`
(vite/vitest configs, scripts) - e.g. `ROM_WEAVER_APP_VERSION`,
`ROM_WEAVER_COMMIT_HASH`, `ROM_WEAVER_WASM_ARTIFACT_DIR`, `ROM_WEAVER_COVERAGE`,
`ROM_WEAVER_BROWSER`, `ROM_WEAVER_WASM_STRESS_1GB`, and the
`ROM_WEAVER_WASM_BENCH*` benchmark toggles. Those are front-end tooling knobs,
not part of the Rust runtime surface above.
