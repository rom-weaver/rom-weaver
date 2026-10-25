# Make an M3U playlist from the CLI

Build an `.m3u` playlist for a multi-disc game with `rom-weaver playlist`, so an emulator such as RetroArch can change discs.

<!-- START doctoc -->
## Table of contents

- [Write a playlist](#write-a-playlist)
- [Control the order](#control-the-order)
- [Copy the game into a frontend's folder](#copy-the-game-into-a-frontends-folder)
- [Bundle the discs in a ZIP](#bundle-the-discs-in-a-zip)
- [Rename the discs](#rename-the-discs)
- [Write bare file names](#write-bare-file-names)

<!-- END doctoc -->

## Write a playlist

Repeat `--input` for each disc, in any order:

```bash
rom-weaver playlist \
  -i 'Game (Disc 2).cue' -i 'Game (Disc 1).cue' \
  -o Game.m3u
```

The command orders the discs by the number in names such as `Disc 1`, `(Disc 2)`, and `.disc02`, then writes one line per disc. Each line is the disc's path relative to the playlist. Track files that a given `.cue` or `.gdi` names are not listed as discs of their own.

Leave out `-o` to write the playlist beside the first disc. It takes the disc's name without the disc number, such as `Game.m3u`.

It never overwrites an existing output.

Most emulators name save files after the playlist. Saves made while playing one disc directly keep that disc's name, so rename them to match the playlist.

## Control the order

`--no-sort` lists the discs exactly as given:

```bash
rom-weaver playlist --no-sort -i disc-b.chd -i disc-a.chd -o Game.m3u
```

Names without a disc number follow the numbered ones, in name order.

## Copy the game into a frontend's folder

Give a folder as `--output`, and pick the `--layout` your frontend expects:

```bash
rom-weaver playlist \
  -i 'Game (Disc 1).cue' -i 'Game (Disc 2).cue' \
  -o roms/psx/ --layout folder
```

This copies the playlist, the discs, and their track files into `roms/psx/Game/`, and makes any folder that is missing. Use `folder` for MinUI and muOS, `m3u-folder` for ES-DE and RetroDECK, and the default `flat` for RetroArch and Batocera. The [CLI reference](../reference/cli.md#playlist) shows where each layout puts the files.

The source files stay where they are. The command stops before copying anything when a file it would write already exists.

## Bundle the discs in a ZIP

An `--output` ending in `.zip` holds the playlist, the discs, and the track files their sheets name, side by side:

```bash
rom-weaver playlist -i 'Game (Disc 1).cue' -i 'Game (Disc 2).cue' -o Game.zip
```

Unzip it into one folder and open the `.m3u`.

When every disc has tracks with the same names, such as `track01.bin` beside each `.gdi`, add `--layout disc-folders`. Each disc then gets its own folder in the ZIP.

## Rename the discs

`--rename` names the copied discs `<game> (Disc N)` in playlist order, and their track files to match:

```bash
rom-weaver playlist --rename --name 'Final Fantasy VII' \
  -i ff7.disc01.cue -i ff7.disc02.cue -i ff7.disc03.cue \
  -o roms/psx/
```

The copies are `Final Fantasy VII (Disc 1).cue` and so on, and each copied `.cue` names its renamed track files. Without `--name`, the game name comes from the first disc's name. `--rename` works with a folder or `.zip` output, never on the original files.

## Write bare file names

`--flat` writes each disc's file name alone, for a playlist you will save in the same folder as the discs:

```bash
rom-weaver playlist --flat -i discs/a.chd -i discs/b.chd -o Game.m3u
```

Batocera hides a playlist's discs from its game list only when each line is a bare file name.

For every flag, see [CLI reference](../reference/cli.md#playlist). To start from a multi-disc PBP, [extract it](work-with-archives.md#extract-an-archive) first.
