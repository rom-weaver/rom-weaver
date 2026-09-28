# Convert ISO or BIN/CUE to CHD in the browser

Use Apply without patches to create a CHD from an `.iso` or a complete `.cue` and `.bin` disc set. The conversion runs locally.

<!-- START doctoc -->
## Table of contents

- [Add the disc](#add-the-disc)
- [Create the CHD](#create-the-chd)
- [Check compatibility and storage](#check-compatibility-and-storage)

<!-- END doctoc -->

## Add the disc

1. Open [Apply](https://rom-weaver.com/apply-patches).
2. Add the `.iso`, or add the `.cue` with every referenced `.bin` file.
3. Wait for reading and checksumming to finish.
4. Remove any discovered patches from **Patches & Cheats**.

The cue sheet names and orders its track files. Missing or renamed BIN files prevent complete disc conversion.

## Create the CHD

1. In **Apply**, enter the output filename.
2. Open **Options**.
3. Under **Compression type**, select **.chd**.
4. Select **APPLY & DOWNLOAD**.
5. Save the `.chd` file.

The output picker offers CHD only for compatible disc inputs. Changing an extension does not convert the disc.

Small ISO images can be detected as CD media and fail with the default codecs. If you see `chd codec list is invalid for cd media`, use the disc's original CUE/BIN set instead.

## Check compatibility and storage

CHD can reduce disc storage while preserving the disc layout. Emulator support varies by system and emulator version.

The browser needs working space for the source, staged tracks, and output. Keep the source files until you test the CHD.

Use [Extract files](extract-files-browser.md) to unpack an existing CHD. [Choosing a compression format](../explanation/compression-formats.md) compares CHD with RVZ and archives.
