# How to apply an IPS patch to a ROM online

Apply an IPS patch to a ROM online with rom-weaver's [Apply](https://rom-weaver.com/apply-rom-patches) page. An IPS patch cannot tell which ROM it expects, so check the ROM first. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Apply the IPS patch](#apply-the-ips-patch)
- [Check the ROM yourself](#check-the-rom-yourself)
- [Headers and IPS patches](#headers-and-ips-patches)
- [IPS32 and large ROMs](#ips32-and-large-roms)
- [Test the patched ROM](#test-the-patched-rom)
- [Related](#related)

<!-- END doctoc -->

## What do you need?

- The `.ips` or `.ips32` patch. It holds only changes, not the game.
- Your own copy of the ROM the patch author names.
- The author's notes: region, revision, header state, and a checksum when they give one.

A ZIP or 7z that holds either file works as it is.

## Apply the IPS patch

1. Open [Apply](https://rom-weaver.com/apply-rom-patches).
2. Drop the ROM and the `.ips` file into **0x01 Inputs**, or choose **Add files**.
3. Wait for **Checksumming** to finish.
4. [Check the ROM yourself](#check-the-rom-yourself). The patch card's **Checks** line shows **IPS** and a check mark for any ROM.
5. Choose **APPLY & DOWNLOAD** and save the patched ROM.

The download is named after the ROM and the patch, such as `game [hack].sfc`. Your original ROM stays unchanged. [Choose the output and apply](apply-rom-patches.md#choose-the-output-and-apply) covers the filename, ZIP or 7z output, and other options.

## Check the ROM yourself

An IPS patch stores no checksum of the ROM, the result, or itself. Apply patches a wrong ROM without a warning. A finished download does not prove the ROM was right.

When the author gives a CRC32, MD5, or SHA-1, let Apply compare it:

1. Open **Checks** on the patch card.
2. Next to **Input**, open **Add** and choose the checksum type.
3. Paste the author's value and press Enter.

The right ROM shows **Matches the ROM**. A wrong ROM shows **Checks failed** and blocks **APPLY & DOWNLOAD**. [Fix a source ROM checksum mismatch](fix-checksum-errors.md) lists the causes; a fresh ROM dropped into **0x01 Inputs** replaces the wrong one.

When the author gives no checksum, match the region and revision by their notes. Then [test the result](#test-the-patched-rom) before you rely on it.

## Headers and IPS patches

Some cartridge dumps start with a copier header, often 512 bytes. It shifts every position an IPS patch writes to.

rom-weaver reads the patch for hints about which form it expects. A hint is not proof. Keep the automatic choice unless the author says otherwise; [Cartridge header differences](fix-checksum-errors.md#cartridge-header-differences) covers the controls.

## IPS32 and large ROMs

An IPS patch cannot start a change at or beyond 16 MiB. Patches for larger files use IPS32, with the `.ips32` extension. The steps above apply to both.

## Test the patched ROM

After Apply finishes, choose **Open in the Test tab** to play the result in the browser. [Test an Apply result](test-roms-in-browser.md#test-an-apply-result) explains what that test does and does not prove.

## Related

- [Apply multiple patches in order](apply-rom-patches.md#apply-multiple-patches-in-order): hacks that ship several patches.
- [Convert IPS to BPS](convert-patch-format-browser.md): add checksums to a patch you publish.
- [Create a ROM patch](create-rom-patches.md): publish your own IPS.
- [IPS and other formats compared](../explanation/patch-formats.md#ips-and-ips32): why IPS has no checks.
- [Apply patches with the CLI](cli-apply.md): the same work from a terminal.
- Other formats: [BPS](apply-bps-patch-browser.md), [UPS](apply-ups-patch-browser.md), [xdelta](apply-xdelta-patch-browser.md), and [the rest](apply-rom-patches.md).
