use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;
use tracing::{debug, trace};

const SLOT_SIZE: usize = 0x28;
const OPTIONS_CHECKSUM: usize = 0x78;
const LETTERS: [&str; 29] = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "period",
    "question_mark",
    "space",
];
const RACE_PROGRESSION: [(&str, i64); 4] = [
    ("none", 0),
    ("played", 1),
    ("challenge_1_completed", 2),
    ("challenge_2_completed", 3),
];
const CHALLENGE_PROGRESSION: [(&str, i64); 3] = [("none", 0), ("played", 1), ("completed", 2)];
const TROPHIES: [(&str, i64); 4] = [("none", 0), ("bronze", 1), ("silver", 2), ("gold", 3)];

// A two-bit progress value: byte offset within the slot and low bit.
type Progress = (&'static str, usize, u8);

struct World {
    slug: &'static str,
    name: &'static str,
    races: &'static [Progress],
    bosses: &'static [(usize, u8)],
    tt: Option<Progress>,
    key_bit: Option<u8>,
    trophy: (usize, u8),
    balloons: Scalar,
}

const fn balloons(offset: usize, storage: Storage, mask: u32) -> Scalar {
    Scalar {
        offset,
        storage,
        mask: Some(mask),
    }
}

// Races, bosses, trophies, and balloon counters per world, from the upstream resource table.
const WORLDS: [World; 5] = [
    World {
        slug: "dino_domain",
        name: "Dino Domain",
        races: &[
            ("ancient_lake", 0x2, 0),
            ("fossil_canyon", 0x2, 4),
            ("jungle_falls", 0x7, 6),
            ("hot_top_volcano", 0x3, 4),
        ],
        bosses: &[(0x8, 2), (0x9, 4)],
        tt: Some(("fire_mountain", 0x4, 4)),
        key_bit: Some(1),
        trophy: (0xc, 4),
        balloons: balloons(0xf, Storage::U8, 0x3c),
    },
    World {
        slug: "sherbet_island",
        name: "Sherbet Island",
        races: &[
            ("whale_bay", 0x3, 2),
            ("pirate_lagoon", 0x2, 2),
            ("crescent_island", 0x4, 6),
            ("treasure_caves", 0x7, 4),
        ],
        bosses: &[(0x8, 0), (0x9, 0)],
        tt: Some(("darkwater_beach", 0x6, 4)),
        key_bit: Some(2),
        trophy: (0xc, 6),
        balloons: balloons(0x10, Storage::U8, 0x78),
    },
    World {
        slug: "snowflake_mountain",
        name: "Snowflake Mountain",
        races: &[
            ("everfrost_peak", 0x4, 2),
            ("walrus_cove", 0x3, 6),
            ("snowball_valley", 0x3, 0),
            ("frosty_village", 0x6, 0),
        ],
        bosses: &[(0x2, 6), (0x9, 2)],
        tt: Some(("icicle_pyramid", 0x6, 2)),
        key_bit: Some(3),
        trophy: (0xb, 0),
        balloons: balloons(0x11, Storage::U8, 0xf0),
    },
    World {
        slug: "dragon_forest",
        name: "Dragon Forest",
        races: &[
            ("boulder_canyon", 0x5, 2),
            ("greenwood_village", 0x5, 4),
            ("windmill_plains", 0x5, 0),
            ("haunted_woods", 0x7, 2),
        ],
        bosses: &[(0x9, 6), (0xa, 6)],
        tt: Some(("smokey_castle", 0x6, 6)),
        key_bit: Some(4),
        trophy: (0xb, 2),
        balloons: balloons(0x11, Storage::U16Be, 0x1e0),
    },
    World {
        slug: "future_fun_land",
        name: "Future Fun Land",
        races: &[
            ("spacedust_alley", 0x5, 6),
            ("darkmoon_caverns", 0x7, 0),
            ("star_city", 0x8, 6),
            ("spaceport_alpha", 0x4, 0),
        ],
        bosses: &[(0xa, 4)],
        tt: None,
        key_bit: None,
        trophy: (0xb, 4),
        balloons: balloons(0x12, Storage::U16Be, 0x3c0),
    },
];
// The first boss level of each world raises one flag and the second another.
// Wizpig's lobby level and Future Fun Land only have a first level.
const LOBBY_BOSS: (usize, u8) = (0x8, 4);
const BOSS_FLAGS: [[(usize, u8); 2]; 5] = [
    [(0xd, 1), (0xd, 7)],
    [(0xd, 2), (0xc, 0)],
    [(0xd, 3), (0xc, 1)],
    [(0xd, 4), (0xc, 2)],
    [(0xd, 5), (0, 0)],
];
// Balloons collected outside races: the four event balloons and Taj's three challenge balloons.
const FREE_BALLOON_MASK: u32 = 0x4c5c;

// Track, vehicles, Time Trial beaten bit, and first record slot, from the upstream resource table.
const RECORDS: [(&str, &str, usize, usize, &[&str]); 20] = [
    (
        "ancient_lake",
        "Ancient Lake",
        0x14,
        0x4,
        &["car", "hover", "plane"],
    ),
    (
        "fossil_canyon",
        "Fossil Canyon",
        0x15,
        0x0,
        &["car", "hover", "plane"],
    ),
    (
        "jungle_falls",
        "Jungle Falls",
        0x16,
        0x22,
        &["car", "hover", "plane"],
    ),
    (
        "hot_top_volcano",
        "Hot Top Volcano",
        0x17,
        0x9,
        &["hover", "plane"],
    ),
    ("whale_bay", "Whale Bay", 0x8, 0xb, &["hover"]),
    ("pirate_lagoon", "Pirate Lagoon", 0x9, 0x3, &["hover"]),
    (
        "crescent_island",
        "Crescent Island",
        0xa,
        0xe,
        &["car", "hover"],
    ),
    (
        "treasure_caves",
        "Treasure Caves",
        0xb,
        0x25,
        &["car", "hover", "plane"],
    ),
    (
        "everfrost_peak",
        "Everfrost Peak",
        0xc,
        0x10,
        &["car", "hover", "plane"],
    ),
    ("walrus_cove", "Walrus Cove", 0xd, 0x7, &["car", "hover"]),
    (
        "snowball_valley",
        "Snowball Valley",
        0xe,
        0xc,
        &["car", "hover"],
    ),
    (
        "frosty_village",
        "Frosty Village",
        0xf,
        0x1f,
        &["car", "hover", "plane"],
    ),
    ("boulder_canyon", "Boulder Canyon", 0x0, 0x1b, &["hover"]),
    (
        "greenwood_village",
        "Greenwood Village",
        0x1,
        0x19,
        &["car", "hover"],
    ),
    (
        "windmill_plains",
        "Windmill Plains",
        0x2,
        0x1c,
        &["car", "hover", "plane"],
    ),
    (
        "haunted_woods",
        "Haunted Woods",
        0x3,
        0x28,
        &["car", "hover"],
    ),
    (
        "spacedust_alley",
        "Spacedust Alley",
        0x4,
        0x16,
        &["car", "hover", "plane"],
    ),
    (
        "darkmoon_caverns",
        "Darkmoon Caverns",
        0x5,
        0x2a,
        &["car", "hover"],
    ),
    (
        "star_city",
        "Star City",
        0x6,
        0x2c,
        &["car", "hover", "plane"],
    ),
    (
        "spaceport_alpha",
        "Spaceport Alpha",
        0x7,
        0x13,
        &["car", "hover", "plane"],
    ),
];

fn checksum(bytes: &[u8], start: usize, length: usize) -> u16 {
    bytes[start..start + length]
        .iter()
        .fold(5u16, |sum, byte| sum.wrapping_add(u16::from(*byte)))
}

// The options block sums both nibbles of every byte and keeps only the low byte.
fn options_checksum(bytes: &[u8]) -> u8 {
    let checksum = bytes[0x79..0x80].iter().fold(5u32, |sum, byte| {
        sum + u32::from(byte >> 4) + u32::from(byte & 0xf)
    }) as u8;
    trace!(checksum, "computed Diddy Kong Racing options checksum");
    checksum
}

fn check(start: usize, length: usize, offset: usize) -> Check {
    Check {
        when: Some(Condition::new(move |bytes| {
            Ok(bytes[offset..offset + 2] != [0xff, 0xff])
        })),
        assert: Condition::new(move |bytes| {
            Ok(u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
                == checksum(bytes, start, length))
        }),
        code: "diddy_kong_racing_checksum".into(),
        message: "a Diddy Kong Racing record checksum is invalid".into(),
        section_id: None,
        warning: None,
    }
}

fn options_initialised() -> Condition {
    Condition::new(|bytes| Ok(bytes[OPTIONS_CHECKSUM] != 0xff))
}

fn record_block_initialised(checksum: usize) -> Condition {
    Condition::new(move |bytes| Ok(bytes[checksum..checksum + 2] != [0xff, 0xff]))
}

fn gated(condition: &Condition) -> field::FieldBehavior {
    field::FieldBehavior {
        editable_when: Some(condition.clone()),
        ..Default::default()
    }
}

fn with_effects(condition: &Condition, on_edit: Vec<Store>) -> field::FieldBehavior {
    field::FieldBehavior {
        editable_when: Some(condition.clone()),
        on_edit,
        ..Default::default()
    }
}

fn store(destination: Scalar, value: impl Fn(&[u8]) -> i64 + Send + Sync + 'static) -> Store {
    Store {
        when: None,
        destination,
        value: ReadValue::new(move |bytes| Ok(value(bytes))),
    }
}

fn field_u8(offset: usize, mask: u32) -> Scalar {
    Scalar {
        offset,
        storage: Storage::U8,
        mask: Some(mask),
    }
}

fn two_bits(bytes: &[u8], base: usize, offset: usize, bit: u8) -> i64 {
    i64::from(bytes[base + offset] >> bit & 3)
}

// Counts of earned balloons per world: one for a first challenge, two for a second.
fn world_balloons(bytes: &[u8], base: usize, world: &World) -> i64 {
    world
        .races
        .iter()
        .map(|&(_, offset, bit)| {
            let progress = two_bits(bytes, base, offset, bit);
            i64::from(progress >= 2) + i64::from(progress == 3)
        })
        .sum()
}

// Progress fields keep the balloon counters, amulet pieces, and boss flags in step with the
// progression, exactly as the upstream editor recalculates them after every progression edit.
fn progression_effects(base: usize) -> Vec<Store> {
    let mut effects = Vec::new();
    effects.push(store(field_u8(base + 0x13, 0x38), move |bytes| {
        WORLDS
            .iter()
            .filter_map(|world| world.tt)
            .filter(|&(_, offset, bit)| two_bits(bytes, base, offset, bit) == 2)
            .count() as i64
    }));
    for (index, world) in WORLDS.iter().enumerate() {
        let mut destination = world.balloons.clone();
        destination.offset += base;
        effects.push(store(destination, move |bytes| {
            world_balloons(bytes, base, &WORLDS[index])
        }));
    }
    effects.push(store(field_u8(base + 0xe, 0xfe), move |bytes| {
        let events = u16::from_le_bytes([bytes[base + 0x14], bytes[base + 0x15]]);
        let events = i64::from((events as u32 & FREE_BALLOON_MASK).count_ones());
        events
            + WORLDS
                .iter()
                .map(|world| world_balloons(bytes, base, world))
                .sum::<i64>()
    }));
    let lobby = LOBBY_BOSS;
    effects.push(store(field_u8(base + 0xd, 1), move |bytes| {
        i64::from(two_bits(bytes, base, lobby.0, lobby.1) == 2)
    }));
    for (index, world) in WORLDS.iter().enumerate() {
        for (level, &(offset, bit)) in world.bosses.iter().enumerate() {
            let (flag_offset, flag_bit) = BOSS_FLAGS[index][level];
            effects.push(store(
                field_u8(base + flag_offset, 1 << flag_bit),
                move |bytes| i64::from(two_bits(bytes, base, offset, bit) == 2),
            ));
        }
    }
    effects.push(store(field_u8(base + 0x13, 0x07), move |bytes| {
        WORLDS
            .iter()
            .filter_map(|world| world.bosses.get(1))
            .filter(|&&(offset, bit)| two_bits(bytes, base, offset, bit) == 2)
            .count() as i64
    }));
    effects
}

fn letter_choices() -> Vec<FieldChoice> {
    choices(
        &LETTERS
            .iter()
            .enumerate()
            .map(|(value, name)| (*name, value as i64))
            .collect::<Vec<_>>(),
    )
}

// Three five-bit letters share one big-endian halfword, first letter in the high bits.
fn name_letters(
    fields: &mut Vec<FieldDefinition>,
    id: &str,
    label: &str,
    offset: usize,
    behavior: &field::FieldBehavior,
) {
    for (index, mask) in [0x7c00, 0x03e0, 0x001f].into_iter().enumerate() {
        fields.push(
            catalog_field(
                &format!("{id}_{}", index + 1),
                &format!("{label} letter {}", index + 1),
                offset,
                Storage::U16Be,
            )
            .mask(mask)
            .choices(letter_choices())
            .min(0)
            .max(LETTERS.len() as i64 - 1)
            .behavior(behavior.clone()),
        );
    }
}

fn progress_field(
    id: String,
    label: String,
    base: usize,
    (offset, bit): (usize, u8),
    values: &[(&str, i64)],
    behavior: &field::FieldBehavior,
) -> FieldDefinition {
    catalog_field(&id, &label, base + offset, Storage::U8)
        .mask(3 << bit)
        .choices(choices(values))
        .min(0)
        .max(values.len() as i64 - 1)
        .behavior(behavior.clone())
}

fn flag(
    id: String,
    label: String,
    offset: usize,
    bit: u8,
    behavior: &field::FieldBehavior,
) -> FieldDefinition {
    catalog_field(&id, &label, offset, Storage::Bit)
        .bit(bit)
        .behavior(behavior.clone())
}

fn slot_fields(slot: usize) -> Vec<FieldDefinition> {
    let base = slot * SLOT_SIZE;
    let occupied = Condition::new(move |bytes| Ok(bytes[base..base + 2] != [0xff, 0xff]));
    let plain = gated(&occupied);
    let progress = with_effects(&occupied, progression_effects(base));
    let prefix = format!("slot_{}", slot + 1);
    let label = format!("Slot {}", slot + 1);
    let mut fields = vec![
        FieldDefinition::new(
            format!("{prefix}.mode"),
            format!("{label} Adventure Two"),
            base + 0x24,
            Storage::Bit,
        )
        .bit(2)
        .behavior(plain.clone()),
        FieldDefinition::new(
            format!("{prefix}.wizpig_amulet"),
            format!("{label} Wizpig amulet pieces"),
            base + 0x13,
            Storage::U8,
        )
        .mask(0x07)
        .max(4)
        .behavior(plain.clone()),
        FieldDefinition::new(
            format!("{prefix}.balloons"),
            format!("{label} balloons"),
            base + 0xe,
            Storage::U8,
        )
        .mask(0xfe)
        .max(47)
        .behavior(plain.clone()),
    ];
    name_letters(
        &mut fields,
        &format!("{prefix}.name"),
        &format!("{label} name"),
        base + 0x25,
        &plain,
    );
    fields.push(progress_field(
        format!("{prefix}.lobby.wizpig_level"),
        format!("{label} Wizpig level"),
        base,
        LOBBY_BOSS,
        &CHALLENGE_PROGRESSION,
        &progress,
    ));
    for world in &WORLDS {
        let world_id = format!("{prefix}.worlds.{}", world.slug);
        let world_label = format!("{label} {}", world.name);
        for &(slug, offset, bit) in world.races {
            fields.push(progress_field(
                format!("{world_id}.{slug}"),
                format!("{world_label} {slug} race"),
                base,
                (offset, bit),
                &RACE_PROGRESSION,
                &progress,
            ));
        }
        for (level, &(offset, bit)) in world.bosses.iter().enumerate() {
            fields.push(progress_field(
                format!("{world_id}.boss_{}", level + 1),
                format!("{world_label} boss level {}", level + 1),
                base,
                (offset, bit),
                &CHALLENGE_PROGRESSION,
                &progress,
            ));
        }
        if let Some((slug, offset, bit)) = world.tt {
            fields.push(progress_field(
                format!("{world_id}.{slug}"),
                format!("{world_label} T.T. challenge {slug}"),
                base,
                (offset, bit),
                &CHALLENGE_PROGRESSION,
                &progress,
            ));
        }
        if let Some(bit) = world.key_bit {
            fields.push(flag(
                format!("{world_id}.key"),
                format!("{world_label} key obtained"),
                base + 0x20,
                bit,
                &plain,
            ));
        }
        fields.push(progress_field(
            format!("{world_id}.trophy"),
            format!("{world_label} trophy race cup"),
            base,
            world.trophy,
            &TROPHIES,
            &plain,
        ));
    }
    for (id, label_text, offset, bit, derived) in [
        (
            "events.future_fun_land_unlocked",
            "Future Fun Land unlocked",
            0x24,
            0,
            true,
        ),
        (
            "events.balloon_near_dino_domain",
            "Balloon near Dino Domain obtained",
            0x14,
            2,
            true,
        ),
        (
            "events.balloon_near_wizpig_head",
            "Balloon near Wizpig head obtained",
            0x14,
            6,
            true,
        ),
        (
            "events.balloon_above_water_sherbet_island",
            "Balloon above water near Sherbet Island obtained",
            0x15,
            2,
            true,
        ),
        (
            "events.balloon_among_trees_sherbet_island",
            "Balloon among trees near Sherbet Island obtained",
            0x15,
            6,
            true,
        ),
        (
            "taj.car_unlocked",
            "Taj Car Challenge unlocked",
            0xb,
            6,
            false,
        ),
        (
            "taj.hover_unlocked",
            "Taj Hover Challenge unlocked",
            0xb,
            7,
            false,
        ),
        (
            "taj.plane_unlocked",
            "Taj Plane Challenge unlocked",
            0xa,
            0,
            false,
        ),
        (
            "taj.car_completed",
            "Taj Car Challenge completed",
            0xa,
            1,
            false,
        ),
        (
            "taj.hover_completed",
            "Taj Hover Challenge completed",
            0xa,
            2,
            false,
        ),
        (
            "taj.plane_completed",
            "Taj Plane Challenge completed",
            0xa,
            3,
            false,
        ),
        (
            "taj.car_balloon",
            "Taj Car Challenge balloon",
            0x15,
            3,
            true,
        ),
        (
            "taj.hover_balloon",
            "Taj Hover Challenge balloon",
            0x14,
            3,
            true,
        ),
        (
            "taj.plane_balloon",
            "Taj Plane Challenge balloon",
            0x14,
            4,
            true,
        ),
    ] {
        fields.push(flag(
            format!("{prefix}.{id}"),
            format!("{label} {label_text}"),
            base + offset,
            bit,
            if derived { &progress } else { &plain },
        ));
    }
    fields
}

// Beating a track's T.T. record sets one bit per track in the options block.
fn option_fields() -> Vec<FieldDefinition> {
    let unlocked = options_initialised();
    let plain = gated(&unlocked);
    // Unlocking T.T. marks every T.T. record as beaten, as the upstream editor does.
    let unlock_tt = with_effects(
        &unlocked,
        vec![
            store(
                Scalar {
                    offset: 0x7d,
                    storage: Storage::U16Be,
                    mask: None,
                },
                |bytes| if bytes[0x7d] & 1 == 1 { 0xffff } else { 0 },
            ),
            store(field_u8(0x7f, 0xf0), |bytes| {
                if bytes[0x7d] & 1 == 1 { 0xf } else { 0 }
            }),
        ],
    );
    let mut fields = vec![
        flag(
            "general.unlocked_adventure_two".into(),
            "Adventure Two unlocked".into(),
            0x7f,
            0,
            &plain,
        ),
        flag(
            "general.unlocked_drumstick".into(),
            "Drumstick unlocked".into(),
            0x7f,
            1,
            &plain,
        ),
        flag(
            "general.unlocked_tt".into(),
            "T.T. unlocked".into(),
            0x7d,
            0,
            &unlock_tt,
        ),
        flag(
            "options.subtitles".into(),
            "Subtitles".into(),
            0x7c,
            1,
            &plain,
        ),
        catalog_field("options.language", "Language", 0x7f, Storage::U8)
            .mask(0x0c)
            .choices(choices(&[("english", 0), ("german", 1), ("french", 2)]))
            .min(0)
            .max(2)
            .description("German is not available in the USA release".into())
            .behavior(plain.clone()),
    ];
    for &(slug, name, tt_bit, _, _) in &RECORDS {
        // Bit 0 is the T.T. unlock flag above, which cannot share storage with a second field.
        if tt_bit == 0 {
            continue;
        }
        fields.push(flag(
            format!("records.{slug}.tt_beaten"),
            format!("{name} T.T. record beaten"),
            0x7d + tt_bit / 8,
            (tt_bit % 8) as u8,
            &plain,
        ));
    }
    fields
}

// Times are frame counts: 1/50 s on PAL and 1/60 s on NTSC.
fn record_fields() -> Vec<FieldDefinition> {
    let laps = record_block_initialised(0x80);
    let times = record_block_initialised(0x140);
    let mut fields = Vec::new();
    for &(slug, name, _, first, vehicles) in &RECORDS {
        for (vehicle_index, vehicle) in vehicles.iter().enumerate() {
            let entry = (first + vehicle_index) * 4;
            let id = format!("records.{slug}.{vehicle}");
            let label = format!("{name} ({vehicle})");
            for (kind, kind_label, time_offset, gate) in [
                ("best_time", "best time", 0x142 + entry, &times),
                ("best_lap", "best lap", 0x82 + entry, &laps),
            ] {
                fields.push(
                    catalog_field(
                        &format!("{id}.{kind}_frames"),
                        &format!("{label} {kind_label} (frames)"),
                        time_offset,
                        Storage::U16Be,
                    )
                    .behavior(gated(gate)),
                );
                name_letters(
                    &mut fields,
                    &format!("{id}.{kind}_name"),
                    &format!("{label} {kind_label} name"),
                    time_offset + 2,
                    &gated(gate),
                );
            }
        }
    }
    fields
}

// Layout and checksum rules: https://github.com/DavidSM64/Diddy-Kong-Racing/blob/1339ad6304118207b342fe8669c500efb91969df/src/save_data.c
// Editor offsets: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/diddy-kong-racing/saveEditor
// Progression, options, and records, unchanged at: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/diddy-kong-racing/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for slot in 0..3 {
        fields.extend(slot_fields(slot));
    }
    fields.extend(option_fields());
    fields.extend(record_fields());
    debug!(fields = fields.len(), "built Diddy Kong Racing save fields");
    let ranges = [
        (2, 0x26, 0),
        (0x2a, 0x26, 0x28),
        (0x52, 0x26, 0x50),
        (0x82, 0xbe, 0x80),
        (0x142, 0xbe, 0x140),
    ];
    let mut checks: Vec<_> = ranges
        .iter()
        .map(|&(start, length, offset)| check(start, length, offset))
        .collect();
    checks.push(Check {
        when: Some(options_initialised()),
        assert: Condition::new(|bytes| Ok(bytes[OPTIONS_CHECKSUM] == options_checksum(bytes))),
        code: "diddy_kong_racing_options_checksum".into(),
        message: "the Diddy Kong Racing options checksum is invalid".into(),
        section_id: None,
        warning: None,
    });
    // Every block is rewritten after an edit, but an unused (0xffff) block stays untouched.
    let mut stores: Vec<_> = ranges
        .iter()
        .map(|&(start, length, offset)| Store {
            when: Some(Condition::new(move |bytes| {
                Ok(bytes[offset..offset + 2] != [0xff, 0xff])
            })),
            destination: Scalar {
                offset,
                storage: Storage::U16Be,
                mask: None,
            },
            value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, start, length)))),
        })
        .collect();
    stores.push(Store {
        when: Some(options_initialised()),
        destination: Scalar {
            offset: OPTIONS_CHECKSUM,
            storage: Storage::U8,
            mask: None,
        },
        value: ReadValue::new(|bytes| Ok(i64::from(options_checksum(bytes)))),
    });
    let game = GameDefinition {
        fields,
        description:
            "Edits Adventure slots, progression, options, and records in normalized 16 Kbit EEPROM. Requires a game-made template."
                .into(),
        runtime: runtime::Runtime {
            require_selection: true,
            recognition: Some(runtime::Recognition {
                checks: checks.clone(),
                reasons: vec![SaveRecognitionReason::ChecksumValid],
                confidence: SaveRecognitionConfidence::High,
                incomplete_confidence: None,
                selected_reason: true,
                empty_top_level_reasons: false,
            }),
            checks,
            after_edit: stores,
            save_format: Some("n64_eeprom_16k".into()),
            save_format_name: Some("Nintendo 64 EEPROM 16 Kbit".into()),
            ..Default::default()
        },
        ..GameDefinition::new(
            "diddy-kong-racing".into(),
            "Diddy Kong Racing".into(),
            "nintendo-64".into(),
            2048,
        )
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent copies of the upstream world tables: races, bosses, T.T. challenge,
    // balloon counter (offset, width in bytes, bit start), then the boss flags it raises.
    struct UpstreamWorld {
        races: &'static [(usize, u32)],
        bosses: &'static [(usize, u32)],
        tt: Option<(usize, u32)>,
        balloons: (usize, usize, u32),
        flags: &'static [(usize, u32)],
    }
    const UPSTREAM: [UpstreamWorld; 6] = [
        UpstreamWorld {
            races: &[],
            bosses: &[(0x8, 4)],
            tt: None,
            balloons: (0, 0, 0),
            flags: &[(0xd, 0)],
        },
        UpstreamWorld {
            races: &[(0x2, 0), (0x2, 4), (0x7, 6), (0x3, 4)],
            bosses: &[(0x8, 2), (0x9, 4)],
            tt: Some((0x4, 4)),
            balloons: (0xf, 1, 2),
            flags: &[(0xd, 1), (0xd, 7)],
        },
        UpstreamWorld {
            races: &[(0x3, 2), (0x2, 2), (0x4, 6), (0x7, 4)],
            bosses: &[(0x8, 0), (0x9, 0)],
            tt: Some((0x6, 4)),
            balloons: (0x10, 1, 3),
            flags: &[(0xd, 2), (0xc, 0)],
        },
        UpstreamWorld {
            races: &[(0x4, 2), (0x3, 6), (0x3, 0), (0x6, 0)],
            bosses: &[(0x2, 6), (0x9, 2)],
            tt: Some((0x6, 2)),
            balloons: (0x11, 1, 4),
            flags: &[(0xd, 3), (0xc, 1)],
        },
        UpstreamWorld {
            races: &[(0x5, 2), (0x5, 4), (0x5, 0), (0x7, 2)],
            bosses: &[(0x9, 6), (0xa, 6)],
            tt: Some((0x6, 6)),
            balloons: (0x11, 2, 5),
            flags: &[(0xd, 4), (0xc, 2)],
        },
        UpstreamWorld {
            races: &[(0x5, 6), (0x7, 0), (0x8, 6), (0x4, 0)],
            bosses: &[(0xa, 4)],
            tt: None,
            balloons: (0x12, 2, 6),
            flags: &[(0xd, 5)],
        },
    ];

    fn get_bits(bytes: &[u8], offset: usize, width: usize, start: u32, length: u32) -> u32 {
        let value = if width == 2 {
            u32::from(bytes[offset]) << 8 | u32::from(bytes[offset + 1])
        } else {
            u32::from(bytes[offset])
        };
        value >> start & ((1 << length) - 1)
    }
    fn set_bits(
        bytes: &mut [u8],
        offset: usize,
        width: usize,
        start: u32,
        length: u32,
        input: u32,
    ) {
        let mask = ((1u32 << length) - 1) << start;
        let current = get_bits(bytes, offset, width, 0, 16);
        let value = (current & !mask) | ((input << start) & mask);
        if width == 2 {
            bytes[offset..offset + 2].copy_from_slice(&(value as u16).to_be_bytes());
        } else {
            bytes[offset] = value as u8;
        }
    }
    // Port of updateTTChallenges, updateWorldBalloons, and updateWorldBosses.
    fn upstream_update(bytes: &mut [u8], base: usize) {
        let mut amulet = 0;
        for world in &UPSTREAM {
            if let Some((offset, bit)) = world.tt
                && get_bits(bytes, base + offset, 1, bit, 2) == 2
            {
                amulet += 1;
            }
        }
        set_bits(bytes, base + 0x13, 1, 3, 3, amulet);
        let free = u32::from(u16::from_le_bytes([bytes[base + 0x14], bytes[base + 0x15]]));
        let mut balloons = (free & 0x4c5c).count_ones();
        for world in &UPSTREAM {
            if world.races.is_empty() {
                continue;
            }
            let mut earned = 0;
            for &(offset, bit) in world.races {
                let progress = get_bits(bytes, base + offset, 1, bit, 2);
                earned += u32::from(progress >= 2) + u32::from(progress == 3);
            }
            let (offset, width, bit) = world.balloons;
            set_bits(bytes, base + offset, width, bit, 4, earned);
            balloons += earned;
        }
        set_bits(bytes, base + 0xe, 1, 1, 7, balloons);
        let mut pieces = 0;
        for world in &UPSTREAM {
            let level1 = get_bits(bytes, base + world.bosses[0].0, 1, world.bosses[0].1, 2);
            let level2 = world.bosses.get(1).map_or(0, |&(offset, bit)| {
                get_bits(bytes, base + offset, 1, bit, 2)
            });
            if level2 == 2 {
                pieces += 1;
            }
            for (index, &(offset, bit)) in world.flags.iter().enumerate() {
                let reached = if index == 0 { level1 } else { level2 };
                set_bits(bytes, base + offset, 1, bit, 1, u32::from(reached == 2));
            }
        }
        set_bits(bytes, base + 0x13, 1, 0, 3, pieces);
    }
    fn upstream_checksum(bytes: &[u8], start: usize, length: usize) -> u16 {
        let mut checksum = 5u32;
        for byte in &bytes[start..start + length] {
            checksum += u32::from(*byte);
        }
        (checksum & 0xffff) as u16
    }
    fn upstream_options(bytes: &[u8]) -> u8 {
        let mut checksum = 5u32;
        for byte in &bytes[0x79..0x80] {
            checksum += u32::from(byte >> 4) + u32::from(byte & 0xf);
        }
        (checksum & 0xff) as u8
    }
    fn repair(bytes: &mut [u8]) {
        for (start, length, offset) in [
            (2, 0x26, 0),
            (0x2a, 0x26, 0x28),
            (0x52, 0x26, 0x50),
            (0x82, 0xbe, 0x80),
            (0x142, 0xbe, 0x140),
        ] {
            if bytes[offset..offset + 2] == [0xff, 0xff] {
                continue;
            }
            let sum = upstream_checksum(bytes, start, length);
            bytes[offset..offset + 2].copy_from_slice(&sum.to_be_bytes());
        }
        if bytes[0x78] != 0xff {
            bytes[0x78] = upstream_options(bytes);
        }
    }
    fn assert_checksums(bytes: &[u8]) {
        for (start, length, offset) in [
            (2, 0x26, 0),
            (0x2a, 0x26, 0x28),
            (0x52, 0x26, 0x50),
            (0x82, 0xbe, 0x80),
            (0x142, 0xbe, 0x140),
        ] {
            if bytes[offset..offset + 2] != [0xff, 0xff] {
                assert_eq!(
                    u16::from_be_bytes([bytes[offset], bytes[offset + 1]]),
                    upstream_checksum(bytes, start, length),
                    "checksum at {offset:#x}"
                );
            }
        }
        assert_eq!(bytes[0x78], upstream_options(bytes));
    }
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x24; 2048];
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("diddy-kong-racing".into()),
            rom_sha1: None,
        }
    }
    fn blank() -> SaveDetectionInput {
        let mut bytes = vec![0; 2048];
        bytes[0x50..0x78].fill(0xff);
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("diddy-kong-racing".into()),
            rom_sha1: None,
        }
    }
    fn edit(id: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: id.into(),
            value,
        }
    }
    fn apply(source: &SaveDetectionInput, edits: &[SaveEdit]) -> crate::Result<Vec<u8>> {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        handler
            .apply(source, &identity, edits, false)
            .map(|result| result.bytes.unwrap())
    }
    fn parsed(source: &SaveDetectionInput, id: &str) -> SaveValue {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        handler
            .parse(source, &identity)
            .unwrap()
            .fields
            .into_iter()
            .find(|field| field.id == id)
            .unwrap_or_else(|| panic!("missing {id}"))
            .value
    }

    #[test]
    fn edit_repairs_slot_checksum_and_preserves_records() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "slot_1.wizpig_amulet".into(),
                    value: SaveValue::U32(3),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[0x13] & 7, 3);
        assert_ne!(&bytes[..2], &original.bytes[..2]);
        assert_eq!(&bytes[0x80..], &original.bytes[0x80..]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[4] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    #[test]
    fn empty_slots_skip_checksum_validation_and_stay_unchanged() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut original = input();
        original.bytes[0x28..0x50].fill(0xff);
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "slot_1.wizpig_amulet".into(),
                    value: SaveValue::U32(3),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&bytes[0x28..0x50], &original.bytes[0x28..0x50]);
    }

    #[test]
    fn schema_exposes_slots_options_and_every_record() {
        let handler = schemas().remove(0);
        let entries: usize = RECORDS.iter().map(|record| record.4.len()).sum();
        assert_eq!(entries, 47);
        let per_slot = 3 + 3 + 1 + (4 + 2 + 1 + 1 + 1) * 4 + (4 + 1 + 1) + 14;
        // Twenty tracks have a T.T. bit; the first shares storage with the unlock flag.
        let tt_bits = RECORDS.iter().filter(|record| record.2 != 0).count();
        assert_eq!(tt_bits, 19);
        assert_eq!(
            handler.game.fields.len(),
            3 * per_slot + 5 + tt_bits + entries * 2 * 4
        );
    }

    #[test]
    fn progression_edits_recalculate_balloons_amulets_and_boss_flags() {
        let source = blank();
        let edits = [
            edit(
                "slot_1.worlds.dino_domain.ancient_lake",
                SaveValue::Enum("challenge_2_completed".into()),
            ),
            edit(
                "slot_1.worlds.dino_domain.fossil_canyon",
                SaveValue::Enum("challenge_1_completed".into()),
            ),
            edit(
                "slot_1.worlds.dino_domain.jungle_falls",
                SaveValue::Enum("played".into()),
            ),
            edit(
                "slot_1.worlds.dino_domain.boss_1",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.worlds.dino_domain.boss_2",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.worlds.dino_domain.fire_mountain",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.worlds.sherbet_island.whale_bay",
                SaveValue::Enum("challenge_2_completed".into()),
            ),
            edit(
                "slot_1.worlds.sherbet_island.boss_2",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.worlds.snowflake_mountain.icicle_pyramid",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.worlds.dragon_forest.windmill_plains",
                SaveValue::Enum("challenge_2_completed".into()),
            ),
            edit(
                "slot_1.worlds.dragon_forest.boss_2",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.worlds.future_fun_land.star_city",
                SaveValue::Enum("challenge_2_completed".into()),
            ),
            edit(
                "slot_1.worlds.future_fun_land.boss_1",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.lobby.wizpig_level",
                SaveValue::Enum("completed".into()),
            ),
            edit(
                "slot_1.events.balloon_near_dino_domain",
                SaveValue::Bool(true),
            ),
            edit("slot_1.taj.plane_balloon", SaveValue::Bool(true)),
            edit("slot_1.worlds.dino_domain.key", SaveValue::Bool(true)),
            edit(
                "slot_1.worlds.snowflake_mountain.trophy",
                SaveValue::Enum("gold".into()),
            ),
        ];
        let bytes = apply(&source, &edits).unwrap();
        let mut expected = source.bytes.clone();
        set_bits(&mut expected, 0x2, 1, 0, 2, 3);
        set_bits(&mut expected, 0x2, 1, 4, 2, 2);
        set_bits(&mut expected, 0x7, 1, 6, 2, 1);
        set_bits(&mut expected, 0x8, 1, 2, 2, 2);
        set_bits(&mut expected, 0x9, 1, 4, 2, 2);
        set_bits(&mut expected, 0x4, 1, 4, 2, 2);
        set_bits(&mut expected, 0x3, 1, 2, 2, 3);
        set_bits(&mut expected, 0x9, 1, 0, 2, 2);
        set_bits(&mut expected, 0x6, 1, 2, 2, 2);
        set_bits(&mut expected, 0x5, 1, 0, 2, 3);
        set_bits(&mut expected, 0xa, 1, 6, 2, 2);
        set_bits(&mut expected, 0x8, 1, 6, 2, 3);
        set_bits(&mut expected, 0xa, 1, 4, 2, 2);
        set_bits(&mut expected, 0x8, 1, 4, 2, 2);
        expected[0x14] |= 1 << 2;
        expected[0x14] |= 1 << 4;
        expected[0x20] |= 1 << 1;
        set_bits(&mut expected, 0xb, 1, 0, 2, 3);
        upstream_update(&mut expected, 0);
        repair(&mut expected);
        assert_eq!(bytes, expected);
        // Spot checks of the derived values: 2 + 1 earned in Dino Domain, plus the rest.
        assert_eq!(
            parsed(
                &SaveDetectionInput {
                    bytes: bytes.clone(),
                    ..source.clone()
                },
                "slot_1.wizpig_amulet"
            ),
            SaveValue::U32(3)
        );
        assert_eq!(
            parsed(&SaveDetectionInput { bytes, ..source }, "slot_1.balloons"),
            SaveValue::U32(2 + 1 + 2 + 2 + 2 + 2)
        );
    }

    #[test]
    fn progression_edits_recalculate_every_slot_independently() {
        let source = blank();
        let bytes = apply(
            &source,
            &[
                edit(
                    "slot_2.worlds.dino_domain.ancient_lake",
                    SaveValue::Enum("challenge_2_completed".into()),
                ),
                edit(
                    "slot_3.worlds.future_fun_land.spacedust_alley",
                    SaveValue::Enum("challenge_1_completed".into()),
                ),
            ],
        );
        // Slot 3 is empty in the blank template, so only slot 2 may change.
        assert!(bytes.is_err());
        let mut three = blank();
        three.bytes[0x50..0x78].fill(0);
        repair(&mut three.bytes);
        let bytes = apply(
            &three,
            &[
                edit(
                    "slot_2.worlds.dino_domain.ancient_lake",
                    SaveValue::Enum("challenge_2_completed".into()),
                ),
                edit(
                    "slot_3.worlds.future_fun_land.spacedust_alley",
                    SaveValue::Enum("challenge_1_completed".into()),
                ),
            ],
        )
        .unwrap();
        let mut expected = three.bytes.clone();
        set_bits(&mut expected, 0x28 + 0x2, 1, 0, 2, 3);
        set_bits(&mut expected, 0x50 + 0x5, 1, 6, 2, 2);
        upstream_update(&mut expected, 0x28);
        upstream_update(&mut expected, 0x50);
        repair(&mut expected);
        assert_eq!(bytes, expected);
        assert_eq!(&bytes[..0x28], &three.bytes[..0x28]);
    }

    #[test]
    fn names_trophies_keys_and_taj_flags_edit_without_recalculation() {
        let source = blank();
        let edits = [
            edit("slot_2.name_1", SaveValue::Enum("z".into())),
            edit("slot_2.name_2", SaveValue::Enum("question_mark".into())),
            edit("slot_2.name_3", SaveValue::Enum("space".into())),
            edit(
                "slot_1.worlds.sherbet_island.trophy",
                SaveValue::Enum("silver".into()),
            ),
            edit("slot_1.worlds.dragon_forest.key", SaveValue::Bool(true)),
            edit("slot_1.taj.car_unlocked", SaveValue::Bool(true)),
            edit("slot_1.taj.plane_completed", SaveValue::Bool(true)),
            edit(
                "slot_1.events.future_fun_land_unlocked",
                SaveValue::Bool(true),
            ),
        ];
        let handler = schemas().remove(0);
        assert!(
            handler
                .game
                .fields
                .iter()
                .any(|field| field.id == "slot_2.name_1"),
            "name fields exist"
        );
        let bytes = apply(&source, &edits[3..7]).unwrap();
        let mut expected = source.bytes.clone();
        set_bits(&mut expected, 0xc, 1, 6, 2, 2);
        expected[0x20] |= 1 << 4;
        expected[0xb] |= 1 << 6;
        expected[0xa] |= 1 << 3;
        repair(&mut expected);
        assert_eq!(bytes, expected);
        // Slot 2 is occupied in a template whose slot starts with a valid checksum word.
        let mut occupied = blank();
        occupied.bytes[0x28..0x50].fill(0);
        repair(&mut occupied.bytes);
        let named = apply(&occupied, &edits[..3]).unwrap();
        let mut expected = occupied.bytes.clone();
        let value = 25u16 << 10 | 27 << 5 | 28;
        expected[0x28 + 0x25..0x28 + 0x27].copy_from_slice(&value.to_be_bytes());
        repair(&mut expected);
        assert_eq!(named, expected);
        let saved = SaveDetectionInput {
            bytes: named,
            ..occupied
        };
        assert_eq!(
            parsed(&saved, "slot_2.name_2"),
            SaveValue::Enum("question_mark".into())
        );
        // The events edit recalculates, which a slot-1 template without Future Fun Land flags shows.
        let future = apply(&source, &edits[7..]).unwrap();
        let mut expected = source.bytes.clone();
        expected[0x24] |= 1;
        upstream_update(&mut expected, 0);
        repair(&mut expected);
        assert_eq!(future, expected);
    }

    #[test]
    fn options_edits_repair_the_nibble_checksum_and_unlock_tt_records() {
        let source = input();
        let tt_on = apply(
            &source,
            &[edit("general.unlocked_tt", SaveValue::Bool(true))],
        )
        .unwrap();
        let mut expected = source.bytes.clone();
        expected[0x7d] = 0xff;
        expected[0x7e] = 0xff;
        expected[0x7f] = (expected[0x7f] & 0x0f) | 0xf0;
        expected[0x78] = upstream_options(&expected);
        assert_eq!(tt_on, expected);
        let tt_source = SaveDetectionInput {
            bytes: tt_on,
            ..source.clone()
        };
        assert_eq!(
            parsed(&tt_source, "records.star_city.tt_beaten"),
            SaveValue::Bool(true)
        );
        let tt_off = apply(
            &tt_source,
            &[edit("general.unlocked_tt", SaveValue::Bool(false))],
        )
        .unwrap();
        assert_eq!(&tt_off[0x7d..0x7f], &[0, 0]);
        assert_eq!(tt_off[0x7f] >> 4, 0);
        assert_checksums(&tt_off);
        let edits = [
            edit("general.unlocked_adventure_two", SaveValue::Bool(true)),
            edit("general.unlocked_drumstick", SaveValue::Bool(true)),
            edit("options.subtitles", SaveValue::Bool(true)),
            edit("options.language", SaveValue::Enum("french".into())),
            edit("records.ancient_lake.tt_beaten", SaveValue::Bool(false)),
        ];
        let bytes = apply(&source, &edits).unwrap();
        let mut expected = source.bytes.clone();
        expected[0x7f] = (expected[0x7f] | 0b11) & !0x0c | 0x08;
        expected[0x7c] |= 1 << 1;
        // Ancient Lake is T.T. bit 0x14, byte 0x7f bit 4.
        expected[0x7f] &= !(1 << 4);
        expected[0x78] = upstream_options(&expected);
        assert_eq!(bytes, expected);
        assert_eq!(&bytes[..0x78], &source.bytes[..0x78]);
        assert_eq!(&bytes[0x80..], &source.bytes[0x80..]);
    }

    #[test]
    fn record_edits_repair_both_record_checksums() {
        let source = input();
        let edits = [
            edit(
                "records.fossil_canyon.car.best_time_frames",
                SaveValue::U32(0xffff),
            ),
            edit(
                "records.fossil_canyon.car.best_time_name_1",
                SaveValue::Enum("d".into()),
            ),
            edit(
                "records.fossil_canyon.car.best_time_name_2",
                SaveValue::Enum("k".into()),
            ),
            edit(
                "records.fossil_canyon.car.best_time_name_3",
                SaveValue::Enum("r".into()),
            ),
            edit(
                "records.spaceport_alpha.plane.best_lap_frames",
                SaveValue::U32(0),
            ),
            edit(
                "records.whale_bay.hover.best_lap_name_3",
                SaveValue::Enum("period".into()),
            ),
        ];
        let bytes = apply(&source, &edits).unwrap();
        let mut expected = source.bytes.clone();
        expected[0x142..0x144].copy_from_slice(&0xffffu16.to_be_bytes());
        let name = 3u16 << 10 | 10 << 5 | 17;
        expected[0x144..0x146].copy_from_slice(&name.to_be_bytes());
        // Spaceport Alpha starts at record slot 0x13, so its plane entry is 0x15.
        let lap = 0x82 + 0x15 * 4;
        expected[lap..lap + 2].copy_from_slice(&0u16.to_be_bytes());
        // Whale Bay hover is slot 0xb: keep the other two letters of the template.
        let whale = 0x84 + 0xb * 4;
        let current = u16::from_be_bytes([expected[whale], expected[whale + 1]]);
        expected[whale..whale + 2].copy_from_slice(&((current & !0x1f) | 26).to_be_bytes());
        repair(&mut expected);
        assert_eq!(bytes, expected);
        assert_eq!(&bytes[..0x80], &source.bytes[..0x80]);
        assert_checksums(&bytes);
    }

    #[test]
    fn gating_and_corruption_reject_edits() {
        let blank = blank();
        // Slot 3 is unused.
        assert!(
            apply(
                &blank,
                &[edit("slot_3.name_1", SaveValue::Enum("a".into()))]
            )
            .is_err()
        );
        // Uninitialised option and record blocks are read-only.
        let mut fresh = input();
        fresh.bytes[0x78] = 0xff;
        fresh.bytes[0x80..0x82].fill(0xff);
        fresh.bytes[0x140..0x142].fill(0xff);
        for id in [
            "options.subtitles",
            "records.ancient_lake.car.best_lap_frames",
            "records.ancient_lake.car.best_time_frames",
        ] {
            assert!(
                apply(&fresh, &[edit(id, SaveValue::U32(1))]).is_err(),
                "{id}"
            );
        }
        // Out-of-range values and unknown choices.
        let source = input();
        assert!(
            apply(
                &source,
                &[edit(
                    "slot_1.worlds.dino_domain.boss_1",
                    SaveValue::Enum("raw:3".into())
                )]
            )
            .is_err()
        );
        assert!(
            apply(
                &source,
                &[edit("slot_1.name_1", SaveValue::Enum("raw:29".into()))]
            )
            .is_err()
        );
        // Each checksum guards its own block.
        for (offset, id) in [
            (0x79usize, "options.subtitles"),
            (0x90, "records.ancient_lake.car.best_lap_frames"),
            (0x150, "records.ancient_lake.car.best_time_frames"),
        ] {
            let mut corrupt = input();
            corrupt.bytes[offset] ^= 0x11;
            assert!(
                apply(&corrupt, &[edit(id, SaveValue::U32(1))]).is_err(),
                "{id}"
            );
        }
    }

    #[test]
    fn options_checksum_adds_both_nibbles_of_every_byte() {
        let mut bytes = vec![0xff; 2048];
        bytes[0x78] = 0;
        // Seven bytes of 0xff add 7 * 30 + 5 = 215, the largest possible sum, so it never wraps.
        assert_eq!(options_checksum(&bytes), 215);
        bytes[0x79..0x80].fill(0xee);
        assert_eq!(options_checksum(&bytes), (5 + 7 * 28) as u8);
        bytes[0x79..0x80].fill(0xf0);
        bytes[0x7a] = 0xff;
        assert_eq!(options_checksum(&bytes), 5 + 6 * 15 + 30);
    }
}
