# Identify and hash files from the CLI

Find out what a file is with `rom-weaver probe`, and prove which bytes it holds with `rom-weaver checksum`.

<!-- START doctoc -->
## Table of contents

- [Identify a file](#identify-a-file)
- [Hash a file](#hash-a-file)
- [Hash the ROM inside an archive](#hash-the-rom-inside-an-archive)
- [Hash part of a file](#hash-part-of-a-file)
- [Read from a pipeline](#read-from-a-pipeline)
- [Get machine-readable output](#get-machine-readable-output)
- [Related](#related)

<!-- END doctoc -->

## Identify a file

```bash
rom-weaver probe --input game.iso
```

`probe` reports the detected format, the platform, and any copier header the file carries. It also answers to `rom-weaver inspect`.

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

`probe` and `checksum` accept `-` as the input, so they can read stdin:

```bash
curl -sL https://example.com/game.gba | rom-weaver checksum --input - --algo sha256
xz -dc game.iso.xz | rom-weaver probe --input - --json
```

## Get machine-readable output

Add `--json` to either command for one JSON object per line:

```bash
rom-weaver probe --input game.sfc --json | jq
```

JSON mode turns off interactive selection, so scripts never block on a prompt.

## Related

- [CLI reference](../reference/cli.md): every flag, exit code, and the JSON contract.
- [Checksum support](../reference/formats.md#checksum-support): the algorithms `--algo` accepts.
- [Fix a checksum error](fix-checksum-errors.md): what to do when a hash does not match.
