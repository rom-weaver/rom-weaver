# Bundles from the CLI

A `rom-weaver-bundle.json` bundle turns a tested patch job into a repeatable recipe: ordered patches, expected checksums, and output naming that any rom-weaver interface can run. This guide covers creating, inspecting, and running bundles from the terminal.

<!-- START doctoc -->
## Table of contents

- [Create a bundle from local files](#create-a-bundle-from-local-files)
- [Include cheats in the bundle](#include-cheats-in-the-bundle)
- [Author a spec instead of flags](#author-a-spec-instead-of-flags)
- [Parse and run a bundle](#parse-and-run-a-bundle)

<!-- END doctoc -->


[What a bundle is](../explanation/bundles.md) explains the format. The [bundle reference](../reference/cli.md#bundles) lists metadata flags and schema behavior. For browser controls, use [Create and share a patch bundle](create-bundles.md).

## Create a bundle from local files

The checks are computed from the real bytes:

```bash
rom-weaver bundle create \
  --input original.sfc \
  --patch translation.bps \
  --patch fixes.ips \
  --output rom-weaver-bundle.json
```

To distribute the recipe and patches together, add an archive output and exclude the ROM:

```bash
rom-weaver bundle create -i original.sfc --patch translation.bps \
  --output rom-weaver-bundle.json --bundle release.zip --no-bundle-rom
```

This records the expected ROM's checksums without including its bytes. For optional patches or release metadata, each `--patch-*` option describes the preceding `--patch`.

## Include cheats in the bundle

Add `--cheat` to record the selection beside the patches, so another machine rebuilds the same cheated ROM:

```bash
rom-weaver bundle create \
  --input original.nes \
  --patch fixes.ips \
  --cheat "Infinite lives" \
  --cheat "Start with 9 keys" \
  --output rom-weaver-bundle.json
```

Applying the bundle bakes those cheats into the output:

```bash
rom-weaver patch apply -i original.nes --bundle rom-weaver-bundle.json -o patched.nes
```

To run the same bundle without its cheats, add `--without-cheats`.

Each entry is looked up in the cheat database, so install it first with `rom-weaver setup`. An entry still applies without the database, from the code the bundle recorded. Mark an entry `"optional": true` when the apply should skip it instead of failing.

## Author a spec instead of flags

Rather than pass every flag, hand-author a `rom-weaver-bundle.json` spec with local `path`s and optional or omitted checksums, add a `$schema` line so your editor validates it, then let `bundle create --from` hash the referenced files and bake the canonical checksummed bundle:

```json
{
  "$schema": "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v2.schema.json",
  "version": 2,
  "patchBasis": "auto",
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

`--from -` reads the spec from stdin, in which case paths resolve against the current directory; otherwise they resolve against the spec file. Any flag you also pass overrides what the spec says, and a `$schema` already in the spec is kept. `--from` only accepts entries with a local `path`; url-only and checks-only entries are rejected with an explanation.

## Parse and run a bundle

Inspect the recipe, then apply it with your matching ROM:

```bash
rom-weaver bundle parse --input release.zip
rom-weaver patch apply -i original.sfc --bundle release.zip -o translated.sfc
```

Add `--output extracted` to `bundle parse` to extract packaged files. Use `--with ID` and `--without ID` on apply to change the selected optional patches. Test each combination you publish from the documented Original.
