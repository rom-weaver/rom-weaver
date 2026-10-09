# Weaves from the CLI

Create, inspect, and apply repeatable patch recipes from the terminal.

<a id="bundles-from-the-cli"></a>

<!-- START doctoc -->
## Table of contents

- [Create a weave from local files](#create-a-weave-from-local-files)
- [Include cheats in the weave](#include-cheats-in-the-weave)
- [Author a spec instead of flags](#author-a-spec-instead-of-flags)
- [Parse and run a weave](#parse-and-run-a-weave)

<!-- END doctoc -->


[What a weave is](../explanation/bundles.md) explains the format. The [weave reference](../reference/cli.md#bundles) lists metadata flags and schema behavior. For browser controls, use [Create and share a patch weave](create-bundles.md).

<a id="create-a-bundle-from-local-files"></a>

## Create a weave from local files

The checks are computed from the real bytes:

```bash
rom-weaver weave create \
  --input original.sfc \
  --patch translation.bps \
  --patch fixes.ips \
  --output rom-weaver-weave.json
```

To distribute the recipe and patches together, add an archive output and exclude the ROM:

```bash
rom-weaver weave create -i original.sfc --patch translation.bps \
  --output rom-weaver-weave.json --weave release.zip --no-weave-rom
```

This records the expected ROM's checksums without including its bytes. For optional patches or release metadata, each `--patch-*` option describes the preceding `--patch`.

<a id="include-cheats-in-the-bundle"></a>

## Include cheats in the weave

Add `--cheat` to record the selection beside the patches, so another machine rebuilds the same cheated ROM:

```bash
rom-weaver weave create \
  --input original.nes \
  --patch fixes.ips \
  --cheat "Infinite lives" \
  --cheat "Start with 9 keys" \
  --output rom-weaver-weave.json
```

Applying the weave bakes those cheats into the output:

```bash
rom-weaver patch apply -i original.nes --weave rom-weaver-weave.json -o patched.nes
```

To run the same weave without its cheats, add `--without-cheats`.

Each entry is looked up in the cheat database, so install it first with `rom-weaver setup`. An entry still applies without the database, from the code the weave recorded. Mark an entry `"optional": true` when the apply should skip it instead of failing.

## Author a spec instead of flags

Write a spec with local paths and optional checksums. Add `$schema` for editor validation. Then use `weave create --from` to hash its files:

```json
{
  "$schema": "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-weave-v2.schema.json",
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
rom-weaver weave create --from spec.json --output rom-weaver-weave.json
```

`--from -` reads the spec from stdin, in which case paths resolve against the current directory; otherwise they resolve against the spec file. Any flag you also pass overrides what the spec says, and a `$schema` already in the spec is kept. A ROM entry may use a local `path` or a `url`. A checks-only ROM entry is rejected. Patch entries need local paths unless explicit `--patch` flags replace the spec's patch list.

<a id="parse-and-run-a-bundle"></a>

## Parse and run a weave

Inspect the recipe, then apply it with your matching ROM:

```bash
rom-weaver weave parse --input release.zip
rom-weaver patch apply -i original.sfc --weave release.zip -o translated.sfc
```

Add `--output extracted` to `weave parse` to extract packaged files. Use `--with ID` and `--without ID` on apply to change the selected optional patches. Test each combination you publish from the documented Original.
