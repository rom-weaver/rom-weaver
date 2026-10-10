# Compress ISO or BIN/CUE to CHD online

Compress ISO or BIN/CUE disc images to CHD locally in your browser. Use this CHD converter without uploads or an account.

[Open the ISO or BIN/CUE to CHD tool](https://rom-weaver.com/compress).

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

For a DVD-style ISO, add the ISO alone. For a CD with a cue sheet, add the CUE and every referenced track, including audio tracks. For example, if `disc.cue` names `track01.bin` and `track02.bin`, all three files belong in Inputs. Keep their filenames unchanged; the cue sheet names and orders the tracks. Do not select only the largest BIN or rename a BIN to ISO.

Missing or renamed track files prevent complete disc conversion. CHD support depends on the actual disc layout, not just the extension; see [supported container formats](../reference/formats.md#container-and-compression-formats).

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

The browser needs working space for the source, staged tracks, and output, in addition to space for the downloaded CHD. Compression savings depend on the data; do not assume the output will fit because another disc compressed well. Available memory and browser storage quotas vary by device, so there is no universal browser file-size limit to quote.

Keep the tab open until downloading finishes. If the operation reports a memory or storage error, free space and retry one complete disc; use the [native compression workflow](work-with-archives.md) if the browser still cannot complete it.

Verify the result before deleting any source: [extract the CHD](extract-chd-browser.md), check that the expected sheet and all tracks are present, and test it in the emulator you intend to use. For a DVD ISO round trip, compare the extracted ISO's checksum with your source using [Checksum file](https://rom-weaver.com/checksum). CD extraction can split or combine BIN files, so compare bytes only with matching track layout. The CHD's own checksum is not the checksum of its extracted contents.

For a supplied synthetic disc with known byte counts and checksums, use the [compressed-disc practice run](../tutorials/patch-compressed-disc.md). It checks data, not whether a commercial game boots.

To reverse this workflow, follow [Extract CHD to ISO, BIN/CUE, or GDI](extract-chd-browser.md). [Choosing a compression format](../explanation/compression-formats.md) compares CHD with RVZ and archives.
