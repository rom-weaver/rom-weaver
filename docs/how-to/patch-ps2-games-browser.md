# How to patch a PS2 ISO online

Patch a PlayStation 2 (PS2) disc online with rom-weaver's [Apply](https://rom-weaver.com/apply-rom-patches) page. Apply unpacks a CHD for you and can save the patched disc as CHD again. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Patch the disc](#patch-the-disc)
- [Check the disc first](#check-the-disc-first)
- [Related](#related)

<!-- END doctoc -->

## What do you need?

- The patch file, such as `.xdelta` or `.ppf`. [Patch formats](../reference/formats.md#patch-formats) lists every format Apply reads.
- Your own dump of the disc the author names, with the same region and revision.
- The disc as an `.iso`, a `.cue` with every `.bin` track, or a `.chd`. A ZIP or 7z that holds it works as it is.

## Patch the disc

1. Open [Apply](https://rom-weaver.com/apply-rom-patches).
2. Drop the disc files and the patch into **0x01 Inputs**, or choose **Add files**.
3. Wait for **Reading** and **Checksumming**. Apply may ask which file to use from a CHD or archive. Choose the one the author names.
4. Read the patch card's **Checks** line. For an xdelta patch, [Check the source file](apply-xdelta-patch-browser.md#check-the-source-file) explains what it can catch.
5. In **Apply**, the format selector starts on **.chd**. Pick **.iso** to keep a raw image instead.
6. Choose **APPLY & DOWNLOAD** and save the result.

Your original disc stays unchanged. Check that your emulator reads CHD before you keep only the CHD.

## Check the disc first

Compare the author's checksum with the ISO or track. Do not compare it with the CHD, ZIP, or 7z around it. Open **Checks** on the ROM card to see the image's checksums.

On a mismatch, [Fix a source ROM checksum mismatch](fix-checksum-errors.md) lists the causes.

A PS2 DVD can be several gigabytes. It needs free memory and storage; [browser limits](../explanation/local-first.md#what-this-costs-you) gives the details.

## Related

- [Apply an xdelta patch](apply-xdelta-patch-browser.md): what an xdelta patch checks.
- [Undo a PPF patch](undo-ppf-browser.md): restore a disc a PPF patch changed.
- [Patch a compressed CHD disc](../tutorials/patch-compressed-disc.md): practice on a supplied disc.
- [Apply patches with the CLI](cli-apply.md): the same work from a terminal, without browser limits.
