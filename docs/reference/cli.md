# CLI reference

Every rom-weaver command and global flag, the archive-selection options, the patching flags, JSON output, exit codes, file permissions, and man pages. Installation is covered in [Install the CLI](../how-to/install-cli.md), and the tutorial is [Your first apply in the terminal](../tutorials/cli-first-weave.md).

<!-- START doctoc -->
## Table of contents

- [Commands](#commands)
  - [Alternate names](#alternate-names)
- [Reaching inside archives](#reaching-inside-archives)
- [Identify](#identify)
  - [Identify flags](#identify-flags)
  - [Identify database directory](#identify-database-directory)
  - [`identify database` subcommands](#identify-database-subcommands)
  - [Identify result](#identify-result)
- [Checksum](#checksum)
- [Patching](#patching)
  - [Inputs](#inputs)
  - [Output and compression](#output-and-compression)
  - [Bundle detection](#bundle-detection)
  - [Checksum flags](#checksum-flags)
  - [Header and byte-order flags](#header-and-byte-order-flags)
  - [Extras](#extras)
  - [Validation](#validation)
- [Supported formats](#supported-formats)
- [JSON output](#json-output)
  - [Exit codes](#exit-codes)
- [File permissions](#file-permissions)
- [Man pages](#man-pages)

<!-- END doctoc -->

## Commands


| Command | Purpose |
| --- | --- |
| `probe` | Identify a file: its format, its platform, and any header it carries. |
| `extract` | Unpack an archive or single-payload compressed format. |
| `identify` | Match a ROM checksum to an exact dump name in local title data. |
| `checksum` | Hash a file, a byte range, or a ROM inside an archive. |
| `formats` | List the formats this build supports, and what it can do with each. |
| `compress` | Pack files into an archive, disc image, or ROM-specific compressed format. |
| `trim` | Cut the padding off a ROM, or put it back. |
| `patch apply` | Apply one or more patches to a ROM, in order. |
| `patch create` | Build a patch from an original ROM and a changed one. |
| `patch validate` | Check that patches would apply cleanly, without writing anything. |
| `bundle create` | Write a `rom-weaver-bundle.json` recipe from local files. |
| `bundle parse` | Read a bundle recipe and report what it points at. |
| `bundle schema` | Print the `rom-weaver-bundle.json` JSON Schema to stdout. |
| `tools ppf-undo` | Undo a PPF3 patch, using the undo data stored inside it. |
| `completions` | Print a tab-completion script for your shell. |

`-h` prints a one-line summary of each option; `--help` prints the full explanation, including the extra detail on flags like `--patch-header`.

Nearly every command takes `-i`/`--input` and `-o`/`--output`; `patch create` is the exception, taking `--original` and `--modified` instead. The other short flags are `-j` threads, `-f` format, `-s` select, `-a` algorithm, `-e` extension, `-n` dry run, `-v` verbose, and `-q` quiet. Run `rom-weaver <command> --help` for the full list.

`identify`, `probe`, and `checksum` accept `-` as the `--input` value to read from stdin.

```bash
curl -sL https://example.com/game.gba | rom-weaver checksum --input - --algo sha256
xz -dc game.iso.xz | rom-weaver probe --input - --json
```

### Alternate names

Some commands and flags answer to more than one name. They are the same code either way, so pick whichever reads better:

| Canonical | Also accepted |
| --- | --- |
| `rom-weaver probe` | `rom-weaver inspect` |
| `rom-weaver patch apply` | `rom-weaver weave`, `rom-weaver patch weave` |
| `trim --revert` | `trim --untrim`, `trim --restore` |
| `trim --revert-marker` | `trim --reversible` |

Format names have alternates too, accepted anywhere `--format` is: `7zip` for `7z`, `3ds` for `z3ds`, `xdelta3` for `xdelta`, `bsdiff` for `bdf`, and more. The [format tables](formats.md) list every one.

Codecs are stricter. Each format accepts only the codec names in its own row of the [codec table](formats.md#create-time-codecs), and the only two alternates are CHD's `huffman` for `huff` and `avhu` for `avhuff`. Passing `--codec zlib` to a ZIP, for instance, is an error rather than a synonym for `deflate`.

Every command accepts these global flags, listed under `Global options` in its help:

- `--json` prints operation reports as one JSON object per line instead of human-readable output. Asset generators such as `bundle schema` and `completions` keep their native schema or script output.
- `--progress` and `--no-progress` override the automatic choice, which is to show progress on a terminal and hide it when output is piped.
- `--log-level off|error|warn|info|debug|trace` sets how much rom-weaver logs to stderr. Logging is off unless you ask for it, and it is separate from the normal output.
- `-v`, `-vv`, and `-vvv` are shorthand for info, debug, and trace.
- `-q`/`--quiet` logs errors only.
- `--dep-trace` adds trace output from the bundled libraries, useful in a bug report. On its own it also raises rom-weaver's own logs to warning level.
- `--color` and `--no-color` override colored output. The flag wins over the `NO_COLOR` environment variable, which wins over the terminal-vs-piped default. `--color` keeps color even when piped, though the live progress bar stays terminal-only.

Most commands also accept `-j`/`--threads auto|N`. `auto` uses the available core count as its ceiling; a number sets a lower ceiling, and format or memory limits may still use fewer.

List-valued flags (`--algo`, `--checksum`, `--filter`, `--codec`, `--expect-in`, `--expect-out`, `--assume-in`, and the compression codec flags) can be repeated or comma-separated: `--algo crc32,sha1` and `--algo crc32 --algo sha1` do the same thing.

These three appear on the commands that write files:

- `--force` overwrites an output that already exists. Without it, a command that would overwrite stops before writing anything.
- `-n`/`--dry-run` reports what the command would write, and writes nothing.
- `-y`/`--yes` answers every confirmation with yes, so a run never waits for input.

rom-weaver only asks interactive questions when stdin and stderr are both terminals and `--json` is off. Otherwise, it decides on its own or fails.

`rom-weaver formats` prints the same support matrix as [Supported formats](formats.md), for the build you are running. Add `--json` for a machine-readable copy.

## Reaching inside archives


`probe`, `extract`, `identify`, `checksum`, `trim`, `bundle parse`, and the patching commands open archives automatically. Four flags control archive selection:

- `-s`/`--select` picks which file to use, by exact name, prefix, or glob.
- `--filter rom` considers only files that look like ROMs; `--filter patch` only patches. Both judge by extension, and the flag is repeatable and comma-separable (`--filter rom,patch`).
- `--no-ignore` also considers the files normally skipped: readmes, images, checksum sidecars, and OS clutter such as `.DS_Store`.
- `--no-extract` skips all of this and works on the file itself.

Not every command takes all four. `extract` has no `--no-extract`, since unpacking is the whole job. `trim` spells its filter `--no-filter`, because it filters to ROMs by default. `rom-weaver <command>
--help` is authoritative.

`extract` also unpacks archives found inside the input, up to eight levels deep; `--no-nested-extract` stops after the first layer. If any output file already exists, extraction stops before writing anything, unless `--force` is given. While extracting it can hash what it writes (`--checksum ALGO`, or `--checksum-rom ALGO` for the ROMs only) and report each file's format and platform (`--probe`).

## Identify

`identify` computes CRC32, MD5, and SHA-1. It searches the raw ROM and common checksum variants.

Native release packages include default Libretro packs plus OpenGood legacy fallbacks. Optional groups use separate Zstandard archives. The default `bundled-identify-data` feature enables packaged lookup.

Native identify performs no network access.

### Identify flags

- `--database PACK` searches a local RWFP1, RWFP2, RWFP3, or RWFP4 pack instead of the built-in data and the installed packs. Repeatable.
- `--system NAME` searches only one system's pack. It takes a canonical platform name or a common alias (`snes`, `psx`). An unknown name is an error.
- `--database-dir DIR` names the directory of installed packs (`*.pack` plus an optional `catalog.json`).
- `--exhaustive-database-search` searches every installed pack instead of only the packs the detected platform routes to.
- `--offline` asserts that identify performs no network access. Natively it never does; the flag records the guarantee in the log.

### Identify database directory

Installed packs live in one directory. The default is the per-user data directory: `$XDG_DATA_HOME/rom-weaver/identify` on Linux (`~/.local/share` fallback), `~/Library/Application Support/rom-weaver/identify` on macOS, `%APPDATA%\rom-weaver\identify` on Windows. `ROM_WEAVER_DATA_DIR` overrides the base; `--database-dir` overrides the full path.

### `identify database` subcommands

Native builds only; the browser build reports them as unsupported. Every subcommand accepts `--database-dir DIR`.

| Subcommand | Purpose |
| --- | --- |
| `list` | List every catalog platform, its source, and whether its pack is installed. |
| `status` | List the installed pack files: slug, format, size, and sha256. |
| `path` | Print the identify database directory. |
| `remove <SYSTEM>` | Remove one system's installed pack. |
| `install-all` | Install the default database for this rom-weaver version. |
| `install-group <GROUP> [--from <ARCHIVE>]` | Download or import one optional pack group. |
| `import-redump <ZIP>` | Build a pack from a local Redump DAT ZIP. |
| `install <SYSTEM> [--from <ZIP>]` | Install one Redump system pack. Without `--from`, download the DAT from Redump. |
| `update [SYSTEM] [--from <ZIP>]` | Update one or all installed Redump packs. Without `--from`, download current DAT files. |

`<SYSTEM>` is a canonical platform name or alias. Platforms that OpenGood covers stay built in and do not install from Redump.

`optional-computers` contains these families:

- Amstrad, Atari computers, Commodore, DOS, Enterprise, Memotech, MSX, and SAM Coupé.
- Sharp, Sinclair, Tandy, Tangerine, Thomson, and Videoton.

PICO-8, TIC-80, WASM-4, LowRes NX, and MicroW8 remain built in.

### Identify result

The terminal report has the `matched`, `ambiguous`, or `unknown` status. JSON reports put the typed result in `details.identify`. Optional result fields, present when known:

- `quality`: `exact`, `partial`, or `metadata_only`, for an RWFP2, RWFP3, or RWFP4 match.
- `condition`: `database_required` (the detected platform's pack is not installed) or `unsupported_media_profile` (the pack expects per-track hashes but the input was hashed as one payload). Both come with a `hint` naming the fix. `status` stays `unknown`.
- `platform_candidates`: detected platforms with `confidence` and `evidence`.
- `media`, `components`: the input's media kind and hashed components.
- `database`: the pack that answered - `source`, `pack_format` (`RWFP1`/`RWFP2`/`RWFP3`/`RWFP4`), and `canonicalization_profile`.
- `matches[].provenance`: every source that contributed the matched hash record.
- `matches[].legacy_variant`: true for an OpenGood-only record.
- `matches[].dump_tags`: preserved GoodTools status tags for a legacy variant.
- `evidence`: `required_components_matched`, `required_components_total`, and `layout_matched`.

CUE/GDI/CHD inputs are identified per selected payload track, not yet as complete track sets. A single matched data track reports `quality: "partial"`, with `evidence` counting the required components that did not match.

The internal `ingest` command also identifies each ROM asset. It identifies a patch's expected source when the patch supplies a source checksum. Its JSON result puts these compact matches in `details.ingest`.

## Checksum

`checksum` computes CRC32, MD5, and SHA-1 when `--algo` is omitted. Passing `--algo` replaces that default set; repeat the flag or separate values with commas to compute multiple algorithms.

## Patching

The flags shared by `patch apply` (also spelled `weave`) and `patch validate`. The task-shaped recipes live in [Apply patches from the CLI](../how-to/cli-apply.md).

Under `Basic`, `patch apply --help` puts the common `--input`, `--patch`, and `--output` task first. The complete list uses the `Basic`, `Archive/bundle`, `Compatibility`, `Diagnostics/authoring`, and `Performance` headings.

### Inputs

Repeat `--patch` to run several patches in order, each on the result of the last. Leave `--patch` out entirely and rom-weaver looks for RetroArch-style patches sitting next to the ROM inside the input archive. A `rom-weaver-bundle.json` can supply the ROM, the patch order, the checks, and the output name instead.

### Output and compression

For an ordinary file apply, `--output` is optional. Without it, the command writes a sibling named `<input-stem>-patched.<rom-extension>` and adds a numeric suffix when that path already exists. Bundle applies keep their bundle-provided output behavior.

Without an explicit compression flag, an output extension matching the selected ROM leaf writes raw ROM bytes. A registered creatable container extension selects that container. Unknown or ambiguous extensions fail rather than selecting a format silently.

`--no-compress` and its compatibility alias `--raw` force raw output. `--compress-format`, `--compress-codec`, and `--compress-level` remain the canonical compression flags; `--format`, `--codec`, and `--level` are accepted aliases on `patch apply`.

DCP patches need a Dreamcast `.cue` or `.gdi` input. They rebuild the GD-ROM data track and reassemble the whole disc, so they cannot be chained with another patch or combined with the header and checksum options.

### Bundle detection

When `patch apply` detects a bundle from its positional input, the canonical `rom-weaver-bundle.json` name is the fast path. It also content-probes valid plain `.json` files and root-level `.json` members inside archives. A stream-compressed positional bundle needs a canonical name such as `rom-weaver-bundle.json.gz`; pass a differently named one explicitly with `--bundle`.

### Checksum flags

- Formats that carry their own checksums are verified strictly. `--ignore-checksum-validation` applies the patch anyway, which can produce a broken ROM.
- `--expect-in ALGO=HEX` stops unless the ROM about to be patched matches.
- `--expect-out ALGO=HEX` fails unless the finished ROM matches.
- `--assume-in ALGO=HEX` takes a checksum on trust rather than reading the ROM to compute it. It is a speed option for scripts and verifies nothing.

### Header and byte-order flags

- `--patch-header auto|keep|strip` decides whether each patch applies to the ROM with or without its copier header. Auto works it out per patch from the patch's own source checksum under any algorithm, and for a patch that carries none from where its records land, from which form the format itself accepts, and from which result the console still recognises. See [How rom-weaver picks a patch's bytes](../explanation/patch-formats.md#how-rom-weaver-picks-a-patchs-bytes).
- `--output-header auto|keep|strip` decides whether the finished ROM keeps its header. Auto keeps the ones emulators need and drops the ones they do not.
- `--repair-checksum` repairs supported internal checksums and compatibility header fields after patching.
- `--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped` puts an N64 ROM in the interleaving a patch expects. Auto matches the patch's source CRC32; for the first patch, a patch that carries no checksum falls back to the shape of its changes. An order settled that way is named in the report label. The output is written back in the order the input arrived in. See [How rom-weaver picks a patch's bytes](../explanation/patch-formats.md#how-rom-weaver-picks-a-patchs-bytes).

### Extras

- `--code` bakes a Game Genie, GameShark/Pro Action Replay, or raw Xploder code into the ROM, as if it were a patch. Repeat it for each code. `--code-system nes|snes|genesis|gameboy|gba|psx` names the console when the ROM header does not. `--code-kind auto|game-genie|gameshark|xploder` pins the scheme instead of inferring it from the code's shape. Xploder supports raw GBA ROM-patch codes and plain PlayStation constant writes into PS-X EXE files. Runtime RAM, conditional, and encrypted codes are rejected. The recipe is [Bake cheat codes into a ROM](../how-to/bake-cheat-codes.md).
- `--emit-bundle PATH` also writes a `rom-weaver-bundle.json` recording the run: the ROM's checksums, the patches in order, and the result. It runs the same code as `bundle create`, so the file is byte-identical to the equivalent `bundle create` call. It carries no per-patch names or authors; for those use `bundle create`, `bundle create --from`, or `--tui`.
- `--tui` asks for each patch's name, version, author, and optional state plus an output name, then applies and writes the bundle. It needs a terminal, and for now it needs explicit `--patch` files; re-opening a bundle is not supported yet.

### Validation

`patch validate` runs the same checks as `patch apply` but writes nothing: it parses each patch and verifies every checksum the format carries.

- `--expect-in` adds a check on the ROM itself, and accepts a checksum (`ALGO=HEX`), an exact size (`size=N`), or a minimum size (`min-size=N`).
- `--strip-header` and `--n64-byte-order` put the ROM in the form the patches expect before checking; N64 byte order defaults to matching the patch's source CRC32.
- Patches are checked as a chain by default, each against the output of the one before it. `--independent` checks each one against the original ROM instead and reports a verdict per patch, rather than stopping at the first failure.

## Supported formats


The full support matrix - every patch format, container and compressed ROM or disc image, create-time codec, checksum algorithm, trim target, and detected header - lives in [Supported formats](formats.md). For picking a format rather than looking one up, see the [archive formats](../how-to/work-with-archives.md) and [compression formats](../explanation/compression-formats.md) guides.

## JSON output


Pass `--json` to make operation commands emit one JSON object per line, including progress, status, warnings, selected inputs, and emitted-file metadata where relevant. JSON mode disables interactive selection, making it the stable interface for scripts. Commands that generate an asset, such as `bundle schema` and `completions`, still write that asset in its native format.

```bash
rom-weaver --json probe --input game.sfc | jq
```

### Exit codes

`rom-weaver` returns `0` on success, `1` when an operation fails, `2` for an unsupported operation or a command-line usage error, and `130` when a run is cancelled.

## File permissions


Inputs are checked for readability before a command does any work. The commands that write large outputs (`extract`, `compress`, `trim`, `patch apply`, and `patch create`) have their destination checked for writability at the same point, so a read-only output directory costs you a quick error rather than an abandoned multi-gigabyte compress. Both checks do the real thing, an open, a listing, or a create, so ACLs, group membership, and read-only mounts are honored instead of guessed at from mode bits.

Denials name the path, the operation, and the identities involved:

```text
error: i/o error: cannot open `/roms/game.iso`: Permission denied (os error 13)
(`/roms/game.iso` is mode 0600 owned by 0:0; this process runs as 1000:1000)
```

Read that as three facts: what was refused, who owns it, and who asked. Only a genuinely missing path is reported as `input path does not exist`. A file that exists but cannot be reached, including one behind a directory you cannot traverse, is always reported as a denial rather than as a typo. The fixes for each case are in [Fix a permission error](../how-to/fix-permission-errors.md).

Permission failures exit `1`. Under `--json` they arrive as a terminal event with `"status": "failed"`, carrying `"stage": "validate"` when the preflight caught them.

## Man pages


The pages under `docs/man` come from the same Clap definitions as `--help`, so they always match it. They are generated during release packaging and are installed by Homebrew and the install scripts. In a source checkout, run:

```bash
mise run manpages
```

Use `man ./docs/man/rom-weaver.1` from a source checkout when they are not installed system-wide. Do not edit the generated `.1` files manually.
