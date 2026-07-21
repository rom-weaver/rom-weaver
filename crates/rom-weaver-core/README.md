<h1 align="center">
  <img src="https://raw.githubusercontent.com/brandonocasey/rom-weaver/0c950a5f3b44cfd597d9798357cae0d273264d13/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-core
</h1>

<p align="center">
  Foundation crate for <a href="https://github.com/brandonocasey/rom-weaver">rom-weaver</a>: registry traits, the single error type, I/O and thread-planning helpers, and standalone codec backends.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-core"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-core?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-core"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-core?color=4a6d63"></a>
  <a href="https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

> **Beta software, published so the CLI can be.** This crate exists to build
> [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli), and the
> `rom-weaver` command is the only supported interface. The Rust API is not
> documented beyond this page, changes without notice between minor releases,
> and using it in another project is unsupported.

## What this crate is

`rom-weaver-core` is the bottom of the rom-weaver crate graph. It depends on
nothing else in the workspace, and every other crate builds on it:

- **Registry traits.** `ContainerHandler` (plus `ContainerHandlerOperations`)
  and `PatchHandler`, registered into a registry keyed by `FormatDescriptor`
  (name, aliases, extensions) that drives both explicit format selection and
  path-based probing.
- **One error type.** `RomWeaverError` plus the `Result<T>` alias. Validation
  failures that need machine-readable codes use the structured
  `ValidationCodeError` variant. rom-weaver deliberately has no per-crate error
  enums.
- **Reports and context.** `OperationReport` is the single progress/result
  currency returned by every handler; `OperationContext` carries cancellation,
  temp-path allocation, progress sinks, and thread budgets downward.
- **Thread planning.** `ThreadCapability` (what a format *can* parallelize) and
  `ThreadExecution` (what a run *actually* used), plus memory-aware
  concurrency helpers that behave on both native and `wasm32`.
- **Codec helpers.** Standalone decoding for zstd, deflate/zlib, LZMA, LZMA2,
  xz, and bzip2; encoding for zstd and xz.

## Usage

```toml
[dependencies]
rom-weaver-core = "0.6"
```

Optional features:

| Feature | Effect |
| --- | --- |
| `typescript-types` | Derives `ts-rs` bindings for the types crossing the Rust ⇄ TypeScript boundary. |

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-checksum`](https://crates.io/crates/rom-weaver-checksum) | Checksum engines and the streaming variant engine. |
| [`rom-weaver-containers`](https://crates.io/crates/rom-weaver-containers) | Archive and disc-image handlers. |
| [`rom-weaver-patches`](https://crates.io/crates/rom-weaver-patches) | ROM patch format handlers. |
| [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli) | The `rom-weaver` binary and the command library both frontends share. |

## Stability

rom-weaver follows Semantic Versioning, but until v1.0 breaking changes land in
minor releases; this crate is the least settled surface in the project. The
supported way to use rom-weaver is the `rom-weaver` CLI; if you depend on this
crate anyway, pin an exact version and expect to do the migration work
yourself.

## Documentation

- [Architecture guide](https://github.com/brandonocasey/rom-weaver/blob/main/docs/ARCHITECTURE.md) — crate graph, registry traits, threading model.
- [Documentation index](https://github.com/brandonocasey/rom-weaver/blob/main/docs/README.md)

## License

Copyright (C) Brandon Casey. Licensed under
[AGPL-3.0-or-later](https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md).
Bundled third-party components retain their own licenses.
