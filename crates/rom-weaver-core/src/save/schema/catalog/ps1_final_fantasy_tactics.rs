use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::{Check, ReadValue, Scalar, Store};
use tracing::trace;

// The parity checksum MUST follow the pinned PS1 layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/final-fantasy-tactics/saveEditor
const CHECKSUM_OFFSET: usize = 0x118;
const CHECKSUM_WIDTH: usize = 8;
const CHUNK_SIZE: usize = 0x80;
const CHUNKS: usize = 0x3c;

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
            Ok(
                bytes[base + CHECKSUM_OFFSET..base + CHECKSUM_OFFSET + CHECKSUM_WIDTH]
                    == checksum(&bytes[base..base + BLOCK_SIZE]),
            )
        }),
        code: "final_fantasy_tactics_checksum".into(),
        message: "selected Final Fantasy Tactics block checksum is invalid".into(),
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
    // The 64-bit checksum is written as two independent little-endian words.
    for (index, storage) in [Storage::U32Le, Storage::U32Le].into_iter().enumerate() {
        game.runtime.after_edit.push(Store {
            when: None,
            destination: Scalar {
                offset: base + CHECKSUM_OFFSET + index * 4,
                storage,
                mask: None,
            },
            value: ReadValue::new(move |bytes| {
                let value = checksum(&bytes[base..base + BLOCK_SIZE]);
                trace!(
                    base,
                    word = index,
                    "recomputed Final Fantasy Tactics checksum"
                );
                let word = &value[index * 4..index * 4 + 4];
                Ok(i64::from(u32::from_le_bytes(word.try_into().unwrap())))
            }),
        });
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product) in [("usa", "SCUS-94221"), ("japan", "SLPS-00770")] {
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
    use super::*;

    const FIXTURE_CHECKSUM: [u8; 8] = [0x0d, 0xed, 0x0f, 0xdf, 0x1a, 0x93, 0x15, 0x0f];

    fn handler(id: &str) -> SchemaSaveHandler {
        schemas()
            .into_iter()
            .find(|handler| handler.definitions()[0].identity.id == id)
            .unwrap()
    }

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

    fn apply(id: &str, bytes: &[u8], edits: &[SaveEdit]) -> crate::Result<Vec<u8>> {
        let handler = handler(id);
        let identity = handler.definitions()[0].identity.clone();
        handler
            .apply(
                &SaveDetectionInput {
                    bytes: bytes.to_vec(),
                    selected_game: Some(id.into()),
                    rom_sha1: None,
                },
                &identity,
                edits,
                false,
            )
            .map(|result| result.bytes.unwrap_or_else(|| bytes.to_vec()))
    }

    fn edit(field: &str, value: u32) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value: SaveValue::U32(value),
        }
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
        for (region, product) in [("usa", "SCUS-94221"), ("japan", "SLPS-00770")] {
            let id = format!("final-fantasy-tactics-{region}-block-4");
            let input = fixture(product, 4);
            let base = 4 * BLOCK_SIZE;
            let edits = [
                edit("war_funds", 99_999_999),
                edit("playtime_seconds", 3_599_999),
            ];
            let output = apply(&id, &input, &edits).unwrap();
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
            assert_eq!(apply(&id, &output, &edits).unwrap(), output);
        }
    }

    #[test]
    fn limits_are_enforced_and_damage_is_rejected() {
        let id = "final-fantasy-tactics-usa-block-4";
        let input = fixture("SCUS-94221", 4);
        assert!(apply(id, &input, &[edit("war_funds", 100_000_000)]).is_err());
        assert!(apply(id, &input, &[edit("playtime_seconds", 3_600_000)]).is_err());
        let base = 4 * BLOCK_SIZE;
        for offset in [0x118, 0x11f, 0x120, 0x1934, 0x1dff] {
            let mut damaged = input.clone();
            damaged[base + offset] ^= 1;
            assert!(
                apply(id, &damaged, &[]).is_err(),
                "accepted damage at {offset:x}"
            );
        }
        // Bytes after the 60 checksummed chunks are outside the game's checksum.
        let mut tail = input.clone();
        tail[base + 0x1e00] ^= 1;
        assert!(apply(id, &tail, &[]).is_ok());
        assert!(apply(id, &fixture("SLPS-00770", 4), &[]).is_err());
    }
}
