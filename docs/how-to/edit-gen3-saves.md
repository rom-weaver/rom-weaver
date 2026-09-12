# Edit a Generation III save

Use the Save Editor to inspect and change an English retail Pokémon Ruby, Sapphire, Emerald, FireRed, or LeafGreen game save. The editor changes the trainer name, gender, money, and badges. It does not change inventory or Pokémon data.

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

Use a game save file, not an emulator save state. A game save contains the persistent data that the game writes to cartridge save memory. These Generation III games use 128 KiB Flash saves, not SRAM.

An emulator save state stores CPU, memory, and emulator state. It is not a game save and the Save Editor rejects it. Export the game's SRAM or battery save from the emulator instead.

GameShark SP exports also work. The Save Editor reads a SharkPortSave file (`.sps`, `.xps`) and a GameShark SP snapshot (`.gsv`). It edits the game save inside the wrapper. The output keeps the wrapper metadata and recomputes the SharkPortSave checksum. The `.gsv` wrapper has no checksum. [Save containers](../reference/save-editor.md#save-containers) lists every wrapper the editor removes.

For Generation III, the editor supports these English retail layouts:

- Pokémon Ruby;
- Pokémon Sapphire;
- Pokémon Emerald;
- Pokémon FireRed;
- Pokémon LeafGreen.

It does not claim support for Japanese, European, Australian, Korean, or other regional layouts. Do not infer regional support from a matching file size.

## Use the browser

1. Open More, then select Save Editor. The Save Editor is a beta tool, so turn on beta tools in Settings first.
2. Add the 128 KiB game save file.
3. Select the game when the page asks for one.
4. Read the recognition result and the active-slot status.
5. Change only the fields that the page marks as editable.
6. Review the change summary.
7. Download the new save file.

The browser keeps the input file unchanged. It downloads an edited copy after the checks pass. Keep the input file until the edited save works in the target emulator or cartridge hardware.

## Use the CLI

[Edit a game save from the CLI](cli-save.md) covers identification, field inspection, previews, and writing an edited copy.

## Read the recognition result

The editor reports one of these outcomes:

- **Recognized:** the selected game matches the save layout and all 14 sections in the active slot pass their checksums.
- **Recognized with a game choice:** the bytes fit a paired layout, but the editor needs your choice of Ruby or Sapphire, or FireRed or LeafGreen.
- **Valid with a warning:** one slot passes and the other is empty. The editor permits edits and preserves the empty slot.
- **Partially recoverable:** one slot passes and the other is damaged. The editor shows the valid slot but does not allow edits.
- **Corrupt or unsupported:** no complete valid slot exists, or the file does not match a supported English retail layout.

Emerald can identify itself from its save checksum layout. Ruby/Sapphire and FireRed/LeafGreen need a manual game choice. These handlers do not use a ROM SHA-1 to distinguish the paired games.

## Understand the safety checks

Generation III saves contain two rotating save slots. Each slot contains 14 logical sections. Every section has an ID, a checksum, a signature, and a save counter.

The editor checks both slots, chooses the newest complete valid slot, and refuses to write when it cannot prove a complete active slot. It recomputes checksums for changed sections and writes a valid edited copy. It preserves the source bytes outside the supported edits.

The editor can edit a valid slot when the unused backup slot is empty. It keeps the empty slot unchanged and shows a warning.

The editor does not repair a damaged section. Keep the original and restore it from a known-good backup before you try an edit again.

## Supported and unsupported data

The editable fields are:

- trainer name, in the game's original character encoding;
- trainer gender;
- money;
- gym badge flags.

These fields are read-only:

- trainer IDs;
- play time;
- the Emerald or FireRed/LeafGreen security key.

The editor does not edit inventory, item quantities, item IDs, party Pokémon, boxed Pokémon, or other save sections. It also does not edit emulator save states, regional layouts, or partially corrupt saves.

## Keep the original file

Store the original save in a separate backup location. Test the downloaded copy before you replace the save file used by an emulator. If the game does not load the edited copy, restore the original and report the recognition result, game choice, and checksum status.

## Related

- [Save Editor development guide](../development/save-editor.md): handler architecture and the eight-step contributor flow.
- [Test a ROM in the browser](test-roms-in-browser.md): emulator SRAM and save state import and export.
- [CLI reference](../reference/cli.md): command output, flags, and exit codes.
