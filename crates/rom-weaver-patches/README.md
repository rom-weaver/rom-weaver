<h1 align="center">
  <img src="https://raw.githubusercontent.com/brandonocasey/rom-weaver/0c950a5f3b44cfd597d9798357cae0d273264d13/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-patches
</h1>

<p align="center">
  ROM hack patch formats for <a href="https://github.com/brandonocasey/rom-weaver">rom-weaver</a>: probe, parse, apply, create, and validate.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-patches"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-patches?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-patches"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-patches?color=4a6d63"></a>
  <a href="https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

> **Beta software, published so the CLI can be.** This crate exists to build
> [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli), and the
> `rom-weaver` command is the only supported interface. The Rust API is not
> documented beyond this page, changes without notice between minor releases,
> and using it in another project is unsupported.

## What this crate is

One file per patch format, each implementing `rom-weaver-core`'s `PatchHandler`
trait, plus the registry that probes an unknown patch file down to a format.

- **Formats.** IPS, IPS32, BPS, UPS, xdelta/VCDIFF, PPF, RUP, BDF/BSDIFF40,
  APS (N64 and GBA), SOLID, MOD/PMSR, DPS, DLDI, GDIFF, HDiffPatch, BSP, PAT,
  EBP, and more than twenty in total. NINJA1 is recognized on probe but cannot
  be applied.
- **Apply and create.** Most formats round-trip: generate a distributable patch
  from an original and a modified file, then apply it back. A few — BSP and
  HDiffPatch among them — are apply-only.
- **Validation before writing.** `validate` dry-run applies to a temp path, so
  a patch chain can be checked end to end before anything is written.
- **Checksum discipline.** Formats that carry expected input/output checksums
  are enforced against `rom-weaver-checksum`; formats that carry none (IPS) are
  verified against the declared base instead.
- **Parallel VCDIFF.** The xdelta encoder splits window encoding across
  threads, and `apply_patch_bytes` exposes in-memory VCDIFF apply for callers
  that patch individual files inside a container.

## Usage

```toml
[dependencies]
rom-weaver-patches = "0.6"
```

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-core`](https://crates.io/crates/rom-weaver-core) | Registry traits, `RomWeaverError`, I/O and threading helpers. |
| [`rom-weaver-checksum`](https://crates.io/crates/rom-weaver-checksum) | Checksum engines and the streaming variant engine. |
| [`rom-weaver-containers`](https://crates.io/crates/rom-weaver-containers) | Archive and disc-image handlers. |
| [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli) | The `rom-weaver` binary and the command library both frontends share. |

## Stability

rom-weaver follows Semantic Versioning, but until v1.0 breaking changes land in
minor releases; this crate is the least settled surface in the project. The
supported way to use rom-weaver is the `rom-weaver` CLI; if you depend on this
crate anyway, pin an exact version and expect to do the migration work
yourself.

## Documentation

- [Supported formats](https://github.com/brandonocasey/rom-weaver/blob/main/docs/cli.md#supported-formats) — the full patch format and capability tables.
- [Architecture guide](https://github.com/brandonocasey/rom-weaver/blob/main/docs/ARCHITECTURE.md) — registry traits and copier-header handling on apply.

## License

Copyright (C) Brandon Casey. Licensed under
[AGPL-3.0-or-later](https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md).
Bundled third-party components retain their own licenses.
