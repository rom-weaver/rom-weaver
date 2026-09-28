# Compress Nintendo 3DS ROMs to Z3DS in the browser

Compress Nintendo 3DS ROMs to Z3DS, ZCCI, ZCXI, ZCIA, or Z3DSX locally in your browser. Files stay on your device.

<!-- START doctoc -->
## Table of contents

- [Add the Nintendo 3DS file](#add-the-nintendo-3ds-file)
- [Create the compressed file](#create-the-compressed-file)
- [Check the result](#check-the-result)

<!-- END doctoc -->

## Add the Nintendo 3DS file

1. Open [Compress](https://rom-weaver.com/compress).
2. Add one `.3ds`, `.cci`, `.cxi`, `.cia`, `.3dsx`, or `.app` file to **Inputs**.
3. Remove other files before choosing the output format.

For a ROM inside ZIP or 7z, [extract the file](extract-files-browser.md) first. For an existing compressed 3DS file, use [Extract Z3DS files](extract-z3ds-browser.md) before recompressing it.

## Create the compressed file

1. In **Output**, choose **Z3DS**.
2. Enter the output filename without its extension.
3. Keep the default compression level, or open **Options** to change it.
4. Select **Compress** and wait for the result.
5. Select **Download** and save the compressed file.

The Z3DS option covers every supported 3DS subtype. For example, a `.cia` input produces `.zcia`, while `.3dsx` produces `.z3dsx`.

Keep the extension assigned by Compress. The [Z3DS filename reference](../reference/formats.md#z3ds-filename-variants) lists each mapping.

If Z3DS is unavailable, check the input extension and keep only one file in **Inputs**. Changing an extension does not convert the contents.

## Check the result

Test the compressed file in an emulator that supports its Z3DS subtype. Keep the original until you check the result.

To check the uncompressed bytes, [extract the compressed file](extract-z3ds-browser.md). Compare its checksum with the original through [Identify](identify-roms-browser.md).

Keep enough free storage for the original and compressed output. Compression does not decrypt a ROM or convert a CIA package into a cartridge image.

[Choosing a compression format](../explanation/compression-formats.md#3ds-rom-compression-z3ds) explains Z3DS compatibility. For GameCube and Wii discs, use [ISO to RVZ](convert-to-rvz-browser.md).
