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
- [Save the selected ROM cheats as a patch](#save-the-selected-rom-cheats-as-a-patch)
- [Create a patch from cheat codes](#create-a-patch-from-cheat-codes)
- [Use the database offline](#use-the-database-offline)

<!-- END doctoc -->

## Add a code manually

1. Select **Add code manually** in the Cheats section.
2. Enter the code and an optional description.
3. Keep automatic system and code-type detection, or select an override.
4. Review the detected system, code type, and delivery result.
5. Add the code when the result is correct.

A code with `?` or `X` placeholders needs a value that ROMWeaver cannot supply, so it shows as unsupported.

## Save the selected ROM cheats as a patch

1. Turn on the cheats that you want in the Cheats section.
2. Select **Save as patch**.
3. Save the downloaded patch file.

ROMWeaver picks the patch format the ROM's size allows: IPS below IPS's 16 MiB addressing limit, BPS above it, and xdelta for a ROM past 256 MiB, which neither IPS nor BPS covers. The status line names the created file and counts the baked cheats.

## Create a patch from cheat codes

1. Add the original ROM to the Create page.
2. Select **Cheat codes** on the Modified step.
3. Enter one code per line, or join codes with `+`.
4. Review the detected system, code type, and write count.
5. Check each code's write list and its `compare` badge.
6. Select the patch format and file name on the Output step.
7. Select **Create & download patch**.

**Pick from the cheat database** offers the same cheats the Apply page does. A code that does not resolve to ROM writes blocks the run and states its reason.

## Use the database offline

Cheat shards install with the built-in identify packs. Leave the app open while online until the offline warm-up in Settings reports the built-in systems as installed.

Opening a system's cheat list once while online also caches that shard. ROMWeaver does not contact Libretro or another third-party server at runtime.

For the baking model, see [ROM cheats](../explanation/rom-cheats.md).

For supported systems and database facts, see [Cheat database reference](../reference/cheat-database.md).
