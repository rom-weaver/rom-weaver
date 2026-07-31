# Apply a ROM patch in the browser

Use the Apply page to combine your clean ROM with one or more patches. The
original stays untouched and the new file never leaves your device.

<!-- START doctoc -->
## Table of contents

- [Practice with the included sample](#practice-with-the-included-sample)
- [What do you need?](#what-do-you-need)
- [Add the files](#add-the-files)
- [Read the ROM and patch cards](#read-the-rom-and-patch-cards)
- [Put several patches in order](#put-several-patches-in-order)
- [Choose the output and weave](#choose-the-output-and-weave)
- [Open a bundle](#open-a-bundle)
- [If the ROM does not match](#if-the-rom-does-not-match)
- [Use the result safely](#use-the-result-safely)

<!-- END doctoc -->

## Practice with the included sample

Open [guided Apply](https://rom-weaver.com/apply?guide=apply) before using a
game you care about. It loads a tiny homebrew NES ROM and two legal practice
patches. The guide points at the same controls you will use with real files.

Patch 1 changes `HELLO` to `MODIFIED`. Patch 2 changes `WORLD` to `ROM`.
Applying both in order gives `MODIFIED ROM`.
The finished ROM's SHA-256 is
`e0db7cbd02cccd5e83931e7974db94aaafe40327b2a33fdd4c83235c9880a90e`.
That fingerprint lets you confirm your result is exactly the practice result.

<figure class="docs-screenshot-pair" aria-label="The practice ROM before and after both patches">
  <figure class="docs-screenshot">
    <img src="/docs/screenshots/first-sample-hello-world.webp" width="1024" height="768" alt="The original homebrew sample ROM displaying HELLO WORLD in an NES emulator" loading="lazy" decoding="async">
    <figcaption>Before: the clean practice ROM.</figcaption>
  </figure>
  <figure class="docs-screenshot">
    <img src="/docs/screenshots/first-sample-modified-rom.webp" width="1024" height="768" alt="The homebrew sample ROM displaying MODIFIED ROM after both patches" loading="lazy" decoding="async">
    <figcaption>After: both patches applied in order.</figcaption>
  </figure>
</figure>

You can choose **Download a test bundle** from the **New here?** beacon on the
empty Apply page or
[download `first-weave.zip`](https://rom-weaver.com/first-weave.zip). The
archive contains the sample ROM, both IPS patches, and the recipe that puts
them in order.

## What do you need?

You need the patch and your own copy of the exact game release it was made
for. Keep the patch author's notes open. Look for:

- region, such as USA, Japan, or Europe;
- revision, such as Rev 0 or Rev 1;
- a checksum and its algorithm;
- whether the ROM has a header;
- the required order when there is more than one patch.

A filename is only a hint. Two different releases can have similar names.
A checksum is calculated from every byte, so it is the useful proof.

Keep one clean original somewhere safe. rom-weaver writes a separate result,
but a known-good copy makes updates and troubleshooting much easier.

## Add the files

1. Open [Apply](https://rom-weaver.com/apply).
2. Drag the ROM and patch onto **0x01 Add files**, or tap the large picker and
   select them. You may add both at once.
3. Wait while the temporary cards say **Reading** or **Checksumming**.
4. If an archive contains several possible files, choose the entry the patch
   author named.

You can add [supported archives](formats.md), including ZIP, 7z, RAR, and tar,
without extracting them first. rom-weaver looks inside, including inside nested
archives. Disc containers such as CHD and RVZ are unpacked to the form the
patch expects.

The page changes after the files are understood. **0x02 ROM** holds the game,
**0x03 Patches** holds the patch stack, and **0x04 Weave** controls the new
file.

## Read the ROM and patch cards

Start with the labels and warning colors, then open **Checks** if you need the
numbers.

The ROM card shows the selected filename, size, detected system, and
checksums. A message about the expected filename is advice. The name can
differ while the bytes are still correct. A checksum or expected-size failure
is strict and means the bytes do not match.

Each patch card shows its format and position. Open **Checks** to see what that
patch expects at this point in the chain. Open the three-dot **Patch actions**
menu to edit details, replace the file, or remove it. Header controls appear
only for formats and systems where they make sense.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/apply-patches-mobile-light.avif" width="1170" height="2348">
    <source type="image/avif" srcset="/docs/screenshots/apply-patches-desktop-light.avif" width="2242" height="1045">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/apply-patches-mobile-light.webp" width="1170" height="2348">
    <img src="/docs/screenshots/apply-patches-desktop-light.webp" width="2242" height="1045" alt="Cropped Weave patch stack with two ordered practice patches in the light theme">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/apply-patches-mobile-dark.avif" width="1170" height="2348">
    <source type="image/avif" srcset="/docs/screenshots/apply-patches-desktop-dark.avif" width="2242" height="1045">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/apply-patches-mobile-dark.webp" width="1170" height="2348">
    <img src="/docs/screenshots/apply-patches-desktop-dark.webp" width="2242" height="1045" alt="Cropped Weave patch stack with two ordered practice patches in the dark theme">
  </picture>
  <figcaption>The focused patch stack. The site serves a mobile crop on small screens and matches the active theme.</figcaption>
</figure>

## Put several patches in order

Patches run from top to bottom. Patch 2 receives the output of patch 1, not the
clean ROM. Order is part of the release instructions.

Drag a numbered handle to move a patch. With a keyboard, focus the handle and
use its announced controls. The number changes when the card moves.

The On or Off switch temporarily skips a patch. This is useful for optional
add-ons, but only use combinations the author says are compatible. Turning off
a required base patch can make everything below it fail.

After changing order or switches, read the checks again. A valid chain should
show each patch matching the bytes produced by the step before it.

## Choose the output and weave

In **0x04 Weave**:

1. Enter an output filename without an extension.
2. Pick a plain file or a compressed output format. The format selector adds
   the extension.
3. Open **Options** only if you need compression, output header, or bundle
   controls. The defaults are right for most patches.
4. Choose **WEAVE & DOWNLOAD**.
5. Wait for the button to finish, then save the browser download.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/apply-output-mobile-light.avif" width="1170" height="654">
    <source type="image/avif" srcset="/docs/screenshots/apply-output-desktop-light.avif" width="2242" height="560">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/apply-output-mobile-light.webp" width="1170" height="654">
    <img src="/docs/screenshots/apply-output-desktop-light.webp" width="2242" height="560" alt="Cropped Weave output card with filename, format, options, and WEAVE AND DOWNLOAD button in the light theme">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/apply-output-mobile-dark.avif" width="1170" height="654">
    <source type="image/avif" srcset="/docs/screenshots/apply-output-desktop-dark.avif" width="2242" height="560">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/apply-output-mobile-dark.webp" width="1170" height="654">
    <img src="/docs/screenshots/apply-output-desktop-dark.webp" width="2242" height="560" alt="Cropped Weave output card with filename, format, options, and WEAVE AND DOWNLOAD button in the dark theme">
  </picture>
  <figcaption>The output card is shown at readable size instead of shrinking the entire page into one image.</figcaption>
</figure>

Everything happens locally in the browser. The ROM, patches, and result are
not sent to rom-weaver. The [privacy guide](../legal/privacy.md) explains local
browser storage and the small amount of normal site traffic.

## Open a bundle

A rom-weaver bundle is a saved patching recipe. It can include patch files,
their order, optional choices, expected checksums, and output settings. A
public bundle normally does not include the original game.

Add the bundle archive to **0x01 Add files**. If it is patch-only, rom-weaver
shows which ROM it expects. Add your matching ROM. Review optional patch
switches, then use **WEAVE & DOWNLOAD** just as you would for loose files.

A release author can also give you a link that opens the bundle directly in
Weave. The same local checks still happen before anything is written.

Want to publish one? [Create and share a patch bundle](create-bundles.md) has a
separate browser-only guide and its own guided sample.

## If the ROM does not match

Stop and find the difference. Do not turn on an override just to make the red
message disappear.

Check these in order:

1. region and revision;
2. the selected file inside an archive;
3. header state;
4. Nintendo 64 byte order;
5. patch order;
6. whether the ROM was already patched or trimmed.

The [checksum error guide](fix-checksum-errors.md) explains each cause using
the browser cards. A wrong filename by itself can be harmless. A wrong
checksum or size is not.

## Use the result safely

Open the downloaded result in the emulator or hardware you trust. Reaching the
title screen is a useful first check, but play far enough to exercise the
change when you can. Some bad combinations fail later.

Do not delete the clean original. Give the patched result a name that includes
the project and version so you can tell it apart later.

If you need automation or terminal commands, switch to the complete
[CLI usage guide](../hosting/cli.md#common-workflows). If you want to make your own
change, continue with [Create a ROM patch](create-rom-patches.md). Back to the
[browser guide index](README.md).
