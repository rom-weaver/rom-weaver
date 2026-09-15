<h1 align="center">
  <img src="https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-cli
</h1>

<p align="center">
  The <code>rom-weaver</code> command-line tool: inspect, extract, compress, and patch ROMs and disc images, all on your own machine.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-cli"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-cli?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-cli"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-cli?color=365d82"></a>
  <a href="https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-365d82"></a>
</p>

> **Beta software.** The `rom-weaver` command is the supported interface. Its four library dependencies (`rom-weaver-core`, `-checksum`, `-containers`, and `-patches`) expose internal Rust APIs; direct use is unsupported.

<!-- START doctoc -->
## Table of contents

- [What does this crate do?](#what-does-this-crate-do)
- [Install](#install)
- [Usage](#usage)
- [Related crates](#related-crates)
- [Stability](#stability)
- [Documentation](#documentation)
- [License](#license)

<!-- END doctoc -->

## What does this crate do?

This crate ships the `rom-weaver` binary and the shared `rom_weaver_app` command library. The native CLI and the `wasm32-wasip1-threads` build used by the [webapp](https://rom-weaver.com/) share command orchestration.

- **Apply and create patches.** Supported formats include IPS, BPS, UPS, xdelta/VCDIFF, PPF, RUP, BDF/BSDIFF40, APS, and DCP (Dreamcast), with ordered multi-patch chains, strict checksum validation, and cheat-code baking. Three of them (DCP, BSP, and HDiffPatch) can only be applied, not created.
- **Inspect and extract archives, disc images, and compressed ROMs.** ZIP, 7z, RAR, tar, CHD, RVZ, Z3DS, CSO, PBP, GCZ, WIA, WBFS, and more, including nested archives.
- **Create compressed output.** ZIP, 7z, CHD, RVZ, and Z3DS. CHD and RVZ output is validated against `chdman` and `dolphin-tool`, respectively.
- **Checksum and verify.** CRC-32, CRC-32C, CRC-16, Adler-32, MD5, SHA-1, SHA-256, and BLAKE3, with copier-header detection and header-aware checksum variants.
- **Trim and restore.** Trimming for NDS, GBA, 3DS, XISO, and RVZ scrub. NDS, GBA, and 3DS support padding restoration. An opt-in footer stores the original size and a fill byte; it does not store removed data.
- **Share workflows.** `rom-weaver-bundle.json` bundles pin patch order, checksums, and output naming so others can replay the exact workflow.
- **Scriptable.** Operation commands can emit line-delimited JSON; schema and completion generators keep their native output formats.

Everything runs locally. Nothing is uploaded.

## Install

```bash
cargo install rom-weaver-cli --locked
rom-weaver --help
rom-weaver man --install
rom-weaver setup
```

Cargo installs the executable and nothing else. `rom-weaver man --install` writes the generated manpages, and `rom-weaver setup` downloads this version's identify and cheat databases into the per-user data directory. `identify`, `probe --identify`, and cheat baking need that data; the other commands do not.

A source build links native C libraries and needs **Rust 1.95+**, **CMake**, **Clang**, and a native compiler toolchain. The crate's Cargo features (`typescript-types`, `wasm-app`) drive this project's own type generation and WASM entrypoint builds; they are not meant for external use.

To skip the toolchain entirely, run the published Linux image:

```bash
docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD:/work" \
  ghcr.io/rom-weaver/rom-weaver-cli:latest probe --input /work/game.iso
```

Mount your ROM directory at `/work` and pass paths under it. `--user` matters: bind-mounted files keep their host ownership, so without it the container may be unable to read private files and writes use the image's uid.

Prebuilt binaries and a Homebrew tap are available. See the [project README](https://github.com/rom-weaver/rom-weaver#install) for the current install methods and platform coverage.

## Usage

```bash
# What is this file?
rom-weaver probe --input game.iso

# Apply a patch, verifying checksums at every step
rom-weaver patch apply --input game.sfc --patch hack.bps \
  --output game-hacked.sfc --no-compress

# ...or let the output extension choose a compression format
rom-weaver patch apply --input game.sfc --patch hack.bps --output game-hacked.zip

# Build a patch you can share
rom-weaver patch create --original original.sfc --modified hacked.sfc --output hack.bps

# Checksum, including the header-aware variants
rom-weaver checksum --input game.sfc --algo crc32,sha1

# Shrink a disc image; the .cue brings its tracks along
rom-weaver compress --input game.cue --output game.chd

# Machine-readable output for scripts
rom-weaver probe --input game.chd --json
```

A few commands and flags answer to more than one name: `weave` is a compatibility alias for `patch apply`, `inspect` for `probe`, and `trim --untrim`/`--restore` for `trim --revert`. Format names have alternates too, so `--format 7zip` and `--format 7z` are the same. The [CLI guide](https://rom-weaver.com/docs/cli#alternate-names) lists them all.

The [CLI reference](https://rom-weaver.com/docs/cli) covers commands, shared flags, JSON output, and file permissions. [Supported formats](https://rom-weaver.com/docs/supported-formats) and [Install the CLI](https://rom-weaver.com/docs/install) cover capabilities and installation.

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-core`](https://crates.io/crates/rom-weaver-core) | Registry traits, `RomWeaverError`, I/O and threading helpers. |
| [`rom-weaver-checksum`](https://crates.io/crates/rom-weaver-checksum) | Checksum engines and the streaming variant engine. |
| [`rom-weaver-containers`](https://crates.io/crates/rom-weaver-containers) | Archive, disc-image, and ROM-specific compression handlers. |
| [`rom-weaver-patches`](https://crates.io/crates/rom-weaver-patches) | ROM patch format handlers. |

## Stability

Before v1.0, breaking changes increase the minor version. CLI flags and JSON output can change between minor releases. The `rom_weaver_app` library is an internal API shared by the native and WASM frontends.

## Documentation

- [CLI reference](https://rom-weaver.com/docs/cli)
- [Documentation index](https://rom-weaver.com/docs)
- [Project README](https://github.com/rom-weaver/rom-weaver#readme)

## License

Copyright © Brandon Casey. Licensed under [AGPL-3.0-or-later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE). Bundled third-party components retain their own licenses; release builds ship a generated `CLI_NOTICE` attribution and license inventory.
