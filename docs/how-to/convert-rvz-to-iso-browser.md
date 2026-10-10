# Decompress RVZ to ISO online

Extract a GameCube or Wii RVZ disc image to ISO locally in your browser. Use this RVZ to ISO converter without uploading your disc.

<!-- START doctoc -->
## Table of contents

- [Extract the ISO](#extract-the-iso)
- [Check compatibility and storage](#check-compatibility-and-storage)

<!-- END doctoc -->

## Extract the ISO

1. Open [Extract](https://rom-weaver.com/extract).
2. Add one `.rvz` file to **Archive**.
3. Wait until **Files** shows `game.iso`, using your RVZ filename as the stem.
4. Keep the ISO selected.
5. Select **Download 1 file**.
6. Save the `.iso` file.

Extract accepts one archive or disc image at a time. Add another file only after the download finishes.

## Check compatibility and storage

RVZ stores GameCube and Wii disc data efficiently. ISO has wider tool compatibility but usually needs more storage.

Budget for the uncompressed ISO, browser working storage, and the saved download, not just the RVZ size. Device memory, browser quota, and free disk space vary; no universal maximum file size is guaranteed. Keep the tab open until the download finishes.

For example, `my-disc.rvz` yields `my-disc.iso`. If you retained the original ISO, compare its checksum with the extracted ISO using [Checksum file](https://rom-weaver.com/checksum), not with the RVZ hash. Keep the RVZ until you test the ISO. For repeated memory/storage failures, use [native extraction](work-with-archives.md#extract-an-iso-from-rvz).

For other inputs, use [Extract files](extract-files-browser.md). [Choosing a compression format](../explanation/compression-formats.md) compares RVZ with other containers.

To compress the ISO again, follow [Convert ISO to RVZ](convert-to-rvz-browser.md).
