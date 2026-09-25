# Choosing a compression format

CHD, RVZ, Z3DS, 7z, ZIP. This page explains which compressed format fits which console, when trimming beats compressing, and what compression does to your checksums.

<!-- START doctoc -->
## Table of contents

- [Two kinds of compression](#two-kinds-of-compression)
- [Compressed disc images: CHD and RVZ](#compressed-disc-images-chd-and-rvz)
- [3DS ROM compression: Z3DS](#3ds-rom-compression-z3ds)
- [General archives: ZIP and 7z](#general-archives-zip-and-7z)
- [Trim, compress, or both](#trim-compress-or-both)
- [Compression changes your checksums](#compression-changes-your-checksums)
- [Which format should I choose?](#which-format-should-i-choose)

<!-- END doctoc -->

## Two kinds of compression

There are two different things people mean by "compressing a ROM," and they behave differently.

A general archive such as ZIP or 7z wraps any file. To play the game, the bytes usually have to come back out first, either by extracting or by an emulator unpacking the archive itself.

A compressed disc image such as CHD or RVZ is a purpose-built container for one disc. Compatible emulators read it directly, without a separate extracted copy. That compatibility depends on the emulator and platform.

## Compressed disc images: CHD and RVZ

**CHD** is a purpose-built container for media images. The official [chdman documentation](https://docs.mamedev.org/tools/chdman.html) covers raw, hard-disk, CD, and DVD images. rom-weaver creates CHD from `.cue`/`.gdi`/`.iso` inputs; the command is in [Extract, convert, and compress archives](../how-to/work-with-archives.md#compress-a-rom-or-disc-image-instead).

**RVZ** is Dolphin's format for GameCube and Wii discs. It understands disc padding, and [Dolphin](https://dolphin-emu.org/docs/faq/) plays it directly.

rom-weaver's parity suite checks that chdman and dolphin-tool can extract its CHD and RVZ outputs byte for byte, and that rom-weaver can extract the reference tools' outputs. The compressed container bytes and sizes may differ.

rom-weaver reads GCZ, WIA, WBFS, and CSO but does not create them. [Extract, convert, and compress archives](../how-to/work-with-archives.md) covers conversion to a format the emulator supports.

## 3DS ROM compression: Z3DS

**Z3DS** is a zstd-based, ROM-specific compression format for Nintendo 3DS payloads (`.3ds`, `.cci`, `.cxi`, `.cia`, and `.3dsx`). Its compressed forms (`.z3ds` and friends) are supported by [Azahar 2123 and later](https://github.com/azahar-emu/azahar/discussions/1302); it is not a disc image format.

## General archives: ZIP and 7z

Many emulators load cartridge ROMs straight from a ZIP, making it a practical default when your emulator supports it. Depending on the data and settings, 7z can produce a smaller archive, but direct emulator support is less consistent, so it fits long-term storage more than a play library. rom-weaver creates both, and the [archive formats guide](../how-to/work-with-archives.md) covers everyday extract and convert workflows.

Double-wrapping adds another extraction step: most setups must unpack a CHD from its surrounding 7z before booting it.

## Trim, compress, or both

Some cartridge and disc formats carry padding rather than useful data. Trimming removes supported padding; compression encodes bytes in less space.

A trimmed cartridge ROM needs no decompression. It can also be compressed afterward if the output container supports it.

Restoration is a separate capability. Recording the original length and one padding byte cannot preserve every possible padding pattern. The [trim reference](../reference/formats.md#trim-support) lists exact restoration limits.

Procedures: [Trim in the browser](../how-to/trim-roms-browser.md) and [trim or restore from the CLI](../how-to/cli-trim.md).

## Compression changes your checksums

A compressed file does not hash the same as the dump inside it, so a `.chd` will not match a database entry for the `.bin` it was made from. The container and payload are different byte sequences. [Hash the ROM inside an archive](../how-to/identify-and-hash-files.md#hash-the-rom-inside-an-archive) gives the command for checking the payload.

## Which format should I choose?

- **CD/DVD console:** CHD when your emulator supports it.
- **GameCube or Wii:** RVZ for Dolphin and compatible tools.
- **Nintendo 3DS ROMs:** Z3DS for Azahar 2123 or later.
- **Cartridge ROMs you play:** ZIP when your emulator reads it directly, or a trimmed file where padding dominates.
- **Cold storage:** 7z when smaller general-purpose archives matter more than broad direct support.
- **Already in GCZ, WIA, WBFS, or CSO:** extract and create a supported modern format when your emulator can read it.

The [Supported formats](../reference/formats.md#container-and-compression-formats) reference is the authoritative table of every container, extension, and codec, including the `--codec` values each output accepts. Back to the [guide index](../README.md).
