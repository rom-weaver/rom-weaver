<h1 align="center">
  <img src="https://raw.githubusercontent.com/brandonocasey/rom-weaver/0c950a5f3b44cfd597d9798357cae0d273264d13/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-containers
</h1>

<p align="center">
  Archive and disc-image handlers for <a href="https://github.com/brandonocasey/rom-weaver">rom-weaver</a>: probe, list, extract, and create.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-containers"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-containers?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-containers"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-containers?color=4a6d63"></a>
  <a href="https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

> **Beta software, published so the CLI can be.** This crate exists to build
> [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli), and the
> `rom-weaver` command is the only supported interface. The Rust API is not
> documented beyond this page, changes without notice between minor releases,
> and using it in another project is unsupported.

## What this crate is

The container registry and one handler per format, each implementing
`rom-weaver-core`'s `ContainerHandler` trait.

- **General archives.** ZIP, 7z, RAR, and the tar family.
- **Disc and cartridge images.** CHD, RVZ, Z3DS, CSO, PBP, GCZ, WIA, WBFS,
  NFS, TGC, and XISO.
- **Creation, not just reading.** ZIP, 7z, CHD, RVZ, and Z3DS can be written
  with codec-aware compression settings. Output is validated against the
  reference tools (`chdman`, `dolphin-tool`) so a rom-weaver-produced image is
  interchangeable with theirs.
- **Bounded memory.** Extract and create run as producer/consumer pipelines
  over bounded channels, so a 60 GiB image does not become a 60 GiB
  allocation.
- **Threading that reports itself.** Every operation returns the
  `ThreadExecution` it actually used, not just what it could have used.

## Usage

```toml
[dependencies]
rom-weaver-containers = "0.6"
```

This crate links native C libraries: a vendored libarchive plus zlib, bzip2,
LZMA, zstd, and LZ4. Building it needs **CMake**, **Clang**, and a working
native compiler toolchain. It declares `links = "archive"`, so only one
libarchive-linking crate may appear in a dependency graph.

Default features build every compression backend from vendored sources.
Notable toggles:

| Feature | Effect |
| --- | --- |
| `compress-{bzip2,lzma,zlib,zstd}-vendored` | Build that codec from vendored source (all on by default). |
| `threading` | Multi-threaded extract/create pipelines (on by default). |
| `libarchive-write-extra` | Additional libarchive write formats. |

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-core`](https://crates.io/crates/rom-weaver-core) | Registry traits, `RomWeaverError`, I/O and threading helpers. |
| [`rom-weaver-checksum`](https://crates.io/crates/rom-weaver-checksum) | Checksum engines and the streaming variant engine. |
| [`rom-weaver-patches`](https://crates.io/crates/rom-weaver-patches) | ROM patch format handlers. |
| [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli) | The `rom-weaver` binary and the command library both frontends share. |

## Stability

rom-weaver follows Semantic Versioning, but until v1.0 breaking changes land in
minor releases; this crate is the least settled surface in the project. The
supported way to use rom-weaver is the `rom-weaver` CLI; if you depend on this
crate anyway, pin an exact version and expect to do the migration work
yourself.

## Documentation

- [Supported formats](https://github.com/brandonocasey/rom-weaver/blob/main/docs/cli.md#supported-formats) — the full container, codec, and capability tables.
- [Architecture guide](https://github.com/brandonocasey/rom-weaver/blob/main/docs/ARCHITECTURE.md) — registry traits and the threading model.
- [Vendored third-party code](https://github.com/brandonocasey/rom-weaver/blob/main/docs/vendor-code.md) — what is vendored here and why.

## License

Copyright (C) Brandon Casey. Licensed under
[AGPL-3.0-or-later](https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md).
Bundled third-party components — libarchive, the inlined `nod` and `xdvdfs`
sources, and the C compression libraries — retain their own licenses.
