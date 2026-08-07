# Comparison with similar tools

rom-weaver overlaps with six established tools, each narrower than it is. This
page compares all of them, format by format and feature by feature, so you can
tell which one fits your job.

<!-- START doctoc -->
## Table of contents

- [Legend](#legend)
- [The tools](#the-tools)
- [At a glance](#at-a-glance)
- [Applying a patch](#applying-a-patch)
- [Creating a patch](#creating-a-patch)
- [Containers and disc images](#containers-and-disc-images)
- [Checksums](#checksums)
- [Headers and byte order](#headers-and-byte-order)
- [Patching features](#patching-features)
- [Beyond patching](#beyond-patching)
- [Delivery and platforms](#delivery-and-platforms)
- [Which one should you use?](#which-one-should-you-use)
- [How this page was checked](#how-this-page-was-checked)

<!-- END doctoc -->

## Legend

Every table on this page uses these three marks.

| Mark | Meaning |
| :---: | --- |
| 🟢 | Supported. |
| 🟡 | Partly supported. The limit is written next to the mark or under the table. |
| 🔴 | Not supported. |

## The tools

| Tool | What it does | Platforms | License |
| --- | --- | --- | --- |
| rom-weaver | ROM workflow: patch, extract, compress, hash, trim, bundle | Browser, Linux, macOS, Windows | AGPL-3.0-or-later |
| [RomPatcher.js](https://github.com/marcrobledo/RomPatcher.js) | Applies and creates ROM patches | Browser, Node | MIT |
| [Floating IPS (Flips)](https://github.com/Alcaro/Flips) | Applies and creates IPS and BPS patches | Linux, macOS, Windows | GPL-3.0 |
| [MultiPatch](https://github.com/sappharad/MultiPatch) | Applies and creates seven patch families | macOS | GPL-2.0 |
| [xdelta3](https://github.com/jmacd/xdelta) | General VCDIFF delta compressor | Linux, macOS, Windows | Apache-2.0 |
| [chdman](https://docs.mamedev.org/tools/chdman.html) | Converts disc images to and from CHD | Linux, macOS, Windows | GPL-2.0 |
| [Dolphin tool](https://github.com/dolphin-emu/dolphin) | Converts GameCube and Wii images | Linux, macOS, Windows | GPL-2.0 |

The last three are the reference implementations rom-weaver is tested against.
Its CHD and RVZ output is checked byte-for-byte against chdman and Dolphin
tool, and its patch output against Flips and MultiPatch, so choosing rom-weaver
for those jobs is a question of convenience, not of different bytes. The full
list of specifications consulted is in
[references](../development/references.md).

## At a glance

| Capability | rom-weaver | RomPatcher.js | Flips | MultiPatch | xdelta3 | chdman | Dolphin tool |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Patch families applied | 🟢 21 | 🟡 11 | 🔴 3 | 🟡 7 | 🔴 1 | 🔴 | 🔴 |
| Patch families created | 🟢 18 | 🟡 7 | 🔴 2 | 🟡 6 | 🔴 1 | 🔴 | 🔴 |
| Chain several patches | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| ROM header awareness | 🟢 13 families | 🟡 4 formats | 🟡 SNES only | 🔴 | 🔴 | 🔴 | 🔴 |
| Archive extract | 🟢 22 formats | 🟡 ZIP only | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Archive or image create | 🟢 5 formats | 🔴 | 🔴 | 🔴 | 🔴 | 🟡 CHD only | 🟡 4 formats |
| Standalone checksum tool | 🟢 8 algorithms | 🟡 3, display only | 🔴 | 🔴 | 🔴 | 🟡 CHD self-check | 🟡 image verify |
| Trim ROM padding | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Runs in a browser | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Command line | 🟢 | 🟡 Node script | 🟢 | 🟡 macOS only | 🟢 | 🟢 | 🟢 |

xdelta3 applies and creates exactly one family, VCDIFF, but it is a general
delta tool with no ROM knowledge at all. chdman and Dolphin tool do not patch.

## Applying a patch

rom-weaver reads 21 patch families. No other tool here reads more than 11.

| Format | rom-weaver | RomPatcher.js | Flips | MultiPatch | xdelta3 |
| --- | :---: | :---: | :---: | :---: | :---: |
| IPS | 🟢 | 🟢 | 🟢 | 🟢 | 🔴 |
| IPS32 | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| EBP | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| BPS | 🟢 | 🟢 | 🟢 | 🟢 | 🔴 |
| UPS | 🟢 | 🟢 | 🟢 | 🟢 | 🔴 |
| PPF | 🟢 | 🟢 | 🔴 | 🟢 | 🔴 |
| RUP | 🟢 | 🟢 | 🔴 | 🟢 | 🔴 |
| APS (N64) | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| APSGBA | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| BDF/BSDIFF40 | 🟢 | 🟢 | 🔴 | 🟢 | 🔴 |
| MOD (PMSR) | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| VCDIFF | 🟢 | 🟡 | 🔴 | 🟢 | 🟢 |
| xdelta | 🟢 | 🟡 | 🔴 | 🟢 | 🟢 |
| SOLID | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| GDIFF | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| PAT (FireFlower) | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| DLDI | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| DPS | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| BSP | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| HDiffPatch/HPatchZ | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| DCP (Dreamcast) | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |

🟡 for RomPatcher.js on VCDIFF and xdelta means it decodes plain VCDIFF but
throws on two optional parts of the spec: a secondary compressor and a custom
code table. Most `.xdelta` patches from xdelta3 use the `djw` secondary
compressor, so they fail. rom-weaver and MultiPatch decode both — MultiPatch
links the real xdelta3 library.

rom-weaver has gaps too. It detects NINJA1 headers but cannot apply them, it
does not support PDS, and it does not support HDiffPatch directory patches
(`HDIFF19`). None of the other tools support those either.

## Creating a patch

| Format | rom-weaver | RomPatcher.js | Flips | MultiPatch | xdelta3 |
| --- | :---: | :---: | :---: | :---: | :---: |
| IPS | 🟢 | 🟢 | 🟢 | 🟢 | 🔴 |
| IPS32 | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| EBP | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| BPS | 🟢 | 🟢 | 🟢 | 🟢 | 🔴 |
| UPS | 🟢 | 🟢 | 🔴 | 🟢 | 🔴 |
| PPF | 🟢 | 🟢 | 🔴 | 🟢 | 🔴 |
| RUP | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| APS (N64) | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| APSGBA | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| BDF/BSDIFF40 | 🟢 | 🔴 | 🔴 | 🟢 | 🔴 |
| MOD (PMSR) | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| VCDIFF | 🟢 | 🔴 | 🔴 | 🟢 | 🟢 |
| xdelta | 🟢 | 🔴 | 🔴 | 🟢 | 🟢 |
| SOLID, GDIFF, PAT, DLDI, DPS | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| BSP, HDiffPatch, DCP | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |

Flips ships a UPS encoder in its library but exposes no way to reach it, so UPS
is apply-only in practice. Flips is the only tool here offering two BPS
strategies on the command line: `--bps-delta` and `--bps-linear`.

## Containers and disc images

| Format | rom-weaver extract | rom-weaver create | RomPatcher.js | chdman | Dolphin tool |
| --- | :---: | :---: | :---: | :---: | :---: |
| ZIP | 🟢 | 🟢 | 🟡 extract only | 🔴 | 🔴 |
| ZIPX | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| 7z | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| RAR | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| TAR (plain, gz, bz2, xz) | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| Gzip, Bzip2, XZ, Zstandard | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| CHD | 🟢 | 🟢 | 🔴 | 🟢 | 🔴 |
| RVZ | 🟢 | 🟢 | 🔴 | 🔴 | 🟢 |
| Z3DS | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |
| GCZ | 🟢 | 🔴 | 🔴 | 🔴 | 🟢 |
| WIA | 🟢 | 🔴 | 🔴 | 🔴 | 🟢 |
| TGC | 🟢 | 🔴 | 🔴 | 🔴 | 🟡 read only |
| NFS | 🟢 | 🔴 | 🔴 | 🔴 | 🟡 read only |
| WBFS | 🟢 | 🔴 | 🔴 | 🔴 | 🟡 read only |
| CSO/CISO | 🟢 | 🔴 | 🔴 | 🔴 | 🟡 read only |
| PBP | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| XISO | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |

Two honest gaps for rom-weaver: Dolphin tool writes GCZ and WIA, and rom-weaver
only reads them. chdman also reads `.cue`, `.gdi`, `.toc`, and raw images as
CHD build inputs, which is a different job from extracting an existing archive.

The practical difference: rom-weaver can take a `.chd` or `.rvz` disc image,
patch the ROM inside, and pack the result back up in one command. Every other
tool here needs you to convert, patch, and convert back by hand.

## Checksums

| Capability | rom-weaver | RomPatcher.js | Flips | MultiPatch | chdman | Dolphin tool |
| --- | --- | --- | :---: | :---: | :---: | :---: |
| Algorithms | 🟢 CRC32, CRC32C, CRC16, MD5, SHA-1, SHA-256, BLAKE3, Adler-32 | 🟡 CRC32, MD5, SHA-1 | 🔴 | 🔴 | 🟡 SHA-1 | 🟡 CRC32, MD5, SHA-1 |
| Shows ROM hashes | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| Verifies checksums in the patch | 🟢 | 🟢 | 🟢 | 🟢 | 🔴 | 🔴 |
| Assert an expected input hash | 🟢 `--expect-in` | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Assert an expected output hash | 🟢 `--expect-out` | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Hash a byte range | 🟢 `--start`/`--length` | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Hash a file inside an archive | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Header and byte-order variants | 🟢 all detected headers, plus trim boundaries | 🟡 N64 only | 🔴 | 🔴 | 🔴 | 🔴 |

chdman `verify` and Dolphin tool `verify` check an image against its own stored
hashes. Neither hashes an arbitrary file.

The last row matters when a patch's readme lists a CRC32 you cannot reproduce.
rom-weaver reports the hash of the raw file, the headerless file, the
repaired-header file, and each N64 byte order at once, so you can see which one
the author meant. See
[Fix a checksum error](../how-to/fix-checksum-errors.md).

## Headers and byte order

| Behavior | rom-weaver | RomPatcher.js | Flips | MultiPatch |
| --- | --- | --- | --- | :---: |
| Header detection | 🟢 13 families | 🟡 4 formats | 🟡 SNES copier only | 🔴 |
| Checksum repair | 🟢 13 platforms | 🟡 Game Boy, Mega Drive | 🔴 | 🔴 |
| Header strip mode | 🟢 `auto`, `keep`, or `strip`, per patch | 🟡 manual on/off | 🟡 auto-detect, `--exact` to force | 🔴 |
| Output header mode | 🟢 separate `auto`, `keep`, or `strip` | 🟡 follows the input choice | 🟡 restores what it stripped | 🔴 |
| N64 byte order | 🟢 converts to match the patch, writes back in the original order | 🟡 detects `.z64` for its CRC display | 🔴 | 🔴 |

rom-weaver detects headers for A78, LNX, NES and FDS, SNES copier and SMC
variants, PCE copier formats, Game Boy and GBA, Mega Drive, SMS and Game Gear,
all N64 byte orders, NDS, Neo Geo Pocket, and MSX. RomPatcher.js covers iNES
(`.nes`), fwNES (`.fds`), LNX (`.lnx`), and SNES copier (`.sfc`, `.smc`,
`.swc`, `.fig`). Flips handles the 512-byte SNES copier header and nothing
else.

## Patching features

| Feature | rom-weaver | RomPatcher.js | Flips | MultiPatch | xdelta3 |
| --- | --- | :---: | :---: | :---: | :---: |
| Apply one patch | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 |
| Chain several patches in order | 🟢 repeat `--patch` | 🔴 | 🔴 | 🔴 | 🔴 |
| Validate without writing | 🟢 `patch validate` | 🔴 | 🟡 `--info` | 🔴 | 🟡 `printhdr` |
| Check each patch independently | 🟢 `--independent` | 🔴 | 🔴 | 🔴 | 🔴 |
| Find patches beside the ROM in an archive | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| Bake in Game Genie / GameShark codes | 🟢 `--code` | 🔴 | 🔴 | 🔴 | 🔴 |
| Undo a PPF3 patch | 🟢 `tools ppf-undo` | 🔴 | 🔴 | 🔴 | 🔴 |
| Override a failed checksum | 🟢 `--ignore-checksum-validation` | 🟢 | 🟢 `--ignore-checksum` | 🔴 | 🔴 |
| Patch metadata on create | 🟢 RUP description, EBP JSON | 🟢 RUP description, EBP JSON | 🟢 BPS manifest | 🔴 | 🟢 `-A` app header |
| Machine-readable output | 🟢 `--json` | 🔴 | 🔴 | 🔴 | 🔴 |

Every tool here except rom-weaver applies exactly one patch per run. Hacks that
ship a base patch plus an update need two passes, and you have to keep the
intermediate file.

## Beyond patching

| Command | rom-weaver | Anything else here |
| --- | --- | --- |
| Trim and restore | 🟢 NDS, GBA, 3DS, XISO, and RVZ scrub | 🔴 |
| Compress | 🟢 ZIP, 7z, CHD, RVZ, Z3DS | 🟡 chdman for CHD, Dolphin tool for RVZ/GCZ/WIA/ISO |
| Probe | 🟢 format, platform, and header, including from stdin | 🟡 chdman `info`, Dolphin tool `header` |
| Ingest | 🟢 sorts a mixed folder into ROMs and patches | 🔴 |
| Bundles | 🟢 `rom-weaver-bundle.json` recipes | 🔴 |

`trim --revert` pads a trimmed file back out, and `--revert-marker` stores a
footer so the revert is exact. A bundle records the ROM's checksums, the patch
order, and the expected result, so someone else can reproduce your build; see
[What a bundle is](bundles.md).

## Delivery and platforms

| Property | rom-weaver | RomPatcher.js | Flips | MultiPatch | xdelta3 | chdman | Dolphin tool |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browser | 🟢 WebAssembly | 🟢 plain JavaScript | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Command line | 🟢 native, 9 platforms | 🟡 Node script | 🟢 | 🟡 macOS only | 🟢 | 🟢 | 🟢 |
| Desktop GUI | 🔴 | 🔴 | 🟢 GTK, Win32 | 🟢 Cocoa | 🔴 | 🔴 | 🔴 |
| Embed in your own page | 🔴 | 🟢 a stated goal | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Multi-threaded | 🟢 `-j` sets the ceiling | 🟡 one worker per job | 🔴 | 🔴 | 🔴 | 🟢 | 🟢 |
| Large files | 🟢 streams; disc images are normal | 🟡 warns above 64 MB | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 |
| Install | 🟢 npm, Homebrew, Docker, or a binary | 🟡 copy files, or `npm install` | 🟡 binary or build | 🟡 app download | 🟡 package or build | 🟡 part of MAME tools | 🟡 part of Dolphin |
| Language | Rust | JavaScript | C++ | Objective-C, C++ | C | C++ | C++ |

The 64 MB warning in RomPatcher.js is advisory, not a block. It reflects that
it loads whole files into JavaScript arrays.

## Which one should you use?

**RomPatcher.js** when you are publishing a hack and want a patch button on
your own site. It embeds in a page, has no build step, and handles IPS, BPS, or
UPS on a cartridge ROM in a few kilobytes of script.

**Flips** when you only touch IPS and BPS and want the reference BPS encoder
with both delta and linear strategies, plus a desktop GUI.

**MultiPatch** when you are on macOS and want a native app covering seven
families, including real xdelta3.

**xdelta3** when the files are not ROMs. It is a general delta compressor and
knows nothing about headers, byte order, or consoles.

**chdman** or **Dolphin tool** when you want the reference converter itself, or
need an output rom-weaver does not write — Dolphin tool writes GCZ and WIA.

**rom-weaver** when the job is bigger than one patch and one ROM: a disc image
inside a CHD, an `.xdelta` patch with secondary compression, a chain of
patches, an N64 ROM in the wrong byte order, a checksum you need to explain, or
a scripted batch you want to run the same way twice.

These are not exclusive. Publishing a BPS patch with a RomPatcher.js button on
your page, and a rom-weaver bundle for people who want the checksums recorded,
covers both audiences.

## How this page was checked

Every claim was read out of each tool's source or official documentation, not
out of a feature list.

| Tool | Checked at | What was read |
| --- | --- | --- |
| rom-weaver | 0.12.2 | [Supported formats](../reference/formats.md), [CLI reference](../reference/cli.md) |
| RomPatcher.js | commit `aef583b`, v3.0.0 | `RomPatcher.js` format registry and header logic, `modules/` parsers, `index.js` CLI |
| Flips | `master` | `flips.cpp` patch identification and create paths, `libips`/`libbps`/`libups`, CLI options |
| MultiPatch | `master` | `MPPatchWindow.mm` apply dispatch, `MPCreationWindow.mm` create list, `adapters/`, `XDeltaAdapter.m` |
| xdelta3 | `master` | Command line syntax documentation |
| chdman | current MAME docs | The [chdman command list](https://docs.mamedev.org/tools/chdman.html) |
| Dolphin tool | `master` | `ToolMain.cpp` subcommands, `ConvertCommand.cpp` output formats, `Blob.cpp` readable formats |

All projects move. If a row here is stale, the rom-weaver side is generated
from [Supported formats](../reference/formats.md), and each other tool's side
lives in the repository linked from [the tools](#the-tools).
