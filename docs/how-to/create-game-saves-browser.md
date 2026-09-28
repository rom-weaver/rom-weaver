# Create game saves in the browser

Create a Super Mario World or Zelda save, edit its properties, and download a copy. For Pokémon, [edit a save made by the game](edit-gen3-saves.md).

<!-- START doctoc -->
## Table of contents

- [Create a fresh save](#create-a-fresh-save)
- [Load a schema pack](#load-a-schema-pack)
- [Start from an existing save](#start-from-an-existing-save)

<!-- END doctoc -->

## Create a fresh save

1. [Enable beta tools](browser-settings.md#enable-beta-tools), then open [Saves](https://rom-weaver.com/save-editor).
2. Under **New save**, select **Choose a game**, then select the game.
3. Select **Create save**. The editor opens the new file.
4. Change the properties you need. **Find a property** filters the fields. Fields outside the filter keep their pending edits.
5. Select **Preview changes**, then **Download edited copy**. Without edits, download the default save directly.
6. Select **Choose ROM and test**. On Test, add the ROM for that game. The editor opens the ROM with the save.

A new Zelda save has one file named `LINK`, three hearts, and two empty slots. Change **File 1 player name** to rename it.

A new Super Mario World save has one file at Yoshi's House and two empty slots.

## Load a schema pack

1. Open **Saves** and select **Load schema pack**.
2. Choose a local JSON schema pack. The editor checks the pack before accepting it.
3. In **New save**, select **Choose a game**, choose the pack's game, and select **Create save**.
4. Edit the properties and select **Download edited copy**.

For a pack without a fresh initializer, add an existing save after loading the pack. The pack stays active for the editor session. Reloading the page clears it.

The [schema reference](../reference/save-editor.md#runtime-schema-packs) defines the pack format and limits.

## Start from an existing save

Follow [Edit a game save](edit-gen3-saves.md) for recognition, previews, downloads, and testing with a matching ROM. The input stays unchanged.

The [support reference](../reference/save-editor.md) lists the games, editable fields, and generation limits. For terminal commands, use [Create saves with the CLI](create-game-saves-cli.md).
