# Extract, convert, and compress archives

Extract files, convert an archive, or create a ZIP or 7z from the terminal. To patch a ROM inside an archive, pass the archive directly to [patch apply](cli-apply.md).

<!-- START doctoc -->
## Table of contents

- [Extract an archive](#extract-an-archive)
- [Convert one archive format to another](#convert-one-archive-format-to-another)
- [Use an archive pipeline](#use-an-archive-pipeline)
- [Create a ZIP or 7z](#create-a-zip-or-7z)
- [Compress a ROM or disc image instead](#compress-a-rom-or-disc-image-instead)
  - [Create a CHD from a CUE/BIN set](#create-a-chd-from-a-cuebin-set)
  - [Extract an ISO from RVZ](#extract-an-iso-from-rvz)
- [Look up what is supported](#look-up-what-is-supported)

<!-- END doctoc -->

## Extract an archive

```sh
rom-weaver extract --input patches.7z --output extracted-patches
```

Gzip, Bzip2, XZ, and Zstandard inputs are single compressed streams, so they extract to their one payload file rather than a directory.

## Convert one archive format to another

There is no single convert command. Extract, then compress the directory:

```sh
rom-weaver extract --input patches.7z --output extracted-patches
rom-weaver compress --input extracted-patches --output patches.zip
```

The new ZIP contains `extracted-patches/` as its top-level directory, because `compress` archives the paths you give it. It does not unpack an archive input on your behalf: pass `patches.7z` directly and the new archive will contain the `patches.7z` file itself.

## Use an archive pipeline

Write one extracted member to stdout:

```sh
rom-weaver extract games.zip --select game.nes -o - > game.nes
```

Use a new destination: the shell opens `game.nes` before extraction starts. Never redirect onto the input archive.

In Bash, enable pipeline failure reporting, then convert a single-file archive without managing an intermediate file:

```sh
set -o pipefail
rom-weaver extract game.zip -o - | rom-weaver compress - -f 7z -o game.7z
```

The new archive names the piped file `stdin.bin`. To keep the ROM filename, supply `--stdin-name`:

```sh
rom-weaver compress - --stdin-name game.nes -o game.7z < game.nes
```

To send compressed bytes to another tool, give an explicit format:

```sh
rom-weaver compress game.nes -f zip -o - | rom-weaver checksum - --digest -a sha1
```

`checksum` opens the ZIP automatically, so this checks the ROM bytes. Add `--no-extract` to checksum the ZIP bytes. See the [binary pipeline reference](../reference/cli.md#binary-pipelines) for temporary disk use and output restrictions.

## Create a ZIP or 7z

```sh
rom-weaver compress --input my-release --output my-release.zip
```

ZIP accepts `store`, `deflate`, or `zstd`; 7z uses LZMA2. Pass `--codec` to choose, or leave it out for the default.

Those two are the only general-purpose archive formats rom-weaver can create. ZIPX, RAR, TAR and its variants, Gzip, Bzip2, XZ, and Zstandard can be opened but not written, so converting *into* one of them is not possible - extract and use a different container.

## Compress a ROM or disc image instead

An archive is not the same thing as a compressed disc image. If your goal is a smaller file your emulator still boots directly, you probably want CHD, RVZ, Z3DS, or a trim rather than a ZIP:

### Create a CHD from a CUE/BIN set

Pass the `.cue` sheet, not the `.bin` tracks. rom-weaver reads the track files named by the sheet and writes one CHD:

```sh
rom-weaver compress --input disc.cue --output disc.chd
```

Keep the CUE and BIN files together until the command finishes. The output CHD contains the disc tracks, so it replaces the set only when the emulator you use supports CHD.

### Extract an ISO from RVZ

Extract the RVZ to a new directory. rom-weaver writes the disc image there with an `.iso` extension:

```sh
rom-weaver extract --input game.rvz --output game-iso
```

For `game.rvz`, the extracted file is `game-iso/game.iso`. Use RVZ for Dolphin-compatible GameCube and Wii libraries; use the ISO when another tool requires an uncompressed disc image.

See [Choosing a compression format](../explanation/compression-formats.md) for which container fits which platform and when trimming beats compressing.

## Look up what is supported

[Supported formats](../reference/formats.md#container-and-compression-formats) is the authoritative table: every container, its aliases and extensions, whether rom-weaver can probe, extract, or create it, and the `--codec` values each output accepts. It covers the specialized disc and ROM containers this page leaves out.
