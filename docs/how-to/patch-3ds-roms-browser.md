# How to patch a 3DS ROM online

Patch a Nintendo 3DS ROM online with rom-weaver's [Apply](https://rom-weaver.com/apply-rom-patches) page. Apply unpacks a Z3DS file for you and can save the patched ROM compressed again. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Patch the ROM](#patch-the-rom)
- [Check the ROM first](#check-the-rom-first)
- [Related](#related)

<!-- END doctoc -->

## What do you need?

- The patch file, such as `.xdelta`, `.bps`, or `.ips`. [Patch formats](../reference/formats.md#patch-formats) lists every format Apply reads.
- Your own dump of the game the author names, with the same region and revision.
- The ROM as `.3ds` or `.cci`, or compressed as `.z3ds` or `.zcci`. A ZIP or 7z that holds it works as it is.

A LayeredFS mod, a folder of replacement game files, is not a patch file. Apply cannot use it.

## Patch the ROM

1. Open [Apply](https://rom-weaver.com/apply-rom-patches).
2. Drop the ROM and the patch into **0x01 Inputs**, or choose **Add files**.
3. Wait for **Reading** and **Checksumming**.
4. Read the patch card's **Checks** line.
5. In **Apply**, the format selector starts on a compressed Z3DS format, such as **.zcci**. Pick **.3ds** or **.cci** to keep a raw file instead.
6. Choose **APPLY & DOWNLOAD** and save the result.

Your original ROM stays unchanged.

## Check the ROM first

A BPS or UPS patch made for a decrypted ROM fails on an encrypted copy. The reverse also fails. rom-weaver does not decrypt or encrypt 3DS ROMs, so use the form the author names.

Compare the author's checksum with the ROM, not the Z3DS, ZIP, or 7z around it. On a mismatch, [Fix a source ROM checksum mismatch](fix-checksum-errors.md) lists the causes.

## Related

- [Compress 3DS ROMs to Z3DS](convert-to-z3ds-browser.md): compress a ROM without patching it.
- [Extract Z3DS files](extract-z3ds-browser.md): unpack a Z3DS file for another tool.
- [Apply an xdelta patch](apply-xdelta-patch-browser.md): what an xdelta patch checks.
- [Apply patches with the CLI](cli-apply.md): the same work from a terminal.
