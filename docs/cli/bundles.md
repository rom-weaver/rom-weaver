# Bundles from the CLI

A `rom-weaver-bundle.json` bundle turns a tested patch job into a repeatable
recipe: ordered patches, expected checksums, and output naming that any
rom-weaver interface can run. This guide covers creating, inspecting, and
running bundles from the terminal.

<!-- START doctoc -->
## Table of contents

- [Create a bundle from local files](#create-a-bundle-from-local-files)
- [Author a spec instead of flags](#author-a-spec-instead-of-flags)
- [Parse and run a bundle](#parse-and-run-a-bundle)

<!-- END doctoc -->


A `rom-weaver-bundle.json` bundle describes a distributable patching
workflow: ordered patches, expected input and output checksums, and output
naming. The machine-readable schema is
[`rom-weaver-bundle-v1.schema.json`](../rom-weaver-bundle-v1.schema.json); its `$id`
resolves to the public GitHub copy at
`https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json`.
For an end-to-end release workflow in either the Apply webapp or terminal,
start with [Create and share a patch bundle](../usage/create-bundles.md).
Print the current schema to stdout with `bundle schema`, then redirect it to a
file or point an editor at it:

```bash
rom-weaver bundle schema > rom-weaver-bundle-v1.schema.json
```

## Create a bundle from local files

The checks are computed from the real bytes:

```bash
rom-weaver bundle create \
  --input original.sfc \
  --patch translation.bps \
  --patch fixes.ips \
  --output rom-weaver-bundle.json
```

`-i`/`--input` names the ROM. `--rom-name` records the expected logical file
name (and supplies display/output naming); applying a separately supplied ROM
with a different basename warns but continues. Use `--rom-url` when the ROM
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

## Author a spec instead of flags

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

## Parse and run a bundle

`bundle parse --input <bundle>` checks a bundle and reports what it points at.
Add `--output <dir>` to write out the files packed alongside it. For an archive
bundle it also takes `-s`/`--select`, `--filter rom|patch`, and `--no-extract`,
which behave as they do elsewhere. A plain JSON bundle references files by
relative path, so there is nothing for those options to unpack.

To actually run a bundle, use `rom-weaver weave --bundle <path-or-url>`, with
`--with` and `--without` to change which optional patches run.

When `weave` detects a bundle from its positional input, the canonical
`rom-weaver-bundle.json` name is the fast path. It also content-probes valid
plain `.json` files and root-level `.json` members inside archives. A
stream-compressed positional bundle needs a canonical name such as
`rom-weaver-bundle.json.gz`; pass a differently named one explicitly with
`--bundle`.
