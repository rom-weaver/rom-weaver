# Extract or compress a ROM in the browser

Use Apply with only a ROM to extract it or change its output container. No patch is needed.

To take every file out of an archive, use [Extract files](extract-files-browser.md). For directory packaging, use the [CLI archive guide](work-with-archives.md).

<!-- START doctoc -->
## Table of contents

- [Load the ROM](#load-the-rom)
- [Choose a plain or compressed output](#choose-a-plain-or-compressed-output)
- [Check the result](#check-the-result)

<!-- END doctoc -->

## Load the ROM

1. Open a fresh [Apply page](https://rom-weaver.com/apply-patches).
2. Add the ROM or its archive to **Inputs**.
3. If a selection dialog opens, choose the ROM you need.
4. Wait for reading and checksumming to finish.
5. Remove any automatically discovered sidecar patches when you want only extraction or compression.

For a disc, keep the sheet and its track files together. Add the complete set, or an archive containing that set.

## Choose a plain or compressed output

1. Open **Apply** and enter an output name.
2. Choose the plain ROM format to extract, or choose a supported compressed format.
3. Open **Options** if you need to change compression settings.
4. Select **APPLY & DOWNLOAD** and save the result.

The format picker offers outputs for the selected input. Renaming a filename extension does not convert its contents.

The [Apply output screenshot](apply-rom-patches.md#choose-the-output-and-apply) shows these same controls.

Only formats marked **Create** in the [container table](../reference/formats.md#container-and-compression-formats) can be output containers. A supported input is not necessarily a supported output.

## Check the result

Open the result with [Identify](identify-roms-browser.md) and compare the ROM's checksums with the original. Compare extracted ROM bytes, not the outer archive.

Test the result in the emulator or hardware you use before replacing your stored copy. Keep the source when changing disc layouts or using trimming.

[Choosing a compression format](../explanation/compression-formats.md) explains archive and disc-container differences.
