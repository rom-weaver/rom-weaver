# Vendored third-party code

`rom-weaver` carries a few dependencies in-tree rather than taking them from
crates.io. Each one is a deliberate exception with a cost, and each should be
retired when upstream makes it unnecessary. This page records what is vendored,
why, and the exact steps to go back to upstream.

<!-- START doctoc -->
## Table of contents

- [The publishing constraint](#the-publishing-constraint)
- [What is vendored](#what-is-vendored)
- [`libarchive`, inlined into `rom-weaver-containers`](#libarchive-inlined-into-rom-weaver-containers)
  - [Refreshing the snapshot](#refreshing-the-snapshot)
  - [Going back to upstream](#going-back-to-upstream)
- [LZMA SDK, inlined into `rom-weaver-containers`](#lzma-sdk-inlined-into-rom-weaver-containers)
  - [The SDK encoder is native-only](#the-sdk-encoder-is-native-only)
  - [Which platforms get the assembly decode loop](#which-platforms-get-the-assembly-decode-loop)
- [`nod`, inlined into `rom-weaver-containers`](#nod-inlined-into-rom-weaver-containers)
- [`xdvdfs`, inlined into `rom-weaver-containers`](#xdvdfs-inlined-into-rom-weaver-containers)
  - [Why it is not a crates.io dependency](#why-it-is-not-a-cratesio-dependency)
  - [Going back to upstream when a release lands](#going-back-to-upstream-when-a-release-lands)
  - [Local changes against 0.8.3](#local-changes-against-083)
- [Validate after any vendor change](#validate-after-any-vendor-change)

<!-- END doctoc -->

## The publishing constraint

`cargo publish` rewrites every path dependency into a registry dependency and
then requires that crate to exist on crates.io. `rom-weaver-cli` is intended for
publication so that `cargo install rom-weaver-cli` can work after the first
release. Every internal path dependency in its graph must therefore also be
published. There is no way to publish a crate while keeping one of its path
dependencies private.

To see the current list:

```bash
cargo tree -p rom-weaver-cli -e normal | grep -o 'rom-weaver-[a-z-]*' | sort -u
```

That has one consequence worth stating plainly: vendoring someone else's crate
as a workspace member means publishing a renamed fork of their work under the
`rom-weaver-*` namespace, permanently. Where that is not acceptable, the source
is inlined as a module inside a crate that will already be part of the release.
See [`src/xdvdfs`](#xdvdfs-inlined-into-rom-weaver-containers) below.

## What is vendored

| Code | Form | Packaged as | Reason |
| --- | --- | --- | --- |
| `crates/rom-weaver-containers/libarchive/vendor/libarchive` | Inlined C sources | part of `rom-weaver-containers` | Built by `crates/rom-weaver-containers/libarchive/build.rs`; carries local patches upstream has not taken |
| `crates/rom-weaver-containers/lzma-sdk/vendor/C` | Inlined C sources | part of `rom-weaver-containers` | 7-Zip's own LZMA1/LZMA2 coders, so the 7z paths match `7zz` speed instead of liblzma's |
| `crates/rom-weaver-containers/src/nod` | Inlined module | part of `rom-weaver-containers` | GameCube/Wii disc support without publishing a renamed `rom-weaver-nod` crate |
| `crates/rom-weaver-containers/src/xdvdfs` | Inlined module | part of `rom-weaver-containers` | Upstream's published `write` feature forces `wax` |

Everything else that was once vendored has gone back upstream: `qbsdiff` and
`chd` now come from crates.io, and the `akv` wrapper was removed outright. That
is the preferred outcome whenever upstream can serve the need. Inlining is the
fallback for when it cannot, and a published fork is the last resort.

No vendored dependency has its own `rom-weaver-*` package.

## `libarchive`, inlined into `rom-weaver-containers`

The libarchive C sources live at
`crates/rom-weaver-containers/libarchive/vendor/libarchive/`, and
`libarchive/build.rs` builds them with CMake. They are the only libarchive
source rom-weaver builds - a local `cargo build` and a `cargo install
rom-weaver-cli` compile the same tree.

Local patches are developed in the fork
[brandonocasey/libarchive](https://github.com/brandonocasey/libarchive), which
keeps the reviewable history against upstream and is where a contribution back
to upstream starts. The inlined copy is a snapshot of one fork commit, recorded
in `crates/rom-weaver-containers/libarchive/vendor/LIBARCHIVE_VERSION`.

### Refreshing the snapshot

```bash
node scripts/vendor-libarchive.mjs <path-to-libarchive-checkout> [ref]
```

The script copies `git archive` output and prunes what the build never
compiles: the five test trees (`libarchive/test` alone is ~13 MB of test data,
plus `cat`, `cpio`, `tar`, and `unzip`), `test_utils`, `doc`, `examples`,
`contrib`, and `.github`. `build.rs` sets `ENABLE_TEST=OFF`, so none of it is
ever built. **Do not prune anything else CMake reads** - that would force an
edit to the vendored tree and turn every future refresh from a copy into a
merge.

There is one wrinkle: upstream calls `add_subdirectory(test)` unconditionally in
all five directories and lets the test tree itself check `ENABLE_TEST`, so a
pruned tree fails to *configure* even with tests off. `build.rs` strips those
five calls (`TEST_SUBDIRECTORY_OWNERS`). If a refresh ever fails with
`add_subdirectory given source "test" which is not an existing directory`, that
list and the script's prune list have drifted apart.

Pruning is also what keeps the published crate viable: the full tree packages to
about 6.3 MB against crates.io's 10 MiB limit, the pruned one to about 1.3 MB.

Every transformation - the test-subdirectory strip, the wasm patches in
`libarchive/patches/wasm/`, and the `CMakeLists.txt` source-list edits - is
applied to a staged copy under `OUT_DIR`, never to the committed tree.

### Going back to upstream

There is no version of this that ends in a crates.io dependency - libarchive is
a C library, and `libarchive-sys` style crates do not carry the local patches or
the wasm build. The realistic end state is upstream accepting the fork's
commits, at which point the fork resets to an upstream tag and the snapshot is
refreshed from it. Track that in the fork's branches, not here.

## LZMA SDK, inlined into `rom-weaver-containers`

7-Zip's own LZMA SDK (public domain) supplies the LZMA1/LZMA2 coders the 7z
reader and writer use. The C sources live at
`crates/rom-weaver-containers/lzma-sdk/vendor/C/`, upstream's `lzma-sdk.txt`
sits beside them, and `libarchive/build.rs` compiles them with `cc` into a
`lzma_sdk` static library that links after `libarchive.a`.

Why it is here at all: liblzma is a *format* library first, and its LZMA2
encoder/decoder are measurably slower than 7-Zip's, which is what `7zz` itself
runs. Matching 7zz's wall time on 7z create/extract is not reachable through
liblzma, and the SDK is public domain so vendoring it costs nothing in license
surface.

The exact upstream drop is pinned in
`crates/rom-weaver-containers/lzma-sdk/LZMA_SDK_VERSION` (version, source URL,
and the SHA-256 of the published `.7z`). Refresh it with:

```bash
node scripts/vendor-lzma-sdk.mjs           # re-fetch the pinned version
node scripts/vendor-lzma-sdk.mjs 26.03     # move the pin
```

The script fetches `https://www.7-zip.org/a/lzma<ver>.7z`, extracts it with
whatever 7z reader is on `PATH`, and copies only the files the coders need
(`VENDORED_FILES` in the script): LZMA1/LZMA2 encode+decode, the match finders,
the SDK's `Threads`/`MtCoder`/`MtDec` layer, and the shared headers. Everything
else in the SDK's `C/` directory - AES, PPMd, BCJ2, the 7z archive reader, the
sample programs - stays out of the tree. The copy is **verbatim**: there are no
local patches, and a refresh is a copy rather than a merge. Keep it that way.

Build wiring lives in `libarchive/build.rs`:

- `build_lzma_sdk` compiles the sources at `-O3` regardless of the Cargo
  profile. They are third-party coders nobody steps through, and a debug-profile
  build of them makes the test suite unusably slow.
- The threaded units (`LzFindMt`, `MtCoder`, `MtDec`, `Threads`) are dropped and
  `Z7_ST` is defined on **every** wasm target, which also drops the glue's
  encoder bridge and leaves `rom-weaver-app.wasm` encoding 7z with liblzma. See
  [The SDK encoder is native-only](#the-sdk-encoder-is-native-only) for why. The
  *decoder* is unaffected and stays on the SDK everywhere - `LzmaDec` and
  `Lzma2Dec` have no threads.
- `Z7_AFFINITY_DISABLE` is set on every wasm target: wasi-libc has no
  `sched_setaffinity` and no `<cpuid.h>`/`<sys/auxv.h>`.
- The SDK's hand-written decode loop (`vendor/Asm/`, selected with
  `Z7_LZMA_DEC_OPT`) replaces `LzmaDec.c`'s C loop wherever it can be
  assembled. It is the same bitstream and is what `7zz` itself runs; it is worth
  ~26% of a 1 GiB LZMA1 extract, and **without it the SDK's C decoder is no
  faster than liblzma's** - the whole 7z extract win is this file. Which
  platforms get it is the matrix below.

### The SDK encoder is native-only

The SDK's LZMA2 encoder is a blocking one-shot over stream callbacks, so
`glue/rom_weaver_lzma_sdk.c` drives it from a thread of its own and rendezvouses
with libarchive's push-shaped `la_zstream`. The SDK then spawns its own
match-finder and block threads **from that thread**, and those nested spawns do
not survive the browser's WASI thread pool:

- A run that asks for one thread gets a *zero-sized* pool
  (`resolveBrowserThreadPoolSizeFromCount` returns 0 for `<= 1`), so even the
  bridge thread fails with `EAGAIN` and no 7z archive can be written at all.
- With a large pool the bridge thread starts, but the SDK's nested spawn from it
  never gets its start ack and comes back `SZ_ERROR_THREAD` carrying errno 6.

liblzma's encoder spawns its workers from the main thread, which the pool
handles, and it is genuinely parallel there - so wasm keeps it. Forcing the SDK
encoder single-threaded to fit would have made every `effective_threads > 1` the
browser reports a lie.

`lzma_sdk_threads_enabled()` in `libarchive/build.rs` is the single switch:
false for wasm, which drops `Z7_ST`-guarded code from the SDK build and leaves
`ROM_WEAVER_LZMA_SDK_MT` undefined so the writer never reaches for it. The
planner in `handlers/sevenz.rs` mirrors the split with `cfg(target_family =
"wasm")` so its worker-memory and parallelism model describes the backend that
actually runs.

Native builds keep a second safety net: if the bridge thread cannot start for
any reason, `compression_init_encoder_lzma2_sdk` returns `ARCHIVE_FAILED`
without setting an archive error and the writer falls through to liblzma.

### Which platforms get the assembly decode loop

| Target | Decode loop | Why |
| --- | --- | --- |
| `aarch64-*` (macOS, Linux, Windows) | assembly, always | `Asm/arm64/LzmaDecOpt.S` is GNU-as syntax; clang assembles it with no extra tool |
| `x86_64-*-linux-*`, BSDs | assembly when a MASM-compatible assembler is on `PATH` | `Asm/x86/LzmaDecOpt.asm` is MASM syntax and no C compiler reads it. `-elf64 -DABI_LINUX` |
| `x86_64-pc-windows-*` | assembly when `ml64` (or jwasm/asmc/uasm) is on `PATH` | MSVC's own `ml64` is already there under `VsDevCmd`. `-win64` |
| `x86_64-apple-darwin` | C loop, always | Nothing in reach emits Mach-O: jwasm has no Mach-O writer, asmc only bootstraps on an x86 host, and uasm's tree does not compile on a current Unix host |
| `i686-*`, other arches | C loop | The SDK ships no loop this build uses for them |
| `wasm32-*` | C loop | No assembler |

`build.rs` probes `jwasm`, `asmc`, `asmc64`, `uasm`, then `ml64`, or takes an
explicit path from `ROM_WEAVER_LZMA_ASM` (`ROM_WEAVER_UASM` is accepted as an
alias). **A missing assembler is never a build failure** - it prints a
`cargo:warning` naming what it looked for and compiles the C loop instead. A
build that found one says so in a warning too, so which loop a binary carries is
always visible in its build log.

`scripts/install-jwasm.sh` builds and installs the assembler (pinned to JWasm
`v2.20`; plain C, builds anywhere in seconds). It runs in the `Dockerfile`
builder stage on `amd64`, in `.github/actions/build-cli-platform` for the native
x86-64 Linux leg, and in `ci.yml`'s Rust job so the test suite actually covers
the x86-64 loop. JWasm rather than the alternatives because asmc is itself
written in assembly (so it only bootstraps on an x86 host, and its repo ships
prebuilt binaries instead) and uasm's tree no longer compiles on a current Unix
host; all three emit a byte-identical object from this source.

**Known gap:** the `linux-x64-musl` npm package builds through `cross`, which
compiles inside cross-rs' own container where that script never runs, so that
one binary keeps the C loop. Closing it means a repo-root `Cross.toml` with a
`pre-build` that inlines the install (the project directory is not mounted
during `pre-build`, so it cannot call the script), which would apply to every
`cross` leg of the release fan-out. `linux-x64-gnu`, the Docker image, and
anything built from source with the assembler present are unaffected.

The libarchive CMake build gets `-DROM_WEAVER_LZMA_SDK=1` plus the SDK include
directory, so the 7z sources can gate every SDK code path behind one define and
still build on liblzma alone if the vendor drop is absent.

## `nod`, inlined into `rom-weaver-containers`

GameCube and Wii disc support comes from [encounter/nod](https://github.com/encounter/nod)
(MIT OR Apache-2.0). The source lives at
`crates/rom-weaver-containers/src/nod/`, with both upstream license files beside
it, and is exposed internally as `rom_weaver_containers::nod`.

The inlined copy is adapted from [encounter/nod](https://github.com/encounter/nod)
and is intentionally self-contained; no nod checkout is required to build or
publish rom-weaver.

Its base is recorded in `crates/rom-weaver-containers/src/nod/NOD_VERSION`. Local
patches are developed in the fork
[brandonocasey/nod](https://github.com/brandonocasey/nod) on the `local-changes`
branch, which is kept as upstream `main` plus whatever is currently out for
review upstream ([#27](https://github.com/encounter/nod/pull/27) and
[#28](https://github.com/encounter/nod/pull/28) today). Anything that lands
upstream is dropped from `local-changes` rather than carried twice.

Unlike `LIBARCHIVE_VERSION`, `NOD_VERSION` records a **base, not a mirror**, and
it lists the exact categories the two trees differ by. There is no `vendor-nod`
script, so re-syncing is a deliberate merge rather than a copy.

Most of the apparent drift is formatting: nod's `rustfmt.toml` uses nightly-only
options (`fn_single_line`, `use_small_heuristics = "Max"`, `imports_granularity`)
while this repo has no `rustfmt.toml` and takes stable defaults. Format both sides
the same way before drawing any conclusion from a diff - `io/wia.rs` looks like
250 changed lines and is actually identical.

The audit behind that list was done by copying both trees into a neutral
directory, rewriting `crate::nod::` back to `crate::`, running the same stable
`rustfmt` over both, and diffing:

```bash
rsync -a --include='*/' --include='*.rs' --exclude='*' <fork>/nod/src/ /tmp/a/
rsync -a --include='*/' --include='*.rs' --exclude='*' \
  crates/rom-weaver-containers/src/nod/ /tmp/b/
mv /tmp/a/lib.rs /tmp/a/mod.rs
find /tmp/b -name '*.rs' -exec sed -i '' 's/crate::nod::/crate::/g' {} +
for f in $(cd /tmp/b && find . -name '*.rs'); do
  rustfmt --edition 2021 --emit files /tmp/a/$f /tmp/b/$f; diff /tmp/a/$f /tmp/b/$f
done
```

Anything that diff reports outside the categories in `NOD_VERSION` is a real
divergence and should be either upstreamed or written down.

When a nod release lands with the needed API and feature support, replace the copy
with the registry crate:

1. Verify the release contains the required Rust disc reader/writer APIs and
   compression/threading features.
2. Add the released `nod` version to `[workspace.dependencies]` and make it a
   dependency of `rom-weaver-containers`.
3. Replace `pub mod nod;` with a re-export of the dependency so the public
   `rom_weaver_containers::nod` path remains stable.
4. Remove `crates/rom-weaver-containers/src/nod/` and its copied license files,
   then remove any dependencies used only by the inlined implementation.
5. Run `cargo test --workspace` and
   `cargo publish --workspace --locked --dry-run --no-verify` before deleting
   this section.

The inlined module drops nod's Python bindings and OpenSSL backend because
rom-weaver only uses the Rust disc reader/writer API. Keeping the source inside
the containers crate avoids creating a `rom-weaver-nod` package for upstream
code.

## `xdvdfs`, inlined into `rom-weaver-containers`

Xbox XISO support comes from [antangelo/xdvdfs](https://github.com/antangelo/xdvdfs)
(MIT). The source lives at `crates/rom-weaver-containers/src/xdvdfs/`, with
upstream's `LICENSE` beside it, and is re-exported as
`rom_weaver_containers::xdvdfs`.

Its base is recorded in `crates/rom-weaver-containers/src/xdvdfs/XDVDFS_VERSION`,
including the crates.io checksum of the exact `.crate` it came from. Like
`NOD_VERSION` it records a **base, not a mirror**, and lists the categories the
two trees differ by; see [Local changes against
0.8.3](#local-changes-against-083) below for the narrative version.

Two things make a diff against upstream awkward. Upstream 0.8.3 is edition 2021
and this workspace is edition 2024, so neither side parses under the other's
edition and each has to be formatted under its own. And unlike nod, formatting is
*not* a source of noise here - neither project has a `rustfmt.toml`, so both
already use stable defaults.

### Why it is not a crates.io dependency

The published 0.8.3 release defines `write = ["std", "arrayvec", "wax"]`, so
using it pulls in `wax` and with it `nom` 7, `regex`, `pori`, `const_format`,
and `itertools`: six crates for a glob-remap module this project never calls.

Upstream `main` **already fixes this**, moving `wax` behind its own `remap`
feature:

```toml
write = ["std"]
remap = ["dep:wax"]
```

That is [antangelo/xdvdfs#189](https://github.com/antangelo/xdvdfs/pull/189)
(`6b05af7`, merged 2026-07-18). It matters for reading this vendored tree: in
0.8.3 the `remap` module is declared unconditionally, so there is no feature to
turn it off, and the inlined copy simply deletes it. The content here is
therefore 0.8.3 plus the outcome of that commit, which is why `XDVDFS_VERSION`
records the sha alongside the release.

But no release has been cut since 0.8.3 (2024-11-13) — still true as of
2026-07-25, with crates.io's `write` feature still listing `wax` — and a `git`
dependency is not an option because crates.io rejects any crate that has one.
Keeping it as a vendored workspace member would have meant publishing
`rom-weaver-xdvdfs`, so it is inlined instead.

### Going back to upstream when a release lands

**Check first:** a release only helps if it contains the `remap` split above.
Confirm the published manifest has `write` without `wax`:

```bash
cargo info xdvdfs                       # is there anything newer than 0.8.3?
curl -s -H 'User-Agent: rom-weaver' \
  https://crates.io/api/v1/crates/xdvdfs | jq '.versions[0].features'
```

If `write` still lists `wax`, stay inlined.

Once it does not, the swap is four steps:

1. Delete `crates/rom-weaver-containers/src/xdvdfs/`.
2. Add the dependency to the root `Cargo.toml` `[workspace.dependencies]`:

   ```toml
   xdvdfs = { version = "0.9", default-features = false, features = ["std", "read", "write", "sync"] }
   ```

   Then `xdvdfs.workspace = true` in `crates/rom-weaver-containers/Cargo.toml`.
3. In `crates/rom-weaver-containers/src/lib.rs`, replace `pub mod xdvdfs;` with
   `pub use ::xdvdfs;`, and drop the `extern crate alloc;` line above the
   `use std::{...}` block.
4. Remove the dependencies that existed only for the inlined module from
   `crates/rom-weaver-containers/Cargo.toml` and the root
   `[workspace.dependencies]`: `arrayvec`, `async-trait`, `bincode`,
   `encoding_rs`, `maybe-async`, `proc-bitfield`, `serde-big-array`, and the
   `rand` dev-dependency. Drop the `[package.metadata.cargo-machete]`
   `async-trait` entry with them.

Call sites do not change. `rom_weaver_containers::xdvdfs::...` keeps working in
`rom-weaver-cli` and `cli_smoke`, and the internal paths (`blockdev`, `layout`,
`read`, `write::fs`, `write::img`) match upstream's layout.

Also revisit the `RUSTSEC-2025-0141` ignore in `.config/deny.toml`. `bincode` 1.3.3 is
surfaced by `unmaintained = "workspace"` because it is currently a direct
dependency of `rom-weaver-containers`; as a transitive dependency of a registry
crate it falls outside that scope and the ignore can likely go.

### Local changes against 0.8.3

The module is **not** a verbatim copy. `#![no_std]` and `#[cfg(feature = "...")]`
are crate-level concepts that cannot survive being moved into a module. The
deltas are listed at the top of `src/xdvdfs/mod.rs`; in short:

- `#![no_std]` dropped; `extern crate alloc;` moved to the `rom-weaver-containers`
  crate root so the source's `use alloc::*` imports still resolve.
- Feature gates resolved to the pinned set (`std`, `read`, `write`, `sync` on;
  `logging`, `checksum`, `ciso_support`, `wax` off). Left alone, those cfgs
  would have resolved against `rom-weaver-containers`' own features and silently
  deleted the code they guard. Disabled-feature code is removed, not gated.
- `crate::` paths rewritten to `crate::xdvdfs::`.
- Edition 2024 fixes upstream never needed on 2021: `rng.gen()` → `rng.random()`,
  two `ref` bindings dropped for match ergonomics, and `if let` pairs collapsed
  into let chains in `write/avl.rs`.
- Seven clippy fixes, because the module now falls under the workspace
  `-D warnings` gate, including `% n > 0` → `!is_multiple_of(n)` and `<'_>`
  lifetime elision.
- `#[repr(C)]` dropped from a bitfield newtype in `layout.rs`: proc-bitfield 0.5
  makes those `#[repr(transparent)]` itself, so the explicit attribute became a
  hard error. The layout is unchanged.
- **`layout.rs`'s two tests are not carried over.** They need `futures::executor`
  and `futures` is not a dependency of `rom-weaver-containers`. The other nine
  upstream tests (`util.rs` 3, `write/avl.rs` 6) are kept and run. This is the
  only place the inlining costs coverage; adding `futures` as a dev-dependency
  would let them come back.

One coupling to know about: `handlers/xiso.rs` matches `ProgressInfo`
exhaustively with no `_` arm. rustc suppresses the unreachable-pattern lint for
foreign enums so upstream can add variants, but not for local ones. A future
upstream version that adds a variant will therefore be a compile error rather
than a silent no-op, which is the safer failure, but it is new.

## Validate after any vendor change

Every vendored source is a normal committed file, so these run the same from a
linked worktree as from the main checkout.

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
cargo test --workspace
mise run deny                                          # advisories, licenses, sources
mise run machete                                       # unused dependencies
cargo publish --workspace --locked --dry-run --no-verify
```

The publish dry-run checks every package and its file list without uploading.
Workspace tests compile the local dependency graph. `--no-verify` keeps Cargo
from replacing same-version workspace dependencies with older copies from the
registry while checking each tarball.
