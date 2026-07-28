# Create ROM patches with rom-weaver

Create a patch by comparing the exact original file with the finished modified
file you want users to reproduce. rom-weaver can do this in the browser or from
the command line without packaging the original ROM into the patch.

<!-- START doctoc -->
## Table of contents

- [Try it with the sample](#try-it-with-the-sample)
- [Prepare the two inputs](#prepare-the-two-inputs)
- [Create a patch in the webapp](#create-a-patch-in-the-webapp)
- [Create a patch with the CLI](#create-a-patch-with-the-cli)
- [Choose a format users can validate](#choose-a-format-users-can-validate)
- [Test the artifact users will receive](#test-the-artifact-users-will-receive)
- [Publish enough information](#publish-enough-information)
- [Update an existing patch](#update-an-existing-patch)

<!-- END doctoc -->

## Try it with the sample

If you do not have a pair of files to hand, the project publishes the two
synthetic NES ROMs its own screenshots are built from. They differ only in the
text they display, so the patch you produce is easy to reason about:

```bash
curl --fail --location --output hello-world.nes \
  https://rom-weaver.com/hello-world.nes
curl --fail --location --output modified-world.nes \
  https://rom-weaver.com/modified-world.nes
rom-weaver patch create \
  --original hello-world.nes \
  --modified modified-world.nes \
  --output first.bps
```

Apply `first.bps` back onto `hello-world.nes` and the result should match
`modified-world.nes` byte for byte. In the browser, drop the same two files
into the [Create workflow](https://rom-weaver.com/create) as **Original** and
**Modified**.

## Prepare the two inputs

Keep two clearly named files:

- **Original** is the clean region and revision your release will support.
- **Modified** is the completed translation, restoration, bug fix, or other
  change you intend to distribute.

Launch and test the modified file before creating the patch. Remove temporary
save data, debugging edits, or unrelated changes. Record checksums for both
files so the release can be reproduced later.

If the modified file is inside an archive, extract or select the intended entry.
Do not compare two archives when you mean to compare the files inside them.

## Create a patch in the webapp

1. Open the [rom-weaver Create workflow](https://rom-weaver.com/create).
2. Choose the clean file as **Original**.
3. Choose the finished file as **Modified**.
4. Review the detected systems, sizes, headers, and checksums.
5. Choose a patch format supported for the selected inputs.
6. Create and download the patch.
7. Apply that downloaded patch to a fresh copy of the original and compare the
   result with the modified file.

The original, modified file, and generated patch remain on your device. The
browser app does not upload them.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" srcset="/docs/screenshots/create-mobile-light.png">
    <img src="/docs/screenshots/create-desktop-light.png" alt="The Create workflow filled with the first-create sample assets" loading="lazy" decoding="async">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" srcset="/docs/screenshots/create-mobile-dark.png">
    <img src="/docs/screenshots/create-desktop-dark.png" alt="The Create workflow filled with the first-create sample assets" loading="lazy" decoding="async">
  </picture>
  <figcaption>The docs build captures this filled workflow from the bundled <code>first-create.zip</code> sample.</figcaption>
</figure>

## Create a patch with the CLI

The corresponding command is:

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --format bps \
  --output release.bps
```

The output extension can identify the format, so this shorter form is also
clear:

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --output release.bps
```

Run `rom-weaver patch create --help` to see format-specific metadata, planning,
compression, and validation options.

## Choose a format users can validate

BPS is a practical choice for many modern cartridge-ROM releases because it
stores CRC32 values for the source, target, and patch. That lets a patcher
reject the wrong source and verify the result.

IPS remains useful when compatibility with older patchers is required, but
classic IPS does not identify its source with an embedded checksum. Publish the
expected source and output checksums beside an IPS patch.

xdelta/VCDIFF is common for larger files and disc-image projects. PPF is also
established in disc workflows. Use the format expected by the platform's
community when that compatibility matters. The
[patch format guide](patch-formats.md) explains the trade-offs and links to the
complete rom-weaver support matrix.

## Test the artifact users will receive

Do not stop after confirming that the already-modified ROM launches. Test the
new patch itself:

1. Make a fresh copy of the documented original.
2. Apply the downloaded or written patch using the instructions you plan to
   publish.
3. Calculate the result's checksum.
4. Confirm that it matches the modified file byte for byte.
5. Launch the reproduced result in the intended emulator or hardware workflow.
6. Repeat every optional multi-patch combination you claim to support.

A checksum match proves that the patch recreated your file. Runtime testing
catches a different problem: the modified file itself may still have broken
content or platform-specific behavior.

## Publish enough information

Include these details with every release:

- patch name and version;
- supported game title, region, and revision;
- required copier-header state or disc-image layout;
- original checksum and algorithm;
- expected patched-file checksum and algorithm;
- patch format and a link to a compatible patcher;
- required patch order and optional-patch compatibility;
- credits, changelog, and issue-reporting location.

For a release made from several patches, create a rom-weaver bundle to preserve
their order, required or optional state, checksums, and output naming. The
[CLI guide](../cli.md#bundles) documents bundle creation and the machine-readable
schema.

## Update an existing patch

Create each full release from the same documented clean original and the new
finished output. Do not create version 2 by comparing version 1's patched ROM
with version 2 unless you deliberately want an incremental patch that requires
users to install version 1 first.

A full patch from the clean base is simpler to explain, validate, and reproduce.
