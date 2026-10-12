# Create game saves in the browser

Create a Super Mario World or Zelda save, edit its properties, and download a copy. For Pokémon, [edit a save made by the game](edit-gen3-saves.md).

<!-- START doctoc -->
## Table of contents

- [Create a fresh save](#create-a-fresh-save)
- [Start from an existing save](#start-from-an-existing-save)

<!-- END doctoc -->

## Create a fresh save

1. [Enable beta tools](browser-settings.md#enable-beta-tools), then open [Saves](https://rom-weaver.com/save-editor).
2. Under **New save**, select **Choose a game**, then select the game.
3. Leave **Files to edit** on **All files**. Select **File 1 only** only if you want raw numeric codes for Zelda.
4. Select **Create save**. The editor opens the new file.
5. Change the properties you need. **Find a property** filters the fields. Fields outside the filter keep their pending edits.
6. Select **Preview changes**, then **Download edited copy**. Without edits, download the default save directly.
7. Select **Choose ROM and test**. On Test, add the ROM for that game. The editor opens the ROM with the save.

A new Zelda save has one file named `LINK`, three hearts, and two empty slots. Change **File 1 player name** to rename it.

A new Super Mario World save has one file at Yoshi's House and two empty slots.

Both choices write the same bytes. The choice matters for Zelda: **All files** offers named choices such as equipment, and **File 1 only** offers raw numeric codes instead. For Super Mario World both choices open the same properties. [The reference](../reference/save-editor.md#save-generation) has the details.

## Start from an existing save

Follow [Edit a game save](edit-gen3-saves.md) for recognition, previews, downloads, and testing with a matching ROM. The input stays unchanged.

The [support reference](../reference/save-editor.md) lists the games, editable fields, and generation limits. For terminal commands, use [Create saves with the CLI](create-game-saves-cli.md).
