# ROM compression formats: CHD, RVZ, Z3DS, ZIP and 7z

Compare ROM compression formats by their inputs, emulator compatibility, and extraction requirements: CHD and RVZ for disc images, Z3DS for Nintendo 3DS files, and ZIP or 7z for general archives.

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

**CHD** is a purpose-built container for media images. The official [chdman documentation](https://docs.mamedev.org/tools/chdman.html) covers raw, hard-disk, CD, and DVD images. rom-weaver creates CHD from `.cue`/`.gdi`/`.iso` inputs. Use the [browser CHD guide](../how-to/convert-to-chd-browser.md) or the [CLI archive guide](../how-to/work-with-archives.md#compress-a-rom-or-disc-image-instead).

**RVZ** is Dolphin's format for GameCube and Wii discs. It understands disc padding, and [Dolphin](https://dolphin-emu.org/docs/faq/) plays it directly.

Browser procedures: [Convert ISO to RVZ](../how-to/convert-to-rvz-browser.md) and [convert RVZ to ISO](../how-to/convert-rvz-to-iso-browser.md).

rom-weaver's parity suite checks that chdman and dolphin-tool can extract its CHD and RVZ outputs byte for byte, and that rom-weaver can extract the reference tools' outputs. The compressed container bytes and sizes may differ.

rom-weaver reads GCZ, WIA, WBFS, and CSO but does not create them. [Extract, convert, and compress archives](../how-to/work-with-archives.md) covers conversion to a format the emulator supports.

## 3DS ROM compression: Z3DS

**Z3DS** is a zstd-based, ROM-specific compression format for Nintendo 3DS payloads (`.3ds`, `.cci`, `.cxi`, `.cia`, and `.3dsx`). Its compressed forms (`.z3ds` and friends) are supported by [Azahar 2123 and later](https://github.com/azahar-emu/azahar/discussions/1302); it is not a disc image format.

Browser procedures: [Compress Nintendo 3DS ROMs to Z3DS](../how-to/convert-to-z3ds-browser.md) and [extract Z3DS files](../how-to/extract-z3ds-browser.md).

## General archives: ZIP and 7z

Many emulators load cartridge ROMs straight from a ZIP, making it a practical default when your emulator supports it. Depending on the data and settings, 7z can produce a smaller archive, but direct emulator support is less consistent, so it fits long-term storage more than a play library. rom-weaver creates both, and the [archive formats guide](../how-to/work-with-archives.md) covers everyday extract and convert workflows.

Double-wrapping adds another extraction step: most setups must unpack a CHD from its surrounding 7z before booting it.

## Trim, compress, or both

Some cartridge and disc formats carry padding rather than useful data. Trimming removes supported padding; compression encodes bytes in less space.

For GameCube and Wii discs, the Trim workflow performs lossless RVZ conversion rather than sector scrubbing. The logical disc bytes remain intact; smaller storage size comes from compression. RVZ can be extracted back to the logical disc image, but the trim restore command does not recreate the original compressed container layout.

A trimmed cartridge ROM needs no decompression. It can also be compressed afterward if the output container supports it.

Restoration is a separate capability. Recording the original length and one padding byte cannot preserve every possible padding pattern. The [trim reference](../reference/formats.md#trim-support) lists exact restoration limits.

Procedures: [Trim in the browser](../how-to/trim-roms-browser.md) and [trim or restore from the CLI](../how-to/cli-trim.md).

## Compression changes your checksums

A compressed file does not hash the same as the dump inside it, so a `.chd` will not match a database entry for the `.bin` it was made from. The container and payload are different byte sequences. [Hash the ROM inside an archive](../how-to/identify-and-hash-files.md#hash-the-rom-inside-an-archive) gives the command for checking the payload.

## Which format should I choose?

| Format | Intended input | Playback and extraction |
| --- | --- | --- |
| CHD | Supported CD/DVD and other disc images | Compatible emulators read CHD directly; others need an extracted image. |
| RVZ | GameCube and Wii disc images | Dolphin reads RVZ directly; tools requiring ISO need extraction. |
| Z3DS | Supported Nintendo 3DS payloads | Azahar 2123 and later support Z3DS; other tools may require the extracted payload. |
| ZIP | Any file, including cartridge ROMs | Some emulators load ROMs from ZIP; others need the member extracted first. |
| 7z | Any file, including ROMs and disc images | Direct emulator support is less common than ZIP; extraction is often needed. |

CHD versus 7z is a choice between a disc container that compatible emulators can read and a general archive. Neither converts a cartridge game into a disc-platform game. CHD and RVZ also target different disc workflows; there is no single size winner for every input and compression setting.

ZIP versus 7z trades broader direct support for the potential of smaller archives. Compression ratio and time depend on the input and settings. For 3DS, Z3DS preserves the payload type; putting a file in ZIP or 7z does not turn it into a `.3ds` ROM.

The browser procedures cover [CHD conversion](../how-to/convert-to-chd-browser.md), [RVZ conversion](../how-to/convert-to-rvz-browser.md), and [3DS compression](../how-to/convert-to-z3ds-browser.md). The [CLI archive guide](../how-to/work-with-archives.md) covers terminal workflows.

The [Supported formats](../reference/formats.md#container-and-compression-formats) reference is the authoritative table of every container, extension, and codec, including the `--codec` values each output accepts. Back to the [guide index](../README.md).
