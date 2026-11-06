use super::playstation_card::{self, BLOCK_SIZE};
use super::*;

// Fields and the checksum MUST follow this pinned game layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/tomb-raider-ii-starring-lara-croft/saveEditor
const CHECKSUM: usize = 0x64b;
const CHECKED: std::ops::Range<usize> = 0x200..0x1ed0;
const LOCATIONS: usize = 0x240;
const LOCATION_STRIDE: usize = 0x2c;
const SECRETS: usize = 0x256;

const LEVELS: [(&str, &str); 18] = [
    ("great_wall", "The Great Wall"),
    ("venice", "Venice"),
    ("bartolis_hideout", "Bartoli's Hideout"),
    ("opera_house", "Opera House"),
    ("offshore_rig", "Offshore Rig"),
    ("diving_area", "Diving Area"),
    ("forty_fathoms", "40 Fathoms"),
    ("wreck_of_the_maria_doria", "Wreck of the Maria Doria"),
    ("living_quarters", "Living Quarters"),
    ("the_deck", "The Deck"),
    ("tibetan_foothills", "Tibetan Foothills"),
    ("barkhang_monastery", "Barkhang Monastery"),
    ("catacombs_of_the_talion", "Catacombs of the Talion"),
    ("ice_palace", "Ice Palace"),
    ("temple_of_xian", "Temple of Xian"),
    ("floating_islands", "Floating Islands"),
    ("dragons_lair", "The Dragon's Lair"),
    ("home_sweet_home", "Home Sweet Home"),
];

/// Negated byte sum of the checked range, skipping the stored checksum byte, as the game
/// recomputes it with that byte zeroed.
fn checksum(bytes: &[u8]) -> u8 {
    let sum = bytes[CHECKED]
        .iter()
        .enumerate()
        .filter(|(index, _)| CHECKED.start + index != CHECKSUM)
        .fold(0u8, |sum, (_, byte)| sum.wrapping_add(*byte));
    sum.wrapping_neg()
}

fn fields(base: usize) -> Vec<FieldDefinition> {
    let mut fields = vec![
        catalog_field("progression", "Progression", base + 0x640, Storage::U8)
            .choices(choices(&[("-", 0), ("Game cleared", 1)]))
            .description("Also grants every weapon and unlimited ammo in each level.".into()),
    ];
    for (level, (slug, name)) in LEVELS.into_iter().enumerate() {
        let record = base + LOCATIONS + level * LOCATION_STRIDE;
        fields.push(
            catalog_field(
                &format!("locations.{slug}.unlocked"),
                &format!("{name} unlocked"),
                record,
                Storage::Bit,
            )
            .bit(0),
        );
        // The last two levels have no secrets.
        if level < 16 {
            fields.push(
                catalog_field(
                    &format!("locations.{slug}.secrets"),
                    &format!("{name} secrets"),
                    base + SECRETS + level * LOCATION_STRIDE,
                    Storage::U8,
                )
                .mask(0x7)
                .description("Bit 0 Gold Dragon, 1 Jade Dragon, 2 Stone Dragon.".into()),
            );
        }
    }
    fields.extend([
        catalog_field(
            "options.bgm_volume",
            "Music volume",
            base + 0x63a,
            Storage::U16Le,
        )
        .max(255),
        catalog_field(
            "options.se_volume",
            "Sound effects volume",
            base + 0x638,
            Storage::U16Le,
        )
        .max(255),
        catalog_field(
            "options.screen_position_x",
            "Screen position X",
            base + 0x63c,
            Storage::I16Le,
        )
        .min(-10)
        .max(32),
        catalog_field(
            "options.screen_position_y",
            "Screen position Y",
            base + 0x63e,
            Storage::I16Le,
        )
        .min(-6)
        .max(40),
        catalog_field(
            "options.control_method",
            "Control method",
            base + 0x636,
            Storage::U16Le,
        )
        .choices(choices(&[
            ("Type 1", 0),
            ("Type 2", 1),
            ("Type 3", 2),
            ("Type 4", 3),
            ("Type 5", 4),
        ])),
    ]);
    fields
}

fn integrity(game: &mut GameDefinition, base: usize) {
    playstation_card::integrity(
        game,
        base,
        &playstation_card::Integrity {
            code: "tomb_raider_ii_checksum",
            message: "selected Tomb Raider II block checksum is invalid",
            storage: Storage::U8,
            offsets: &[CHECKSUM],
            span: BLOCK_SIZE,
        },
        |_| true,
        |block| u32::from(checksum(block)),
    );
}

fn profile(region: &str, product: &'static str, block: usize) -> GameDefinition {
    let base = block * BLOCK_SIZE;
    let mut game = playstation_card::definition(
        "tomb-raider-ii-starring-lara-croft",
        "Tomb Raider II Starring Lara Croft",
        region,
        product,
        block,
        1,
        fields(base),
    );
    integrity(&mut game, base);
    game
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        for (region, product) in [
            ("europe", "SLES-00718"),
            ("usa", "SLUS-00437"),
            ("japan", "SLPS-01200"),
            ("france", "SLES-00719"),
            ("germany", "SLES-00720"),
            ("italy", "SLES-00107"),
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

    const BLOCK: usize = 5;
    const BASE: usize = BLOCK * BLOCK_SIZE;

    fn game() -> GameDefinition {
        profile("usa", "SLUS-00437", BLOCK)
    }

    /// Independent restatement of the upstream rule: the checksum byte is zeroed, every byte of
    /// the range is summed, and the stored byte is the negated sum modulo 256.
    fn expected_checksum(bytes: &[u8]) -> u8 {
        let mut copy = bytes.to_vec();
        copy[BASE + 0x64b] = 0;
        let sum: i64 = copy[BASE + 0x200..BASE + 0x1ed0]
            .iter()
            .map(|byte| i64::from(*byte))
            .sum();
        (-sum).rem_euclid(256) as u8
    }

    fn seal(bytes: &mut [u8]) {
        bytes[BASE + 0x64b] = expected_checksum(bytes);
    }

    fn template() -> Vec<u8> {
        let game = game();
        let mut bytes = playstation_card::fixture("SLUS-00437", BLOCK);
        lcg_fill(&mut bytes[BASE + 0x200..BASE + 0x1ed0], 0x70b4);
        for field in game.fields.iter().filter(|field| !field.choices.is_empty()) {
            let width = if matches!(field.storage, Storage::U16Le) {
                2
            } else {
                1
            };
            bytes[field.offset..field.offset + width].fill(0);
        }
        // Signed screen offsets must be inside the game's range for the template to be valid.
        bytes[BASE + 0x63c..BASE + 0x640].fill(0);
        seal(&mut bytes);
        bytes
    }

    #[test]
    fn checksum_negates_the_sum_and_wraps_at_one_byte() {
        let mut bytes = vec![0u8; BASE + BLOCK_SIZE];
        assert_eq!(checksum(&bytes[BASE..]), 0);
        bytes[BASE + 0x200] = 1;
        assert_eq!(checksum(&bytes[BASE..]), 0xff);
        bytes[BASE + 0x1ecf] = 0xff;
        assert_eq!(checksum(&bytes[BASE..]), 0);
        bytes[BASE + 0x1ed0] = 0x55;
        assert_eq!(
            checksum(&bytes[BASE..]),
            0,
            "bytes after the range are ignored"
        );
        bytes[BASE + 0x64b] = 0x77;
        assert_eq!(checksum(&bytes[BASE..]), 0, "the stored byte is excluded");
        bytes[BASE + 0x1ff] = 0x55;
        assert_eq!(
            checksum(&bytes[BASE..]),
            0,
            "bytes before the range are ignored"
        );
        bytes[BASE + 0x201] = 0x80;
        bytes[BASE + 0x202] = 0x80;
        bytes[BASE + 0x203] = 0x80;
        assert_eq!(checksum(&bytes[BASE..]), 0x80);
        let mut random = playstation_card::fixture("SLUS-00437", BLOCK);
        lcg_fill(&mut random[BASE + 0x200..BASE + 0x1ed0], 3);
        assert_eq!(
            checksum(&random[BASE..BASE + BLOCK_SIZE]),
            expected_checksum(&random)
        );
    }

    #[test]
    fn every_field_edits_only_itself_and_the_checksum() {
        let game = game();
        let template = template();
        let original = parse_fields(&game, &template);
        assert_eq!(original.len(), 1 + 18 + 16 + 5);
        let edits = edit_each_field(&game, &template);
        assert_eq!(edits.len(), original.len());
        for edit in edits {
            assert!(
                edit.stray.iter().all(|index| *index == BASE + 0x64b),
                "{}: {:x?}",
                edit.id,
                edit.stray
            );
            assert_only_changed(&edit, &original, &[]);
            assert_eq!(
                edit.after[BASE + 0x64b],
                expected_checksum(&edit.after),
                "{}",
                edit.id
            );
        }
    }

    #[test]
    fn spot_checks_use_the_documented_offsets() {
        let game = game();
        let mut template = template();
        template[BASE + 0x240 + 17 * 0x2c] = 0xfe;
        template[BASE + 0x256 + 15 * 0x2c] = 0xf8;
        seal(&mut template);
        let edits = edit_each_field(&game, &template);
        let find = |id: &str| edits.iter().find(|edit| edit.id == id).unwrap();
        assert_eq!(find("progression").after[BASE + 0x640], 1);
        assert_eq!(
            find("locations.home_sweet_home.unlocked").after[BASE + 0x240 + 17 * 0x2c],
            0xff
        );
        assert_eq!(
            find("locations.floating_islands.secrets").after[BASE + 0x256 + 15 * 0x2c],
            0xff
        );
        assert_eq!(
            find("options.bgm_volume").after[BASE + 0x63a..BASE + 0x63c],
            255u16.to_le_bytes()
        );
        assert_eq!(
            find("options.screen_position_x").after[BASE + 0x63c..BASE + 0x63e],
            32i16.to_le_bytes()
        );
        assert_eq!(
            find("options.control_method").after[BASE + 0x636..BASE + 0x638],
            4u16.to_le_bytes()
        );
        assert!(
            game.fields
                .iter()
                .all(|field| !field.id.contains("dragons_lair.secrets"))
        );
    }

    #[test]
    fn rejects_out_of_range_values_and_damaged_blocks() {
        let game = game();
        let handler = handler(&game);
        let identity = handler.definitions().remove(0).identity;
        let template = template();
        let source = input(template.clone(), &identity.id);
        for (field, value) in [
            ("options.bgm_volume", SaveValue::U32(256)),
            ("options.screen_position_x", SaveValue::I32(33)),
            ("options.screen_position_x", SaveValue::I32(-11)),
            ("options.screen_position_y", SaveValue::I32(41)),
            ("locations.venice.secrets", SaveValue::U32(8)),
            ("options.control_method", SaveValue::Enum("raw:5".into())),
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
        for offset in [0x200, 0x64b, 0x1ecf] {
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
        bytes[BASE + 0x1ed0] ^= 1;
        assert!(
            handler
                .apply(&input(bytes, &identity.id), &identity, &[], false)
                .is_ok()
        );
    }
}
