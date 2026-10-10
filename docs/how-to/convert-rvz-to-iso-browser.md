# Decompress RVZ to ISO online

Extract a GameCube or Wii RVZ disc image to ISO locally in your browser. Use this RVZ to ISO converter without uploading your disc.

[Open the RVZ to ISO tool](https://rom-weaver.com/extract).

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

Use the uncompressed ISO size to plan space, not the smaller RVZ download size. The browser needs working storage, and saving the result needs destination space too. There is no single maximum disc size guaranteed across devices: browser storage quota, available memory, and free disk space all matter. Keep the tab open and the device awake until the download finishes.

For example, `my-disc.rvz` is listed as `my-disc.iso` after extraction. Check the listed size before downloading. If you retained the ISO used to create that RVZ, compare the two ISO checksums using [Checksum file](https://rom-weaver.com/checksum); do not compare the RVZ checksum with the ISO checksum. Keep the RVZ until you test the ISO in the intended tool or emulator.

If extraction stops with a storage or memory error, free space and retry one disc in a fresh session. A smaller practice file succeeding does not establish that the full disc fits. If it still fails, use the [native extraction workflow](work-with-archives.md) on a computer with sufficient space.

For other inputs, use [Extract files](extract-files-browser.md). [Choosing a compression format](../explanation/compression-formats.md) compares RVZ with other containers.

To compress the ISO again, follow [Convert ISO to RVZ](convert-to-rvz-browser.md).
