# Extract CHD, RVZ, Z3DS, and ROM archives online

Extract ROM archives, CHD and RVZ disc images, or Z3DS, ZCCI, ZCXI, ZCIA, and Z3DSX files in your browser. Download files without uploads.

To change a ROM's container instead, follow [Convert a ROM](convert-roms-browser.md). For terminal procedures, see the [CLI archive guide](work-with-archives.md).

To extract one GameCube or Wii disc, follow [Convert RVZ to ISO](convert-rvz-to-iso-browser.md).

To decompress Nintendo 3DS files, follow [Extract Z3DS, ZCCI, ZCXI, ZCIA, and Z3DSX](extract-z3ds-browser.md).

<!-- START doctoc -->
## Table of contents

- [Extract an archive](#extract-an-archive)
- [Download the files](#download-the-files)
- [Convert CHD to ISO or BIN/CUE](#convert-chd-to-iso-or-bincue)

<!-- END doctoc -->

## Extract an archive

1. Open [Extract](https://rom-weaver.com/extract).
2. Add one archive or disc image to **Archive**.
3. For a CHD that holds a multi-track CD, choose **One BIN file** or **One BIN file per track**.
4. Wait for extraction to finish. rom-weaver also extracts archives found inside the file.

To stop a long extraction, cancel it from the progress bar. Select **Extract again** to restart it.

## Download the files

1. In **Files**, select the files you need.
2. Select **Download 1 file**, or **Download N files as ZIP** for several files.
3. Save the download.

The extracted files stay in this browser until you add another file or leave the page.

The [container table](../reference/formats.md#container-and-compression-formats) lists the formats that can be read.

## Convert CHD to ISO or BIN/CUE

1. Open [Extract](https://rom-weaver.com/extract) and add one `.chd` file.
2. For a CD, choose **One BIN file** or **One BIN file per track**.
3. Wait until the extracted files appear in **Files**.
4. For a DVD, select the ISO and choose **Download 1 file**.
5. For a CD or GD-ROM, select the sheet and tracks, then choose **Download N files as ZIP**.

DVD CHDs extract to ISO. CD CHDs produce BIN/CUE files. Dreamcast GD-ROM CHDs produce a GDI sheet and track files. Keep the sheet with its tracks.

Use the output shown in **Files**. Renaming a BIN file to ISO does not convert its sector layout. Extract does not turn every CHD into ISO.

Keep enough free space for the uncompressed disc and its download. Test the result before removing the CHD.

To compress the disc again, follow [Convert ISO or BIN/CUE to CHD](convert-to-chd-browser.md).
