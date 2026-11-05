use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;
use tracing::trace;

const SLOT_SIZE: usize = 0x38c;

fn checksum(bytes: &[u8], base: usize) -> u16 {
    let sum = (base + 6..base + SLOT_SIZE)
        .step_by(2)
        .fold(0u32, |sum, offset| {
            (sum + u32::from(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))) % 0xffff
        });
    trace!(base, sum, "computed Mystic Quest slot checksum");
    sum as u16
}

const COMPANION_CHARACTERS: [(&str, i64); 9] = [
    ("None", 0x0f),
    ("Kaeli (1st encounter)", 1),
    ("Tristam (1st encounter)", 2),
    ("Phoebe (1st encounter)", 3),
    ("Reuben (1st encounter)", 4),
    ("Kaeli (2nd encounter)", 5),
    ("Tristam (2nd encounter)", 6),
    ("Phoebe (2nd encounter)", 7),
    ("Reuben (2nd encounter)", 8),
];

// Bit positions are (offset in the character block, bit); the game stores each list from the high bit down.
const WEAPONS: [(&str, usize, u8); 12] = [
    ("Steel Sword", 0x38, 7),
    ("Knight Sword", 0x38, 6),
    ("Excalibur", 0x38, 5),
    ("Axe", 0x38, 4),
    ("Battle Axe", 0x38, 3),
    ("Giant's Axe", 0x38, 2),
    ("Cat Claw", 0x38, 1),
    ("Charm Claw", 0x38, 0),
    ("Dragon Claw", 0x39, 7),
    ("Bomb", 0x39, 6),
    ("Jumbo Bomb", 0x39, 5),
    ("Mega Grenade", 0x39, 4),
];
const ARMORS: [(&str, usize, u8); 12] = [
    ("Steel Helm", 0x3b, 7),
    ("Moon Helm", 0x3b, 6),
    ("Apollo Helm", 0x3b, 5),
    ("Steel Armor", 0x3b, 4),
    ("Noble Armor", 0x3b, 3),
    ("Gaia's Armor", 0x3b, 2),
    ("Steel Shield", 0x3c, 5),
    ("Venus Shield", 0x3c, 4),
    ("Aegis Shield", 0x3c, 3),
    ("Charm", 0x3c, 1),
    ("Magic Ring", 0x3c, 0),
    ("Cupid Locket", 0x3d, 7),
];
const SPELLS: [(&str, usize, u8); 12] = [
    ("Exit", 0x3e, 7),
    ("Cure", 0x3e, 6),
    ("Heal", 0x3e, 5),
    ("Life", 0x3e, 4),
    ("Quack", 0x3e, 3),
    ("Blizzard", 0x3e, 2),
    ("Fire", 0x3e, 1),
    ("Aero", 0x3e, 0),
    ("Thunder", 0x3f, 7),
    ("White", 0x3f, 6),
    ("Meteor", 0x3f, 5),
    ("Flare", 0x3f, 4),
];
const KEY_ITEMS: [(&str, usize, u8); 16] = [
    ("Elixir", 0xc8, 7),
    ("Tree Wither", 0xc8, 6),
    ("Wakewater", 0xc8, 5),
    ("Venus Key", 0xc8, 4),
    ("Multi-Key", 0xc8, 3),
    ("Mask", 0xc8, 2),
    ("Magic Mirror", 0xc8, 1),
    ("Thunder Rock", 0xc8, 0),
    ("Captain's Cap", 0xc9, 7),
    ("Libra Crest", 0xc9, 6),
    ("Gemini Crest", 0xc9, 5),
    ("Mobius Crest", 0xc9, 4),
    ("Sand Coin", 0xc9, 3),
    ("River Coin", 0xc9, 2),
    ("Sun Coin", 0xc9, 1),
    ("Sky Coin", 0xc9, 0),
];

fn slug(label: &str) -> String {
    label
        .chars()
        .filter_map(|character| match character {
            'a'..='z' | '0'..='9' => Some(character),
            'A'..='Z' => Some(character.to_ascii_lowercase()),
            ' ' | '-' => Some('_'),
            _ => None,
        })
        .collect()
}

fn flag_fields(
    fields: &mut Vec<FieldDefinition>,
    prefix: &str,
    block: usize,
    flags: &[(&str, usize, u8)],
) {
    for (label, offset, bit) in flags {
        fields.push(
            catalog_field(
                &format!("{prefix}.{}", slug(label)),
                label,
                block + offset,
                Storage::Bit,
            )
            .bit(*bit),
        );
    }
}

// Editing a displayed stat also moves the stored equipment-adjusted value and the saved base copy by the same amount.
fn stat_edit(stat: usize, adjusted: usize, base: usize) -> field::FieldBehavior {
    field::FieldBehavior {
        on_edit: vec![
            Store {
                when: None,
                destination: Scalar {
                    offset: adjusted,
                    storage: Storage::U8,
                    mask: None,
                },
                value: ReadValue::new(move |bytes| {
                    Ok(
                        i64::from(bytes[stat]) + i64::from(bytes[adjusted])
                            - i64::from(bytes[base]),
                    )
                }),
            },
            Store {
                when: None,
                destination: Scalar {
                    offset: base,
                    storage: Storage::U8,
                    mask: None,
                },
                value: ReadValue::new(move |bytes| Ok(i64::from(bytes[stat]))),
            },
        ],
        ..Default::default()
    }
}

fn character_fields(
    prefix: &str,
    name: &str,
    block: usize,
    companion: bool,
) -> Vec<FieldDefinition> {
    let id = |suffix: &str| format!("party.{prefix}.{suffix}");
    let label = |suffix: &str| format!("{name} {suffix}");
    let mut fields = vec![
        catalog_field(
            &id("experience"),
            &label("experience"),
            block + 0x17,
            Storage::U24Le,
        )
        .min(0)
        .max(9_999_999),
        catalog_field(
            &id("hp"),
            &label("current HP"),
            block + 0x1a,
            Storage::U16Le,
        )
        .min(0)
        .max(1640),
        catalog_field(
            &id("max_hp"),
            &label("maximum HP"),
            block + 0x1c,
            Storage::U16Le,
        )
        .min(1)
        .max(1640),
        catalog_field(
            &id("accuracy"),
            &label("accuracy"),
            block + 0x46,
            Storage::U8,
        )
        .min(0)
        .max(200),
        catalog_field(
            &id("ammo"),
            &label("ammo quantity"),
            block + 0x36,
            Storage::U8,
        )
        .min(0)
        .max(99),
    ];
    for (index, (magic, current, maximum)) in [
        ("white_magic", 0x1e, 0x21),
        ("black_magic", 0x1f, 0x22),
        ("sorcery", 0x20, 0x23),
    ]
    .into_iter()
    .enumerate()
    {
        let text = ["white magic", "black magic", "sorcery"][index];
        fields.push(
            catalog_field(
                &id(magic),
                &label(&format!("current {text}")),
                block + current,
                Storage::U8,
            )
            .min(0)
            .max(99),
        );
        fields.push(
            catalog_field(
                &id(&format!("max_{magic}")),
                &label(&format!("maximum {text}")),
                block + maximum,
                Storage::U8,
            )
            .min(0)
            .max(99),
        );
    }
    for (index, stat) in ["attack", "defense", "speed", "magic"]
        .into_iter()
        .enumerate()
    {
        fields.push(
            catalog_field(&id(stat), &label(stat), block + 0x52 + index, Storage::U8)
                .min(0)
                .max(200)
                .behavior(stat_edit(
                    block + 0x52 + index,
                    block + 0x28 + index,
                    block + 0x2c + index,
                )),
        );
    }
    for (suffix, text, bit) in [
        ("silence", "Silence", 0),
        ("blind", "Blind", 1),
        ("poison", "Poison", 2),
        ("fatal", "Fatal", 7),
    ] {
        fields.push(
            catalog_field(
                &id(&format!("condition.{suffix}")),
                &label(&format!("{text} status")),
                block + 0x27,
                Storage::Bit,
            )
            .bit(bit),
        );
    }
    flag_fields(&mut fields, &id("weapons"), block, &WEAPONS);
    flag_fields(&mut fields, &id("armors"), block, &ARMORS);
    flag_fields(&mut fields, &id("spells"), block, &SPELLS);
    if companion {
        // The level byte doubles as the "slot is empty" marker (0xff), so changing the character resets it.
        let level = block + 0x16;
        let character = block + 0x26;
        fields.push(
            catalog_field(
                &id("character"),
                "Companion character",
                character,
                Storage::U8,
            )
            .mask(0x7f)
            .choices(choices(&COMPANION_CHARACTERS))
            .behavior(field::FieldBehavior {
                on_edit: vec![Store {
                    when: None,
                    destination: Scalar {
                        offset: level,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: ReadValue::new(move |bytes| {
                        Ok(if bytes[character] & 0x7f == 0x0f {
                            0xff
                        } else {
                            1
                        })
                    }),
                }],
                ..Default::default()
            }),
        );
        fields.push(
            catalog_field(&id("level"), "Companion level", level, Storage::U8)
                .min(1)
                .max(41)
                .behavior(field::FieldBehavior {
                    editable_when: Some(Condition::new(move |bytes| Ok(bytes[level] != 0xff))),
                    ..Default::default()
                }),
        );
    }
    fields
}

// Layout, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/mystic-quest-legend/saveEditor
// Current layout and write rules: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/mystic-quest-legend/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3).map(|slot| {
        let base = slot * SLOT_SIZE;
        let check = Check { when: None, assert: Condition::new(move |bytes| Ok(u16::from_le_bytes([bytes[base + 4], bytes[base + 5]]) == checksum(bytes, base))), code: "mystic_quest_checksum".into(), message: "the Mystic Quest slot checksum is invalid".into(), section_id: None, warning: None };
        let mut fields = vec![
            catalog_field("money", "Money", base + 0xa6, Storage::U24Le).min(0).max(9_999_999),
            catalog_field("location", "Location code", base + 0xb3, Storage::U8),
            catalog_field("party.hero.level", "Hero level", base + 0x16, Storage::U8).min(1).max(41),
            catalog_field("play_time", "Play time (frames at 60 per second)", base + 0xb9, Storage::U32Le).min(0).max(215_999_999),
            catalog_field("options.control", "Control", base + 0x76, Storage::U8).mask(0x80).choices(choices(&[("Manual", 0), ("Auto", 1)])),
            catalog_field("options.message_speed", "Message speed (stored 0-6)", base + 0xbd, Storage::U8).min(0).max(6),
        ];
        fields.extend(character_fields("hero", "Hero", base, false));
        fields.extend(character_fields("companion", "Companion", base + 0x50, true));
        for index in 0..4 {
            fields.push(
                catalog_field(&format!("items.slot_{}.item", index + 1), &format!("Item slot {}", index + 1), base + 0xc0 + index * 2, Storage::U8)
                    .choices(choices(&[("Cure", 0x10), ("Heal", 0x11), ("Seed", 0x12), ("Refresher", 0x13), ("Empty", 0xff)])),
            );
            fields.push(catalog_field(&format!("items.slot_{}.quantity", index + 1), &format!("Item slot {} quantity", index + 1), base + 0xc1 + index * 2, Storage::U8).min(0).max(99));
        }
        flag_fields(&mut fields, "key_items", base, &KEY_ITEMS);
        for index in 0..20 {
            fields.push(catalog_field(&format!("battlefields.remaining_rounds_{}", index + 1), &format!("Battlefield {} remaining rounds", index + 1), base + 0x1f6 + index, Storage::U8).min(0).max(10));
        }
        GameDefinition {
            fields,
            description: format!("Edits slot {}: money, play time, options, items, key items, battlefield rounds, and per-character experience, HP, magic points, stats, status, and weapon/armor/spell ownership. Stat edits keep the equipment-adjusted and base copies in step; companion changes reset the level marker. Names, equipment slots, locations, and colors are omitted.", slot + 1),
            signatures: vec![SignatureDefinition { offset: base, bytes: b"FF0!".to_vec() }],
            runtime: runtime::Runtime { recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: base + 4, storage: Storage::U16Le, mask: None }, value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))) }], ..Default::default() },
            ..GameDefinition::new(format!("mystic-quest-legend-slot-{}", slot + 1), format!("Mystic Quest Legend (Slot {})", slot + 1), "snes".into(), 8192)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edit_repairs_modulo_checksum_and_preserves_other_slots() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0xa5; 8192];
        bytes[..4].copy_from_slice(b"FF0!");
        let sum = checksum(&bytes, 0);
        bytes[4..6].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0xa6..0xa9].copy_from_slice(&[0x56, 0x34, 0x12]);
        let sum = checksum(&expected, 0);
        expected[4..6].copy_from_slice(&sum.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "money".into(),
                    value: SaveValue::U32(0x123456),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(output, expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[6] ^= 1;
        assert!(matches!(
            handler.recognize(&bad).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    // Independent transcription of the upstream loop: add each word, then reduce modulo 0xffff.
    fn reference_checksum(bytes: &[u8], base: usize) -> u16 {
        let mut sum: u32 = 0;
        for word in bytes[base + 6..base + SLOT_SIZE].chunks(2) {
            sum += u32::from(word[0]) | (u32::from(word[1]) << 8);
            sum %= 0xffff;
        }
        sum as u16
    }

    fn repair(bytes: &mut [u8], base: usize) {
        let sum = reference_checksum(bytes, base);
        bytes[base + 4..base + 6].copy_from_slice(&sum.to_le_bytes());
    }

    fn slot_template(fill: u8) -> Vec<u8> {
        let mut bytes = vec![fill; 8192];
        for slot in 0..3 {
            bytes[slot * SLOT_SIZE..slot * SLOT_SIZE + 4].copy_from_slice(b"FF0!");
            repair(&mut bytes, slot * SLOT_SIZE);
        }
        bytes
    }

    fn apply(handler: &SchemaSaveHandler, bytes: Vec<u8>, edits: &[SaveEdit]) -> Result<Vec<u8>> {
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        Ok(handler
            .apply(&input, &identity, edits, false)?
            .bytes
            .expect("edited bytes"))
    }

    #[test]
    fn checksum_reduces_after_every_word() {
        let bytes: Vec<u8> = (0..8192).map(|offset| (offset * 7) as u8).collect();
        for base in [0, SLOT_SIZE, 2 * SLOT_SIZE] {
            assert_eq!(checksum(&bytes, base), reference_checksum(&bytes, base));
        }
        let mut wrap = vec![0xff; 8192];
        assert_eq!(checksum(&wrap, 0), 0);
        wrap[6..8].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(checksum(&wrap, 0), 1);
    }

    #[test]
    fn slot_party_item_and_option_fields_write_only_their_bytes() {
        let handler = schemas().remove(2);
        let base = 2 * SLOT_SIZE;
        let companion = base + 0x50;
        let bytes = slot_template(0xa5);
        let choice = |name: &str| SaveValue::Enum(name.into());
        let edits = [
            edit("play_time", SaveValue::U32(215_999_999)),
            edit("options.control", choice("Manual")),
            edit("options.message_speed", SaveValue::U32(6)),
            edit("party.hero.experience", SaveValue::U32(9_999_999)),
            edit("party.hero.hp", SaveValue::U32(1640)),
            edit("party.hero.max_hp", SaveValue::U32(1640)),
            edit("party.hero.white_magic", SaveValue::U32(99)),
            edit("party.companion.max_sorcery", SaveValue::U32(0)),
            edit("party.companion.accuracy", SaveValue::U32(200)),
            edit("party.hero.condition.poison", SaveValue::Bool(false)),
            edit("party.hero.weapons.excalibur", SaveValue::Bool(false)),
            edit(
                "party.companion.armors.cupid_locket",
                SaveValue::Bool(false),
            ),
            edit("party.companion.spells.exit", SaveValue::Bool(false)),
            edit("key_items.sky_coin", SaveValue::Bool(false)),
            edit("key_items.elixir", SaveValue::Bool(false)),
            edit("items.slot_2.item", choice("Seed")),
            edit("items.slot_2.quantity", SaveValue::U32(99)),
            edit("battlefields.remaining_rounds_20", SaveValue::U32(10)),
        ];
        let mut expected = bytes.clone();
        expected[base + 0xb9..base + 0xbd].copy_from_slice(&215_999_999u32.to_le_bytes());
        expected[base + 0x76] &= 0x7f;
        expected[base + 0xbd] = 6;
        expected[base + 0x17..base + 0x1a].copy_from_slice(&9_999_999u32.to_le_bytes()[..3]);
        expected[base + 0x1a..base + 0x1c].copy_from_slice(&1640u16.to_le_bytes());
        expected[base + 0x1c..base + 0x1e].copy_from_slice(&1640u16.to_le_bytes());
        expected[base + 0x1e] = 99;
        expected[companion + 0x23] = 0;
        expected[companion + 0x46] = 200;
        expected[base + 0x27] &= !0x04;
        expected[base + 0x38] &= !0x20;
        expected[companion + 0x3d] &= !0x80;
        expected[companion + 0x3e] &= !0x80;
        expected[base + 0xc9] &= !0x01;
        expected[base + 0xc8] &= !0x80;
        expected[base + 0xc2] = 0x12;
        expected[base + 0xc3] = 99;
        expected[base + 0x209] = 10;
        repair(&mut expected, base);
        assert_eq!(apply(&handler, bytes.clone(), &edits).unwrap(), expected);
        for (field, value) in [
            ("play_time", SaveValue::U32(216_000_000)),
            ("party.hero.hp", SaveValue::U32(1641)),
            ("party.hero.max_hp", SaveValue::U32(0)),
            ("party.hero.white_magic", SaveValue::U32(100)),
            ("battlefields.remaining_rounds_1", SaveValue::U32(11)),
            ("items.slot_1.quantity", SaveValue::U32(100)),
            ("items.slot_1.item", choice("Elixir")),
        ] {
            assert!(
                apply(&handler, bytes.clone(), &[edit(field, value)]).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn stat_edits_keep_equipment_adjusted_and_base_copies_in_step() {
        let handler = schemas().remove(0);
        let mut bytes = slot_template(0);
        // Attack 10 displayed, 25 adjusted by equipment (15 bonus), 10 in the base copy.
        for (stat, adjusted, base) in [(0x52, 0x28, 0x2c), (0xa3, 0x79, 0x7d)] {
            bytes[stat] = 10;
            bytes[adjusted] = 25;
            bytes[base] = 10;
        }
        repair(&mut bytes, 0);
        let mut expected = bytes.clone();
        expected[0x52] = 40;
        expected[0x28] = 55;
        expected[0x2c] = 40;
        expected[0xa3] = 7;
        expected[0x79] = 22;
        expected[0x7d] = 7;
        repair(&mut expected, 0);
        let edits = [
            edit("party.hero.attack", SaveValue::U32(40)),
            edit("party.companion.defense", SaveValue::U32(7)),
        ];
        assert_eq!(apply(&handler, bytes.clone(), &edits).unwrap(), expected);
        // The adjusted copy must stay within a byte and above zero.
        let mut negative = bytes.clone();
        negative[0x28] = 3;
        repair(&mut negative, 0);
        assert!(
            apply(
                &handler,
                negative,
                &[edit("party.hero.attack", SaveValue::U32(2))]
            )
            .is_err()
        );
        let mut overflow = bytes;
        overflow[0x28] = 250;
        repair(&mut overflow, 0);
        assert!(
            apply(
                &handler,
                overflow,
                &[edit("party.hero.attack", SaveValue::U32(200))]
            )
            .is_err()
        );
    }

    #[test]
    fn companion_character_resets_the_level_marker() {
        let handler = schemas().remove(1);
        let base = SLOT_SIZE;
        let mut bytes = slot_template(0);
        bytes[base + 0x66] = 0xff;
        bytes[base + 0x76] = 0x0f;
        repair(&mut bytes, base);
        let choice = |name: &str| SaveValue::Enum(name.into());
        // An empty companion slot cannot have its level edited.
        assert!(
            apply(
                &handler,
                bytes.clone(),
                &[edit("party.companion.level", SaveValue::U32(5))]
            )
            .is_err()
        );
        let mut expected = bytes.clone();
        expected[base + 0x76] = 0x05;
        expected[base + 0x66] = 1;
        repair(&mut expected, base);
        let character = [edit(
            "party.companion.character",
            choice("Kaeli (2nd encounter)"),
        )];
        let occupied = apply(&handler, bytes.clone(), &character).unwrap();
        assert_eq!(occupied, expected);
        expected[base + 0x66] = 5;
        repair(&mut expected, base);
        let occupied = apply(
            &handler,
            occupied,
            &[edit("party.companion.level", SaveValue::U32(5))],
        )
        .unwrap();
        assert_eq!(occupied, expected);
        let mut cleared = occupied;
        cleared = apply(
            &handler,
            cleared,
            &[edit("party.companion.character", choice("None"))],
        )
        .unwrap();
        assert_eq!(cleared[base + 0x66], 0xff);
        assert_eq!(cleared[base + 0x76], 0x0f);
    }
}
