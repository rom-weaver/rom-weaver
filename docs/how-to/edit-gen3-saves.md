# Edit a Generation III save

Use the Save Editor to inspect and change an English retail Pokémon Ruby, Sapphire, Emerald, FireRed, or LeafGreen game save. The first version changes the trainer name, gender, money, and badges. It does not change inventory or Pokémon data.

The [Save Editor development guide](../development/save-editor.md) describes the handler design and contributor flow.

<!-- START doctoc -->
## Table of contents

- [Check the input file](#check-the-input-file)
- [Use the browser](#use-the-browser)
- [Use the CLI](#use-the-cli)
- [Read the recognition result](#read-the-recognition-result)
- [Understand the safety checks](#understand-the-safety-checks)
- [Supported and unsupported data](#supported-and-unsupported-data)
- [Keep the original file](#keep-the-original-file)
- [Related](#related)

<!-- END doctoc -->

## Check the input file

Use a game save file, not an emulator save state. A game save is the SRAM file that the game writes to its cartridge save memory. The supported Generation III layout is 128 KiB.

An emulator save state stores CPU, memory, and emulator state. It is not a game save and the Save Editor rejects it. Export the game's SRAM or battery save from the emulator instead.

The first version supports only these English retail layouts:

- Pokémon Ruby;
- Pokémon Sapphire;
- Pokémon Emerald;
- Pokémon FireRed;
- Pokémon LeafGreen.

It does not claim support for Japanese, European, Australian, Korean, or other regional layouts. Do not infer regional support from a matching file size.

## Use the browser

1. Open Tools, then select Save Editor.
2. Add the 128 KiB game save file.
3. Select the game when the page asks for one.
4. Read the recognition result and the active-slot status.
5. Change only the fields that the page marks as editable.
6. Review the change summary.
7. Download the new save file.

The browser keeps the input file unchanged. It downloads an edited copy after the checks pass. Keep the input file until the edited save works in the target emulator or cartridge hardware.

## Use the CLI

Identify a save without changing it:

```bash
rom-weaver save identify game.sav --game pokemon-emerald
```

Show the active slot, section checks, and supported fields:

```bash
rom-weaver save inspect game.sav --game pokemon-emerald
```

Read one field:

```bash
rom-weaver save get game.sav trainer.money --game pokemon-emerald
```

Preview a change without writing a file:

```bash
rom-weaver save set game.sav trainer.money=999999 \
  --game pokemon-emerald --dry-run
```

Write an edited copy to a new path:

```bash
rom-weaver save set game.sav trainer.money=999999 \
  --game pokemon-emerald --output edited.sav
```

Print the generic field schema:

```bash
rom-weaver save export-schema game.sav --game pokemon-emerald
```

Use `pokemon-ruby`, `pokemon-sapphire`, `pokemon-emerald`, `pokemon-firered`, or `pokemon-leafgreen` as the game ID. Ruby and Sapphire share a save layout. FireRed and LeafGreen share a save layout. The first version does not infer either pair from a ROM identity.

Pass `--force` only when the output path is an explicit path that you want to replace. The input path is never an output path by default.

## Read the recognition result

The editor reports one of these outcomes:

- **Recognized:** the selected game matches the save layout and all 14 sections in the active slot pass their checksums.
- **Recognized with a game choice:** the bytes fit a paired layout, but the editor needs your choice of Ruby or Sapphire, or FireRed or LeafGreen.
- **Partially recoverable:** one slot passes and the other slot is empty or damaged. The editor shows the valid slot but does not allow edits.
- **Corrupt or unsupported:** no complete valid slot exists, or the file does not match a supported English retail layout.

Emerald can identify itself from its save checksum layout. Ruby/Sapphire and FireRed/LeafGreen need a manual game choice when the editor has no ROM identity.

## Understand the safety checks

Generation III saves contain two rotating save slots. Each slot contains 14 logical sections. Every section has an ID, a checksum, a signature, and a save counter.

The editor checks both slots, chooses the newest complete valid slot, and refuses to write when it cannot prove a complete active slot. It recomputes checksums for changed sections and writes a valid edited copy. It preserves the source bytes outside the supported edits.

The editor can edit a valid slot when the unused backup slot is empty. It keeps the empty slot unchanged and shows a warning.

The editor does not repair a damaged section. Keep the original and restore it from a known-good backup before you try an edit again.

## Supported and unsupported data

The first editable fields are:

- trainer name, in the game's original character encoding;
- trainer gender;
- money;
- gym badge flags.

These fields are read-only:

- trainer IDs;
- play time;
- the Emerald or FireRed/LeafGreen security key.

The first version does not edit inventory, item quantities, item IDs, party Pokémon, boxed Pokémon, or other save sections. It also does not edit emulator save states, regional layouts, or partially corrupt saves.

## Keep the original file

Store the original save in a separate backup location. Test the downloaded copy before you replace the save file used by an emulator. If the game does not load the edited copy, restore the original and report the recognition result, game choice, and checksum status.

## Related

- [Save Editor development guide](../development/save-editor.md): handler architecture and the eight-step contributor flow.
- [Test a ROM in the browser](test-roms-in-browser.md): emulator SRAM and save state import and export.
- [CLI reference](../reference/cli.md): command output, flags, and exit codes.
