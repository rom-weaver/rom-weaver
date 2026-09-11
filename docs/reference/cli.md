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
  - [`setup`](#setup)
  - [`identify database` subcommands](#identify-database-subcommands)
  - [Identify result](#identify-result)
- [Checksum](#checksum)
- [Save Editor](#save-editor)
- [Cheats](#cheats)
- [Patching](#patching)
  - [Inputs](#inputs)
  - [Output and compression](#output-and-compression)
  - [Bundle detection](#bundle-detection)
  - [Bundle execution targets](#bundle-execution-targets)
  - [Checksum flags](#checksum-flags)
  - [Header and byte-order flags](#header-and-byte-order-flags)
  - [Extras](#extras)
  - [Validation](#validation)
- [Patch creation metadata](#patch-creation-metadata)
- [Bundles](#bundles)
  - [Bundle cheats](#bundle-cheats)
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
| `identify` | Match a ROM checksum, or a game name, to an exact dump name in local title data. |
| `checksum` | Hash a file, a byte range, or a ROM inside an archive. |
| `formats` | List the formats this build supports, and what it can do with each. |
| `compress` | Pack files into an archive, disc image, or ROM-specific compressed format. |
| `trim` | Cut the padding off a ROM, or put it back. |
| `cheat list` | List the cheat database's entries for a ROM, with each one's delivery. |
| `patch apply` | Apply one or more patches to a ROM, in order. |
| `patch create` | Build a patch from an original ROM and a changed one. |
| `patch validate` | Check patch application without keeping an output ROM. |
| `bundle create` | Write a `rom-weaver-bundle.json` recipe from local files. |
| `bundle parse` | Read a bundle recipe and report what it points at. |
| `bundle schema` | Print the `rom-weaver-bundle.json` JSON Schema to stdout. |
| `save identify` | Report save recognition, format, integrity, and active slot. |
| `save inspect` | Report the sections and generic field schema for a supported save. |
| `save get` | Read one field by its stable field ID. |
| `save set` | Check and apply one or more atomic `FIELD=VALUE` edits. |
| `save export-schema` | Report the generic field schema for a checked save. |
| `tools ppf-undo` | Undo a PPF3 patch, using the undo data stored inside it. |
| `setup` | Install the offline identify and cheat databases. |
| `completions` | Print a tab-completion script for your shell. |
| `man` | Print one generated manpage or install all generated manpages. |

`-h` prints a one-line summary of each option; `--help` prints the full explanation, including the extra detail on flags like `--patch-header`.

`probe`, `checksum`, `identify`, and `extract` accept one positional `FILE` instead of `-i`/`--input`. Supplying both forms is an error. `compress` and `trim` accept multiple positional files and repeated `--input` values; mixed forms retain their command-line order. `--` ends option parsing for filenames that start with `-`. The native aliases do not change the JSON/WASM command schema.

Output flags remain `-o`/`--output` on commands that accept them. `patch create` takes `--original` and `--modified`. The other short flags are `-j` threads, `-f` format, `-s` select, `-a` algorithm, `-e` extension, `-n` dry run, `-v` verbose, and `-q` quiet. `rom-weaver <command> --help` lists each command's flags.

`identify`, `probe`, and `checksum` accept `-` as either the positional file or the `--input` value to read from stdin.

See [Read from a pipeline](../how-to/identify-and-hash-files.md#read-from-a-pipeline) for examples.

### Alternate names

These alternate names invoke the same command or option:

| Canonical | Also accepted |
| --- | --- |
| `rom-weaver probe` | `rom-weaver inspect` |
| `rom-weaver patch apply` | `rom-weaver weave`, `rom-weaver patch weave` |
| `trim --revert` | `trim --untrim`, `trim --restore` |
| `trim --revert-marker` | `trim --reversible` |

Format names have alternates too, accepted anywhere `--format` is: `7zip` for `7z`, `3ds` for `z3ds`, `xdelta3` for `xdelta`, `bsdiff` for `bdf`, and more. The [format tables](formats.md) list every one.

Codecs are stricter. Each format accepts only the codec names in its own row of the [codec table](formats.md#create-time-codecs), and the only two alternates are CHD's `huffman` for `huff` and `avhu` for `avhuff`. Passing `--codec zlib` to a ZIP, for instance, is an error rather than a synonym for `deflate`.

Every command accepts these global flags, listed under `Global options` in its help:

- `--json` prints operation reports as one JSON object per line instead of human-readable output. Asset generators such as `bundle schema`, `completions`, and `man` without `--install` keep their native output. `man --install --json` reports the installed page count and output directory as a JSON event.
- `--progress` and `--no-progress` override the automatic choice, which is to show progress on a terminal and hide it when output is piped.
- `--log-level off|error|warn|info|debug|trace` sets how much rom-weaver logs to stderr. Logging is off unless you ask for it, and it is separate from the normal output.
- `-v`, `-vv`, and `-vvv` are shorthand for info, debug, and trace.
- `-q`/`--quiet` logs errors only and hides successful write summaries. Query results and dry-run plans remain visible. Progress is controlled separately by `--progress` and `--no-progress`.
- `--dep-trace` adds trace output from the bundled libraries, useful in a bug report. On its own it also raises rom-weaver's own logs to warning level.
- `--color` and `--no-color` override colored output. The flag wins over the `NO_COLOR` environment variable, which wins over the terminal-vs-piped default. `--color` keeps color even when piped, though the live progress bar stays terminal-only.

Most commands also accept `-j`/`--threads auto|N`. `auto` uses the available core count as its ceiling; a number sets a lower ceiling, and format or memory limits may still use fewer.

List-valued flags (`--algo`, `--checksum`, `--filter`, `--codec`, `--expect-in`, `--expect-out`, `--assume-in`, and the compression codec flags) can be repeated or comma-separated: `--algo crc32,sha1` and `--algo crc32 --algo sha1` do the same thing.

`-n`/`--dry-run` is available on every command, before or after the command name. It reports planned changes without writing destination files, changing installed databases, or downloading inputs. Read-only commands report a read-only plan instead of running the operation. Dry runs do not ask interactive questions.

Compression, trimming, and explicit patch application retain their detailed plans. Explicit patch application needs `--output` for its dry-run plan. Other commands report the requested destinations and any unresolved work. Archive member selection, remote bundle contents, checksums, and destination write access can remain unvalidated; the plan names these limits. A successful dry run means the plan completed, not that the later operation is guaranteed to succeed. Trimming an archive can use temporary extraction files, which are removed after planning.

In human output, a dry run shows the plan and a no-write notice. JSON plans carry `details.dry_run`, `writes`, `downloads`, and `read_only`; `writes` and `downloads` describe planned actions, not completed actions. Existing detailed plan fields remain available.

`--force` overwrites an output that already exists on commands that support it. Without it, a command that would overwrite stops before writing anything. `-y`/`--yes` answers confirmations with yes; it does not choose between candidates.

rom-weaver only asks interactive questions when stdin and stderr are both terminals and `--json` is off. Otherwise, it decides on its own or fails.

`rom-weaver formats` prints the same support matrix as [Supported formats](formats.md), for the build you are running. Add `--json` for a machine-readable copy.

## Reaching inside archives


`probe`, `extract`, `identify`, `checksum`, `trim`, `bundle parse`, and the patching commands open archives automatically. Five flags control archive selection:

- `-s`/`--select` picks which file to use, by exact name, prefix, or glob. On `patch apply` and `patch validate` it applies to the input and to every `--patch` archive alike.
- `--patch-select` picks the file inside the `--patch` archive it follows, overriding `--select` for that patch. Repeat it once per `--patch`, in the same order. Only `patch apply` and `patch validate` take it, and it is the only way to select different files from an archive input and an archive patch in one command.
- `--filter rom` considers only files that look like ROMs; `--filter patch` only patches. Both judge by extension, and the flag is repeatable and comma-separable (`--filter rom,patch`).
- `--no-ignore` also considers the files normally skipped: readmes, images, checksum sidecars, and OS clutter such as `.DS_Store`.
- `--no-extract` skips all of this and works on the file itself.

Not every command takes all five. `extract` has no `--no-extract`, since unpacking is the whole job. `trim` spells its filter `--no-filter`, because it filters to ROMs by default. `rom-weaver <command>
--help` is authoritative.

`extract` also unpacks archives found inside the input, up to eight levels deep; `--no-nested-extract` stops after the first layer. If any output file already exists, extraction stops before writing anything, unless `--force` is given. While extracting it can hash what it writes (`--checksum ALGO`, or `--checksum-rom ALGO` for the ROMs only) and report each file's format and platform (`--probe`).

## Identify

`identify` computes CRC32, MD5, and SHA-1. It searches the raw ROM and common checksum variants.

Native release packages include default Libretro packs plus OpenGood legacy fallbacks, and the Libretro cheat shards for the platforms in the [cheat database reference](cheat-database.md). Each pack uses Brotli, and optional groups use separate Brotli-compressed tar archives. The default `bundled-identify-data` feature enables packaged lookup.

Native identify performs no network access.

### Identify flags

- `--input ROM` names the ROM to hash and identify. Use `-` to read from stdin.
- `--hash HEX` identifies from a checksum instead of a file. The algorithm comes from the length: 8 characters for CRC32, 32 for MD5, 40 for SHA-1, 64 for SHA-256. Repeatable, one value per algorithm. Give exactly one of `--input` or `--hash`.
- `--size BYTES` gives the exact byte size to pair with `--hash`, narrowing the lookup to records of that size. It only applies with `--hash`.
- `--database PACK` searches a local RWFP1 pack instead of the built-in data and the installed packs. The pack may be raw or Brotli compressed (`.pack.br`, as the packaged data ships it). Repeatable.
- `--name QUERY` searches names instead of identifying a file or checksum. It requires `--system`, `--database`, or `--title-index` and cannot be combined with `--input` or `--hash`. Matching ignores case, punctuation, and accents (`asterix` matches `Astérix`). Every query word must match. Literal matches rank before spelling corrections. Pack searches cover each record's name, alternate names, and dump tags.
- `--title-index JSON` selects a `rom-weaver-identify-title-index-v1` file for `--name`. It returns base titles, pack slugs, and scores under `details.identifyTitles.matches` in JSON output. It cannot be combined with `--database`, `--system`, or `--size`.
- `--limit N` caps the number of matches `--name` returns. The default is 50. `N` must be at least 1, and `--limit` without `--name` is an error.
- `--system NAME` searches only one system's pack. It takes a canonical platform name or a common alias (`snes`, `psx`). An unknown name is an error.
- `--database-dir DIR` names the directory of installed packs (`*.pack` plus an optional `catalog.json`).
- `--exhaustive-database-search` searches every installed pack instead of only the packs the detected platform routes to.
- `--offline` asserts that identify performs no network access. Natively it never does; the flag records the guarantee in the log.

### Identify database directory

Installed packs live in one directory. The default is the per-user data directory: `$XDG_DATA_HOME/rom-weaver/identify` on Linux (`~/.local/share` fallback), `~/Library/Application Support/rom-weaver/identify` on macOS, `%APPDATA%\rom-weaver\identify` on Windows. `ROM_WEAVER_DATA_DIR` overrides the base; `--database-dir` overrides the full path.

### `setup`

`rom-weaver setup` installs the identify packs and the cheat shards into the directory above, downloading them from this version's GitHub release. It is for installs that ship only the executable - `cargo install`, `cargo binstall`, and `mise`; Homebrew, scoop, npm, the install scripts, and the Docker image place that data beside the binary already, and `setup` only reports on those.

- `--database-dir DIR` installs somewhere other than the per-user data directory.
- `--from ARCHIVE` installs a local `rom-weaver-identify-data.tar.br` and makes no network request. The archive must be the one built for this version; its packs are verified against the index it carries.
- `--force` downloads again even when the database is already installed.

Without `--force` an installed database is reported, not re-downloaded, so the command is safe to repeat. `--from` states the intent to install that archive, so it replaces an installed database the way `--force` does. JSON output carries `packs`, `downloaded`, and `database_dir`; `downloaded` is `false` for a `--from` install.

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

`optional-fantasy` contains MicroW8, PICO-8, TIC-80, and WASM-4. LowRes NX remains built in.

### Identify result

The terminal report has the `matched`, `ambiguous`, or `unknown` status. JSON reports put the typed result in `details.identify`. Optional result fields, present when known:

- `quality`: `exact`, `partial`, or `metadata_only`.
- `condition`: `database_required` (the detected platform's pack is not installed) or `unsupported_media_profile` (the pack expects per-track hashes but the input was hashed as one payload). Both come with a `hint` naming the cause; identify never downloads a pack itself, so a missing database is installed with `rom-weaver setup`. `status` stays `unknown`.
- `platform_candidates`: detected platforms with `confidence` and `evidence`.
- `media`, `components`: the input's media kind and hashed components.
- `database`: the pack that answered - `source`, `pack_format` (`RWFP1`), and `canonicalization_profile`.
- `matches[].provenance`: every source that contributed the matched hash record.
- `matches[].legacy_variant`: true for an OpenGood-only record.
- `matches[].dump_tags`: preserved GoodTools status tags for a legacy variant.
- `matches[].expected_components`: the matched record's own components - `size` and every checksum the database holds, plus `filename`, `hash_scope`, and the one-based `track` on a per-track disc record. A partial check reads the checksums it does not itself carry from here.
- `matches[].game_id`, `matches[].region`, `matches[].language`, `matches[].disc_number`, `matches[].revision`, `matches[].parent`: record metadata, each present when the pack holds it.
- `evidence`: `required_components_matched`, `required_components_total`, and `layout_matched`.

CUE/GDI/CHD inputs are identified per selected payload track, not yet as complete track sets. A single matched data track reports `quality: "partial"`, with `evidence` counting the required components that did not match.

A `--hash` run has no input components, so `components` reports the matched record's components instead of the input's.

The internal `ingest` command also identifies each ROM asset. It identifies a patch's expected source when the patch supplies a source checksum. Its JSON result puts these compact matches in `details.ingest`.

## Checksum

`checksum` computes CRC32, MD5, and SHA-1 when `--algo` is omitted. Passing `--algo` replaces that default set; repeat the flag or separate values with commas to compute multiple algorithms.

Native `checksum --digest --algo ALGO` prints only the primary checksum in lowercase, followed by one newline. It requires exactly one algorithm. It prints no filename, label, variant checksums, color, or elapsed time. `--quiet` retains the digest; progress and errors use stderr. A failed operation prints no digest. `--digest` conflicts with `--json` and `--dry-run`.

`--digest` retains the normal input semantics: archives open automatically, `--no-extract` hashes the archive bytes, and `--start`/`--length` select a byte range. It is not a checksum-file verification mode.

## Save Editor

All five `save` commands take a save path. `identify`, `inspect`, `get`, and `export-schema` do not write a file. `get` also takes one field ID.

`save set` takes one or more `FIELD=VALUE` assignments. It checks all assignments before it changes a copy. `-n` or `--dry-run` returns the change preview and writes nothing.

Without `-o` or `--output`, `save set` writes a free sibling name such as `game-edited.sav`. It adds a number when that name exists. An explicit output path must not exist unless `--force` is present. The output path must not name the source file.

`--game GAME_ID` selects a compatible handler when recognition is ambiguous. `--rom-sha1 SHA1` supplies a known ROM identity to recognition. The SHA-1 value contains 40 hexadecimal characters.

[Save Editor support](save-editor.md) lists the accepted game IDs, input layouts, and fields.

## Cheats

`cheat list --input ROM` detects the ROM's system, reads that system's shard from the cheat-database directory, matches the game, and prints one row per cheat: ID, delivery, raw code, description. `--json` puts the same data in `details.cheat_list`.

`rom-weaver setup` installs the shards along with the identify packs. A shard may be Brotli compressed (`<slug>.json.br`) or plain (`<slug>.json`); the compressed copy wins when both are present.

Delivery is `rom` or `unsupported`. The match class is `exact` (a checksum matched), `title` (the file name matched a game title), or `manual` (`--game`). Every run prints the CC-BY-SA-4.0 attribution line once.

The shared flags below are also on `patch apply` and `patch create`, under the `Cheats` help heading.

| Flag | Meaning |
| --- | --- |
| `--cheat ID_OR_DESCRIPTION` | Select one cheat by record ID or by exact description. Repeatable. A description that matches more than one entry fails with `cheat_selector_ambiguous`. |
| `--cheat-database DIR` | The directory holding the shards. Defaults to `$ROM_WEAVER_CHEAT_DATABASE`, then `<identify database directory>/cheats`. |
| `--cheat-system SYS` | `nes`, `snes`, `genesis`, `32x`, `sms`, `gamegear`, `gameboy`, `gameboy-color`, or `gba`, when the ROM header does not say. |
| `--game ID` | Use this database game ID instead of matching by checksum or title. |
| `--allow-cheat-conflicts` | Let a later cheat overwrite an earlier one at the same offset. Without it, two `rom` cheats writing different values to one byte fail with `cheat_write_conflict`. |

`patch apply --cheat` bakes the selected entries into the output ROM, after the patch chain. Selecting an `unsupported` entry fails the run.

`patch create --cheat` puts the `rom` entries in the patch and names the rest in `details.skipped_cheats`. Without `--cheat` it uses every cheat the matched game holds.

The directory layout is in [Cheat database reference](cheat-database.md). The recipes are in [Bake cheat codes into a ROM](../how-to/bake-cheat-codes.md).

## Patching

The flags shared by `patch apply` (also spelled `weave`) and `patch validate`. The task-shaped recipes live in [Apply patches from the CLI](../how-to/cli-apply.md).

Under `Basic`, `patch apply --help` puts the common `--input`, `--patch`, and `--output` task first. The complete list uses the `Basic`, `Archive/bundle`, `Compatibility`, `Diagnostics/authoring`, and `Performance` headings.

### Inputs

Repeat `--patch` to run several patches in order on one accumulated result. The shared input basis defaults to `auto`, which infers the authored input from checksums. `--default-patch-basis base` declares original-ROM patches. `previous` declares a dependent chain. Repeat `--patch-basis` for mixed per-patch overrides.

Leave `--patch` out entirely and rom-weaver looks for RetroArch-style patches sitting next to the ROM inside the input archive. A `rom-weaver-bundle.json` can supply the ROM, patch order, input rule, checks, and output name.

### Output and compression

For an ordinary file apply, `--output` is optional. Without it, the command writes a sibling named `<input-stem>-patched.<rom-extension>` and adds a numeric suffix when that path already exists. Bundle applies keep their bundle-provided output behavior.

Without an explicit compression flag, an output extension matching the selected ROM leaf writes raw ROM bytes. A registered creatable container extension selects that container. Unknown or ambiguous extensions fail rather than selecting a format silently.

`--no-compress` and its compatibility alias `--raw` force raw output. `--compress-format`, `--compress-codec`, and `--compress-level` remain the canonical compression flags; `--format`, `--codec`, and `--level` are accepted aliases on `patch apply`.

DCP patches need a Dreamcast `.cue` or `.gdi` input. They rebuild the GD-ROM data track and reassemble the whole disc, so they cannot be chained with another patch or combined with the header and checksum options.

### Bundle detection

When `patch apply` detects a bundle from its positional input, the canonical `rom-weaver-bundle.json` name is the fast path. It also content-probes valid plain `.json` files and root-level `.json` members inside archives. A stream-compressed positional bundle needs a canonical name such as `rom-weaver-bundle.json.gz`; pass a differently named one explicitly with `--bundle`.

Bundle version 2 requires `patchBasis`. Bundle version 1 remains readable and uses automatic inference. Per-entry `basis` values override the shared bundle rule.

### Bundle execution targets

A version 2 patch entry accepts `target` and `input`. Both use either a ROM reference (`rom: true`) or a generated-output reference (`patch: "producer-id"`), with an optional exact `member` selector.

| Field | Execution behavior |
| --- | --- |
| `target` | Continues the selected patch chain for the referenced target. The first selected step starts from that target's source bytes. |
| `input` | Reads the exact referenced bytes, including a named producer's output. It does not follow optional changes to an accumulated chain. |
| Both | Reads `input` and records the result in the chain identified by `target`. |
| Neither | Retains the ordinary accumulated execution order. |

When the identify database is installed, `rom.checks` that match a per-track disc record (only the packs whose catalog profile is per-track are read) supply the first selected step of every ROM-member lane that declares no `input` and no `inputChecks` with that member's checks from the record: `crc32`, `md5`, `sha1`, and `size`. The member matches a record component by file name, then by track number. The first selected step of a ROM-member lane verifies its input checks against the member bytes before it runs, whether the checks were authored or filled; an authored check is skipped when an earlier optional entry of that lane is deselected. A chain check failure (`patch.chain.input_mismatch`, `patch.chain.output_mismatch`, `patch.base.input_mismatch`) also carries the database's `expected_title`, `expected_platform`, `expected_region`, and `expected_revision` for the declared state when the database knows it. Both are best effort: a missing database changes nothing.

A named producer must be selected and precede its consumer. Member selection applies to both ROM sources and generated outputs. A producer reference identifies the intermediate bytes after that patch, before final output compression or disc reassembly. `basis` and `patchBasis` describe authored verification requirements; they do not choose execution bytes. `checkStates` and the check-reference fields share authored state values across entries. Output compression remains an apply-time option.

### Checksum flags

- Formats that carry their own checksums are verified strictly. `--ignore-checksum-validation` applies the patch anyway, which can produce a broken ROM.
- `--expect-in ALGO=HEX` stops unless the ROM about to be patched matches.
- `--expect-out ALGO=HEX` fails unless the finished ROM matches.
- `--assume-in ALGO=HEX` takes a checksum on trust rather than reading the ROM to compute it. It is a speed option for scripts and verifies nothing.

### Header and byte-order flags

- `--patch-header auto|keep|strip` decides whether each patch applies to the ROM with or without its copier header. Auto compares source checksums per patch. For the first patch only, missing checksum evidence can trigger record, format-validation, and platform-header inference. See [How rom-weaver picks a patch's bytes](../explanation/patch-formats.md#how-rom-weaver-picks-a-patchs-bytes).
- `--output-header auto|keep|strip` decides whether the finished ROM keeps its header. Auto keeps the ones emulators need and drops the ones they do not.
- `--repair-checksum` repairs supported internal checksums and compatibility header fields after patching.
- `--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped` puts an N64 ROM in the interleaving a patch expects. Auto matches the patch's source CRC32; for the first patch, a patch that carries no checksum falls back to the shape of its changes. An order settled that way is named in the report label. The output is written back in the order the input arrived in. See [How rom-weaver picks a patch's bytes](../explanation/patch-formats.md#how-rom-weaver-picks-a-patchs-bytes).

### Extras

- `--code` bakes a Game Genie, GameShark/Pro Action Replay, or raw Xploder code into the ROM, as if it were a patch. Repeat it for each code. `--code-system nes|snes|genesis|32x|sms|gamegear|sg1000|gameboy|gba|psx` names the console when the ROM header does not. `--code-kind auto|game-genie|gameshark|xploder` pins the scheme instead of inferring it from the code's shape. Xploder supports raw GBA ROM-patch codes and plain PlayStation constant writes into PS-X EXE files. Codes whose address resolves to runtime memory, conditional codes, and encrypted codes are rejected. One value may hold several codes joined with `+`, commas, or newlines. Codes are applied after the last `--patch`, and cannot be combined with `--patch-header strip` or `--n64-byte-order`. `patch create` takes the same three flags in place of `--modified` and writes a patch holding only the codes' byte writes. The recipe is [Bake cheat codes into a ROM](../how-to/bake-cheat-codes.md).
- `--emit-bundle PATH` also writes a `rom-weaver-bundle.json` recording the run: the ROM's checksums, the patches in order, and the result. It runs the same code as `bundle create`, so the file is byte-identical to the equivalent `bundle create` call. It carries no per-patch names or authors; for those use `bundle create`, `bundle create --from`, or `--tui`.
- `--tui` asks for each patch's name, version, author, and optional state plus an output name, then applies and writes the bundle. It needs a terminal, and for now it needs explicit `--patch` files; re-opening a bundle is not supported yet.

### Validation

`patch validate` parses and checks the patch chain without keeping an output ROM. It can write temporary files while applying patches. It verifies the checksums available in each format; formats without result checks cannot establish that the output matches the author's intent.

- `--expect-in` adds a check on the ROM itself, and accepts a checksum (`ALGO=HEX`), an exact size (`size=N`), or a minimum size (`min-size=N`).
- `--strip-header` and `--n64-byte-order` put the ROM in the form the patches expect before checking; N64 byte order defaults to matching the patch's source CRC32.
- `--default-patch-basis base|previous|auto` sets the shared input relationship. The default is `auto`.
- `--patch-basis base|previous|auto` overrides one patch. It binds to the preceding `--patch`.
- `--independent` checks each patch separately against the original ROM. It reports every verdict instead of stopping at the first failure.

## Patch creation metadata

SOLID output accepts `--solid-system`, `--solid-game`, and `--solid-hack` for its three-string header. Any of `--solid-version`, `--solid-author`, `--solid-contact`, or `--solid-comment` selects the seven-string extended header. `--solid-extended` selects the extended header with empty extra fields. When `--code` supplies the changes and the extended header has no `--solid-comment`, the comment records the codes. These options require SOLID output and cannot be combined with `--plan`.

[Create patches from the CLI](../how-to/cli-create.md) provides a metadata example and reconstruction check.

## Bundles

`bundle schema` prints the JSON Schema. The current schema is [rom-weaver-bundle-v2.schema.json](../rom-weaver-bundle-v2.schema.json). Version 1 bundles remain readable.

| Option | Meaning |
| --- | --- |
| `--rom-name`, `--rom-url` | Expected logical ROM name and remote source. A filename mismatch warns; checksum and size mismatches remain strict. |
| `--rom-member PATH` | Exact archive member or disc track recorded as the bundle's ROM target. Its checksums describe that member. |
| `--default-patch-basis base\|previous\|auto` | Shared input basis recorded as `patchBasis`. The default is `auto`. |
| `--patch-id`, `--patch-version` | Stable patch identity and author-controlled version. |
| `--patch-author`, `--patch-name`, `--patch-description`, `--patch-label` | Patch metadata. |
| `--patch-optional` | Marks the preceding patch optional. |
| `--patch-source-url`, `--patch-header`, `--patch-basis` | Source URL, header policy, and input basis for the preceding patch. |
| `--expect-out` | Expected final result checks. |
| `--patch-expect-in`, `--patch-expect-out` | Expected checks around the preceding patch. |
| `--assume-in` | Supplied ROM checksums used without reading the file to verify them. |
| `--bundle ARCHIVE`, `--no-bundle-rom` | Archive packaging and exclusion of ROM bytes. |
| `--schema-ref URL` | Adds a `$schema` URL; omitted by default. |
| `--from FILE`, `--from -` | Reads a specification from a file or stdin. File paths resolve against the spec directory, or the current directory for stdin. Explicit CLI values override the spec: `--patch` replaces the spec's patch chain and `--cheat` replaces its `cheats` array, in both cases wholesale. |
| `--cheat ID_OR_DESCRIPTION` | Records a cheat selection in the bundle's `cheats` array. Needs `--input`. Takes the same selection flags as `patch apply`. |

Patch metadata options bind to the preceding `--patch`. `--from` preserves an existing `$schema`. A ROM entry needs a local `path` or a `url`; a URL-only ROM supplies `--rom-url`. Patch entries need local paths unless explicit CLI patches replace the spec chain. Checks-only ROM entries are rejected.

### Bundle cheats

The optional top-level `cheats` array records the cheat selection that produced a build, in selection order. `bundle create --cheat` and `patch apply --emit-bundle` write it. A bundle needs at least one `patches` entry or one `cheats` entry.

| Field | Meaning |
| --- | --- |
| `id` | Cheat database record ID. Required. An exact description is also accepted; one that matches several records fails with `cheat_selector_ambiguous`. |
| `source`, `revision` | The database the ID belongs to and the revision it was selected against. |
| `description` | The record's description. |
| `code` | Raw code snapshot, so the entry still applies when the database is absent. |
| `optional` | When true an unresolvable entry is skipped and named in the report; omitted or false makes it fail the apply. |

Applying a bundle resolves each entry by `id` through the cheat database at `--cheat-database`, then falls back to `code`. An entry that resolves to nothing, or that the ROM's bytes cannot bake, fails the apply unless it is `optional`. Entries bake after the patch chain, so the result equals the same `patch apply --cheat`. Write conflicts fail with `cheat_write_conflict` unless `--allow-cheat-conflicts` is given.

`patch apply --without-cheats` ignores the whole `cheats` array and runs only the patch chain. It is all-or-nothing; there is no per-cheat filter. A bundle with no patches and `--without-cheats` fails, because nothing is left to run.

When every recorded cheat is `optional` and none resolves, a bundle with no patches fails and names each skipped entry.

`bundle parse` names each cheat and whether it is optional.

`bundle parse` accepts archive selection options for packaged bundles. A plain JSON recipe references paths and has no archive members to unpack. [Bundles from the CLI](../how-to/cli-bundles.md) gives creation, parsing, and apply examples.

## Supported formats


The full support matrix - every patch format, container and compressed ROM or disc image, create-time codec, checksum algorithm, trim target, and detected header - lives in [Supported formats](formats.md). For picking a format rather than looking one up, see the [archive formats](../how-to/work-with-archives.md) and [compression formats](../explanation/compression-formats.md) guides.

## JSON output


Pass `--json` to make operation commands emit one JSON object per line, including progress, status, warnings, selected inputs, and emitted-file metadata where relevant. JSON mode disables interactive selection, making it the stable interface for scripts. Commands that generate an asset, such as `bundle schema`, `completions`, and `man` without `--install`, still write that asset in its native format.

A closed stdout pipe does not cause a panic or interrupt file creation. The command finishes its work and retains its operation exit status. Other stdout write errors produce a diagnostic on stderr and a nonzero exit status.

```bash
rom-weaver --json probe --input game.sfc | jq
```

### Exit codes

`rom-weaver` returns `0` on success, `1` when an operation fails, `2` for an unsupported operation or a command-line usage error, and `130` when a run is cancelled.

## File permissions


During normal execution, inputs are checked for readability before a command does any work. The commands that write large outputs (`extract`, `compress`, `trim`, `patch apply`, and `patch create`) have their destination checked for writability at the same point, so a read-only output directory costs you a quick error rather than an abandoned multi-gigabyte compress. Both checks do the real thing, an open, a listing, or a create, so ACLs, group membership, and read-only mounts are honored instead of guessed at from mode bits.

Denials name the path, the operation, and the identities involved:

```text
error: i/o error: cannot open `/roms/game.iso`: Permission denied (os error 13)
(`/roms/game.iso` is mode 0600 owned by 0:0; this process runs as 1000:1000)
```

The message identifies what was refused, who owns it, and which identity made the request. Only a genuinely missing path is reported as `input path does not exist`. A file that exists but cannot be reached, including one behind a directory without search permission, is reported as a denial. [Fix a permission error](../how-to/fix-permission-errors.md) gives the corrective steps.

Permission failures exit `1`. Under `--json` they arrive as a terminal event with `"status": "failed"`, carrying `"stage": "validate"` when the preflight caught them.

## Man pages


The pages under `docs/man` come from the same Clap definitions as `--help`. Release packaging generates them. `rom-weaver man [COMMAND...]` prints a page. `rom-weaver man --install [COMMAND...]` writes all pages, or the named page, to the configured man directory. `--man-dir DIR` and `ROM_WEAVER_MAN_DIR` select that directory.

On Unix, the default install directory is `$XDG_DATA_HOME/man/man1`, with `~/.local/share/man/man1` as the fallback. On Windows, it is `%LOCALAPPDATA%\rom-weaver\docs\man`. Homebrew, the macOS/Linux install script, and global npm installs add the pages to a Unix manpath. Windows installers store them under the installed package's `docs/man` directory. Cargo, cargo-binstall, and mise install only the executable. Docker stores the pages under `/usr/local/share/man/man1`, but its distroless image has no `man(1)` program.

[Install the CLI](../how-to/install-cli.md) covers man-page installation. [Generate man pages](../development/development.md#generated-files) covers source builds.
