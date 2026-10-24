# Convert BPS to IPS and other ROM patch formats

Convert a ROM patch to another format, such as BPS to IPS or IPS to BPS, with [Create a ROM patch](https://rom-weaver.com/create-rom-patch). You need the clean ROM the patch was made for. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Convert the patch](#convert-the-patch)
- [Check the converted patch](#check-the-converted-patch)
- [Which format should you pick?](#which-format-should-you-pick)

<!-- END doctoc -->

## What do you need?

- The patch to convert, such as a `.bps`, `.ips`, `.ups`, or `.xdelta` file.
- The clean ROM that patch expects. A patch stores only changes, so Create rebuilds them from this ROM.

## Convert the patch

1. Open [Create a ROM patch](https://rom-weaver.com/create-rom-patch).
2. Add the clean ROM and the patch together. Create switches to **Patches & cheats** and shows the ROM as **Original**.
3. Open the patch card's **Checks**. Fix any [checksum mismatch](fix-checksum-errors.md) before you continue.
4. Choose the new format in **Patch format**.
5. Choose **Create patch & download**.

The format list here does not check file sizes. IPS stops at 16 MiB, and disc images need xdelta or PPF. If Create reports a size limit, choose BPS for a cartridge ROM or xdelta for a disc.

To merge several patches or add cheats, see [Build from patches and cheats](create-rom-patches.md#build-from-patches-and-cheats).

## Check the converted patch

1. In [Apply](https://rom-weaver.com/apply-patches), apply the original patch to a fresh copy of the clean ROM.
2. Apply the new patch to another fresh copy.
3. Compare both results in [Checksum file](https://rom-weaver.com/checksum). The checksums should match.

## Which format should you pick?

[BPS vs IPS, UPS, xdelta and PPF](../explanation/patch-formats.md) compares checksum protection and size limits. IPS cannot record which ROM it expects, so publish the clean ROM's checksum with an IPS patch.
