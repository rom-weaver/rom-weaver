# Make an M3U playlist in the browser

Use Make playlist to list every disc of a multi-disc game in an `.m3u` file, so an emulator such as RetroArch can change discs. Download the playlist in any browser. In Chrome or Edge on a computer, you can also save it into the game's folder and rename the discs to match.

<!-- START doctoc -->
## Table of contents

- [Download a playlist](#download-a-playlist)
- [Save it into the game's folder](#save-it-into-the-games-folder)
- [Rename the discs](#rename-the-discs)

<!-- END doctoc -->

## Download a playlist

1. Open [Make playlist](https://rom-weaver.com/create-m3u-playlist).
2. Drop the discs of one game, with the track files their sheets name, or select **Open game folder** and pick the folder that holds them.
3. Check the disc list. Discs are ordered by the number in names such as `Disc 1`, `(Disc 2)`, and `.disc02`. Track files such as `.bin` are not listed as discs of their own.
4. Type a **Game name** to name the playlist, or keep the name taken from the first disc.
5. Select **Download**, then save the `.m3u` in the folder that holds the discs.

When the folder holds discs of more than one game, choose the game in the **Game** list.

When the discs are in subfolders of the folder you opened, each line includes the subfolder. Save the playlist in the folder you opened, not beside the discs.

Most emulators name save files after the playlist. Saves made while playing one disc directly keep that disc's name, so rename them to match the playlist.

## Save it into the game's folder

Saving into a folder needs Chrome or Edge on a computer. Other browsers show **Save into folder** disabled; download the playlist instead.

1. Select **Open game folder** and pick the game's folder.
2. Select **Save into folder**, and allow the browser to change files in that folder when it asks.

The playlist is saved next to the folder's other files. It never replaces a file that already has its name, even one that differs only in upper and lower case.

## Rename the discs

Renaming the discs also needs Chrome or Edge on a computer. In other browsers, the option is disabled; [rename the discs with the command line](cli-playlist.md#rename-the-discs) instead, which copies them under the new names.

1. Select **Open game folder** and pick the game's folder.
2. Type the **Game name**.
3. Turn on **Rename the discs**. The list shows each file's new name, `<game> (Disc N)` in playlist order.
4. Select **Rename discs and save playlist**, and allow the browser to change files in that folder when it asks.

Track files are renamed with their disc, and each `.cue` is rewritten to name its renamed tracks. A file that shares a disc's name, such as a LibCrypt `.sbi` beside a PlayStation `.cue`, is renamed with it. Other files in the folder stay as they are.

Before renaming, the page checks the folder again. Nothing is renamed when:

- a disc and its track files are not all in the folder itself;
- the disc numbers in the names do not run from 1 to the number of discs;
- another file already has one of the new names;
- a file changed after the list was shown.

If a rename fails partway, the page puts the files back under their old names and names any file it could not. Keep the tab open until the rename finishes. If the tab closes during a rename, the folder can be left half renamed:

- some files keep a temporary name such as `ff7.disc01.rw-1a2b3c4d-0.bin`, which is the old name `ff7.disc01.bin` with `.rw-` and a code added;
- some files already have their new name;
- a `.cue` can still name its old track files;
- the playlist can be empty.

Rename the files by hand until each `.cue` names its track files as they are, delete an empty playlist, and then make the playlist again.
