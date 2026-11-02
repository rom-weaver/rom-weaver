# Trim a ROM in the browser

Use Trim to remove unused padding from a Nintendo DS/DSi, Game Boy Advance, Nintendo 3DS, or Xbox XISO image and download a smaller copy, or to pad a trimmed ROM back to full size. Keep the original for future patches.

<!-- START doctoc -->
## Table of contents

- [Open Trim](#open-trim)
- [Save a trimmed copy](#save-a-trimmed-copy)
- [Restore padding](#restore-padding)

<!-- END doctoc -->

## Open Trim

1. Open [Trim](https://rom-weaver.com/trim-rom). No setting needs to be enabled first.
2. Add the ROM or its archive. The drop zone lists the accepted file types by platform: Nintendo DS/DSi, Game Boy Advance, Nintendo 3DS, and Xbox XISO, plus archives.
3. Select the required member if an archive contains several candidates.
4. Wait for reading, checksumming, and identification to finish.

Once the ROM is staged, the output step states what the run will do for that file. A file Trim does not support gets a notice instead; use [Compress](convert-roms-browser.md) for other files. The [trim support reference](../reference/formats.md#trim-support) lists supported formats and restoration limits.

## Save a trimmed copy

1. Check the selected file in the ROM card. Open **Checks** to record its original checksums.
2. Choose an output name and format.
3. Select **TRIM & DOWNLOAD**. The run starts at once, or waits in the queue while the ROM is still being read.
4. Read the warning dialog that opens, then select **Got it**. The dialog is informational: closing it, by button, Esc, or clicking outside, never cancels or changes the run.
5. Save the result and test it in the emulator or hardware you use.

The format starts from the **Download format** setting in [Settings](browser-settings.md): ZIP for Nintendo DS and Game Boy Advance ROMs and Z3DS for Nintendo 3DS ROMs by default, `.7z` or the plain file if you chose those there. Change it in the output step for one run.

The format list offers the ROM's own extension, ZIP, and 7z. Z3DS appears only for a 3DS ROM, and CHD is never offered for an Xbox XISO, which cannot be stored as CHD. A 3DS ROM is trimmed from inside a `.z3ds`, `.zcci`, `.zcxi`, ZIP, or 7z file; a `.z3ds` or `.zcci` input keeps its own extension.

A trimmed NDS, GBA, or 3DS ROM ends in a 12-byte revert marker that records the removed padding, so [Restore padding](#restore-padding) can rebuild the original exactly. Tools that read only the ROM's used data ignore it; the [footer format](../development/trim-revert-footer.md) describes its limits. An XISO is rebuilt without its unused space and cannot be restored, so keep the original.

A file without removable padding may have no useful size reduction. A format that is not supported cannot be made trimmable by renaming it.

## Restore padding

Add a trimmed ROM and Trim selects **Restore** for it; use the mode toggle in the output step to choose between trimming and restoring. **RESTORE & DOWNLOAD** also starts at once and opens a warning dialog.

Restoring is byte-exact only for a ROM trimmed with a revert marker. Without one, the padding is rebuilt as `0xFF` up to a power-of-two size. XISO trimming does not support restore-padding. The browser does not expose the CLI's revert-marker option; use [Trim and restore from the CLI](cli-trim.md#put-the-padding-back) when you need it. [Compression and trimming](../explanation/compression-formats.md#trim-compress-or-both) explains the difference.
