# Native emulator runtime

The native ROM smoke test uses a separate RetroArch and libretro core runtime built from pinned sources. The CLI binary does not embed these components. Release assets carry both the runtime and its corresponding source package.

<!-- START doctoc -->
## Table of contents

- [Supported target](#supported-target)
- [Build the release artifacts](#build-the-release-artifacts)
- [Verify and smoke-test the runtime](#verify-and-smoke-test-the-runtime)
- [Runtime manifest contract](#runtime-manifest-contract)
- [Release flow](#release-flow)

<!-- END doctoc -->

## Supported target

The first runtime target is `linux-x64-gnu`: Linux x86-64 with GNU libc 2.39 or later. The runtime contains:

- a headless RetroArch binary with networking and unused drivers disabled;
- libretro cores for the supported ROM systems;
- packaged core assets, including PPSSPP assets;
- a schema-version 2 manifest with pinned revisions and SHA-256 values;
- the RetroArch, core, and dependency license files.

The source lock is `scripts/emulator-runtime/sources.json`. It pins the upstream archive URL, revision, and SHA-256 for each component.

Each component retains its upstream license. Snes9x, Genesis Plus GX, and PicoDrive restrict commercial redistribution; their source-lock entries record `redistribution: "noncommercial-only"`. The runtime and source archives include their license notices. The full GPLv3 text used by PokeMini is also included in `licenses/RetroArch-COPYING`.

## Build the release artifacts

Use separate empty build and output directories. The build needs `cc`, `c++`, `cmake`, `curl`, `gzip`, `make`, `nasm`, `node`, `python3`, `sha256sum`, and `tar`. It also needs OpenGL and zlib development libraries (`libgl-dev` and `zlib1g-dev` on Ubuntu).

```sh
root=$HOME/.cache/rom-weaver-emulator
```

```sh
mkdir -p "$root/build" "$root/output"
```

```sh
build=scripts/emulator-runtime/build.sh
```

```sh
$build --build-dir "$root/build" --output-dir "$root/output"
```

The build creates three release files:

- `rom-weaver-emulator-linux-x64-gnu.tar.gz`;
- `rom-weaver-emulator-linux-x64-gnu.tar.gz.sha256`;
- `rom-weaver-emulator-sources.tar.gz`.

The source archive contains the exact upstream source archives, source lock, build and smoke scripts, verifier, and license files. These materials let users rebuild the runtime from the pinned sources. Build dates can make rebuilt binary bytes differ.

## Verify and smoke-test the runtime

Verify the unpacked runtime manifest and file hashes:

```sh
node scripts/emulator-runtime/verify-runtime.mjs PATH_TO_RUNTIME
```

Run the repository's generated NES sample through the unpacked runtime:

```sh
smoke=scripts/emulator-runtime/smoke.sh
```

```sh
$smoke --runtime-dir PATH_TO_RUNTIME --scratch-dir "$root/smoke"
```

The smoke script uses isolated configuration, data, cache, save, and state directories. It requires a nonempty PNG with the PNG signature. It checks the baseline FCEUmm path; it does not prove every packaged core or game.

The build loads all core libraries. The CI integration check requires the installed catalog to match the native source lock and contain every browser core. The native catalog also includes Atari 2600, PC Engine, SuperGrafx, Virtual Boy, Neo Geo Pocket, WonderSwan, Pokémon Mini, and Sega 32X cores.

CI captures frames from NES, Game Boy, GBA, DS, PSP, and all eight additional cores. The additional core fixtures also check automatic selection against explicit core selection. Downloaded inputs have SHA-256 checks and remain outside distributed archives. Their pinned URLs and hashes are in `scripts/ci/emulator-fixtures.json`; the PSP fixture is pinned in the check script.

The SuperGrafx fixture runs the PC Engine 240p Test Suite with forced SuperGrafx mode. It checks startup and rendering through that core, not SuperGrafx-specific graphics features.

The PPSSPP source recipe waits for asynchronous startup before it returns the first frame. Without this patch, a short frame budget can unload the core while its loader thread still writes to emulated memory.

## Runtime manifest contract

`manifest.json` has `schemaVersion: 2` and `platform: "linux-x64-gnu"`. Its `retroarch` object records `path`, the 40-character source `revision`, and `sha256`.

Each `cores` entry records `id`, `platform`, `path`, `revision`, `sha256`, `extensions`, `options`, and `firmware`. Extensions drive automatic core selection. Options become an isolated RetroArch core-options file. Firmware paths describe files the user must supply through `--system-dir`.

The `systemFiles` array records the relative `path` and `sha256` of each packaged core asset. The CLI copies these assets into the isolated system directory before it adds user-supplied firmware. The PPSSPP assets use this mechanism.

The CLI also accepts the original schema-version 1 NES manifest. It supplies the `.nes` extension for the legacy FCEUmm entry when it is absent.

The CLI rejects extra manifest fields, unsafe or duplicate paths, symbolic links, missing executable permission, hash mismatches, unsupported platforms, invalid core metadata, and empty or oversized core sets.

## Release flow

CI builds and smoke-tests the runtime from the pinned source lock. The release fan-out attaches the runtime archive, its SHA-256 sidecar, and the complete source archive while the GitHub release is still a draft. Draft publication waits for these artifacts and checks to succeed.

The runtime checksum is the deliberate exception to the project's general rule against release checksum sidecars. `rom-weaver emulator install` needs the public sidecar before it downloads and installs the optional runtime.

Users install the runtime that matches their CLI version. The online installer reads the matching versioned release. The offline `--archive` and `--sha256` path can install a locally built artifact before publication.
