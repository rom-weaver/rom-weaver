<h1 align="center">
  <img src="https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-core
</h1>

<p align="center">
  Foundation crate for <a href="https://github.com/rom-weaver/rom-weaver">rom-weaver</a>: registry traits, the single error type, I/O and thread-planning helpers, and standalone codec backends.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-core"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-core?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-core"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-core?color=365d82"></a>
  <a href="https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-365d82"></a>
</p>

> **Beta software.** This crate is published as a dependency of [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli). The `rom-weaver` command is the supported interface. The Rust API is internal and can change between minor releases.

<!-- START doctoc -->
## Table of contents

- [What does this crate do?](#what-does-this-crate-do)
- [Usage](#usage)
- [Related crates](#related-crates)
- [Stability](#stability)
- [Documentation](#documentation)
- [License](#license)

<!-- END doctoc -->

## What does this crate do?

`rom-weaver-core` is the bottom of the rom-weaver crate graph. It depends on nothing else in the workspace, and every other crate builds on it:

- **Registry traits.** `ContainerHandler` (plus `ContainerHandlerOperations`) and `PatchHandler`, registered into a registry keyed by `FormatDescriptor` (name, aliases, extensions) that drives both explicit format selection and path-based probing.
- **One error type.** `RomWeaverError` plus the `Result<T>` alias. Validation failures that need machine-readable codes use the `ValidationCode` variant, which holds a `ValidationCodeError`. rom-weaver deliberately has no per-crate error enums.
- **Reports and context.** `OperationReport` carries operation results and progress details. `OperationContext` supplies cancellation, temporary paths, progress sinks, and thread budgets to handlers.
- **Thread planning.** `ThreadCapability` (what a format *can* parallelize) and `ThreadExecution` (what a run *actually* used), plus memory-aware concurrency helpers for native and `wasm32` builds.
- **Codec helpers.** Standalone decoding for zstd, deflate/zlib, LZMA, LZMA2, xz, and bzip2; encoding for zstd and xz.

## Usage

Use the [CLI](https://rom-weaver.com/docs/install) to run rom-weaver. This page describes the internal crate for contributors.

Optional features:

| Feature | Effect |
| --- | --- |
| `typescript-types` | Derives `ts-rs` bindings for the types crossing the Rust ⇄ TypeScript boundary. |

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-checksum`](https://crates.io/crates/rom-weaver-checksum) | Checksum engines and the streaming variant engine. |
| [`rom-weaver-containers`](https://crates.io/crates/rom-weaver-containers) | Archive, disc-image, and ROM-specific compression handlers. |
| [`rom-weaver-patches`](https://crates.io/crates/rom-weaver-patches) | ROM patch format handlers. |
| [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli) | The `rom-weaver` binary and the command library both frontends share. |

## Stability

Before v1.0, breaking changes increase the minor version. Direct use of this crate is unsupported; an exact version pin prevents an update from changing its API unexpectedly.

## Documentation

- [Architecture guide](https://github.com/rom-weaver/rom-weaver/blob/main/docs/development/ARCHITECTURE.md): crate graph, registry traits, threading model.
- [Documentation index](https://github.com/rom-weaver/rom-weaver/blob/main/docs/README.md)

## License

Copyright © Brandon Casey. Licensed under [AGPL-3.0-or-later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE). Bundled third-party components retain their own licenses.
