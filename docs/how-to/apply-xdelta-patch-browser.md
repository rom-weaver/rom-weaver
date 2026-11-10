# How to apply an xdelta patch to a ROM or disc image

Apply an xdelta patch to a ROM or disc image online with rom-weaver's [Apply](https://rom-weaver.com/apply-rom-patches) page. You do not need to install xdelta. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Apply the xdelta patch](#apply-the-xdelta-patch)
- [Check the source file](#check-the-source-file)
- [Patch a disc image](#patch-a-disc-image)
- [Related](#related)

<!-- END doctoc -->

## What do you need?

- The patch: a `.xdelta`, `.delta`, `.dat`, or `.vcdiff` file. It holds only changes, not the game.
- Your own copy of the exact ROM, disc image, or track the patch author names.
- The author's notes: region, revision, image layout, and a checksum when they give one.

## Apply the xdelta patch

1. Open [Apply](https://rom-weaver.com/apply-rom-patches).
2. Drop the ROM or disc image and the patch into **0x01 Inputs**, or choose **Add files**.
3. Wait for **Checksumming** to finish. If asked, choose the entry the author names.
4. [Check the source file](#check-the-source-file). The patch card's **Checks** line shows **XDELTA** or **VCDIFF**, and **Checked**.
5. Choose **APPLY & DOWNLOAD** and save the result.

The download is named after the source file and the patch, such as `game [hack].bin`. Your original file stays unchanged.

## Check the source file

An xdelta patch has no fixed checksum of the file it expects unless the author used xdelta3's armor option. What it catches depends on how the author made it.

- A patch made with the armor option records a BLAKE3 digest of the source. A wrong source fails with a `checksum mismatch` message, and **APPLY & DOWNLOAD** is blocked.
- A patch with window checksums catches a wrong source. The card shows **Checks failed** with a `checksum mismatch` message, and **APPLY & DOWNLOAD** is blocked.
- A patch with neither applies to a wrong source without a warning.

The card shows **Checked** for the patches without armor, so compare the author's checksum yourself. Add it as an input check on the patch card, as in [Check the ROM yourself](apply-ips-patch-browser.md#check-the-rom-yourself). The card then shows **Verified** for the right file.

After a failed check, [Fix a source ROM checksum mismatch](fix-checksum-errors.md) lists the causes. A fresh file dropped into **0x01 Inputs** replaces the wrong one.

## Patch a disc image

A disc patch fits one exact image layout. Add the files the author names:

- an `.iso` on its own;
- a BIN/CUE disc with its `.cue` and every `.bin` track;
- a CHD, RVZ, ZIP, or 7z as it is, because Apply unpacks it first.

A `.bin` or `.iso` extension does not prove the layout, so compare the author's checksum with the image or track, not with the archive around it.

A disc image's output starts on a compressed disc format, such as **.chd**. [Choose the output and apply](apply-rom-patches.md#choose-the-output-and-apply) explains how to keep raw files instead. Large discs need free memory and storage; [browser limits](../explanation/local-first.md#what-this-costs-you) gives the details.

## Related

- [Patch a compressed CHD disc](../tutorials/patch-compressed-disc.md): practice on a supplied disc.
- [Apply multiple patches in order](apply-rom-patches.md#apply-multiple-patches-in-order): releases that ship several patches.
- [Create a ROM patch](create-rom-patches.md): publish your own xdelta.
- [xdelta and other formats compared](../explanation/patch-formats.md#xdelta-and-vcdiff): what xdelta records.
- [Apply patches with the CLI](cli-apply.md): the same work from a terminal.
- Other formats: [BPS](apply-bps-patch-browser.md), [IPS](apply-ips-patch-browser.md), [UPS](apply-ups-patch-browser.md), and [the rest](apply-rom-patches.md).
