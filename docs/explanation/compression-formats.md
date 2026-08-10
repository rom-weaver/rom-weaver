# Choosing a compression format

CHD, RVZ, Z3DS, 7z, ZIP. This guide explains which compressed format fits which console, when trimming beats compressing, and what compression does to your checksums.

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

A compressed disc image such as CHD or RVZ is a purpose-built container for one disc. Emulators that support it read it directly, so the file stays small on disk and still boots. Check the emulator and platform you use before converting a collection.

## Compressed disc images: CHD and RVZ

**CHD** is a purpose-built container for media images. The official [chdman documentation](https://docs.mamedev.org/tools/chdman.html) covers raw, hard-disk, CD, and DVD images. rom-weaver creates CHD from `.cue`/`.gdi`/`.iso` inputs; the command is in [Extract, convert, and compress archives](../how-to/work-with-archives.md#compress-a-rom-or-disc-image-instead).

**RVZ** is Dolphin's format for GameCube and Wii discs. It understands disc padding, and [Dolphin](https://dolphin-emu.org/docs/faq/) plays it directly.

rom-weaver's parity suite checks that chdman and dolphin-tool can extract its CHD and RVZ outputs byte for byte, and that rom-weaver can extract the reference tools' outputs. The compressed container bytes and sizes may differ.

To change a format rom-weaver can open but not create, such as GCZ, WIA, WBFS, or CSO, extract it first and then create a format your emulator supports.

## 3DS ROM compression: Z3DS

**Z3DS** is a zstd-based, ROM-specific compression format for Nintendo 3DS payloads (`.3ds`, `.cci`, `.cxi`, `.cia`, and `.3dsx`). Its compressed forms (`.z3ds` and friends) are supported by [Azahar 2123 and later](https://azahar-emu.org/blog/compressed-backups/); it is not a disc image format.

## General archives: ZIP and 7z

Many emulators load cartridge ROMs straight from a ZIP, making it a practical default when your emulator supports it. Depending on the data and settings, 7z can produce a smaller archive, but direct emulator support is less consistent, so it fits long-term storage more than a play library. rom-weaver creates both, and the [archive formats guide](../how-to/work-with-archives.md) covers everyday extract and convert workflows.

Avoid double-wrapping: a CHD inside a 7z usually gains little, and most setups must extract the outer archive before booting it.

## Trim, compress, or both

Some cartridge and disc formats carry padding rather than data. Trimming cuts it off instead of squeezing it. rom-weaver trims NDS, GBA, and 3DS ROMs, Xbox XISO images, and RVZ scrub candidates. NDS, GBA, and 3DS trims can be restored; `--revert-marker` lets those formats return byte for byte instead of guessing the original padding. XISO and RVZ scrub trims cannot be reverted, so keep the source. For flashcarts and tight storage, a trimmed cartridge ROM needs no decompression. The [trim support](../reference/formats.md#trim-support) list has the details.

## Compression changes your checksums

A compressed file does not hash the same as the dump inside it, so a `.chd` will not match a database entry for the `.bin` it was made from. That is normal. `checksum` automatically unwraps many supported containers; use `--no-extract` when you mean to hash the wrapper bytes. `probe` identifies the container and reports its structure. If a patch guide expects a specific checksum, check the payload, and see [Fix a checksum error](../how-to/fix-checksum-errors.md) when it still disagrees.

## Which format should I choose?

- **CD/DVD console:** CHD when your emulator supports it.
- **GameCube or Wii:** RVZ for Dolphin and compatible tools.
- **Nintendo 3DS ROMs:** Z3DS for Azahar 2123 or later.
- **Cartridge ROMs you play:** ZIP when your emulator reads it directly, or a trimmed file where padding dominates.
- **Cold storage:** 7z when smaller general-purpose archives matter more than broad direct support.
- **Already in GCZ, WIA, WBFS, or CSO:** extract and create a supported modern format when your emulator can read it.

The [Supported formats](../reference/formats.md#container-and-compression-formats) reference is the authoritative table of every container, extension, and codec, including the `--codec` values each output accepts. Back to the [guide index](../README.md).
