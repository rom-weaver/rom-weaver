# CLI reference

Every rom-weaver command and global flag, the archive-selection options, JSON
output, exit codes, file permissions, shell completions, and man pages.
Installation is covered in [Install the CLI](../how-to/install-cli.md), and the
tutorial is [Your first weave in the terminal](../tutorials/cli-first-weave.md).

<!-- START doctoc -->
## Table of contents

- [Everyday commands](#everyday-commands)
- [Commands](#commands)
  - [Alternate names](#alternate-names)
- [Reaching inside archives](#reaching-inside-archives)
- [Supported formats](#supported-formats)
- [JSON output](#json-output)
  - [Exit codes](#exit-codes)
- [File permissions](#file-permissions)
- [Shell completions](#shell-completions)
- [Man pages](#man-pages)

<!-- END doctoc -->

## Everyday commands

Find out what a file is. Archives are opened for you unless you pass
`--no-extract`:

```bash
rom-weaver probe --input unknown-file.bin
rom-weaver probe --input archive.zip --select '*.sfc'
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
| `extract` | Unpack an archive or single-payload compressed format. |
| `checksum` | Hash a file, a byte range, or a ROM inside an archive. |
| `ingest` | Sort a file into ROMs and patches, unpacking and hashing as needed. |
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
The [format tables](formats.md) list every one.

Codecs are stricter. Each format accepts only the codec names in its own row of
the [codec table](formats.md#create-time-codecs), and the only
two alternates are CHD's
`huffman` for `huff` and `avhu` for `avhuff`. Passing `--codec zlib` to a ZIP,
for instance, is an error rather than a synonym for `deflate`.

Every command accepts these global flags, listed under `Global options` in its
help:

- `--json` prints operation reports as one JSON object per line instead of
  human-readable output. Asset generators such as `bundle schema` and
  `completions` keep their native schema or script output.
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

Most commands also accept `-j`/`--threads auto|N`. `auto` uses the available
core count as its ceiling; a number sets a lower ceiling, and format or memory
limits may still use fewer.

List-valued flags (`--algo`, `--checksum`, `--filter`, `--codec`, `--expect-in`,
`--expect-out`, `--assume-in`, and the compression codec flags) can be repeated
or comma-separated: `--algo crc32,sha1` and `--algo crc32 --algo sha1` do the
same thing.

rom-weaver only asks interactive questions when stdin and stderr are both
terminals and `--json` is off. Otherwise, it decides on its own or fails.

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

## Supported formats


The full support matrix - every patch format, container and compressed ROM or
disc image, create-time codec, checksum algorithm, trim target, and detected
header - lives in [Supported formats](formats.md). For picking a
format rather than looking one up, see the
[archive formats](../how-to/work-with-archives.md) and
[compression formats](../explanation/compression-formats.md) guides.

## JSON output


Pass `--json` to make operation commands emit one JSON object per line,
including progress, status, warnings, selected inputs, and emitted-file
metadata where relevant. JSON mode disables interactive selection, making it
the stable interface for scripts. Commands that generate an asset, such as
`bundle schema` and `completions`, still write that asset in its native format.

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

```text
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
  `--user "$(id -u):$(id -g)"` as shown in
  [Run in Docker](../how-to/install-cli.md#run-in-docker).

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

The Homebrew and script installers already place these files. npm packages
ship them under `docs/completions`; for the other install methods, redirect the
command to the path your shell uses.

## Man pages


The pages under `docs/man` come from the same Clap definitions as `--help`, so
they always match it. They are generated during release packaging and are
installed by Homebrew and the install scripts. In a source checkout, run:

```bash
mise run manpages
```

Use `man ./docs/man/rom-weaver.1` from a source checkout when they are not
installed system-wide. Do not edit the generated `.1` files manually.
