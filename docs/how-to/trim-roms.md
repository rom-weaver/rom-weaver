# Trim a ROM in the browser

Use the Trim page to cut the padding off a ROM and save a smaller copy. Your
original file is not changed.

<!-- START doctoc -->
## Table of contents

- [Turn the Trim page on](#turn-the-trim-page-on)
- [Add the ROM](#add-the-rom)
- [Choose the output](#choose-the-output)
- [Run the trim](#run-the-trim)
- [Keep the original](#keep-the-original)
- [Related](#related)

<!-- END doctoc -->

## Turn the Trim page on

Trim is a beta tool, so it is hidden until you ask for it.

1. Open **Settings** from the top navigation.
2. Tick **Enable beta tools (Trim and Tools)**.
3. Save. **Trim** and **Tools** appear beside Apply and Create.

The setting is listed in [Webapp settings](../reference/webapp-settings.md#beta-tools-and-onboarding).

## Add the ROM

1. Open [Trim](https://rom-weaver.com/trim).
2. Drop a ROM on the drop zone, or click it to pick a file.
3. Wait while the card finishes reading and checksumming.

Trim accepts NDS-family ROMs (`.nds`, `.dsi`, `.srl`), GBA ROMs, 3DS images,
XISO images, and GameCube or Wii images that can be scrubbed to RVZ. You can
drop an archive or container and rom-weaver will look inside it.

The [trim support table](../reference/formats.md#trim-support) is the
authoritative list.

## Choose the output

The output card names the new file. It gets a `(trimmed)` suffix by default,
and you can edit the name.

Pick the output type in the same card:

- the raw extension keeps the trimmed bytes uncompressed;
- a ROM-specific format such as CHD, RVZ, or Z3DS compresses the result;
- `.zip` or `.7z` packs it into an archive.

## Run the trim

Click **Trim ROM**. A confirmation appears first and repeats two facts:

- the trimmed copy is saved as a new download, and your original file is not
  changed;
- keep the original, because some patches and tools need the untrimmed ROM,
  and restored padding may not be byte-identical.

Confirm, wait for the run to finish, then save the result.

## Keep the original

Trim removes bytes. The browser Trim page does not put them back, so the
untrimmed file is your only exact copy. Patch authors usually target the
untrimmed ROM, so patch first and trim afterwards.

To restore padding, use `trim --revert` from the command line:
[Trim a ROM from the CLI](cli-trim.md).

## Related

- [Choosing a compression format](../explanation/compression-formats.md): when
  trimming beats compressing.
- [Supported formats](../reference/formats.md#trim-support): every trim target.
