# Identify and hash ROMs from the CLI

Match a ROM to an exact dump name with `rom-weaver identify`.

Use `probe` to inspect the file type. Use `checksum` to prove which bytes it holds.

<!-- START doctoc -->
## Table of contents

- [Identify a ROM title](#identify-a-rom-title)
- [Install the default identify data](#install-the-default-identify-data)
- [Install an optional group](#install-an-optional-group)
- [Force a system](#force-a-system)
- [Inspect a file](#inspect-a-file)
- [Hash a file](#hash-a-file)
- [Hash the ROM inside an archive](#hash-the-rom-inside-an-archive)
- [Hash part of a file](#hash-part-of-a-file)
- [Read from a pipeline](#read-from-a-pipeline)
- [Get machine-readable output](#get-machine-readable-output)
- [Related](#related)

<!-- END doctoc -->

## Identify a ROM title

```bash
rom-weaver identify --input game.nes
```

The command checks the packaged Libretro data and OpenGood fallback data. It also checks common header, trim, and byte-order variants.

Point it at an archive to identify the ROM inside:

```bash
rom-weaver identify --input games.zip
```

Use `--select` when the archive holds more than one candidate.

Use a locally built pack instead of the built-in data:

```bash
rom-weaver identify --input game.iso --database playstation.pack
```

Repeat `--database` to search more packs. `--database` accepts RWFP1, RWFP2, and RWFP3 packs.

## Install the default identify data

Release packages include the default local database. After a Cargo or binary-only install, install the same versioned archive:

```bash
rom-weaver identify database install-all
```

Then identify as usual; the command finds the installed pack on its own:

```bash
rom-weaver identify --input game.bin
```

Check what is installed with `rom-weaver identify database list`. A result with `"condition": "database_required"` means the detected platform's pack is not installed. Its `hint` names the install command.

## Install an optional group

Choose `optional-arcade`, `optional-engines`, `optional-mobile`, or `optional-extended`.

Install one group:

```bash
rom-weaver identify database install-group optional-extended
```

Use `--from ARCHIVE` to import a downloaded group archive without network access.

## Force a system

Search one system's pack only, by canonical name or alias:

```bash
rom-weaver identify --input dump.bin --system psx
```

Use it when detection picks the wrong platform, or when a headerless dump detects nothing. `rom-weaver identify database list` prints the accepted names.

## Inspect a file

```bash
rom-weaver probe --input game.iso
```

`probe` reports the detected format, platform, and copier header. It also answers to `rom-weaver inspect`.

Point it at an archive and it looks inside:

```bash
rom-weaver probe --input games.zip
```

`--select` picks one member by name, prefix, or glob. `--no-extract` treats the archive itself as the file to identify.

## Hash a file

```bash
rom-weaver checksum --input game.sfc --algo sha256
```

`--algo` is repeatable and comma-separable, so one read produces several hashes:

```bash
rom-weaver checksum --input game.sfc --algo crc32,md5,sha1
```

## Hash the ROM inside an archive

```bash
rom-weaver checksum --input game.zip --select 'game*.sfc' --algo crc32
```

This is the checksum a patch author usually means: the ROM's bytes, not the archive's.

## Hash part of a file

Skip a copier header, or hash only the region a patch touches, with a byte range. `rom-weaver checksum --help` lists the range flags for your version.

## Read from a pipeline

`identify`, `probe`, and `checksum` accept `-` as the input. Thus, they can read stdin:

```bash
curl -sL https://example.com/game.gba | rom-weaver checksum --input - --algo sha256
xz -dc game.iso.xz | rom-weaver probe --input - --json
```

## Get machine-readable output

Add `--json` to a command for one JSON object per line:

```bash
rom-weaver probe --input game.sfc --json | jq
```

JSON mode turns off interactive selection, so scripts never block on a prompt.

## Related

- [CLI reference](../reference/cli.md): every flag, exit code, and the JSON contract.
- [Checksum support](../reference/formats.md#checksum-support): the algorithms `--algo` accepts.
- [Fix a checksum error](fix-checksum-errors.md): what to do when a hash does not match.
