# Save Editor support

The Save Editor changes persistent game data. It does not change emulator save states.

<!-- START doctoc -->
## Table of contents

- [Supported games](#supported-games)
- [Editable fields](#editable-fields)
- [Read-only fields](#read-only-fields)
- [Recognition](#recognition)
- [Integrity rules](#integrity-rules)
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

## Unsupported data

Diamond, Pearl, Platinum, other Pokémon generations, and other Zelda games remain unsupported. The editor does not change party Pokémon or boxes.

The editor rejects container headers and emulator-specific trailers. Export a raw game save before inspection.
