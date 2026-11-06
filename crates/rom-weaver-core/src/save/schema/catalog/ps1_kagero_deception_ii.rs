use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::{Check, Condition};

// The 0x7f-byte frame layout and per-frame checksum MUST follow the pinned PS1 layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/kagero-deception-ii/saveEditor
const PAYLOAD: usize = 0x200;
const FRAME_SIZE: usize = 0x80;
const FRAME_DATA: usize = 0x7f;
const FRAMES: usize = 60;

fn frame_checksum(frame: &[u8]) -> u8 {
    frame[..FRAME_DATA]
        .iter()
        .fold(0u8, |xor, value| xor ^ value)
        .wrapping_add(1)
}

/// Maps a concatenated data offset to its card offset; a field MUST NOT straddle two frames.
fn physical(base: usize, offset: usize, width: usize) -> usize {
    assert!(
        offset % FRAME_DATA + width <= FRAME_DATA,
        "Kagero field {offset:#x} crosses a frame boundary"
    );
    base + PAYLOAD + offset / FRAME_DATA * FRAME_SIZE + offset % FRAME_DATA
}

/// The Japanese release stores the same data at earlier offsets; upstream applies every shift
/// whose threshold the offset reaches.
fn japan_shift(offset: usize) -> usize {
    [
        (0xd, 0x3),
        (0x631, 0x38),
        (0x6fe, 0x4),
        (0x80d, 0xc),
        (0x86d, 0xc),
        (0x8cd, 0xc),
        (0x92d, 0xc),
        (0x98d, 0xc),
        (0x9ed, 0xc),
        (0xa4d, 0xc),
        (0xaad, 0xc),
        (0xb6d, 0x18),
    ]
    .into_iter()
    .filter(|(threshold, _)| offset >= *threshold)
    .fold(offset, |offset, (_, shift)| offset - shift)
}

fn integrity(game: &mut GameDefinition, base: usize) {
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| {
            Ok((0..FRAMES).all(|frame| {
                let start = base + PAYLOAD + frame * FRAME_SIZE;
                bytes[start + FRAME_DATA] == frame_checksum(&bytes[start..start + FRAME_SIZE])
            }))
        }),
        code: "kagero_frame_checksum".into(),
        message: "selected Kagero: Deception II block has an invalid frame checksum".into(),
        section_id: None,
        warning: None,
    };
    playstation_card::register_check(game, check);
    for frame in 0..FRAMES {
        let start = base + PAYLOAD + frame * FRAME_SIZE;
        playstation_card::store_checksum(
            game,
            start + FRAME_DATA,
            Storage::U8,
            None,
            move |bytes| i64::from(frame_checksum(&bytes[start..start + FRAME_SIZE])),
        );
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product, japan) in [
            ("europe", "SLES-01967", false),
            ("usa", "SLUS-00677", false),
            ("japan", "SLPS-01421", true),
        ] {
            let at = |offset: usize, width: usize| {
                physical(
                    base,
                    if japan { japan_shift(offset) } else { offset },
                    width,
                )
            };
            let mut fields = vec![
                catalog_field("clear_count", "Clear count", at(0x69, 1), Storage::U8)
                    .min(0)
                    .max(99),
                catalog_field(
                    "slain_enemies",
                    "Slain enemies",
                    at(0x691, 1),
                    Storage::U8,
                ),
                catalog_field("total_ark", "Total Ark", at(0x45, 4), Storage::U32Le)
                    .min(0)
                    .max(9_999_999),
                catalog_field("ark", "Ark", at(0x70d, 4), Storage::U32Le)
                    .min(0)
                    .max(9_999_999),
                catalog_field(
                    "playtime_frames",
                    "Playtime frames",
                    at(0x41, 4),
                    Storage::U32Le,
                )
                .min(0)
                .max(216_000 * 60 - 1)
                .description(
                    "The game counts 60 frames per second; the maximum is 59 hours 59 minutes 59 seconds.".into(),
                ),
            ];
            for ending in 0..4 {
                fields.push(
                    catalog_field(
                        &format!("ending_{}", ending + 1),
                        &format!("Ending {} unlocked", ending + 1),
                        at(0x49, 1),
                        Storage::Bit,
                    )
                    .bit(ending),
                );
            }
            let mut game = playstation_card::definition(
                "kagero-deception-ii",
                "Kagero: Deception II",
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
    use super::playstation_card::{apply, edit, flag};
    use super::*;

    // Frame 14 is all zero so a single edited byte can drive its xor to 0xff, where the stored
    // `xor + 1` wraps to zero.
    fn fixture(product: &str, block: usize) -> Vec<u8> {
        let mut bytes = playstation_card::fixture(product, block);
        let base = block * BLOCK_SIZE;
        for frame in 0..FRAMES {
            let start = base + PAYLOAD + frame * FRAME_SIZE;
            for index in 0..FRAME_DATA {
                bytes[start + index] = if frame == 14 {
                    0
                } else {
                    ((frame * 31 + index * 7) % 251) as u8
                };
            }
            let checksum = frame_checksum(&bytes[start..start + FRAME_SIZE]);
            bytes[start + FRAME_DATA] = checksum;
        }
        bytes
    }

    // Expected shifted offsets and card offsets come from an independent Python port of the
    // upstream shift table and frame mapping.
    #[test]
    fn frame_mapping_and_japan_shifts_match_the_upstream_tables() {
        assert_eq!(physical(0, 0, 1), 0x200);
        assert_eq!(physical(0, 0x7e, 1), 0x27e);
        assert_eq!(physical(0, 0x7f, 1), 0x280);
        assert_eq!(physical(0, 0x70d, 4), 0x91b);
        for (offset, shifted) in [
            (0xc, 0xc),
            (0x41, 0x3e),
            (0x45, 0x42),
            (0x49, 0x46),
            (0x69, 0x66),
            (0x691, 0x656),
            (0x6fd, 0x6c2),
            (0x6fe, 0x6bf),
            (0x70d, 0x6ce),
            (0x80d, 0x7c2),
            (0xb6d, 0xab6),
            (0xc00, 0xb49),
        ] {
            assert_eq!(japan_shift(offset), shifted, "{offset:#x}");
        }
        assert_eq!(frame_checksum(&[0; 0x80]), 1);
        assert_eq!(frame_checksum(&[0xff; 0x80]), 0);
        let mut frame = [0; 0x80];
        frame[0] = 0xff;
        assert_eq!(frame_checksum(&frame), 0);
    }

    #[test]
    fn edits_repair_every_frame_checksum_and_preserve_the_rest() {
        // (region, product, [clear, slain, total ark, ark, playtime, endings] card offsets)
        for (region, product, offsets) in [
            (
                "europe",
                "SLES-01967",
                [0x269, 0x89e, 0x245, 0x91b, 0x241, 0x249],
            ),
            (
                "usa",
                "SLUS-00677",
                [0x269, 0x89e, 0x245, 0x91b, 0x241, 0x249],
            ),
            (
                "japan",
                "SLPS-01421",
                [0x266, 0x862, 0x242, 0x8db, 0x23e, 0x246],
            ),
        ] {
            let id = format!("kagero-deception-ii-{region}-block-6");
            let input = fixture(product, 6);
            let base = 6 * BLOCK_SIZE;
            let edits = [
                edit("clear_count", 99),
                edit("slain_enemies", 200),
                edit("total_ark", 9_999_999),
                edit("ark", 1_234_567),
                edit("playtime_frames", 216_000 * 60 - 1),
                flag("ending_1", true),
                flag("ending_4", true),
                flag("ending_2", false),
            ];
            let output = apply(schemas, &id, &input, &edits).unwrap();
            assert_eq!(output[base + offsets[0]], 99);
            assert_eq!(output[base + offsets[1]], 200);
            assert_eq!(
                &output[base + offsets[2]..base + offsets[2] + 4],
                &9_999_999u32.to_le_bytes()
            );
            assert_eq!(
                &output[base + offsets[3]..base + offsets[3] + 4],
                &1_234_567u32.to_le_bytes()
            );
            assert_eq!(
                &output[base + offsets[4]..base + offsets[4] + 4],
                &(216_000u32 * 60 - 1).to_le_bytes()
            );
            assert_eq!(
                output[base + offsets[5]] & 0xf,
                (input[base + offsets[5]] & 0xf & !0b10) | 0b1001
            );
            for frame in 0..FRAMES {
                let start = base + 0x200 + frame * 0x80;
                let mut xor = 0u8;
                for value in &output[start..start + 0x7f] {
                    xor ^= value;
                }
                assert_eq!(
                    output[start + 0x7f],
                    xor.wrapping_add(1),
                    "{id} frame {frame}"
                );
            }
            let edited = [
                offsets[0]..offsets[0] + 1,
                offsets[1]..offsets[1] + 1,
                offsets[2]..offsets[2] + 4,
                offsets[3]..offsets[3] + 4,
                offsets[4]..offsets[4] + 4,
                offsets[5]..offsets[5] + 1,
            ];
            for (index, (&after, &before)) in output.iter().zip(&input).enumerate() {
                let relative = index.wrapping_sub(base);
                let frame_checksum_byte = (0x200..0x200 + FRAMES * 0x80).contains(&relative)
                    && (relative - 0x200) % 0x80 == 0x7f;
                if !edited.iter().any(|range| range.contains(&relative)) && !frame_checksum_byte {
                    assert_eq!(after, before, "{id} at {index:x}");
                }
            }
            assert_eq!(apply(schemas, &id, &output, &edits).unwrap(), output);
        }
    }

    #[test]
    fn frame_checksum_wraps_when_the_data_xor_is_0xff() {
        let id = "kagero-deception-ii-usa-block-6";
        let input = fixture("SLUS-00677", 6);
        let base = 6 * BLOCK_SIZE;
        let frame = base + 0x200 + 14 * 0x80;
        assert_eq!(input[frame + 0x7f], 1);
        let output = apply(schemas, id, &input, &[edit("ark", 0xff)]).unwrap();
        assert_eq!(output[frame + 0x1b], 0xff);
        assert_eq!(output[frame + 0x7f], 0);
        let back = apply(schemas, id, &output, &[edit("ark", 0)]).unwrap();
        assert_eq!(back, input);
    }

    #[test]
    fn limits_are_enforced_and_damage_is_rejected() {
        let id = "kagero-deception-ii-usa-block-6";
        let input = fixture("SLUS-00677", 6);
        let base = 6 * BLOCK_SIZE;
        assert!(apply(schemas, id, &input, &[edit("clear_count", 100)]).is_err());
        assert!(apply(schemas, id, &input, &[edit("total_ark", 10_000_000)]).is_err());
        assert!(apply(schemas, id, &input, &[edit("ark", 10_000_000)]).is_err());
        assert!(
            apply(
                schemas,
                id,
                &input,
                &[edit("playtime_frames", 216_000 * 60)]
            )
            .is_err()
        );
        for frame in [0, 1, 14, 59] {
            let checksum = base + 0x200 + frame * 0x80 + 0x7f;
            let data = base + 0x200 + frame * 0x80 + 3;
            for offset in [checksum, data] {
                let mut damaged = input.clone();
                damaged[offset] ^= 1;
                assert!(
                    apply(schemas, id, &damaged, &[]).is_err(),
                    "accepted damage at {offset:x}"
                );
            }
        }
        // The icon header and the bytes past the last frame are outside the frame checksums.
        let mut header = input.clone();
        header[base + 0x100] ^= 1;
        assert!(apply(schemas, id, &header, &[]).is_ok());
        assert!(apply(schemas, id, &fixture("SLES-01967", 6), &[]).is_err());
    }
}
