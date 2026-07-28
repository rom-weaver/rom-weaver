# Apply a ROM patch

Somebody gave you a patch. This guide turns that patch and your own copy of
the game into a new, patched file you can play.

<!-- START doctoc -->
## Table of contents

- [Practice on the sample first](#practice-on-the-sample-first)
- [What you need](#what-you-need)
- [Apply a patch in the browser](#apply-a-patch-in-the-browser)
- [Apply a patch in a terminal](#apply-a-patch-in-a-terminal)
- [Check first, write after](#check-first-write-after)
- [Apply several patches in order](#apply-several-patches-in-order)
- [Open a bundle](#open-a-bundle)
- [When rom-weaver says the file does not match](#when-rom-weaver-says-the-file-does-not-match)

<!-- END doctoc -->

## Practice on the sample first

New to this? Do not start with a game you care about. Open
[guided Apply](https://rom-weaver.com/weave?guide=apply). It loads a tiny
practice ROM and two patches shipped with the project, then walks through the
ROM, patch stack, file picker, and output controls. The first patch changes
`HELLO` to `MODIFIED`; the second changes `WORLD` to `ROM`.

<figure class="docs-screenshot-pair" aria-label="The sample ROM before and after both patches">
  <figure class="docs-screenshot">
    <img src="/docs/screenshots/first-sample-hello-world.png" alt="The original sample ROM displaying HELLO WORLD in an NES emulator" loading="lazy" decoding="async">
    <figcaption>Before: the original practice ROM.</figcaption>
  </figure>
  <figure class="docs-screenshot">
    <img src="/docs/screenshots/first-sample-modified-rom.png" alt="The sample ROM displaying MODIFIED ROM in an NES emulator after both patches" loading="lazy" decoding="async">
    <figcaption>After: the result with both patches applied in order.</figcaption>
  </figure>
</figure>

Want the files without the guide? Choose **Download the bundle** on that page,
or [download `first-weave.zip`](https://rom-weaver.com/first-weave.zip)
directly. It contains the ROM, both patches, and the bundle recipe that puts
them in order.

The same practice run works in a terminal:

```bash
curl --fail --location --output first-weave.zip \
  https://rom-weaver.com/first-weave.zip
rom-weaver weave --input first-weave.zip --output modified-rom.nes --no-compress
rom-weaver checksum --input modified-rom.nes --algo sha256
```

That last command should print
`e0db7cbd02cccd5e83931e7974db94aaafe40327b2a33fdd4c83235c9880a90e`. If it
does, patching works on your machine and you can move on to the real thing.
If rom-weaver is not installed yet, copy an install command from the hosted
[CLI installation guide](../cli.md#install).

## What you need

Two files: the patch, and the exact copy of the game its author built it from.

Keep the author's notes open while you work. They should say which region the
game is from (USA, Japan, Europe), which revision, and often a checksum. A
checksum is a short code worked out from every byte of a file. If two files
have the same checksum they are the same file, whatever they are named.

That last part is the one people get wrong. A filename is a guess. A USA
release and a Japanese release can carry near-identical names and completely
different bytes, and so can two revisions of the same release. The patch cares
about bytes.

One habit saves a lot of grief: keep a clean copy of the original and write
every patched result to a new name. Updates, optional add-ons, and undoing a
mistake all get easy once you can go back to a known-good file.

## Apply a patch in the browser

1. Open the [Weave page](https://rom-weaver.com/weave).
2. Add your clean copy of the game.
3. Add the patch. Drag both onto the page or use the file pickers.
4. Look over what rom-weaver worked out: the formats it recognized, the
   checksums, how it plans to handle headers, and any warnings.
5. Got more than one patch? Put them in the order the author asked for.
6. Run the weave.
7. Download the result under a new name and try it in your emulator or on
   whatever hardware you use.

Everything happens inside your browser. The game, the patch, and the result
are not uploaded anywhere.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" srcset="/docs/screenshots/weave-mobile-light.png">
    <img src="/docs/screenshots/weave-desktop-light.png" alt="The Weave workflow filled with the first-weave sample ROM and two patches" loading="lazy" decoding="async">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" srcset="/docs/screenshots/weave-mobile-dark.png">
    <img src="/docs/screenshots/weave-desktop-dark.png" alt="The Weave workflow filled with the first-weave sample ROM and two patches" loading="lazy" decoding="async">
  </picture>
  <figcaption>The docs build captures this filled workflow from the bundled <code>first-weave.zip</code> sample.</figcaption>
</figure>

If your download is a zip or another archive, hand rom-weaver the archive as
it is. It looks inside. When an archive holds several files that could be the
ROM or the patch, it asks which one you meant. Picking the file with the
likeliest name is still a guess, so check the checksum afterwards.

## Apply a patch in a terminal

One patch:

```bash
rom-weaver weave \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --no-compress
```

`--input` is your clean game, `--patch` is the patch, `--output` is the new
file to write. `weave` is the short name for `patch apply`; the two run the
same thing.

If the output name ends in an archive extension such as `.zip`, rom-weaver
compresses the result for you. `--no-compress` turns that off and writes a
plain ROM.

`rom-weaver weave --help` lists the rest: checksum options, header handling,
byte order, which file to pull out of an archive, compression, and bundles.

## Check first, write after

You can ask rom-weaver to read a patch and run its checks without producing
any file:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch translation.bps
```

Some patch formats carry a checksum of the file they were built from, so this
catches a wrong starting file on its own. Formats that carry nothing need you
to supply the value the author published:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch translation.bps \
  --expect-in sha256=EXPECTED_HEX_VALUE
```

Use the same algorithm the author used. A CRC32 value and a SHA-256 value of
the same file look nothing alike, so comparing across algorithms tells you
nothing.

## Apply several patches in order

Repeat `--patch` once per patch:

```bash
rom-weaver weave \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups \
  --output patched.zip
```

They run left to right, and each one works on the result of the one before.
That is why order is part of the instructions: a translation, a bug fix, and
an optional tweak may each expect a different starting point. Swapping two of
them can fail outright or, worse, appear to succeed.

## Open a bundle

A bundle is a small text file named `rom-weaver-bundle.json` that writes the
whole job down: which game, which patches, in what order, which are optional,
what the checksums should be, and what to call the output. It records the
recipe, not the game, so an author can share it freely.

```bash
rom-weaver weave --bundle rom-weaver-bundle.json
```

In the browser, open a bundle the way you would open any other file. Check any
optional patches before you run it.

## When rom-weaver says the file does not match

Stop. Do not keep forcing it.

The warning means the bytes you handed over are not the bytes the author
built against. Something is off: the region, the revision, the header, the
byte order, which file got picked out of the archive, or the order of the
patches. The [checksum guide](fix-checksum-errors.md) walks those checks in
the order that finds the problem fastest.

Forcing past the warning can still produce a file. It will download fine, and
then crash on the title screen or corrupt itself six hours into the game.
Finding the right starting file is quicker than that.

Once a patch works, hang on to the clean original. The next release will want
it.

Ready to make your own? See [Create a patch](create-rom-patches.md). Back to
the [guide index](README.md).
