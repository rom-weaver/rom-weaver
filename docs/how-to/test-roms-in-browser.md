# Test a ROM in the browser

Use the Test page to play a local ROM or check an Apply result. The ROM stays on your device.

If you need a practice file, open [guided Test](https://rom-weaver.com/test?guide=test). It loads a tiny homebrew NES ROM from this project.

<!-- START doctoc -->
## Table of contents

- [Load a ROM](#load-a-rom)
- [Test an Apply result](#test-an-apply-result)
- [Switch games or stop](#switch-games-or-stop)
- [Use saves and fullscreen](#use-saves-and-fullscreen)
- [Export and restore a save](#export-and-restore-a-save)
- [Disable save storage](#disable-save-storage)
- [Fix a game that does not start](#fix-a-game-that-does-not-start)

<!-- END doctoc -->

## Load a ROM

1. Open [Test](https://rom-weaver.com/test).
2. Drop a ROM onto **0x01 Load a game**, or choose **Choose a ROM file**.
3. Use the controls inside the emulator player.

You can also add a ZIP or 7z archive. rom-weaver shows the extraction progress, then opens a supported ROM from the archive.

The Test page recognizes local ROMs for Atari 7800 and Lynx. It also recognizes Nintendo NES, Famicom Disk System, Game Boy and Game Boy Color, Game Boy Advance, Nintendo 64, Nintendo DS, and Super Nintendo. It recognizes Sega Game Gear, Master System, and Mega Drive or Genesis.

Apply can also send a detected Sega Saturn or Sony PlayStation result to Test.

rom-weaver does not bundle EmulatorJS cores for Nintendo GameCube, Wii, or 3DS. It also omits Sega CD and Dreamcast; Sony PlayStation 2 and PSP; PC Engine and PC Engine CD; and Neo Geo Pocket.

## Test an Apply result

1. Apply the patch on the [Apply page](https://rom-weaver.com/apply).
2. Check **Post Apply Test** under **Options**. If it warns that the platform cannot be tested, use another emulator or the target hardware.
3. Select **Open in the Test tab** after Apply finishes.
4. Play far enough to exercise the patched content.
5. Return to Apply and download the result if you have not downloaded it.

The **Post Apply Test** option can open Test automatically or hide the Test button. Apply skips automatic testing for unsupported platforms. Its disabled Test button names the unsupported platform.

Use **Post Apply Download** to choose whether Apply downloads the result automatically.

An emulator test does not prove that every part of a patch works. Keep the clean original and test important paths on the target hardware when possible.

## Switch games or stop

Select **Choose another ROM** to replace the current game. Select **Stop** to unload the game and return to the Test start screen.

The emulator pauses when you leave the Test page or hide the browser tab. It resumes when you return.

## Use saves and fullscreen

Use the emulator menu to create a save state or save the game's SRAM. rom-weaver stores the save bytes in this browser.

Each save uses the ROM's SHA-1 checksum as its identity. The record also stores the file name as a display name. Thus, the same ROM finds its save after you rename the file.

The panel above EmulatorJS shows the current file name and complete SHA-1. Storage shows the same value as a ROM fingerprint. You only need these values when you troubleshoot a save mismatch.

Use the fullscreen button above the player to enter or leave fullscreen. On iPhone and iPad, the button uses a full-viewport player because Safari does not offer fullscreen for this type of content.

## Export and restore a save

Export a save before you clear browser data or move to another browser.

1. Load the ROM on the [Test page](https://rom-weaver.com/test).
2. Create a save state or save the game's SRAM from the emulator menu.
3. Open **Settings**, then select **Storage**.
4. Find the ROM under **Emulator saves**.
5. Select **Export** and keep the downloaded ZIP file.

Restore the save in a browser that has the same ROM:

1. Open **Settings**, then select **Storage**.
2. Select **Import save**.
3. Choose the exported rom-weaver ZIP file.
4. Confirm that the ROM name and SHA-1 appear under **Emulator saves**.
5. Load the same ROM on the Test page.
6. Select **Load State** from the emulator menu.

Storage also accepts the older uncompressed JSON export.

To import a raw SRAM or save-state file:

1. Open **Settings**, then select **Storage**.
2. Select **Import save**.
3. Choose the file exported by the emulator settings.
4. Select **SRAM** or **Save state**.
5. Enter the ROM's 40-character SHA-1.

The import merges with any other save part for the same SHA-1. You can select **Delete** before the import if you want to test the complete restore process.

## Disable save storage

1. Open **Settings**.
2. Clear **Store emulator saves on this device**.
3. Select **Save**.

New save states and SRAM are not stored while this setting is off. Existing saves remain in **Storage** until you delete them.

Use the **Delete** action in **Storage** to remove one game. Use your browser's site-data controls to remove all rom-weaver data.

## Fix a game that does not start

- **No emulator core for this system:** use one of the systems listed above.
- **WebGL 2 is required:** enable hardware acceleration or use a browser that supports WebGL 2.
- **An archive does not load:** extract it yourself, then add the ROM file.
- **A save does not appear:** load the same ROM bytes. rom-weaver uses the ROM's SHA-1 checksum to find its saves.
- **An imported save does not load:** confirm that its SHA-1 matches the ROM shown in Storage.
- **The player has no sound on iPhone or iPad:** start the game inside the player. Safari requires that direct tap before it enables audio.

The emulator and its selected cores download from rom-weaver's own origin. Open the Test page once while online before you depend on the installed app offline.
