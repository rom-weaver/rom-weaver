# Extract CHD to ISO, BIN/CUE, or GDI online

Decompress CHD locally in your browser without uploading it. DVDs produce ISO, CDs BIN/CUE, and Dreamcast GD-ROMs GDI with tracks.

[Open the CHD extraction tool](https://rom-weaver.com/extract).

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

Extract accepts one archive or disc image. Cancel from the progress bar; select **Extract again** to restart.

## Download the disc files

1. For a DVD, select the ISO and choose **Download 1 file**.
2. For a CD or GD-ROM, select the sheet and all its tracks.
3. Choose **Download N files as ZIP** for several files.
4. Save and unpack the ZIP before opening the disc in your emulator.

Keep the CUE or GDI sheet and tracks together with their original filenames. Use the output in **Files**. Not every CHD converts to ISO; renaming BIN to ISO does not convert its sectors.

## Check the result and storage

Plan for the uncompressed disc, browser working storage, and the downloaded files. A small CHD can expand substantially. Browser quotas, free disk space, and memory vary by device; no fixed maximum CHD size is guaranteed. Keep this page open and the device awake until downloading finishes.

For a safe example with a known result, the [synthetic compressed-disc tutorial](../tutorials/patch-compressed-disc.md) supplies a CHD and two patches. After its patching steps, **One BIN file** produces a 32,768-byte BIN with SHA-1 `ebce631d802abe7c450e3f6cb658f9679701fdd6`. That checksum applies to the patched, extracted BIN, not the original CHD or its CUE sheet. Compare it with [Checksum file](https://rom-weaver.com/checksum).

For your own disc, confirm that all expected tracks are present and test it in your intended emulator before removing the CHD. A CD yielding BIN/CUE instead of ISO is an expected result. If an emulator asks for a missing track, keep the sheet and every referenced track together and undo any filename changes.

If extraction reports insufficient storage or memory, free space and retry one disc. If it still fails, use the [native extraction workflow](work-with-archives.md). Do not treat a successful tiny example as a capacity test for a multi-gigabyte disc.

To compress the disc again, follow [Convert ISO or BIN/CUE to CHD](convert-to-chd-browser.md). For other inputs, follow [Extract files](extract-files-browser.md).
