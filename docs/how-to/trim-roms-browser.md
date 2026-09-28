# Trim a ROM in the browser

Use Trim to remove padding from a supported ROM and download a smaller copy. Keep the original for future patches.

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

A file without removable padding may have no useful size reduction. A format that is not supported cannot be made trimmable by renaming it.

## Restore padding

The browser does not expose the CLI's restore-padding or revert-marker options. Use [Trim and restore from the CLI](cli-trim.md#put-the-padding-back) when you need them.

Restoring padding does not always reproduce the original bytes. XISO and RVZ scrub cannot be reverted. [Compression and trimming](../explanation/compression-formats.md#trim-compress-or-both) explains the difference.
