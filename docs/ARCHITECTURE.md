# Architecture

How rom-weaver is put together: one Rust command core shipped two ways (native
CLI and a WASM build that runs in browser workers), with a React webapp driving
the WASM build over a JSON event protocol.

```
                 ┌──────────────────────────────┐
                 │ rom-weaver-cli Cargo package│
                 │  rom_weaver_app shared lib  │  command orchestration
                 └──────────┬──────────┬────────┘
                            │          │
               native build │          │ wasm32-wasip1-threads build
                            ▼          ▼
                 ┌──────────────┐  ┌──────────────────────┐
                 │  rom-weaver  │  │ rom-weaver-app.wasm │ typed JSON stdio
                 │ CLI binary   │  └──────────┬───────────┘
                 └──────────────┘             │
                                  ┌───────────▼───────────┐
                                  │ react src/wasm layer │ OPFS WASI runner,
                                  │    (browser-only)    │ thread pool, worker client
                                  └───────────┬───────────┘
                                  ┌───────────▼───────────┐
                                  │ rom-weaver-webapp     │ workflows, forms, PWA
                                  └───────────────────────┘
```

<!-- START doctoc -->
## Table of contents

- [Workspace layout](#workspace-layout)
- [Core abstractions (`crates/rom-weaver-core/src/registry.rs`)](#core-abstractions-cratesrom-weaver-coresrcregistryrs)
- [Threading model](#threading-model)
- [Browser I/O paths](#browser-io-paths)
- [Patch apply: ROM copier headers](#patch-apply-rom-copier-headers)
- [Dreamcast `.dcp` patches (the filesystem-level apply path)](#dreamcast-dcp-patches-the-filesystem-level-apply-path)
- [rom-weaver-bundle.json bundles](#rom-weaver-bundlejson-bundles)
- [Rust ⇄ TypeScript boundary](#rust-%E2%87%84-typescript-boundary)
- [Build graph](#build-graph)
- [Webapp UI - the loom workbench](#webapp-ui---the-loom-workbench)
- [Testing](#testing)
- [Other docs](#other-docs)

<!-- END doctoc -->

## Workspace layout

| Path | Role |
| --- | --- |
| `crates/rom-weaver-core` | Foundation: registry traits, `RomWeaverError`, I/O helpers, thread planning (`ThreadCapability`/`ThreadExecution` in `src/threads.rs`), and the standalone codec backends (zstd, deflate, lzma, ... in `src/codecs`). Depends on nothing else in the workspace. |
| `crates/rom-weaver-checksum` | Checksum engines (crc32/md5/sha*/blake3/crc32c/crc16/adler32) plus the streaming variant engine shared by `checksum` and extract flows. |
| `crates/rom-weaver-containers` | Container registry + per-format handlers (`src/handlers/*.rs`: zip, 7z, tar*, rvz, z3ds, pbp, cso, ...), native CHD implementation (`src/chd`), and the libarchive wrapper/bindings/build integration (`src/libarchive`, `libarchive/`). |
| `crates/rom-weaver-patches` | Patch format handlers (`src/{ips,bps,ups,ppf,rup,...}.rs`), one file per format, including VCDIFF/xdelta encode+decode (`src/xdelta`, parallel window encoding; also exposes `apply_patch_bytes` for in-memory VCDIFF apply, used by `.dcp`). |
| `crates/rom-weaver-cli/src/gdrom` | Dreamcast GD-ROM / CD data-track filesystem: read (`sector` cooking of `MODE1/2352`, `iso9660` parse, `GdRomFs` tree view with the +45000 LBA bias) and write (`iso_writer` authors a cooked ISO9660 image, `mode1` re-encodes EDC/ECC into raw `MODE1/2352`). Pure Rust, wasm-safe. |
| `crates/rom-weaver-cli/src/dcp` | Universal Dreamcast Patcher (`.dcp`) format: ZIP central-directory reader + entry inflate (`zip`), entry classification (`manifest`), per-file apply (`apply`), and full data-track rebuild (`rebuild`). Builds on the app's `gdrom` module + `rom-weaver-patches`'s `xdelta` module. |
| `crates/rom-weaver-cli` | The installable package: the `rom_weaver_app` command library, native `rom-weaver` CLI, `rom-weaver-app` WASM entrypoint, type generator, argument parsing, and reporters. |
| `packages/rom-weaver-webapp/src/wasm` | Browser WASM layer in the webapp package: OPFS WASI runner (`run`/`runJson`), mounts, thread pool, worker client, generated types. |
| `packages/rom-weaver-webapp` | Webapp: workflow controllers, runtime adapters, React forms, workers, PWA shell. |
| `scripts/` | Benches, worktree setup, and WASM toolchain helpers (`scripts/wasm/`); build orchestration moved to `.config/mise.toml` (`mise run build-wasm`). |

Crate dependency flow is one-directional: `core` ← format crates
(`checksum`/`containers`/`patches`) ← `cli`. Libarchive is an internal
`containers` module rather than another package. The CLI package's `dcp` module
consumes its `gdrom` module (data-track filesystem) and `patches`' `xdelta`
module (per-file VCDIFF apply).

## Core abstractions (`crates/rom-weaver-core/src/registry.rs`)

Every pluggable format handler implements one of two traits, registered into a registry
keyed by `FormatDescriptor` (name + aliases + extensions, used for both CLI
`--format` matching and path-based probing):

- `ContainerHandler` (+ `ContainerHandlerOperations`): `probe`, `probe_details`,
  `list_entries`, `extract`, `create`, plus `capabilities()` describing what the
  format supports (create, dry-run sizing, ...).
- `PatchHandler`: `probe`, `parse`, `apply`, `create`, with a default
  `validate` that dry-run applies to a temp path.

Checksums and codecs are not trait-pluggable: `NativeChecksumEngine`
(`crates/rom-weaver-checksum/src/core.rs`) covers whole-file and range
checksums for every algorithm, and the codec helpers in
`crates/rom-weaver-core/src/codecs` are free functions.

Handlers return `OperationReport` (family, format, stage, label, JSON details,
percent, thread execution, status) - the single progress/result currency that
flows from format code through the `rom_weaver_app` library to the CLI reporters and, in
JSON mode, to the browser. `OperationContext` carries cancellation, temp-path
allocation, progress sinks, and thread budgets downward.

Registry entries are wrapped in tracing decorators
(`traced_container_handler`/`traced_patch_handler`) so
every probe/extract/apply gets start/complete `trace!` spans for free.

Errors are one `thiserror` enum, `RomWeaverError`
(`crates/rom-weaver-core/src/error.rs`), with `pub type Result<T>` alias. Validation
failures that need machine-readable codes use the structured
`ValidationCodeError` variant; do not add per-crate error types.

## Threading model

`ThreadCapability` (what a format *can* parallelize) and `ThreadExecution`
(what a run *actually* used) live in `crates/rom-weaver-core/src/threads.rs`. Formats
plan a parallelism level from input size and the requested budget, build a
scoped pool, and report the outcome in `OperationReport.thread_execution`.

Patterns that matter when touching this code:

- **Producer/consumer pipelines.** CHD decode/create and RVZ create stream
  compressed data through bounded channels: a reader stage feeds worker
  decoders/encoders, and an ordered writer reassembles output. Memory is
  bounded (~1 GiB cap on CHD decode batches).
- **Per-worker reads under WASM (via the OPFS proxy).** Spawned wasm threads
  cannot `path_open` an OPFS file directly (WASI `os error 44`, worst on Safari).
  The dedicated OPFS proxy worker resolves this - threads open and read through
  it - so container/patch decode reads per-worker like native does, and the old
  read-on-main gates (`ROM_WEAVER_CONTAINER_MAIN_THREAD_READER` /
  `ROM_WEAVER_PATCH_MAIN_THREAD_READER`) are retired. (Lone remaining
  read-on-main: RVZ *create* in the inlined `nod` source.) See **Browser I/O
  paths** below for the full picture.
- **Browser thread budgets.** "auto" is resolved on the JS side
  (`packages/rom-weaver-webapp/src/wasm/workers/browser-thread-budget.ts` and the
  React `toThreadBudget` path) before it reaches wasm - the wasm fallback is a
  fixed 4 threads, so passing "auto" through literally caps throughput.
- **Byte-identical parity.** Compression outputs are validated against
  reference tools (chdman, dolphin-tool). Performance changes to encode paths
  must keep outputs byte-identical; tests assert this.

`docs/browser-concurrency.md` covers the browser-side concurrency rules in
more depth.

## Browser I/O paths

Every wasm file read/write goes through one stack; only the bottom backend
differs:

```
wasm (Rust std::fs)
  -> WASI import (fd_read / fd_pread / fd_write ...)
    -> WasiRandomAccessFileInode / OpenWasiRandomAccessFile   (wasm/browser-opfs-wasi-file-inode.ts)
      -> a RandomAccessFileLike adapter (.readAt / .writeAt)
        -> ONE of the backends below
```

`OpenWasiRandomAccessFile` adds sequential **write coalescing** (8 MiB buffer;
direct writes >=2 MiB bypass it) so per-sector decode output doesn't become
round-trip-bound. Note the WASI contract gotcha: a `readAt` of **0 bytes is
success**, which Rust `read_exact` surfaces as a generic "read error".

**Input reads** - chosen per source in
`packages/rom-weaver-webapp/src/workers/protocol/browser-opfs-source-ref.ts`:

| source | backend | notes |
| --- | --- | --- |
| already on OPFS (extracted file, patch output) | `BrowserProxyRandomAccessFile` by path | no copy; how multi-step workflows chain |
| Blob/File, fast path (`useProxyHandle=false`) | `BrowserVirtualRandomAccessFile` + per-thread `FileReaderSync` + 16 MiB LRU | N readers run at once |
| Blob/File, proxy handle (`useProxyHandle=true`) | `BrowserProxyRandomAccessFile` -> OPFS proxy worker (Blob-backed handle) | exactly one reader, over SAB |
| in-memory `Uint8Array`/`ArrayBuffer` | `BrowserVirtualRandomAccessFile` in-memory | defensive only - no current caller |

The fast-path/proxy choice is browser-gated:
`useProxyHandle = isWebKitInputRuntime() && size >= ~64 MiB`. Concurrent reads of
one File parallelize on Chrome/Firefox (fast path scales ~Nx) but serialize at
WebKit's file layer (one proxy reader avoids the contention; measured RVZ
extract ~5747 ms stalled vs ~4612 ms balanced). Small inputs are single-threaded
(no contention), so they take the lower-overhead fast path even on Safari. OPFS
input *staging* (copying a Blob into OPFS up front) is fully retired.

**Output writes** - wasm-produced files (extracted ISO, created CHD/RVZ, patched
ROM) write through `BrowserProxyRandomAccessFile.writeAt` (4 MiB write-back
coalescing) -> `OpfsProxyClient.write` -> proxy server `SyncAccessHandle.write`.
A separate storage worker
(`packages/rom-weaver-webapp/src/workers/storage/browser-opfs-staging.worker.ts`,
actions `write`/`truncate`/`cleanup`) backs the app-side large-file VFS and path
cleanup, not the per-op wasm output.

**Output -> user** -
`packages/rom-weaver-webapp/src/storage/browser/browser-large-file-vfs.ts`
`createOutputRef()` exposes the OPFS result as a lazy `getFile()` plus `saveAs()`
(browser download, or write into a user-picked `FileSystemFileHandle`) - the
bytes stay OPFS-backed instead of round-tripping the JS heap.

**OPFS proxy topology** - one **dedicated** proxy worker per runner
(`packages/rom-weaver-webapp/src/wasm/browser-opfs-proxy-runtime.ts` spawns
`packages/rom-weaver-webapp/src/wasm/workers/browser-opfs-proxy-worker.ts`).
It is the single owner of every `SyncAccessHandle` (and Blob input handle); its
loop is async (`Atomics.waitAsync` doorbell) while **consumers block
synchronously** (`Atomics.wait`) - that free event loop is what makes the
Blob-handle reads deadlock-free. The SAB channel is forwarded into every spawned
WASI thread so they share the one proxy; the mount
(`packages/rom-weaver-webapp/src/wasm/browser-opfs-mount.ts`) builds proxy vs virtual inodes and caches inode
trees across runs.

**Native (CLI)** - plain `std::fs::File` + `BufReader`/`BufWriter`,
`SplitFileReader` for split inputs, `create_extract_output_file` for outputs
(`rom-weaver-core`). Container decode uses the same **per-worker** reader shape
as wasm (each worker opens its own range), differing only in backend (`File` vs
proxy) - there is no read-on-main on native.

**Constraints that shape all of this:** `SharedArrayBuffer` needs
crossOriginIsolation (COOP/COEP headers from
`packages/rom-weaver-webapp/scripts/dev-server.mjs` / the prod
service worker) - no SAB means no proxy and no threads; OPFS is dedicated-worker
only (no main-thread `window`); WebKit allows **one `SyncAccessHandle` per file**
(the proxy refcounts to one) and serializes concurrent `FileReaderSync` of one
File (the reason for the input-read gate).

## Patch apply: ROM copier headers

Some dumps carry a copier header the patch author may or may not have included
(`crates/rom-weaver-checksum/src/rom_headers.rs` is the source of truth:
signatures, size-modulus rules, per-header `headered_extension` /
`headerless_extension`, and `retained_on_output`). Patch apply handles this with
two symmetric policies (`crates/rom-weaver-cli/src/patch_apply.rs`):

- **`--patch-header auto|keep|strip`** - which bytes each patch applies against.
  Auto decides **per patch in the chain** on checksum proof: the patch's
  embedded source CRC32 (or the first patch's `[crc32:..]` filename token) is
  compared against the current bytes vs their headerless/re-headered
  counterpart, and the header is stripped or restored between steps
  (`chain_header_transition`) only when the proof matches. The flag is
  positional and repeatable - each occurrence binds to the preceding `--patch`
  and carries forward (`align_patch_header_modes` re-derives the interleave from
  raw clap indices).
- **`--output-header auto|keep|strip`** - whether the single final output
  carries the header. Auto keeps emulator-required format headers (iNES/FDS/
  LNX/A78) and drops junk copier headers (SNES/PCE/Game Doctor) - except an
  NSRT-signed SNES copier header (`NSRT` at 0x1e8), which carries real dump
  metadata and comes back, matching the RUP handler's own normalization. When
  the final header state changes the ROM's conventional extension, the CLI
  adjusts the `--output` extension (`.smc` ↔ `.sfc`) and notes it in the
  report label.

The browser mirrors the decision instead of re-hashing: staging's checksum
variants carry a `remove-header` row (`transforms.removeHeader` with
`strippedBytes`, `retainOnOutput`, and the extension pair), the first patch's
mode is resolved in TS (`lib/workflow/apply-header-resolution.ts`) and sent
concretely, later chain entries are sent as `auto` for the engine to decide from
its own intermediates, and the download filename follows the engine's emitted
(possibly extension-adjusted) path.

## Dreamcast `.dcp` patches (the filesystem-level apply path)

Most patch formats are byte-stream transforms and fit `PatchHandler`. Universal
Dreamcast Patcher (`.dcp`) is different: it is a ZIP of per-file xdelta/VCDIFF
deltas (plus verbatim new files and an optional replacement `IP.BIN`) applied
*inside* a GD-ROM data track's ISO9660 filesystem, after which the filesystem is
rebuilt. It therefore does **not** register as a `PatchHandler`; it has a
dedicated path that rebuilds a whole disc track.

- **The app's `gdrom` module** is the filesystem layer. A Dreamcast high-density data
  track is `MODE1/2352` raw sectors whose ISO9660 records use *absolute* LBAs
  biased by the track start (45000). `sector` cooks 2352→2048; `GdRomFs::open(reader, start_lba)`
  parses the PVD/directory tree resolving extents at `lba − start_lba`;
  `iso_writer::build_iso` authors a cooked image back (deterministic, pinnable
  timestamp, +start_lba bias); `mode1::encode_mode1_sector` re-adds sync/header/
  EDC (poly `0x8001801B`) /ECC (GF(2⁸), poly `0x11D`) - validated byte-for-byte
  against real disc sectors. The first 16 sectors are the IP.BIN boot area and
  are carried through (or replaced) on rebuild.
- **The app's `dcp` module** owns the format: `zip` reads the central directory and
  inflates entries (miniz_oxide, no C deps → wasm-safe); `manifest` classifies
  each entry as `Delta`/`Verbatim`/`BootSector`; `apply::apply_dcp` produces each
  patched file via an I/O-free emit closure (so native and browser share it);
  `rebuild::rebuild_track_to_writer` plans the rebuilt layout from file *sizes*
  (a patched file's size is read from its VCDIFF header without decoding) and
  then **streams** the raw `MODE1/2352` track to a writer, producing each file's
  bytes on demand (delta applied against its freshly-read source, verbatim
  inflated, or untouched file read through) and dropping them immediately. The
  cooked image and raw track are never materialized, so peak memory scales with
  the largest single file's apply working set - not the disc or the patch.
- **CLI wiring.** `patch apply` detects a `.dcp` patch and routes to
  `crates/rom-weaver-cli/src/patch_apply_dcp.rs`, which requires a disc-sheet
  (`.cue`/`.gdi`) input, auto-selects the data track (largest track that opens
  as a `GdRomFs`), rebuilds it, then reuses the shared disc staging
  (`patch_apply_disc.rs`) to reassemble the full disc and compress to CHD by
  default (or write the disc beside the output sheet with `--no-compress`).

Parity note: output is currently *file-level* parity (every rebuilt file is
byte-correct, validated against the file-based xdelta handler), not necessarily
byte-identical to UDP's own disc image. Matching UDP's image byte-for-byte would
require reproducing DiscUtils' exact ISO9660 layout and is deferred.

## rom-weaver-bundle.json bundles

An `rom-weaver-bundle.json` bundle is a distributable patching-workflow definition: ordered
`patches` (each with a stable `id`, author-controlled `version`, editable `name`/`description`, an `optional` flag
(absent/false = applied by default), a free-form maturity `label`, and a
per-patch `header` mode), an optional `rom` entry, and
overridable `output` defaults (`name`/`header`). ROM state checks live on the
chain's endpoints: `rom.checks` describes the input ROM and `output.checks`
the result of applying the full chain. A patch only carries its own
`inputChecks`/`outputChecks` when they differ from those endpoints (mid-chain
steps) - `bundle create` drops endpoint-equal per-patch checks
automatically, so patches rely on the rom/output checks unless they differ.
Output compression always remains the applying user's choice. Every patch
entry's source is either a download `url` or a `path` relative to the bundle
(an archive member when the bundle ships inside an "everything archive" that
also bundles the ROM and patches). The `rom` entry may instead be *sourceless*
(checks/name only): the applying user supplies the ROM themselves and the
checks validate it - the default shape for distributable patch bundles; the
apply error for a sourceless bundle input and the webapp's ROM step both
surface the expected name/checksums/size so the user knows which ROM to
supply. Schema and the single shared parser live in
`crates/rom-weaver-cli/src/bundle_schema.rs` / `bundle_parse.rs`; validation
failures use stable `bundle.*` `ValidationCode`s. Bundle detection is
filename-based: exactly `rom-weaver-bundle.json`, `rom-weaver-bundle.json.<gz|bz2|xz|zst>`, or a root-level
`rom-weaver-bundle.json` archive member. Never name one `manifest.json` - the webapp service
worker runtime-caches that name.

- **Commands.** `bundle parse` loads any accepted packaging, resolves
  entries (extracting referenced archive members into `--output`,
  attaching ingest-grade patch descriptors), and returns a typed
  `BundleParseResult` under `details.bundle`. `bundle parse` also accepts the
  shared extraction options (`-s`/`--select`, `--filter`, `--no-extract`) for
  archive-packaged bundles. `bundle create` mirrors `patch apply`'s argument
  surface: the ROM comes from `-i`/`--input`, and it builds a validated bundle
  from local files (ROM checks computed from the real bytes, per-patch metadata
  flags - including `--patch-expect-in`/`--patch-expect-out` chain-state
  requirements - bound to the preceding `--patch` by argv index; `--expect-out`
  pins the final `output.checks`), emits plain/`.gz`/`.zst`, and `--bundle`s
  the bundle + sources into a creatable archive (the extension picks the
  format, e.g. `.zip`/`.7z`). `--no-bundle-rom` keeps the local ROM out of the
  bundle and emits its
entry checks-only. Create re-parses before writing, so it can never emit
  what parse rejects, and reports hash progress as running events (the
  webapp progress meter). `bundle create --from <file|->` bakes a canonical
  checksummed bundle from a hand-written spec (local `path` entries with
  optional/omitted checksums; explicit CLI flags override spec values, and a
  spec `$schema` is preserved), `--schema-ref <url>` stamps a `$schema` into
  the output (off by default to keep bytes stable), and `bundle schema` prints
  the JSON Schema. Bundles hand-authored with a `$schema` key are accepted on
  read. `patch apply --emit-bundle <path>` reuses this same pipeline to emit a
  byte-identical bundle after an apply, and `patch apply --tui` drives an
  interactive (dialoguer) authoring wizard over the `--patch` args.
- **Bundle-driven apply.** `patch apply` routes through
  `bundle_apply.rs` when it sees `--bundle <path-or-url>`, an
  `rom-weaver-bundle.json[.codec]` input, or an archive with a root `rom-weaver-bundle.json` and no
  explicit `--patch`. The resolver merges the bundle into a plain command;
  precedence is decided by field shape (explicit CLI value > bundle >
  built-in default). Non-optional patches seed the selection
  (`--with`/`--without` override; an interactive session prompts over every
  entry and Cancel keeps the defaults). Input validation merges `rom.checks`
  plus the FIRST selected patch's `inputChecks`; the expected output is the
  LAST selected patch's `outputChecks`, falling back to `output.checks` when
  the selection ends the full chain. A selected patch whose `inputChecks`
  disagree with its predecessor's `outputChecks` logs a warning (skipped
  chain step) rather than failing. Native builds download `url` entries via
  `ureq` (target-gated out of wasm); relative entry URLs resolve against the
  bundle's own URL.
- **Browser flow.** URL sessions are parsed once at boot in
  `src/webapp/url-session/`, fetched by the browser, resolved by the WASM
  `bundle parse` command, and delivered to the standard page-drop pipeline.
  Patch sources pass through `prepareInputFile`, so exported bundles contain
  their extracted patch leaves; ROM checks continue to use logical bytes while
  a suitable compressed source can be reused. The resulting
  `BundleApplySession` reconstructs each entry's effective chain checks from
  the ROM/output endpoints. Its display name derives from output or ROM naming
  because bundles have no top-level name field. Patch metadata and checksum
  fields live in each patch's Options drawer; output naming, bundle format,
  ROM inclusion, export progress, and the Export action live in Output. The
  public URL and same-origin OPFS host APIs are documented in
  [Webapp integration](webapp-integration.md).

## Rust ⇄ TypeScript boundary

- **Type generation.** `mise run typegen` (or
  `npm run typegen`) emits `rom-weaver-rust-types.d.ts`,
  `rom-weaver-format-metadata.ts`, and `rom-weaver-command-types.ts` into
  `packages/rom-weaver-webapp/src/wasm/generated/`. CI runs `--check`; any change to
  a `#[derive(TS)]` type or format registry metadata requires regenerating and
  committing. The generated format metadata is the single source for codec
  pickers and format tables in the webapp - do not hand-maintain duplicates.
- **Event protocol.** The wasm CLI is invoked with argv and `--json`; progress
  and results stream back as JSON lines (`RomWeaverRunJsonEvent`). The browser
  side never calls Rust functions directly - everything goes through the
  runner's argv/stdio surface, which is what keeps the native and browser CLIs
  behaviorally identical.
- **`ingest` - the mainline browser drop path.** The webapp routes every
  dropped input through the shared `ingest` command
  (`crates/rom-weaver-cli/src/ingest_command.rs`), one wasm call per source. It
  classifies the source into a `rom` or `patch` bucket, does nested archive/
  codec extraction, checksums each ROM leaf (variants + platform identity), and
  describes any patches - replacing the webapp's older separate classify →
  nested-extract → checksum (ROM) and classify → describe (patch) round-trips.
  A ROM source that also bundled sidecar patches carries both. The consolidated
  `IngestResult` rides the standard `OperationReport.details` envelope (under
  `details.ingest`) so the existing terminal-event parse layer keeps working,
  and stays a compile-checked Rust⇄TS shape via `#[derive(TS)]`. It has its own
  cli_smoke family (`crates/rom-weaver-cli/tests/cli_smoke/ingest.rs`).
- **Workers only.** The OPFS runtime requires a Dedicated Worker (sync OPFS
  access handles and SharedArrayBuffer are unavailable on the main thread).
  `packages/rom-weaver-webapp/src/workers/` hosts the worker entrypoints; the
  protocol types live in its `protocol/` directory.
- **Worker URLs always come from `?worker&url`.** A worker entrypoint is
  referenced as `import workerUrl from "./x.worker.ts?worker&url"`, never as
  `new URL("./x.worker.ts", import.meta.url)`. Only the `?worker&url` form makes
  Vite emit a *built* worker chunk; a bare `new URL()` that Vite's worker
  detection cannot statically match degrades to a plain asset copy and ships the
  raw TypeScript into `dist/assets/`, which then 404s or parse-fails in
  production (dev hides it by transforming `.ts` on the fly). Detection is
  fragile - it misses the URL inside a `??` chain, or when the `new Worker()`
  call lives in another module - so the import form is the rule, not a
  case-by-case judgement. Self-referential imports (a worker that transitively
  imports its own URL, as the WASI thread worker does to self-spawn) are fine:
  Vite collapses them to `self.location.href` inside that worker's own bundle
  and emits no duplicate chunk.

## Build graph

```
cargo build (workspace)                     # native CLI
mise run typegen                            # regen TS types when Rust types change
mise run build-wasm-prod                    # WASI SDK build → wasm-opt → brotli
                                            #   → sync into packages/rom-weaver-webapp/src/wasm
npm --prefix packages/rom-weaver-webapp run dev|build
```

The WASM build needs a WASI SDK (v33+, auto-detected; see
`scripts/wasm/detect-wasi-sdk.sh` and the `build-wasm` task in `.config/mise.toml`). Generated wasm artifacts in
`packages/rom-weaver-webapp/src/wasm` are gitignored; the generated *TypeScript*
files are
committed and drift-checked.

## Webapp UI - the loom workbench

The React webapp's presentation layer uses the "loom workbench" design
language (charcoal chassis, cartridge-orange thread accent, cream hash
readouts, sage verification).

- **Stylesheet.** One hand-written semantic sheet,
  `packages/rom-weaver-webapp/src/webapp/design-system.css`: design tokens on
  `:root[data-theme="dark"|"light"]` (`--thread`, `--plate`, `--seam`,
  `--ink-*`, ...), component rules scoped under `.rw-app`, webapp-only
  adaptations (React modal framework, codec combobox, platform ergonomics) at
  the end of the file. No utility classes, no CSS-in-JS, no Tailwind.
- **Shell.** `packages/rom-weaver-webapp/src/webapp/components/shell.tsx`
  (masthead, mode rail with the
  sliding thumb, reveal banners, selvage status strip),
  `packages/rom-weaver-webapp/src/webapp/components/log-dialog.tsx` (native
  `<dialog>` trace inspector over
  `packages/rom-weaver-webapp/src/webapp/log-store.ts`, which chains a
  capturing sink onto the logger). The selvage state comes from
  `packages/rom-weaver-webapp/src/lib/activity-store.ts`, which the workflow
  forms publish to (idle/running/done/failed + the active stage line).
- **Primitives.** `packages/rom-weaver-webapp/src/public/react/components/ds/`
  - the collapsible drawer
  (`drawer.tsx`, the `.cks` grid-rows pattern; replaces `<details>`), file
  cards, checksum rows (the whole row is the copy control), the weave meter +
  recessed progress panels, the 0x01 INPUTS hero/add-row drop zone, and the
  `needs-input` directives that point empty sections back to 0x01.
- **Steps.** Every workflow renders numbered loom stages: `0x01 Inputs`,
  then per-mode sections (apply: ROM/Patches/Apply; create:
  Original/Modified/Patch; trim: ROM/Trim).
- **Theming.** `<html data-theme>` via
  `packages/rom-weaver-webapp/src/webapp/theme.ts`; the toggle plays
  the circle-wipe view transition and updates `<meta name="theme-color">`.
- **Localization.** UI chrome strings live in the `ui.*` namespace of
  `packages/rom-weaver-webapp/src/presentation/localization/catalog.ts`
  (en/es/de) and are consumed via
  `useUiLocalizer()` (settings `language` → `createBrowserLocalizer`).
  Plural ids end in `.one`/`.other` and resolve via `Localizer.messageCount`.
- **Test hooks.** Browser tests rely on the `rom-weaver-*` element ids and a
  few structural classes (`.card`/`.file`, `.ck`/`.ck-k`/`.ck-v`,
  `.meter`/`.track`, `.outopts .cks-head`, `.rw-modal.select-modal .seltree`);
  keep them when touching the markup.

## Testing

| Layer | Where | What |
| --- | --- | --- |
| Rust unit | `crates/*/tests/unit/`, inline `#[test]` | Per-format parsers, registry, I/O, and threads. |
| CLI smoke | `crates/rom-weaver-cli/tests/cli_smoke/` | End-to-end CLI runs against synthesized fixtures, per command family. Shared helpers in `shared.rs`. |
| React unit | `packages/rom-weaver-webapp/tests/unit/` | Patcher state layer plus the loom UI contract (DS primitives, shell, stores, apply-view markup) - vitest, node/happy-dom. |
| WASM node | `packages/rom-weaver-webapp/tests/wasm/` | Worker client, OPFS protocols, format metadata (vitest, node). |
| Browser | `packages/rom-weaver-webapp/tests/browser/` | Playwright + vitest integration tests of the real worker/OPFS/wasm stack, including mobile-Safari-specific cases. |

The live app's axe-core audit runs from `packages/rom-weaver-webapp/scripts/run-webapp-e2e.mjs`
against the actual dev-server entrypoint and covers the workflow tabs and
Settings in both themes.

CI (`.github/workflows/ci.yml`) runs fmt, clippy `-D warnings`,
typegen drift check, wasm-target checks, the full Rust test suite, the wasm
build, and both packages' lint/type/test/build. `.config/lefthook.yml` mirrors the same
checks pre-commit, scoped by changed paths.

## Other docs

See the [documentation index](README.md) for runtime configuration, browser
protocols, verification guides, implementation notes, and format references.
