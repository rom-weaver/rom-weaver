# Test a patched ROM in the browser

Use the Test page to boot a ROM in an emulator inside the same tab, so you can
check a patch actually works before you keep it.

<!-- START doctoc -->
## Table of contents

- [What the Test page is](#what-the-test-page-is)
- [Test a ROM you just patched](#test-a-rom-you-just-patched)
- [Test a ROM from your device](#test-a-rom-from-your-device)
- [While the game runs](#while-the-game-runs)
- [Related](#related)

<!-- END doctoc -->

## What the Test page is

Test runs [EmulatorJS](https://emulatorjs.org/) in your browser. The ROM never
leaves your device, the same as everywhere else in rom-weaver. Test needs no
setting turned on; it sits beside Apply and Create.

Not every system has an emulator core. A ROM without one is listed but cannot
be started, and the page says **No emulator core for this system**.

## Test a ROM you just patched

A finished apply offers a test button, so you can go straight from the result
to the emulator without saving and re-adding the file.

You can change what a finished apply does:

- **Show the test button after applying** hides or shows that button.
- **After applying** chooses whether the result downloads, opens in Test, does
  both, or neither.

Both are listed in [Webapp settings](../reference/webapp-settings.md#apply-behaviour).

## Test a ROM from your device

1. Open [Test](https://rom-weaver.com/test).
2. Drop a ROM on the drop zone, or click it to pick a file. ZIP and 7z
   archives work too.
3. Pick the game in the list.
4. Click the core's own start button inside the player to begin.

## While the game runs

- **Fullscreen** expands the player; press it again, or Escape, to leave.
- **Close** returns to the list and keeps the loaded games.
- Saves made by the emulator are kept in your browser, not on a server.

## Related

- [Apply a ROM patch](apply-rom-patches.md): the workflow that produces the
  file you are testing.
- [Test the downloaded patch](create-rom-patches.md#test-the-downloaded-patch):
  why you test the artifact you would publish, not your working copy.
