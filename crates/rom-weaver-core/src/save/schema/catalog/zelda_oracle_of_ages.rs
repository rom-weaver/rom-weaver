use super::*;

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/legend-of-zelda-the-oracle-of-ages/saveEditor
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/legend-of-zelda-the-oracle-of-ages/saveEditor

/// Which Oracle game a slot belongs to; the two layouts share the slot frame and checksum but
/// place most values at different offsets.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Game {
    Ages,
    Seasons,
}

#[derive(Clone, Copy)]
enum Kind {
    U8,
    BcdByte,
    BcdWord,
    I16,
}

// (id, label, Ages offset, Seasons offset, kind, maximum); a missing offset means the value only
// exists in the other game.
type ScalarRow = (
    &'static str,
    &'static str,
    Option<usize>,
    Option<usize>,
    Kind,
    i64,
);

const SCALARS: [ScalarRow; 17] = [
    (
        "linked_id",
        "Linked ID",
        Some(0x60),
        Some(0x60),
        Kind::I16,
        32767,
    ),
    (
        "death_count",
        "Death count",
        Some(0x7e),
        Some(0x7e),
        Kind::BcdWord,
        999,
    ),
    (
        "sword_level",
        "Sword level",
        Some(0x112),
        Some(0x10c),
        Kind::U8,
        3,
    ),
    (
        "shield_level",
        "Shield level",
        Some(0x10f),
        Some(0x109),
        Kind::U8,
        3,
    ),
    (
        "bracelet_level",
        "Bracelet level",
        Some(0x118),
        None,
        Kind::U8,
        2,
    ),
    ("hook_level", "Hook level", Some(0x116), None, Kind::U8, 2),
    (
        "roc_item_level",
        "Roc's item level",
        None,
        Some(0x114),
        Kind::U8,
        2,
    ),
    (
        "slingshot_level",
        "Slingshot level",
        None,
        Some(0x113),
        Kind::U8,
        2,
    ),
    (
        "boomerang_level",
        "Boomerang level",
        None,
        Some(0x111),
        Kind::U8,
        2,
    ),
    (
        "bombchus",
        "Bombchus",
        Some(0x113),
        Some(0x10d),
        Kind::BcdByte,
        99,
    ),
    (
        "gasha_seeds",
        "Gasha seeds",
        Some(0x11e),
        Some(0x11a),
        Kind::BcdByte,
        99,
    ),
    ("slates", "Slates", Some(0x123), None, Kind::BcdByte, 4),
    (
        "ore_chunks",
        "Ore chunks",
        None,
        Some(0x107),
        Kind::BcdWord,
        999,
    ),
    ("flute", "Flute", Some(0x115), Some(0x10f), Kind::U8, 3),
    (
        "tradable_item",
        "Tradable item",
        Some(0x120),
        Some(0x11c),
        Kind::U8,
        11,
    ),
    (
        "ring_box",
        "Ring box level",
        Some(0x12c),
        Some(0x126),
        Kind::U8,
        3,
    ),
    ("season", "Season", None, Some(0x8d), Kind::U8, 3),
];

// (group, byte offset, bit, label) flags; the plain flags have no dependent values.
type FlagRow = (&'static str, usize, u8, &'static str);

const AGES_FLAGS: [FlagRow; 57] = [
    ("key_item", 0xff, 6, "Zora's Flippers"),
    ("key_item", 0x103, 2, "Mermaid Suit"),
    ("key_item", 0xff, 7, "Magic Potion"),
    ("key_item", 0x102, 1, "Tradable Item"),
    ("key_item", 0x104, 1, "Fairy Powder"),
    ("key_item", 0x103, 6, "Zora Scale"),
    ("key_item", 0x103, 7, "Tokay Eyeball"),
    ("key_item", 0x100, 6, "Maku Seed"),
    ("key_item", 0x100, 4, "Gasha Seed"),
    ("key_item", 0x102, 2, "Graveyard Key"),
    ("key_item", 0x104, 2, "Cheval Rope"),
    ("key_item", 0x103, 0, "Ricky's Gloves"),
    ("key_item", 0x104, 4, "Island Chart"),
    ("key_item", 0x104, 3, "Member's Card"),
    ("key_item", 0x103, 5, "Scent Seedling"),
    ("key_item", 0x103, 4, "Cracked Tuni Nut"),
    ("key_item", 0x122, 1, "Tuni Nut"),
    ("key_item", 0x103, 1, "Bomb Flower"),
    ("key_item", 0x102, 3, "Crown Key"),
    ("key_item", 0x105, 3, "Brother Emblem"),
    ("key_item", 0x103, 3, "Slate"),
    ("key_item", 0x105, 2, "Lava Juice"),
    ("key_item", 0x105, 1, "Introduction"),
    ("key_item", 0x102, 4, "Mermaid Key"),
    ("key_item", 0x105, 6, "Rock Sirloin"),
    ("key_item", 0x105, 4, "Goron Vase"),
    ("key_item", 0x105, 5, "Goronade"),
    ("key_item", 0x102, 5, "Old Mermaid Key"),
    ("key_item", 0x102, 6, "Library Key"),
    ("key_item", 0x104, 5, "Book of Seals"),
    ("key_item", 0xff, 5, "Magic Ring"),
    ("essence", 0x11f, 0, "Eternal Spirit"),
    ("essence", 0x11f, 1, "Ancient Wood"),
    ("essence", 0x11f, 2, "Echoing Howl"),
    ("essence", 0x11f, 3, "Burning Flame"),
    ("essence", 0x11f, 4, "Sacred Soil"),
    ("essence", 0x11f, 5, "Lonely Peak"),
    ("essence", 0x11f, 6, "Rolling Sea"),
    ("essence", 0x11f, 7, "Falling Star"),
    ("seed", 0xfe, 0, "Ember Seeds"),
    ("seed", 0xfe, 1, "Scent Seeds"),
    ("seed", 0xfe, 2, "Pegasus Seeds"),
    ("seed", 0xfe, 3, "Gale Seeds"),
    ("seed", 0xfe, 4, "Mystery Seeds"),
    ("tune", 0xfe, 5, "Tune of Echoes"),
    ("tune", 0xfe, 6, "Tune of Currents"),
    ("tune", 0xfe, 7, "Tune of Ages"),
    ("gale_warp_present", 0x173, 4, "Symmetry Village"),
    ("gale_warp_present", 0x1d8, 4, "South Lynna"),
    ("gale_warp_present", 0x20c, 4, "Crescent Island"),
    ("gale_warp_present", 0x221, 4, "Zora Village"),
    ("gale_warp_past", 0x268, 4, "Rolling Ridge"),
    ("gale_warp_past", 0x285, 4, "Ambi's Palace"),
    ("gale_warp_past", 0x28d, 4, "Rolling Ridge"),
    ("gale_warp_past", 0x2d8, 4, "South Shore"),
    ("gale_warp_past", 0x2e0, 4, "Deku Forest"),
    ("gale_warp_past", 0x321, 4, "Zora Village"),
];

const SEASONS_FLAGS: [FlagRow; 48] = [
    ("key_item", 0xfc, 4, "Master's Plaque"),
    ("key_item", 0xf7, 6, "Zora's Flippers"),
    ("key_item", 0xf7, 7, "Magic Potion"),
    ("key_item", 0xfa, 1, "Tradable Item"),
    ("key_item", 0xf8, 6, "Maku Seed"),
    ("key_item", 0xf8, 4, "Gasha Seed"),
    ("key_item", 0xfa, 2, "Gnarled Key"),
    ("key_item", 0xfb, 0, "Ricky's Gloves"),
    ("key_item", 0xfa, 3, "Floodgate Key"),
    ("key_item", 0xfb, 2, "Rusty Bell"),
    ("key_item", 0x11d, 0, "Pirate's Bell"),
    ("key_item", 0xfb, 3, "Treasure Map"),
    ("key_item", 0xfb, 4, "Jewel Circle"),
    ("key_item", 0xfb, 5, "Jewel Triangle"),
    ("key_item", 0xfb, 6, "Jewel Square"),
    ("key_item", 0xfb, 7, "Jewel Cross"),
    ("key_item", 0xfa, 6, "Ribbon"),
    ("key_item", 0xfa, 5, "Star-shaped Ore"),
    ("key_item", 0xfa, 7, "Spring Banana"),
    ("key_item", 0xfa, 4, "Dragon Key"),
    ("key_item", 0xfc, 0, "Red Ore"),
    ("key_item", 0xfc, 2, "Hard Ore"),
    ("key_item", 0xfc, 1, "Blue Ore"),
    ("key_item", 0xfc, 3, "Member's Card"),
    ("key_item", 0xf7, 5, "Magic Ring"),
    ("essence", 0x11b, 0, "Fertile Soil"),
    ("essence", 0x11b, 1, "Gift of Time"),
    ("essence", 0x11b, 2, "Bright Sun"),
    ("essence", 0x11b, 3, "Soothing Rain"),
    ("essence", 0x11b, 4, "Nurturing Warmth"),
    ("essence", 0x11b, 5, "Blowing Wind"),
    ("essence", 0x11b, 6, "Seed of Life"),
    ("essence", 0x11b, 7, "Changing Seasons"),
    ("seed", 0xf6, 0, "Ember Seeds"),
    ("seed", 0xf6, 1, "Scent Seeds"),
    ("seed", 0xf6, 2, "Pegasus Seeds"),
    ("seed", 0xf6, 3, "Gale Seeds"),
    ("seed", 0xf6, 4, "Mystery Seeds"),
    ("season", 0x110, 0, "Spring"),
    ("season", 0x110, 1, "Summer"),
    ("season", 0x110, 2, "Autumn"),
    ("season", 0x110, 3, "Winter"),
    ("gale_warp", 0x170, 4, "Tarm Ruins"),
    ("gale_warp", 0x1bf, 4, "Sunken City"),
    ("gale_warp", 0x1c7, 4, "North Horon"),
    ("gale_warp", 0x1d2, 4, "Spool Swamp"),
    ("gale_warp", 0x1fe, 4, "Woods of Winter"),
    ("gale_warp", 0x258, 4, "Horon Village"),
];

// Setting one of these flags also sets a hidden twin flag that the game reads:
// (offset, bit, twin offset, twin bit).
type Twin = (usize, u8, usize, u8);

const AGES_TWINS: [Twin; 2] = [(0x103, 1, 0x105, 0), (0x20c, 4, 0x20c, 7)];

const AGES_DUNGEONS: [(usize, &str); 13] = [
    (0x0, "Maku Path (Present)"),
    (0xd, "Maku Path (Past)"),
    (0x1, "Level 1: Spirit's Grave"),
    (0x2, "Level 2: Wing Dungeon"),
    (0x3, "Level 3: Moonlit Grotto"),
    (0x4, "Level 4: Skull Dungeon"),
    (0x5, "Level 5: Crown Dungeon"),
    (0x6, "Level 6: Mermaid's Cave (Present)"),
    (0xc, "Level 6: Mermaid's Cave (Past)"),
    (0x7, "Level 7: Jabu-Jabu's Belly"),
    (0x8, "Level 8: Ancient Tomb"),
    (0xa, "Room of Rites"),
    (0xb, "Hero's Cave"),
];

const SEASONS_DUNGEONS: [(usize, &str); 12] = [
    (0x0, "Hero's Cave"),
    (0x1, "Level 1: Gnarled Root"),
    (0x2, "Level 2: Snake's Remains"),
    (0x3, "Level 3: Poison Moth's Lair"),
    (0x4, "Level 4: Dancing Dragon Dungeon"),
    (0x5, "Level 5: Unicorn's Cave"),
    (0x6, "Level 6: Ancient Ruins"),
    (0x7, "Level 7: Explorer's Crypt"),
    (0x8, "Level 8: Sword & Shield Dungeon"),
    (0x9, "Onox's Castle"),
    (0xa, "Room of Rites"),
    (0xb, "Hero's Cave (Linked Game)"),
];

fn scalar_field(row: &ScalarRow, base: usize, game: Game) -> Option<FieldDefinition> {
    let (id, label, ages, seasons, kind, max) = *row;
    let offset = base + if game == Game::Ages { ages } else { seasons }?;
    let field = catalog_field(id, label, offset, Storage::U8)
        .min(0)
        .max(max);
    Some(match kind {
        Kind::U8 => field,
        Kind::I16 => FieldDefinition {
            storage: Storage::I16Le,
            ..field
        },
        Kind::BcdByte => FieldDefinition {
            storage: Storage::BcdBe,
            length: Some(1),
            ..field
        },
        Kind::BcdWord => FieldDefinition {
            storage: Storage::BcdLe,
            length: Some(2),
            ..field
        },
    })
}

fn flag_field(row: &FlagRow, base: usize, twins: &[Twin]) -> FieldDefinition {
    let (group, offset, bit, label) = *row;
    let suffix = if group.starts_with("gale_warp") {
        format!("_{offset:x}")
    } else {
        String::new()
    };
    let mut field = catalog_field(
        &format!("{group}.{}{suffix}", id_part(label)),
        label,
        base + offset,
        Storage::Bit,
    )
    .bit(bit);
    if let Some((_, _, twin_offset, twin_bit)) = twins
        .iter()
        .find(|(twin_source, source_bit, _, _)| *twin_source == offset && *source_bit == bit)
    {
        let (source, source_bit) = (base + offset, bit);
        field.behavior.on_edit.push(rules::Store {
            when: None,
            destination: rules::Scalar {
                offset: base + twin_offset,
                storage: Storage::U8,
                mask: Some(1 << twin_bit),
            },
            value: rules::ReadValue::new(move |bytes| {
                Ok(i64::from(bytes[source] >> source_bit & 1))
            }),
        });
    }
    field
}

fn dungeon_fields(game: Game, base: usize) -> Vec<FieldDefinition> {
    let (dungeons, map, compass, boss_key, keys) = match game {
        Game::Ages => (&AGES_DUNGEONS[..], 0xe6, 0xe4, 0xe2, 0xd2),
        Game::Seasons => (&SEASONS_DUNGEONS[..], 0xde, 0xdc, 0xda, 0xce),
    };
    let mut fields = Vec::new();
    for (index, name) in dungeons {
        let (byte, bit) = (index >> 3, (index & 7) as u8);
        for (key, label, offset) in [
            ("map", "map", map),
            ("compass", "compass", compass),
            ("boss_key", "boss key", boss_key),
        ] {
            fields.push(
                catalog_field(
                    &format!("dungeon.{index:02}.{key}"),
                    &format!("{name}: {label}"),
                    base + offset + byte,
                    Storage::Bit,
                )
                .bit(bit),
            );
        }
        fields.push(
            catalog_field(
                &format!("dungeon.{index:02}.small_keys"),
                &format!("{name}: small keys"),
                base + keys + index,
                Storage::U8,
            )
            .min(0)
            .max(9),
        );
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    oracle_schema(
        "zelda-oracle-of-ages",
        "The Legend of Zelda: Oracle of Ages",
        b"Z21216-0",
        Game::Ages,
    )
}

pub(super) fn oracle_schema(
    id: &str,
    name: &str,
    signature: &[u8],
    game: Game,
) -> Vec<SchemaSaveHandler> {
    let (health, flags, twins): (usize, &[FlagRow], &[Twin]) = match game {
        Game::Ages => (0x10a, &AGES_FLAGS, &AGES_TWINS),
        Game::Seasons => (0x102, &SEASONS_FLAGS, &[]),
    };
    let games = (0..3)
        .map(|slot| {
            let mut fields = Vec::new();
            let base = slot * 0x550;
            for (key, label, offset, storage, max) in [
                ("mode", "Mode", 0x72, Storage::U16Le, u16::MAX as i64),
                ("health", "Health quarter-hearts", health, Storage::U8, 64),
                (
                    "max_health",
                    "Maximum health quarter-hearts",
                    health + 1,
                    Storage::U8,
                    64,
                ),
                ("heart_pieces", "Heart pieces", health + 2, Storage::U8, 3),
                (
                    "rupees_bcd",
                    "Rupees (packed BCD)",
                    health + 3,
                    Storage::BcdLe,
                    999,
                ),
            ] {
                let mut field =
                    FieldDefinition::new(key.into(), label.into(), base + offset, storage)
                        .min(0)
                        .max(max);
                if key == "rupees_bcd" {
                    field = field.length(2);
                }
                fields.push(field);
            }
            fields.extend(SCALARS.iter().filter_map(|row| scalar_field(row, base, game)));
            fields.push(
                catalog_field("options.message_speed", "Message speed", base + 0x89, Storage::U8)
                    .min(1)
                    .max(5)
                    .behavior(field::FieldBehavior {
                        read: Some(rules::ReadValue::new(move |bytes| {
                            Ok(i64::from(bytes[base + 0x89]) + 1)
                        })),
                        on_edit: vec![rules::Store {
                            when: None,
                            destination: rules::Scalar {
                                offset: base + 0x89,
                                storage: Storage::U8,
                                mask: None,
                            },
                            value: rules::ReadValue::new(move |bytes| {
                                Ok(i64::from(bytes[base + 0x89]) - 1)
                            }),
                        }],
                        ..Default::default()
                    }),
            );
            fields.extend(flags.iter().map(|row| flag_field(row, base, twins)));
            fields.extend(dungeon_fields(game, base));
            GameDefinition {
                fields,
                description: format!(
                    "Edits core values, equipment levels, key items, essences, seeds, dungeon items, and warp flags in slot {}. Rings, item slots, seed counts, names, and location are omitted. Select the occupied slot explicitly.",
                    slot + 1
                ),
                signatures: vec![SignatureDefinition {
                    offset: base + 0x12,
                    bytes: signature.to_vec(),
                }],
                checksums: vec![ChecksumDefinition {
                    start: Some(base + 0x12),
                    length: Some(0x54e),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, base + 0x10)
                }],
                ..GameDefinition::new(
                    format!("{id}-slot-{}", slot + 1),
                    format!("{name} — Slot {}", slot + 1),
                    "game-boy-color".into(),
                    8192,
                )
            }
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
pub(in crate::save) mod tests {
    use super::*;

    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x55; 8192];
        for slot in 0..3 {
            let base = slot * 0x550;
            bytes[base + 0x12..base + 0x1a].copy_from_slice(b"Z21216-0");
            bytes[base + 0x10d..base + 0x10f].copy_from_slice(&[0x23, 0x01]);
            let sum = bytes[base + 0x12..base + 0x560]
                .chunks_exact(2)
                .fold(0u16, |sum, pair| {
                    sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
                });
            bytes[base + 0x10..base + 0x12].copy_from_slice(&sum.to_le_bytes());
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some("zelda-oracle-of-ages-slot-1".into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn edits_one_slot_repairs_only_its_checksum_and_rejects_malformed_input() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let input = input();
        let result = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "rupees_bcd".into(),
                    value: SaveValue::U32(321),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&result[0x10d..0x10f], &[0x21, 0x03]);
        assert_eq!(&result[0x550..], &input.bytes[0x550..]);
        let expected = result[0x12..0x560].chunks_exact(2).fold(0u16, |sum, pair| {
            sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
        });
        assert_eq!(u16::from_le_bytes([result[0x10], result[0x11]]), expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[0x12] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        assert!(handler.generate(&identity).is_err());
    }

    // Slot frame shared by both games: zeroed data with the signature, a block of 0xff words so
    // the 16-bit sum wraps, and a valid checksum for every slot.
    pub(in crate::save) fn slot_save(signature: &[u8; 8]) -> Vec<u8> {
        let mut bytes = vec![0; 8192];
        for slot in 0..3 {
            let base = slot * 0x550;
            bytes[base + 0x12..base + 0x1a].copy_from_slice(signature);
            bytes[base + 0x400..base + 0x500].fill(0xff);
        }
        for slot in 0..3 {
            seal(&mut bytes, slot);
        }
        bytes
    }

    pub(in crate::save) fn seal(bytes: &mut [u8], slot: usize) {
        let base = slot * 0x550;
        let sum = bytes[base + 0x12..base + 0x560]
            .chunks_exact(2)
            .fold(0u16, |sum, pair| {
                sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
            });
        bytes[base + 0x10..base + 0x12].copy_from_slice(&sum.to_le_bytes());
    }

    pub(in crate::save) fn edit_slot(
        handlers: &[SchemaSaveHandler],
        bytes: &[u8],
        slot: usize,
        edits: &[(&str, SaveValue)],
    ) -> Result<Vec<u8>> {
        let handler = &handlers[slot];
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes: bytes.to_vec(),
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits: Vec<_> = edits
            .iter()
            .map(|(field, value)| SaveEdit {
                field: (*field).into(),
                value: value.clone(),
            })
            .collect();
        Ok(handler
            .apply(&input, &identity, &edits, false)?
            .bytes
            .expect("edit changes the save"))
    }

    #[test]
    fn ages_fields_edit_their_offsets_and_keep_the_wrapped_checksum_valid() {
        let handlers = schemas();
        let bytes = slot_save(b"Z21216-0");
        for slot in 0..3 {
            let base = slot * 0x550;
            let out = edit_slot(
                &handlers,
                &bytes,
                slot,
                &[
                    ("health", SaveValue::U32(8)),
                    ("heart_pieces", SaveValue::U32(2)),
                    ("death_count", SaveValue::U32(123)),
                    ("linked_id", SaveValue::I32(1000)),
                    ("sword_level", SaveValue::U32(3)),
                    ("slates", SaveValue::U32(4)),
                    ("gasha_seeds", SaveValue::U32(55)),
                    ("ring_box", SaveValue::U32(2)),
                    ("options.message_speed", SaveValue::U32(5)),
                    ("essence.eternal_spirit", SaveValue::Bool(true)),
                    ("seed.mystery_seeds", SaveValue::Bool(true)),
                    ("tune.tune_of_ages", SaveValue::Bool(true)),
                    ("key_item.bomb_flower", SaveValue::Bool(true)),
                    (
                        "gale_warp_present.crescent_island_20c",
                        SaveValue::Bool(true),
                    ),
                    ("dungeon.13.boss_key", SaveValue::Bool(true)),
                    ("dungeon.13.small_keys", SaveValue::U32(9)),
                    ("dungeon.01.map", SaveValue::Bool(true)),
                ],
            )
            .unwrap();
            let mut expected = bytes.clone();
            for (offset, value) in [
                (0x10a, 8),
                (0x10c, 2),
                (0x7e, 0x23),
                (0x7f, 0x01),
                (0x60, 0xe8),
                (0x61, 0x03),
                (0x112, 3),
                (0x123, 0x04),
                (0x11e, 0x55),
                (0x12c, 2),
                (0x89, 4),
                (0x11f, 0x01),
                // Mystery seeds (bit 4) and the Tune of Ages (bit 7) share one byte.
                (0xfe, 0x90),
                (0x103, 0x02),
                (0x105, 0x01),
                (0x20c, 0x90),
                (0xe3, 0x20),
                (0xdf, 9),
                (0xe6, 0x02),
            ] {
                expected[base + offset] = value;
            }
            seal(&mut expected, slot);
            assert_eq!(out, expected, "slot {slot}");
        }
        assert!(edit_slot(&handlers, &bytes, 0, &[("slates", SaveValue::U32(5))]).is_err());
        assert!(
            edit_slot(
                &handlers,
                &bytes,
                0,
                &[("dungeon.00.small_keys", SaveValue::U32(10))]
            )
            .is_err()
        );
    }
}
