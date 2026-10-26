# CHD to ISO converter online: extract ISO, BIN/CUE, or GDI

Convert CHD to ISO free in your browser, without uploading the disc. DVD CHDs produce ISO, CD CHDs BIN/CUE, and Dreamcast GD-ROM CHDs GDI with tracks.

<a id="convert-chd-to-iso-bincue-or-gdi-online"></a>

<a id="extract-chd-to-iso-bincue-or-gdi-online"></a>

<!-- START doctoc -->
## Table of contents

- [Extract the disc](#extract-the-disc)
- [Download the disc files](#download-the-disc-files)
- [Why BIN/CUE instead of ISO?](#why-bincue-instead-of-iso)
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

## Why BIN/CUE instead of ISO?

The CHD's source disc decides the output. A CD CHD extracts to BIN/CUE because its tracks can include audio and raw sectors that an ISO cannot hold; a DVD CHD extracts to ISO. Open the `.cue` file in your emulator, with its BIN tracks beside it.

## Check the result and storage

Allow space for the uncompressed disc, browser working storage, and download. Quotas and memory vary by device. Keep this page open until downloading finishes; for repeated storage/memory failures, use [native extraction](work-with-archives.md).

The [synthetic disc tutorial](../tutorials/patch-compressed-disc.md) supplies a safe example: after its two patches, **One BIN file** yields 32,768 bytes with SHA-1 `ebce631d802abe7c450e3f6cb658f9679701fdd6`. Check the extracted BIN using [Checksum file](https://rom-weaver.com/checksum), not the CHD or CUE. This tiny example does not test multi-gigabyte capacity.

For your disc, confirm all tracks are present and test the emulator before removing the CHD. A CD yielding BIN/CUE rather than ISO is expected.

To compress the disc again, follow [Compress ISO or BIN/CUE to CHD](convert-to-chd-browser.md). For other inputs, follow [Extract files](extract-files-browser.md).
