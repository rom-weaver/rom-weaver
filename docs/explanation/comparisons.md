# Comparison with similar tools

rom-weaver overlaps with a handful of established tools, each narrower than it
is. This page says where the overlap is real and where it is not, so you can
tell which tool fits your job.

<!-- START doctoc -->
## Table of contents

- [The landscape](#the-landscape)
- [RomPatcher.js](#rompatcherjs)
  - [What each tool is](#what-each-tool-is)
  - [Patch formats](#patch-formats)
  - [Archive and compressed image formats](#archive-and-compressed-image-formats)
  - [Checksums](#checksums)
  - [Headers and byte order](#headers-and-byte-order)
  - [Patching features](#patching-features)
  - [Beyond patching](#beyond-patching)
  - [Delivery and platforms](#delivery-and-platforms)
  - [Which one should you use?](#which-one-should-you-use)
- [How this page was checked](#how-this-page-was-checked)

<!-- END doctoc -->

## The landscape

| Tool | What it does | Overlap with rom-weaver |
| --- | --- | --- |
| [RomPatcher.js](https://github.com/marcrobledo/RomPatcher.js) | Applies and creates ROM patches in a browser tab or Node | Large. Compared row by row below. |
| [Floating IPS (Flips)](https://github.com/Alcaro/Flips) | Applies and creates IPS and BPS patches | Patch apply and create, for two formats |
| [MultiPatch](https://projects.sappharad.com/multipatch/) | macOS patcher for IPS, BPS, PPF, and more | Patch apply and create |
| [xdelta3](https://github.com/jmacd/xdelta) | General VCDIFF delta compressor | The xdelta and VCDIFF families |
| [chdman](https://docs.mamedev.org/tools/chdman.html) | Converts disc images to and from CHD | CHD extract and create |
| [Dolphin tool](https://github.com/dolphin-emu/dolphin) | Converts GameCube and Wii images to and from RVZ | RVZ extract and create |

The single-purpose tools are the reference implementations rom-weaver is tested
against. Its CHD and RVZ output is checked byte-for-byte against chdman and
Dolphin tool, and its patch output against Flips and MultiPatch, so choosing
rom-weaver for those jobs is a question of convenience, not of different bytes.
The full list of specifications and implementations consulted is in
[references](../development/references.md).

Only RomPatcher.js is compared feature by feature below, because it is the
only one of these with a scope broad enough for a like-for-like table.

## RomPatcher.js

[RomPatcher.js](https://github.com/marcrobledo/RomPatcher.js) is the browser
patcher most ROM hacks link to, so it is the tool people are most likely to be
choosing between.

### What each tool is

RomPatcher.js is a single-purpose patcher. You give it a ROM and a patch, and
it hands back the patched ROM. It is a handful of dependency-free JavaScript
files, it embeds into any web page, and it also runs as a small Node command.
Its scope is deliberately narrow.

rom-weaver is a ROM workflow tool. Patching is one of its commands; the others
probe, extract, compress, hash, trim, and record what you did. The engine is
Rust, compiled twice: once as a native binary, once as WebAssembly for the
browser. Both front ends run the same code.

Neither tool uploads your files. RomPatcher.js runs in JavaScript in your tab;
the rom-weaver webapp runs WebAssembly in your tab. See
[Why your files stay on your device](local-first.md).

### Patch formats

rom-weaver reads 21 patch families. RomPatcher.js reads 11 of them.

| Format | RomPatcher.js apply | rom-weaver apply | RomPatcher.js create | rom-weaver create |
| --- | :---: | :---: | :---: | :---: |
| IPS | yes | yes | yes | yes |
| IPS32 | no | yes | no | yes |
| EBP | yes | yes | yes | yes |
| BPS | yes | yes | yes | yes |
| UPS | yes | yes | yes | yes |
| PPF | yes | yes | yes | yes |
| RUP | yes | yes | yes | yes |
| APS (N64) | yes | yes | yes | yes |
| APSGBA | yes | yes | no | yes |
| BDF/BSDIFF40 | yes | yes | no | yes |
| MOD (PMSR) | yes | yes | no | yes |
| VCDIFF | partial | yes | no | yes |
| xdelta | partial | yes | no | yes |
| SOLID | no | yes | no | yes |
| GDIFF | no | yes | no | yes |
| PAT (FireFlower) | no | yes | no | yes |
| DLDI | no | yes | no | yes |
| DPS | no | yes | no | yes |
| BSP | no | yes | no | no |
| HDiffPatch/HPatchZ | no | yes | no | no |
| DCP (Dreamcast) | no | yes | no | no |

"Partial" for VCDIFF and xdelta means RomPatcher.js decodes plain VCDIFF but
throws on two optional parts of the spec: a secondary compressor and a custom
code table. Most `.xdelta` patches from xdelta3 use the `djw` secondary
compressor, so they fail. rom-weaver decodes both.

Counting creation: RomPatcher.js writes 7 formats, rom-weaver writes 18.

rom-weaver also has gaps. It detects NINJA1 headers but cannot apply them, it
does not support PDS, and it does not support HDiffPatch directory patches
(`HDIFF19`). RomPatcher.js supports none of those either.

### Archive and compressed image formats

RomPatcher.js reads ZIP. It unzips a dropped ROM, a dropped patch, or a set of
patches shipped with an embedded build. That is the whole list. It cannot
create archives, and its patch builder rejects zipped ROMs outright.

rom-weaver probes and extracts 22 container and compressed-image formats, and
creates 5 of them.

| Format | RomPatcher.js | rom-weaver extract | rom-weaver create |
| --- | :---: | :---: | :---: |
| ZIP | extract | yes | yes |
| ZIPX | no | yes | no |
| 7z | no | yes | yes |
| RAR | no | yes | no |
| TAR (plain, gz, bz2, xz) | no | yes | no |
| Gzip, Bzip2, XZ, Zstandard | no | yes | no |
| CHD | no | yes | yes |
| RVZ | no | yes | yes |
| Z3DS | no | yes | yes |
| GCZ, WIA, TGC, NFS, WBFS | no | yes | no |
| CSO, PBP | no | yes | no |
| XISO | no | yes | no |

The practical difference: rom-weaver can take a `.chd` or `.rvz` disc image,
patch the ROM inside, and pack the result back up. RomPatcher.js needs a plain
ROM file.

### Checksums

| | RomPatcher.js | rom-weaver |
| --- | --- | --- |
| Algorithms | CRC32, MD5, SHA-1 | CRC32, CRC32C, CRC16, MD5, SHA-1, SHA-256, BLAKE3, Adler-32 |
| Shows ROM hashes before patching | yes | yes |
| Verifies checksums stored in the patch | yes | yes |
| Assert an expected input hash | no | `--expect-in` |
| Assert an expected output hash | no | `--expect-out` |
| Hash a byte range | no | `--start`/`--length` |
| Hash a file inside an archive | no | yes |
| Header and byte-order hash variants | N64 only | all detected headers, plus trim boundaries |

The variants row matters when a patch's readme lists a CRC32 you cannot
reproduce. rom-weaver reports the hash of the raw file, the headerless file,
the repaired-header file, and each N64 byte order at once, so you can see which
one the author meant. See
[Fix a checksum error](../how-to/fix-checksum-errors.md).

### Headers and byte order

RomPatcher.js can strip or inject a header for four formats: iNES (`.nes`),
fwNES (`.fds`), LNX (`.lnx`), and SNES copier (`.sfc`, `.smc`, `.swc`,
`.fig`). It picks by file extension and file size.

rom-weaver detects headers for A78, LNX, NES and FDS, SNES copier and SMC
variants, PCE copier formats, Game Boy and GBA, Mega Drive, SMS and Game Gear,
all N64 byte orders, NDS, Neo Geo Pocket, and MSX.

Header checksum repair after patching splits the same way.

| | RomPatcher.js | rom-weaver |
| --- | --- | --- |
| Repairs | Game Boy, Mega Drive | SNES, NES, Game Boy/GBA, Mega Drive, SMS/Game Gear, N64, Atari 7800, Lynx, PCE/TurboGrafx-16, Virtual Boy, Neo Geo Pocket, MSX, NDS |
| Header strip mode | manual on/off | `auto`, `keep`, or `strip`, decided per patch from its source checksum |
| Output header mode | follows the input choice | separate `auto`, `keep`, or `strip` |
| N64 byte order | detects `.z64` for its CRC display | converts between big-endian, little-endian, and byte-swapped to match the patch, then writes back in the original order |

### Patching features

| Feature | RomPatcher.js | rom-weaver |
| --- | :---: | :---: |
| Apply one patch | yes | yes |
| Chain several patches in order | no | yes, repeat `--patch` |
| Validate without writing | no | `patch validate` |
| Check each patch independently | no | `--independent` |
| Auto-find patches next to the ROM in an archive | no | yes |
| Bake in Game Genie / GameShark codes | no | `--code` |
| Undo a PPF3 patch | no | `tools ppf-undo` |
| Override a failed checksum | yes | `--ignore-checksum-validation` |
| Patch metadata on create | RUP description, EBP JSON | RUP description, EBP JSON |
| Machine-readable output | no | `--json` |

RomPatcher.js applies exactly one patch per run. Hacks that ship a base patch
plus an update need two passes, and you have to keep the intermediate file.

### Beyond patching

These have no RomPatcher.js equivalent at all.

- **Trim.** Cut padding off NDS, GBA, 3DS, and XISO images, and scrub RVZ
  candidates. `--revert` pads them back, and `--revert-marker` stores a footer
  so the revert is exact.
- **Compress.** Build ZIP, 7z, CHD, RVZ, and Z3DS, with per-codec compression
  levels.
- **Probe.** Identify a file, its platform, and its header, including from
  stdin.
- **Ingest.** Sort a mixed folder into ROMs and patches, unpacking and hashing
  as it goes.
- **Bundles.** Write a `rom-weaver-bundle.json` recipe that records the ROM's
  checksums, the patch order, and the expected result, so someone else can
  reproduce your build. See [What a bundle is](bundles.md).

### Delivery and platforms

| | RomPatcher.js | rom-weaver |
| --- | --- | --- |
| Browser | yes, plain JavaScript | yes, WebAssembly |
| Command line | Node script | native binary, 9 platforms |
| Install | copy files, or `npm install` | npm, Homebrew, Docker, or a release binary |
| Embed in your own page | yes, that is a stated goal | no |
| Threads | one web worker per job | multi-threaded, `-j` sets the ceiling |
| Language | JavaScript | Rust |
| Large files | warns above 64 MB | streams; disc images are the normal case |
| License | MIT | AGPL-3.0-or-later |

The 64 MB warning is advisory, not a block. It reflects that RomPatcher.js
loads whole files into JavaScript arrays.

### Which one should you use?

**Use RomPatcher.js when** you are publishing a hack and want a patch button
on your own site. It embeds in a page, it has no build step, and for IPS, BPS,
or UPS on a cartridge ROM it does the job in a few kilobytes of script. It is
also the tool most of your audience already recognizes.

**Use rom-weaver when** the job is bigger than one patch and one ROM: a disc
image inside a CHD, an `.xdelta` patch with secondary compression, a chain of
patches, an N64 ROM in the wrong byte order, a checksum you need to explain, or
a scripted batch you want to run the same way twice.

The two are not exclusive. Publishing a BPS patch with a RomPatcher.js button
on your page, and a rom-weaver bundle for people who want the checksums
recorded, covers both audiences.

## How this page was checked

Every claim in the RomPatcher.js comparison was read out of the source, not out
of a feature list. RomPatcher.js was checked at commit `aef583b` (version
3.0.0, July 2026): `RomPatcher.js` for the format registry and header logic,
`modules/` for the per-format parsers, and `index.js` for the Node command.
rom-weaver was checked at version 0.12.2 against
[Supported formats](../reference/formats.md) and
[CLI reference](../reference/cli.md).

Both projects move. If a row here is stale, the rom-weaver side is generated
from [Supported formats](../reference/formats.md), and the RomPatcher.js side
lives in its [repository](https://github.com/marcrobledo/RomPatcher.js).
