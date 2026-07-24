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
scripts/vendor-libarchive.sh <path-to-libarchive-checkout> [ref]
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

## `nod`, inlined into `rom-weaver-containers`

GameCube and Wii disc support comes from [encounter/nod](https://github.com/encounter/nod)
(MIT OR Apache-2.0). The source lives at
`crates/rom-weaver-containers/src/nod/`, with both upstream license files beside
it, and is exposed internally as `rom_weaver_containers::nod`.

The inlined copy is adapted from [encounter/nod](https://github.com/encounter/nod)
and is intentionally self-contained; no nod checkout is required to build or
publish rom-weaver. When a nod release lands with the needed API and feature
support, replace the copy with the registry crate:

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

But no release has been cut since 0.8.3 (2024-11-13), and a `git` dependency is
not an option because crates.io rejects any crate that has one. Keeping it as a
vendored workspace member would have meant publishing `rom-weaver-xdvdfs`, so
it is inlined instead.

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
- Edition 2024 fixes upstream never needed on 2021: `rng.gen()` → `rng.random()`
  and two `ref` bindings dropped for match ergonomics.
- Seven clippy fixes, because the module now falls under the workspace
  `-D warnings` gate.

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
