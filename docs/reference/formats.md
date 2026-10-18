# Supported formats

This reference lists patch formats, containers, codecs, checksums, trim support, header handling, and browser emulators.

The [feature map](features.md) explains the capabilities in plain words. [Cheat systems](cheat-database.md) and [editable game saves](save-editor.md) have separate support tables.

<!-- START doctoc -->
## Table of contents

- [Legend](#legend)
- [Patch formats](#patch-formats)
- [Container and compression formats](#container-and-compression-formats)
  - [Z3DS filename variants](#z3ds-filename-variants)
- [Create-time codecs](#create-time-codecs)
- [Checksum support](#checksum-support)
- [Trim support](#trim-support)
- [Header detection and repair](#header-detection-and-repair)
- [Browser emulator support](#browser-emulator-support)

<!-- END doctoc -->

## Legend

Every support table uses these three marks. Each mark has its own shape and colour, so the tables still read without colour vision.

| Mark | Meaning |
| :---: | --- |
| ✅ | Supported. |
| ⚠️ | Partly supported. The limit appears beside the mark or in a numbered note. |
| ❌ | Not supported. |

## Patch formats

Every supported Apply entry also supports probe/parse, except DCP. DCP uses a specialized Dreamcast apply workflow rather than the general single-file parser.

| Format | Aliases | Extensions | Apply | Create |
| --- | --- | --- | :---: | :---: |
| IPS | none | `.ips` | ✅ | ✅ |
| IPS32 | none | `.ips32` | ✅ | ⚠️ ⁴ |
| SOLID | `solidpatch`, `solid-patch` | `.solid` | ✅ | ⚠️ ⁴ |
| BPS | none | `.bps` | ✅ | ✅ |
| UPS | none | `.ups` | ✅ | ✅ |
| VCDIFF | `vcdiff` | `.vcdiff` | ✅ | ⚠️ ⁴ |
| xdelta | `xdelta3` | `.xdelta`, `.delta`, `.dat` | ✅ | ✅ |
| GDIFF | `gdiff` | `.gdiff`, `.gdf` | ✅ | ⚠️ ⁴ |
| HDiffPatch/HPatchZ | `hdiffpatch`, `hdiff`, `hpatch`, `hpatchz` | `.hdiff`, `.hpatchz` | ⚠️ ¹ | ❌ |
| APS (N64) | none | `.aps` | ✅ | ✅ |
| APSGBA | `aps-gba` | `.apsgba` | ✅ | ⚠️ ⁴ |
| RUP | none | `.rup` | ✅ | ✅ |
| PPF | none | `.ppf` | ✅ | ✅ |
| PAT | `ffp`, `fireflower` | `.pat`, `.ffp` | ✅ | ⚠️ ⁴ |
| EBP | none | `.ebp` | ✅ | ✅ |
| BDF/BSDIFF40 | `bdf`, `bsdiff`, `bsdiff40` | `.bdf`, `.bsdiff`, `.bsdiff40` | ✅ | ✅ |
| BSP | `bspatch` | `.bsp`, `.bspatch` | ✅ | ❌ |
| MOD | `pmsr` | `.mod`, `.pmsr` | ✅ | ⚠️ ³ |
| DLDI | none | `.dldi` | ✅ | ⚠️ ⁴ |
| DPS | none | `.dps` | ✅ | ⚠️ ⁴ |
| DCP | none | `.dcp` | ⚠️ ² | ❌ |

> ¹ Single-file `.hdiff` and `.hpatchz` patches are supported. Directory patches (`HDIFF19`) are not supported.
>
> ² DCP requires a Dreamcast `.cue` or `.gdi` input and must be applied alone. Byte-level patch flags do not apply to this filesystem rebuild. This workflow is available through the native CLI, not browser Apply.
>
> ³ MOD patches target Paper Mario (USA) v1.0: 41,943,040 bytes, CRC32 `A7F5CD7E`. Browser Create in **Modified ROM** mode and the CLI format recommendation offer MOD only for that Original. The combined patch in Create's **Patches & cheats** mode and Apply's **Download a combined patch** list MOD for any Original. CLI `patch create --format mod` accepts another Original with a warning. A MOD patch made from another Original applies in the CLI only with `--ignore-checksum-validation`.
>
> ⁴ The native CLI creates this format. Browser Create does not offer it. Browser Apply supports it.

NINJA1 headers can be detected but not applied. PDS is unsupported.

## Container and compression formats

For everyday extract, convert, and compress steps, see [Extract, convert, and compress archives](../how-to/work-with-archives.md).

| Format | Aliases | Extensions | Probe | Extract | Create |
| --- | --- | --- | :---: | :---: | :---: |
| ZIP | none | `.zip` | ✅ | ✅ | ✅ |
| ZIPX | none | `.zipx` | ✅ | ✅ | ❌ |
| 7z | `7zip` | `.7z` | ✅ | ✅ | ✅ |
| RAR | none | `.rar` | ✅ | ✅ | ❌ |
| TAR | none | `.tar` | ✅ | ✅ | ❌ |
| TAR.GZ | `tgz` | `.tar.gz`, `.tgz` | ✅ | ✅ | ❌ |
| TAR.BZ2 | `tbz2` | `.tar.bz2`, `.tbz2` | ✅ | ✅ | ❌ |
| TAR.XZ | `txz` | `.tar.xz`, `.txz` | ✅ | ✅ | ❌ |
| Gzip | `gzip` | `.gz` | ✅ | ✅ | ❌ |
| Bzip2 | `bzip2` | `.bz2` | ✅ | ✅ | ❌ |
| XZ | `lzma`, `lzma2` | `.xz` | ✅ | ✅ | ❌ |
| Zstandard | `zstd`, `zstandard` | `.zst` | ✅ | ✅ | ❌ |
| CSO | `ciso` | `.cso`, `.ciso` | ✅ | ✅ ³ | ❌ |
| PBP | none | `.pbp` | ✅ | ✅ | ❌ |
| CHD | `chd-cd`, `chd-gd`, `chd-dvd`, `chd-raw`, `chd-hd`, `chd-av`, `chd-ld` | `.chd` | ✅ | ✅ ² | ✅ ² |
| GCZ | none | `.gcz` | ✅ | ✅ | ❌ |
| WIA | none | `.wia` | ✅ | ✅ | ❌ |
| TGC | none | `.tgc` | ✅ | ✅ | ❌ |
| NFS | none | `.nfs` | ✅ | ✅ | ❌ |
| WBFS | none | `.wbfs` | ✅ | ✅ | ❌ |
| RVZ | none | `.rvz` | ✅ | ✅ | ✅ |
| Z3DS | `3ds` | `.z3ds`, `.zcci`, `.zcxi`, `.zcia`, `.z3dsx` | ✅ | ✅ | ✅ |
| XISO | none | `.xiso`, `.xiso.iso` | ❌ | ⚠️ ¹ | ❌ |

> ¹ XISO extraction rebuilds the detected XDVDFS filesystem as a normalized ISO. Detailed `probe` reports and XISO creation are not supported.
>
> ² CHD parent and differential support exists in the Rust container API. The native CLI does not expose it. `extract --split-bin` affects CD images only.
>
> ³ CSO v1 (raw-deflate blocks) images extract. v2 images extract only in the `ciso` crate's layout (length-prefixed LZ4 blocks); `maxcso --format=cso2` output is not read. GameCube `.ciso` files share the extension but use a different layout and are not read as CSO.

When `compress` creates a CHD from a `.bin` or extensionless file, it uses the CD layout only on content evidence: a whole number of 2352-byte sectors that starts with the CD sync header or has an ISO9660 descriptor at sector 16, or a whole number of 2048-byte sectors with an ISO9660 descriptor at sector 16. Other such files become a hard-disk CHD when they carry a recognized partition table or boot sector, an A/V CHD for `chav` streams, and a raw CHD otherwise.

The browser's Compress page creates only CD, GD-ROM, and DVD CHDs, and it never inspects file contents to choose among them. It offers **CHD** for exactly one `.cue` or `.gdi` sheet whose referenced tracks are all supplied, with no unreferenced extra file and no duplicate track base names, or for a single `.bin` or `.iso` whose size is a whole number of 2048- or 2352-byte sectors. A second sheet, a missing or extra file, or duplicate track names leaves only ZIP and 7z. RVZ has no size check: it is offered for any single input with a GameCube or Wii extension such as `.iso`, including one whose size is not sector-aligned. A `.cue` or `.bin` input becomes a CD CHD, a `.gdi` a GD-ROM CHD, and an `.iso` a CD CHD up to 450,000 sectors of 2048 bytes (about 921 MB) or a DVD CHD above that. A hard-disk or raw image is not recognized: a `.bin` of that shape still gets the CD layout, and one with another extension or an unaligned size is offered only ZIP and 7z. Hard-disk, raw, and A/V CHD creation needs the native CLI.

### Z3DS filename variants

The browser's Z3DS output option selects the compressed extension from the source filename. Each subtype stores one Nintendo 3DS file.

| Source extension | Compressed extension | Extracted extension |
| --- | --- | --- |
| `.3ds` | `.z3ds` | Payload-dependent; `.3ds` if unrecognized |
| `.cci` | `.zcci` | `.cci` |
| `.cxi`, `.app` | `.zcxi` | `.cxi` |
| `.cia` | `.zcia` | `.cia` |
| `.3dsx` | `.z3dsx` | `.3dsx` |

For `.z3ds`, the payload signature determines the extracted extension: NCSD becomes `.cci`, NCCH becomes `.cxi`, CIA becomes `.cia`, and 3DSX becomes `.3dsx`.

Compression writes the payload type into the Z3DS header as `NCSD`, `NCCH`, `CIA\0`, or `3DSX`, as Azahar does, recognizing NCSD and NCCH at offset `0x100` and a CIA by its `0x2020` header size. A `.z3ds` written by an earlier rom-weaver release stored the payload's first four bytes instead, so only its CIA payloads still extract as `.cia`; NCSD and NCCH payloads extract as `.3ds`.

Z3DS compression and extraction preserve the payload bytes. They do not decrypt files or convert between cartridge images, CIA packages, and homebrew executables.

Browser procedures: [compress Nintendo 3DS files](../how-to/convert-to-z3ds-browser.md) and [extract Z3DS files](../how-to/extract-z3ds-browser.md).

## Create-time codecs

| Output | Supported `--codec` values |
| --- | --- |
| ZIP | `store`, `deflate`, `zstd` |
| 7z | `lzma2` |
| RVZ | `zstd` |
| Z3DS | `zstd` |
| CHD | `store`, `zlib`, `zstd`, `lzma`, `huff`, `flac`, `cdlz`, `cdzl`, `cdzs`, `cdfl`, `avhuff` |

`huffman` aliases `huff`; `avhu` aliases `avhuff`. CHD accepts repeated codec options for MAME-style codec lists.

Compression levels use these codec-aware profiles:

- `min`
- `very-low`
- `low`
- `medium`
- `high`
- `very-high`
- `max`

An explicit `codec:level` value overrides the global profile.

## Checksum support

Supported algorithms are `crc32`, `md5`, `sha1`, `sha256`, `blake3`, `crc32c`, `crc16`, and `adler32`.

Checksums can target source bytes, selected container payloads, or byte ranges (`--start`/`--length`). Known header and byte-order compatibility transforms appear as `checksum_variants`, including raw, headerless, repaired-header, and N64 byte orders. `--no-trim-fix` disables automatic trim-boundary variants.

## Trim support

`trim` supports:

- NDS-family ROMs (`.nds`, `.dsi`, `.srl`)
- GBA ROMs (`.gba`)
- 3DS images (`.3ds`) with validated NCSD/NCCH partition extents
- XISO images (`.xiso`, `.xiso.iso`, and probed XDVDFS `.iso` files)
- GameCube/Wii disc candidates detected by the format recommendation: lossless RVZ conversion, without sector scrubbing

A single disc conversion reports mode `rvz-convert` and `output_format: "rvz"`. Completed conversions also report logical disc byte counts in `input_size` and `raw_size`. The emitted file size is the compressed size. Separate output is required; sectors are not scrubbed.

`--in-place` rewrites the source file; `--output` or `--extension` write the trimmed copy elsewhere instead, and `-n`/`--dry-run` reports what would change without writing anything.

`--revert` pads a trimmed file back out, and works for NDS, GBA, and 3DS. XISO trimming and RVZ conversion do not support this operation. It also answers to `--untrim` and `--restore`.

`--revert-marker` (also `--reversible`) records the original length and one padding byte in a footer for NDS-family, GBA, and 3DS ROMs. XISO and RVZ conversion reject this option and cannot be reverted, even when a footer is present. Exact restoration requires unchanged retained data and uniformly padded removed bytes. The fill byte is recorded before trimming, including in-place operations. See the [footer format and limits](../development/trim-revert-footer.md).

## Header detection and repair

Probe, checksum, and patch apply recognize headers for A78, LNX, NES/FDS, SNES copier and SMC variants, PCE copier formats, Game Boy/GBA, Mega Drive, SMS/Game Gear, all N64 byte orders, NDS, Neo Geo Pocket, and MSX.

`patch apply --repair-checksum` can repair SNES, NES, Game Boy/GBA, Mega Drive, SMS/Game Gear, N64, Atari 7800/Lynx, PCE/TurboGrafx-16, Virtual Boy, Neo Geo Pocket, MSX, and NDS compatibility fields. It validates but does not rewrite FDS, Atari Jaguar, ColecoVision, Watara Supervision, or Intellivision headers.


For format specifications and upstream implementations, see [`references.md`](../development/references.md).

## Browser emulator support

The Test page supports these platforms:

- Atari 7800
- Atari Lynx
- Nintendo Entertainment System
- Nintendo Famicom Disk System (recognized, but does not start: it needs the FDS BIOS `disksys.rom`, which rom-weaver does not bundle and the Test page cannot load yet; tracked in [issue #1223](https://github.com/rom-weaver/rom-weaver/issues/1223))
- Nintendo Game Boy
- Nintendo Game Boy Color
- Nintendo Game Boy Advance
- Nintendo 64
- Nintendo DS
- Super Nintendo Entertainment System
- Sega Game Gear
- Sega Master System
- Sega Mega Drive or Genesis
- Sega Saturn
- Sony PlayStation
- Sony PSP

A PBP with an empty `DATA.PSAR` section, such as a PSP homebrew `EBOOT.PBP`, has no disc to extract. rom-weaver treats it as a PSP ROM, including inside nested archives, and the Test page passes it to the emulator core unchanged. `checksum` and `identify` use the PBP itself. `probe` reports it as a self-contained PSP executable, and direct `extract` rejects it.

The Test page passes recognized PlayStation and Mega Drive or Genesis `.chd` files to the emulator core without extraction. rom-weaver reads the payload SHA-1 from the CHD header and the platform from the disc data, without extracting the file. Every other CHD is extracted first, including a Saturn CHD (the Saturn core cannot read one), as is a CHD inside a ZIP or 7z archive. A disc image keeps its real extension (`.iso`, `.cue`, `.img`, `.mds`, `.mdf`, `.ccd`, `.gdi`, `.toc`, `.cso`, `.pbp`, `.m3u`, and `.bin` on PlayStation and Saturn) when it reaches the emulator, so EmulatorJS and the core can tell the format apart. A core can still lack an extension: the Saturn core does not list `.bin`, `.img`, or `.mdf`, so EmulatorJS treats those as raw 2352-byte tracks and invents a cue sheet. The one exception is a `.bin` whose cue sheet lists a single file with one `MODE1/2048` or `MODE2/2048` track: that `.bin` reaches the emulator as `.iso`, because its sectors are plain ISO data.

rom-weaver does not bundle EmulatorJS cores for these platforms:

- Nintendo GameCube
- Nintendo Wii
- Nintendo 3DS
- Sega CD
- Sega Dreamcast
- Sony PlayStation 2
- NEC PC Engine
- NEC PC Engine CD
- SNK Neo Geo Pocket

[Load and test a ROM](../how-to/test-roms-in-browser.md) covers the browser controls. Patch and container support do not imply emulator support.
