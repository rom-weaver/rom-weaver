# How to apply a BPS patch to a ROM online

Apply a BPS patch to a ROM online with rom-weaver's [Apply](https://rom-weaver.com/apply-rom-patches) page. It checks that your ROM is the one the patch expects. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Apply the BPS patch](#apply-the-bps-patch)
- [What a BPS patch checks](#what-a-bps-patch-checks)
- [If the checks fail](#if-the-checks-fail)
- [Test the patched ROM](#test-the-patched-rom)
- [Related](#related)

<!-- END doctoc -->

## What do you need?

- The `.bps` patch. It holds only changes, not the game.
- Your own copy of the ROM the patch author names, with the same region and revision.

A ZIP or 7z that holds either file works as it is.

## Apply the BPS patch

1. Open [Apply](https://rom-weaver.com/apply-rom-patches).
2. Drop the ROM and the `.bps` file into **0x01 Inputs**, or choose **Add files**.
3. Wait for **Checksumming** to finish.
4. Read the **Checks** line on the patch card. It should show **BPS** and a check mark.
5. Choose **APPLY & DOWNLOAD** and save the patched ROM.

The download is named after the ROM and the patch, such as `game [hack].sfc`. Your original ROM stays unchanged. [Choose the output and apply](apply-rom-patches.md#choose-the-output-and-apply) covers the filename, ZIP or 7z output, and other options.

## What a BPS patch checks

A BPS patch stores three CRC32 checksums, and Apply compares each one for you.

| Stored checksum | What a match proves |
| --- | --- |
| Patch file | The `.bps` file is complete and undamaged |
| Source ROM, with its size | Your ROM is the one the author patched |
| Patched ROM, with its size | The result is the one the author made |

Open the patch card's **Checks** to see the values. **Input** lists the source ROM's values and **Patch result** lists the patched ROM's values. The check mark means your ROM matched the input values.

Apply compares the patched ROM last, and stops with an error if it differs.

## If the checks fail

With the wrong ROM, the patch card shows **Checks failed** and **APPLY & DOWNLOAD** is blocked. The message gives the CRC32 the patch expects and the CRC32 of your ROM.

The usual causes are the wrong region or revision, or a copy that is already patched. Find the ROM with the expected CRC32 and drop it into **0x01 Inputs**; it replaces the wrong one. [Fix a source ROM checksum mismatch](fix-checksum-errors.md) covers each cause in order.

**Apply anyway despite patch and ROM check mismatch** skips the check. It does not repair the ROM, so the result may not work.

If the card shows **Patch file is damaged**, download the patch again. Then open the card's **Patch actions** menu and choose **Replace patch**. Apply cannot check the ROM against a damaged patch.

## Test the patched ROM

After Apply finishes, choose **Open in the Test tab** to play the result in the browser. [Test an Apply result](test-roms-in-browser.md#test-an-apply-result) explains what that test does and does not prove.

## Related

- [Apply multiple patches in order](apply-rom-patches.md#apply-multiple-patches-in-order): hacks that ship several patches.
- [Convert BPS to IPS](convert-patch-format-browser.md): when another tool needs a different format.
- [Create a ROM patch](create-rom-patches.md): publish your own BPS.
- [BPS and other formats compared](../explanation/patch-formats.md#bps): why BPS carries checksums.
- [Apply patches with the CLI](cli-apply.md): the same work from a terminal.
- Other formats: [IPS](apply-ips-patch-browser.md), [UPS](apply-ups-patch-browser.md), [xdelta](apply-xdelta-patch-browser.md), and [the rest](apply-rom-patches.md).
