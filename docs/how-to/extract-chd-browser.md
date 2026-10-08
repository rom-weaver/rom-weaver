# Extract CHD to ISO, BIN/CUE, or GDI online

Decompress a CHD disc image locally in your browser, without uploading it. DVD CHDs convert to ISO. CDs produce BIN/CUE, and Dreamcast GD-ROMs produce GDI with tracks.

<!-- START doctoc -->
## Table of contents

- [Extract the disc](#extract-the-disc)
- [Download the disc files](#download-the-disc-files)
- [Check the result and storage](#check-the-result-and-storage)

<!-- END doctoc -->

## Extract the disc

1. Open [Extract](https://rom-weaver.com/extract).
2. Add one `.chd` file to **Archive**.
3. For a multi-track CD, choose **One BIN file** or **One BIN file per track**.
4. Wait until the extracted files appear in **Files**.

Extract accepts one archive or disc image at a time. To stop extraction, cancel it from the progress bar. Select **Extract again** to restart it.

## Download the disc files

1. For a DVD, select the ISO and choose **Download 1 file**.
2. For a CD or GD-ROM, select the sheet and all its tracks.
3. Choose **Download N files as ZIP** when downloading several files.
4. Save the download. Unpack the ZIP before opening the disc in your emulator.

Keep the CUE or GDI sheet with its tracks, preserving their filenames. Use the output shown in **Files**; not every CHD converts to ISO. Renaming a BIN file to ISO does not convert its sector layout.

## Check the result and storage

Keep enough free space for the uncompressed disc and its download. Test the disc in your emulator before removing the CHD. Keep the page open until your download finishes.

To compress the disc again, follow [Convert ISO or BIN/CUE to CHD](convert-to-chd-browser.md). For other inputs, follow [Extract files](extract-files-browser.md).
