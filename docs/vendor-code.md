# Vendored third-party code

`rom-weaver` carries a few dependencies in-tree rather than taking them from
crates.io. Each one is a deliberate exception with a cost, and each should be
retired when upstream makes it unnecessary. This page records what is vendored,
why, and the exact steps to go back to upstream.

<!-- START doctoc -->
## Table of contents

- [The publishing constraint](#the-publishing-constraint)
- [What is vendored](#what-is-vendored)
- [`nod`, inlined into `rom-weaver-containers`](#nod-inlined-into-rom-weaver-containers)
- [`xdvdfs`, inlined into `rom-weaver-containers`](#xdvdfs-inlined-into-rom-weaver-containers)
  - [Why it is not a crates.io dependency](#why-it-is-not-a-cratesio-dependency)
  - [Going back to upstream when a release lands](#going-back-to-upstream-when-a-release-lands)
  - [Local changes against 0.8.3](#local-changes-against-083)
- [Validate after any vendor change](#validate-after-any-vendor-change)

<!-- END doctoc -->

## The publishing constraint

`cargo publish` rewrites every path dependency into a registry dependency and
then requires that crate to exist on crates.io. `rom-weaver-cli` is published so
that `cargo install rom-weaver-cli` works, and all 14 `rom-weaver-*` crates are
in its dependency graph. So **any vendored crate that is a workspace member must
also be published** — there is no way to publish a crate while keeping one of
its path dependencies private.

To see the current list:

```bash
cargo tree -p rom-weaver-cli -e normal | grep -o 'rom-weaver-[a-z-]*' | sort -u
```

That has one consequence worth stating plainly: vendoring someone else's crate
as a workspace member means publishing a renamed fork of their work under the
`rom-weaver-*` namespace, permanently. Where that is not acceptable, the source
is inlined as a module inside a crate that is already published instead. See
[`src/xdvdfs`](#xdvdfs-inlined-into-rom-weaver-containers) below.

## What is vendored

| Code | Form | Published as | Reason |
| --- | --- | --- | --- |
| `vendor/libarchive` | Git submodule | not a crate | C sources built by `rom-weaver-libarchive-sys/build.rs`, which bundles the tarball into its package |
| `vendor/nod` | Git submodule | — | Upstream `main` checkout used to refresh the inlined source; excluded from the workspace |
| `crates/rom-weaver-containers/src/nod` | Inlined module | not published | GameCube/Wii disc support without publishing a renamed `rom-weaver-nod` crate |
| `crates/rom-weaver-containers/src/xdvdfs` | Inlined module | not published | Upstream's published `write` feature forces `wax` |

Everything else that was once vendored has gone back upstream: `qbsdiff` and
`chd` now come from crates.io, and the `akv` wrapper was removed outright. That
is the preferred outcome whenever upstream can serve the need — inlining is the
fallback for when it cannot, and a published fork is the last resort.

`rom-weaver-libarchive-sys` is the only remaining case republishing a
third-party-facing package under the `rom-weaver-*` namespace.

## `nod`, inlined into `rom-weaver-containers`

GameCube and Wii disc support comes from [encounter/nod](https://github.com/encounter/nod)
(MIT OR Apache-2.0). The source lives at
`crates/rom-weaver-containers/src/nod/`, with both upstream license files beside
it, and is exposed internally as `rom_weaver_containers::nod`.

`vendor/nod` remains as the upstream `main` checkout for refreshing this copy;
it is not a Cargo dependency. To update nod, copy `vendor/nod/nod/src/` into
`crates/rom-weaver-containers/src/nod/`, keep the license files, rewrite its
`crate::` paths to `crate::nod::`, and retain only the compression/threading
features declared by `rom-weaver-containers`.

The inlined module drops nod's Python bindings and OpenSSL backend because
rom-weaver only uses the Rust disc reader/writer API. Keeping the source inside
the already-published containers crate avoids creating a publishable
`rom-weaver-nod` package for upstream code.

## `xdvdfs`, inlined into `rom-weaver-containers`

Xbox XISO support comes from [antangelo/xdvdfs](https://github.com/antangelo/xdvdfs)
(MIT). The source lives at `crates/rom-weaver-containers/src/xdvdfs/`, with
upstream's `LICENSE` beside it, and is re-exported as
`rom_weaver_containers::xdvdfs`.

### Why it is not a crates.io dependency

The published 0.8.3 release defines `write = ["std", "arrayvec", "wax"]`, so
using it pulls in `wax` and with it `nom` 7, `regex`, `pori`, `const_format`,
and `itertools` — six crates for a glob-remap module this project never calls.

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
   `use std::{…}` block.
4. Remove the dependencies that existed only for the inlined module from
   `crates/rom-weaver-containers/Cargo.toml` and the root
   `[workspace.dependencies]`: `arrayvec`, `async-trait`, `bincode`,
   `encoding_rs`, `maybe-async`, `proc-bitfield`, `serde-big-array`, and the
   `rand` dev-dependency. Drop the `[package.metadata.cargo-machete]`
   `async-trait` entry with them.

Call sites do not change. `rom_weaver_containers::xdvdfs::…` keeps working in
`rom-weaver-app` and `cli_smoke`, and the internal paths (`blockdev`, `layout`,
`read`, `write::fs`, `write::img`) match upstream's layout.

Also revisit the `RUSTSEC-2025-0141` ignore in `deny.toml`. `bincode` 1.3.3 is
surfaced by `unmaintained = "workspace"` because it is currently a direct
dependency of `rom-weaver-containers`; as a transitive dependency of a registry
crate it falls outside that scope and the ignore can likely go.

### Local changes against 0.8.3

The module is **not** a verbatim copy — `#![no_std]` and `#[cfg(feature = "…")]`
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
than a silent no-op — which is the safer failure, but it is new.

## Validate after any vendor change

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
cargo test --workspace
mise run deny                                          # advisories, licenses, sources
mise run machete                                       # unused dependencies
cargo publish --workspace --exclude rom-weaver-typegen --locked --dry-run
```

The publish dry-run is the one that catches vendoring mistakes the compiler
cannot: it fails if a path dependency would need to exist on crates.io and does
not. Check its crate list against what you intend to publish.
