# CLI guide

The rom-weaver CLI exposes the same Rust command core used by the browser app.
Use it for repeatable patching, container work, checksums, trimming, and JSON
automation.

## Install

### npm

The npm launcher requires Node.js 22 or newer and installs the native package
for the current platform:

```bash
npm install --global rom-weaver
rom-weaver --version
```

For one-off use without installing, run `npx --yes rom-weaver --help`.

Native npm packages target macOS arm64/x64, Linux x64 glibc, and Windows x64.
On Unix, the npm package also installs the generated `rom-weaver(1)` command
manuals when npm's global man directory is on `MANPATH`.

### Cargo

Cargo builds from source, so it covers Rust targets beyond the prebuilt npm
platforms. Both paths require Rust 1.95, CMake, Clang, and a native build
toolchain.

```bash
# Published crate
cargo install rom-weaver-cli

# Tagged source release
cargo install \
  --git https://github.com/brandonocasey/rom-weaver.git \
  --tag v0.5.0 \
  rom-weaver-cli
```

### Docker

The published CLI image needs only Docker. Mount a working directory to
process local files:

```bash
docker run --rm --volume "$PWD:/data" \
  ghcr.io/brandonocasey/rom-weaver-cli:latest \
  probe /data/game.sfc
```

### Development checkout

For a development checkout, follow the [development guide](development.md)
and use `cargo run -p rom-weaver-cli --` in place of `rom-weaver`.

## Common workflows

Inspect an unknown file. Container payloads are resolved automatically unless
`--no-extract` is supplied:

```bash
rom-weaver probe unknown-file.bin
rom-weaver probe archive.zip --select '*.sfc'
```

Apply one patch or an ordered patch chain:

```bash
rom-weaver patch apply \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --no-compress

rom-weaver patch apply \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups \
  --output patched.zip
```

Patch output compression is enabled by default. Use `--no-compress` for a raw
ROM, or choose `--compress-format`, `--compress-codec`, and
`--compress-level` explicitly.

Create a patch from an original and modified file:

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --format bps \
  --output release.bps
```

Extract a container and checksum a ROM:

```bash
rom-weaver extract collection.7z --out-dir extracted
rom-weaver checksum game.gba --algo sha256
```

Compress files or trim a supported ROM in place:

```bash
rom-weaver compress track.cue track.bin --output disc.chd --format chd
rom-weaver trim game.nds --in-place --revert-marker
rom-weaver trim game.nds --in-place --revert
```

Run `rom-weaver <command> --help` for every option and caveat on a command.

## Commands

| Command | Purpose |
| --- | --- |
| `probe` | Identify containers, patches, and known ROM headers. |
| `extract` | Extract containers, including nested containers. |
| `checksum` | Hash files, ranges, or auto-resolved container payloads. |
| `ingest` | Classify dropped sources and describe ROMs and patches. |
| `compress` | Create a supported output container. |
| `trim` | Trim or restore supported ROM and disc-image families. |
| `patch apply` | Apply one or more patches in order. |
| `patch create` | Create a patch from original and modified data. |
| `patch validate` | Validate a patch and its embedded metadata. |
| `bundle create` | Build a `rom-weaver-bundle.json` workflow from local files. |
| `bundle parse` | Validate and resolve a bundle and its referenced entries. |
| `tools ppf-undo` | Restore a ROM using undo data embedded in a PPF3 patch. |

Global flags:

- `--json` emits structured progress and terminal status as JSON lines.
- `--progress` and `--no-progress` override automatic progress display.
- `--trace` enables trace logs.
- `--dep-trace` enables trace logs from dependencies such as `nod` while keeping application logs at warning level unless `--trace` is also set.

Most data-processing commands also accept `--threads auto|N`. `auto` uses the
available platform parallelism; a positive integer supplies an upper thread
budget, which each format may reduce when its implementation has a lower cap.

Interactive selection is available only in non-JSON sessions where stdin and
stderr are terminals.

## Input selection

`probe`, `extract`, `checksum`, and patching commands can look through archive
containers automatically.

- `--select` chooses payloads by exact name, prefix, or glob.
- `--rom-filter` keeps ROM-like candidates.
- `--patch-filter` keeps patch-like candidates.
- `--no-ignore` includes common sidecar files normally ignored by selection.
- `--no-extract` operates on the source bytes directly.

`extract` recursively handles nested containers up to depth 8 by default. Use
`--no-nested-extract` to stop after the first layer. While extracting, it can
also hash outputs (`--checksum ALGO`, or `--checksum-rom ALGO` to hash only
ROM-like outputs), refuse to overwrite existing files (`--no-overwrite`), and
fold container/platform probe metadata into the result (`--probe`).

## Patch apply behavior

- Repeat `--patch` to apply patches sequentially.
- Patch checksum validation is strict by default for formats that embed
  checksums. `--ignore-checksum-validation` bypasses recoverable validation
  failures.
- `--validate-with-checksum ALGO=HEX` validates the effective input before
  patching.
- `--validate-output-checksum ALGO=HEX` validates the final output.
- `--checksum-cache ALGO=HEX` supplies a trusted input checksum without
  recomputing it.
- `--patch-header auto|keep|strip` controls copier-header handling per patch.
- `--output-header auto|keep|strip` controls the final ROM header.
- `--repair-checksum` repairs supported ROM headers and checksums after apply.
- `--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped` controls
  N64 input order per patch. Auto is the default and matches checksum variants;
  the original input order is restored on output.
- `--code` can bake supported Game Genie or Pro Action Replay/GameShark codes
  into a ROM as a synthetic patch.

If `--patch` is omitted, patch apply can discover RetroArch-style sidecar
patches inside the input archive. A `rom-weaver-bundle.json` file can provide
the input, ordered patches, validation rules, and output name.

DCP patches require a Dreamcast `.cue` or `.gdi` input. They rebuild the
GD-ROM data track and cannot be chained with another patch or combined with
header/checksum transforms.

## Patch validation

`patch validate` runs the same checks as `patch apply` without writing
output: format parsing, embedded patch checksums, and optional input
preflight (`--validate-with-checksum`, `--validate-with-size`,
`--validate-with-min-size`). `--strip-header` and `--n64-byte-order` apply
the matching input transform before validation; N64 byte order defaults to
checksum-driven auto detection. Patches validate as a
sequential chain by default; `--independent` validates each `--patch`
directly against the input instead, reporting a per-patch verdict without
aborting the batch on a single failure.

## Bundles

A `rom-weaver-bundle.json` bundle describes a distributable patching
workflow: ordered patches, expected input and output checksums, and output
naming. The machine-readable schema is
[`rom-weaver-bundle.schema.json`](rom-weaver-bundle.schema.json).

Create a bundle from local files; the checks are computed from the real
bytes:

```bash
rom-weaver bundle create \
  --rom original.sfc \
  --patch translation.bps \
  --patch fixes.ips \
  --output rom-weaver-bundle.json
```

Per-patch metadata flags (`--patch-name`, `--patch-description`,
`--patch-optional`, `--patch-label`, `--patch-header`, and the chain-state
checks) bind to the preceding `--patch`. `--bundle <archive>` packages the
bundle together with its sources into one shareable archive;
`--no-bundle-rom` keeps the ROM out and records its checks only, which is
the usual shape for distributing patches.

`bundle parse <bundle>` validates a bundle and resolves its referenced
entries (`--extract-dir` extracts archive members). To apply one, run
`rom-weaver patch apply --bundle <path-or-url>`; `--with` and `--without`
override which optional patches run.

## Supported formats

### Patch formats

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

### Container and compression formats

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

### Create-time codecs

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
trimmed copy elsewhere instead, and `--simulate` reports what would change
without writing anything.

`--revert` supports NDS, GBA, and 3DS. It does not support XISO or RVZ scrub
paths. `--revert-marker` embeds a small footer so a later revert can reproduce
the exact original padding; see the [footer format](trim-revert-footer.md).

## Header detection and repair

Probe, checksum, and patch apply recognize headers for A78, LNX, NES/FDS,
SNES copier and SMC variants, PCE copier formats, Game Boy/GBA, Mega Drive,
SMS/Game Gear, all N64 byte orders, NDS, Neo Geo Pocket, and MSX.

## JSON output

Pass `--json` to emit one JSON object per line, including progress, status,
warnings, selected inputs, and emitted-file metadata where relevant. JSON mode
disables interactive selection, making it the stable interface for scripts:

```bash
rom-weaver --json probe game.sfc | jq
```

For format specifications and upstream implementations, see
[`references.md`](references.md).

## Man pages

The checked-in pages under [`docs/man`](man/) are generated directly from the
same Clap command definitions as `--help`:

```bash
mise run manpages
mise run manpages-check
```

Use `man ./docs/man/rom-weaver.1` from a source checkout when they are not
installed system-wide. Do not edit the generated `.1` files manually.
