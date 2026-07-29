# Create a ROM patch

You changed a game and want to share the change. This guide turns your before
and after files into a patch other people can apply to their own copy.

<!-- START doctoc -->
## Table of contents

- [How making a patch works](#how-making-a-patch-works)
- [Practice on the sample first](#practice-on-the-sample-first)
- [Get your two files ready](#get-your-two-files-ready)
- [Create a patch in the browser](#create-a-patch-in-the-browser)
- [Create a patch in a terminal](#create-a-patch-in-a-terminal)
- [Pick a format people can check](#pick-a-format-people-can-check)
- [Test the patch, not your copy](#test-the-patch-not-your-copy)
- [Tell people what they need](#tell-people-what-they-need)
- [Releasing an update](#releasing-an-update)

<!-- END doctoc -->

## How making a patch works

rom-weaver compares two files and writes down the differences. You supply the
clean original and your finished version. It produces a small patch file
holding only what changed.

Because the patch holds differences and not the game, you can share it. Anyone
with the same clean original can rebuild your exact file from it. Anyone with
a different original cannot, which is why the rest of this guide keeps
insisting you write down which original you used.

## Practice on the sample first

No pair of files handy? Open
[guided Create](https://rom-weaver.com/create?guide=create). It loads two tiny
practice ROMs, then walks through the original, modified, file picker, and
output controls.

Want the files without the guide? Choose **Download the sample ROMs** on that
page, or [download `first-create.zip`](https://rom-weaver.com/first-create.zip)
directly. Extract the pair before using the CLI:

```bash
curl --fail --location --output first-create.zip \
  https://rom-weaver.com/first-create.zip
unzip first-create.zip
rom-weaver patch create \
  --original hello-world.nes \
  --modified modified-world.nes \
  --output first.bps
```

Now prove the patch works by applying it to a fresh copy of the original and
comparing the result with the file you started from:

```bash
rom-weaver weave \
  --input hello-world.nes \
  --patch first.bps \
  --output rebuilt.nes \
  --no-compress
cmp rebuilt.nes modified-world.nes && echo "identical"
```

`cmp` prints nothing when two files match, so `identical` means your patch
rebuilt the file byte for byte. On Windows, expand the archive and use
`fc /b rebuilt.nes modified-world.nes` for the same check.

## Get your two files ready

Two clearly named files:

- **Original** is the clean, untouched game. Whatever region and revision you
  put here is what your release will require, so choose deliberately.
- **Modified** is your finished work: the translation, the restoration, the
  bug fix, the hack.

Play the modified file and be happy with it before you make a patch. Strip out
temporary save data, debug edits, and anything unrelated. Write down the
checksum of both files so you can reproduce this release later.

If either file lives inside a zip, pull it out first. Comparing two archives
is not the same as comparing the files inside them, and it will produce a
patch nobody can use.

## Create a patch in the browser

1. Open the [Create page](https://rom-weaver.com/create).
2. Pick the clean file as **Original**.
3. Pick your finished file as **Modified**.
4. Look over what rom-weaver detected: system, file sizes, headers, checksums.
5. Choose a patch format from the ones offered for your files.
6. Create the patch and download it.
7. Apply that downloaded patch to a fresh copy of the original and check the
   result matches your modified file.

Step 7 is not optional. See [Test the patch, not your
copy](#test-the-patch-not-your-copy) below.

Your original, your modified file, and the patch all stay on your device.

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

## Create a patch in a terminal

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --format bps \
  --output release.bps
```

The output extension already names the format, so this shorter version does
the same thing:

```bash
rom-weaver patch create \
  --original original.gba \
  --modified modified.gba \
  --output release.bps
```

`rom-weaver patch create --help` lists the rest: per-format metadata, planning,
compression, and validation options.

## Pick a format people can check

BPS is a good default for cartridge games. It stores a checksum of the
original, of the finished file, and of the patch itself, so a patcher can
refuse the wrong starting file instead of quietly producing garbage. Your
users get a clear error rather than a broken game.

IPS is older and works with almost every patcher ever written, which is
sometimes what you need. It stores no checksum of the original at all, so
publish the expected checksums next to the download.

xdelta and VCDIFF suit large files and disc images. PPF is long established
for discs. If a game's community already expects one format, use that format;
compatibility beats theory.

[Pick a patch format](patch-formats.md) compares them properly and links to
the full table of what rom-weaver supports.

## Test the patch, not your copy

Your modified file working proves nothing about the patch. Test what people
will actually download:

1. Take a fresh copy of the original you documented.
2. Apply the downloaded patch using the instructions you plan to publish.
3. Work out the checksum of the result.
4. Confirm it matches your modified file byte for byte.
5. Launch that rebuilt file in the emulator or on the hardware you support.
6. Repeat for every combination of optional patches you claim to support.

A matching checksum proves the patch rebuilt your file. Actually launching it
proves something different: that your modified file was sound to begin with.
Both are worth knowing, and they fail in different ways.

## Tell people what they need

Ship these details with every release:

- patch name and version;
- game title, region, and revision;
- whether the original needs its header, and for discs, the image layout;
- checksum of the original, and which algorithm it is;
- checksum of the finished file, and which algorithm it is;
- patch format, and a link to a patcher that handles it;
- what order to apply things in, and which optional patches work together;
- credits, changelog, and where to report problems.

For a release made of several patches, ship a rom-weaver bundle. It records
the order, which patches are optional, the checksums, and the output name, so
your users do not have to get any of that right by hand. The
[bundle creation guide](create-bundles.md) walks through both the Weave webapp
and CLI. The [CLI guide](../cli.md#bundles) documents every flag and the file
format.

## Releasing an update

Build every release from the same documented clean original and your new
finished file. Do not build version 2 by comparing version 1's patched result
against version 2.

That produces an incremental patch: it only works for people who already
installed version 1, in the right order, with nothing else applied. Sometimes
that is what you want, and if so, say so loudly. Otherwise a full patch from
the clean original is easier to explain, easier to check, and easier for
someone to reproduce years from now.

Not sure which format to publish in? Read
[Pick a patch format](patch-formats.md). Back to the
[guide index](README.md).
