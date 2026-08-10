# Create patches from the CLI

Build a patch from an original ROM and a modified one, add SOLID metadata, and test the result before publishing it. New to the CLI? Start with [your first apply](../tutorials/cli-first-weave.md).

<!-- START doctoc -->
## Table of contents

- [Create a patch](#create-a-patch)
- [Test what you built](#test-what-you-built)
- [Where next](#where-next)

<!-- END doctoc -->

## Create a patch

Build a patch from an original ROM and a changed one:

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --format bps \
  --output release.bps
```

SOLID patches carry their own metadata. `--solid-system`, `--solid-game`, and `--solid-hack` fill in its three-string header. Adding any of `--solid-version`, `--solid-author`, `--solid-contact`, or `--solid-comment` switches to the seven-string extended header; `--solid-extended` selects that header with the extra fields left empty. These flags need SOLID output and cannot be combined with `--plan`.

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

## Test what you built

Never publish an untested patch. Apply it back onto a clean copy of the original and checksum the result, as the [practice walkthrough](../tutorials/cli-first-weave.md#practice-patch-creation-and-bundles) shows end to end, or run `patch validate` for a check that writes nothing; its flags are covered in the [CLI reference](../reference/cli.md#validation).

## Where next

- Unsure which format to publish in? [Pick a patch format](../explanation/patch-formats.md).
- Ship several patches with checksums and ordering as one file: [Bundles from the CLI](cli-bundles.md).
- Run `rom-weaver patch create --help` for every flag; the [CLI reference](../reference/cli.md) covers shared behavior.
