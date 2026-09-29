# Extract Z3DS files in the browser

Extract Z3DS, ZCCI, ZCXI, ZCIA, or Z3DSX files into Nintendo 3DS ROMs locally in your browser, without uploads.

<!-- START doctoc -->
## Table of contents

- [Decompress the Nintendo 3DS file](#decompress-the-nintendo-3ds-file)
- [Check the extracted filename](#check-the-extracted-filename)
- [Check the result and storage](#check-the-result-and-storage)

<!-- END doctoc -->

## Decompress the Nintendo 3DS file

1. Open [Extract](https://rom-weaver.com/extract).
2. Add one `.z3ds`, `.zcci`, `.zcxi`, `.zcia`, or `.z3dsx` file to **Archive**.
3. Wait until the uncompressed file appears in **Files**.
4. Keep that file selected, then select **Download 1 file**.
5. Save the download before adding another compressed file.

Keep the page open until extraction and download finish. To stop extraction, use the cancel control on the progress bar.

If your compressed file is inside ZIP or 7z, you can add that archive instead. Extract also opens supported containers found inside it.

## Check the extracted filename

Use the filename shown in **Files**. A `.zcia` produces `.cia`, `.zcci` produces `.cci`, `.zcxi` produces `.cxi`, and `.z3dsx` produces `.3dsx`.

A `.z3ds` file can produce `.cci` when its contents identify a cartridge image. It does not always produce a `.3ds` filename.

Check the [Z3DS filename reference](../reference/formats.md#z3ds-filename-variants) for the complete mapping. Renaming `.zcia` to `.z3ds` does not convert CIA contents into a cartridge image.

## Check the result and storage

Open the extracted file in a compatible emulator or tool. Extraction removes compression; it does not decrypt the ROM or change its underlying format.

If you have the original uncompressed file, compare its checksum with the download through [Identify](identify-roms-browser.md).

Make sure the browser and download destination have enough free storage for the uncompressed file. Keep the compressed copy until you check the download.

To reverse this workflow, [compress a Nintendo 3DS ROM to Z3DS](convert-to-z3ds-browser.md). For other containers, use [Extract files](extract-files-browser.md).
