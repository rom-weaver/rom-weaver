# Create patches from the CLI

Build a patch from an original ROM and a modified one, and test the result before publishing it. New to the CLI? Start with [your first apply](../tutorials/cli-first-weave.md).

<!-- START doctoc -->
## Table of contents

- [Create a patch](#create-a-patch)
- [Pipe the patch to another program](#pipe-the-patch-to-another-program)
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

For a SOLID patch with game and author metadata:

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

To create a patch from cheat codes instead of a changed ROM, see [Share a cheat as a patch](bake-cheat-codes.md#share-a-cheat-as-a-patch).

## Pipe the patch to another program

Set the patch format explicitly and use `--output -`:

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --format bps --output - | gzip > release.bps.gz
```

The [binary pipeline reference](../reference/cli.md#binary-pipelines) lists storage requirements and incompatible options.

## Test what you built

Apply the created patch to the clean Original, then compare the rebuilt file with Modified:

```bash
rom-weaver patch apply -i original.gba --patch release.bps -o rebuilt.gba
rom-weaver checksum -i rebuilt.gba --algo sha256
rom-weaver checksum -i modified.gba --algo sha256
```

The SHA-256 values must match. Test the rebuilt file in the emulator or hardware you support. `patch validate` checks the values stored in the patch. It cannot compare with a separate Modified file, so keep the reconstruction check above.

## Where next

- Unsure which format to publish in? [Pick a patch format](../explanation/patch-formats.md).
- Ship several patches with checksums and ordering as one file: [Bundles from the CLI](cli-bundles.md).
- Run `rom-weaver patch create --help` for every flag; the [CLI reference](../reference/cli.md) covers shared behavior.
