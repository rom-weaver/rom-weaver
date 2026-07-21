<h1 align="center">
  <img src="https://raw.githubusercontent.com/brandonocasey/rom-weaver/0c950a5f3b44cfd597d9798357cae0d273264d13/packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="" width="64" height="64"><br>
  rom-weaver-cli
</h1>

<p align="center">
  The <code>rom-weaver</code> command-line tool: a local-first offline toolkit for ROMs and ROM hack patches.
</p>

<p align="center">
  <a href="https://crates.io/crates/rom-weaver-cli"><img alt="crates.io" src="https://img.shields.io/crates/v/rom-weaver-cli?color=d9690f"></a>
  <a href="https://docs.rs/rom-weaver-cli"><img alt="docs.rs" src="https://img.shields.io/docsrs/rom-weaver-cli?color=4a6d63"></a>
  <a href="https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

> **Beta software.** The `rom-weaver` command is the supported interface, and
> the one to install. The four library crates it is built from
> (`rom-weaver-core`, `-checksum`, `-containers`, `-patches`) are published only
> so this one can be; using them directly is unsupported.

## What this crate is

The installable end of rom-weaver. It ships the `rom-weaver` binary and the
`rom_weaver_app` command library that both frontends share — the native CLI and
the `wasm32-wasip1-threads` build that powers the
[rom-weaver.com](https://rom-weaver.com/) webapp run the exact same
orchestration code.

- **Apply and create patches.** IPS, BPS, UPS, xdelta/VCDIFF, PPF, RUP,
  BDF/BSDIFF40, APS, DCP (Dreamcast), and more than twenty formats, with
  ordered multi-patch chains, strict checksum validation, and cheat-code
  baking. A few — DCP, BSP, and HDiffPatch among them — are apply-only.
- **Inspect and extract containers.** ZIP, 7z, RAR, tar, CHD, RVZ, Z3DS, CSO,
  PBP, GCZ, WIA, WBFS, and more, including nested archives.
- **Create compressed containers.** ZIP, 7z, CHD, RVZ, and Z3DS, validated
  against reference tools such as `chdman` and `dolphin-tool`.
- **Checksum and verify.** CRC-32, MD5, SHA-1, SHA-256, BLAKE3, and friends,
  with copier-header detection and header-aware checksum variants.
- **Trim and restore.** Trimming for NDS, GBA, 3DS, XISO, and RVZ scrub. NDS,
  GBA, and 3DS can be reverted, with an opt-in footer that restores the
  original byte-for-byte.
- **Share workflows.** `rom-weaver-bundle.json` bundles pin patch order,
  checksums, and output naming so others can replay the exact workflow.
- **Scriptable.** Line-delimited JSON output for every command.

Everything runs locally. Nothing is uploaded.

## Install

```bash
cargo install rom-weaver-cli --locked
rom-weaver --help
```

A source build links native C libraries and needs **Rust 1.95+**, **CMake**,
**Clang**, and a native compiler toolchain. The crate's Cargo features
(`typescript-types`, `wasm-app`) drive this project's own type generation and
WASM entrypoint builds; they are not meant for external use.

To skip the toolchain entirely, run the published Linux image:

```bash
docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD:/work" \
  ghcr.io/brandonocasey/rom-weaver-cli:latest probe --input /work/game.iso
```

Mount your ROM directory at `/work` and pass paths under it. `--user` matters:
bind-mounted files keep their host ownership, so without it the container
cannot read files it does not own.

Prebuilt binaries and a Homebrew tap will land with the first GitHub Release;
see the [project README](https://github.com/brandonocasey/rom-weaver#install)
for the current state.

## Usage

```bash
# What is this file?
rom-weaver probe --input game.iso

# Apply a patch chain, verifying checksums at every step
rom-weaver patch apply --input game.sfc --patch hack.bps \
  --output game-hacked.sfc --no-compress

# ...or let the output extension pick a compression container
rom-weaver patch apply --input game.sfc --patch hack.bps --output game-hacked.zip

# Create a distributable patch
rom-weaver patch create --original original.sfc --modified hacked.sfc --output hack.bps

# Checksum with header-aware variants
rom-weaver checksum --input game.sfc --algo crc32,sha1

# Machine-readable output for scripts
rom-weaver probe --input game.chd --json
```

The [CLI guide](https://github.com/brandonocasey/rom-weaver/blob/main/docs/cli.md)
covers every command, the supported-format tables, compression settings, JSON
output, man pages, Docker usage, and file permissions.

## Related crates

| Crate | Role |
| --- | --- |
| [`rom-weaver-core`](https://crates.io/crates/rom-weaver-core) | Registry traits, `RomWeaverError`, I/O and threading helpers. |
| [`rom-weaver-checksum`](https://crates.io/crates/rom-weaver-checksum) | Checksum engines and the streaming variant engine. |
| [`rom-weaver-containers`](https://crates.io/crates/rom-weaver-containers) | Archive and disc-image handlers. |
| [`rom-weaver-patches`](https://crates.io/crates/rom-weaver-patches) | ROM patch format handlers. |

## Stability

rom-weaver follows Semantic Versioning, but until v1.0 breaking changes land in
minor releases. Patching, compressing, extracting, and bundling are tested
extensively; the flags and JSON shapes around them may still change on the way
to v1.0. `trim` and `tools` are untested but theoretically working, and are
disabled in the webapp for that reason. The `rom_weaver_app` library this crate
also exposes is an internal seam between the native and wasm frontends, not a
supported API.

## Documentation

- [CLI guide](https://github.com/brandonocasey/rom-weaver/blob/main/docs/cli.md)
- [Documentation index](https://github.com/brandonocasey/rom-weaver/blob/main/docs/README.md)
- [Project README](https://github.com/brandonocasey/rom-weaver#readme)

## License

Copyright (C) Brandon Casey. Licensed under
[AGPL-3.0-or-later](https://github.com/brandonocasey/rom-weaver/blob/main/LICENSE.md).
Bundled third-party components retain their own licenses; release builds ship a
generated [attribution notice](https://rom-weaver.com/NOTICE) and
[third-party license inventory](https://rom-weaver.com/THIRD_PARTY_LICENSES.md).
