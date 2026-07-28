# Apply ROM patches with rom-weaver

Use rom-weaver to combine a clean base ROM or disc image with one or more patch
files. The browser app is the quickest interactive path; the CLI is useful for
repeatable commands and automation.

<!-- START doctoc -->
## Table of contents

- [What you need](#what-you-need)
- [Apply a patch in the webapp](#apply-a-patch-in-the-webapp)
- [Apply a patch with the CLI](#apply-a-patch-with-the-cli)
- [Validate before writing an output](#validate-before-writing-an-output)
- [Work with patch bundles](#work-with-patch-bundles)
- [When the patch does not match](#when-the-patch-does-not-match)

<!-- END doctoc -->

## What you need

You need the patch file and the exact base file expected by its author. Keep
the release notes nearby. They should identify the game region and revision,
and may also specify a copier-header state, disc-image layout, or checksum.

Do not rely on the filename alone. A USA release and a Japanese release can
share a similar name while containing different bytes. Even two files for the
same region can be different revisions.

Keep a clean original and write the patched result to a new file. That one
habit makes updates, optional patches, and troubleshooting much easier.

## Apply a patch in the webapp

1. Open the [rom-weaver Weave workflow](https://rom-weaver.com/weave).
2. Add the clean ROM or disc image.
3. Add the patch file. You can drop the files onto the page or use the file
   pickers.
4. Review the detected formats, checksums, header handling, and warnings.
5. If you added several patches, arrange them in the order specified by the
   release.
6. Run the weave.
7. Download the result under a new name and test it in the intended emulator
   or device workflow.

Files are processed locally in the browser. rom-weaver does not upload the ROM,
patches, or output to a server.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" srcset="/docs/screenshots/weave-mobile-light.png">
    <img src="/docs/screenshots/weave-desktop-light.png" alt="The Weave workflow filled with the first-weave sample ROM and patch" loading="lazy" decoding="async">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" srcset="/docs/screenshots/weave-mobile-dark.png">
    <img src="/docs/screenshots/weave-desktop-dark.png" alt="The Weave workflow filled with the first-weave sample ROM and patch" loading="lazy" decoding="async">
  </picture>
  <figcaption>The docs build captures this filled workflow from the bundled <code>first-weave.zip</code> sample.</figcaption>
</figure>

Supported archives can be opened for you. If an archive contains several
possible ROMs or patches, rom-weaver asks which entry to use. Selecting a file
with a familiar name is still not a substitute for matching the expected
checksum.

## Apply a patch with the CLI

For one patch:

```bash
rom-weaver weave \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --no-compress
```

`weave` is the short name for `patch apply`; both commands use the same
workflow. The result is compressed by default when the output extension names
a supported archive. Use `--no-compress` when you want a plain ROM.

Repeat `--patch` to apply several patches in order:

```bash
rom-weaver weave \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups \
  --output patched.zip
```

Each patch receives the output of the previous patch. A translation, bug-fix,
restoration, and optional quality-of-life patch may all target different stages
of the chain, so their order is part of the release.

Run `rom-weaver weave --help` for the full set of checksum, header, byte-order,
archive-selection, compression, and bundle options.

## Validate before writing an output

The CLI can parse a patch and verify the checks it carries without writing a
result:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch translation.bps
```

For formats or releases with a published checksum, add an explicit expectation:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch translation.bps \
  --expect-in sha256=EXPECTED_HEX_VALUE
```

Use the algorithm named by the release. A CRC32 value cannot be compared with
SHA-1 or SHA-256.

## Work with patch bundles

A `rom-weaver-bundle.json` can describe the input, ordered patches, expected
checksums, optional selections, and output name. A bundle records the workflow;
it does not need to include the copyrighted base ROM.

Apply a local or remote bundle with:

```bash
rom-weaver weave --bundle rom-weaver-bundle.json
```

In the webapp, open a bundle like any other supported input. Review optional
patches before running it.

## When the patch does not match

Stop at a source-checksum warning instead of repeatedly forcing the patch.
Confirm the region, revision, header state, byte order, selected archive entry,
and patch order. The [checksum troubleshooting guide](fix-checksum-errors.md)
walks through those checks in a useful order.

Ignoring validation can produce a file that downloads successfully but fails
later in an emulator or during gameplay. A clean source and a documented patch
chain are faster than trial and error.
