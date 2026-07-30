# Create a ROM patch in the browser

Give rom-weaver a clean ROM and your edited version. It downloads a patch that
contains the differences, not a copy of the game.

<!-- START doctoc -->
## Table of contents

- [What are Original and Modified?](#what-are-original-and-modified)
- [Practice with the included sample](#practice-with-the-included-sample)
- [Prepare a clean release pair](#prepare-a-clean-release-pair)
- [Add Original and Modified](#add-original-and-modified)
- [Choose a patch format](#choose-a-patch-format)
- [Create and download the patch](#create-and-download-the-patch)
- [Test the downloaded patch](#test-the-downloaded-patch)
- [Write useful release notes](#write-useful-release-notes)
- [Release an update](#release-an-update)

<!-- END doctoc -->

## What are Original and Modified?

Creating a patch is a comparison:

- **Original** is the clean, untouched game.
- **Modified** is your finished translation, fix, restoration, or hack.

rom-weaver records what must change to turn Original into Modified. The
direction matters. Swapping the files creates a patch that undoes your work
instead.

Anyone applying the patch later needs the same Original, byte for byte. That
is why a good release names the region and revision and publishes checksums.

## Practice with the included sample

Open [guided Create](https://rom-weaver.com/create?guide=create). It loads two
tiny homebrew NES ROMs and points to the real Create controls. You can learn
the workflow without using any commercial game data.

The Original displays `HELLO WORLD`. The Modified file displays
`MODIFIED WORLD`. The patch made by the sample only needs to describe the
changed word.

Choose **Download the sample ROMs** on the empty Create page or
[download `first-create.zip`](https://rom-weaver.com/first-create.zip) if you
want to keep the pair. The same files are used for automated browser and CLI
verification in this project.

## Prepare a clean release pair

Finish and test the Modified file before making the patch. Remove accidental
save data, debug edits, temporary text, and any change you do not intend to
ship.

Keep the Original clean. Do not use the result of an earlier patch unless you
are deliberately making an update that requires that earlier release.

Give both files clear names. If they are inside archives, extract them first.
Creating a patch between two ZIP files records archive packaging differences,
not just ROM differences.

Write down the region, revision, and header state now. The Create cards will
show checksums you can copy into the release notes later.

## Add Original and Modified

1. Open [Create](https://rom-weaver.com/create).
2. Drop both files onto **0x01 Add files**, or tap the picker and select them.
   The shorter filename usually becomes Original and the longer one Modified.
3. Check the labels on **0x02 Original** and **0x03 Modified**.
4. If they landed backwards, choose **Swap** between the two cards.
5. Wait until reading and checksum work finishes.

Each card shows the selected file, size, detected system, and checksums. Open
**Checks** to copy a value or to confirm the pair you meant to use.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/create-inputs-mobile-light.avif" width="1170" height="881">
    <source type="image/avif" srcset="/docs/screenshots/create-inputs-desktop-light.avif" width="2242" height="837">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/create-inputs-mobile-light.webp" width="1170" height="881">
    <img src="/docs/screenshots/create-inputs-desktop-light.webp" width="2242" height="837" alt="Cropped Create workflow showing the Original and Modified homebrew sample cards in the light theme">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/create-inputs-mobile-dark.avif" width="1170" height="881">
    <source type="image/avif" srcset="/docs/screenshots/create-inputs-desktop-dark.avif" width="2242" height="837">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/create-inputs-mobile-dark.webp" width="1170" height="881">
    <img src="/docs/screenshots/create-inputs-desktop-dark.webp" width="2242" height="837" alt="Cropped Create workflow showing the Original and Modified homebrew sample cards in the dark theme">
  </picture>
  <figcaption>Original is the clean starting file. Modified is the result your patch must rebuild.</figcaption>
</figure>

If rom-weaver asks you to choose a file from an archive, stop and make sure
you are comparing the ROM entries, not readmes, save files, or different disc
tracks.

## Choose a patch format

In **0x04 Patch**, give the download a useful filename and choose a format.

BPS is a strong default for cartridge games. It stores checksums for the
Original, Modified, and patch, so another patcher can reject the wrong
starting file and verify the result.

Use IPS when compatibility with very old patchers matters. IPS does not store
the Original checksum, so put that checksum prominently in the release notes.

Large files and disc projects often use xdelta, VCDIFF, or PPF. A community's
existing tool support can matter more than a theoretical best choice.

The [patch format guide](patch-formats.md) compares the main choices. The
format list in Create only offers formats rom-weaver can make for the files
you selected.

## Create and download the patch

1. Enter a patch filename without an extension.
2. Select the patch format.
3. Open **Options** only when the chosen format has metadata or compression
   settings you need.
4. Choose **CREATE & DOWNLOAD PATCH**.
5. Save the browser download somewhere separate from your working files.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/create-output-mobile-light.avif" width="1170" height="666">
    <source type="image/avif" srcset="/docs/screenshots/create-output-desktop-light.avif" width="2242" height="568">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/create-output-mobile-light.webp" width="1170" height="666">
    <img src="/docs/screenshots/create-output-desktop-light.webp" width="2242" height="568" alt="Cropped Create output card with patch name, BPS format, options, and CREATE AND DOWNLOAD PATCH button in the light theme">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/create-output-mobile-dark.avif" width="1170" height="666">
    <source type="image/avif" srcset="/docs/screenshots/create-output-desktop-dark.avif" width="2242" height="568">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/create-output-mobile-dark.webp" width="1170" height="666">
    <img src="/docs/screenshots/create-output-desktop-dark.webp" width="2242" height="568" alt="Cropped Create output card with patch name, BPS format, options, and CREATE AND DOWNLOAD PATCH button in the dark theme">
  </picture>
  <figcaption>The focused output card. Mobile readers get a mobile capture and dark mode gets a dark capture.</figcaption>
</figure>

The browser reads both ROMs and creates the patch locally. None of those files
are uploaded.

## Test the downloaded patch

Your Modified file working does not prove the downloaded patch works. Test the
artifact another person will receive:

1. Open a fresh [Apply](https://rom-weaver.com/apply) page.
2. Add a fresh copy of the documented Original.
3. Add the patch you just downloaded.
4. Confirm the card accepts the Original without a checksum warning.
5. Choose **WEAVE & DOWNLOAD**.
6. Compare the result's checksum with the Modified checksum shown on Create.
7. Launch the rebuilt result in the emulator or hardware you support.

A checksum match proves the patch rebuilt Modified byte for byte. Launching
the rebuilt file proves the game itself still works. Do both.

Repeat the test for every supported optional-patch combination. Test from a
clean browser page so loose files or old choices cannot hide a packaging
mistake.

## Write useful release notes

Tell users:

- the game title, region, and revision;
- the Original checksum and algorithm;
- whether a cartridge header is required;
- the disc image layout when applicable;
- the patch format and release version;
- the expected output checksum and algorithm;
- the order for multiple patches;
- which additions are optional and which combinations work;
- what changed, who contributed, and where to report a problem.

Several patches are easier to use as one rom-weaver bundle. It carries the
order, choices, checksums, patch files, and output settings so users do not
have to copy them by hand. Continue with
[Create and share a patch bundle](create-bundles.md).

## Release an update

Create every normal release from the same documented clean Original and the
new Modified file. This gives new users one patch to apply.

Comparing version 1's patched result with version 2 makes an incremental
update. It requires users to install version 1 first and in the exact expected
state. That can be intentional, but say so clearly if you choose it.

For scripts or command-line publishing, use the
[CLI patch creation guide](../hosting/cli.md#common-workflows). Back to the
[browser guide index](README.md).
