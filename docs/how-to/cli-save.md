# Edit a game save from the CLI

Use the `save` commands to inspect a game save, preview a field change, and write an edited copy. The examples use Pokémon Emerald. The [Save Editor reference](../reference/save-editor.md) lists every supported game and its editable fields. For browser steps, see [Edit a Generation III save](edit-gen3-saves.md#use-the-browser).

Keep a backup before you edit. Use the game's persistent save file, not an emulator save state.

<!-- START doctoc -->
## Table of contents

- [Identify and inspect the save](#identify-and-inspect-the-save)
- [Read and preview a field change](#read-and-preview-a-field-change)
- [Write and check the edited copy](#write-and-check-the-edited-copy)

<!-- END doctoc -->

## Identify and inspect the save

Identify the file without changing it:

```bash
rom-weaver save identify game.sav
```

If recognition is ambiguous, select the game you played with `--game`. For Generation III, the accepted IDs are `pokemon-ruby`, `pokemon-sapphire`, `pokemon-emerald`, `pokemon-firered`, and `pokemon-leafgreen`.

Inspect the active slot, integrity results, and fields:

```bash
rom-weaver save inspect game.sav --game pokemon-emerald
```

Use only fields marked editable. If a damaged backup blocks editing, restore a known-good save before proceeding. The editor does not repair damaged sections.

## Read and preview a field change

Read the current money value:

```bash
rom-weaver save get game.sav trainer.money --game pokemon-emerald
```

Preview an edit without writing a file:

```bash
rom-weaver save set game.sav trainer.money=999999 \
  --game pokemon-emerald --dry-run
```

Check the reported field and new value. You can pass several `FIELD=VALUE` assignments; the command validates all of them before it changes the copy.

To inspect field IDs, types, and limits as a schema:

```bash
rom-weaver save export-schema game.sav --game pokemon-emerald
```

## Write and check the edited copy

Write to a new path:

```bash
rom-weaver save set game.sav trainer.money=999999 \
  --game pokemon-emerald --output edited.sav
```

An existing output needs `--force`. The output must not name the input file. Without `--output`, the command chooses a free sibling name such as `game-edited.sav`.

Read the value from the new file:

```bash
rom-weaver save get edited.sav trainer.money --game pokemon-emerald
```

Load the edited copy in the target emulator or on cartridge hardware. Check the changed field before replacing your working save. Keep the original backup.
