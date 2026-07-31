# Supported formats

The authoritative support matrix for everything rom-weaver reads and writes:
every patch format it can apply and create, every container and compressed
disc image it can probe, extract, and build, the codecs available at create
time, and the checksum, trim, and header capabilities that surround them.

<!-- START doctoc -->
## Table of contents

- [Patch formats](#patch-formats)
- [Container and compression formats](#container-and-compression-formats)
- [Create-time codecs](#create-time-codecs)
- [Checksum support](#checksum-support)
- [Trim support](#trim-support)
- [Header detection and repair](#header-detection-and-repair)

<!-- END doctoc -->


## Patch formats

All formats marked Apply also support probe/parse. DCP is a specialized
Dreamcast apply workflow rather than a general single-file patch parser.

| Format | Aliases | Extensions | Apply | Create |
| --- | --- | --- | :---: | :---: |
| IPS | none | `.ips` | yes | yes |
| IPS32 | none | `.ips32` | yes | yes |
| SOLID | `solidpatch`, `solid-patch` | `.solid` | yes | yes |
| BPS | none | `.bps` | yes | yes |
| UPS | none | `.ups` | yes | yes |
| VCDIFF | `vcdiff` | `.vcdiff` | yes | yes |
| xdelta | `xdelta3` | `.xdelta`, `.delta`, `.dat` | yes | yes |
| GDIFF | `gdiff` | `.gdiff`, `.gdf` | yes | yes |
| HDiffPatch/HPatchZ | `hdiffpatch`, `hdiff`, `hpatch`, `hpatchz` | `.hdiff`, `.hpatchz` | yes | no |
| APS (N64) | none | `.aps` | yes | yes |
| APSGBA | `aps-gba` | `.apsgba` | yes | yes |
| RUP | none | `.rup` | yes | yes |
| PPF | none | `.ppf` | yes | yes |
| PAT | `ffp`, `fireflower` | `.pat`, `.ffp` | yes | yes |
| EBP | none | `.ebp` | yes | yes |
| BDF/BSDIFF40 | `bdf`, `bsdiff`, `bsdiff40` | `.bdf`, `.bsdiff`, `.bsdiff40` | yes | yes |
| BSP | `bspatch` | `.bsp`, `.bspatch` | yes | no |
| MOD | `pmsr` | `.mod`, `.pmsr` | yes | yes |
| DLDI | none | `.dldi` | yes | yes |
| DPS | none | `.dps` | yes | yes |
| DCP | none | `.dcp` | yes | no |

HDiffPatch directory patches (`HDIFF19`) are not supported; single-file
`.hdiff` and `.hpatchz` patches are supported. NINJA1 headers can be detected
but not applied, and PDS is unsupported.

## Container and compression formats

For a shorter guide focused on everyday archive files, see
[Archive formats](../usage/formats.md).

| Format | Aliases | Extensions | Probe | Extract | Create |
| --- | --- | --- | :---: | :---: | :---: |
| ZIP | none | `.zip` | yes | yes | yes |
| ZIPX | none | `.zipx` | yes | yes | no |
| 7z | `7zip` | `.7z` | yes | yes | yes |
| RAR | none | `.rar` | yes | yes | no |
| TAR | none | `.tar` | yes | yes | no |
| TAR.GZ | `tgz` | `.tar.gz`, `.tgz` | yes | yes | no |
| TAR.BZ2 | `tbz2` | `.tar.bz2`, `.tbz2` | yes | yes | no |
| TAR.XZ | `txz` | `.tar.xz`, `.txz` | yes | yes | no |
| Gzip | `gzip` | `.gz` | yes | yes | no |
| Bzip2 | `bzip2` | `.bz2` | yes | yes | no |
| XZ | `lzma`, `lzma2` | `.xz` | yes | yes | no |
| Zstandard | `zstd`, `zstandard` | `.zst` | yes | yes | no |
| CSO | `ciso` | `.cso`, `.ciso` | yes | yes | no |
| PBP | none | `.pbp` | yes | yes | no |
| CHD | `chd-cd`, `chd-gd`, `chd-dvd`, `chd-raw`, `chd-hd`, `chd-av`, `chd-ld` | `.chd` | yes | yes | yes |
| GCZ | none | `.gcz` | yes | yes | no |
| WIA | none | `.wia` | yes | yes | no |
| TGC | none | `.tgc` | yes | yes | no |
| NFS | none | `.nfs` | yes | yes | no |
| WBFS | none | `.wbfs` | yes | yes | no |
| RVZ | none | `.rvz` | yes | yes | yes |
| Z3DS | `3ds` | `.z3ds`, `.zcci`, `.zcxi`, `.zcia`, `.z3dsx` | yes | yes | yes |
| XISO | none | `.xiso`, `.xiso.iso` | no | yes | no |

XISO extraction rebuilds the detected XDVDFS filesystem as a normalized ISO;
detailed `probe` reports and XISO creation are not supported. CHD
parent/differential support exists in the Rust container API but is not exposed
as a native CLI flag. `extract --split-bin` affects CHD CD extraction only.

## Create-time codecs

| Output | Supported `--codec` values |
| --- | --- |
| ZIP | `store`, `deflate`, `zstd` |
| 7z | `lzma2` |
| RVZ | `zstd` |
| Z3DS | `zstd` |
| CHD | `store`, `zlib`, `zstd`, `lzma`, `huff`, `flac`, `cdlz`, `cdzl`, `cdzs`, `cdfl`, `avhuff` |

`huffman` aliases `huff`; `avhu` aliases `avhuff`. CHD accepts repeated codec
options for MAME-style codec lists.

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

Supported algorithms are `crc32`, `md5`, `sha1`, `sha256`, `blake3`,
`crc32c`, `crc16`, and `adler32`.

Checksums can target source bytes, selected container payloads, or byte
ranges (`--start`/`--length`).
Known header and byte-order compatibility transforms appear as
`checksum_variants`, including raw, headerless, repaired-header, and N64 byte
orders. `--no-trim-fix` disables automatic trim-boundary variants.

## Trim support

`trim` supports:

- NDS-family ROMs (`.nds`, `.dsi`, `.srl`)
- GBA ROMs (`.gba`)
- 3DS images (`.3ds`)
- XISO images (`.xiso`, `.xiso.iso`, and probed XDVDFS `.iso` files)
- RVZ scrub candidates detected by the format recommendation

`--in-place` rewrites the source file; `--output` or `--extension` write the
trimmed copy elsewhere instead, and `-n`/`--dry-run` reports what would change
without writing anything.

`--revert` pads a trimmed file back out, and works for NDS, GBA, and 3DS. XISO
and RVZ scrub cannot be reverted. It also answers to `--untrim` and
`--restore`.

`--revert-marker` (also `--reversible`) embeds a small footer so a later revert
reproduces the original padding exactly rather than guessing at it; see the
[footer format](../development/trim-revert-footer.md).

## Header detection and repair

Probe, checksum, and patch apply recognize headers for A78, LNX, NES/FDS,
SNES copier and SMC variants, PCE copier formats, Game Boy/GBA, Mega Drive,
SMS/Game Gear, all N64 byte orders, NDS, Neo Geo Pocket, and MSX.


For format specifications and upstream implementations, see
[`references.md`](../development/references.md).
