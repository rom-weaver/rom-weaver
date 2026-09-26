# Native emulator runtime

The native ROM smoke test uses a separate RetroArch and FCEUmm runtime built from pinned sources. The CLI binary does not embed these GPL components. Release assets carry both the runtime and its corresponding source package.

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
- the FCEUmm libretro core for NES ROMs;
- a schema-version 1 manifest with pinned revisions and SHA-256 values;
- the RetroArch and FCEUmm license files.

The source lock is `scripts/emulator-runtime/sources.json`. It pins the upstream archive URL, revision, and SHA-256 for each component.

## Build the release artifacts

Use separate empty build and output directories. The build needs `cc`, `c++`, `curl`, `gzip`, `make`, `node`, `sha256sum`, and `tar`.

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

The smoke script uses isolated configuration, data, cache, save, and state directories. It requires a nonempty PNG with the PNG signature.

## Runtime manifest contract

`manifest.json` has `schemaVersion: 1` and `platform: "linux-x64-gnu"`. Its `retroarch` object records `path`, the 40-character source `revision`, and `sha256`. Its only initial `cores` entry uses `id: "fceumm"`, `platform: "nes"`, and the same path, revision, and hash fields.

The CLI rejects extra manifest fields, unsafe paths, symbolic links, missing executable permission, hash mismatches, other platforms, and other core sets.

## Release flow

CI builds and smoke-tests the runtime from the pinned source lock. The release fan-out attaches the runtime archive, its SHA-256 sidecar, and the complete source archive while the GitHub release is still a draft. Draft publication waits for these artifacts and checks to succeed.

The runtime checksum is the deliberate exception to the project's general rule against release checksum sidecars. `rom-weaver emulator install` needs the public sidecar before it downloads and installs the optional runtime.

Users install the runtime that matches their CLI version. The online installer reads the matching versioned release. The offline `--archive` and `--sha256` path can install a locally built artifact before publication.
