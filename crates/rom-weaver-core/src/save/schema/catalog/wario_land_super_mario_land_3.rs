use super::*;

const PACKED_BCD_DESCRIPTION: &str = concat!(
    "Raw big-endian packed-BCD storage byte; the three-byte decoded ",
    "value is not available in schema v1."
);
const COMPLETION_DESCRIPTION: &str = concat!(
    "Read-only because changing course completion also requires ",
    "recomputing the derived packed-BCD completion count."
);

fn slot_fields(slot: usize) -> Vec<FieldDefinition> {
    let base = (slot - 1) * 64;
    let mut fields = vec![
        FieldDefinition::new(
            "slot_1.current_course".into(),
            "Slot 1 Current Course".into(),
            4,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.gold_bcd_byte_1".into(),
            "Slot 1 Gold packed-BCD byte 1".into(),
            5,
            Storage::U8,
        )
        .description(PACKED_BCD_DESCRIPTION.into()),
        FieldDefinition::new(
            "slot_1.gold_bcd_byte_2".into(),
            "Slot 1 Gold packed-BCD byte 2".into(),
            6,
            Storage::U8,
        )
        .description(PACKED_BCD_DESCRIPTION.into()),
        FieldDefinition::new(
            "slot_1.gold_bcd_byte_3".into(),
            "Slot 1 Gold packed-BCD byte 3".into(),
            7,
            Storage::U8,
        )
        .description(PACKED_BCD_DESCRIPTION.into()),
        FieldDefinition::new(
            "slot_1.hearts_bcd".into(),
            "Slot 1 Hearts packed BCD".into(),
            8,
            Storage::U8,
        )
        .description("Raw packed-BCD storage byte.".into()),
        FieldDefinition::new(
            "slot_1.lives_bcd".into(),
            "Slot 1 Lives packed BCD".into(),
            9,
            Storage::U8,
        )
        .description("Raw packed-BCD storage byte.".into()),
        FieldDefinition::new(
            "slot_1.power_up".into(),
            "Slot 1 Power Up".into(),
            10,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.completed_level_count_bcd".into(),
            "Slot 1 Completed Level Count packed BCD".into(),
            13,
            Storage::U8,
        )
        .description(
            concat!(
                "Derived raw packed-BCD count. Course flags are read-only because ",
                "schema v1 cannot refresh this value."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_1.checkpoint_enabled".into(),
            "Slot 1 Checkpoint Enabled".into(),
            21,
            Storage::Bool,
        ),
        FieldDefinition::new(
            "slot_1.checkpoint_course".into(),
            "Slot 1 Checkpoint Course".into(),
            22,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progression".into(),
            "Slot 1 Progression".into(),
            23,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.treasures.a".into(),
            "Slot 1 Treasure A: Golden Horn".into(),
            14,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.treasures.b".into(),
            "Slot 1 Treasure B: Harp".into(),
            15,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.treasures.c".into(),
            "Slot 1 Treasure C: Crown".into(),
            14,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.treasures.d".into(),
            "Slot 1 Treasure D: Shield".into(),
            15,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.treasures.e".into(),
            "Slot 1 Treasure E: Bell".into(),
            15,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.treasures.f".into(),
            "Slot 1 Treasure F: Lamp".into(),
            14,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.treasures.g".into(),
            "Slot 1 Treasure G: Crystal Ball".into(),
            15,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.treasures.h".into(),
            "Slot 1 Treasure H: Chalice".into(),
            14,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.treasures.i".into(),
            "Slot 1 Treasure I: Dagger".into(),
            14,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.treasures.j".into(),
            "Slot 1 Treasure J: Axe".into(),
            15,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.treasures.k".into(),
            "Slot 1 Treasure K: Football".into(),
            15,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.treasures.l".into(),
            "Slot 1 Treasure L: Idol".into(),
            15,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.treasures.m".into(),
            "Slot 1 Treasure M: Golden Glove".into(),
            15,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.treasures.n".into(),
            "Slot 1 Treasure N: Whale".into(),
            14,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.treasures.o".into(),
            "Slot 1 Treasure O: Diamond Ring".into(),
            14,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.completed.course_01".into(),
            "Slot 1 Course 01 completed".into(),
            11,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_02".into(),
            "Slot 1 Course 02 completed".into(),
            11,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_03".into(),
            "Slot 1 Course 03 completed".into(),
            11,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_03_alt".into(),
            "Slot 1 Course 03' completed".into(),
            11,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_04".into(),
            "Slot 1 Course 04 completed".into(),
            11,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_05".into(),
            "Slot 1 Course 05 completed".into(),
            11,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_06".into(),
            "Slot 1 Course 06 completed".into(),
            11,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_07".into(),
            "Slot 1 Course 07 completed".into(),
            12,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_08".into(),
            "Slot 1 Course 08 completed".into(),
            12,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_08_alt".into(),
            "Slot 1 Course 08' completed".into(),
            12,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_09".into(),
            "Slot 1 Course 09 completed".into(),
            12,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_10".into(),
            "Slot 1 Course 10 completed".into(),
            12,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_11".into(),
            "Slot 1 Course 11 completed".into(),
            12,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_12".into(),
            "Slot 1 Course 12 completed".into(),
            12,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_13".into(),
            "Slot 1 Course 13 completed".into(),
            12,
            Storage::Bit,
        )
        .bit(7)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_14".into(),
            "Slot 1 Course 14 completed".into(),
            19,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_15".into(),
            "Slot 1 Course 15 completed".into(),
            19,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_15_alt".into(),
            "Slot 1 Course 15' completed".into(),
            19,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_16".into(),
            "Slot 1 Course 16 completed".into(),
            19,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_16_alt".into(),
            "Slot 1 Course 16' completed".into(),
            19,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_17".into(),
            "Slot 1 Course 17 completed".into(),
            19,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_18".into(),
            "Slot 1 Course 18 completed".into(),
            19,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_19".into(),
            "Slot 1 Course 19 completed".into(),
            19,
            Storage::Bit,
        )
        .bit(7)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_20".into(),
            "Slot 1 Course 20 completed".into(),
            16,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_21".into(),
            "Slot 1 Course 21 completed".into(),
            16,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_22".into(),
            "Slot 1 Course 22 completed".into(),
            16,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_23".into(),
            "Slot 1 Course 23 completed".into(),
            16,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_23_alt".into(),
            "Slot 1 Course 23' completed".into(),
            16,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_24".into(),
            "Slot 1 Course 24 completed".into(),
            16,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_25".into(),
            "Slot 1 Course 25 completed".into(),
            16,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_26".into(),
            "Slot 1 Course 26 completed".into(),
            17,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_27".into(),
            "Slot 1 Course 27 completed".into(),
            17,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_28".into(),
            "Slot 1 Course 28 completed".into(),
            17,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_29".into(),
            "Slot 1 Course 29 completed".into(),
            17,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_30".into(),
            "Slot 1 Course 30 completed".into(),
            17,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_31".into(),
            "Slot 1 Course 31 completed".into(),
            18,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_32".into(),
            "Slot 1 Course 32 completed".into(),
            18,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_33".into(),
            "Slot 1 Course 33 completed".into(),
            18,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_34".into(),
            "Slot 1 Course 34 completed".into(),
            18,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_35".into(),
            "Slot 1 Course 35 completed".into(),
            18,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_36".into(),
            "Slot 1 Course 36 completed".into(),
            18,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_37".into(),
            "Slot 1 Course 37 completed".into(),
            20,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_38".into(),
            "Slot 1 Course 38 completed".into(),
            20,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        FieldDefinition::new(
            "slot_1.completed.course_39".into(),
            "Slot 1 Course 39 completed".into(),
            20,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
    ];
    for field in &mut fields {
        field.id = field.id.replacen("slot_1", &format!("slot_{slot}"), 1);
        field.label = field.label.replacen("Slot 1", &format!("Slot {slot}"), 1);
        field.offset += base;
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(
        vec![game_wario_land_super_mario_land_3()],
        BTreeMap::new(),
        true,
    )
}

fn game_wario_land_super_mario_land_3() -> GameDefinition {
    let fields = (1..=3).flat_map(slot_fields).collect();
    GameDefinition {
        fields,
        description: concat!(
            "Edits three 0x40-byte slots and repairs their independent ",
            "additive checksums at 0xC0-0xC2. Course completion is read-only ",
            "because its derived packed-BCD count is not refreshed. Gold, ",
            "lives, hearts, and completion count expose raw packed-BCD ",
            "storage; decoded three-byte gold is omitted."
        )
        .into(),
        signatures: vec![SignatureDefinition {
            offset: 0,
            bytes: vec![25, 100, 57, 87],
        }],
        checksums: vec![
            ChecksumDefinition {
                start: Some(0),
                length: Some(32),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add8, 192)
            },
            ChecksumDefinition {
                start: Some(64),
                length: Some(32),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add8, 193)
            },
            ChecksumDefinition {
                start: Some(128),
                length: Some(32),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add8, 194)
            },
        ],
        ..GameDefinition::new(
            "wario-land-super-mario-land-3".into(),
            "Wario Land: Super Mario Land 3".into(),
            "game-boy".into(),
            8192,
        )
    }
}
