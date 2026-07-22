# CLI guide

The rom-weaver CLI exposes the same Rust command core used by the browser app.
Use it for repeatable patching, container work, checksums, trimming, and JSON
automation.

<!-- START doctoc -->
## Table of contents

- [Install](#install)
  - [Prebuilt install](#prebuilt-install)
    - [Homebrew (macOS arm64, macOS Intel, Linux x86-64)](#homebrew-macos-arm64-macos-intel-linux-x86-64)
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
- [Input selection](#input-selection)
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

Every method here installs the same binary built for the release: macOS arm64
and x86-64, Linux x86-64, and Windows x86-64. Anything else needs the
[source install](#source-install).

#### Homebrew (macOS arm64, macOS Intel, Linux x86-64)

```bash
brew install brandonocasey/tap/rom-weaver
```

#### Scoop (Windows)

```powershell
scoop bucket add brandonocasey https://github.com/brandonocasey/scoop-bucket
scoop install rom-weaver
```

#### Install script (macOS, Linux)

Downloads the latest release to `~/.local/bin` and checks it against the
published checksum. Set `ROM_WEAVER_INSTALL_DIR` to choose another directory, or
`ROM_WEAVER_VERSION` to install a specific release.

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/brandonocasey/rom-weaver/main/install.sh | sh
```

#### Install script (Windows)

The PowerShell equivalent, installing to `%LOCALAPPDATA%\rom-weaver\bin`. It
honors the same two environment variables.

```powershell
irm https://raw.githubusercontent.com/brandonocasey/rom-weaver/main/install.ps1 | iex
```

#### npm

The only channel covering every supported target at once. Needs Node.js 22+.
The unscoped `rom-weaver` package points at the `@rom-weaver/cli` launcher,
whose binary arrives through a platform-specific optional dependency, so only
your platform's binary is downloaded.

```bash
npm install --global rom-weaver
```

Use the scoped launcher directly for a one-off run, or as a dev dependency to
pin the version a repository's scripts expect:

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

Pins the CLI per project in `mise.toml` and verifies the release's GitHub
artifact attestations on install. Pass an explicit version - mise cannot resolve
`@latest` for this repository.

```bash
mise use github:brandonocasey/rom-weaver@0.6.7
```

### Source install

Install the current source build. This requires Rust 1.95, CMake, Clang, and a
native compiler toolchain.

```bash
git clone https://github.com/brandonocasey/rom-weaver.git
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
keep their host ownership, and without it the container runs as its own
`rom-weaver` user (uid 10001): reading your files may be refused, and anything it
does write ends up owned by a uid that does not exist on the host. rom-weaver
reads no home directory or user config, so an arbitrary uid needs no matching
account inside the image.

Mount read-only sources with `:ro` and give writes their own destination:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$HOME/roms:/work/in:ro" \
  --volume "$PWD/out:/work/out" \
  ghcr.io/brandonocasey/rom-weaver-cli:latest \
  weave --input /work/in/game.sfc --patch /work/in/hack.bps --output /work/out/patched.sfc
```

Tags follow the release: `latest`, the exact version (`0.5.0`), and the minor
series (`0.5`). Prereleases publish under `beta` instead of `latest`. The image
is built for `linux/amd64` only, so it runs under emulation on arm64 hosts
(Apple Silicon included) — install a native build there for large jobs.

### Development checkout

For a development checkout, follow the [development guide](development.md)
and use `cargo run -p rom-weaver-cli --` in place of `rom-weaver`.

## First weave

Run a complete patch with the tiny synthetic sample used by the webapp. The
bundle contains its ROM, patch, and expected output checksum.

```bash
curl --fail --location --output first-weave.zip https://rom-weaver.com/first-weave.zip
rom-weaver patch apply --input first-weave.zip --output woven.bin --no-compress
rom-weaver checksum --input woven.bin --algo sha256
```

The final SHA-256 should be
`43b1cc171d0b795e224072752effd13400f6392d0fab8d0793373cce4b4f46fb`.

## Common workflows

Inspect an unknown file. Container payloads are resolved automatically unless
`--no-extract` is supplied:

```bash
rom-weaver probe --input unknown-file.bin
rom-weaver probe --input archive.zip --select '*.sfc'
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

For SOLID patches, `--solid-system`, `--solid-game`, and `--solid-hack`
override the default three-string header metadata. Supplying
`--solid-version`, `--solid-author`, `--solid-contact`, or `--solid-comment`
selects the seven-string extended header automatically; use
`--solid-extended` when the extended fields should intentionally remain empty.
These options require SOLID output and cannot be combined with `--plan`.

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

Extract a container and checksum a ROM:

```bash
rom-weaver extract --input collection.7z --output extracted
rom-weaver checksum --input game.gba --algo sha256
```

Compress files or trim a supported ROM in place:

```bash
rom-weaver compress --input track.cue --input track.bin --output disc.chd --format chd
rom-weaver trim --input game.nds --in-place --revert-marker
rom-weaver trim --input game.nds --in-place --revert
```

Most commands use `-i`/`--input` and `-o`/`--output`. Some commands need more
specific inputs, such as `patch create --original ... --modified ...`. Common
short flags include `-j` for threads, `-f` for format, `-s` for selection,
`-a` for a checksum algorithm, and `-n` for a dry run. Run
`rom-weaver <command> --help` for the exact options.

`probe` and `checksum` also accept `-` as the `--input` value to read the ROM
from stdin, so they slot into Unix pipelines:

```bash
curl -sL https://example.com/game.gba | rom-weaver checksum --input - --algo sha256
xz -dc game.iso.xz | rom-weaver probe --input - --json
```

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
| `bundle schema` | Print the `rom-weaver-bundle.json` JSON Schema to stdout. |
| `tools ppf-undo` | Restore a ROM using undo data embedded in a PPF3 patch. |
| `weave` | Run `patch apply` through its shorter alias. |
| `completions` | Generate a shell completion script. |

Global flags:

- `--json` emits structured progress and terminal status as JSON lines.
- `--progress` and `--no-progress` override automatic progress display.
- `--log-level off|error|warn|info|debug|trace` sets the application log level.
- `-v`, `-vv`, and `-vvv` (or `--verbose`) select info, debug, and trace logging.
- `-q` or `--quiet` selects error-only application logging.
- `--dep-trace` enables trace logs from dependencies such as `nod` while keeping application logs at warning level unless another log level is selected.
- `--color` and `--no-color` override colored output. Precedence is flag, then the `NO_COLOR` environment variable, then a terminal-vs-piped default; `--color` forces color even when piped (the live progress bar stays terminal-only).

Most data-processing commands also accept `-j`/`--threads auto|N`. `auto` uses the
available platform parallelism; a positive integer supplies an upper thread
budget, which each format may reduce when its implementation has a lower cap.

List-valued flags (`--algo`, `--checksum`, `--filter`, `--codec`, `--expect-in`,
`--expect-out`, `--assume-in`, and the compression codec flags) are repeatable
and comma-separable: `--algo crc32,sha1` and `--algo crc32 --algo sha1` are
equivalent.

Interactive selection is available only in non-JSON sessions where stdin and
stderr are terminals.

## Input selection

`probe`, `extract`, `checksum`, and patching commands can look through archive
containers automatically.

- `-s`/`--select` chooses payloads by exact name, prefix, or glob.
- `--filter rom` keeps ROM-like candidates; `--filter patch` keeps patch-like
  candidates. The flag is repeatable and comma-separable (`--filter rom,patch`).
- `--no-ignore` includes common sidecar files normally ignored by selection.
- `--no-extract` operates on the source bytes directly.

`extract` recursively handles nested containers up to depth 8 by default. Use
`--no-nested-extract` to stop after the first layer. It refuses to overwrite an
existing destination by default and fails if one is present; pass `--force` to
overwrite. While extracting, it can also hash outputs (`--checksum ALGO`, or
`--checksum-rom ALGO` to hash only ROM-like outputs) and fold
container/platform probe metadata into the result (`--probe`).

## Patch apply behavior

- Repeat `--patch` to apply patches sequentially.
- Patch checksum validation is strict by default for formats that embed
  checksums. `--ignore-checksum-validation` bypasses recoverable validation
  failures.
- `--expect-in ALGO=HEX` validates the effective input before patching.
- `--expect-out ALGO=HEX` validates the final output.
- `--assume-in ALGO=HEX` supplies a trusted input checksum without recomputing
  it.
- `--patch-header auto|keep|strip` controls copier-header handling per patch.
- `--output-header auto|keep|strip` controls the final ROM header.
- `--repair-checksum` repairs supported ROM headers and checksums after apply.
- `--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped` controls
  N64 input order per patch. Auto is the default and matches checksum variants;
  the original input order is restored on output.
- `--code` can bake supported Game Genie or Pro Action Replay/GameShark codes
  into a ROM as a synthetic patch.
- `--emit-bundle PATH` also writes a `rom-weaver-bundle.json` after a
  successful apply, describing the input ROM's computed checks, the ordered
  patches, and the produced output. It reuses the `bundle create` pipeline, so
  the file is byte-identical to the equivalent `bundle create`. The result is
  metadata-light; rich per-patch metadata comes from `bundle create`,
  `bundle create --from`, or `--tui`.
- `--tui` opens an interactive wizard, seeded from the `--patch` arguments,
  that prompts for each patch's name, version, author, and optional state plus
  an output name, then applies and writes a `rom-weaver-bundle.json`. It needs
  an interactive terminal and currently requires explicit `--patch` files
  (re-opening a bundle input is not supported yet).

If `--patch` is omitted, patch apply can discover RetroArch-style sidecar
patches inside the input archive. A `rom-weaver-bundle.json` file can provide
the input, ordered patches, validation rules, and output name.

DCP patches require a Dreamcast `.cue` or `.gdi` input. They rebuild the
GD-ROM data track and cannot be chained with another patch or combined with
header/checksum transforms.

## Patch validation

`patch validate` runs the same checks as `patch apply` without writing
output: format parsing, embedded patch checksums, and optional input
preflight via `--expect-in`, whose tokens accept a checksum (`ALGO=HEX`), an
exact size (`size=N`), or a minimum size (`min-size=N`). `--strip-header` and
`--n64-byte-order` apply
the matching input transform before validation; N64 byte order defaults to
checksum-driven auto detection. Patches validate as a
sequential chain by default; `--independent` validates each `--patch`
directly against the input instead, reporting a per-patch verdict without
aborting the batch on a single failure.

## Bundles

A `rom-weaver-bundle.json` bundle describes a distributable patching
workflow: ordered patches, expected input and output checksums, and output
naming. The machine-readable schema is
[`rom-weaver-bundle-v1.schema.json`](rom-weaver-bundle-v1.schema.json); its `$id`
resolves to the public GitHub copy at
`https://raw.githubusercontent.com/brandonocasey/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json`.
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

`-i`/`--input` supplies the ROM (`--rom-url`/`--rom-name` describe a bundle
ROM that ships elsewhere). Per-patch metadata flags (`--patch-id`,
`--patch-version`, `--patch-author`, `--patch-name`, `--patch-description`,
`--patch-optional`, `--patch-label`, `--patch-source-url`, `--patch-header`,
and `--patch-basis`) bind to the preceding `--patch`. Stable patch IDs let
authors replace a patch in the webapp without losing its metadata; bump the
patch version when publishing the replacement. Checksum expectations use the
same expect-token vocabulary as `patch apply`: `--expect-out ALGO=HEX` pins the
final output, `--patch-expect-in`/`--patch-expect-out ALGO=HEX` pin a patch's
chain-state checks (bound to the preceding `--patch`), and `--assume-in`
supplies a trusted input checksum without recomputing it. `--bundle <archive>`
packages the bundle together with its sources into one shareable archive;
`--no-bundle-rom` keeps the ROM out and records its checks only, which is the
usual shape for distributing patches. `--schema-ref <URL>` stamps a `$schema`
URL into the emitted bundle for editor validation; it is not stamped by
default, which keeps the output byte-stable.

Rather than pass every flag, hand-author a `rom-weaver-bundle.json` spec with
local `path`s and optional or omitted checksums, add a `$schema` line so your
editor validates it, then let `bundle create --from` hash the referenced files
and bake the canonical checksummed bundle:

```json
{
  "$schema": "https://raw.githubusercontent.com/brandonocasey/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json",
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

`--from -` reads the spec from stdin (paths resolve relative to the current
directory for stdin, or relative to the spec file otherwise). Explicit CLI
flags override spec values, and a `$schema` already present in the spec is
preserved automatically. Only local `path` entries are supported for `--from`;
url-only or checks-only entries error with guidance.

`bundle parse --input <bundle>` validates a bundle and resolves its referenced
entries (`--output <dir>` extracts archive members). For archive-packaged
bundles it also accepts the shared extraction options `-s`/`--select` (glob
over bundle entry file names), `--filter rom|patch` (extract only that class),
and `--no-extract` (report structure without extracting archive members).
Plain JSON bundles reference files by relative path, so those options have
nothing to extract. To apply one, run
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
trimmed copy elsewhere instead, and `-n`/`--dry-run` reports what would change
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
rom-weaver --json probe --input game.sfc | jq
```

### Exit codes

`rom-weaver` returns `0` on success, `1` when an operation fails, `2` for an
unsupported operation or a command-line usage error, and `130` when a run is
cancelled.

## File permissions

Inputs are checked for readability before a command does any work, and the
destinations of the commands that write large outputs — `extract`, `compress`,
`trim`, `patch apply`, and `patch create` — are checked for writability at the
same point. A read-only output directory costs a validation error, not an
abandoned multi-gigabyte compress. Both checks perform the real operation (an
open, a listing, a create), so ACLs, group membership, and read-only mounts are
honored rather than guessed at from mode bits.

Denials name the path, the operation, and the identities involved:

```
error: i/o error: cannot open `/roms/game.iso`: Permission denied (os error 13)
(`/roms/game.iso` is mode 0600 owned by 0:0; this process runs as 1000:1000)
```

Read that as three facts: what was refused, who owns it, and who asked. Only a
genuinely absent path is reported as `input path does not exist`; a file that
exists but cannot be reached — including one behind a directory your user
cannot traverse — is always reported as a denial, never as a typo.

Common fixes:

- **Reading someone else's files** — `sudo chown` them, add yourself to the
  owning group, or copy them somewhere you own.
- **Writing to a read-only location** — point `--output` at a directory you own.
  rom-weaver creates missing output directories but never changes permissions
  on an existing one.
- **Output files owned by the wrong user** — new files inherit your identity and
  umask; rom-weaver does not copy the source file's mode.
- **In a container** — the message adds a container hint, because the usual
  cause is a uid mismatch against a bind mount. Re-run with
  `--user "$(id -u):$(id -g)"` as shown in [Run in Docker](#run-in-docker).

Permission failures exit `1`. Under `--json` they arrive as a terminal event
with `"status": "failed"`, carrying `"stage": "validate"` when the preflight
caught them.

## Shell completions

Generate a completion script for your shell and load it however that shell
expects:

```bash
rom-weaver completions fish > ~/.config/fish/completions/rom-weaver.fish
rom-weaver completions bash > /etc/bash_completion.d/rom-weaver
```

Supported shells are `bash`, `zsh`, `fish`, `powershell`, and `elvish`.

For format specifications and upstream implementations, see
[`references.md`](references.md).

## Man pages

The pages under `docs/man` are generated directly from the same Clap command
definitions as `--help`. They are not checked in — run the generator to produce
them (the npm `prepack` step does this automatically before publishing):

```bash
mise run manpages
```

Use `man ./docs/man/rom-weaver.1` from a source checkout when they are not
installed system-wide. Do not edit the generated `.1` files manually.
