# Convert ISO to RVZ in the browser

Compress a GameCube or Wii ISO to RVZ locally in your browser. No patch, upload, or account is needed.

<!-- START doctoc -->
## Table of contents

- [Add the ISO](#add-the-iso)
- [Create the RVZ](#create-the-rvz)
- [Check the result](#check-the-result)

<!-- END doctoc -->

## Add the ISO

1. Open [Compress](https://rom-weaver.com/compress).
2. Add one GameCube or Wii `.iso` file to **Inputs**.
3. Remove other files before choosing the output format.

Use a valid GameCube or Wii disc image. Renaming another console's image to `.iso` does not make it compatible with RVZ.

For a disc inside ZIP, 7z, or another supported container, [extract the ISO](extract-files-browser.md) first. Add that ISO to Compress.

## Create the RVZ

1. In **Output**, choose **RVZ**.
2. Enter the output filename without its extension.
3. Keep the default compression settings, or open **Options** to change the level or block size.
4. Select **Compress** and wait for the result.
5. Select **Download** and save the `.rvz` file.

If RVZ is unavailable, check that **Inputs** contains only one compatible disc image. Multiple files offer archive output instead.

Keep the page open until compression and download finish. To stop compression, use the cancel control on the progress bar.

## Check the result

Open the RVZ in an emulator that supports RVZ for your console. Keep the original ISO until you check the result.

To compare the uncompressed bytes, [convert the RVZ back to ISO](convert-rvz-to-iso-browser.md). Compare that ISO's checksum with the original through [Identify](identify-roms-browser.md).

Keep enough free storage for the ISO and compressed output. The resulting file size depends on the disc contents and compression settings.

[Choosing a compression format](../explanation/compression-formats.md) compares RVZ with CHD and Z3DS. For other discs, use [ISO or BIN/CUE to CHD](convert-to-chd-browser.md).
