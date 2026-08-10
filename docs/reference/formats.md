# Supported formats

This is the authoritative support matrix for everything rom-weaver reads and writes. It covers every patch format the tool can apply and create, every container and format-specific compressed ROM or disc image it can probe, extract, and build, and the codecs available at create time. It also lists the checksum, trim, and header capabilities that surround them.

<!-- START doctoc -->
## Table of contents

- [Legend](#legend)
- [Patch formats](#patch-formats)
- [Container and compression formats](#container-and-compression-formats)
- [Create-time codecs](#create-time-codecs)
- [Checksum support](#checksum-support)
- [Trim support](#trim-support)
- [Header detection and repair](#header-detection-and-repair)

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
| IPS32 | none | `.ips32` | ✅ | ✅ |
| SOLID | `solidpatch`, `solid-patch` | `.solid` | ✅ | ✅ |
| BPS | none | `.bps` | ✅ | ✅ |
| UPS | none | `.ups` | ✅ | ✅ |
| VCDIFF | `vcdiff` | `.vcdiff` | ✅ | ✅ |
| xdelta | `xdelta3` | `.xdelta`, `.delta`, `.dat` | ✅ | ✅ |
| GDIFF | `gdiff` | `.gdiff`, `.gdf` | ✅ | ✅ |
| HDiffPatch/HPatchZ | `hdiffpatch`, `hdiff`, `hpatch`, `hpatchz` | `.hdiff`, `.hpatchz` | ⚠️ ¹ | ❌ |
| APS (N64) | none | `.aps` | ✅ | ✅ |
| APSGBA | `aps-gba` | `.apsgba` | ✅ | ✅ |
| RUP | none | `.rup` | ✅ | ✅ |
| PPF | none | `.ppf` | ✅ | ✅ |
| PAT | `ffp`, `fireflower` | `.pat`, `.ffp` | ✅ | ✅ |
| EBP | none | `.ebp` | ✅ | ✅ |
| BDF/BSDIFF40 | `bdf`, `bsdiff`, `bsdiff40` | `.bdf`, `.bsdiff`, `.bsdiff40` | ✅ | ✅ |
| BSP | `bspatch` | `.bsp`, `.bspatch` | ✅ | ❌ |
| MOD | `pmsr` | `.mod`, `.pmsr` | ✅ | ✅ |
| DLDI | none | `.dldi` | ✅ | ✅ |
| DPS | none | `.dps` | ✅ | ✅ |
| DCP | none | `.dcp` | ⚠️ ² | ❌ |

> ¹ Single-file `.hdiff` and `.hpatchz` patches are supported. Directory patches (`HDIFF19`) are not supported.
>
> ² DCP requires a Dreamcast `.cue` or `.gdi` input and must be applied alone. Byte-level patch flags do not apply to this filesystem rebuild.

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
| CSO | `ciso` | `.cso`, `.ciso` | ✅ | ✅ | ❌ |
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
- 3DS images (`.3ds`)
- XISO images (`.xiso`, `.xiso.iso`, and probed XDVDFS `.iso` files)
- RVZ scrub candidates detected by the format recommendation

`--in-place` rewrites the source file; `--output` or `--extension` write the trimmed copy elsewhere instead, and `-n`/`--dry-run` reports what would change without writing anything.

`--revert` pads a trimmed file back out, and works for NDS, GBA, and 3DS. XISO and RVZ scrub cannot be reverted. It also answers to `--untrim` and `--restore`.

`--revert-marker` (also `--reversible`) embeds a small footer so a later revert reproduces the original padding exactly rather than guessing at it; see the [footer format](../development/trim-revert-footer.md).

## Header detection and repair

Probe, checksum, and patch apply recognize headers for A78, LNX, NES/FDS, SNES copier and SMC variants, PCE copier formats, Game Boy/GBA, Mega Drive, SMS/Game Gear, all N64 byte orders, NDS, Neo Geo Pocket, and MSX.

`patch apply --repair-checksum` can repair SNES, NES, Game Boy/GBA, Mega Drive, SMS/Game Gear, N64, Atari 7800/Lynx, PCE/TurboGrafx-16, Virtual Boy, Neo Geo Pocket, MSX, and NDS compatibility fields. It validates but does not rewrite FDS, Atari Jaguar, ColecoVision, Watara Supervision, or Intellivision headers.


For format specifications and upstream implementations, see [`references.md`](../development/references.md).
