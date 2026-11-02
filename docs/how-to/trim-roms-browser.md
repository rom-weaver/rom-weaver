# Trim a ROM in the browser

Use Trim to remove padding from a supported ROM and download a smaller copy, or to pad a trimmed ROM back to full size. Keep the original for future patches.

<!-- START doctoc -->
## Table of contents

- [Open Trim](#open-trim)
- [Save a trimmed copy](#save-a-trimmed-copy)
- [Restore padding](#restore-padding)

<!-- END doctoc -->

## Open Trim

1. Enable **Beta tools** in [Settings](browser-settings.md#enable-beta-tools).
2. Open [Trim](https://rom-weaver.com/trim-rom).
3. Add the ROM or its archive.
4. Select the required member if an archive contains several candidates.
5. Wait for reading, checksumming, and identification to finish.

The [trim support reference](../reference/formats.md#trim-support) lists supported formats and restoration limits.

## Save a trimmed copy

1. Check the selected file in the ROM card. Open **Checks** to record its original checksums.
2. Choose an output name and format.
3. Select **TRIM & DOWNLOAD**.
4. Read the warning, then select **Trim ROM** to continue.
5. Save the result and test it in the emulator or hardware you use.

GameCube and Wii disc inputs convert losslessly to RVZ by default. The downloaded extension reflects the actual format, and savings come from compression rather than removal of unused sectors.

The format list offers the ROM's own extension, ZIP, and 7z. CHD, RVZ, and Z3DS appear only when the input is a matching disc image or 3DS ROM.

A file without removable padding may have no useful size reduction. A format that is not supported cannot be made trimmable by renaming it.

## Restore padding

1. Add the trimmed NDS, GBA, or 3DS ROM. Trim selects **Restore padding** in the output step when the ROM is already trimmed. Select it yourself for any other ROM it can restore.
2. Choose an output name and format.
3. Select **RESTORE & DOWNLOAD**, then select **Restore padding** to continue.
4. Save the result and test it in the emulator or hardware you use.

The output is the original byte for byte only for a ROM trimmed with the CLI's revert marker and uniform padding. Otherwise the padding is rebuilt as `0xFF` up to the next power-of-two size, which may not match the original. XISO trimming and RVZ conversion cannot be restored, and Trim does not offer **Restore padding** for them. The browser does not write revert markers; use [Trim and restore from the CLI](cli-trim.md#make-the-trim-reversible) for that. [Compression and trimming](../explanation/compression-formats.md#trim-compress-or-both) explains the difference.
