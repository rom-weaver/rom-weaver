# Environment variables

Every `ROM_WEAVER_*` runtime knob the workspace reads, in one place. Runtime
knobs parse through `rom_weaver_core::env` (`env_bool`/`env_u64`/`env_u64_opt`),
which logs a `warn!` on an unparseable value instead of silently using the
default.

> **Not an env var:** the generated `packages/rom-weaver-react/src/wasm/generated/rom-weaver-format-metadata.ts`
> exports compile-time data tables named `ROM_WEAVER_CONTAINER_FORMATS`,
> `ROM_WEAVER_FORMAT_METADATA`, etc. Despite the `ROM_WEAVER_` prefix these are
> TypeScript `export const`s, **not** environment variables — a `grep ROM_WEAVER_`
> will surface them alongside the real knobs below.

## Runtime knobs

| Variable | Type | Default | Read at | Purpose |
| --- | --- | --- | --- | --- |
| `ROM_WEAVER_LOG` | filter string | unset | `rom-weaver-app/src/lib.rs` | Tracing filter spec (e.g. `rom_weaver_cli=trace`); also honored via `RUST_LOG` and the `--trace` flag. |
| `ROM_WEAVER_PATCH_IN_MEMORY_LIMIT` | u64 (bytes) | 256 MiB | `rom-weaver-patches/src/lib.rs` | Cap below which patch apply/create buffers in memory; above it the streaming path is used. Set to `0` to force streaming for benchmarks. |
| `ROM_WEAVER_ZIP_ZSTD_MEM_BUDGET_MB` | u64 (MiB) | physical RAM / 2 (1–2 GiB fallback) | `rom-weaver-containers/src/handlers/zip.rs` | Memory budget that caps zstd multi-thread job count for zip create. |

## Solid-patch metadata (`patch create --format solid`)

These eight strings are currently the **only** way to populate Solid patch
header metadata — there is no equivalent CLI flag. Read in
`rom-weaver-patches/src/solid.rs`.

`ROM_WEAVER_SOLID_GAME`, `ROM_WEAVER_SOLID_HACK`, `ROM_WEAVER_SOLID_VERSION`,
`ROM_WEAVER_SOLID_AUTHOR`, `ROM_WEAVER_SOLID_CONTACT`, `ROM_WEAVER_SOLID_COMMENT`,
`ROM_WEAVER_SOLID_SYSTEM`, `ROM_WEAVER_SOLID_PATCH_INFO7`.

## Test / build-only knobs

Not for production use.

| Variable | Read at | Purpose |
| --- | --- | --- |
| `ROM_WEAVER_CONTAINER_MAIN_THREAD_READER` | `rom-weaver-core/src/io.rs` | **Native, test-only.** Forces container pipelines to read the source on the main thread. On wasm this path is always taken and the variable is ignored. |
| `ROM_WEAVER_PATCH_MAIN_THREAD_READER` | `rom-weaver-patches/src/lib.rs` | **Native, test-only.** Same as above for patch apply/create. Ignored on wasm (always read-on-main there). |
| `ROM_WEAVER_TEST_THREAD_POOL_FAIL` | `rom-weaver-core/src/threads.rs` | Forces a thread-pool build failure to exercise the single-thread fallback. |
| `ROM_WEAVER_TEST_TMPDIR` | container test harness | Overrides the temp dir used by container tests. |
| `ROM_WEAVER_WASI_THREADS` | crate `build.rs` scripts | Forces the `rom_weaver_wasi_threads` cfg on (otherwise gated on the `wasm32-wasip1-threads` target). |

The webapp build/test/bench also reads a `ROM_WEAVER_*` family in `*.mjs`
(vite/vitest configs, scripts) — e.g. `ROM_WEAVER_APP_VERSION`,
`ROM_WEAVER_COMMIT_HASH`, `ROM_WEAVER_WASM_ARTIFACT_DIR`, `ROM_WEAVER_COVERAGE`,
`ROM_WEAVER_BROWSER`, `ROM_WEAVER_WASM_STRESS_1GB`, and the
`ROM_WEAVER_WASM_BENCH*` benchmark toggles. Those are front-end tooling knobs,
not part of the Rust runtime surface above.
