# CLI guide

The rom-weaver CLI exposes the same Rust command core used by the browser app.
Use it for repeatable patching, container work, checksums, trimming, and JSON
automation.

<!-- START doctoc -->
## Table of contents

- [Install](#install)
  - [Prebuilt install](#prebuilt-install)
    - [Homebrew (macOS arm64/Intel, Linux arm64/x86-64)](#homebrew-macos-arm64intel-linux-arm64x86-64)
    - [Scoop (Windows)](#scoop-windows)
    - [Install script (macOS, Linux)](#install-script-macos-linux)
    - [Install script (Windows)](#install-script-windows)
    - [npm](#npm)
    - [cargo-binstall](#cargo-binstall)
    - [mise](#mise)
  - [Source install](#source-install)
  - [Run in Docker](#run-in-docker)
  - [Development checkout](#development-checkout)
- [First weave](#first-weave)
- [Common workflows](#common-workflows)
- [Commands](#commands)
  - [Alternate names](#alternate-names)
- [Reaching inside archives](#reaching-inside-archives)
- [Patch apply behavior](#patch-apply-behavior)
- [Patch validation](#patch-validation)
- [Bundles](#bundles)
- [Supported formats](#supported-formats)
  - [Patch formats](#patch-formats)
  - [Container and compression formats](#container-and-compression-formats)
  - [Create-time codecs](#create-time-codecs)
- [Checksum support](#checksum-support)
- [Trim support](#trim-support)
- [Header detection and repair](#header-detection-and-repair)
- [JSON output](#json-output)
  - [Exit codes](#exit-codes)
- [File permissions](#file-permissions)
- [Shell completions](#shell-completions)
- [Man pages](#man-pages)

<!-- END doctoc -->

## Install

### Prebuilt install

Every method here installs a binary built for the release: macOS arm64 and
x86-64; Linux x86-64 GNU plus x86-64, arm64, and i686 musl; and Windows
arm64, x86-64, and x86.

#### Homebrew (macOS arm64/Intel, Linux arm64/x86-64)

```bash
brew install rom-weaver/tap/rom-weaver
```

#### Scoop (Windows)

```powershell
scoop bucket add rom-weaver https://github.com/rom-weaver/scoop-bucket
scoop install rom-weaver
```

#### Install script (macOS, Linux)

Downloads the latest release to `~/.local/bin` and checks it against the
published checksum. Set `ROM_WEAVER_INSTALL_DIR` to choose another directory, or
`ROM_WEAVER_VERSION` to install a specific release.

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh | sh
```

#### Install script (Windows)

The PowerShell equivalent, installing to `%LOCALAPPDATA%\rom-weaver\bin`. It
honors the same two environment variables.

```powershell
irm https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.ps1 | iex
```

#### npm

The only channel covering every supported target at once. Needs Node.js 22+.
The unscoped `rom-weaver` package points at the `@rom-weaver/cli` launcher,
whose binary arrives through a platform-specific optional dependency, so only
your platform's binary is downloaded.

```bash
npm install --global rom-weaver
```

Use the scoped launcher directly for a one-off run, or as a dev dependency for
a repository's scripts:

```bash
npx @rom-weaver/cli probe --input game.iso
npm install --save-dev @rom-weaver/cli
```

#### cargo-binstall

Fetches the released binary instead of compiling the workspace, which
`cargo install rom-weaver-cli` would otherwise do.

```bash
cargo binstall rom-weaver-cli
```

#### mise

Manages the CLI per project in `mise.toml` and verifies the release's GitHub
artifact attestations on install. The `minimum_release_age=0s` option lets
new releases resolve immediately on release day; omit it if you prefer mise's
default release-age delay.

```bash
mise use 'github:rom-weaver/rom-weaver[minimum_release_age=0s]'
```

### Source install

Install the current source build. This requires Rust 1.95, CMake, Clang, and a
native compiler toolchain.

```bash
git clone https://github.com/rom-weaver/rom-weaver.git
cd rom-weaver
cargo install --path crates/rom-weaver-cli --locked
rom-weaver --version
```

### Run in Docker

A Linux CLI image is published for each release. It carries its own runtime, so
nothing but Docker is required:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/work" \
  ghcr.io/brandonocasey/rom-weaver-cli:latest \
  probe --input /work/game.iso
```

The image's working directory is `/work`; mount the directory holding your ROMs
there and pass paths under `/work`. Arguments after the image name go straight to
`rom-weaver`, so `--help` and every subcommand work unchanged.

`--user "$(id -u):$(id -g)"` is what makes the output usable. Bind-mounted files
keep their host ownership, and without it the container runs as the base image's
`nonroot` user (uid 65532): reading your files may be refused, and anything it
does write ends up owned by a uid that does not exist on the host. rom-weaver
reads no home directory or user config, so an arbitrary uid needs no matching
account inside the image.

The image is distroless - it contains the `rom-weaver` binary and its C runtime
and nothing else, so there is no shell inside and `--entrypoint sh` will not get
you a prompt.

Mount read-only sources with `:ro` and give writes their own destination:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$HOME/roms:/work/in:ro" \
  --volume "$PWD/out:/work/out" \
  ghcr.io/brandonocasey/rom-weaver-cli:latest \
  weave --input /work/in/game.sfc --patch /work/in/hack.bps --output /work/out/patched.sfc
```

Tags follow the release: `latest`, the exact version (`X.Y.Z`), and the minor
series (`X.Y`). Stable releases also receive a major-series tag once the
project reaches 1.0. Prereleases publish under `beta` instead of `latest`. The
image is built for `linux/amd64` only, so it runs under emulation on arm64 hosts
(Apple Silicon included). Install a native build there for large jobs.

### Development checkout

For a development checkout, follow the [development guide](development.md)
and use `cargo run -p rom-weaver-cli --bin rom-weaver --` in place of
`rom-weaver`.

## First weave

Run a complete patch with the tiny made-up sample the webapp uses. The download
holds the ROM, the patch, and the checksum the result should have, so there is
nothing else to supply.

```bash
curl --fail --location --output first-weave.zip https://rom-weaver.com/first-weave.zip
rom-weaver weave --input first-weave.zip --output woven.bin --no-compress
rom-weaver checksum --input woven.bin --algo sha256
```

The final SHA-256 should be
`43b1cc171d0b795e224072752effd13400f6392d0fab8d0793373cce4b4f46fb`.

## Common workflows

Find out what a file is. Archives are opened for you unless you pass
`--no-extract`:

```bash
rom-weaver probe --input unknown-file.bin
rom-weaver probe --input archive.zip --select '*.sfc'
```

Apply one patch, or several in order:

```bash
rom-weaver weave \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --no-compress

rom-weaver weave \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups \
  --output patched.zip
```

`weave` is the short name for `patch apply`; either spelling works.

The result is compressed by default, into whatever the `--output` extension
names. Pass `--no-compress` for a plain ROM, or set `--compress-format`,
`--compress-codec`, and `--compress-level` yourself.

Build a patch from an original ROM and a changed one:

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --format bps \
  --output release.bps
```

SOLID patches carry their own metadata. `--solid-system`, `--solid-game`, and
`--solid-hack` fill in its three-string header. Adding any of
`--solid-version`, `--solid-author`, `--solid-contact`, or `--solid-comment`
switches to the seven-string extended header; `--solid-extended` selects that
header with the extra fields left empty. These flags need SOLID output and
cannot be combined with `--plan`.

```bash
rom-weaver patch create \
  --original original.sfc \
  --modified translated.sfc \
  --output translation.solid \
  --solid-system SNES \
  --solid-game "Example Game" \
  --solid-hack "English Translation" \
  --solid-version 1.0 \
  --solid-author "Example Team"
```

Unpack an archive, and hash a ROM:

```bash
rom-weaver extract --input collection.7z --output extracted
rom-weaver checksum --input game.gba --algo sha256
```

Shrink a disc image, or trim a ROM in place and put it back later:

```bash
rom-weaver compress --input disc.cue --output disc.chd
rom-weaver trim --input game.nds --in-place --revert-marker
rom-weaver trim --input game.nds --in-place --revert
```

Nearly every command takes `-i`/`--input` and `-o`/`--output`; `patch create`
is the exception, taking `--original` and `--modified` instead. The other short
flags are `-j` threads, `-f` format, `-s` select, `-a` algorithm, `-e`
extension, `-n` dry run, `-v` verbose, and `-q` quiet. Run
`rom-weaver <command> --help` for the full list.

`probe` and `checksum` accept `-` as the `--input` value to read from stdin, so
they fit into a pipeline:

```bash
curl -sL https://example.com/game.gba | rom-weaver checksum --input - --algo sha256
xz -dc game.iso.xz | rom-weaver probe --input - --json
```

## Commands

| Command | Purpose |
| --- | --- |
| `probe` | Identify a file: its format, its platform, and any header it carries. |
| `extract` | Unpack an archive or disc image. |
| `checksum` | Hash a file, a byte range, or a ROM inside an archive. |
| `ingest` | Sort a file into ROMs and patches, unpacking and hashing as needed. |
| `compress` | Pack files into an archive or a compressed disc image. |
| `trim` | Cut the padding off a ROM, or put it back. |
| `patch apply` | Apply one or more patches to a ROM, in order. |
| `patch create` | Build a patch from an original ROM and a changed one. |
| `patch validate` | Check that patches would apply cleanly, without writing anything. |
| `bundle create` | Write a `rom-weaver-bundle.json` recipe from local files. |
| `bundle parse` | Read a bundle recipe and report what it points at. |
| `bundle schema` | Print the `rom-weaver-bundle.json` JSON Schema to stdout. |
| `tools ppf-undo` | Undo a PPF3 patch, using the undo data stored inside it. |
| `completions` | Print a tab-completion script for your shell. |

`-h` prints a one-line summary of each option; `--help` prints the full
explanation, including the extra detail on flags like `--patch-header`.

### Alternate names

Some commands and flags answer to more than one name. They are the same code
either way, so pick whichever reads better:

| Canonical | Also accepted |
| --- | --- |
| `rom-weaver probe` | `rom-weaver inspect` |
| `rom-weaver patch apply` | `rom-weaver weave`, `rom-weaver patch weave` |
| `trim --revert` | `trim --untrim`, `trim --restore` |
| `trim --revert-marker` | `trim --reversible` |

This guide uses `weave` for patching, since it is the shortest way to spell the
command people reach for most.

Format names have alternates too, accepted anywhere `--format` is: `7zip` for
`7z`, `3ds` for `z3ds`, `xdelta3` for `xdelta`, `bsdiff` for `bdf`, and more.
The [format tables](#supported-formats) list every one.

Codecs are stricter. Each format accepts only the codec names in its own row of
the [codec table](#create-time-codecs), and the only two alternates are CHD's
`huffman` for `huff` and `avhu` for `avhuff`. Passing `--codec zlib` to a ZIP,
for instance, is an error rather than a synonym for `deflate`.

Every command accepts these global flags, listed under `Global options` in its
help:

- `--json` prints one JSON object per line instead of human-readable output.
- `--progress` and `--no-progress` override the automatic choice, which is to
  show progress on a terminal and hide it when output is piped.
- `--log-level off|error|warn|info|debug|trace` sets how much rom-weaver logs
  to stderr. Logging is off unless you ask for it, and it is separate from the
  normal output.
- `-v`, `-vv`, and `-vvv` are shorthand for info, debug, and trace.
- `-q`/`--quiet` logs errors only.
- `--dep-trace` adds trace output from the bundled libraries, useful in a bug
  report. On its own it also raises rom-weaver's own logs to warning level.
- `--color` and `--no-color` override colored output. The flag wins over the
  `NO_COLOR` environment variable, which wins over the terminal-vs-piped
  default. `--color` keeps color even when piped, though the live progress bar
  stays terminal-only.

Most commands also accept `-j`/`--threads auto|N`. `auto` uses every core; a
number caps it, and a format may still use fewer when its implementation has a
lower ceiling.

List-valued flags (`--algo`, `--checksum`, `--filter`, `--codec`, `--expect-in`,
`--expect-out`, `--assume-in`, and the compression codec flags) can be repeated
or comma-separated: `--algo crc32,sha1` and `--algo crc32 --algo sha1` do the
same thing.

rom-weaver only asks interactive questions when stdin and stderr are both
terminals and `--json` is off. Otherwise it decides on its own or fails.

## Reaching inside archives

`probe`, `extract`, `checksum`, `ingest`, `trim`, `bundle parse`, and the
patching commands all open archives for you, so you can point them at a `.zip`
and they will work on the ROM inside it. Four flags steer that, and they mean
the same thing everywhere they appear:

- `-s`/`--select` picks which file to use, by exact name, prefix, or glob.
- `--filter rom` considers only files that look like ROMs; `--filter patch`
  only patches. Both judge by extension, and the flag is repeatable and
  comma-separable (`--filter rom,patch`).
- `--no-ignore` also considers the files normally skipped: readmes, images,
  checksum sidecars, and OS clutter such as `.DS_Store`.
- `--no-extract` skips all of this and works on the file itself.

Not every command takes all four. `ingest` has `--select` and `--no-ignore`
only, since it always looks inside and always sorts by kind. `extract` has no
`--no-extract`, since unpacking is the whole job. `trim` spells its filter
`--no-filter`, because it filters to ROMs by default. `rom-weaver <command>
--help` is authoritative.

`extract` also unpacks archives found inside the input, up to eight levels
deep; `--no-nested-extract` stops after the first layer. If any output file
already exists, extraction stops before writing anything, unless `--force` is
given. While extracting it can hash what it writes (`--checksum ALGO`, or
`--checksum-rom ALGO` for the ROMs only) and report each file's format and
platform (`--probe`).

## Patch apply behavior

Repeat `--patch` to run several patches in order, each on the result of the
last. Leave `--patch` out entirely and rom-weaver looks for RetroArch-style
patches sitting next to the ROM inside the input archive. A
`rom-weaver-bundle.json` can supply the ROM, the patch order, the checks, and
the output name instead.

Checking the result:

- Formats that carry their own checksums are verified strictly.
  `--ignore-checksum-validation` applies the patch anyway, which can produce a
  broken ROM.
- `--expect-in ALGO=HEX` stops unless the ROM about to be patched matches.
- `--expect-out ALGO=HEX` fails unless the finished ROM matches.
- `--assume-in ALGO=HEX` takes a checksum on trust rather than reading the ROM
  to compute it. It is a speed option for scripts and verifies nothing.

Headers and byte order:

- `--patch-header auto|keep|strip` decides whether each patch applies to the
  ROM with or without its copier header. Auto works it out per patch from the
  patch's own source checksum.
- `--output-header auto|keep|strip` decides whether the finished ROM keeps its
  header. Auto keeps the ones emulators need and drops the ones they do not.
- `--repair-checksum` recomputes the ROM's internal header checksum afterwards,
  so the console does not reject it.
- `--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped` puts an
  N64 ROM in the interleaving a patch expects. Auto matches the patch's source
  CRC32, and the output is written back in the order the input arrived in.

Extras:

- `--code` bakes Game Genie or GameShark/Pro Action Replay codes into the ROM,
  as if they were a patch.
- `--emit-bundle PATH` also writes a `rom-weaver-bundle.json` recording the run:
  the ROM's checksums, the patches in order, and the result. It runs the same
  code as `bundle create`, so the file is byte-identical to the equivalent
  `bundle create` call. It carries no per-patch names or authors; for those use
  `bundle create`, `bundle create --from`, or `--tui`.
- `--tui` asks for each patch's name, version, author, and optional state plus
  an output name, then applies and writes the bundle. It needs a terminal, and
  for now it needs explicit `--patch` files; re-opening a bundle is not
  supported yet.

DCP patches need a Dreamcast `.cue` or `.gdi` input. They rebuild the GD-ROM
data track and reassemble the whole disc, so they cannot be chained with
another patch or combined with the header and checksum options.

## Patch validation

`patch validate` runs the same checks as `patch apply` but writes nothing: it
parses each patch and verifies every checksum the format carries.

`--expect-in` adds a check on the ROM itself, and accepts a checksum
(`ALGO=HEX`), an exact size (`size=N`), or a minimum size (`min-size=N`).
`--strip-header` and `--n64-byte-order` put the ROM in the form the patches
expect before checking; N64 byte order defaults to matching the patch's source
CRC32.

Patches are checked as a chain by default, each against the output of the one
before it. `--independent` checks each one against the original ROM instead and
reports a verdict per patch, rather than stopping at the first failure.

## Bundles

A `rom-weaver-bundle.json` bundle describes a distributable patching
workflow: ordered patches, expected input and output checksums, and output
naming. The machine-readable schema is
[`rom-weaver-bundle-v1.schema.json`](rom-weaver-bundle-v1.schema.json); its `$id`
resolves to the public GitHub copy at
`https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json`.
Print the current schema to stdout with `bundle schema`, then redirect it to a
file or point an editor at it:

```bash
rom-weaver bundle schema > rom-weaver-bundle-v1.schema.json
```

Create a bundle from local files; the checks are computed from the real
bytes:

```bash
rom-weaver bundle create \
  --input original.sfc \
  --patch translation.bps \
  --patch fixes.ips \
  --output rom-weaver-bundle.json
```

`-i`/`--input` names the ROM. Use `--rom-url` and `--rom-name` when the ROM
ships from somewhere else and the bundle should only point at it.

Every `--patch-*` flag describes the `--patch` before it: `--patch-id`,
`--patch-version`, `--patch-author`, `--patch-name`, `--patch-description`,
`--patch-optional`, `--patch-label`, `--patch-source-url`, `--patch-header`,
and `--patch-basis`. Give each patch an ID that stays the same across releases
and the webapp keeps its settings when you publish a replacement; bump
`--patch-version` at the same time.

Checksums use the same tokens as `patch apply`. `--expect-out ALGO=HEX` pins
the final result, `--patch-expect-in` and `--patch-expect-out` pin what a
single patch should see and produce, and `--assume-in` takes the ROM's
checksum on trust rather than reading the file.

`--bundle <archive>` also packs the recipe and its files into one shareable
archive. `--no-bundle-rom` leaves the ROM out and records only its checksums,
which is the usual shape for distributing a patch. `--schema-ref <URL>` records
a `$schema` URL for editors; it is left out unless you ask for it, so the
output stays byte-stable.

Rather than pass every flag, hand-author a `rom-weaver-bundle.json` spec with
local `path`s and optional or omitted checksums, add a `$schema` line so your
editor validates it, then let `bundle create --from` hash the referenced files
and bake the canonical checksummed bundle:

```json
{
  "$schema": "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json",
  "version": 1,
  "rom": { "path": "original.sfc" },
  "patches": [
    { "path": "translation.bps", "name": "English translation" },
    { "path": "fixes.ips", "optional": true }
  ],
  "output": { "name": "translated.sfc" }
}
```

```bash
rom-weaver bundle create --from spec.json --output rom-weaver-bundle.json
```

`--from -` reads the spec from stdin, in which case paths resolve against the
current directory; otherwise they resolve against the spec file. Any flag you
also pass overrides what the spec says, and a `$schema` already in the spec is
kept. `--from` only accepts entries with a local `path`; url-only and
checks-only entries are rejected with an explanation.

`bundle parse --input <bundle>` checks a bundle and reports what it points at.
Add `--output <dir>` to write out the files packed alongside it. For an archive
bundle it also takes `-s`/`--select`, `--filter rom|patch`, and `--no-extract`,
which behave as they do elsewhere. A plain JSON bundle references files by
relative path, so there is nothing for those options to unpack.

To actually run a bundle, use `rom-weaver weave --bundle <path-or-url>`, with
`--with` and `--without` to change which optional patches run.

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
trimmed copy elsewhere instead, and `-n`/`--dry-run` reports what would change
without writing anything.

`--revert` pads a trimmed file back out, and works for NDS, GBA, and 3DS. XISO
and RVZ scrub cannot be reverted. It also answers to `--untrim` and
`--restore`.

`--revert-marker` (also `--reversible`) embeds a small footer so a later revert
reproduces the original padding exactly rather than guessing at it; see the
[footer format](trim-revert-footer.md).

## Header detection and repair

Probe, checksum, and patch apply recognize headers for A78, LNX, NES/FDS,
SNES copier and SMC variants, PCE copier formats, Game Boy/GBA, Mega Drive,
SMS/Game Gear, all N64 byte orders, NDS, Neo Geo Pocket, and MSX.

## JSON output

Pass `--json` to emit one JSON object per line, including progress, status,
warnings, selected inputs, and emitted-file metadata where relevant. JSON mode
disables interactive selection, making it the stable interface for scripts:

```bash
rom-weaver --json probe --input game.sfc | jq
```

### Exit codes

`rom-weaver` returns `0` on success, `1` when an operation fails, `2` for an
unsupported operation or a command-line usage error, and `130` when a run is
cancelled.

## File permissions

Inputs are checked for readability before a command does any work. The commands
that write large outputs (`extract`, `compress`, `trim`, `patch apply`, and
`patch create`) have their destination checked for writability at the same
point, so a read-only output directory costs you a quick error rather than an
abandoned multi-gigabyte compress. Both checks do the real thing, an open, a
listing, or a create, so ACLs, group membership, and read-only mounts are
honored instead of guessed at from mode bits.

Denials name the path, the operation, and the identities involved:

```
error: i/o error: cannot open `/roms/game.iso`: Permission denied (os error 13)
(`/roms/game.iso` is mode 0600 owned by 0:0; this process runs as 1000:1000)
```

Read that as three facts: what was refused, who owns it, and who asked. Only a
genuinely missing path is reported as `input path does not exist`. A file that
exists but cannot be reached, including one behind a directory you cannot
traverse, is always reported as a denial rather than as a typo.

Common fixes:

- **Reading someone else's files.** `sudo chown` them, add yourself to the
  owning group, or copy them somewhere you own.
- **Writing to a read-only location.** Point `--output` at a directory you own.
  rom-weaver creates missing output directories but never changes permissions
  on an existing one.
- **Output files owned by the wrong user.** New files inherit your identity and
  umask; rom-weaver does not copy the source file's mode.
- **Inside a container.** The message adds a container hint, because the usual
  cause is a uid mismatch against a bind mount. Re-run with
  `--user "$(id -u):$(id -g)"` as shown in [Run in Docker](#run-in-docker).

Permission failures exit `1`. Under `--json` they arrive as a terminal event
with `"status": "failed"`, carrying `"stage": "validate"` when the preflight
caught them.

## Shell completions

Print a completion script and save it where your shell looks for one, then
start a new shell:

```bash
rom-weaver completions bash > /etc/bash_completion.d/rom-weaver
rom-weaver completions zsh  > ~/.zfunc/_rom-weaver
rom-weaver completions fish > ~/.config/fish/completions/rom-weaver.fish
```

`bash`, `zsh`, `fish`, `powershell`, and `elvish` are supported.

For format specifications and upstream implementations, see
[`references.md`](references.md).

## Man pages

The pages under `docs/man` come from the same Clap definitions as `--help`, so
they always match it. They are not checked in; run the generator to produce
them (the npm `prepack` step does this automatically before publishing):

```bash
mise run manpages
```

Use `man ./docs/man/rom-weaver.1` from a source checkout when they are not
installed system-wide. Do not edit the generated `.1` files manually.
