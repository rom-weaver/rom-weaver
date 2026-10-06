# Patch a compressed CHD disc in the browser

Apply two supplied patches to a compressed disc, download another CHD, and verify the extracted bytes. You need only a browser and the three practice files below.

This tiny synthetic disc contains test data, not a commercial game. It is not a playable disc; this exercise checks the patching workflow.

<!-- START doctoc -->
## Table of contents

- [Step 1: download the practice files](#step-1-download-the-practice-files)
- [Step 2: add the compressed input and patches](#step-2-add-the-compressed-input-and-patches)
- [Step 3: set the patch order](#step-3-set-the-patch-order)
- [Step 4: download a compressed result](#step-4-download-a-compressed-result)
- [Step 5: verify the result](#step-5-verify-the-result)

<!-- END doctoc -->

## Step 1: download the practice files

Save these three files to your device:

- [practice-disc.chd](https://rom-weaver.com/docs/samples/compressed-disc/practice-disc.chd): the compressed starting disc.
- [01-first.bps](https://rom-weaver.com/docs/samples/compressed-disc/01-first.bps): the first change.
- [02-second.bps](https://rom-weaver.com/docs/samples/compressed-disc/02-second.bps): a change that requires the first patch's result.

Keep the original CHD. Each patch changes the same 16-byte region in its extracted BIN, so the order matters.

## Step 2: add the compressed input and patches

1. Open [Apply Patches](https://rom-weaver.com/apply-patches).
2. Add the CHD and both BPS files to **Inputs**.
3. Wait for reading and checksumming to finish. If asked to choose a file from the CHD, select its `.bin` entry.
4. Open **Checks** on the ROM card. The extracted BIN's SHA-1 should be `ba1af47af57aed5590c30358f4b7dc247cf26e94`.

The patch runs on the extracted BIN, not on the CHD's compressed bytes. The CHD can also supply a CUE sheet describing the disc.

## Step 3: set the patch order

1. Put `01-first.bps` above `02-second.bps` in **Patches & Cheats**. Drag a numbered handle if necessary.
2. Keep both patches switched on.
3. Set the first patch's input to **Original ROM**.
4. Set the second patch's input to **Previous patch output**.
5. Leave checksum validation enabled.

The first patch produces a BIN with SHA-1 `b94e0943f9d487bb1a8961dfdce4494bf83d2160`. The second patch expects that intermediate result. Applying it directly to the original fails its source checksum.

## Step 4: download a compressed result

1. In **Apply**, enter `practice-patched` as the output filename, without an extension.
2. Choose **CHD** in **Output format**.
3. Choose **APPLY & DOWNLOAD**, wait for completion, and save `practice-patched.chd`.

Keep the default compression settings. The compressed file's checksum is not the checksum of the BIN inside it.

## Step 5: verify the result

1. Open [Extract](https://rom-weaver.com/extract) and add `practice-patched.chd`.
2. If offered a track layout, choose **One BIN file**.
3. In **Files**, choose **Clear all**, select only the `.bin` file, then choose **Download 1 file**.
4. Open [Checksum file](https://rom-weaver.com/checksum) and add that BIN.
5. Select SHA-1 and compare it with `ebce631d802abe7c450e3f6cb658f9679701fdd6`.

The extracted BIN is 32,768 bytes. A matching SHA-1 confirms the supplied patches produced the expected disc data after decompression.

This verifies the patched BIN, not emulator compatibility or a byte-identical CHD encoding. Your original CHD remains the starting point for another run.

For your own discs, follow [Apply ROM patches](../how-to/apply-rom-patches.md). For GameCube and Wii compression, see [Convert ISO to RVZ](../how-to/convert-to-rvz-browser.md).
