use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::{Check, Condition, ReadValue, Scalar, Store};
use tracing::{debug, trace};

// Fields, the tape counter, and the checksum MUST follow this pinned game layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/tony-hawk-s-skateboarding/saveEditor
const CHECKSUM: usize = 0x236;
const CHECKED: std::ops::Range<usize> = 0x280..0xc80;
const CHARACTER_STRIDE: usize = 0xe;
const TAPE_COUNT: usize = 0x288;
const TAPE_WINDOW: usize = 0x28c;
const BEST_SCORES: usize = 0x32c;
const COURSE_STRIDE: usize = 0x60;

const CHARACTERS: [(&str, &str); 11] = [
    ("tony_hawk", "Tony Hawk"),
    ("bob_burnquist", "Bob Burnquist"),
    ("geoff_rowley", "Geoff Rowley"),
    ("bucky_lasek", "Bucky Lasek"),
    ("chad_muska", "Chad Muska"),
    ("kareem_campbell", "Kareem Campbell"),
    ("andrew_reynolds", "Andrew Reynolds"),
    ("rune_glifberg", "Rune Glifberg"),
    ("jamie_thomas", "Jamie Thomas"),
    ("elissa_steamer", "Elissa Steamer"),
    ("officer_dick", "Officer Dick"),
];

/// Courses in the game's record order.
const COURSES: [(&str, &str); 9] = [
    ("warehouse", "Warehouse"),
    ("school", "School"),
    ("mall", "Mall"),
    ("skate_park", "Skate Park"),
    ("downtown", "Downtown"),
    ("downhill_jam", "Downhill Jam"),
    ("burnside", "Burnside"),
    ("streets", "Streets"),
    ("roswell", "Roswell"),
];

/// Course, tape byte (relative to the character's block position), and the five tape goals
/// in bit order.
const TAPES: [(&str, usize, &str); 6] = [
    (
        "warehouse",
        0x28c,
        "Bit 0 5,000 Points, 1 Smash the Boxes, 2 Get S-K-A-T-E, 3 Hidden Tape, 4 15,000 Points.",
    ),
    (
        "school",
        0x28d,
        "Bit 0 7,500 Points, 1 Grind 5 Tables, 2 Get S-K-A-T-E, 3 Hidden Tape, 4 25,000 Points.",
    ),
    (
        "mall",
        0x28e,
        "Bit 0 10,000 Points, 1 Destroy 5 Directories, 2 Get S-K-A-T-E, 3 Hidden Tape, 4 30,000 Points.",
    ),
    (
        "downtown",
        0x290,
        "Bit 0 15,000 Points, 1 Break 5 No Skating Signs, 2 Get S-K-A-T-E, 3 Hidden Tape, 4 40,000 Points.",
    ),
    (
        "downhill_jam",
        0x291,
        "Bit 0 20,000 Points, 1 Open 5 Valves, 2 Get S-K-A-T-E, 3 Hidden Tape, 4 40,000 Points.",
    ),
    (
        "streets",
        0x293,
        "Bit 0 25,000 Points, 1 Wreck 5 Cop Cars, 2 Get S-K-A-T-E, 3 Hidden Tape, 4 50,000 Points.",
    ),
];

/// Course, medal byte for the three competition courses.
const MEDALS: [(&str, &str, usize); 3] = [
    ("skate_park", "Skate Park", 0x28f),
    ("burnside", "Burnside", 0x292),
    ("roswell", "Roswell", 0x294),
];

/// The checksum adds one to every byte and keeps the low 16 bits.
fn checksum(bytes: &[u8]) -> u16 {
    bytes
        .iter()
        .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte) + 1))
}

/// Tape bits (0 to 4) of the eight bytes from a character's first tape byte, which include the
/// low bits of the Skate Park and Burnside medal bytes.
fn tape_count(bytes: &[u8], start: usize) -> i64 {
    bytes[start..start + 8]
        .iter()
        .map(|byte| i64::from((byte & 0x1f).count_ones()))
        .sum()
}

fn tape_store(base: usize, character: usize) -> Store {
    let start = base + TAPE_WINDOW + character * CHARACTER_STRIDE;
    Store {
        when: None,
        destination: Scalar {
            offset: base + TAPE_COUNT + character * CHARACTER_STRIDE,
            storage: Storage::U8,
            mask: None,
        },
        value: ReadValue::new(move |bytes| {
            let count = tape_count(bytes, start);
            trace!(
                character,
                count, "recomputed Tony Hawk's Skateboarding tape count"
            );
            Ok(count)
        }),
    }
}

fn career_fields(base: usize, fields: &mut Vec<FieldDefinition>) {
    for (character, (slug, name)) in CHARACTERS.into_iter().enumerate() {
        let shift = base + character * CHARACTER_STRIDE;
        for (course, tape_byte, goals) in TAPES {
            let label = COURSES.iter().find(|(id, _)| *id == course).unwrap().1;
            let mut field = catalog_field(
                &format!("career.{slug}.{course}.tapes"),
                &format!("{name} {label} tapes"),
                shift + tape_byte,
                Storage::U8,
            )
            .mask(0x1f)
            .description(goals.into());
            field.behavior.on_edit.push(tape_store(base, character));
            fields.push(field);
        }
        for (course, label, medal_byte) in MEDALS {
            fields.push(
                catalog_field(
                    &format!("career.{slug}.{course}.medal"),
                    &format!("{name} {label} competition medal"),
                    shift + medal_byte,
                    Storage::U8,
                )
                .mask(0xe0)
                .choices(choices(&[
                    ("None", 0),
                    ("Gold", 1),
                    ("Silver", 2),
                    ("Bronze", 4),
                ])),
            );
        }
    }
}

fn record_fields(base: usize, fields: &mut Vec<FieldDefinition>) {
    for (course, (slug, name)) in COURSES.into_iter().enumerate() {
        fields.push(
            catalog_field(
                &format!("records.{slug}.best_score"),
                &format!("{name} best score"),
                base + BEST_SCORES + course * COURSE_STRIDE,
                Storage::U32Le,
            )
            .max(999_999),
        );
    }
}

fn option_fields(base: usize, fields: &mut Vec<FieldDefinition>) {
    let buttons = || {
        choices(&[
            ("Grind/Slide", 0),
            ("Flip Trick", 1),
            ("Grab Trick", 2),
            ("Jump/Ollie", 3),
        ])
    };
    let toggle = || choices(&[("Off", 0), ("On", 1)]);
    for (player, controls, vibration, autokick) in
        [(1, 0xbd0, 0xbc8, 0xbc0), (2, 0xbe0, 0xbcc, 0xbc4)]
    {
        for (index, button) in ["Triangle", "Square", "Circle", "Cross"]
            .into_iter()
            .enumerate()
        {
            fields.push(
                catalog_field(
                    &format!("options.player_{player}.{}", button.to_lowercase()),
                    &format!("Player {player} {button} button"),
                    base + controls + index * 4,
                    Storage::U8,
                )
                .choices(buttons()),
            );
        }
        fields.push(
            catalog_field(
                &format!("options.player_{player}.vibration"),
                &format!("Player {player} vibration"),
                base + vibration,
                Storage::U8,
            )
            .choices(toggle()),
        );
        fields.push(
            catalog_field(
                &format!("options.player_{player}.autokick"),
                &format!("Player {player} autokick"),
                base + autokick,
                Storage::U8,
            )
            .choices(toggle()),
        );
    }
    for (id, label, offset) in [
        ("options.sfx_level", "Sound effects level", 0xab0),
        ("options.music_level", "Music level", 0xab4),
    ] {
        fields.push(catalog_field(id, label, base + offset, Storage::U8).max(12));
    }
    for (id, label, offset) in [
        ("options.trick_tips", "Trick tips", 0xc34),
        ("options.score_display", "Score display", 0xc38),
    ] {
        fields.push(catalog_field(id, label, base + offset, Storage::U8).choices(toggle()));
    }
}

fn integrity(game: &mut GameDefinition, base: usize) {
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| {
            let expected = checksum(&bytes[base + CHECKED.start..base + CHECKED.end]);
            Ok(bytes[base + CHECKSUM..base + CHECKSUM + 2] == expected.to_le_bytes())
        }),
        code: "tony_hawk_checksum".into(),
        message: "selected Tony Hawk's Skateboarding block checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    game.runtime.checks.push(check.clone());
    game.runtime
        .recognition
        .as_mut()
        .unwrap()
        .checks
        .push(check);
    game.runtime.after_edit.push(Store {
        when: None,
        destination: Scalar {
            offset: base + CHECKSUM,
            storage: Storage::U16Le,
            mask: None,
        },
        value: ReadValue::new(move |bytes| {
            let value = checksum(&bytes[base + CHECKED.start..base + CHECKED.end]);
            debug!(value, "recomputed Tony Hawk's Skateboarding checksum");
            Ok(i64::from(value))
        }),
    });
}

fn profile(region: &str, product: &'static str, block: usize) -> GameDefinition {
    let base = block * BLOCK_SIZE;
    let mut fields = Vec::new();
    career_fields(base, &mut fields);
    record_fields(base, &mut fields);
    option_fields(base, &mut fields);
    let mut game = playstation_card::definition(
        "tony-hawk-s-skateboarding",
        "Tony Hawk's Skateboarding",
        region,
        product,
        block,
        fields,
    );
    integrity(&mut game, base);
    game
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        for (region, product) in [
            ("europe", "SLES-02055"),
            ("usa", "SLUS-00860"),
            ("japan", "SLPM-86429"),
        ] {
            games.push(profile(region, product, block));
        }
    }
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::super::ps1_action_support::*;
    use super::*;

    const BLOCK: usize = 3;
    const BASE: usize = BLOCK * BLOCK_SIZE;

    fn game() -> GameDefinition {
        profile("usa", "SLUS-00860", BLOCK)
    }

    /// Independent restatement of the upstream checksum: a plain wide sum of byte + 1.
    fn expected_checksum(bytes: &[u8]) -> u16 {
        let total: u64 = bytes[BASE + 0x280..BASE + 0xc80]
            .iter()
            .map(|byte| u64::from(*byte) + 1)
            .sum();
        (total & 0xffff) as u16
    }

    fn expected_tapes(bytes: &[u8], character: usize) -> usize {
        let start = BASE + 0x28c + character * 0xe;
        let mut count = 0;
        for byte in &bytes[start..start + 8] {
            for bit in 0..5 {
                count += usize::from(byte >> bit & 1);
            }
        }
        count
    }

    fn template() -> Vec<u8> {
        let game = game();
        let mut bytes = playstation_card::fixture("SLUS-00860", BLOCK);
        lcg_fill(&mut bytes[BASE + 0x280..BASE + 0xc80], 0x5eed);
        for field in game.fields.iter().filter(|field| !field.choices.is_empty()) {
            bytes[field.offset] &= !field.mask.map_or(0xff, |mask| mask as u8);
        }
        for character in 0..11 {
            bytes[BASE + 0x288 + character * 0xe] = expected_tapes(&bytes, character) as u8;
        }
        let checksum = expected_checksum(&bytes);
        bytes[BASE + 0x236..BASE + 0x238].copy_from_slice(&checksum.to_le_bytes());
        bytes
    }

    #[test]
    fn checksum_wraps_at_sixteen_bits_and_matches_the_wide_sum() {
        let ones = [0xffu8; 0xa00];
        assert_eq!(checksum(&ones), 0);
        assert_eq!(checksum(&[0; 0xa00]), 0xa00);
        assert_eq!(checksum(&[0xff; 0x100]), 0);
        let mut bytes = vec![0u8; BASE + 0xc80];
        lcg_fill(&mut bytes[BASE + 0x280..], 9);
        assert!(
            bytes[BASE + 0x280..]
                .iter()
                .map(|byte| u32::from(*byte) + 1)
                .sum::<u32>()
                > 0xffff
        );
        assert_eq!(
            checksum(&bytes[BASE + 0x280..BASE + 0xc80]),
            expected_checksum(&bytes)
        );
    }

    #[test]
    fn every_field_edits_only_itself_its_tape_counter_and_the_checksum() {
        let game = game();
        let template = template();
        let original = parse_fields(&game, &template);
        let editable = original.iter().filter(|field| field.editable).count();
        let edits = edit_each_field(&game, &template);
        assert_eq!(edits.len(), editable);
        assert_eq!(editable, original.len());
        assert_eq!(original.len(), 11 * 9 + 9 + 16);
        for edit in edits {
            let mut allowed = vec![BASE + 0x236, BASE + 0x237];
            if edit.id.ends_with(".tapes") {
                let slug = edit.id.split('.').nth(1).unwrap();
                let character = CHARACTERS
                    .iter()
                    .position(|(candidate, _)| *candidate == slug)
                    .unwrap();
                allowed.push(BASE + 0x288 + character * 0xe);
                let stored = usize::from(edit.after[BASE + 0x288 + character * 0xe]);
                assert_eq!(
                    stored,
                    expected_tapes(&edit.after, character),
                    "{}",
                    edit.id
                );
            }
            assert!(
                edit.stray.iter().all(|index| allowed.contains(index)),
                "{}: {:x?}",
                edit.id,
                edit.stray
            );
            assert_only_changed(&edit, &original, &[]);
            let stored = &edit.after[BASE + 0x236..BASE + 0x238];
            assert_eq!(
                stored,
                expected_checksum(&edit.after).to_le_bytes(),
                "{}",
                edit.id
            );
        }
    }

    #[test]
    fn spot_checks_use_the_documented_offsets_and_preserve_neighbours() {
        let game = game();
        let mut template = template();
        template[BASE + 0x28f] = 0x15;
        template[BASE + 0x311] = 0xe0;
        let checksum = expected_checksum(&template);
        template[BASE + 0x236..BASE + 0x238].copy_from_slice(&checksum.to_le_bytes());
        let edits = edit_each_field(&game, &template);
        let find = |id: &str| edits.iter().find(|edit| edit.id == id).unwrap();
        // The alternate medal is the last listed choice, Bronze, which sets only bit 7.
        assert_eq!(
            find("career.tony_hawk.skate_park.medal").after[BASE + 0x28f],
            0x95
        );
        // All five tape bits set keeps the byte's upper bits and updates the character counter.
        let streets = find("career.elissa_steamer.streets.tapes");
        assert_eq!(streets.after[BASE + 0x311], 0xff);
        assert_eq!(
            usize::from(streets.after[BASE + 0x288 + 9 * 0xe]),
            expected_tapes(&streets.after, 9)
        );
        assert_eq!(
            find("records.roswell.best_score").after[BASE + 0x62c..BASE + 0x630],
            999_999u32.to_le_bytes()
        );
        assert_eq!(find("options.player_2.cross").after[BASE + 0xbec], 3);
        assert_eq!(find("options.sfx_level").after[BASE + 0xab0], 12);
        assert_eq!(find("options.score_display").after[BASE + 0xc38], 1);
    }

    #[test]
    fn rejects_values_the_game_never_stores_and_damaged_blocks() {
        let game = game();
        let handler = handler(&game);
        let identity = handler.definitions().remove(0).identity;
        let template = template();
        let source = input(template.clone(), &identity.id);
        for (field, value) in [
            ("options.sfx_level", SaveValue::U32(13)),
            ("records.mall.best_score", SaveValue::U32(1_000_000)),
            (
                "career.tony_hawk.burnside.medal",
                SaveValue::Enum("raw:3".into()),
            ),
            ("career.tony_hawk.warehouse.tapes", SaveValue::U32(32)),
        ] {
            let edit = SaveEdit {
                field: field.into(),
                value,
            };
            assert!(
                handler.apply(&source, &identity, &[edit], false).is_err(),
                "{field}"
            );
        }
        for offset in [0x236, 0x280, 0x7ff, 0xc7f] {
            let mut bytes = template.clone();
            bytes[BASE + offset] ^= 1;
            assert!(
                handler
                    .apply(&input(bytes, &identity.id), &identity, &[], false)
                    .is_err(),
                "accepted damage at {offset:x}"
            );
        }
        let mut bytes = template;
        bytes[BASE + 0xc80] ^= 1;
        assert!(
            handler
                .apply(&input(bytes, &identity.id), &identity, &[], false)
                .is_ok(),
            "bytes after the checked range are not covered"
        );
    }
}
