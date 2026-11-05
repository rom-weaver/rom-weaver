use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

const SLOT_SIZE: usize = 0xa00;
const CHARACTER_STRIDE: usize = 0x50;
const CHARACTER_BLOCK: usize = 0x200;

/// Experience required to reach levels 2 through 99.
const LEVEL_EXPERIENCE: [i64; 98] = [
    20, 60, 130, 240, 400, 620, 920, 1320, 1840, 2490, 3280, 4220, 5320, 6590, 8040, 9680, 11520,
    13570, 15840, 18340, 21080, 24070, 27320, 30840, 34640, 38730, 43120, 47820, 52840, 58190,
    63880, 69920, 76320, 83090, 90240, 97780, 105720, 114070, 122840, 132040, 141680, 151770,
    162320, 173340, 184840, 196830, 209320, 222320, 235840, 249890, 264480, 279620, 295320, 311590,
    328440, 345880, 363920, 382570, 401840, 421740, 442280, 463470, 485320, 507840, 531040, 554930,
    579520, 604820, 630840, 657590, 685080, 713320, 742320, 772090, 802640, 833980, 866120, 899070,
    932840, 967440, 1002880, 1039170, 1076320, 1114340, 1153240, 1193030, 1233720, 1275320,
    1317840, 1361290, 1405680, 1451020, 1497320, 1544590, 1592840, 1642080, 1692320, 1743570,
];

// Characters in save order; the names are the defaults the game assigns.
const CHARACTERS: [(&str, &str); 7] = [
    ("crono", "Crono"),
    ("marle", "Marle"),
    ("lucca", "Lucca"),
    ("robo", "Robo"),
    ("frog", "Frog"),
    ("ayla", "Ayla"),
    ("magus", "Magus"),
];

fn checksum(bytes: &[u8], base: usize) -> u16 {
    (base..base + SLOT_SIZE)
        .step_by(2)
        .fold(0u32, |sum, offset| {
            (sum + u32::from(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))) % 0xffff
        }) as u16
}

fn experience_for_level(level: i64) -> i64 {
    usize::try_from(level - 2)
        .ok()
        .and_then(|index| LEVEL_EXPERIENCE.get(index))
        .copied()
        .unwrap_or(0)
}

fn level_for_experience(experience: i64) -> i64 {
    LEVEL_EXPERIENCE
        .iter()
        .rposition(|threshold| experience >= *threshold)
        .map_or(1, |index| index as i64 + 2)
}

// Remaining experience to the next level, or zero at the level cap.
fn next_experience(level: i64, experience: i64) -> i64 {
    usize::try_from(level - 1)
        .ok()
        .and_then(|index| LEVEL_EXPERIENCE.get(index))
        .map_or(0, |threshold| threshold - experience)
}

fn scalar(offset: usize, storage: Storage) -> Scalar {
    Scalar {
        offset,
        storage,
        mask: None,
    }
}

fn store(
    offset: usize,
    storage: Storage,
    value: impl Fn(&[u8]) -> Result<i64> + Send + Sync + 'static,
) -> Store {
    Store {
        when: None,
        destination: scalar(offset, storage),
        value: ReadValue::new(value),
    }
}

fn on_edit(on_edit: Vec<Store>) -> field::FieldBehavior {
    field::FieldBehavior {
        on_edit,
        ..Default::default()
    }
}

// Writing a level resets the character's experience to the level's threshold, and writing experience derives the level; both refresh the stored remaining experience.
fn progression_fields(prefix: &str, name: &str, block: usize) -> Vec<FieldDefinition> {
    let (level, experience, next) = (block + 0x12, block + 0x13, block + 0x2b);
    let level_edit = on_edit(vec![
        store(experience, Storage::U24Le, move |bytes| {
            Ok(experience_for_level(i64::from(bytes[level])))
        }),
        store(next, Storage::U16Le, move |bytes| {
            let experience = scalar(experience, Storage::U24Le).read(bytes)?;
            Ok(next_experience(i64::from(bytes[level]), experience))
        }),
    ]);
    let experience_edit = on_edit(vec![
        store(level, Storage::U8, move |bytes| {
            Ok(level_for_experience(
                scalar(experience, Storage::U24Le).read(bytes)?,
            ))
        }),
        store(next, Storage::U16Le, move |bytes| {
            let experience = scalar(experience, Storage::U24Le).read(bytes)?;
            Ok(next_experience(
                level_for_experience(experience),
                experience,
            ))
        }),
    ]);
    vec![
        catalog_field(
            &format!("party.{prefix}.level"),
            &format!("{name} level"),
            level,
            Storage::U8,
        )
        .min(1)
        .max(99)
        .behavior(level_edit),
        catalog_field(
            &format!("party.{prefix}.experience"),
            &format!("{name} experience"),
            experience,
            Storage::U24Le,
        )
        .min(0)
        .max(9_999_999)
        .behavior(experience_edit),
    ]
}

fn character_fields(index: usize, base: usize) -> Vec<FieldDefinition> {
    let (prefix, name) = CHARACTERS[index];
    let block = base + CHARACTER_BLOCK + index * CHARACTER_STRIDE;
    let mut fields = progression_fields(prefix, name, block);
    fields.extend([
        catalog_field(
            &format!("party.{prefix}.tech_points"),
            &format!("{name} tech points"),
            block + 0x16,
            Storage::U24Le,
        )
        .min(0)
        .max(9_999_999),
        catalog_field(
            &format!("party.{prefix}.hp"),
            &format!("{name} current HP"),
            block + 0x3,
            Storage::U16Le,
        )
        .min(0)
        .max(999),
        catalog_field(
            &format!("party.{prefix}.mp"),
            &format!("{name} current MP"),
            block + 0x7,
            Storage::U16Le,
        )
        .min(0)
        .max(99),
        catalog_field(
            &format!("party.{prefix}.max_mp"),
            &format!("{name} maximum MP"),
            block + 0x9,
            Storage::U16Le,
        )
        .min(0)
        .max(99),
        catalog_field(
            &format!("party.{prefix}.element"),
            &format!("{name} element"),
            block + 0x1,
            Storage::U8,
        )
        .mask(0xf0)
        .choices(choices(&[
            ("Fire", 1),
            ("Water", 2),
            ("Shadow", 4),
            ("Lightning", 8),
        ])),
    ]);
    for (id, label, offset) in [
        ("weapon", "weapon", 0x29),
        ("helmet", "helmet", 0x27),
        ("armor", "armor", 0x28),
        ("accessory", "accessory", 0x2a),
    ] {
        fields.push(
            catalog_field(
                &format!("party.{prefix}.{id}"),
                &format!("{name} {label} item code"),
                block + offset,
                Storage::U8,
            )
            .description("Raw item code; the game does not validate it against the slot.".into()),
        );
    }
    fields
}

const BUTTONS: [(&str, i64); 7] = [
    ("S", 0x02),
    ("B", 0x08),
    ("Y", 0x04),
    ("R", 0x10),
    ("L", 0x20),
    ("X", 0x40),
    ("A", 0x80),
];

fn option_fields(base: usize) -> Vec<FieldDefinition> {
    let mut fields = vec![
        catalog_field(
            "options.battle_speed",
            "Battle speed (stored 0-7)",
            base + 0x590,
            Storage::U8,
        )
        .mask(0x07),
        catalog_field(
            "options.window_color",
            "Window color (stored 0-7)",
            base + 0x591,
            Storage::U8,
        )
        .mask(0x07),
        catalog_field(
            "options.battle_gauge",
            "Battle gauge",
            base + 0x592,
            Storage::U8,
        )
        .mask(0x03)
        .choices(choices(&[("Off", 0), ("1", 1), ("2", 2)])),
    ];
    for (id, label, offset, mask, off, on) in [
        ("stereo", "Stereo", 0x590, 0x08, "On", "Off"),
        ("battle_mode", "Battle mode", 0x590, 0x40, "Wait", "Active"),
        (
            "control_pad",
            "Control pad",
            0x590,
            0x10,
            "Standard",
            "Custom",
        ),
        (
            "skill_item_info",
            "Skill/item info",
            0x590,
            0x80,
            "Off",
            "On",
        ),
        (
            "save_menu_cursor",
            "Save menu cursor",
            0x590,
            0x20,
            "No",
            "Yes",
        ),
        (
            "save_battle_cursor",
            "Save battle cursor",
            0x591,
            0x40,
            "No",
            "Yes",
        ),
        (
            "save_skill_item_cursor",
            "Save skill/item cursor",
            0x591,
            0x80,
            "No",
            "Yes",
        ),
    ] {
        fields.push(
            catalog_field(&format!("options.{id}"), label, base + offset, Storage::U8)
                .mask(mask)
                .choices(choices(&[(off, 0), (on, 1)])),
        );
    }
    for (index, label) in ["Confirm", "Cancel", "Menu", "Dash", "Map", "Warp"]
        .into_iter()
        .enumerate()
    {
        fields.push(
            catalog_field(
                &format!("options.button.{}", label.to_lowercase()),
                &format!("{label} button"),
                base + 0x593 + index,
                Storage::U8,
            )
            .choices(choices(&BUTTONS)),
        );
    }
    fields
}

fn formation_fields(base: usize) -> Vec<FieldDefinition> {
    let mut members: Vec<(i64, &str)> = CHARACTERS
        .iter()
        .enumerate()
        .map(|(index, (_, name))| (index as i64, *name))
        .collect();
    members.push((0x80, "None"));
    let entries: Vec<(&str, i64)> = members
        .iter()
        .map(|(value, name)| (*name, *value))
        .collect();
    (0..9)
        .map(|index| {
            let (id, label) = if index < 3 {
                (
                    format!("formation.main_{}", index + 1),
                    format!("Main party member {}", index + 1),
                )
            } else {
                (
                    format!("formation.reserve_{}", index - 2),
                    format!("Reserve member {}", index - 2),
                )
            };
            catalog_field(&id, &label, base + 0x580 + index, Storage::U8).choices(choices(&entries))
        })
        .collect()
}

// Layout, slot markers, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/chrono-trigger/saveEditor
// Current layout (the upstream checksum order change in f34a137a is intentionally not applied): https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/chrono-trigger/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3).map(|slot| {
        let base = slot * SLOT_SIZE;
        let checksum_offset = 0x1ff0 + slot * 2;
        let check = Check { when: None, assert: Condition::new(move |bytes| Ok(u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]) == checksum(bytes, base))), code: "chrono_trigger_checksum".into(), message: "the Chrono Trigger slot checksum is invalid".into(), section_id: None, warning: None };
        let mut fields = vec![
            catalog_field("gold", "Gold", base + 0x5e0, Storage::U24Le).min(0).max(9_999_999),
            catalog_field("inventory.first_item", "First inventory item code", base + 0x2c5, Storage::U8).editable(false),
            catalog_field("save_count", "Save count", base + 0x59c, Storage::U16Le),
            catalog_field("events.silver_points", "Millennial Fair silver points", base + 0x655, Storage::U8).min(0).max(200),
            catalog_field("events.cat_food_ounces", "Ounces of cat food", base + 0x662, Storage::U8).min(0).max(200),
            catalog_field("system.new_game_plus", "New Game+", 0x1fe2, Storage::U8)
                .choices(choices(&[("Locked", 0), ("Unlocked", 0xff)]))
                .description("Shared by every slot; stored outside the slot checksum ranges.".into()),
        ];
        fields.extend(option_fields(base));
        fields.extend(formation_fields(base));
        for index in 0..CHARACTERS.len() {
            fields.extend(character_fields(index, base));
        }
        GameDefinition {
            fields,
            description: format!("Edits slot {}: gold, save count, Millennial Fair counters, options, button mapping, party formation, and per-character level, experience, tech points, HP/MP, element, and equipment codes. Level and experience edits refresh the derived experience values. Inventory pairs, techs, base stats, locations, and progression are omitted because they have coupled write rules.", slot + 1),
            signatures: vec![SignatureDefinition { offset: 0x1ff8 + slot * 2, bytes: vec![0x1b, 0xe4] }],
            runtime: runtime::Runtime { recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: checksum_offset, storage: Storage::U16Le, mask: None }, value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))) }], ..Default::default() },
            ..GameDefinition::new(format!("chrono-trigger-slot-{}", slot + 1), format!("Chrono Trigger (Slot {})", slot + 1), "snes".into(), 8192)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent transcription of the base loop: add, then fold, going up.
    fn reference_checksum(bytes: &[u8], base: usize) -> u16 {
        let mut sum: u64 = 0;
        for offset in (base..base + SLOT_SIZE).step_by(2) {
            sum = (sum + u64::from(bytes[offset]) + (u64::from(bytes[offset + 1]) << 8)) % 0xffff;
        }
        sum as u16
    }

    fn template(fill: u8) -> Vec<u8> {
        let mut bytes = vec![fill; 8192];
        for slot in 0..3 {
            bytes[0x1ff8 + slot * 2..0x1ffa + slot * 2].copy_from_slice(&[0x1b, 0xe4]);
        }
        repair(&mut bytes);
        bytes
    }

    fn repair(bytes: &mut [u8]) {
        for slot in 0..3 {
            let sum = reference_checksum(bytes, slot * SLOT_SIZE);
            bytes[0x1ff0 + slot * 2..0x1ff2 + slot * 2].copy_from_slice(&sum.to_le_bytes());
        }
    }

    fn input(
        handler: &SchemaSaveHandler,
        bytes: Vec<u8>,
    ) -> (SaveDetectionInput, SaveGameIdentity) {
        let identity = handler.definitions().remove(0).identity;
        (
            SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            },
            identity,
        )
    }

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    fn choice(name: &str) -> SaveValue {
        SaveValue::Enum(name.into())
    }

    fn apply(handler: &SchemaSaveHandler, bytes: Vec<u8>, edits: &[SaveEdit]) -> Result<Vec<u8>> {
        let (input, identity) = input(handler, bytes);
        Ok(handler
            .apply(&input, &identity, edits, false)?
            .bytes
            .expect("edited bytes"))
    }

    #[test]
    fn checksum_matches_reference_vector_and_end_around_carry() {
        let bytes: Vec<u8> = (0..8192).map(|offset| offset as u8).collect();
        assert_eq!(checksum(&bytes, 0), 0x7d82);
        assert_eq!(checksum(&bytes, 0x1400), 0x7d82);
        assert_eq!(checksum(&vec![0xff; 8192], 0), 0);
    }
    #[test]
    fn edit_repairs_slot_checksum_and_preserves_system_area() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x33; 8192];
        bytes[0x1ff8..0x1ffa].copy_from_slice(&[0x1b, 0xe4]);
        let sum = checksum(&bytes, 0);
        bytes[0x1ff0..0x1ff2].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x5e0..0x5e3].copy_from_slice(&[0x56, 0x34, 0x12]);
        let sum = checksum(&expected, 0);
        expected[0x1ff0..0x1ff2].copy_from_slice(&sum.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "gold".into(),
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
        bad.bytes[9] ^= 1;
        assert!(matches!(
            handler.recognize(&bad).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    #[test]
    fn scalar_option_formation_and_character_fields_write_only_their_bytes() {
        let handler = schemas().remove(1);
        let bytes = template(0x33);
        let base = SLOT_SIZE;
        let block = base + 0x200 + 2 * 0x50;
        let edits = [
            edit("save_count", SaveValue::U32(0x1234)),
            edit("events.silver_points", SaveValue::U32(150)),
            edit("events.cat_food_ounces", SaveValue::U32(200)),
            edit("system.new_game_plus", choice("Unlocked")),
            edit("options.battle_speed", SaveValue::U32(6)),
            edit("options.stereo", choice("Off")),
            edit("options.battle_mode", choice("Active")),
            edit("options.battle_gauge", choice("2")),
            edit("options.button.dash", choice("L")),
            edit("formation.main_2", choice("Lucca")),
            edit("formation.reserve_3", choice("None")),
            edit("party.lucca.tech_points", SaveValue::U32(123_456)),
            edit("party.lucca.hp", SaveValue::U32(321)),
            edit("party.lucca.mp", SaveValue::U32(45)),
            edit("party.lucca.max_mp", SaveValue::U32(99)),
            edit("party.lucca.element", choice("Shadow")),
            edit("party.lucca.weapon", SaveValue::U32(0x15)),
        ];
        let mut expected = bytes.clone();
        expected[base + 0x59c..base + 0x59e].copy_from_slice(&[0x34, 0x12]);
        expected[base + 0x655] = 150;
        expected[base + 0x662] = 200;
        expected[0x1fe2] = 0xff;
        expected[base + 0x590] = 0x7e;
        expected[base + 0x592] = 0x32;
        expected[base + 0x596] = 0x20;
        expected[base + 0x581] = 2;
        expected[base + 0x585] = 0x80;
        expected[block + 0x16..block + 0x19].copy_from_slice(&[0x40, 0xe2, 0x01]);
        expected[block + 3..block + 5].copy_from_slice(&321u16.to_le_bytes());
        expected[block + 7..block + 9].copy_from_slice(&45u16.to_le_bytes());
        expected[block + 9..block + 0xb].copy_from_slice(&99u16.to_le_bytes());
        expected[block + 1] = 0x43;
        expected[block + 0x29] = 0x15;
        repair(&mut expected);
        assert_eq!(apply(&handler, bytes.clone(), &edits).unwrap(), expected);
        for (field, value) in [
            ("events.silver_points", SaveValue::U32(201)),
            ("party.lucca.hp", SaveValue::U32(1000)),
            ("party.lucca.element", choice("Wind")),
            ("options.button.dash", choice("Z")),
        ] {
            assert!(
                apply(&handler, bytes.clone(), &[edit(field, value)]).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn level_and_experience_edits_refresh_derived_experience() {
        let handler = schemas().remove(1);
        let bytes = template(0x33);
        let block = SLOT_SIZE + 0x200 + 2 * 0x50;
        for (level, experience, next) in [
            (1u32, 0u32, 20u16),
            (2, 20, 40),
            (5, 240, 160),
            (99, 1_743_570, 0),
        ] {
            let mut expected = bytes.clone();
            expected[block + 0x12] = level as u8;
            expected[block + 0x13..block + 0x16].copy_from_slice(&experience.to_le_bytes()[..3]);
            expected[block + 0x2b..block + 0x2d].copy_from_slice(&next.to_le_bytes());
            repair(&mut expected);
            let output = apply(
                &handler,
                bytes.clone(),
                &[edit("party.lucca.level", SaveValue::U32(level))],
            )
            .unwrap();
            assert_eq!(output, expected, "level {level}");
        }
        for (experience, level, next) in [
            (0u32, 1u8, 20u16),
            (19, 1, 1),
            (20, 2, 40),
            (1000, 8, 320),
            (1_743_570, 99, 0),
            (9_999_999, 99, 0),
        ] {
            let mut expected = bytes.clone();
            expected[block + 0x12] = level;
            expected[block + 0x13..block + 0x16].copy_from_slice(&experience.to_le_bytes()[..3]);
            expected[block + 0x2b..block + 0x2d].copy_from_slice(&next.to_le_bytes());
            repair(&mut expected);
            let output = apply(
                &handler,
                bytes.clone(),
                &[edit("party.lucca.experience", SaveValue::U32(experience))],
            )
            .unwrap();
            assert_eq!(output, expected, "experience {experience}");
        }
        for level in [0, 100] {
            assert!(
                apply(
                    &handler,
                    bytes.clone(),
                    &[edit("party.lucca.level", SaveValue::U32(level))]
                )
                .is_err()
            );
        }
    }
}
