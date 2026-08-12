# Test a ROM in the browser

Use the Test page to play a local ROM or check an Apply result. The ROM stays on your device.

If you need a practice file, open [guided Test](https://rom-weaver.com/test?guide=test). It loads a tiny homebrew NES ROM from this project.

<!-- START doctoc -->
## Table of contents

- [Load a ROM](#load-a-rom)
- [Test an Apply result](#test-an-apply-result)
- [Switch games or stop](#switch-games-or-stop)
- [Use saves and fullscreen](#use-saves-and-fullscreen)
- [Fix a game that does not start](#fix-a-game-that-does-not-start)

<!-- END doctoc -->

## Load a ROM

1. Open [Test](https://rom-weaver.com/test).
2. Drop a ROM onto **0x01 Load a game**, or choose **Choose a ROM file**.
3. Use the controls inside the emulator player.

You can also add a ZIP or 7z archive. rom-weaver shows the extraction progress, then opens a supported ROM from the archive.

The Test page recognizes local ROMs for Atari 7800 and Lynx; Nintendo NES, Famicom Disk System, Game Boy, Game Boy Advance, Nintendo 64, Nintendo DS, and Super Nintendo; and Sega Game Gear, Master System, and Mega Drive or Genesis.

Apply can also send a detected Sega Saturn or Sony PlayStation result to Test.

## Test an Apply result

1. Apply the patch on the [Apply page](https://rom-weaver.com/apply).
2. Select **Open in the Test tab** after Apply finishes.
3. Play far enough to exercise the patched content.
4. Return to Apply and download the result if you have not downloaded it.

The **After applying** option can open Test automatically. Choose whether Apply also downloads the result. The **Show the test button after applying** setting controls the separate Test button.

An emulator test does not prove that every part of a patch works. Keep the clean original and test important paths on the target hardware when possible.

## Switch games or stop

Select **Choose another ROM** to replace the current game. Select **Stop** to unload the game and return to the Test start screen.

The emulator pauses when you leave the Test page or hide the browser tab. It resumes when you return.

## Use saves and fullscreen

Use the emulator menu to create a save state or save the game's SRAM. rom-weaver stores the save bytes in this browser. It does not store the ROM name or play history with them.

Use the fullscreen button above the player to enter or leave fullscreen. On iPhone and iPad, the button uses a full-viewport player because Safari does not offer fullscreen for this type of content.

Use your browser's site-data controls to remove all rom-weaver saves and cached emulator files.

## Fix a game that does not start

- **No emulator core for this system:** use one of the systems listed above.
- **WebGL 2 is required:** enable hardware acceleration or use a browser that supports WebGL 2.
- **An archive does not load:** extract it yourself, then add the ROM file.
- **A save does not appear:** load the ROM with the same filename and file size. Local ROMs use those two values to find their saves.
- **The player has no sound on iPhone or iPad:** start the game inside the player. Safari requires that direct tap before it enables audio.

The emulator and its selected cores download from rom-weaver's own origin. Open the Test page once while online before you depend on the installed app offline.
