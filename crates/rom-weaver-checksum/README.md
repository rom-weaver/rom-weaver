<h1 align="center">
  <img src="https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-checksum
</h1>

<p align="center">
  Checksum engines and header-aware checksum variants for <a href="https://github.com/rom-weaver/rom-weaver">rom-weaver</a>.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-checksum"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-checksum?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-checksum"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-checksum?color=365d82"></a>
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

This crate provides the checksum engine used by the `checksum` command, extracted-ROM hashing, and patch input checks. Format handlers also compute checksums required by their own formats.

- **Algorithms.** CRC-32, CRC-32C, CRC-16, Adler-32, MD5, SHA-1, SHA-256, and BLAKE3. One engine, `NativeChecksumEngine`, computes any of them over a whole file or a byte range.
- **One streaming pass.** The variant engine feeds all requested algorithms from the same buffered stream. Header removal and N64 byte-order variants share that pass; some checksum-repair variants need a second read.
- **Header-aware variants.** Header detection lets a file report checksums for both its raw bytes and its headerless bytes, so callers can match databases that use either form.
- **N64 byte orders.** The three interleavings (`.z64` big-endian, `.v64` byte-swapped, `.n64` little-endian) are detected from the boot magic, and the same pass reports checksums for all three orders.
- **Checksum repair.** Repair variants cover the N64 boot checksum pair for CIC-6101/6102, the Genesis word sum, and the GBA header complement. Genesis always needs a second read to hash the repaired bytes. N64 boot code that matches another known CIC is excluded; unknown boot code uses the CIC-6101/6102 calculation.
- **ROM identity.** Platform detection and header parsing used to label a file with its platform and medium.

## Usage

Use the [CLI](https://rom-weaver.com/docs/install) to run rom-weaver. This page describes the internal crate for contributors.

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-core`](https://crates.io/crates/rom-weaver-core) | Registry traits, `RomWeaverError`, I/O and threading helpers. |
| [`rom-weaver-containers`](https://crates.io/crates/rom-weaver-containers) | Archive, disc-image, and ROM-specific compression handlers. |
| [`rom-weaver-patches`](https://crates.io/crates/rom-weaver-patches) | ROM patch format handlers. |
| [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli) | The `rom-weaver` binary and the command library both frontends share. |

## Stability

Before v1.0, breaking changes increase the minor version. Direct use of this crate is unsupported; an exact version pin prevents an update from changing its API unexpectedly.

## Documentation

- [Supported formats](https://github.com/rom-weaver/rom-weaver/blob/main/docs/reference/formats.md#checksum-support): the full algorithm and variant tables.
- [Documentation index](https://github.com/rom-weaver/rom-weaver/blob/main/docs/README.md)

## License

Copyright © Brandon Casey. Licensed under [AGPL-3.0-or-later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE). Bundled third-party components retain their own licenses.
