# Environment variables

This page lists the supported runtime variables and the main developer
overrides. Most runtime numbers and booleans are parsed by
`rom_weaver_core::env`; the table notes exceptions.

> **Not an env var:** the generated `packages/rom-weaver-webapp/src/wasm/generated/rom-weaver-format-metadata.ts`
> exports compile-time data tables named `ROM_WEAVER_CONTAINER_FORMATS`,
> `ROM_WEAVER_FORMAT_METADATA`, etc. Despite the `ROM_WEAVER_` prefix these are
> TypeScript `export const`s, **not** environment variables.

<!-- START doctoc -->
## Table of contents

- [Command-scoped configuration](#command-scoped-configuration)
- [Runtime knobs](#runtime-knobs)
- [Test / build-only knobs](#test--build-only-knobs)
- [Browser / PWA runtime handles (`window.*` globals)](#browser--pwa-runtime-handles-window-globals)
- [Webapp build/test/bench tooling (`*.mjs`)](#webapp-buildtestbench-tooling-mjs)

<!-- END doctoc -->

## Command-scoped configuration

Patch metadata and browser command arguments are command inputs, not ambient
environment configuration. SOLID metadata is supplied with the
`patch create --solid-*` flags documented in [CLI usage](cli.md), or with the
corresponding `solid_*` fields on a typed WASM `PatchCreateCommand`.

The browser OPFS runner likewise has no constructor-level `program`, `argv0`,
or `env` options. WASI argv0 is always `rom-weaver`. A command may still supply
`env` in its per-run options when it needs one of the runtime knobs below.

## Runtime knobs

| Variable | Type | Default | Read at | Purpose |
| --- | --- | --- | --- | --- |
| `ROM_WEAVER_LOG` | filter string | unset | `crates/rom-weaver-cli/src/lib.rs` | Tracing filter spec (e.g. `rom_weaver_app=trace`); also honored via `RUST_LOG` when no explicit CLI log level is selected. |
| `ROM_WEAVER_PATCH_IN_MEMORY_LIMIT` | u64 (bytes) | 256 MiB | `crates/rom-weaver-patches/src/lib.rs` | Cap below which patch apply/create buffers in memory; above it the streaming path is used. Set to `0` to force streaming for benchmarks. |
| `ROM_WEAVER_DISC_TRACK_IN_MEMORY_LIMIT` | u64 (bytes) | 256 MiB | `crates/rom-weaver-cli/src/patch_apply_disc.rs` | Cap for buffering a single freshly produced disc track in memory during compression instead of a temp file (only ever bounds one track, never the whole disc). Set to `0` to force the on-disk path for regression/parity runs. |
| `ROM_WEAVER_ZIP_ZSTD_MEM_BUDGET_MB` | u64 (MiB) | physical RAM / 2 (1–2 GiB fallback) | `crates/rom-weaver-containers/src/handlers/zip.rs` | Memory budget that caps zstd multi-thread job count for zip create. |
| `ROM_WEAVER_7Z_MEM_BUDGET_MB` | u64 (MiB) | physical RAM / 2 (1 GiB wasm / 2 GiB native fallback) | `crates/rom-weaver-containers/src/handlers/sevenz.rs` | Memory budget that caps the LZMA2 multi-thread count for 7z create. Invalid text is ignored. |

## Test / build-only knobs

Not for production use.

| Variable | Read at | Purpose |
| --- | --- | --- |
| `ROM_WEAVER_TEST_THREAD_POOL_FAIL` | `crates/rom-weaver-core/src/threads.rs` | Forces a thread-pool build failure to exercise the single-thread fallback. |
| `ROM_WEAVER_TEST_TMPDIR` | container test harness | Overrides the temp dir used by container tests. |
| `ROM_WEAVER_WASI_THREADS` | crate `build.rs` scripts | Forces the `rom_weaver_wasi_threads` cfg on (otherwise gated on the `wasm32-wasip1-threads` target). |

## Browser / PWA runtime handles (`window.*` globals)

> **Not env vars:** these are diagnostic and service-worker handles exposed by
> the webapp at runtime, **not** process environment variables.

| Global | Direction | Set/read at | Purpose |
| --- | --- | --- | --- |
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
