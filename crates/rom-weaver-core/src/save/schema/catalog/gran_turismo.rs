use super::playstation_card::{self, BLOCK_SIZE};
use super::*;

// Fields and the checksum MUST follow this pinned game layout. The save spans five card blocks,
// which `playstation_card::definition` validates as one contiguous chain.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/gran-turismo/saveEditor
const BLOCKS: usize = 5;
const CHECKSUM: usize = 0x6da4;
const CHECKED: std::ops::Range<usize> = 0x200..CHECKSUM;

/// Two running sums over the checked range: a 16-bit add-then-xor sum and a 16-bit CRC-style
/// register whose reduction runs before the next message bit is merged in. The upstream editor
/// keeps both in wider integers, but only their low 16 bits reach the stored value.
fn sums(data: impl IntoIterator<Item = u8>) -> u32 {
    let mut sum = 0xaaaau16;
    let mut register = 0x3770u32;
    for byte in data {
        sum = sum.wrapping_add(u16::from(byte)) ^ (u16::from(byte) << 8);
        for bit in (0..8).rev() {
            register <<= 1;
            if register & 0x10000 != 0 {
                register ^= 0x11021;
            }
            register |= u32::from(byte >> bit) & 1;
        }
    }
    u32::from(sum) << 16 | (register & 0xffff)
}

fn checksum(bytes: &[u8]) -> u32 {
    sums(bytes[CHECKED].iter().copied())
}

fn fields(base: usize) -> Vec<FieldDefinition> {
    vec![
        catalog_field(
            "playtime_seconds",
            "Playtime seconds",
            base + 0x200,
            Storage::U32Le,
        )
        .max(999 * 3600 + 59 * 60 + 59),
        catalog_field("credits", "Credits", base + 0x204, Storage::U32Le)
            .max(2_000_000_000)
            .description("The Japanese release shows this value multiplied by 100.".into()),
        catalog_field("days", "Days", base + 0x208, Storage::U32Le).max(99_999),
    ]
}

/// `product` is the directory file name: the product code followed by the game's `GT\0`.
fn profile(region: &str, product: &'static str, first: usize) -> GameDefinition {
    let base = first * BLOCK_SIZE;
    let mut game = playstation_card::definition(
        "gran-turismo",
        "Gran Turismo",
        region,
        product,
        first,
        BLOCKS,
        fields(base),
    );
    playstation_card::integrity(
        &mut game,
        base,
        &playstation_card::Integrity {
            code: "gran_turismo_checksum",
            message: "selected Gran Turismo save checksum is invalid",
            storage: Storage::U32Le,
            offsets: &[CHECKSUM],
            span: BLOCKS * BLOCK_SIZE,
        },
        |_| true,
        checksum,
    );
    game
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for first in 1..=15 - (BLOCKS - 1) {
        for (region, product) in [
            ("europe", "SCES-00984GT\0"),
            ("usa", "SCUS-94194GT\0"),
            ("japan", "SCPS-10045GT\0"),
        ] {
            games.push(profile(region, product, first));
        }
    }
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::super::playstation_card::CARD_SIZE;
    use super::super::ps1_action_support::*;
    use super::*;

    const FIRST: usize = 4;
    const BASE: usize = FIRST * BLOCK_SIZE;
    const PRODUCT: &str = "SCUS-94194GT\0";

    /// The upstream arithmetic with JavaScript's signed 32-bit bitwise semantics.
    fn js_checksum(bytes: &[u8]) -> u32 {
        let mut first: i32 = 0xaaaa;
        let mut second: i32 = 0x3770;
        for byte in &bytes[BASE + 0x200..BASE + 0x6da4] {
            let mut int = i32::from(*byte);
            first = first.wrapping_add(int) ^ (int << 8);
            for _ in 0..8 {
                second <<= 1;
                if second & 0x10000 != 0 {
                    second ^= 0x11021;
                }
                second |= (int >> 7) & 1;
                int <<= 1;
            }
        }
        ((first << 16) | (second & 0xffff)) as u32
    }

    fn seal(bytes: &mut [u8]) {
        let value = js_checksum(bytes);
        bytes[BASE + 0x6da4..BASE + 0x6da8].copy_from_slice(&value.to_le_bytes());
    }

    fn card() -> Vec<u8> {
        let mut bytes = vec![0xa5; CARD_SIZE];
        bytes[..0x80].fill(0);
        bytes[..2].copy_from_slice(b"MC");
        bytes[0x7f] = b'M' ^ b'C';
        for block in 1..=15 {
            bytes[block * 0x80..block * 0x80 + 0x80].fill(0);
        }
        for block in FIRST..FIRST + BLOCKS {
            let offset = block * 0x80;
            let (mode, link) = match block {
                FIRST => (0x51, (block as u16).to_le_bytes()),
                _ if block == FIRST + BLOCKS - 1 => (0x53, [0xff, 0xff]),
                _ => (0x52, (block as u16).to_le_bytes()),
            };
            bytes[offset] = mode;
            bytes[offset + 8..offset + 10].copy_from_slice(&link);
            if block == FIRST {
                bytes[offset + 4..offset + 8]
                    .copy_from_slice(&((BLOCKS * BLOCK_SIZE) as u32).to_le_bytes());
                bytes[offset + 0xa..offset + 0xc].copy_from_slice(b"BA");
                bytes[offset + 0xc..offset + 0xc + PRODUCT.len()]
                    .copy_from_slice(PRODUCT.as_bytes());
            }
            bytes[offset + 0x7f] = bytes[offset..offset + 0x7f].iter().fold(0, |x, v| x ^ v);
        }
        bytes[BASE..BASE + BLOCKS * BLOCK_SIZE].fill(0x3c);
        bytes[BASE..BASE + 4].copy_from_slice(&[b'S', b'C', 0x11, BLOCKS as u8]);
        lcg_fill(&mut bytes[BASE + 0x200..BASE + 0x6da4], 0x6717);
        seal(&mut bytes);
        bytes
    }

    fn game() -> GameDefinition {
        profile("usa", PRODUCT, FIRST)
    }

    #[test]
    fn sums_match_vectors_from_the_javascript_semantics() {
        // Vectors from the upstream expressions run with 32-bit signed integers.
        for (data, expected) in [
            (&[][..], 0xaaaa_3770),
            (&[0x00], 0xaaaa_36b4),
            (&[0xff], 0x54a9_367f),
            (&[1, 2, 3], 0xaab0_5a4f),
            (b"123456789", 0x9d87_c09f),
        ] {
            assert_eq!(sums(data.iter().copied()), expected, "{data:x?}");
        }
        // 300 set bytes wrap the 16-bit sum several times.
        assert_eq!(sums([0xffu8; 300]), 0xa97e_f33f);
        let template = card();
        assert_eq!(
            checksum(&template[BASE..BASE + BLOCKS * BLOCK_SIZE]),
            js_checksum(&template)
        );
        for byte in [0, 0x1ff, 0x200, 0x6da3, 0x6da4] {
            let mut copy = template.clone();
            copy[BASE + byte] ^= 0xff;
            let changed = checksum(&copy[BASE..BASE + BLOCKS * BLOCK_SIZE]);
            assert_eq!(changed, js_checksum(&copy));
            let unchanged = changed == checksum(&template[BASE..BASE + BLOCKS * BLOCK_SIZE]);
            assert_eq!(unchanged, !CHECKED.contains(&byte), "{byte:x}");
        }
    }

    #[test]
    fn every_field_edits_only_itself_and_the_checksum() {
        let game = game();
        let template = card();
        let original = parse_fields(&game, &template);
        assert_eq!(original.len(), 3);
        let edits = edit_each_field(&game, &template);
        assert_eq!(edits.len(), 3);
        for edit in edits {
            assert!(
                edit.stray
                    .iter()
                    .all(|index| (BASE + 0x6da4..BASE + 0x6da8).contains(index)),
                "{}: {:x?}",
                edit.id,
                edit.stray
            );
            assert_only_changed(&edit, &original, &[]);
            let stored = &edit.after[BASE + 0x6da4..BASE + 0x6da8];
            assert_eq!(
                stored,
                js_checksum(&edit.after).to_le_bytes(),
                "{}",
                edit.id
            );
            assert_eq!(edit.after.len(), CARD_SIZE);
        }
    }

    #[test]
    fn spot_checks_use_the_documented_offsets() {
        let game = game();
        let edits = edit_each_field(&game, &card());
        let find = |id: &str| edits.iter().find(|edit| edit.id == id).unwrap();
        assert_eq!(
            find("playtime_seconds").after[BASE + 0x200..BASE + 0x204],
            3_599_999u32.to_le_bytes()
        );
        assert_eq!(
            find("credits").after[BASE + 0x204..BASE + 0x208],
            2_000_000_000u32.to_le_bytes()
        );
        assert_eq!(
            find("days").after[BASE + 0x208..BASE + 0x20c],
            99_999u32.to_le_bytes()
        );
    }

    #[test]
    fn edits_credits_of_a_five_block_card_and_reseals_the_checksum() {
        let game = game();
        let handler = handler(&game);
        let identity = handler.definitions().remove(0).identity;
        let template = card();
        assert_eq!(
            template[FIRST * 0x80 + 4..FIRST * 0x80 + 8],
            [0, 0xa0, 0, 0]
        );
        let result = handler
            .apply(
                &input(template.clone(), &identity.id),
                &identity,
                &[SaveEdit {
                    field: "credits".into(),
                    value: SaveValue::U32(1_234_567),
                }],
                false,
            )
            .unwrap();
        let after = result.bytes.expect("the edit changes the card");
        assert_eq!(after.len(), CARD_SIZE);
        assert_eq!(
            after[BASE + 0x204..BASE + 0x208],
            1_234_567u32.to_le_bytes()
        );
        assert_eq!(
            after[BASE + CHECKSUM..BASE + CHECKSUM + 4],
            js_checksum(&after).to_le_bytes()
        );
        assert_ne!(
            after[BASE + CHECKSUM..BASE + CHECKSUM + 4],
            template[BASE + CHECKSUM..BASE + CHECKSUM + 4]
        );
        let changed: Vec<usize> = (0..CARD_SIZE)
            .filter(|index| template[*index] != after[*index])
            .collect();
        assert!(
            changed
                .iter()
                .all(|index| (BASE + 0x204..BASE + 0x208).contains(index)
                    || (BASE + CHECKSUM..BASE + CHECKSUM + 4).contains(index)),
            "{changed:x?}"
        );
    }

    #[test]
    fn rejects_a_title_frame_block_count_other_than_the_file_size() {
        let game = game();
        let handler = handler(&game);
        let identity = handler.definitions().remove(0).identity;
        for count in [0, 1, 4, 6, 0xff] {
            let mut bytes = card();
            bytes[BASE + 3] = count;
            assert!(
                handler
                    .apply(&input(bytes, &identity.id), &identity, &[], false)
                    .is_err(),
                "accepted block count byte {count}"
            );
        }
    }

    #[test]
    fn rejects_out_of_range_values_damage_and_unsupported_chains() {
        let game = game();
        let handler = handler(&game);
        let identity = handler.definitions().remove(0).identity;
        let template = card();
        let source = input(template.clone(), &identity.id);
        for (field, value) in [
            ("playtime_seconds", 3_600_000),
            ("credits", 2_000_000_001),
            ("days", 100_000),
        ] {
            let edit = SaveEdit {
                field: field.into(),
                value: SaveValue::U32(value),
            };
            assert!(
                handler.apply(&source, &identity, &[edit], false).is_err(),
                "{field}"
            );
        }
        // Directory damage re-seals the frame's XOR so the mode, link, size, and product checks
        // each reject it on their own; a flipped XOR byte is the one case left to the XOR check.
        let damaged = |index: usize| {
            let mut bytes = template.clone();
            bytes[index] ^= 1;
            if index < 0x800 && index % 0x80 != 0x7f {
                let frame = index / 0x80 * 0x80;
                bytes[frame + 0x7f] = bytes[frame..frame + 0x7f].iter().fold(0, |x, v| x ^ v);
            }
            handler
                .apply(&input(bytes, &identity.id), &identity, &[], false)
                .is_err()
        };
        let dir = FIRST * 0x80;
        for index in [
            0,
            0x7f,
            dir,
            dir + 4 + 1,
            dir + 8,
            dir + 0xc,
            dir + 0x16,
            dir + 0x17,
            dir + 0x7f,
            dir + 0x80,
            dir + 0x80 + 8,
            dir + 0x100,
            dir + 0x100 + 8,
            dir + 0x180,
            dir + 0x180 + 8,
            dir + 0x200,
            dir + 0x200 + 8,
            dir + 0x200 + 0x7f,
            BASE,
            BASE + 0x200,
            BASE + 0x6da3,
            BASE + 0x6da4,
            BASE + 0x6da7,
        ] {
            assert!(damaged(index), "accepted damage at {index:x}");
        }
        // Bytes past the checksum are outside every rule, and so is the unused frame.
        assert!(!damaged(BASE + 0x6da8));
        assert!(!damaged(BASE + 0x7fff));
        // An unrelated file linking into the chain makes the directory ambiguous.
        let mut bytes = template;
        bytes[0x80] = 0x51;
        bytes[0x88..0x8a].copy_from_slice(&((FIRST + 1) as u16).to_le_bytes());
        bytes[0xff] = bytes[0x80..0xff].iter().fold(0, |x, v| x ^ v);
        assert!(
            handler
                .apply(&input(bytes, &identity.id), &identity, &[], false)
                .is_err()
        );
    }
}
