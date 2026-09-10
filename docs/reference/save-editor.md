# Save Editor support

The Save Editor changes persistent game data. It does not change emulator save states.

<!-- START doctoc -->
## Table of contents

- [Supported games](#supported-games)
- [Editable fields](#editable-fields)
- [Read-only fields](#read-only-fields)
- [Recognition](#recognition)
- [Integrity rules](#integrity-rules)
- [Save containers](#save-containers)
- [Physical save formats](#physical-save-formats)
- [Unsupported data](#unsupported-data)

<!-- END doctoc -->

## Supported games

| Game | Platform | Input | Recognition limit |
| --- | --- | --- | --- |
| Pokémon Gold | Game Boy Color | Raw 32 KiB SRAM | Shares its layout with Silver |
| Pokémon Silver | Game Boy Color | Raw 32 KiB SRAM | Shares its layout with Gold |
| Pokémon Crystal | Game Boy Color | Raw 32 KiB SRAM | English retail layout |
| Pokémon Ruby | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with Sapphire |
| Pokémon Sapphire | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with Ruby |
| Pokémon Emerald | Game Boy Advance | Raw 128 KiB Flash | English retail layout |
| Pokémon FireRed | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with LeafGreen |
| Pokémon LeafGreen | Game Boy Advance | Raw 128 KiB Flash | Shares its layout with FireRed |
| Pokémon HeartGold | Nintendo DS | Raw 512 KiB save | The profile version selects the title |
| Pokémon SoulSilver | Nintendo DS | Raw 512 KiB save | The profile version selects the title |
| The Legend of Zelda: A Link to the Past | Super Nintendo | Raw 8 KiB SRAM | Needs a valid file marker and checksum |

The Pokémon handlers cover the English layouts named above. A matching file size alone does not prove support.

## Editable fields

| Family | Fields |
| --- | --- |
| Pokémon Generation II | Money and 16 badge flags |
| Pokémon Generation III | Trainer name, gender, money, and badge flags |
| Pokémon HeartGold and SoulSilver | Gender, money, and 16 badge flags |
| Zelda: A Link to the Past | Resources, health, equipment, selected inventory items, pendants, and crystals for each file |

The Zelda resource fields cover rupees, bombs, and arrows. Its equipment fields cover swords, shields, armor, and gloves.

## Read-only fields

| Family | Fields |
| --- | --- |
| Pokémon Generation II | Trainer name, Trainer ID, and play time; Crystal also shows its Secret ID |
| Pokémon Generation III | Trainer IDs, play time, and the security key |
| Pokémon HeartGold and SoulSilver | Trainer IDs and play time |
| Zelda: A Link to the Past | Player name for each file |

## Recognition

Recognition returns `recognized`, `ambiguous`, or `unsupported`. An ambiguous result needs an explicit game choice.

Gold and Silver remain ambiguous without a selected game. The same rule applies to Ruby/Sapphire and FireRed/LeafGreen.

HeartGold and SoulSilver use the stored game version after both save-block checks pass. Zelda uses its file marker and checksum.

## Integrity rules

- Generation II checks primary and backup additive checksums. Edits need both copies to pass.
- Generation III checks all 14 sections. It changes only the active slot and each affected section checksum.
- HeartGold and SoulSilver check both redundant copies, block footers, counters, signatures, sizes, and CRC-16 values.
- Zelda checks three primary files and their duplicate copies. It rewrites both copies only for an edited file.

Every write starts from a copy. The handler reparses the result before it returns the edited bytes.

## Save containers

The editor removes these wrappers before recognition and puts them back on output. The wrapper bytes survive unchanged; only the raw save inside changes.

| Container | Extensions | Layout | Checksum |
| --- | --- | --- | --- |
| GameShark SP save (SharkPortSave) | `.sps`, `.xps` | Length-prefixed strings, a 28-byte game block, the raw save | Recomputed on output |
| GameShark SP snapshot | `.gsv` | 1072-byte header, 128 KiB raw flash | None |
| DeSmuME save | `.dsv` | Raw save, then a 122-byte footer | None |
| DexDrive memory card | `.gme` | 3904-byte header, 128 KiB raw card | None |
| Virtual Game Station memory card | `.mem`, `.vgs` | 64-byte header, 128 KiB raw card | None |

A GameShark SP checksum that does not match produces a warning, not a rejection. A DeSmuME footer whose padded size disagrees with the file produces a warning.

`save identify` reports the container under `container`, the raw save size under `save_size`, and the file size under `file_size`.

## Physical save formats

An unsupported save still gets a physical format guess from its raw size. The report lists every format below that matches, under `potential_formats`. A size match alone does not prove the platform. A format with a signature check sorts first and sets `signature_checked`.

| Platform | Formats | Signature |
| --- | --- | --- |
| Game Boy and Game Boy Color | Battery SRAM 512 B (MBC2), 2 KiB, 8 KiB, 32 KiB, 128 KiB | None |
| Game Boy Advance | EEPROM 512 B, EEPROM 8 KiB, SRAM 32 KiB, Flash 64 KiB, Flash 128 KiB | None |
| Nintendo Entertainment System | Battery WRAM 8 KiB | None |
| Super Nintendo | Battery SRAM 2 KiB, 8 KiB, 32 KiB, 64 KiB, 128 KiB | None |
| Nintendo 64 | EEPROM 512 B, EEPROM 2 KiB, SRAM 32 KiB, FlashRAM 128 KiB, Controller Pak 32 KiB, Mupen64Plus combined save 290 KiB | None |
| Nintendo DS | 512 B, 8 KiB, 64 KiB, 128 KiB, 256 KiB, 512 KiB, 1 MiB, 8 MiB, 32 MiB | None |
| Sega Genesis and Mega Drive | Cartridge SRAM 8 KiB, 32 KiB, 64 KiB | None |
| Sega Master System and Game Gear | Cartridge SRAM 8 KiB, 32 KiB | None |
| Sony PlayStation | Memory card 128 KiB | `MC` at offset 0 |
| Sega Saturn | Internal backup RAM 32 KiB, 64 KiB (16-bit dump) | `BackUpRam Format` header, contiguous or on odd bytes |

The Mupen64Plus combined save is the libretro core's `.srm`: EEPROM, four Controller Paks, SRAM, then FlashRAM, 296,960 bytes in total. PSP saves are per-game directories and have no entry.

## Unsupported data

Diamond, Pearl, Platinum, other Pokémon generations, and other Zelda games remain unsupported. The editor does not change party Pokémon or boxes.

A physical format match or a removed container does not make a save editable. Only the games in [Supported games](#supported-games) have an editor. Emulator save states are rejected.
