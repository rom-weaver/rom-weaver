# How to patch a GameCube or Wii ISO or RVZ online

Patch a GameCube or Wii disc online with rom-weaver's [Apply](https://rom-weaver.com/apply-rom-patches) page. Apply unpacks an RVZ for you and can save the patched disc as RVZ again. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Patch the disc](#patch-the-disc)
- [Check the disc first](#check-the-disc-first)
- [Related](#related)

<!-- END doctoc -->

## What do you need?

- The patch file, such as `.xdelta` or `.bps`. [Patch formats](../reference/formats.md#patch-formats) lists every format Apply reads.
- Your own dump of the disc the author names, with the same region and revision.
- The disc as `.iso`, `.gcm`, or `.rvz`. A ZIP or 7z that holds it works as it is.

A Riivolution pack or a folder of replacement game files is not a patch file. Apply cannot use it.

## Patch the disc

1. Open [Apply](https://rom-weaver.com/apply-rom-patches).
2. Drop the disc and the patch into **0x01 Inputs**, or choose **Add files**.
3. Wait for **Reading** and **Checksumming**. Apply reads the ISO inside an RVZ.
4. Read the patch card's **Checks** line. For an xdelta patch, [Check the source file](apply-xdelta-patch-browser.md#check-the-source-file) explains what it can catch.
5. In **Apply**, the format selector starts on **.rvz**. Pick **.iso** to keep a raw image instead.
6. Choose **APPLY & DOWNLOAD** and save the result.

Your original disc stays unchanged.

## Check the disc first

Compare the author's checksum with the ISO, not the RVZ, ZIP, or 7z around it. Open **Checks** on the ROM card to see the ISO's checksums.

On a mismatch, [Fix a source ROM checksum mismatch](fix-checksum-errors.md) lists the causes.

A Wii disc can be several gigabytes. It needs free memory and storage; [browser limits](../explanation/local-first.md#what-this-costs-you) gives the details.

## Related

- [Apply an xdelta patch](apply-xdelta-patch-browser.md): what an xdelta patch checks.
- [Compress ISO to RVZ](convert-to-rvz-browser.md): compress a disc without patching it.
- [Convert RVZ to ISO](convert-rvz-to-iso-browser.md): unpack an RVZ for another tool.
- [Apply patches with the CLI](cli-apply.md): the same work from a terminal, without browser limits.
