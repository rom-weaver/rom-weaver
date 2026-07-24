# Development guide

rom-weaver is a Rust workspace with a native CLI and a React webapp backed by a
threaded WASI module. [mise](https://mise.jdx.dev) pins the Rust, Node.js,
and Binaryen versions and exposes the repository's build and test
tasks.

<!-- START doctoc -->
## Table of contents

- [Prerequisites](#prerequisites)
- [Clone and bootstrap](#clone-and-bootstrap)
- [Build and run the webapp](#build-and-run-the-webapp)
- [Build and run the native CLI](#build-and-run-the-native-cli)
- [Test and lint](#test-and-lint)
- [Generated files](#generated-files)
- [Dependencies](#dependencies)
  - [bzip2 backend](#bzip2-backend)
- [Linked worktrees](#linked-worktrees)
- [Project map](#project-map)

<!-- END doctoc -->

## Prerequisites

Install these system tools before the first build:

- [mise](https://mise.jdx.dev)
- CMake, Clang, and a native compiler toolchain
- [WASI SDK](https://github.com/WebAssembly/wasi-sdk/releases) for web builds
- Brotli for optimized production WASM builds
- sccache (optional) to speed up repeated Rust builds

On macOS with Homebrew:

```bash
brew install mise cmake llvm brotli sccache
```

WASI SDK is detected in `/opt/wasi-sdk`, `/opt/homebrew/opt/wasi-sdk`, or
`~/.local/toolchains/wasi-sdk-<version>`. Set `WASI_SDK_PATH` when it is
installed elsewhere.

## Clone and bootstrap

All vendored source is committed in-tree, so a plain clone is complete:

```bash
git clone https://github.com/rom-weaver/rom-weaver.git
cd rom-weaver
```

Trust and install the pinned toolchains, install both JavaScript dependency
sets, and install the repository hooks:

```bash
mise trust
mise install
npm ci
npm ci --prefix packages/rom-weaver-webapp
npm --prefix packages/rom-weaver-webapp exec playwright -- install chromium
npm run hooks:install
```

Run `mise tasks` at any time to list the supported task entry points.

## Build and run the webapp

Choose the WASM build that matches the task:

```bash
mise run wasm-check        # type-check the threaded WASI target
mise run build-wasm        # fast development build
mise run build-wasm-prod   # optimized release build with wasm-opt and Brotli
```

Then start the HTTPS development server:

```bash
npm run dev
```

The server prints its local URL. To choose another port:

```bash
npm run dev -- --port 5174
```

The local certificate may need a one-time browser exception. HTTPS and the
server's COOP/COEP headers are required to exercise the same
`SharedArrayBuffer` runtime used in production.

`npm run dev` checks the WASM artifact and rebuilds it when the Rust sources
are newer. Run `mise run build-wasm` directly when changing the WASM toolchain
or when you need to see the complete build output.

By default, build artifacts are written to
`packages/rom-weaver-webapp/src/wasm/`, which is gitignored. To keep a separate
artifact directory:

```bash
ROM_WEAVER_WASM_OUT_DIR=/path/to/artifacts mise run build-wasm
```

The build synchronizes the artifacts back into the webapp package when the
custom directory differs from the default. The threaded target flags and WASI
compiler wiring live in `.cargo/config.toml` and `.mise.toml`; use `mise exec`
for ad hoc target commands:

```bash
mise exec -- cargo check -p rom-weaver-containers --target wasm32-wasip1-threads
```

See the [WASM runtime notes](../packages/rom-weaver-webapp/src/wasm/README.md)
for the browser OPFS and worker API.

## Build and run the native CLI

```bash
cargo build -p rom-weaver-cli
cargo run -p rom-weaver-cli --bin rom-weaver -- --help
```

The `rom-weaver-cli` package contains the reusable `rom_weaver_app` command
library plus the native CLI, WASM entrypoint, and type generator.

## Test and lint

Run the complete local quality gate before submitting a change:

```bash
mise run ci
```

That task covers Rust formatting, Clippy, generated types, threaded-WASM
guards, license inventory, workflow/shell/Dockerfile linting, Rust tests, the
production WASM build, frontend linting, unit tests, browser/WASM tests,
full-browser tests, webapp E2E, and the production frontend build.

The frontend `lint` command is the source of truth for formatting, Oxlint and
Biome (including complexity limits), TypeScript, browser compatibility, unused
exports, copy/paste duplication, i18n catalog integrity, and the legacy-string
audit. The pre-commit hook selects these and the Rust checks from the staged
paths; CI runs its lint jobs over the whole tree.

Useful narrower checks:

```bash
mise run fmt
mise run clippy
mise run test-rust
mise run typegen-check
mise run actionlint    # GitHub Actions workflows and composite actions
mise run shellcheck    # tracked shell scripts
mise run hadolint      # Dockerfiles

npm --prefix packages/rom-weaver-webapp run lint    # complete frontend lint fan-out
npm --prefix packages/rom-weaver-webapp run test:unit
npm --prefix packages/rom-weaver-webapp run test:browser
```

Use the repository's browser-test runner instead of invoking browser Vitest
directly; it isolates files and avoids browser-mode hangs in linked worktrees.

The fast end-to-end gate is also available separately:

```bash
mise run test-e2e-fast
```

The [Mobile Safari guide](mobile-safari-verification.md) owns the WebKit,
nightly matrix, iOS Simulator, and real-device verification procedures.

## Generated files

When Rust command types or metadata change, regenerate the TypeScript surface:

```bash
mise run typegen
mise run typegen-check
```

The build generates third-party attribution files from the resolved Cargo
dependency graph. Public-domain and no-attribution-only licenses are omitted.
To check that generation still works:

```bash
mise run licenses-check
```

When Clap commands or argument help changes, regenerate the man pages from
those definitions (they are generated artifacts, not checked in):

```bash
mise run manpages
```

Do not edit files under
`packages/rom-weaver-webapp/src/wasm/generated/` or `docs/man/` manually.

## Dependencies

`.config/deny.toml` owns the dependency policy - advisories, licenses, and sources.
Check it with:

```bash
mise run deny             # advisories + licenses + sources
mise run deny-policy      # licenses + sources only (the gating half)
mise run deny-advisories  # advisories only
mise run machete          # unused Rust dependencies
```

The two halves are split because CI treats them differently. Licenses and
sources gate the build - they change only when we add a dependency, so a
violation is fixable in the same commit. Advisories run in the separate,
non-gating `security` job alongside `npm audit`: a CVE is published against a
transitive dependency with no commit of ours, and a red check on every open
pull request would block unrelated work. Findings show up as job annotations
and a run summary, and are still expected to get fixed.

New crates must resolve to an already-allowed license. When one does not,
prefer a per-crate entry in `exceptions` over widening the global `allow`
list, and write down why - a scoped entry keeps the next crate carrying that
license from landing unnoticed.

### bzip2 backend

`bzip2` exposes two backends and picks one with
`#[cfg(feature = "bzip2-sys")]`: the C `bzip2-sys` library, or the pure-Rust
`libbz2-rs-sys`. The workspace pins `bzip2` to `default-features = false,
features = ["bzip2-sys"]`, which keeps every build on the C backend.

**That pin is load-bearing.** Cargo unions features across the graph, and
upstream `qbsdiff` depends on `bzip2` with default features on, so
`libbz2-rs-sys` is present in the dependency graph regardless. The workspace
pin is the only thing keeping `bzip2-sys` selected; drop it and the bzip2
implementation underneath BDF patch output silently swaps.

`libbz2-rs-sys` therefore compiles but is never linked. Keep the scoped
`.config/deny.toml` exception for its `bzip2-1.0.6` license. If `qbsdiff` later exposes
a feature that disables its default bzip2 backend, remove the extra backend
and the exception together.

## Linked worktrees

After creating a linked worktree, run its setup helper before building or
testing:

```bash
./scripts/setup-worktree.sh
```

It installs package dependencies and copies existing WASM artifacts when
available.

After verifying that a worktree has no real changes, remove it from the main
checkout with:

```bash
scripts/remove-worktree.sh .worktrees/<name>
```

## Project map

- `crates/` contains the Rust format libraries, shared app orchestration, and
  native CLI.
- `packages/rom-weaver-webapp/` contains the React app, browser workers, OPFS
  adapters, PWA shell, and WASM package surface.
- `scripts/` contains build, test, release, and license automation.
- `docs/` contains deployment, runtime, verification, and architecture guides.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full crate graph, ownership
boundaries, worker model, generated-type path, and browser runtime flow.
