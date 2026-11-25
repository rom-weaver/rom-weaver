# Make an M3U playlist in the browser

Use Make playlist to list every disc of a multi-disc game in an `.m3u` file, so an emulator such as RetroArch can change discs. In any browser, download a ZIP that holds the playlist and the discs, renamed and arranged for your frontend if you choose. In Chrome or Edge on a computer, you can also save the playlist into the game's folder and rename the discs where they are.

<!-- START doctoc -->
## Table of contents

- [Download the playlist and discs as a ZIP](#download-the-playlist-and-discs-as-a-zip)
- [Save it into the game's folder](#save-it-into-the-games-folder)
- [Rename the discs](#rename-the-discs)

<!-- END doctoc -->

<a id="download-a-playlist"></a>

<a id="download-the-discs-as-a-zip"></a>

## Download the playlist and discs as a ZIP

The ZIP works in every browser. It holds the playlist, copies of the discs, and the track files their `.cue` or `.gdi` sheets name. Other files in the folder, such as a LibCrypt `.sbi`, are left out. The discs you picked are not changed.

1. Open [Make playlist](https://rom-weaver.com/create-m3u-playlist).
2. Drop the discs of one game, with the track files their sheets name, or select **Open game folder** and pick the folder that holds them.
3. Check the disc list. Discs are ordered by the number in names such as `Disc 1`, `(Disc 2)`, and `.disc02`. Track files such as `.bin` are not listed as discs of their own.
4. Type a **Game name** to name the playlist and the ZIP, or keep the name taken from the first disc. Discs named only by number, such as `Disc 1.cue`, give no name, so type one.
5. To rename the discs, turn on **Rename the discs to `<game>` (Disc N)**. Each `.cue` or `.gdi` in the ZIP is rewritten to name its renamed track files.
6. Choose the **Layout** your frontend reads:
   - **Beside the discs** (RetroArch, Batocera, Recalbox): the playlist and discs side by side.
   - **In a game folder** (MinUI, muOS): a `<game>` folder that holds the playlist and discs.
   - **In a .m3u folder** (ES-DE, RetroDECK): a `<game>.m3u` folder that holds the playlist and discs.
   - **One folder per disc** (igir): the playlist beside one folder for each disc.
7. Select **Download `<game>.zip`**. Select **Cancel** to stop; no ZIP is saved.
8. Unzip it where your frontend reads games.

When the folder holds discs of more than one game, choose the game in the **Game** list.

When the discs are in subfolders of the folder you opened, each line of the playlist includes the subfolder.

Most emulators name save files after the playlist. Saves made while playing one disc directly keep that disc's name, so rename them to match the playlist.

The ZIP is stored without compression. The page builds it in the browser's own storage before the download starts, so it needs free space about the size of the discs. If storage runs out, the page reports it and removes the partial ZIP.

## Save it into the game's folder

Saving into a folder needs Chrome or Edge on a computer. Other browsers show **Save into folder** disabled; download the ZIP instead.

1. Select **Open game folder** and pick the game's folder.
2. Select **Save into folder**, and allow the browser to change files in that folder when it asks.

The playlist is saved next to the folder's other files. It never replaces a file that already has its name, even one that differs only in upper and lower case.

## Rename the discs

Renaming the files in the folder needs Chrome or Edge on a computer, the game's folder opened, every disc in that folder itself, and the **Beside the discs** layout. In every other case, turning on **Rename the discs** renames copies in the ZIP instead; see [Download the playlist and discs as a ZIP](#download-the-playlist-and-discs-as-a-zip).

1. Select **Open game folder** and pick the game's folder.
2. Type the **Game name**.
3. Turn on **Rename the discs to `<game>` (Disc N)**. The list shows each file's new name, `<game> (Disc N)` in playlist order.
4. Select **Rename discs and save playlist**, and allow the browser to change files in that folder when it asks. Select **Download `<game>.zip`** instead to leave the files as they are.

Track files are renamed with their disc, and each `.cue` or `.gdi` is rewritten to name its renamed tracks. A file that shares a disc's name, such as a LibCrypt `.sbi` beside a PlayStation `.cue`, is renamed with it. Other files in the folder stay as they are.

Before renaming, the page checks the folder again. Nothing is renamed when:

- a disc and its track files are not all in the folder itself;
- the disc numbers in the names do not run from 1 to the number of discs;
- a disc is an `.mds` image (which can name its `.mdf` internally);
- another file already has one of the new names;
- a file changed after the list was shown.

If a rename fails partway, the page puts the files back under their old names and names any file it could not. Keep the tab open until the rename finishes. If the tab closes during a rename, the folder can be left half renamed:

- some files keep a temporary name such as `ff7.disc01.rw-1a2b3c4d-0.bin`, which is the old name `ff7.disc01.bin` with `.rw-` and a code added;
- some files already have their new name;
- a `.cue` can still name its old track files;
- the playlist can be empty.

Rename the files by hand until each `.cue` names its track files as they are, delete an empty playlist, and then make the playlist again.
