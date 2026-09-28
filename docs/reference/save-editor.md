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
  - [Layout selection and recovery](#layout-selection-and-recovery)
  - [Field values and validation](#field-values-and-validation)
  - [Edit transactions](#edit-transactions)
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

Fresh Pokémon generation is unavailable because structure and checksum checks do not prove a playable game state. Earlier generated Pokémon files may pass those checks while missing game initialization data. Start with a save made by the matching game. Direct Rust handler calls enforce the same generation capability; synthetic Pokémon initializers remain test-only.

Template generation supports every editable game above. It validates an existing save, applies optional field assignments, and writes a separate file. Without assignments, the output is byte-identical to the template. Container wrappers are retained. A template cannot be the output path.

`save list-games` reports the game definitions and the IDs that support fresh generation. `save create` requires an output path unless it runs with `--dry-run`.

Procedures: [Create saves in the browser](../how-to/create-game-saves-browser.md) and [Create saves with the CLI](../how-to/create-game-saves-cli.md).

## Runtime schema packs

A schema pack defines layouts and editing rules without rebuilding the application. Built-in games use bundled schema packs through the same interpreter. The CLI accepts `--schema PATH` on every `save` command. The browser accepts a local JSON pack through **Load schema pack**. The repository catalog and its profile counts are in [`data/save-schemas/README.md`](../../data/save-schemas/README.md).

The top-level object contains `schema_version` (`1`) and a nonempty `games` array. Optional `$schema` metadata identifies an authoring schema; the interpreter never fetches it. Optional `pack_revision` is a positive 32-bit revision for the pack data. It does not enable interpreter features. Optional `records` defines reusable field arrays by name. Optional `text_codecs` maps codec names to declarative character encodings.

A game contains `id`, `name`, `platform`, `save_size`, and `fields`. Optional members include `description`, `records`, `signatures`, `checksums`, `mirrors`, and `generation`. Advanced layouts also define `layout`, `logical_size`, `recognition`, `recovery`, validation checks, and write effects. Game metadata can preserve `family`, `handler_id`, `save_format`, `save_format_name`, `known_rom_sha1`, and `checksum_sizes`. `handler_id` is output metadata; it cannot select native code.

| Member          | Representation                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field           | `id`, `label`, byte `offset`, and `type`; optional `description`, `editable`, `min`, `max`, `bit`, `length`, `inverted`, `copies`, `choices`, and `mask` |
| Record instance | `record`, byte `offset`, and `id`; optional `count`, `stride` or `stride_bits`, `index_start`, and `index_width`                                         |
| Signature       | `offset` and a `bytes` array                                                                                                                             |
| Checksum        | `algorithm`, `offset`, optional `target`, optional `unit`, one `start`/`length` input or a `spans` array, and optional `exclude` ranges                  |
| Mirror          | `source`, `target`, and `length`, all in bytes; optional `validate`                                                                                      |
| Generation      | A `fill` byte and a `patches` array of `offset`/`bytes` objects                                                                                          |

Storage types are `u8`, `u16_le`, `u16_be`, `u24_le`, `u24_be`, `u32_le`, `u32_be`, `i8`, `i16_le`, `i16_be`, `i32_le`, `i32_be`, `bool`, `bit`, `ascii`, `bcd_le`, and `bcd_be`. Integers expose their full stored range unless `min` or `max` narrows it. BCD fields use one through four bytes and store two decimal digits per byte. Their byte order controls the order of the packed decimal byte pairs.

`bit` requires a bit index from 0 through 7. `bool` and `bit` can set `inverted` to exchange the stored zero and one meanings. `ascii` requires a byte length from 1 through 255. A flat field's `offset` and `copies` are absolute. A record field's offsets and copies are relative to the instance base and its stride. An edit encodes the same value at the primary offset and every copy; reads use the primary offset. Copies do not validate equality before an edit.

A record instance expands one top-level record without nesting. `count` defaults to 1 and has a maximum of 4,096. A larger count needs one positive `stride` in bytes or `stride_bits` in bits. `stride_bits` accepts only records made of `bit` fields. `index_start` defaults to 0. `index_width` defaults to 0, has a maximum of 10, and adds leading zeroes. Expansion substitutes `{index}` and `{ordinal}` in field IDs, labels, descriptions, and group names. `{index}` starts at `index_start`; `{ordinal}` is the one-based repetition number. A nonempty instance ID prefixes each field ID with a dot. An empty ID retains the template IDs. Rule scalars marked `relative: true` move with the instance offset and stride. Other rule references retain their absolute addresses. For bit strides, relative rule scalars require a single-bit mask. `presentation.relative_offset` advances the reported offset by the repetition displacement, without adding the instance base. Every expanded field, offset, copy, and storage location follows the normal validation limits.

Numeric fields can define `choices` as unique name and integer-value pairs. Choice names cannot start with `raw:`. The CLI and browser use the existing named-option controls. If stored data has an unknown value, readers expose `raw:<decimal>` as the current choice. An unrelated edit preserves that value.

Unsigned binary integer fields can set a nonzero, contiguous `mask`. Reads shift the masked bits down to expose the logical value. Writes preserve neighboring bits. Signed integers, BCD, booleans, individual bits, and text do not accept a mask.

Checksum algorithms are:

| Family                | Algorithms                                             | Stored result                                                                              |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Subtractive sum       | `sum8`, `sum16_le`, `sum16_be`, `sum32_le`, `sum32_be` | `target - accumulated`, modulo the result width                                            |
| Additive sum          | `add8`, `add16_le`, `add16_be`, `add32_le`, `add32_be` | `target + accumulated`, modulo the result width                                            |
| XOR                   | `xor8`, `xor16_le`, `xor16_be`, `xor32_le`, `xor32_be` | `target XOR accumulated`                                                                   |
| Modulo-255 complement | `sum8_mod255_complement`                               | `(byte sum modulo 255) XOR 255`                                                            |
| Folded word sum       | `sum32_le_fold16`                                      | Sum little-endian 32-bit words, add the upper and lower halves, and store the low 16 bits  |
| CRC-16                | `crc16_ccitt_false_le`                                 | CRC-CCITT-FALSE with polynomial `0x1021`, initial value `0xffff`, and little-endian output |

`target` defaults to zero. The algorithm suffix controls the output width and byte order. The optional `unit` controls how input bytes become values: `u8` by default, or `u16_le`, `u16_be`, `u32_le`, or `u32_be`. Input lengths must be divisible by the unit width. The modulo-255 and CRC algorithms accept only `u8` and no target. The folded word sum requires `u32_le` units and no target.

A checksum uses either one `start`/`length` range or a nonempty `spans` array. Spans are concatenated in order and cannot overlap. Each `exclude` range must fit inside one input span. Excluded bytes contribute zero while their positions remain in the input. Exclusion ranges cannot overlap.

An edit validates all assignments before it copies the input. It then encodes all fields and their copies, repairs checksums, copies mirror ranges, reparses the result, and checks that every assignment round-trips. A no-op edit preserves every byte. A mirror validates source and target equality by default. `validate: false` accepts a different target before an edit but still replaces it from the source afterward. Generation fills the image, applies patches, repairs checksums, then copies mirrors. Generation is unavailable when its initializer is absent. Structural validation proves only that bytes satisfy the declared storage and integrity rules. It does not prove that the game accepts the values or combinations.

### Layout selection and recovery

`layout.groups` defines independent logical regions. Each group contains fixed candidate mappings or a tagged section scan. Mapping spans associate logical byte offsets with physical offsets. Unmapped bytes retain their original offsets. `logical_size` defaults to the physical save size. Top-level signatures, checksums, mirrors, fields, and rules address this logical image. Candidate integrity rules address the physical save.

Fixed candidates declare signatures, checksums, predicates, optional counters, and section metadata. `checksum_blocks` is a shorthand for blocks that each own one checksum. Each block adds that checksum, its repair, and a section. Section IDs start at 0 and follow the block order. A block with a `mirror` offset also adds an equality predicate and a repair that copy the checksum there. Block checksums read byte units, so `sum32_le_fold16` is not available. A candidate with `checksum_blocks` declares no `checksums`, `repairs`, or `sections`, and it accepts at most 256 blocks. Tagged candidates declare sector positions, section IDs, footer positions, checksum input lengths, and checksum operations. The interpreter resolves addresses before reading or editing fields.

Selection uses the first valid copy or the newest counter. Counter selection can recognize the maximum-to-zero rollover and reject ties. Recognition can inspect valid copies without requiring an unambiguous active copy.

A group's write policy patches the selected copy, patches valid copies, or copies the complete selected region to every copy. The complete-copy policy runs only for touched groups. A requested no-op field counts as touched when another field changes in the same batch. An entirely unchanged batch does not repair copies.

`recovery` declares outcomes for incomplete, damaged, unrecoverable, and differing copies. Each outcome controls integrity state, editability, issues, warnings, and optional parse or edit errors. `active_group` reports the selected group index; otherwise the document reports its selected copy. `all_copy_sections` exposes every copy's section metadata when the format requires it.

### Field values and validation

Fields can name a layout `group` and define `present_when` or `editable_when` predicates. A field's `presentation` preserves its reported section, offset, kind, constraints, step, encoding, and warnings separately from storage. `section_id` and `offset` are required. An omitted `kind`, `constraints`, `step`, or `encoding` keeps the value derived from the field. An explicit `null` step or encoding clears it.

`text_codec` selects a codec from the pack's `text_codecs`. Codecs declare byte or word units, glyph tables or UTF-16 mappings, terminators, skipped units, padding, bit lanes, and invalid-input policies. Conditional replacement tables support context-dependent character encodings.

A numeric field can define an `xor` expression for stored-value encryption and a `read` expression for a derived value. Read-only `format` fields concatenate text and numeric expressions. `value_override` defines a conditional displayed value and read-only state. `unknown_choice` defines a read-only fallback for unknown enum codes; the default remains `raw:<decimal>`.

Expressions contain integers, scalar reads, checked arithmetic, bit operations, and conditional values. Predicates combine comparisons, byte-range checks, `all`, `any`, and `not`. Expression depth is limited to 16 and validation work to 4,096 nodes per expression. There are no scripts, loops, or native callbacks.

Recognition checks determine candidates. `checks` validate parsed logical data. `document_checks` report invalid values and disable editing. `edit_checks` run before editing and after the complete batch. Numeric edit constraints remain separate from checks on existing stored values. A check with `repeat` expands into `count` copies. Each copy moves rule scalars marked `relative: true` by `stride` bytes. Expanded checks count toward the 4,096-check limit.

### Edit transactions

Assignments are validated before writes begin. Each field's `on_edit` stores run in request order after its main write. Game-level `after_edit` stores run after all assignments. Completed-batch checks therefore see linked edits together.

The interpreter writes the resolved logical data to the declared physical copies. It repairs affected checksums and executes dependent checksum or mirror repairs in their declared order. It then reparses the output and checks every requested value. A failed check returns no edited bytes. Dry runs perform the same checks and return the resulting document without output bytes.

Layout initializers provide complete valid bytes, including initialized copies and their checksums. Uninitialized files remain empty. Flat-layout initializers retain automatic checksum and mirror finalization.

The interpreter rejects unknown properties and versions, duplicate IDs, duplicate choice names or values, invalid ranges, and conflicting writes. Packs cannot replace built-in games. Limits are 2 MiB per pack, 2 MiB of expanded field metadata per game, 64 games, 4,096 expanded fields per game, 4,096 field storage locations per game, and 8 MiB per raw save. Expanded primary field offsets and copies both count as storage locations. The metadata estimate includes each field and choice representation, copy offsets, rendered text, instance prefixes, and field behavior definitions. The interpreter checks this limit before it clones record fields. Flat layouts use at most 128 synthetic 64-KiB sections. Explicit layouts expose their declared physical sections. Flat layouts without signatures or checksums require an explicit game choice. Packs cannot execute code or fetch network resources.

Game IDs contain 1–128 lowercase ASCII letters, digits, underscores, or hyphens and start with a letter or digit. Field IDs and record names contain dot-separated nonempty segments of ASCII letters, digits, underscores, or hyphens. A record template is nonempty. Other text values have a 1,024-byte limit. A pack contains at most 4,096 template fields in total. Each game contains at most 4,096 record instances. Each signatures, checksums, mirrors, patches, copies, choices, spans, or exclusions array contains at most 4,096 entries. Total integrity work across a pack cannot exceed 64 MiB. This total includes signatures, checksum inputs, mirror sources, layout candidates, predicates, expressions, checks, and write effects.

Catalog profiles are separate game definitions for fixed slots, players, regions, or storage variants. Profile count is not title count. Integer and BCD fields use their stored range by default. A stored value or combination can still be invalid during play.

After schema version 1 is released, a new interpreter operation or changed required meaning needs a new `schema_version`. Readers keep support for released versions. An unknown version fails explicitly; readers do not downgrade it. `pack_revision` tracks data revisions only.

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
