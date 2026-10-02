# Save schema source catalog

The application defines its save layouts and editing rules as typed Rust under [`crates/rom-weaver-core/src/save/schema/catalog/`](../../crates/rom-weaver-core/src/save/schema/catalog). This directory keeps the source attribution and license for those definitions. It does not contain runtime schema packs.

The default registry includes 129 profiles: the original seven game-family definitions and 107 additional profiles. Existing IDs remain stable, including IDs that end in `-schema`. A profile selects one fixed region, slot, player, or storage variant.

| Original catalog module | Games |
| --- | --- |
| `builtin_pokemon_gen1.rs` | Red, Blue, Yellow |
| `builtin_pokemon_gen2.rs` | Gold, Silver, Crystal |
| `builtin_pokemon_gen3.rs` | Ruby, Sapphire, Emerald, FireRed, LeafGreen |
| `builtin_pokemon_gen4.rs` | Diamond, Pearl, Platinum, HeartGold, SoulSilver |
| `builtin_pokemon_gen5.rs` | Black, White, Black 2, White 2 |
| `builtin_super_mario_world.rs` | Super Mario World |
| `builtin_zelda_alttp.rs` | The Legend of Zelda: A Link to the Past |

| Catalog module | Titles | Profiles | Fields | Creation |
| --- | ---: | ---: | ---: | --- |
| `donkey_kong_country.rs` | 1 | 6 | 24 | Template only |
| `donkey_kong_country_2_diddy_s_kong_quest.rs` | 1 | 3 | 30 | Template only |
| `donkey_kong_country_3_dixie_kong_s_double_trouble.rs` | 1 | 3 | 42 | Template only |
| `final_fantasy_nes.rs` | 1 | 1 | 311 | Template only |
| `mario_party.rs` | 1 | 1 | 15 | Template only |
| `mario_party_2.rs` | 1 | 1 | 11 | Template only |
| `pokemon_generation_i.rs` | 3 | 3 | 1,031 | Template only |
| `pokemon_generation_ii.rs` | 3 | 3 | 1,806 | Template only |
| `secret_of_mana.rs` | 1 | 4 | 52 | Template only |
| `solatorobo_red_the_hunter.rs` | 1 | 1 | 16 | Template only |
| `super_mario_64.rs` | 1 | 4 | 180 | Template only |
| `super_mario_kart.rs` | 1 | 1 | 364 | Template only |
| `super_mario_rpg.rs` | 1 | 4 | 68 | Template only |
| `super_mario_world.rs` | 1 | 3 | 699 | File 1 fresh; all profiles template |
| `super_metroid.rs` | 1 | 6 | 96 | Template only |
| `wario_land_super_mario_land_3.rs` | 1 | 1 | 210 | Template only |
| `zelda_a_link_to_the_past.rs` | 1 | 3 | 381 | File 1 fresh; all profiles template |
| `f_zero.rs` | 1 | 1 | 663 | Template only |
| `game_and_watch_gallery_3.rs` | 1 | 1 | 10 | Template only |
| `kirbys_adventure.rs` | 1 | 9 | 27 | Template only |
| `actraiser.rs` | 1 | 3 | 9 | Template only |
| `capcom_gba_eeprom.rs` | 2 | 2 | 70 | Template only |
| `chrono_trigger.rs` | 1 | 3 | 6 | Template only |
| `diddy_kong_racing.rs` | 1 | 1 | 9 | Template only |
| `donkey_kong_land.rs` | 1 | 1 | 15 | Template only |
| `f_zero_maximum_velocity.rs` | 1 | 1 | 12 | Template only |
| `f_zero_x.rs` | 1 | 1 | 5 | Template only |
| `final_fantasy_vi.rs` | 1 | 3 | 9 | Template only |
| `lylat_wars.rs` | 1 | 1 | 15 | Template only |
| `mario_kart_64.rs` | 1 | 1 | 16 | Template only |
| `mission_impossible.rs` | 1 | 1 | 16 | Template only |
| `mystic_quest_legend.rs` | 1 | 3 | 9 | Template only |
| `pokemon_trading_card_game.rs` | 1 | 1 | 14 | Template only |
| `super_punch_out.rs` | 1 | 8 | 24 | Template only |
| `wario_land_3.rs` | 1 | 1 | 6 | Template only |
| `zelda_oracle_of_ages.rs` | 1 | 3 | 15 | Template only |
| `zelda_oracle_of_seasons.rs` | 1 | 3 | 15 | Template only |
| `sonic_3.rs` | 1 | 3 | 136 | Template only |
| `shining_force.rs` | 1 | 3 | 54 | Template only |
| `soleil.rs` | 1 | 5 | 84 | Template only |
| **Total** | **45** | **107** | **6,575** | **2 fresh profiles** |

Fresh creation uses a verified initializer. Template creation starts from an existing valid save and preserves bytes outside the requested edits and integrity repairs. A profile without an initializer cannot create a fresh save.

The A Link to the Past profiles require a valid primary file. They accept a stale backup and replace it from the repaired primary after an edit. They do not recover a damaged primary from its backup. The Super Mario World profiles require matching primary and backup files.

The Super Mario 64 profiles accept 512-byte EEPROM saves and copies padded to 2 KiB. Edits repair both copies of the selected Mario file and both options records. Other Mario files and trailing padding remain unchanged. These profiles require valid primary file and options checksums; they do not recover a damaged primary from its backup.

Integer and packed-decimal fields use the full stored range unless the source proves a narrower storage rule. A game can reject combinations that fit the storage. Raw numeric options can include states that normal play does not produce.

The Generation I and II definitions use Rust loops and shared constructors for repeated Pokédex fields. Their field IDs and byte locations remain unchanged. Shared choices define `fast` (1), `medium` (3), and `slow` (5). Every Pokémon profile requires a template.

<!-- START doctoc -->
## Table of contents

- [Sources and attribution](#sources-and-attribution)

<!-- END doctoc -->

## Sources and attribution

Super Mario 64 EEPROM sizes and backup behavior follow n64decomp/sm64 [`save_file.h`](https://github.com/n64decomp/sm64/blob/master/src/game/save_file.h) and [`save_file.c`](https://github.com/n64decomp/sm64/blob/master/src/game/save_file.c). Game-over reload restores the backup file and options records.

The Super Mario World layouts and initializer follow [SMWDisX `rammap.asm`](https://github.com/IsoFrieze/SMWDisX/blob/30643c7595a7d097d731de69476f8059c7cf98c3/rammap.asm), [`bank_00.asm`](https://github.com/IsoFrieze/SMWDisX/blob/30643c7595a7d097d731de69476f8059c7cf98c3/bank_00.asm), and [`bank_04.asm`](https://github.com/IsoFrieze/SMWDisX/blob/30643c7595a7d097d731de69476f8059c7cf98c3/bank_04.asm). The last source defines the event bit order.

The Generation I layouts follow [pret/pokered](https://github.com/pret/pokered/tree/a1a22aaf84d1675bcdbaeb194592379d586d838e) and [PKHeX `SAV1Offsets.cs`](https://github.com/kwsch/PKHeX/blob/e0e63bc87837ad2d9c8f8fda4efdbf5f2933db08/PKHeX.Core/Saves/Substructures/Gen12/SAV1Offsets.cs). The Generation II layouts follow [pret/pokegold](https://github.com/pret/pokegold/blob/656583c939d30f920a316177311a502dd222b57c5/layout.link), [pret/pokecrystal](https://github.com/pret/pokecrystal/blob/7a7881d0d62e0ddbd82dcf10e7116807487ac651/layout.link), and [PKHeX `SAV2Offsets.cs`](https://github.com/kwsch/PKHeX/blob/e0e63bc87837ad2d9c8f8fda4efdbf5f2933db08/PKHeX.Core/Saves/Substructures/Gen12/SAV2Offsets.cs). The A Link to the Past layouts follow [jpdasm `symbols_sram.asm`](https://github.com/spannerisms/jpdasm/blob/d078addd79e888c0d048fe5250d2c665ccf61628/symbols_sram.asm) and [zelda3 `select_file.c`](https://github.com/snesrev/zelda3/blob/fbbb3f967a51fafe642e6140d0753979e73b4090/src/select_file.c).

The other definitions derive from Game Tools Collection commit [`fd8ca0beba05723fcfdb5af83c453ba9bea1221a`](https://github.com/RyudoSynbios/game-tools-collection/tree/fd8ca0beba05723fcfdb5af83c453ba9bea1221a):

| Titles                         | Layout                                                                                                                                                                                                                                                                                                                                                                           | Integrity and write rules                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Donkey Kong Country            | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country/saveEditor/template.ts)                                                                                                                                                                                                | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country/saveEditor/utils.ts)                                                                                                                                                                                          |
| Donkey Kong Country 2          | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country-2-diddy-s-kong-quest/saveEditor/template.ts)                                                                                                                                                                           | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country-2-diddy-s-kong-quest/saveEditor/utils.ts)                                                                                                                                                                     |
| Donkey Kong Country 3          | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country-3-dixie-kong-s-double-trouble/saveEditor/template.ts)                                                                                                                                                                  | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country-3-dixie-kong-s-double-trouble/saveEditor/utils.ts)                                                                                                                                                            |
| Final Fantasy                  | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/final-fantasy/saveEditor/template.ts)                                                                                                                                                                                                      | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/final-fantasy/saveEditor/utils.ts)                                                                                                                                                                                                |
| Mario Party and Mario Party 2  | [Mario Party `template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/mario-party/saveEditor/template.ts), [Mario Party 2 `template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/mario-party-2/saveEditor/template.ts) | [Mario Party `utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/mario-party/saveEditor/utils.ts), [Mario Party 2 `utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/mario-party-2/saveEditor/utils.ts) |
| Secret of Mana                 | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/secret-of-mana/saveEditor/template.ts)                                                                                                                                                                                                     | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/secret-of-mana/saveEditor/utils.ts)                                                                                                                                                                                               |
| Solatorobo: Red the Hunter     | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/solatorobo-red-the-hunter/saveEditor/template.ts)                                                                                                                                                                                          | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/solatorobo-red-the-hunter/saveEditor/utils.ts)                                                                                                                                                                                    |
| Super Mario 64                 | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-mario-64/saveEditor/template.ts)                                                                                                                                                                                                     | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-mario-64/saveEditor/utils.ts)                                                                                                                                                                                               |
| Super Mario Kart               | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-mario-kart/saveEditor/template.ts)                                                                                                                                                                                                   | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-mario-kart/saveEditor/utils.ts)                                                                                                                                                                                             |
| Super Mario RPG                | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-mario-rpg-legend-of-the-seven-stars/saveEditor/template.ts)                                                                                                                                                                          | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-mario-rpg-legend-of-the-seven-stars/saveEditor/utils.ts)                                                                                                                                                                    |
| Super Metroid                  | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-metroid/saveEditor/template.ts)                                                                                                                                                                                                      | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/super-metroid/saveEditor/utils.ts)                                                                                                                                                                                                |
| Wario Land: Super Mario Land 3 | [`template.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/wario-land-super-mario-land-3/saveEditor/template.ts)                                                                                                                                                                                      | [`utils.ts`](https://github.com/RyudoSynbios/game-tools-collection/blob/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/wario-land-super-mario-land-3/saveEditor/utils.ts)                                                                                                                                                                                |

Game Tools Collection is copyright 2024 RyudoSynbios and is used under the [MIT License](LICENSE-GAME-TOOLS-COLLECTION).

The catalog uses the shared schema engine and native callbacks. Adding or changing a definition requires an application update.

F-Zero, Game & Watch Gallery 3, and Kirby's Adventure derive from Game Tools Collection revision `75ce8f848b628f202c50daa75d95dda58eb1f3a5`:

| Title | Layout and write rules | Supported edits |
| --- | --- | --- |
| F-Zero | [Source](https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/f-zero/saveEditor) | Master Class unlocks, best laps, ranked times, and cars; three league checksums repaired. |
| Game & Watch Gallery 3 | [Source](https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/game-and-watch-gallery-3/saveEditor) | Game unlocks and Very Hard mode flags; additive checksum repaired. Scores and pending games omitted. |
| Kirby's Adventure | [Source](https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/kirby-s-adventure/saveEditor) | Current level in three slots and three region layouts; animation bytes and slot checksums repaired. Door and progression edits omitted. |

These profiles require explicit selection and a game-made template. F-Zero accepts 2 KiB raw SRAM; the other two games accept 8 KiB. Edits preserve unrelated bytes.

The additional handheld, Nintendo 64, and SNES profiles also require explicit selection and a game-made template. Their editable scope is limited to these fields:

| Titles | Editable scope |
| --- | --- |
| ActRaiser | Master HP, level with its derived experience value, and MP in separate Europe, USA, and Japan profiles |
| Final Fight One | Opponents defeated, options, character colors, and character/color values in five ranking records |
| Super Street Fighter II Turbo Revival | VS points, options, and 13 challenge times |
| Chrono Trigger | Gold in each of three slots; the first inventory item code is read-only |
| Diddy Kong Racing | Adventure Two mode, Wizpig amulet pieces, and balloons in three occupied slots |
| Donkey Kong Land | Progression, current level, and playtime in three slots |
| F-Zero: Maximum Velocity | Championship clear counts and three unlocks in each slot |
| F-Zero X | Four cup progression values and the Death Race time |
| Final Fantasy VI | Money and battle speed in each slot; location code is read-only |
| Lylat Wars / Star Fox 64 | Played, completion, and medal flags for Corneria, Meteo, and Sector Y |
| Mario Kart 64 | Mario GP trophies for four cups in four classes |
| Mission: Impossible | Music, sound-effects, audio-mode, and screen-ratio options in four records |
| Mystic Quest Legend | Money, location code, and hero level in each slot |
| Pokémon Trading Card Game | Playtime, position, location with both preview copies, and eight Master Medals with their total |
| Super Punch-Out!! | Losses in eight profiles; wins and championship progression are read-only |
| Wario Land 3 | Coins, language, encoded day/night, and the first three sequential power upgrades |
| The Legend of Zelda: Oracle of Ages and Oracle of Seasons | Mode, health, maximum health, heart pieces, and rupees in three slots per title |

These definitions derive from [Game Tools Collection commit `8fb075e7c130da9e72c3c46ec8efa447a252ad88`](https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88). Diddy Kong Racing also uses the checksum rules in [DavidSM64/Diddy-Kong-Racing `save_data.c`](https://github.com/DavidSM64/Diddy-Kong-Racing/blob/1339ad6304118207b342fe8669c500efb91969df/src/save_data.c).

The Genesis definitions accept only their listed odd-byte SRAM dump sizes. They do not accept a contiguous logical save or an arbitrary padded dump.

| Title | Accepted file sizes | Editable scope |
| --- | --- | --- |
| Sonic 3 | 604 B, 980 B, or 64 KiB | Character, zone, next special stage, and emerald count in six Sonic 3 slots; character, zone, lives, and continues in eight Sonic 3 & Knuckles slots when that block is present |
| Shining Force | 16,381 B, 16,382 B, or 64 KiB | Chapter, gold, and the hero's level, experience, maximum HP, and current HP in each present slot |
| Soleil (Crusader of Centy) | 512 B, 4,608 B, 8,704 B, 12,800 B, or 64 KiB | Current and maximum health, Malins, two equipped animals, and location in each present slot |

The Genesis field offsets derive from [Game Tools Collection commit `8fb075e7c130da9e72c3c46ec8efa447a252ad88`](https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88). The Sonic 3 checksum and block layout also follow [jcfields/sonic3-save-editor `save format.md`](https://gitlab.com/jcfields/sonic3-save-editor/-/blob/8b740b670ff8e46f7c35ff8fac98169efccfe3b9/save%20format.md).
