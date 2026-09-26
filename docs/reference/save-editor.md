# Save Editor support

The Save Editor changes persistent game data. It does not change emulator save states.

<!-- START doctoc -->
## Table of contents

- [Supported games](#supported-games)
- [Editable fields](#editable-fields)
- [Read-only fields](#read-only-fields)
- [Recognition](#recognition)
- [Integrity rules](#integrity-rules)
- [Save generation](#save-generation)
- [Runtime schema packs](#runtime-schema-packs)
- [Save containers](#save-containers)
- [Physical save formats](#physical-save-formats)
- [Unsupported data](#unsupported-data)

<!-- END doctoc -->

## Supported games

| Game                                    | Platform         | Input             | Recognition limit                                       |
| --------------------------------------- | ---------------- | ----------------- | ------------------------------------------------------- |
| Pokémon Red                             | Game Boy         | Raw 32 KiB SRAM   | Shares its layout with Blue                             |
| Pokémon Blue                            | Game Boy         | Raw 32 KiB SRAM   | Shares its layout with Red                              |
| Pokémon Yellow                          | Game Boy         | Raw 32 KiB SRAM   | Uses the stored starter marker                          |
| Pokémon Gold                            | Game Boy Color   | Raw 32 KiB SRAM   | Shares its layout with Silver                           |
| Pokémon Silver                          | Game Boy Color   | Raw 32 KiB SRAM   | Shares its layout with Gold                             |
| Pokémon Crystal                         | Game Boy Color   | Raw 32 KiB SRAM   | English retail layout                                   |
| Pokémon Ruby                            | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with Sapphire                         |
| Pokémon Sapphire                        | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with Ruby                             |
| Pokémon Emerald                         | Game Boy Advance | Raw 128 KiB Flash | English retail layout                                   |
| Pokémon FireRed                         | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with LeafGreen                        |
| Pokémon LeafGreen                       | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with FireRed                          |
| Pokémon Diamond                         | Nintendo DS      | Raw 512 KiB save  | Uses the Diamond/Pearl block layout and profile version |
| Pokémon Pearl                           | Nintendo DS      | Raw 512 KiB save  | Uses the Diamond/Pearl block layout and profile version |
| Pokémon Platinum                        | Nintendo DS      | Raw 512 KiB save  | Uses the Platinum block layout and profile version      |
| Pokémon HeartGold                       | Nintendo DS      | Raw 512 KiB save  | The profile version selects the title                   |
| Pokémon SoulSilver                      | Nintendo DS      | Raw 512 KiB save  | The profile version selects the title                   |
| Pokémon Black                           | Nintendo DS      | Raw 512 KiB save  | Stored version and Black/White block checksums          |
| Pokémon White                           | Nintendo DS      | Raw 512 KiB save  | Stored version and Black/White block checksums          |
| Pokémon Black 2                         | Nintendo DS      | Raw 512 KiB save  | Stored version and sequel block checksums               |
| Pokémon White 2                         | Nintendo DS      | Raw 512 KiB save  | Stored version and sequel block checksums               |
| Super Mario World                       | Super Nintendo   | Raw 2 KiB SRAM    | Needs a valid primary or backup file checksum           |
| The Legend of Zelda: A Link to the Past | Super Nintendo   | Raw 8 KiB SRAM    | Needs a valid file marker and checksum                  |

The Pokémon handlers cover the English layouts named above. A matching file size alone does not prove support.

## Editable fields

| Family                    | Fields                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pokémon Generation I      | Trainer name, rival name, Trainer ID, occupied bag/PC item IDs and quantities, money, coins, play time, text speed, battle options, eight badges, and all 151 Pokédex owned/seen flags; Yellow adds Pikachu friendship, Pikachu Beach score, sound, and printer brightness |
| Pokémon Generation II     | Trainer name, Trainer ID, money, stored money, coins, play time, options, inventory, 16 badges, and all 251 Pokédex owned/seen flags                                                                                                                                       |
| Pokémon Generation III    | Trainer name, both Trainer IDs, gender, money, coins, play time including frames, options, bag and PC item IDs/quantities, eight badges, and all 386 Pokédex owned/seen flags; Emerald adds Battle Points                                                                  |
| Pokémon Generation IV     | Both Trainer IDs, gender, money, coins, play time, Battle Points, and badges (eight in Diamond/Pearl/Platinum, 16 in HeartGold/SoulSilver)                                                                                                                                 |
| Pokémon Generation V      | Trainer name, both Trainer IDs, gender, money, play time, Battle Points, eight badges, and inventory item IDs/quantities                                                                                                                                                   |
| Super Mario World         | Each file's 96 level flag bytes, 120 event flags, both players' submaps, animations, coordinates and tile pointers, four Switch Palaces, and exit count                                                                                                                    |
| Zelda: A Link to the Past | Player name, resources, health, equipment, inventory, bottles, magic, capacity upgrades, dungeon maps/compasses/keys, and progression for each file                                                                                                                        |

The Zelda resource fields cover rupees, bombs, and arrows. Its equipment fields cover swords, shields, armor, and gloves.

Generation I and II names accept up to seven supported game characters. The escapes `{` and `}` represent the PK and MN glyphs; each uses one game character.

Generation I and II item-list edits cover occupied slots. Generation II also exposes quantities for all 50 TMs and seven HMs, including zero. Key items have no stored quantity. Adding, removing, or reordering their item-list slots remains unsupported.

Generation III inventory fields include empty slots. Each slot has an item ID and quantity. Adding an item requires both values. Clearing a slot uses zero for both values. Item IDs use each game's numeric item table; a numeric ID does not prove that the item belongs in that pocket.

The Generation III slot counts, including PC storage, are 216 for Ruby/Sapphire, 236 for Emerald, and 216 for FireRed/LeafGreen. PC quantities remain unencrypted. Bag quantities retain the game's encryption.

Generation III owned flags also set all three seen copies. Clearing a seen flag also clears its owned flag. Previews include these related changes. Conflicting explicit assignments are rejected.

Numeric fields expose the ranges in `save export-schema`. A representable value does not establish a playable combination of progression flags, inventory, or player coordinates.

Zelda dungeon fields cover all 14 dungeon entries. Progression includes the game state, map icon, spawn point, saved world, and named story flags. A file name contains at most six supported ASCII characters.

## Read-only fields

| Family                 | Fields                                         |
| ---------------------- | ---------------------------------------------- |
| Pokémon Generation I   | Current PC box and formatted play-time summary |
| Pokémon Generation II  | Formatted play-time summary                    |
| Pokémon Generation III | Formatted play-time summary and security key   |
| Pokémon Generation IV  | Formatted play-time summary                    |

## Recognition

Recognition returns `recognized`, `ambiguous`, or `unsupported`. An ambiguous result needs an explicit game choice.

Red and Blue remain ambiguous without a selected game. The same rule applies to Gold/Silver, Ruby/Sapphire, and FireRed/LeafGreen.

Generation IV uses the block layout and stored game version after both save-block checks pass. Generation V checks the stored version and every primary block checksum, including the checksum table. Zelda uses its file marker and checksum. Super Mario World checks the file checksum and its backup.

## Integrity rules

- Generation I checks its complemented byte checksum, packed-decimal values, and inventory markers. Edits preserve the box storage and other bytes outside the edited fields and checksum.
- Generation II checks primary and backup additive checksums. Edits need both copies to pass.
- Generation III checks all 14 sections. It changes only the active slot and each affected section checksum.
- Generation IV checks redundant copies, block footers, counters, signatures, sizes, and CRC-16 values.
- Generation V repairs each changed block checksum, its table entry, and the checksum table itself. Other bytes, including backup storage, stay unchanged. Invalid primary checksums block editing.
- Super Mario World rewrites both copies of each edited file and preserves unedited files. One valid copy can repair its damaged twin.
- Zelda checks three primary files and their duplicate copies. It rewrites both copies only for an edited file.

Every write starts from a copy. The handler reparses the result before it returns the edited bytes.

## Save generation

Fresh generation is available for Super Mario World and The Legend of Zelda: A Link to the Past.

The repository schema catalog also limits fresh generation to the File 1 profiles for those two titles. Every other catalog profile requires a template.

Super Mario World starts with one file at Yoshi's House, the original initial movement flags, a matching backup, and two empty slots.

The Zelda save follows the original file initialization. Its image contains one file named `LINK`, three hearts, no acquired equipment, a valid backup, and two empty file slots. Its bytes follow the original game's file initialization. The browser shows only editable properties for a fresh save; the full document retains its read-only metadata.

Fresh Pokémon generation is unavailable because structure and checksum checks do not prove a playable game state. Earlier generated Pokémon files may pass those checks while missing game initialization data. Start with a save made by the matching game.

Template generation supports every editable game above. It validates an existing save, applies optional field assignments, and writes a separate file. Without assignments, the output is byte-identical to the template. Container wrappers are retained. A template cannot be the output path.

`save list-games` reports the game definitions and the IDs that support fresh generation. `save create` requires an output path unless it runs with `--dry-run`.

Procedures: [Create saves in the browser](../how-to/create-game-saves-browser.md) and [Create saves with the CLI](../how-to/create-game-saves-cli.md).

## Runtime schema packs

A schema pack adds fixed layouts without rebuilding the application. The CLI accepts `--schema PATH` on every `save` command. The browser accepts a local JSON pack through **Load schema pack**. The repository catalog and its profile counts are in [`data/save-schemas/README.md`](../../data/save-schemas/README.md).

The top-level object contains `schema_version` (`1`) and a nonempty `games` array. Optional `$schema` metadata identifies an authoring schema; the interpreter never fetches it. A game contains `id`, `name`, `platform`, `save_size`, and `fields`. Optional members are `description`, `signatures`, `checksums`, `mirrors`, and `generation`.

| Member     | Representation                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Field      | `id`, `label`, absolute byte `offset`, and `type`; optional `description`, `editable`, `min`, `max`, `bit`, `length`, `inverted`, and `copies` |
| Signature  | `offset` and a `bytes` array                                                                                                                   |
| Checksum   | `algorithm`, `offset`, optional `target`, optional `unit`, one `start`/`length` input or a `spans` array, and optional `exclude` ranges        |
| Mirror     | `source`, `target`, and `length`, all in bytes; optional `validate`                                                                            |
| Generation | A `fill` byte and a `patches` array of `offset`/`bytes` objects                                                                                |

Storage types are `u8`, `u16_le`, `u16_be`, `u24_le`, `u24_be`, `u32_le`, `u32_be`, `i8`, `i16_le`, `i16_be`, `i32_le`, `i32_be`, `bool`, `bit`, `ascii`, `bcd_le`, and `bcd_be`. Integers expose their full stored range unless `min` or `max` narrows it. BCD fields use one through four bytes and store two decimal digits per byte. Their byte order controls the order of the packed decimal byte pairs.

`bit` requires a bit index from 0 through 7. `bool` and `bit` can set `inverted` to exchange the stored zero and one meanings. `ascii` requires a byte length from 1 through 255. A field's `copies` array contains absolute offsets. An edit encodes the same value at the primary offset and every copy; reads use the primary offset. Copies do not validate equality before an edit.

Checksum algorithms are:

| Family                | Algorithms                                             | Stored result                                                                              |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Subtractive sum       | `sum8`, `sum16_le`, `sum16_be`, `sum32_le`, `sum32_be` | `target - accumulated`, modulo the result width                                            |
| Additive sum          | `add8`, `add16_le`, `add16_be`, `add32_le`, `add32_be` | `target + accumulated`, modulo the result width                                            |
| XOR                   | `xor8`, `xor16_le`, `xor16_be`, `xor32_le`, `xor32_be` | `target XOR accumulated`                                                                   |
| Modulo-255 complement | `sum8_mod255_complement`                               | `(byte sum modulo 255) XOR 255`                                                            |
| CRC-16                | `crc16_ccitt_false_le`                                 | CRC-CCITT-FALSE with polynomial `0x1021`, initial value `0xffff`, and little-endian output |

`target` defaults to zero. The algorithm suffix controls the output width and byte order. The optional `unit` controls how input bytes become values: `u8` by default, or `u16_le`, `u16_be`, `u32_le`, or `u32_be`. Input lengths must be divisible by the unit width. The modulo-255 and CRC algorithms accept only `u8` and no target.

A checksum uses either one `start`/`length` range or a nonempty `spans` array. Spans are concatenated in order and cannot overlap. Each `exclude` range must fit inside one input span. Excluded bytes contribute zero while their positions remain in the input. Exclusion ranges cannot overlap.

An edit writes primary fields and their copies, repairs checksums, then copies mirror ranges. A mirror validates source and target equality by default. `validate: false` accepts a different target before an edit but still replaces it from the source afterward. Generation fills the image, applies patches, repairs checksums, then copies mirrors. Generation is unavailable when its initializer is absent. A structurally valid initializer does not prove that the game can load it.

The interpreter rejects unknown properties and versions, duplicate IDs, invalid ranges, and conflicting writes. Packs cannot replace built-in games. Limits are 2 MiB per pack, 64 games, 4,096 field storage locations per game, and 8 MiB per raw save. Primary field offsets and copies both count as storage locations. A save can contain at most 128 64-KiB sections. Layouts without signatures or checksums require an explicit game choice. Packs cannot execute code or fetch network resources.

Game IDs contain 1–128 lowercase ASCII letters, digits, underscores, or hyphens and start with a letter or digit. Field IDs contain dot-separated nonempty segments of ASCII letters, digits, underscores, or hyphens. Other text values have a 1,024-byte limit. Each signatures, checksums, mirrors, patches, copies, spans, or exclusions array contains at most 4,096 entries. Total signature, checksum-input, and mirror-source work across a pack cannot exceed 64 MiB.

Catalog profiles are separate game definitions for fixed slots, players, regions, or storage variants. Profile count is not title count. Integer and BCD fields use their stored range by default. A stored value or combination can still be invalid during play.

`save export-schema` still exports the fields of an inspected save. Its output is not an importable layout pack because it omits byte storage and integrity rules.

## Save containers

The editor removes these wrappers before recognition and puts them back on output. The wrapper metadata survives unchanged. If the container has a checksum, the editor updates it to match the changed save.

| Container                         | Extensions     | Layout                                                      | Checksum             |
| --------------------------------- | -------------- | ----------------------------------------------------------- | -------------------- |
| GameShark SP save (SharkPortSave) | `.sps`, `.xps` | Length-prefixed strings, a 28-byte game block, the raw save | Recomputed on output |
| GameShark SP snapshot             | `.gsv`         | 1072-byte header, 128 KiB raw flash                         | None                 |
| DeSmuME save                      | `.dsv`         | Raw save, then a 122-byte footer                            | None                 |
| DexDrive memory card              | `.gme`         | 3904-byte header, 128 KiB raw card                          | None                 |
| Virtual Game Station memory card  | `.mem`, `.vgs` | 64-byte header, 128 KiB raw card                            | None                 |

A GameShark SP checksum that does not match produces a warning, not a rejection. A DeSmuME footer whose padded size disagrees with the file produces a warning.

`save identify` reports the container under `container`, the raw save size under `save_size`, and the file size under `file_size`.

## Physical save formats

An unsupported save still gets a physical format guess from its raw size. The report lists every format below that matches, under `potential_formats`. A size match alone does not prove the platform. A format with a signature check sorts first and sets `signature_checked`.

| Platform                         | Formats                                                                                                             | Signature                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Game Boy and Game Boy Color      | Battery SRAM 512 B (MBC2), 2 KiB, 8 KiB, 32 KiB, 128 KiB                                                            | None                                                  |
| Game Boy Advance                 | EEPROM 512 B, EEPROM 8 KiB, SRAM 32 KiB, Flash 64 KiB, Flash 128 KiB                                                | None                                                  |
| Nintendo Entertainment System    | Battery WRAM 8 KiB                                                                                                  | None                                                  |
| Super Nintendo                   | Battery SRAM 2 KiB, 8 KiB, 32 KiB, 64 KiB, 128 KiB                                                                  | None                                                  |
| Nintendo 64                      | EEPROM 512 B, EEPROM 2 KiB, SRAM 32 KiB, FlashRAM 128 KiB, Controller Pak 32 KiB, Mupen64Plus combined save 290 KiB | None                                                  |
| Nintendo DS                      | 512 B, 8 KiB, 64 KiB, 128 KiB, 256 KiB, 512 KiB, 1 MiB, 8 MiB, 32 MiB                                               | None                                                  |
| Sega Genesis and Mega Drive      | Cartridge SRAM 8 KiB, 32 KiB, 64 KiB                                                                                | None                                                  |
| Sega Master System and Game Gear | Cartridge SRAM 8 KiB, 32 KiB                                                                                        | None                                                  |
| Sony PlayStation                 | Memory card 128 KiB                                                                                                 | `MC` at offset 0                                      |
| Sega Saturn                      | Internal backup RAM 32 KiB, 64 KiB (16-bit dump)                                                                    | `BackUpRam Format` header, contiguous or on odd bytes |

The Mupen64Plus combined save is the libretro core's `.srm`: EEPROM, four Controller Paks, SRAM, then FlashRAM, 296,960 bytes in total. PSP saves are per-game directories and have no entry.

## Unsupported data

Pokémon generations after V and other Zelda games remain unsupported. The editor does not change party Pokémon or box contents. Generation IV and V Pokédex data and Generation IV inventory remain unsupported. Fields absent from a game's schema have no editing path; this is not unrestricted byte editing.

A physical format match or a removed container does not make a save editable. The built-in games in [Supported games](#supported-games) and profiles from an explicitly loaded schema pack have an editor. Emulator save states are rejected.
