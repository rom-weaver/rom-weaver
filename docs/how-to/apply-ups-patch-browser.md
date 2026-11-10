# How to apply a UPS patch to a ROM online

Apply a UPS patch to a ROM online with rom-weaver's [Apply](https://rom-weaver.com/apply-rom-patches) page. It checks that your ROM is the one the patch expects. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Apply the UPS patch](#apply-the-ups-patch)
- [What a UPS patch checks](#what-a-ups-patch-checks)
- [If the checks fail](#if-the-checks-fail)
- [Test the patched ROM](#test-the-patched-rom)
- [Related](#related)

<!-- END doctoc -->

## What do you need?

- The `.ups` patch. It holds only changes, not the game.
- Your own copy of the ROM the patch author names, with the same region and revision.

A ZIP or 7z that holds either file works as it is.

## Apply the UPS patch

1. Open [Apply](https://rom-weaver.com/apply-rom-patches).
2. Drop the ROM and the `.ups` file into **0x01 Inputs**, or choose **Add files**.
3. Wait for **Checksumming** to finish.
4. Read the **Checks** line on the patch card. It should show **UPS** and **Verified**.
5. Choose **APPLY & DOWNLOAD** and save the patched ROM.

The download is named after the ROM and the patch, such as `game [hack].gba`. Your original ROM stays unchanged. [Choose the output and apply](apply-rom-patches.md#choose-the-output-and-apply) covers the filename, ZIP or 7z output, and other options.

## What a UPS patch checks

A UPS patch stores three CRC32 checksums, and Apply compares each one for you.

| Stored checksum | What a match proves |
| --- | --- |
| Patch file | The `.ups` file is complete and undamaged |
| Input ROM, with its size | Your ROM is the one the author patched |
| Patched ROM, with its size | The result is the one the author made |

Open the patch card's **Checks** to see the values. **Input** lists the values your ROM matched and **Patch result** lists the values of the file you will get.

A UPS patch also matches the ROM it produces. With an already patched copy, **Checks** still shows **Verified**, and applying gives back the original ROM. Compare **Patch result** with the author's checksum when you are unsure which copy you have.

## If the checks fail

With the wrong ROM, the patch card shows **Checks failed** and **Input checks do not match the ROM**. **APPLY & DOWNLOAD** is blocked.

Open the ROM card's **Checks** to compare the values. **Computed** is your ROM, and **Expected** is what the patch wants.

The usual causes are the wrong region or revision, or a ROM changed by another patch. Find the ROM with the expected CRC32 and drop it into **0x01 Inputs**; it replaces the wrong one. [Fix a source ROM checksum mismatch](fix-checksum-errors.md) covers each cause in order.

**Apply anyway despite patch and ROM check mismatch** skips the check. It does not repair the ROM, so the result may not work.

If the card shows **Patch file is damaged**, download the patch again. Then open the card's **Patch actions** menu and choose **Replace patch**. Apply cannot check the ROM against a damaged patch.

## Test the patched ROM

After Apply finishes, choose **Open in the Test tab** to play the result in the browser. [Test an Apply result](test-roms-in-browser.md#test-an-apply-result) explains what that test does and does not prove.

## Related

- [Apply multiple patches in order](apply-rom-patches.md#apply-multiple-patches-in-order): hacks that ship several patches.
- [Convert a patch to another format](convert-patch-format-browser.md): when another tool needs BPS or IPS.
- [Create a ROM patch](create-rom-patches.md): publish your own UPS.
- [UPS and other formats compared](../explanation/patch-formats.md#ups): what UPS records.
- [Apply patches with the CLI](cli-apply.md): the same work from a terminal.
- Other formats: [BPS](apply-bps-patch-browser.md), [IPS](apply-ips-patch-browser.md), [xdelta](apply-xdelta-patch-browser.md), and [the rest](apply-rom-patches.md).
