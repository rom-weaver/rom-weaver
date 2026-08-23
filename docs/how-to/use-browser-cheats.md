# Use cheats in the browser

Use the Apply page to bake ROM cheats or export RAM cheats for RetroArch.

1. Add the original ROM to the Apply page.
2. Open the Cheats section after ROMWeaver identifies the system.
3. Check the game title, region, revision, and match label.
4. Search the list or select a delivery filter.
5. Select the cheats that you want.
6. Review each selected cheat's delivery badge.
7. Start Apply and save the output.

ROMWeaver produces only a `.cht` file when the workflow has only runtime cheats. It produces one ZIP when the workflow has ROM changes and runtime cheats. The ZIP contains the ROM output and the `.cht` file.

An exact match means a known ROM checksum matched a known release record. A title match does not prove the ROM revision.

ROM cheats show **ROM cheat · Baked into output**. ROMWeaver applies them after earlier patch steps.

RAM cheats show **RAM cheat · Requires emulator cheat file**. ROMWeaver writes these entries to a RetroArch `.cht` file.

A mixed cheat contains linked ROM and RAM subcodes. ROMWeaver keeps the complete entry together in the `.cht` file.

Resolve a reported ROM-write conflict before Apply. ROMWeaver does not let the last selected cheat overwrite another selected cheat without a warning.

<!-- START doctoc -->
## Table of contents

- [Load the cheat file in RetroArch](#load-the-cheat-file-in-retroarch)
- [Import a local RetroArch cheat file](#import-a-local-retroarch-cheat-file)
- [Add a code manually](#add-a-code-manually)
- [Use the database offline](#use-the-database-offline)

<!-- END doctoc -->

## Load the cheat file in RetroArch

1. Start the matching game with a compatible core.
2. Open the RetroArch Quick Menu.
3. Open Cheats.
4. Choose **Load Cheat File (Replace)**.
5. Select the exported `.cht` file.
6. Apply the loaded cheats.

Core support differs. ROMWeaver preserves native and structured fields, but it cannot test every core or emulator.

See the [RetroArch cheat guide](https://docs.libretro.com/guides/cheat-codes/).

## Import a local RetroArch cheat file

1. Add the matching ROM to the Apply page.
2. Select **Import RetroArch .cht** in the Cheats section.
3. Choose a local `.cht` file for the detected system.
4. Review each imported entry and its delivery badge.
5. Select the entries that you want.

ROMWeaver reads the file in the browser worker. It does not upload the file, ROM, checksum, filename, or selections.

The import keeps native codes, structured memory fields, and unknown entry fields. It does not select imported entries automatically.

## Add a code manually

1. Select **Add code manually** in the Cheats section.
2. Enter the code and an optional description.
3. Keep automatic system and code-type detection, or select an override.
4. Review the detected system, code type, and delivery method.
5. Add the code when the result is correct.

A code with `?` or `X` placeholders needs a value. ROMWeaver preserves the placeholder and keeps the entry disabled.

## Use the database offline

Open a system's cheat list once while online. The service worker caches that system shard after a successful load.

An uncached system shard is unavailable offline. ROMWeaver does not contact Libretro or another third-party server at runtime.

For the delivery model, see [ROM cheats and runtime cheats](../explanation/rom-and-runtime-cheats.md).

For supported systems and database facts, see [Cheat database reference](../reference/cheat-database.md).
