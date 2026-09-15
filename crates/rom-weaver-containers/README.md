<h1 align="center">
  <img src="https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-containers
</h1>

<p align="center">
  Archive, disc-image, and ROM-specific compression handlers for <a href="https://github.com/rom-weaver/rom-weaver">rom-weaver</a>: probe, list, extract, and create.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-containers"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-containers?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-containers"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-containers?color=365d82"></a>
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

The container registry and one handler per format, each implementing `rom-weaver-core`'s `ContainerHandler` trait.

- **General archives.** ZIP, 7z, RAR, and the tar family.
- **Disc-image containers.** CHD, RVZ, CSO, PBP, GCZ, WIA, WBFS, NFS, TGC, and XISO.
- **ROM-specific compression.** Z3DS for Nintendo 3DS ROMs.
- **Creation.** ZIP, 7z, CHD, RVZ, and Z3DS can be written with codec-aware compression settings. CHD and RVZ output is validated against `chdman` and `dolphin-tool`, respectively.
- **Bounded memory.** Large-image handlers stream data or process bounded batches. Buffer and worker limits keep image size from requiring an equally large allocation.
- **Thread reporting.** Operation reports carry the negotiated `ThreadExecution`, including fallback to a single thread when a worker pool cannot be built.

## Usage

Use the [CLI](https://rom-weaver.com/docs/install) to run rom-weaver. This page describes the internal crate for contributors.

This crate links native C libraries: a vendored libarchive plus zlib, bzip2, LZMA, zstd, and LZ4. Building it needs **CMake**, **Clang**, and a working native compiler toolchain. It declares `links = "archive"`, so only one libarchive-linking crate may appear in a dependency graph.

The default features enable vendored bzip2, LZMA, zlib, and zstd backends, plus threading:

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

Before v1.0, breaking changes increase the minor version. Direct use of this crate is unsupported; an exact version pin prevents an update from changing its API unexpectedly.

## Documentation

- [Supported formats](https://github.com/rom-weaver/rom-weaver/blob/main/docs/reference/formats.md#container-and-compression-formats): the full container, codec, and capability tables.
- [Architecture guide](https://github.com/rom-weaver/rom-weaver/blob/main/docs/development/ARCHITECTURE.md): registry traits and the threading model.
- [Vendored third-party code](https://github.com/rom-weaver/rom-weaver/blob/main/docs/development/vendor-code.md): what is vendored here and why.

## License

Copyright © Brandon Casey. Licensed under [AGPL-3.0-or-later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE). Bundled third-party components retain their own licenses: libarchive, the inlined `nod` and `xdvdfs` sources, and the C compression libraries.
