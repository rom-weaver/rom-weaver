# Create game saves with the CLI

Use `save create` to write a fresh game save or a copy of an existing save template. The command validates the save before it writes the output.

<!-- START doctoc -->
## Table of contents

- [Create a fresh Zelda save](#create-a-fresh-zelda-save)
- [Use an existing save as a template](#use-an-existing-save-as-a-template)

<!-- END doctoc -->

## Create a fresh Zelda save

List the supported game IDs and their generation support:

```bash
rom-weaver save list-games
```

Create a file at a new output path:

```bash
rom-weaver save create --game zelda-a-link-to-the-past -o link.srm
```

Inspect the generated file:

```bash
rom-weaver save inspect link.srm
```

The file contains one `LINK` slot with three hearts and no acquired equipment. The other two slots are empty. Fresh generation is unavailable for games that have no verified initializer.

## Use an existing save as a template

Create a validated copy without changing any properties:

```bash
rom-weaver save create --template game.sav -o copy.sav
```

Add `--game GAME_ID` if the template matches more than one game. For example:

```bash
rom-weaver save create --template red.sav --game pokemon-red -o copy.sav
```

Preview a field change before creating the output:

```bash
rom-weaver save create --template game.sav trainer.money=999999 --dry-run
```

Create the edited file:

```bash
rom-weaver save create --template game.sav trainer.money=999999 -o rich.sav
```

The output must differ from the template. A container wrapper stays in place; use the template's extension for the output. `--force` permits replacement of an existing output file. It never permits replacement of the template.

Inspect the output, then import it through the emulator's battery-save import control and load the game to check the result.

The [support reference](../reference/save-editor.md) lists the games and fields. For the browser procedure, use [Create saves in the browser](create-game-saves-browser.md).
