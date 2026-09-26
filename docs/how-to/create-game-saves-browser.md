# Create game saves in the browser

Create a Super Mario World or Zelda save, edit its properties, and download a copy. To edit a Pokémon save, start with a save made by the game. Earlier fresh Pokémon files passed editor checks but did not have a confirmed playable game state.

<!-- START doctoc -->
## Table of contents

- [Create a fresh save](#create-a-fresh-save)
- [Start from an existing save](#start-from-an-existing-save)

<!-- END doctoc -->

## Create a fresh save

1. Open **Saves**. Enable beta tools in Settings if needed.
2. In **New save**, select **Choose a game**, then select the game.
3. Select **Create save**. The editor opens the new file.
4. Change the properties you need. **Find a property** filters the fields. Fields outside the filter keep their pending edits.
5. Select **Download edited copy**. The default save can also be downloaded without edits.
6. Select **Choose ROM and test**. On Test, add the ROM for that game. The editor opens the ROM with the save.

A new Zelda save has one file named `LINK`, three hearts, and two empty slots. Change **File 1 player name** to give the file a different name.

A new Super Mario World save has one file at Yoshi's House and two empty slots.

## Start from an existing save

1. Add the game's battery save or SRAM file to the Save Editor. Use this path for Pokémon games.
2. Select the game if recognition needs a choice.
3. Change the required properties and select **Preview changes**.
4. Select **Download edited copy** after the preview passes.

The input stays unchanged. To test the result, select **Choose ROM and test** and add the matching ROM on Test. The browser keeps one pending save on this device across reloads until a ROM opens with it or you select **Discard save**. If Test already has a compatible ROM, **Test save in ROM** reloads it directly. The check covers the game system and a linked ROM hash when one is available. Check the game title yourself when there is no linked hash.

The [support reference](../reference/save-editor.md) lists the games, editable fields, and generation limits. For terminal commands, use [Create saves with the CLI](create-game-saves-cli.md).
