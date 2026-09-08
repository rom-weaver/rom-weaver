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

| Database system | Rust decoders |
| --- | --- |
| Nintendo Entertainment System | Game Genie, Pro Action Replay |
| Super Nintendo Entertainment System | Game Genie, Pro Action Replay |
| Sega Genesis / Mega Drive | Game Genie, Pro Action Replay |
| Sega 32X | Game Genie, Pro Action Replay |
| Sega Master System | Game Genie, Pro Action Replay |
| Sega Game Gear | Game Genie, Pro Action Replay |
| Game Boy | Game Genie, GameShark |
| Game Boy Color | Game Genie, GameShark |
| Game Boy Advance | Xploder ROM-patch codes |

ROMWeaver does not offer database systems outside this table.

## Delivery classes

| Class | Meaning | Output |
| --- | --- | --- |
| ROM cheat | Every subcode decodes to a cartridge ROM address | Ordered ROM write step |
| Unsupported | The code cannot bake into the ROM | Disabled, with a reason |

An unsupported row shows its reason and cannot be selected. Reasons include: the code targets runtime memory, some of its linked subcodes target runtime memory, the entry needs a parameter value, or the entry is a structured RetroArch memory entry rather than a native code.

## Match classes

| Match | Meaning |
| --- | --- |
| Exact | A known checksum matched a canonical release record and its cheat set. |
| Title | A normalized title matched, but the ROM checksum did not match. |
| Manual | The user selected a game record. |
| None | ROMWeaver found no automatic game match. |

Title and manual matches can target another region or revision.

## Data source

The shards derive from the `cht/` directories of `libretro/libretro-database` at the same pinned revision as the identify packs. The identify index (`index.json`, `sources.libretro.revision`) records that revision, and the Cheats section shows it.

Source [libretro/libretro-database](https://github.com/libretro/libretro-database)

License CC-BY-SA-4.0

The generated shards are an adapted database under CC-BY-SA-4.0. ROMWeaver's code license does not replace that data license. ShareAlike applies to redistributed adaptations of this database.

The distribution includes the full license text and the source revision in the third-party notices.

Game titles and release checksums come from the same Libretro DAT files that build the platform's identify pack, so a cheat match and an identify match agree on the ROM.

The build drops, before packaging, every record that can never bake: structured RetroArch entries, placeholder codes, and codes whose literal address is provably runtime memory for that system.

## Storage and network behavior

Each shard is one identify data asset (`assets/identify-cheats-<platform slug>.json`) listed in the identify index with its size and SHA-256. The app loads only the detected or selected platform.

A shard belongs to the same pack group as its platform's identify pack. The background warm-up downloads the default group, the Settings page installs optional groups, and the CLI `identify database install-group` installs the same shards natively. An uncached shard is fetched on demand when the Cheats section opens.

All nine shards are in the default group. Together they add about 4.5 MB to the default group download and about 58 MB of decoded JSON to the browser's cache storage.

The service worker verifies each shard's SHA-256 before it stores it, and the parsing worker verifies it again before use. A shard that fails either check reports the database as unavailable.

A dedicated browser worker parses each shard. The initial JavaScript bundle does not contain the database.

The hosted app requests shards only from its own origin. It makes no runtime request to Libretro.

## Preserved source fields

Each imported record keeps the original code, every `cheatN_*` value, unknown fields, source file, source index, and source revision.

ROMWeaver does not synthesize RetroArch memory handlers. It only decodes the native code fields the source record already carries.

## Bundle status

Bundles do not store cheat selections in this release. Stable cheat IDs, source records, revisions, and delivery classes provide the data for later bundle support.

For the browser task, see [Use cheats in the browser](../how-to/use-browser-cheats.md).

For the baking model, see [ROM cheats](../explanation/rom-cheats.md).
