use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::{Check, Condition};

// The preview table, slot table, and their checksums MUST follow the pinned PS1 layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/silent-hill/saveEditor
// The options section is not exposed: the game copies it into every Silent Hill block, which a
// single-block profile cannot keep consistent.
const PREVIEWS: usize = 0x204;
const PREVIEW_ENTRY: usize = 0xc;
const PREVIEW_CHECKSUM: usize = 0x2fc;
const SLOTS: usize = 11;
const SLOT_START: usize = 0x380;
const SLOT_SIZE: usize = 0x280;
const SLOT_CHECKSUM: usize = 0x27c;
const RELEASES: [(&str, &str); 3] = [
    ("europe", "SLES-01514"),
    ("usa", "SLUS-00707"),
    ("japan", "SLPM-86192"),
];

fn xor_checksum(bytes: &[u8]) -> u16 {
    let xor = bytes.iter().fold(0u8, |xor, value| xor ^ value);
    u16::from(xor) * 0x101
}

/// Slots are listed in order until the first preview entry with a zero save count.
fn populated(bytes: &[u8], base: usize, slot: usize) -> bool {
    (0..=slot).all(|index| {
        let offset = base + PREVIEWS + index * PREVIEW_ENTRY;
        bytes[offset..offset + 4] != [0; 4]
    })
}

fn populated_condition(base: usize, slot: usize) -> Condition {
    Condition::new(move |bytes| Ok(populated(bytes, base, slot)))
}

fn slot_range(base: usize, slot: usize) -> std::ops::Range<usize> {
    let start = base + SLOT_START + slot * SLOT_SIZE;
    start..start + SLOT_CHECKSUM
}

fn integrity(game: &mut GameDefinition, base: usize) {
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| {
            let preview = &bytes[base + PREVIEWS..base + PREVIEW_CHECKSUM];
            let stored = |offset: usize| u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
            Ok(stored(base + PREVIEW_CHECKSUM) == xor_checksum(preview)
                && (0..SLOTS)
                    .filter(|slot| populated(bytes, base, *slot))
                    .all(|slot| {
                        let range = slot_range(base, slot);
                        stored(range.end) == xor_checksum(&bytes[range])
                    }))
        }),
        code: "silent_hill_checksum".into(),
        message: "selected Silent Hill block has an invalid preview or slot checksum".into(),
        section_id: None,
        warning: None,
    };
    playstation_card::register_check(game, check);
    playstation_card::store_checksum(
        game,
        base + PREVIEW_CHECKSUM,
        Storage::U16Le,
        None,
        move |bytes| {
            i64::from(xor_checksum(
                &bytes[base + PREVIEWS..base + PREVIEW_CHECKSUM],
            ))
        },
    );
    for slot in 0..SLOTS {
        let range = slot_range(base, slot);
        playstation_card::store_checksum(
            game,
            range.end,
            Storage::U16Le,
            Some(populated_condition(base, slot)),
            move |bytes| i64::from(xor_checksum(&bytes[range.clone()])),
        );
    }
}

fn slot_fields(base: usize) -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for slot in 0..SLOTS {
        let start = base + SLOT_START + slot * SLOT_SIZE;
        let number = slot + 1;
        let mut slot_fields = vec![
            catalog_field(
                &format!("slot_{number}.health"),
                &format!("Slot {number} health"),
                start + 0x242,
                Storage::U8,
            )
            .min(0)
            .max(6),
            catalog_field(
                &format!("slot_{number}.game_clear"),
                &format!("Slot {number} game clear count"),
                start + 0x24a,
                Storage::U8,
            )
            .min(0)
            .max(99),
            catalog_field(
                &format!("slot_{number}.continues"),
                &format!("Slot {number} continues"),
                start + 0x27b,
                Storage::U8,
            )
            .min(0)
            .max(99),
            // Mirrored into the preview's 16-bit saves count at +0x8. Zero is valid: the slot-in-use
            // marker is the total saves at preview +0x0, which this field never writes.
            catalog_field(
                &format!("slot_{number}.saves"),
                &format!("Slot {number} saves"),
                start + 0xa6,
                Storage::U16Le,
            )
            .min(0)
            .max(999)
            .copies(vec![base + PREVIEWS + slot * PREVIEW_ENTRY + 0x8]),
        ];
        let condition = populated_condition(base, slot);
        for field in &mut slot_fields {
            field.behavior.present_when = Some(condition.clone());
            field.behavior.editable_when = Some(condition.clone());
        }
        fields.extend(slot_fields);
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product) in RELEASES {
            let mut game = playstation_card::definition(
                "silent-hill",
                "Silent Hill",
                region,
                product,
                block,
                slot_fields(base),
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

    fn refresh(bytes: &mut [u8], base: usize) {
        let previews = xor_checksum(&bytes[base + PREVIEWS..base + PREVIEW_CHECKSUM]);
        bytes[base + PREVIEW_CHECKSUM..base + PREVIEW_CHECKSUM + 2]
            .copy_from_slice(&previews.to_le_bytes());
        for slot in 0..SLOTS {
            if populated(bytes, base, slot) {
                let range = slot_range(base, slot);
                let value = xor_checksum(&bytes[range.clone()]);
                bytes[range.end..range.end + 2].copy_from_slice(&value.to_le_bytes());
            }
        }
    }

    // Slots 1 to 3 are populated; slot 4 is unused and keeps a deliberately invalid checksum.
    // The expected checksums in the tests were computed with an independent Python port.
    fn fixture(product: &str, block: usize) -> Vec<u8> {
        let mut bytes = playstation_card::fixture(product, block);
        let base = block * BLOCK_SIZE;
        for offset in (PREVIEWS..PREVIEW_CHECKSUM).chain(SLOT_START..SLOT_START + SLOTS * SLOT_SIZE)
        {
            bytes[base + offset] = (offset * 37 + 11) as u8;
        }
        for slot in 0..SLOTS {
            let offset = base + PREVIEWS + slot * PREVIEW_ENTRY;
            bytes[offset..offset + 4]
                .copy_from_slice(&if slot < 3 { slot as u32 + 1 } else { 0 }.to_le_bytes());
        }
        refresh(&mut bytes, base);
        bytes
    }

    #[test]
    fn fixture_checksums_match_the_independent_values() {
        let bytes = fixture("SLUS-00707", 3);
        let base = 3 * BLOCK_SIZE;
        assert_eq!(&bytes[base + 0x2fc..base + 0x2fe], &[0x3c, 0x3c]);
        for slot in 0..3 {
            let offset = base + 0x380 + slot * 0x280 + 0x27c;
            assert_eq!(&bytes[offset..offset + 2], &[0x4c, 0x4c]);
        }
        // The unused slot keeps pattern bytes where a checksum would be, which are not its xor.
        let offset = base + 0x380 + 3 * 0x280 + 0x27c;
        assert_eq!(bytes[offset], 0xf7);
        assert_ne!(bytes[offset..offset + 2], [0xf7, 0xf7]);
    }

    #[test]
    fn edits_mirror_the_save_count_and_repair_the_touched_checksums() {
        for (region, product) in RELEASES {
            let id = format!("silent-hill-{region}-block-3");
            let input = fixture(product, 3);
            let base = 3 * BLOCK_SIZE;
            let edits = [
                edit("slot_2.health", 6),
                edit("slot_2.saves", 500),
                edit("slot_2.game_clear", 99),
                edit("slot_2.continues", 99),
            ];
            let output = apply(schemas, &id, &input, &edits).unwrap();
            assert_eq!(output[base + 0x842], 6);
            assert_eq!(&output[base + 0x6a6..base + 0x6a8], &500u16.to_le_bytes());
            // Preview entry 2 is at +0x210: saves at +0x8 is mirrored, total saves at +0x0 is not.
            assert_eq!(&output[base + 0x218..base + 0x21a], &500u16.to_le_bytes());
            assert_eq!(
                &output[base + 0x210..base + 0x214],
                &input[base + 0x210..base + 0x214]
            );
            assert_eq!(output[base + 0x600 + 0x24a], 99);
            assert_eq!(output[base + 0x600 + 0x27b], 99);
            let mut expected = input.clone();
            expected[base + 0x842] = 6;
            expected[base + 0x6a6..base + 0x6a8].copy_from_slice(&500u16.to_le_bytes());
            expected[base + 0x218..base + 0x21a].copy_from_slice(&500u16.to_le_bytes());
            expected[base + 0x600 + 0x24a] = 99;
            expected[base + 0x600 + 0x27b] = 99;
            let mut reference = expected.clone();
            // Independent recomputation of the two checksums touched by this edit.
            let slot_xor = reference[base + 0x600..base + 0x600 + 0x27c]
                .iter()
                .fold(0, |xor, value| xor ^ value);
            reference[base + 0x600 + 0x27c] = slot_xor;
            reference[base + 0x600 + 0x27d] = slot_xor;
            let preview_xor = reference[base + 0x204..base + 0x2fc]
                .iter()
                .fold(0, |xor, value| xor ^ value);
            reference[base + 0x2fc] = preview_xor;
            reference[base + 0x2fd] = preview_xor;
            assert_eq!(output, reference, "{id}");
            assert_eq!(apply(schemas, &id, &output, &edits).unwrap(), output);
        }
    }

    #[test]
    fn single_edit_matches_the_independent_python_checksums() {
        let input = fixture("SLUS-00707", 3);
        let base = 3 * BLOCK_SIZE;
        let output = apply(
            schemas,
            "silent-hill-usa-block-3",
            &input,
            &[edit("slot_2.health", 6), edit("slot_2.saves", 500)],
        )
        .unwrap();
        assert_eq!(
            &output[base + 0x600 + 0x27c..base + 0x600 + 0x27e],
            &[0x0d, 0x0d]
        );
        assert_eq!(&output[base + 0x2fc..base + 0x2fe], &[0xe2, 0xe2]);
        for slot in [0usize, 2] {
            let offset = base + 0x380 + slot * 0x280 + 0x27c;
            assert_eq!(&output[offset..offset + 2], &[0x4c, 0x4c]);
        }
    }

    #[test]
    fn unused_slots_are_not_editable_and_stay_untouched() {
        let id = "silent-hill-usa-block-3";
        let input = fixture("SLUS-00707", 3);
        assert!(apply(schemas, id, &input, &[edit("slot_4.health", 1)]).is_err());
        // A populated entry after an empty one is not listed by the game.
        let mut gap = input.clone();
        let base = 3 * BLOCK_SIZE;
        gap[base + PREVIEWS + 4 * PREVIEW_ENTRY] = 1;
        refresh(&mut gap, base);
        assert!(apply(schemas, id, &gap, &[edit("slot_5.health", 1)]).is_err());
        let output = apply(schemas, id, &input, &[edit("slot_1.health", 1)]).unwrap();
        let unused = base + 0x380 + 3 * 0x280;
        assert_eq!(
            output[unused..unused + 0x280],
            input[unused..unused + 0x280]
        );
    }

    #[test]
    fn limits_are_enforced_and_damage_is_rejected() {
        let id = "silent-hill-usa-block-3";
        let input = fixture("SLUS-00707", 3);
        let base = 3 * BLOCK_SIZE;
        assert!(apply(schemas, id, &input, &[edit("slot_1.health", 7)]).is_err());
        assert!(apply(schemas, id, &input, &[edit("slot_1.saves", 1000)]).is_err());
        // Zero saves is valid: the slot stays listed through the untouched total at preview +0x0.
        let zero = apply(schemas, id, &input, &[edit("slot_2.saves", 0)]).unwrap();
        assert_eq!(
            &zero[base + 0x210..base + 0x214],
            &input[base + 0x210..base + 0x214]
        );
        assert_eq!(&zero[base + 0x218..base + 0x21a], &[0, 0]);
        assert!(apply(schemas, id, &input, &[edit("slot_1.saves", 999)]).is_ok());
        assert!(apply(schemas, id, &input, &[edit("slot_1.continues", 100)]).is_err());
        for offset in [
            0x2fc,
            0x2fd,
            0x205,
            0x380 + 0x27c,
            0x380 + 0x27d,
            0x380 + 0x10,
            0x600 + 0x27b,
        ] {
            let mut damaged = input.clone();
            damaged[base + offset] ^= 1;
            assert!(
                apply(schemas, id, &damaged, &[]).is_err(),
                "accepted damage at {offset:x}"
            );
        }
        // The unused slot and the options section are outside the verified ranges.
        for offset in [0x380 + 3 * 0x280 + 5, 0x300 + 5] {
            let mut tolerated = input.clone();
            tolerated[base + offset] ^= 1;
            assert!(
                apply(schemas, id, &tolerated, &[]).is_ok(),
                "rejected {offset:x}"
            );
        }
        assert!(apply(schemas, id, &fixture("SLES-01514", 3), &[]).is_err());
    }
}
