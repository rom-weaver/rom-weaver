# Cheat database reference

<!-- START doctoc -->
## Table of contents

- [Supported systems](#supported-systems)
- [Delivery classes](#delivery-classes)
- [Match classes](#match-classes)
- [Data source](#data-source)
- [Storage and network behavior](#storage-and-network-behavior)
- [Preserved source fields](#preserved-source-fields)
- [Bundle status](#bundle-status)

<!-- END doctoc -->

## Supported systems

| Database system | Rust decoder | ROM baking | Runtime export |
| --- | --- | --- | --- |
| Nintendo Entertainment System | NES | Yes | Yes |
| Super Nintendo Entertainment System | SNES | Yes | Yes |
| Sega Genesis / Mega Drive | Genesis | Yes | Yes |
| Game Boy | Game Boy | Yes | Yes |
| Game Boy Color | Compatible Game Boy codes | Yes | Yes |

ROMWeaver does not offer database systems outside this table.

## Delivery classes

| Class | Output |
| --- | --- |
| ROM-bakeable | Ordered ROM write step |
| Runtime | RetroArch `.cht` entry |
| Mixed | Complete original `.cht` entry |
| Requires parameter | Disabled until a value editor exists |
| Unsupported | Disabled with a reason |

## Match classes

| Match | Meaning |
| --- | --- |
| Exact | A known checksum matched a canonical release record and its cheat set. |
| Title | A normalized title matched, but the ROM checksum did not match. |
| Manual | The user selected a game record. |
| None | ROMWeaver found no automatic game match. |

Title and manual matches can target another region or revision.

## Data source

The generated database derives from `libretro/libretro-database` at revision `4968f556a0bf749378901086646b78bc78703b88`.

Source [libretro/libretro-database](https://github.com/libretro/libretro-database)

License CC-BY-SA-4.0

The generated shards are an adapted database under CC-BY-SA-4.0. ROMWeaver's code license does not replace that data license.

The distribution includes the full license text, the source revision, and separate attribution.

The normalized shards are adaptations under CC-BY-SA-4.0. ShareAlike applies to redistributed adaptations of this database. It does not change ROMWeaver's separate software license.

## Storage and network behavior

The app ships one small manifest and one shard per supported system. It loads only the detected or selected system.

A dedicated browser worker parses each shard. The initial JavaScript bundle does not contain the database.

The hosted app requests shards only from its own origin. It makes no runtime request to Libretro.

The service worker caches a shard after its first successful load. The shard then works offline with that app version.

## Preserved source fields

Each imported record keeps the original code, every `cheatN_*` value, unknown fields, source file, source index, and source revision.

The exporter renumbers selected entries from zero. It sets each selected entry to enabled and preserves the other fields.

ROMWeaver does not synthesize RetroArch memory handlers. It only preserves tested native or structured source entries.

## Bundle status

Bundles do not store cheat selections in this release. Stable cheat IDs, source records, revisions, and delivery classes provide the data for later bundle support.

For the browser task, see [Use cheats in the browser](../how-to/use-browser-cheats.md).

For the delivery model, see [ROM cheats and runtime cheats](../explanation/rom-and-runtime-cheats.md).
