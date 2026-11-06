use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::Check;

// The parity checksum MUST follow the pinned PS1 layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/final-fantasy-tactics/saveEditor
const CHECKSUM_OFFSET: usize = 0x118;
const CHECKSUM_WIDTH: usize = 8;
const CHUNK_SIZE: usize = 0x80;
const CHUNKS: usize = 0x3c;
/// Bits of the last checksum byte that a chunk parity covers (60 chunks leave the low 4 unused).
const COVERED_MASK: u8 = 0xf0;
const RELEASES: [(&str, &str); 2] = [("usa", "SCUS-94221"), ("japan", "SLPS-00770")];

/// One parity bit per 128-byte chunk, most significant bit first, over the first 60 chunks with
/// the stored checksum read as zero. The four unused bits stay set.
fn checksum(block: &[u8]) -> [u8; CHECKSUM_WIDTH] {
    let mut result = [0xff; CHECKSUM_WIDTH];
    for chunk in 0..CHUNKS {
        let start = chunk * CHUNK_SIZE;
        let ones: u32 = block[start..start + CHUNK_SIZE]
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                if (CHECKSUM_OFFSET..CHECKSUM_OFFSET + CHECKSUM_WIDTH).contains(&(start + index)) {
                    0
                } else {
                    byte.count_ones()
                }
            })
            .sum();
        let mask = 0x80u8 >> (chunk % 8);
        if ones & 1 == 1 {
            result[chunk / 8] |= mask;
        } else {
            result[chunk / 8] &= !mask;
        }
    }
    result
}

fn integrity(game: &mut GameDefinition, base: usize) {
    let check = Check {
        when: None,
        assert: rules::Condition::new(move |bytes| {
            let stored = &bytes[base + CHECKSUM_OFFSET..base + CHECKSUM_OFFSET + CHECKSUM_WIDTH];
            let expected = checksum(&bytes[base..base + BLOCK_SIZE]);
            // No chunk covers the low nibble of the last byte, so it is not validated.
            Ok(
                stored[..CHECKSUM_WIDTH - 1] == expected[..CHECKSUM_WIDTH - 1]
                    && stored[CHECKSUM_WIDTH - 1] & COVERED_MASK
                        == expected[CHECKSUM_WIDTH - 1] & COVERED_MASK,
            )
        }),
        code: "final_fantasy_tactics_checksum".into(),
        message: "selected Final Fantasy Tactics block checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    playstation_card::register_check(game, check);
    // The 64-bit checksum is written as two independent little-endian words.
    for index in 0..2 {
        playstation_card::store_checksum(
            game,
            base + CHECKSUM_OFFSET + index * 4,
            Storage::U32Le,
            None,
            move |bytes| {
                let value = checksum(&bytes[base..base + BLOCK_SIZE]);
                let word = &value[index * 4..index * 4 + 4];
                i64::from(u32::from_le_bytes(word.try_into().unwrap()))
            },
        );
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product) in RELEASES {
            let fields = vec![
                catalog_field("war_funds", "War funds", base + 0x1934, Storage::U32Le)
                    .min(0)
                    .max(99_999_999),
                catalog_field(
                    "playtime_seconds",
                    "Playtime in seconds",
                    base + 0x120,
                    Storage::U32Le,
                )
                .min(0)
                .max(999 * 3600 + 3599),
            ];
            let mut game = playstation_card::definition(
                "final-fantasy-tactics",
                "Final Fantasy Tactics",
                region,
                product,
                block,
                1,
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

    const FIXTURE_CHECKSUM: [u8; 8] = [0x0d, 0xed, 0x0f, 0xdf, 0x1a, 0x93, 0x15, 0x0f];

    // A literal port of the upstream bit loop, deliberately structured differently from
    // `checksum` so the two implementations cannot share a mistake.
    fn reference(block: &[u8]) -> [u8; 8] {
        let mut data = block[..0x1e00].to_vec();
        data[0x118..0x120].fill(0);
        let mut buffer = [0xffu8; 8];
        let mut buffer_index = 0;
        let mut offset = 0;
        for i in 0..0x3c {
            let mut ones = 0;
            for j in 0..0x400 {
                if (data[offset] >> (7 - (j % 8))) & 1 != 0 {
                    ones += 1;
                }
                if (j + 1) % 8 == 0 {
                    offset += 1;
                }
            }
            let bit = 1u8 << (7 - (i % 8));
            buffer[buffer_index] &= !bit;
            if ones & 1 != 0 {
                buffer[buffer_index] |= bit;
            }
            if (i + 1) % 8 == 0 {
                buffer_index += 1;
            }
        }
        buffer
    }

    // Pattern bytes make every chunk parity depend on distinct data; the expected value below
    // was computed with an independent Python port of the upstream loop (FIXTURE_CHECKSUM).
    fn fixture(product: &str, block: usize) -> Vec<u8> {
        let mut bytes = playstation_card::fixture(product, block);
        let base = block * BLOCK_SIZE;
        for offset in 0x200..0x1e00 {
            bytes[base + offset] = ((offset as u32).wrapping_mul(2_654_435_761) >> 13) as u8;
        }
        let value = checksum(&bytes[base..base + BLOCK_SIZE]);
        bytes[base + CHECKSUM_OFFSET..base + CHECKSUM_OFFSET + 8].copy_from_slice(&value);
        bytes
    }

    #[test]
    fn checksum_matches_the_literal_upstream_port() {
        assert_eq!(
            checksum(&[0; 0x2000]),
            [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0f]
        );
        assert_eq!(checksum(&[0xff; 0x2000]), reference(&[0xff; 0x2000]));
        assert_eq!(checksum(&[0; 0x2000]), reference(&[0; 0x2000]));
        let block = &fixture("SCUS-94221", 1)[BLOCK_SIZE..2 * BLOCK_SIZE];
        assert_eq!(checksum(block), reference(block));
        assert_eq!(&block[0x118..0x120], &FIXTURE_CHECKSUM);
    }

    #[test]
    fn edits_repair_the_checksum_and_preserve_everything_else() {
        for (region, product) in RELEASES {
            let id = format!("final-fantasy-tactics-{region}-block-4");
            let input = fixture(product, 4);
            let base = 4 * BLOCK_SIZE;
            let edits = [
                edit("war_funds", 99_999_999),
                edit("playtime_seconds", 3_599_999),
            ];
            let output = apply(schemas, &id, &input, &edits).unwrap();
            assert_eq!(
                &output[base + 0x1934..base + 0x1938],
                &99_999_999u32.to_le_bytes()
            );
            assert_eq!(
                &output[base + 0x120..base + 0x124],
                &3_599_999u32.to_le_bytes()
            );
            assert_eq!(
                &output[base + 0x118..base + 0x120],
                &reference(&output[base..base + BLOCK_SIZE])
            );
            let changed = [0x118..0x124, 0x1934..0x1938];
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
    fn unused_checksum_bits_are_ignored_on_input_and_written_set() {
        let id = "final-fantasy-tactics-usa-block-4";
        let base = 4 * BLOCK_SIZE;
        let mut input = fixture("SCUS-94221", 4);
        // Saves from other tools may clear the four bits that no chunk covers.
        input[base + 0x11f] &= 0xf0;
        assert_eq!(input[base + 0x11f] & 0x0f, 0);
        assert!(apply(schemas, id, &input, &[]).is_ok());
        let edits = [edit("war_funds", 1234)];
        let output = apply(schemas, id, &input, &edits).unwrap();
        // As upstream does, an edit writes the unused bits set.
        assert_eq!(output[base + 0x11f] & 0x0f, 0x0f);
        assert_eq!(
            &output[base + 0x118..base + 0x120],
            &reference(&output[base..base + BLOCK_SIZE])
        );
    }

    #[test]
    fn limits_are_enforced_and_damage_is_rejected() {
        let id = "final-fantasy-tactics-usa-block-4";
        let input = fixture("SCUS-94221", 4);
        assert!(apply(schemas, id, &input, &[edit("war_funds", 100_000_000)]).is_err());
        assert!(apply(schemas, id, &input, &[edit("playtime_seconds", 3_600_000)]).is_err());
        let base = 4 * BLOCK_SIZE;
        for offset in [0x118, 0x11e, 0x120, 0x1934, 0x1dff] {
            let mut damaged = input.clone();
            damaged[base + offset] ^= 1;
            assert!(
                apply(schemas, id, &damaged, &[]).is_err(),
                "accepted damage at {offset:x}"
            );
        }
        // The high nibble of the last checksum byte is covered by chunks 56 to 59.
        let mut high = input.clone();
        high[base + 0x11f] ^= 0x10;
        assert!(apply(schemas, id, &high, &[]).is_err());
        // Bytes after the 60 checksummed chunks are outside the game's checksum.
        let mut tail = input.clone();
        tail[base + 0x1e00] ^= 1;
        assert!(apply(schemas, id, &tail, &[]).is_ok());
        assert!(apply(schemas, id, &fixture("SLPS-00770", 4), &[]).is_err());
    }
}
