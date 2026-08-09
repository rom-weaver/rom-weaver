# Undo a PPF patch in the browser

Use the Tools page to turn a PPF3-patched ROM back into the original, using the
undo data stored inside the patch itself.

<!-- START doctoc -->
## Table of contents

- [Turn the Tools page on](#turn-the-tools-page-on)
- [What Tools does today](#what-tools-does-today)
- [Restore the original ROM](#restore-the-original-rom)
- [If it fails](#if-it-fails)
- [Related](#related)

<!-- END doctoc -->

## Turn the Tools page on

Tools is a beta tool, so it is hidden until you ask for it.

1. Open **Settings** from the top navigation.
2. Tick **Enable beta tools (Trim and Tools)**.
3. Save. **Tools** and **Trim** appear beside Apply and Create.

The setting is listed in [Webapp settings](../reference/webapp-settings.md#beta-tools-and-onboarding).

## What Tools does today

Tools holds one command, **PPF undo**. It reads the patched ROM and the PPF
patch that was applied to it, then writes the original ROM back out.

This only works when the patch is a PPF3 file that carries undo data. A PPF
without undo data cannot restore anything, and the run reports an error.

## Restore the original ROM

1. Open [Tools](https://rom-weaver.com/tools).
2. Drop the patched ROM and the `.ppf` patch on the drop zone. Both can go on
   at once; the `.ppf` file is recognised as the patch and the other file as
   the ROM.
3. Check **0x02 Patched ROM** and **0x03 PPF patch** name the files you meant.
4. Edit the output filename in **0x04 Restore** if you want a different name.
   It defaults to your ROM's name with `-restored` added.
5. Click **Restore original ROM**, then save the result.

The restored file downloads on its own. **Download** in the same card saves it
again with a location prompt.

## If it fails

- **A PPF3 patch must include undo data.** The patch was written without it.
  Ask the patch author for a version that has it, or keep a clean copy of the
  ROM instead.
- The patched ROM and the patch must be the pair that were used together.
  A different ROM produces a wrong result or an error.

## Related

- [How patching works](../explanation/how-patching-works.md): why the exact
  starting bytes matter.
- [Patch formats](../explanation/patch-formats.md): what PPF is and is not.
