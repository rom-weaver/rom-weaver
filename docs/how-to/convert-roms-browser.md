# Extract or compress files in the browser

Use Compress to package files in a ZIP or 7z archive. You can also create CHD, RVZ, or Z3DS images from compatible disc images and ROMs.

To take every file out of an archive, use [Extract files](extract-files-browser.md). For directory packaging, use the [CLI archive guide](work-with-archives.md).

For common disc tasks, use [Convert RVZ to ISO](convert-rvz-to-iso-browser.md) or [Convert ISO or BIN/CUE to CHD](convert-to-chd-browser.md).

<!-- START doctoc -->
## Table of contents

- [Add files](#add-files)
- [Choose an output](#choose-an-output)
- [Check the result](#check-the-result)

<!-- END doctoc -->

## Add files

1. Open [Compress](https://rom-weaver.com/compress).
2. Add the files that you want to package or compress.
3. For a CUE disc, add the CUE file and every referenced track file.

ZIP and 7z accept arbitrary file sets. CHD accepts compatible disc images and ROMs. RVZ accepts GameCube and Wii ISO images. Z3DS accepts Nintendo 3DS images.

## Choose an output

1. Choose ZIP, 7z, CHD, RVZ, or Z3DS.
2. Enter the output filename without its extension.
3. Open **Options** to change the codec or compression level.
4. Select **Compress**, then select **Download** when the output is ready.

<figure class="docs-screenshot">
  <picture>
    <source media="(max-width: 520px)" type="image/webp" srcset="../screenshots/compress-mobile-dark.webp" width="370" height="639">
    <img src="../screenshots/compress-desktop-light.webp" alt="Compress with input files, output filename, format, codec, level, and download button" width="1133" height="775">
  </picture>
  <figcaption>Choose a format and compression options, then download the finished file.</figcaption>
</figure>

The format picker offers outputs that match the selected inputs. Renaming a filename extension does not convert its contents.

For conversion, extract the ROM or disc image first. Add the extracted files to Compress.

Compress does not apply patches. Use [Apply](apply-rom-patches.md) when you need to change ROM contents.

Only formats marked **Create** in the [container table](../reference/formats.md#container-and-compression-formats) can be output containers. A supported input is not necessarily a supported output.

## Check the result

Open a disc-image result with [Identify](identify-roms-browser.md) and compare the extracted ROM bytes with the original.

Test the result in the emulator or hardware you use before replacing your stored copy. Keep the source when changing disc layouts or using trimming.

[Choosing a compression format](../explanation/compression-formats.md) explains archive and disc-container differences.
