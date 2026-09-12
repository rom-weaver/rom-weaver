<h1 align="center">
  <img src="https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-patches
</h1>

<p align="center">
  ROM hack patch formats for <a href="https://github.com/rom-weaver/rom-weaver">rom-weaver</a>: probe, parse, apply, create, and validate.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-patches"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-patches?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-patches"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-patches?color=365d82"></a>
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

Patch handlers implement `rom-weaver-core`'s `PatchHandler` trait. The registry selects a handler from a patch's signature or file extension.

- **Formats.** IPS, IPS32, BPS, UPS, xdelta/VCDIFF, PPF, RUP, BDF/BSDIFF40, APS (N64 and GBA), SOLID, MOD/PMSR, DPS, DLDI, GDIFF, HDiffPatch, BSP, PAT, EBP, and other registered formats. NINJA1 is recognized on probe but cannot be applied.
- **Apply and create.** Most formats round-trip: generate a distributable patch from an original and a modified file, then apply it back. BSP and HDiffPatch can only be applied, not created.
- **Validation without a saved ROM.** Most handlers check the patch and source directly. BSP and VCDIFF/xdelta apply to a temporary output because validation needs to execute the patch.
- **Checksum discipline.** Formats that carry expected input/output checksums are enforced against `rom-weaver-checksum`. Formats that carry none, such as IPS, cannot prove that the chosen base is correct on their own; the CLI can add that check with `--expect-in`.
- **Parallel VCDIFF.** The xdelta encoder splits window encoding across threads, and `apply_patch_bytes` exposes in-memory VCDIFF apply for callers that patch individual files inside a container.

## Usage

Use the [CLI](https://rom-weaver.com/docs/install) to run rom-weaver. This page describes the internal crate for contributors.

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-core`](https://crates.io/crates/rom-weaver-core) | Registry traits, `RomWeaverError`, I/O and threading helpers. |
| [`rom-weaver-checksum`](https://crates.io/crates/rom-weaver-checksum) | Checksum engines and the streaming variant engine. |
| [`rom-weaver-containers`](https://crates.io/crates/rom-weaver-containers) | Archive, disc-image, and ROM-specific compression handlers. |
| [`rom-weaver-cli`](https://crates.io/crates/rom-weaver-cli) | The `rom-weaver` binary and the command library both frontends share. |

## Stability

Before v1.0, breaking changes increase the minor version. Direct use of this crate is unsupported; an exact version pin prevents an update from changing its API unexpectedly.

## Documentation

- [Supported formats](https://github.com/rom-weaver/rom-weaver/blob/main/docs/reference/formats.md#patch-formats): the full patch format and capability tables.
- [Architecture guide](https://github.com/rom-weaver/rom-weaver/blob/main/docs/development/ARCHITECTURE.md): registry traits and copier-header handling on apply.

## License

Copyright © Brandon Casey. Licensed under [AGPL-3.0-or-later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE). Bundled third-party components retain their own licenses.
