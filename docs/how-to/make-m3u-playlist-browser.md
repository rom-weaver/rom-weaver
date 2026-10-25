# Make an M3U playlist in the browser

Build an `.m3u` playlist for a multi-disc game so an emulator such as RetroArch can change discs. The discs stay on your device.

<!-- START doctoc -->
## Table of contents

- [Build the playlist](#build-the-playlist)
- [Change the order](#change-the-order)
- [Bundle the discs with the playlist](#bundle-the-discs-with-the-playlist)
- [Start from Extract](#start-from-extract)

<!-- END doctoc -->

## Build the playlist

1. Open [M3U playlist](https://rom-weaver.com/m3u-playlist).
2. Add every disc of the game: `.cue`, `.gdi`, `.chd`, `.iso`, `.pbp`, or another disc file. For a `.cue` or `.gdi`, add the track files it names too.
3. Check **Disc order**. Names such as `Disc 1`, `(Disc 2)`, and `.disc02` set the order; the track files appear below the list as included with their disc.
4. Enter a filename in **Playlist** and keep the **M3U playlist** format.
5. Select **Build playlist**.

Each playlist line is one disc's file name, one per line. Save the `.m3u` in the same folder as the discs. Then open the `.m3u` in RetroArch; its disc control switches between the listed discs.

## Change the order

Select the up or down button on a disc card to move it. Select the remove button to leave a disc out. Reordering never renames or changes the disc files.

## Bundle the discs with the playlist

Choose **ZIP with discs** in **Playlist** to download one ZIP holding the playlist, the discs, and the track files their sheets name. Unzip it into one folder and open the `.m3u`.

## Start from Extract

When [Extract](extract-files-browser.md) finishes with several discs, such as a multi-disc PBP, select **Make M3U playlist** to carry those discs over to this tool.

For the terminal command, see [Make a playlist from the CLI](cli-playlist.md).
