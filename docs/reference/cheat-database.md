# Cheat database reference

<!-- START doctoc -->
## Table of contents

- [Supported systems](#supported-systems)
- [Delivery classes](#delivery-classes)
- [Match classes](#match-classes)
- [Data source](#data-source)
- [CLI database directory](#cli-database-directory)
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

## CLI database directory

The CLI reads the same files the webapp serves, from a directory on disk. It reads only the uncompressed `<system>.json` shards; it carries no brotli decoder.

| Path | Contents |
| --- | --- |
| `manifest.json` | Source name, source revision, source URL, and license. Optional. |
| `nes.json` | Nintendo Entertainment System shard. |
| `snes.json` | Super Nintendo Entertainment System shard. |
| `genesis.json` | Sega Genesis / Mega Drive shard. |
| `gameboy.json` | Game Boy shard. |
| `gameboy-color.json` | Game Boy Color shard. |
| `gameboyadvance.json` | Game Boy Advance shard. |
| `mastersystem.json` | Sega Master System shard. |
| `gamegear.json` | Sega Game Gear shard. |
| `sega32x.json` | Sega 32X shard. |

The directory comes from `--cheat-database DIR`, then `$ROM_WEAVER_CHEAT_DATABASE`, then a per-user default:

| Platform | Default |
| --- | --- |
| Linux and BSD | `$XDG_DATA_HOME/rom-weaver/cheats`, or `$HOME/.local/share/rom-weaver/cheats` |
| macOS | `$HOME/Library/Application Support/rom-weaver/cheats` |
| Windows | `%LOCALAPPDATA%\rom-weaver\cheats` |

A missing shard is an error naming the file it looked for. The CLI downloads nothing.

Copy the shards from the repository:

```bash
mkdir -p ~/.local/share/rom-weaver/cheats
cp packages/rom-weaver-webapp/public/cheats/manifest.json ~/.local/share/rom-weaver/cheats/
cp packages/rom-weaver-webapp/public/cheats/*.json ~/.local/share/rom-weaver/cheats/
```

Or regenerate them from a libretro checkout:

```bash
node scripts/import-libretro-cheats.mjs --output-dir ~/.local/share/rom-weaver/cheats
```

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

For the CLI task, see [Bake cheat codes into a ROM](../how-to/bake-cheat-codes.md).

For the browser task, see [Use cheats in the browser](../how-to/use-browser-cheats.md).

For the baking model, see [ROM cheats](../explanation/rom-cheats.md).
