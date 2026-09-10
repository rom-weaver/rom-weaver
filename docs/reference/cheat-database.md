# Cheat database reference

<!-- START doctoc -->
## Table of contents

- [Supported systems](#supported-systems)
- [Delivery classes](#delivery-classes)
- [Match classes](#match-classes)
- [Data source](#data-source)
- [CLI database directory](#cli-database-directory)
- [Storage and network behavior](#storage-and-network-behavior)
- [Shard file](#shard-file)
- [Preserved source fields](#preserved-source-fields)
- [Bundles](#bundles)

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

The CLI reads the same shards the webapp serves, from a directory on disk.

| Path | Contents |
| --- | --- |
| `nintendo-nintendo-entertainment-system.json.br` | Nintendo Entertainment System shard. |
| `nintendo-super-nintendo-entertainment-system.json.br` | Super Nintendo Entertainment System shard. |
| `sega-mega-drive-genesis.json.br` | Sega Genesis / Mega Drive shard. |
| `sega-master-system-mark-iii.json.br` | Sega Master System shard. |
| `sega-game-gear.json.br` | Sega Game Gear shard. |
| `sega-32x.json.br` | Sega 32X shard. |
| `nintendo-game-boy.json.br` | Game Boy shard. |
| `nintendo-game-boy-color.json.br` | Game Boy Color shard. |
| `nintendo-game-boy-advance.json.br` | Game Boy Advance shard. |
| `manifest.json` | Source name, source revision, source URL, and license. Optional. |

Each shard may also be a plain `<slug>.json`, or carry the `cheats-<slug>` prefix the repository's own data directory uses. When several forms are present the CLI reads the `.json.br` copy.

The directory comes from `--cheat-database DIR`, then `$ROM_WEAVER_CHEAT_DATABASE`, then `cheats` inside the [identify database directory](cli.md#identify-database-directory). `ROM_WEAVER_DATA_DIR` moves the base the same way it moves the identify data.

`rom-weaver setup` installs the shards there along with the identify packs; they travel in the same archive. A missing shard is an error naming the file it looked for and the command that installs it.

Regenerating them from a libretro checkout works too:

```bash
node scripts/import-libretro-cheats.mjs --output-dir ~/.local/share/rom-weaver/identify/cheats
```

## Storage and network behavior

Each shard is one identify data asset (`assets/identify-cheats-<platform slug>.json`) listed in the identify index with its size and SHA-256. The app loads only the detected or selected platform.

A shard belongs to the same pack group as its platform's identify pack. The background warm-up downloads the default group, the Settings page installs optional groups, and the CLI `identify database install-group` installs the same shards natively. An uncached shard is fetched on demand when the Cheats section opens.

All nine shards are in the default group. Together they add about 2 MB to the default group download and about 17 MB of decoded JSON to the browser's cache storage.

The service worker verifies each shard's SHA-256 before it stores it, and the parsing worker verifies it again before use. A shard that fails either check reports the database as unavailable.

A dedicated browser worker parses each shard and restores the fields the file leaves out (see [Shard file](#shard-file)). The initial JavaScript bundle does not contain the database.

The hosted app requests shards only from its own origin. It makes no runtime request to Libretro.

## Shard file

A shard is one JSON document: `schemaVersion`, `system`, `sourceRevision`, and `games`. Each game carries its `id`, `title`, `normalizedTitle`, `regions`, `revisions`, `sourceFiles`, `checksums`, and `cheats`.

The file stores each cheat record without the values a reader derives. The CLI and the browser worker restore them the same way:

| Record field | Source in the file |
| --- | --- |
| `system` | the shard's `system` |
| `gameId` | the game's `id` |
| `sourceRevision` | the shard's `sourceRevision` |
| `sourceFile` | `sourceFiles[sourceFile]` of the game (the file stores an index) |
| `description` | stored when the source record has a `desc` field, else `Cheat <sourceIndex + 1>` |
| `rawFields.desc`, `rawFields.code` | `description` and `rawCode` |
| `rawFields.enable` | stored only when it is not `false` |
| `id` | `cheat_` plus the first 24 hex digits of SHA-256 over `system`, `gameId`, `codeKind`, and the raw fields without `enable`, as key-sorted JSON, joined by NUL bytes |

Record IDs do not depend on the file layout, so a bundle written against an earlier layout still names the same records.

## Preserved source fields

Each imported record keeps the original code, every `cheatN_*` value, unknown fields, source file, source index, and source revision. A source record without a `cheatN_enable` line reads as `enable = false`.

ROMWeaver does not synthesize RetroArch memory handlers. It only decodes the native code fields the source record already carries.

## Bundles

A bundle's optional top-level `cheats` array records a selection: each entry carries the record `id`, the `source` database and `revision`, the `description`, and a `code` snapshot.

`bundle create --cheat` and `patch apply --emit-bundle` write the array. Applying the bundle resolves each entry by `id` against the database at `--cheat-database`, and falls back to its `code` snapshot when the database is absent. An unresolvable entry fails the apply unless it is marked `optional`.

For the field list, see [CLI reference](cli.md#bundle-cheats).

For the CLI task, see [Bake cheat codes into a ROM](../how-to/bake-cheat-codes.md).

For the browser task, see [Use cheats in the browser](../how-to/use-browser-cheats.md).

For the baking model, see [ROM cheats](../explanation/rom-cheats.md).
