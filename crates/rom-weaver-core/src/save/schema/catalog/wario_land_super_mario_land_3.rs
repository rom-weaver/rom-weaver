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
        catalog_field(
            "slot_1.current_course",
            "Slot 1 Current Course",
            4,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.gold_bcd_byte_1",
            "Slot 1 Gold packed-BCD byte 1",
            5,
            Storage::U8,
        )
        .description(PACKED_BCD_DESCRIPTION.into()),
        catalog_field(
            "slot_1.gold_bcd_byte_2",
            "Slot 1 Gold packed-BCD byte 2",
            6,
            Storage::U8,
        )
        .description(PACKED_BCD_DESCRIPTION.into()),
        catalog_field(
            "slot_1.gold_bcd_byte_3",
            "Slot 1 Gold packed-BCD byte 3",
            7,
            Storage::U8,
        )
        .description(PACKED_BCD_DESCRIPTION.into()),
        catalog_field(
            "slot_1.hearts_bcd",
            "Slot 1 Hearts packed BCD",
            8,
            Storage::U8,
        )
        .description("Raw packed-BCD storage byte.".into()),
        catalog_field(
            "slot_1.lives_bcd",
            "Slot 1 Lives packed BCD",
            9,
            Storage::U8,
        )
        .description("Raw packed-BCD storage byte.".into()),
        catalog_field("slot_1.power_up", "Slot 1 Power Up", 10, Storage::U8),
        catalog_field(
            "slot_1.completed_level_count_bcd",
            "Slot 1 Completed Level Count packed BCD",
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
        catalog_field(
            "slot_1.checkpoint_enabled",
            "Slot 1 Checkpoint Enabled",
            21,
            Storage::Bool,
        ),
        catalog_field(
            "slot_1.checkpoint_course",
            "Slot 1 Checkpoint Course",
            22,
            Storage::U8,
        ),
        catalog_field("slot_1.progression", "Slot 1 Progression", 23, Storage::U8),
        catalog_field(
            "slot_1.treasures.a",
            "Slot 1 Treasure A: Golden Horn",
            14,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.treasures.b",
            "Slot 1 Treasure B: Harp",
            15,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.treasures.c",
            "Slot 1 Treasure C: Crown",
            14,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_1.treasures.d",
            "Slot 1 Treasure D: Shield",
            15,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.treasures.e",
            "Slot 1 Treasure E: Bell",
            15,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.treasures.f",
            "Slot 1 Treasure F: Lamp",
            14,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.treasures.g",
            "Slot 1 Treasure G: Crystal Ball",
            15,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.treasures.h",
            "Slot 1 Treasure H: Chalice",
            14,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.treasures.i",
            "Slot 1 Treasure I: Dagger",
            14,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.treasures.j",
            "Slot 1 Treasure J: Axe",
            15,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.treasures.k",
            "Slot 1 Treasure K: Football",
            15,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.treasures.l",
            "Slot 1 Treasure L: Idol",
            15,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_1.treasures.m",
            "Slot 1 Treasure M: Golden Glove",
            15,
            Storage::Bit,
        )
        .bit(0),
        catalog_field(
            "slot_1.treasures.n",
            "Slot 1 Treasure N: Whale",
            14,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.treasures.o",
            "Slot 1 Treasure O: Diamond Ring",
            14,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.completed.course_01",
            "Slot 1 Course 01 completed",
            11,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_02",
            "Slot 1 Course 02 completed",
            11,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_03",
            "Slot 1 Course 03 completed",
            11,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_03_alt",
            "Slot 1 Course 03' completed",
            11,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_04",
            "Slot 1 Course 04 completed",
            11,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_05",
            "Slot 1 Course 05 completed",
            11,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_06",
            "Slot 1 Course 06 completed",
            11,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_07",
            "Slot 1 Course 07 completed",
            12,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_08",
            "Slot 1 Course 08 completed",
            12,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_08_alt",
            "Slot 1 Course 08' completed",
            12,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_09",
            "Slot 1 Course 09 completed",
            12,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_10",
            "Slot 1 Course 10 completed",
            12,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_11",
            "Slot 1 Course 11 completed",
            12,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_12",
            "Slot 1 Course 12 completed",
            12,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_13",
            "Slot 1 Course 13 completed",
            12,
            Storage::Bit,
        )
        .bit(7)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_14",
            "Slot 1 Course 14 completed",
            19,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_15",
            "Slot 1 Course 15 completed",
            19,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_15_alt",
            "Slot 1 Course 15' completed",
            19,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_16",
            "Slot 1 Course 16 completed",
            19,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_16_alt",
            "Slot 1 Course 16' completed",
            19,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_17",
            "Slot 1 Course 17 completed",
            19,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_18",
            "Slot 1 Course 18 completed",
            19,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_19",
            "Slot 1 Course 19 completed",
            19,
            Storage::Bit,
        )
        .bit(7)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_20",
            "Slot 1 Course 20 completed",
            16,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_21",
            "Slot 1 Course 21 completed",
            16,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_22",
            "Slot 1 Course 22 completed",
            16,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_23",
            "Slot 1 Course 23 completed",
            16,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_23_alt",
            "Slot 1 Course 23' completed",
            16,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_24",
            "Slot 1 Course 24 completed",
            16,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_25",
            "Slot 1 Course 25 completed",
            16,
            Storage::Bit,
        )
        .bit(6)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_26",
            "Slot 1 Course 26 completed",
            17,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_27",
            "Slot 1 Course 27 completed",
            17,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_28",
            "Slot 1 Course 28 completed",
            17,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_29",
            "Slot 1 Course 29 completed",
            17,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_30",
            "Slot 1 Course 30 completed",
            17,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_31",
            "Slot 1 Course 31 completed",
            18,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_32",
            "Slot 1 Course 32 completed",
            18,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_33",
            "Slot 1 Course 33 completed",
            18,
            Storage::Bit,
        )
        .bit(2)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_34",
            "Slot 1 Course 34 completed",
            18,
            Storage::Bit,
        )
        .bit(3)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_35",
            "Slot 1 Course 35 completed",
            18,
            Storage::Bit,
        )
        .bit(4)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_36",
            "Slot 1 Course 36 completed",
            18,
            Storage::Bit,
        )
        .bit(5)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_37",
            "Slot 1 Course 37 completed",
            20,
            Storage::Bit,
        )
        .bit(0)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_38",
            "Slot 1 Course 38 completed",
            20,
            Storage::Bit,
        )
        .bit(1)
        .description(COMPLETION_DESCRIPTION.into())
        .editable(false),
        catalog_field(
            "slot_1.completed.course_39",
            "Slot 1 Course 39 completed",
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
