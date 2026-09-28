# Undo a PPF patch in the browser

Use PPF Undo with the patched ROM and the exact PPF3 patch that changed it. The patch must contain undo data.

This tool cannot undo arbitrary patches or reconstruct bytes absent from the patch.

<!-- START doctoc -->
## Table of contents

- [Restore the saved bytes](#restore-the-saved-bytes)
- [Check the restored copy](#check-the-restored-copy)

<!-- END doctoc -->

## Restore the saved bytes

1. Enable **Beta tools** in [Settings](browser-settings.md#enable-beta-tools), then open [PPF Undo](https://rom-weaver.com/ppf-undo).
2. Add the patched ROM and the original `.ppf` patch.
3. Check the **Patched ROM** and **PPF patch** cards.
4. Enter a separate output filename.
5. Select **Restore original ROM**.

If the patch lacks undo data, use your clean backup. The tool cannot recover changes from other patches applied afterward.

## Check the restored copy

Compare the restored file's checksum with the known original using [Identify](identify-roms-browser.md#compare-a-checksum). Test the copy before replacing any file.

For the terminal command, see [CLI tools](../reference/cli.md#tools). [PPF background](../explanation/patch-formats.md#ppf) explains the format.
