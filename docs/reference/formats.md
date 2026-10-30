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
> ³ MOD patches target Paper Mario (USA) v1.0: 41,943,040 bytes, CRC32 `A7F5CD7E`. Browser Create in **Modified ROM** mode and the CLI format recommendation offer MOD only for that Original and only when the Modified ROM is not smaller. The combined patch in Create's **Patches & cheats** mode and Apply's **Download a combined patch** do not list MOD. CLI `patch create --format mod` accepts another Original with a warning. A MOD patch made from another Original applies in the CLI only with `--ignore-checksum-validation`.
>
> ⁴ The native CLI creates this format. Browser Create does not offer it. Browser Apply supports it.

PPF, EBP, and MOD cannot encode a target smaller than the Original. Browser Create hides them for such a target, and CLI `patch create` and `patch create --plan` reject or omit them.

BSP scripts with nonempty menus fail during apply or validation in the browser and CLI. Interactive choices are unsupported; no branch is selected automatically. Scripts without menus and empty menus remain supported.

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
| LZ4 frame | none | `.lz4` | ✅ | ✅ | ❌ |
| CSO | `ciso` | `.cso`, `.ciso` | ✅ | ✅ ³ | ❌ |
| PBP | none | `.pbp` | ✅ | ✅ | ❌ |
| CHD | `chd-cd`, `chd-gd`, `chd-dvd`, `chd-raw`, `chd-hd`, `chd-av`, `chd-ld` | `.chd` | ✅ | ✅ ² | ✅ ² |
| GameCube CISO | `gc-ciso` | `.ciso` | ✅ | ✅ ⁵ | ❌ |
| GCZ | none | `.gcz` | ✅ | ✅ | ❌ |
| WIA | none | `.wia` | ✅ | ✅ | ❌ |
| TGC | none | `.tgc` | ✅ | ✅ | ❌ |
| NFS | none | `.nfs` | ✅ | ✅ | ❌ |
| WBFS | none | `.wbfs` | ✅ | ✅ ⁴ | ❌ |
| RVZ | none | `.rvz` | ✅ | ✅ | ✅ |
| Z3DS | `3ds` | `.z3ds`, `.zcci`, `.zcxi`, `.zcia`, `.z3dsx` | ✅ | ✅ | ✅ |
| XISO | none | `.xiso`, `.xiso.iso` | ❌ | ⚠️ ¹ | ❌ |

> ¹ XISO extraction rebuilds the detected XDVDFS filesystem as a normalized ISO. Detailed `probe` reports and XISO creation are not supported.
>
> ² CHD parent and differential support exists in the Rust container API. The native CLI does not expose it. `extract --split-bin` affects CD images only.
>
> ³ CSO v1 (raw-deflate blocks) and v2 images extract, including `maxcso --format=cso2` output (deflate, bare LZ4 from `--only-lz4`, and raw blocks) and the `ciso` crate's length-prefixed LZ4 layout. As in maxcso, a v2 block with the high index bit clear whose stored length reaches the header block size is raw (a block with the bit set and such a length is rejected), and a final partial block is read as a block padded to the block size and then truncated. Support for maxcso output is tested against images generated to maxcso's documented layout, not against output from a maxcso build. GameCube `.ciso` files share the extension but use a different layout; they are detected from the header and read as GameCube CISO (see ⁵), not as CSO.
>
> ⁴ WBFS holds one disc per file. The native CLI reads split sets written for FAT32 (`.wbfs` plus `.wbf1`, `.wbf2`, ...) when every part sits beside the first, and rejects a set with a missing part as an invalid file size. Whole WBFS drive images that hold several games are not supported and fail with "Only single WBFS discs are supported". Discs over 4 GiB are read with 64-bit offsets. `compress` to RVZ reads every part from the first. ZIP and 7z store only the files passed as `--input`, so `compress` to them fails unless every part (`.wbfs`, `.wbf1`, ...) is passed. CHD and z3ds take one input, so they refuse a split set. Browser Extract reads a split set when every part is added in the same selection or drop; other browser workflows take a single `.wbfs` file. `probe` reports the platform, disc format, container entry, game ID, and title, plus each Wii partition's kind and data size. A title that is not valid UTF-8, such as a Shift-JIS title on a Japanese disc, is left out.
>
> ⁵ GameCube CISO shares the `CISO` magic and `.ciso` extension with PSP CSO. The value at bytes 4..8 separates them: 24 (any version) or 0 (v1 and earlier) is PSP CSO, a non-zero multiple of 32 KiB is the GameCube block size. GameCube CISO is extract-only, decoded by the same disc reader as GCZ and WBFS; extract writes an ISO, which `compress` accepts for RVZ, ZIP, or 7z. Creating `.ciso` is not supported.

Archive member names keep their exact Unicode spelling. A name that is not valid UTF-8 and carries no charset marker, as in older ZIP and tar files, is decoded as Shift-JIS when it reads as Japanese text, otherwise as CP437 for ZIP, RAR, CAB, and LHA and as Windows-1252 for tar and other Unix formats. For ZIP and tar, the result does not depend on the platform, locale, or code page. RAR5 stores names as UTF-8 and always reads them that way, so a RAR5 member name that is not valid UTF-8 is rejected as invalid data, except for a skipped link, whose name is only logged.

When `compress` creates a CHD from a `.bin` or extensionless file, recognized disk headers take precedence. Other inputs use the CD layout only on content evidence: a whole number of 2352-byte sectors that starts with the CD sync header or has an ISO9660 descriptor at sector 16, or a whole number of 2048-byte sectors, at most 450,000 of them, with an ISO9660 descriptor at sector 16 and no UDF descriptor. A whole number of 2048-byte sectors with a UDF `NSR02` or `NSR03` descriptor in sectors 16 to 31, or with an ISO9660 descriptor and more than 450,000 sectors, uses the DVD layout. `chav` streams use A/V CHD layout; remaining files use raw CHD layout. An `.iso` with a UDF descriptor also uses the DVD layout at any size.

The browser's Compress page offers CHD for optical inputs under the following rules. It offers **CHD** for exactly one `.cue` or `.gdi` sheet whose referenced tracks are all supplied, with no unreferenced extra file and no duplicate track base names, or for a single `.iso` whose size is a whole number of 2048- or 2352-byte sectors, or a single `.bin` that passes the content check above (the browser reads the header through the engine; a size-aligned `.bin` without that evidence, such as a cartridge dump, is offered only ZIP and 7z). On Apply and Weave, the output format of a `.bin` defaults to CHD only under the same content check or when a supplied `.cue` or `.gdi` names it; otherwise it defaults to the input's own extension. A second sheet, a missing or extra file, or duplicate track names leaves only ZIP and 7z. RVZ has no size check: it is offered for any single input with a GameCube or Wii extension such as `.iso`, including one whose size is not sector-aligned. A `.cue` input becomes a CD CHD, a `.gdi` a GD-ROM CHD, and an `.iso` a CD CHD up to 450,000 sectors of 2048 bytes (about 921 MB) or a DVD CHD above that or when it carries a UDF descriptor. A hard-disk or raw image without optical evidence is not offered CHD automatically.

Explicit CHD output on Apply and Weave accepts raw and hard-disk inputs. Valid disk headers take precedence over CD signatures, including inside archives. Raw and disk inputs use generic codecs from the DVD codec setting. A `.bin` name or sector alignment alone does not select CD codecs.

A/V CHD creation needs the native CLI.

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

A PlayStation PBP is opened like an archive of disc images. A single-disc PBP extracts to `<name>.cue` and `<name>.bin`; a multi-disc PBP extracts every disc as `<name>.disc01.cue` and `<name>.disc01.bin`, `<name>.disc02.cue`, and so on. BIN sizing depends on the producer's TOC convention.

Audio beyond the ISO volume is retained when the TOC describes audio, its first track starts at `00:00:00`, and the leadout fits the ISO volume and validated index table. This follows PSXPackager's full-BIN leadout convention. Other layouts use the ISO volume.

The populated index count must cover the block count required by the selected disc extent; missing blocks are rejected. Surplus blocks past the extent are ignored with a warning. Each decoded block must cover its own extent; the final block may be short or padded.

`checksum` and `identify` hash one extracted file, so they need `--select <name>.bin`, or `--select <name>.discNN.bin` for a multi-disc PBP. A CHD holds a single disc, so CHD conversion takes one disc's cue sheet per run; with several discs selected, the Compress page offers only ZIP and 7z, which keep every selected cue and bin file in one archive. The CLI `compress` command does not open a PBP: it stores the `.pbp` file as is.

For a selected PS1 `.pbp`, including one inside nested archives, the Test page validates every disc. The Test page extracts every cue and bin file from every validated PS1 PBP, regardless of compression or index layout, then prepares a ZIP with an M3U playlist through the existing playlist command. The bundle retains every extracted disc and track, within the sizing rules above.

EmulatorJS unpacks the ZIP and exposes its native disc controls when the core reports multiple discs. Temporary bundle members use a fixed ASCII basename so original filenames cannot become playlist comments. The metadata probe reports the disc count, stored-block count, and whether every disc has a validated end-offset marker in its first unused index slot.

Single-disc PBP saves keep the extracted disc's SHA-1 identity, matching earlier Test sessions. Multi-disc PBP saves use the SHA-1 of the complete PBP; saves from earlier first-disc Test sessions require manual export/import. Preparing any PS1 PBP bundle temporarily keeps the expanded discs and ZIP in browser storage, and EmulatorJS unpacks the bundle into memory. Large multi-disc games can exceed browser storage or memory. The Test page retains the selected inner PBP while opening outer archives, so its save identity is independent of outer archive bytes and names. Other workflows continue recursive extraction by default. General browser M3U playlist creation is tracked in [#1227](https://github.com/rom-weaver/rom-weaver/issues/1227). Compatibility with commercial games and in-game requests to change discs has not been verified.

A PSP PBP stays byte-identical for `checksum`, `identify`, ingest, and nested archives; the Test page passes it unchanged to the PSP core. Supported layouts are:

- An empty `DATA.PSAR` section (the existing PSP homebrew path).
- `DATA.PSAR` beginning with `NPUMDIMG` and containing at least its 256-byte header.
- A nonempty asset `DATA.PSAR` with a recognized `DATA.PSP` executable: a complete 52-byte ELF32 little-endian version-1 MIPS header (machine 8, ELF version 1, header size 52), or `~PSP` with at least its 336-byte PRX header.

All eight PBP section offsets must be nondecreasing, start at or after the 40-byte PBP header, and remain within the file. Executable headers must fit entirely inside `DATA.PSP`. The PS1 `PSISOIMG` and `PSTITLEIMG` prefixes take precedence over PSP executable recognition; their supported `PSISOIMG0000` and `PSTITLEIMG000000` signatures retain disc validation, and unknown versions are rejected. A truncated `NPUMDIMG` header is rejected even with a recognized executable. Unknown PSAR data without a recognized executable is rejected. These checks classify containers; they do not authenticate encrypted content or prove an executable boots. rom-weaver does not decrypt or extract PSP PSAR content. `probe` distinguishes the supported PSP layouts; direct `extract` explains that there is no extractable PS1 disc and keeps the PBP intact.

The [PBP format specification](https://www.psdevwiki.com/ps3/PBP) describes the section table. Header sizes and executable recognition follow [PPSSPP’s PBP reader](https://github.com/hrydgard/ppsspp/blob/master/Core/ELF/PBPReader.h), [loader](https://github.com/hrydgard/ppsspp/blob/master/Core/Loaders.cpp), [NPUMDIMG reader](https://github.com/hrydgard/ppsspp/blob/master/Core/FileSystems/BlockDevices.cpp), and [PRX header](https://github.com/hrydgard/ppsspp/blob/master/Core/ELF/PrxDecrypter.h).

The Test page passes recognized PlayStation and Mega Drive or Genesis `.chd` files to the emulator core without extraction. rom-weaver reads the payload SHA-1 from the CHD header and the platform from the disc data, without extracting the file. Every other CHD is extracted first, including a Saturn CHD (the Saturn core cannot read one), as is a CHD inside a ZIP or 7z archive. A disc image keeps its real extension (`.iso`, `.cue`, `.img`, `.mds`, `.mdf`, `.ccd`, `.gdi`, `.toc`, `.cso`, `.pbp`, `.m3u`, `.zip` bundles, and `.bin` on PlayStation and Saturn) when it reaches the emulator, so EmulatorJS and the core can tell the format apart. A core can still lack an extension: the Saturn core does not list `.bin`, `.img`, or `.mdf`, so EmulatorJS treats those as raw 2352-byte tracks and invents a cue sheet. The one exception is a `.bin` whose cue sheet lists a single file with one `MODE1/2048` or `MODE2/2048` track: that `.bin` reaches the emulator as `.iso`, because its sectors are plain ISO data.

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
