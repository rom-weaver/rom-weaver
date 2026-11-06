use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::Check;

// The block CRC and the gil preview copy MUST follow the pinned PS1 layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/final-fantasy-ix/saveEditor
// The CRC is CRC-16/MCRF4XX (reflected 0x1021, initial 0xffff, no final xor), checked in the
// CRC catalogue: https://reveng.sourceforge.io/crc-catalogue/16.htm#crc.cat.crc-16-mcrf4xx
const CRC_START: usize = 0;
const CRC_END: usize = 0x13fe;
const CRC_OFFSET: usize = 0x13fe;
const RELEASES: [(&str, &str, u32); 7] = [
    ("europe", "SLES-02965", 50),
    ("usa", "SLUS-01251", 60),
    ("japan", "SLPS-02000", 60),
    ("france", "SLES-02966", 50),
    ("germany", "SLES-02967", 50),
    ("italy", "SLES-02968", 50),
    ("spain", "SLES-02969", 50),
];

fn crc(bytes: &[u8]) -> u16 {
    let mut value = 0xffffu16;
    for byte in bytes {
        value ^= u16::from(*byte);
        for _ in 0..8 {
            value = (value >> 1) ^ if value & 1 != 0 { 0x8408 } else { 0 };
        }
    }
    value
}

fn integrity(game: &mut GameDefinition, base: usize) {
    let check = Check {
        when: None,
        assert: rules::Condition::new(move |bytes| {
            let expected = crc(&bytes[base + CRC_START..base + CRC_END]).to_le_bytes();
            Ok(bytes[base + CRC_OFFSET..base + CRC_OFFSET + 2] == expected)
        }),
        code: "final_fantasy_ix_crc".into(),
        message: "selected Final Fantasy IX block checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    playstation_card::register_check(game, check);
    playstation_card::store_checksum(
        game,
        base + CRC_OFFSET,
        Storage::U16Le,
        None,
        move |bytes| i64::from(crc(&bytes[base + CRC_START..base + CRC_END])),
    );
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product, ticks_per_second) in RELEASES {
            let fields = vec![
                catalog_field("gil", "Gil", base + 0xee8, Storage::U32Le)
                    .min(0)
                    .max(9_999_999)
                    .copies(vec![base + 0x130]),
                catalog_field(
                    "playtime_ticks",
                    "Playtime ticks",
                    base + 0x12c,
                    Storage::U32Le,
                )
                .min(0)
                .max(2_160_000 * i64::from(ticks_per_second) - 1)
                .description(
                    format!("The game counts {ticks_per_second} ticks per second in this region; the maximum is 599 hours 59 minutes 59 seconds."),
                ),
            ];
            let mut game = playstation_card::definition(
                "final-fantasy-ix",
                "Final Fantasy IX",
                region,
                product,
                block,
                fields,
            );
            integrity(&mut game, base);
            games.push(game);
        }
    }
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::playstation_card::{apply, edit};
    use super::*;

    #[test]
    fn crc_has_the_catalogue_check_value() {
        assert_eq!(crc(b"123456789"), 0x6f91);
        assert_eq!(crc(&[]), 0xffff);
        assert_eq!(crc(&[0]), 0x0f87);
    }

    // Payload bytes follow a fixed pattern that the expected CRC below was computed from
    // with an independent Python implementation of the same reflected polynomial.
    fn fixture(product: &str, block: usize) -> Vec<u8> {
        let mut bytes = playstation_card::fixture(product, block);
        let base = block * BLOCK_SIZE;
        for offset in 0x200..CRC_END {
            bytes[base + offset] = (offset * 7 + 3) as u8;
        }
        let checksum = crc(&bytes[base..base + CRC_END]);
        bytes[base + CRC_OFFSET..base + CRC_OFFSET + 2].copy_from_slice(&checksum.to_le_bytes());
        bytes
    }

    #[test]
    fn fixture_crc_matches_the_independent_value() {
        let bytes = fixture("SLUS-01251", 2);
        let base = 2 * BLOCK_SIZE;
        assert_eq!(
            &bytes[base + CRC_OFFSET..base + CRC_OFFSET + 2],
            &0x7e66u16.to_le_bytes()
        );
    }

    #[test]
    fn edits_mirror_gil_and_repair_the_crc_in_every_region() {
        for (region, product, ticks) in RELEASES {
            let id = format!("final-fantasy-ix-{region}-block-2");
            let input = fixture(product, 2);
            let base = 2 * BLOCK_SIZE;
            let edits = [edit("gil", 9_999_999), edit("playtime_ticks", ticks * 3600)];
            let output = apply(schemas, &id, &input, &edits).unwrap();
            assert_eq!(
                &output[base + 0xee8..base + 0xeec],
                &9_999_999u32.to_le_bytes()
            );
            assert_eq!(
                &output[base + 0x130..base + 0x134],
                &9_999_999u32.to_le_bytes()
            );
            assert_eq!(
                &output[base + 0x12c..base + 0x130],
                &(ticks * 3600).to_le_bytes()
            );
            let checksum = crc(&output[base..base + CRC_END]);
            assert_eq!(
                &output[base + CRC_OFFSET..base + CRC_OFFSET + 2],
                &checksum.to_le_bytes()
            );
            let changed = [0x12c..0x134, 0xee8..0xeec, CRC_OFFSET..CRC_OFFSET + 2];
            for (index, (&after, &before)) in output.iter().zip(&input).enumerate() {
                if !changed
                    .iter()
                    .any(|range| range.contains(&index.wrapping_sub(base)))
                {
                    assert_eq!(after, before, "{id} at {index:x}");
                }
            }
            assert_eq!(apply(schemas, &id, &output, &edits).unwrap(), output);
        }
    }

    #[test]
    fn gil_edit_matches_an_independent_crc() {
        let input = fixture("SLUS-01251", 2);
        let output = apply(
            schemas,
            "final-fantasy-ix-usa-block-2",
            &input,
            &[edit("gil", 9_999_999)],
        )
        .unwrap();
        let base = 2 * BLOCK_SIZE;
        assert_eq!(
            &output[base + CRC_OFFSET..base + CRC_OFFSET + 2],
            &0x8454u16.to_le_bytes()
        );
    }

    #[test]
    fn limits_are_enforced_and_damage_is_rejected() {
        let input = fixture("SLUS-01251", 2);
        let id = "final-fantasy-ix-usa-block-2";
        assert!(apply(schemas, id, &input, &[edit("gil", 10_000_000)]).is_err());
        assert!(
            apply(
                schemas,
                id,
                &input,
                &[edit("playtime_ticks", 2_160_000 * 60)]
            )
            .is_err()
        );
        assert!(
            apply(
                schemas,
                id,
                &input,
                &[edit("playtime_ticks", 2_160_000 * 60 - 1)]
            )
            .is_ok()
        );
        let europe = fixture("SLES-02965", 2);
        assert!(
            apply(
                schemas,
                "final-fantasy-ix-europe-block-2",
                &europe,
                &[edit("playtime_ticks", 2_160_000 * 50)]
            )
            .is_err()
        );
        let base = 2 * BLOCK_SIZE;
        for offset in [0, 0x130, 0x13fd, CRC_OFFSET, CRC_OFFSET + 1] {
            let mut damaged = input.clone();
            damaged[base + offset] ^= 1;
            assert!(
                apply(schemas, id, &damaged, &[]).is_err(),
                "accepted damage at {offset:x}"
            );
        }
        let mut other_block = input.clone();
        other_block[BLOCK_SIZE * 3 + 0x300] ^= 1;
        assert!(apply(schemas, id, &other_block, &[]).is_ok());
        let wrong_product = fixture("SLUS-01252", 2);
        assert!(apply(schemas, id, &wrong_product, &[]).is_err());
    }
}
