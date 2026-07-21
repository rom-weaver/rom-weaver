<h1 align="center">
  <img src="https://raw.githubusercontent.com/brandonocasey/rom-weaver/0c950a5f3b44cfd597d9798357cae0d273264d13/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-checksum
</h1>

<p align="center">
  Checksum engines and header-aware checksum variants for <a href="https://github.com/brandonocasey/rom-weaver">rom-weaver</a>.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-checksum"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-checksum?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-checksum"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-checksum?color=4a6d63"></a>
  <a href="https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

> **Beta software, published so the CLI can be.** This crate exists to build
> [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli), and the
> `rom-weaver` command is the only supported interface. The Rust API is not
> documented beyond this page, changes without notice between minor releases,
> and using it in another project is unsupported.

## What this crate is

Every checksum rom-weaver computes comes from here, whether it is verifying a
patch's expected input, fingerprinting an extracted ROM, or answering a plain
`rom-weaver checksum` run.

- **Algorithms.** CRC-32, CRC-32C, CRC-16, Adler-32, MD5, SHA-1, SHA-256, and
  BLAKE3. One engine, `NativeChecksumEngine`, computes any of them over a whole
  file or a byte range.
- **One streaming pass.** The variant engine reads the input once and feeds
  every requested algorithm from the same buffered stream, so hashing a
  multi-gigabyte disc image with six algorithms costs one read, not six.
- **Header-aware variants.** ROM copier headers (SNES/SMC, NES, and friends)
  are detected so a file can report both the raw checksum and the
  headerless checksum databases actually index by.
- **N64 byte orders.** The three interleavings — `.z64` big-endian, `.v64`
  byte-swapped, `.n64` little-endian — are detected from the boot magic, and
  the same pass reports what the file would hash to in each of the other two.
- **Checksum repair.** Internal header checksums that a patch invalidates can
  be recomputed in the same streaming pass: the N64 boot-code CRC pair, the
  Genesis word sum, and the GBA header complement.
- **ROM identity.** Platform detection and header parsing used to label a file
  with its platform and medium.

## Usage

```toml
[dependencies]
rom-weaver-checksum = "0.6"
```

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-core`](https://crates.io/crates/rom-weaver-core) | Registry traits, `RomWeaverError`, I/O and threading helpers. |
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

- [Supported formats](https://github.com/brandonocasey/rom-weaver/blob/main/docs/cli.md#supported-formats) — the full algorithm and variant tables.
- [Documentation index](https://github.com/brandonocasey/rom-weaver/blob/main/docs/README.md)

## License

Copyright (C) Brandon Casey. Licensed under
[AGPL-3.0-or-later](https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md).
Bundled third-party components retain their own licenses.
