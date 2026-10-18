# Make an M3U playlist from the CLI

Build an `.m3u` playlist for a multi-disc game with `rom-weaver playlist`, so an emulator such as RetroArch can change discs.

<!-- START doctoc -->
## Table of contents

- [Write a playlist](#write-a-playlist)
- [Control the order](#control-the-order)
- [Bundle the discs in a ZIP](#bundle-the-discs-in-a-zip)
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

It never overwrites an existing output.

## Control the order

`--no-sort` lists the discs exactly as given:

```bash
rom-weaver playlist --no-sort -i disc-b.chd -i disc-a.chd -o Game.m3u
```

Names without a disc number follow the numbered ones, in name order.

## Bundle the discs in a ZIP

An `--output` ending in `.zip` holds the playlist, the discs, and the track files their sheets name, side by side:

```bash
rom-weaver playlist -i 'Game (Disc 1).cue' -i 'Game (Disc 2).cue' -o Game.zip
```

Unzip it into one folder and open the `.m3u`.

## Write bare file names

`--flat` writes each disc's file name alone, for a playlist you will save in the same folder as the discs:

```bash
rom-weaver playlist --flat -i discs/a.chd -i discs/b.chd -o Game.m3u
```

For every flag, see [CLI reference](../reference/cli.md#playlist). To start from a multi-disc PBP, [extract it](work-with-archives.md#extract-an-archive) first.
