# Compress ISO or BIN/CUE to CHD online

Compress ISO or BIN/CUE disc images to CHD locally in your browser. Use this CHD converter without uploads or an account.

<!-- START doctoc -->
## Table of contents

- [Add the disc](#add-the-disc)
- [Create the CHD](#create-the-chd)
- [Check compatibility and storage](#check-compatibility-and-storage)

<!-- END doctoc -->

## Add the disc

1. Open [Compress](https://rom-weaver.com/compress).
2. Add the `.iso`, or add the `.cue` with every referenced `.bin` file.
3. Keep only that disc's files in **Inputs**.

The cue sheet names and orders its track files. Missing or renamed BIN files prevent complete disc conversion.

## Create the CHD

1. In **Output**, choose **CHD**.
2. Enter the output filename without its extension.
3. Keep the default codecs, or open **Options** to change compression settings.
4. Select **Compress** and wait for the result.
5. Select **Download** and save the `.chd` file.

The output picker offers CHD only for compatible disc inputs. Changing an extension does not convert the disc.

If CHD is unavailable, remove unrelated files and check that every CUE track is present. Compress accepts one disc at a time.

For an image inside ZIP or 7z, add the archive to Compress. Select the ISO or the complete CUE/BIN set, then select the **Add** button.

## Check compatibility and storage

CHD can reduce disc storage while preserving the disc layout. Emulator support varies by system and emulator version.

The browser needs working space for the source, staged tracks, and output. Keep the source files until you test the CHD.

To reverse this workflow, follow [Extract CHD to ISO, BIN/CUE, or GDI](extract-chd-browser.md). [Choosing a compression format](../explanation/compression-formats.md) compares CHD with RVZ and archives.
