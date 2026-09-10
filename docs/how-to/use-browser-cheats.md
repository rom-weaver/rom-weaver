# Use cheats in the browser

Use the Apply page to bake cheats into a ROM.

1. Add the original ROM to the Apply page.
2. Open the Cheats section after ROMWeaver identifies the system.
3. Check the game title, region, revision, and match label.
4. Search the list.
5. Select the cheats that you want.
6. Review each selected cheat's delivery badge.
7. Start Apply and save the output ROM.

An exact match means a known ROM checksum matched a known release record. A title match does not prove the ROM revision.

ROM cheats show **ROM cheat · Baked into output**. ROMWeaver applies them after earlier patch steps.

Unsupported cheats show **Unsupported** and their reason. ROMWeaver cannot select them.

Resolve a reported ROM-write conflict before Apply. ROMWeaver does not let the last selected cheat overwrite another selected cheat without a warning.

<!-- START doctoc -->
## Table of contents

- [Add a code manually](#add-a-code-manually)
- [Use the database offline](#use-the-database-offline)

<!-- END doctoc -->

## Add a code manually

1. Select **Add code manually** in the Cheats section.
2. Enter the code and an optional description.
3. Keep automatic system and code-type detection, or select an override.
4. Review the detected system, code type, and delivery result.
5. Add the code when the result is correct.

A code with `?` or `X` placeholders needs a value that ROMWeaver cannot supply, so it shows as unsupported.

## Use the database offline

Cheat shards install with the built-in identify packs. Leave the app open while online until the offline warm-up in Settings reports the built-in systems as installed.

Opening a system's cheat list once while online also caches that shard. ROMWeaver does not contact Libretro or another third-party server at runtime.

For the baking model, see [ROM cheats](../explanation/rom-cheats.md).

For supported systems and database facts, see [Cheat database reference](../reference/cheat-database.md).
