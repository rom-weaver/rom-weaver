use super::rules::{Condition, ReadValue, Scalar, Store};
use super::*;

// Header signature, field offsets, per-region shifts, and the checksum range:
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/pokemon-snap/saveEditor
// The four stored words are an MD4 state over big-endian words, with the usual padding and a
// little-endian bit length, as the upstream hash routine computes it.
const SIGNATURE_OFFSET: usize = 0x10;
const SIGNATURE: &[u8] = b"HAL_SNAP_V1";
const HASH_START: usize = 0x10;
const NEXT_COURSE_OFFSET: usize = 0x50;
const SCORES: [(&str, &str, usize); 7] = [
    ("beach", "Beach", 0x34),
    ("tunnel", "Tunnel", 0x38),
    ("volcano", "Volcano", 0x3c),
    ("river", "River", 0x40),
    ("cave", "Cave", 0x44),
    ("valley", "Valley", 0x48),
    ("rainbow_cloud", "Rainbow Cloud", 0x4c),
];

/// Regions that share one layout. The Japanese save is four bytes shorter before its option
/// block and ends its hashed range earlier.
struct Variant {
    id: &'static str,
    name: &'static str,
    end: usize,
    shift: usize,
}

const VARIANTS: [Variant; 2] = [
    Variant {
        id: "europe-usa-australia",
        name: "Europe/USA/Australia",
        end: 0x1f2a4,
        shift: 0,
    },
    Variant {
        id: "japan",
        name: "Japan",
        end: 0x1eb1c,
        shift: 4,
    },
];

fn md4_block(state: &mut [u32; 4], x: &[u32; 16]) {
    let [mut a, mut b, mut c, mut d] = *state;
    let choose = |x: u32, y: u32, z: u32| (x & y) | (!x & z);
    let majority = |x: u32, y: u32, z: u32| (x & (y | z)) | (y & z);
    for i in [0, 4, 8, 12] {
        a = a
            .wrapping_add(choose(b, c, d))
            .wrapping_add(x[i])
            .rotate_left(3);
        d = d
            .wrapping_add(choose(a, b, c))
            .wrapping_add(x[i + 1])
            .rotate_left(7);
        c = c
            .wrapping_add(choose(d, a, b))
            .wrapping_add(x[i + 2])
            .rotate_left(11);
        b = b
            .wrapping_add(choose(c, d, a))
            .wrapping_add(x[i + 3])
            .rotate_left(19);
    }
    for i in 0..4 {
        a = a
            .wrapping_add(majority(b, c, d))
            .wrapping_add(x[i])
            .wrapping_add(0x5a82_7999)
            .rotate_left(3);
        d = d
            .wrapping_add(majority(a, b, c))
            .wrapping_add(x[i + 4])
            .wrapping_add(0x5a82_7999)
            .rotate_left(5);
        c = c
            .wrapping_add(majority(d, a, b))
            .wrapping_add(x[i + 8])
            .wrapping_add(0x5a82_7999)
            .rotate_left(9);
        b = b
            .wrapping_add(majority(c, d, a))
            .wrapping_add(x[i + 12])
            .wrapping_add(0x5a82_7999)
            .rotate_left(13);
    }
    for i in [0, 2, 1, 3] {
        a = a
            .wrapping_add(b ^ c ^ d)
            .wrapping_add(x[i])
            .wrapping_add(0x6ed9_eba1)
            .rotate_left(3);
        d = d
            .wrapping_add(a ^ b ^ c)
            .wrapping_add(x[i + 8])
            .wrapping_add(0x6ed9_eba1)
            .rotate_left(9);
        c = c
            .wrapping_add(d ^ a ^ b)
            .wrapping_add(x[i + 4])
            .wrapping_add(0x6ed9_eba1)
            .rotate_left(11);
        b = b
            .wrapping_add(c ^ d ^ a)
            .wrapping_add(x[i + 12])
            .wrapping_add(0x6ed9_eba1)
            .rotate_left(15);
    }
    for (word, round) in state.iter_mut().zip([a, b, c, d]) {
        *word = word.wrapping_add(round);
    }
}

/// Hashes `data`, whose final partial block MUST be a whole number of words shorter than 56 bytes.
fn checksum(data: &[u8]) -> [u32; 4] {
    debug_assert!(data.len() % 64 < 56 && data.len().is_multiple_of(4));
    let mut state = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    let blocks = data.chunks_exact(64);
    let tail = blocks.remainder();
    for block in blocks {
        md4_block(&mut state, &read_words(block));
    }
    let mut last = read_words(tail);
    last[14] = (data.len() as u32).wrapping_mul(8).swap_bytes();
    last[tail.len() / 4] = 0x8000_0000;
    md4_block(&mut state, &last);
    trace!(length = data.len(), words = ?state, "computed Pokemon Snap checksum");
    state
}

fn read_words(bytes: &[u8]) -> [u32; 16] {
    let mut words = [0; 16];
    for (word, chunk) in words.iter_mut().zip(bytes.chunks_exact(4)) {
        *word = u32::from_be_bytes(chunk.try_into().expect("four bytes"));
    }
    words
}

fn valid(bytes: &[u8], end: usize) -> bool {
    checksum(&bytes[HASH_START..end])
        .iter()
        .zip(bytes.chunks_exact(4))
        .all(|(word, stored)| stored == word.to_be_bytes())
}

fn stores(end: usize) -> Vec<Store> {
    (0..4)
        .map(|word| Store {
            when: None,
            destination: Scalar {
                offset: word * 4,
                storage: Storage::U32Be,
                mask: None,
            },
            value: ReadValue::new(move |bytes| {
                Ok(i64::from(checksum(&bytes[HASH_START..end])[word]))
            }),
        })
        .collect()
}

fn fields(shift: usize) -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (id, label, offset) in SCORES {
        fields.push(
            catalog_field(
                &format!("scores.{id}"),
                &format!("{label} challenge score"),
                offset,
                Storage::U32Be,
            )
            .max(99_999_999),
        );
    }
    let course = Scalar {
        offset: 0x64 - shift,
        storage: Storage::U8,
        mask: Some(0xe0),
    };
    let mut unlocked = catalog_field(
        "unlocked_course",
        "Furthest unlocked course",
        course.offset,
        Storage::U8,
    )
    .mask(0xe0)
    .max(6)
    .choices(choices(&[
        ("Beach", 0),
        ("Tunnel", 1),
        ("Volcano", 2),
        ("River", 3),
        ("Cave", 4),
        ("Valley", 5),
        ("Rainbow Cloud", 6),
    ]));
    // The game keeps the same course number in a second word.
    unlocked.behavior.on_edit.push(Store {
        when: None,
        destination: Scalar {
            offset: NEXT_COURSE_OFFSET,
            storage: Storage::U32Be,
            mask: None,
        },
        value: ReadValue::new(move |bytes| course.read(bytes)),
    });
    fields.push(unlocked);
    for (id, label, mask, names) in [
        ("sound", "Sound", 0x40, ["Stereo", "Mono"]),
        ("z_button", "Z button setup", 0x04, ["Hold", "Switch"]),
        (
            "control_stick",
            "Control stick setup",
            0x02,
            ["Reverse", "Normal"],
        ),
    ] {
        fields.push(
            catalog_field(&format!("options.{id}"), label, 0x67 - shift, Storage::U8)
                .mask(mask)
                .choices(choices(&[(names[0], 0), (names[1], 1)])),
        );
    }
    for field in &mut fields {
        field.behavior.group = Some("file".into());
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = VARIANTS
        .iter()
        .map(|variant| {
            let end = variant.end;
            let candidate = layout::Candidate {
                spans: vec![layout::Span {
                    logical_offset: 0,
                    physical_offset: 0,
                    length: end,
                }],
                signatures: vec![layout::Signature {
                    offset: SIGNATURE_OFFSET,
                    bytes: SIGNATURE.to_vec(),
                }],
                predicates: vec![Condition::new(move |bytes| Ok(valid(bytes, end)))],
                ..Default::default()
            };
            GameDefinition {
                fields: fields(variant.shift),
                description: "Edits challenge scores, the unlocked-course progress, and control options in canonical 128 KiB FlashRAM, then recomputes the four-word header hash. Rejects a damaged hash or header; preserves every byte outside the hashed range. Photos, the player name, item and menu unlocks, and byte-swapped images are unsupported. Requires a game-made template.".into(),
                runtime: runtime::Runtime {
                    logical_size: Some(end),
                    layout: Some(layout::Layout {
                        groups: vec![layout::Group {
                            id: "file".into(),
                            logical_offset: 0,
                            logical_length: end,
                            copies: layout::Copies::Fixed {
                                candidates: vec![candidate],
                            },
                            selection: layout::Selection::FirstValid,
                            write: layout::WritePolicy::Selected,
                            empty: Vec::new(),
                            empty_if_no_signature: false,
                        }],
                    }),
                    after_edit: stores(end),
                    save_format: Some("n64_flashram_128k".into()),
                    ..Default::default()
                },
                ..GameDefinition::new(
                    format!("pokemon-snap-canonical-flashram-{}", variant.id),
                    format!("Pokémon Snap (canonical FlashRAM, {})", variant.name),
                    "nintendo-64".into(),
                    0x20000,
                )
            }
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // MD4 as RFC 1320 lays it out, with selectable word endianness and explicit padding.
    fn reference_md4(message: &[u8], big_endian: bool) -> [u32; 4] {
        let mut padded = message.to_vec();
        padded.push(0x80);
        while padded.len() % 64 != 56 {
            padded.push(0);
        }
        padded.extend_from_slice(&(message.len() as u64 * 8).to_le_bytes());
        let mut state = [0x6745_2301u32, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
        let rounds: [([usize; 16], [u32; 4], u32); 3] = [
            (core::array::from_fn(|i| i), [3, 7, 11, 19], 0),
            (
                [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15],
                [3, 5, 9, 13],
                0x5a82_7999,
            ),
            (
                [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15],
                [3, 9, 11, 15],
                0x6ed9_eba1,
            ),
        ];
        for block in padded.chunks(64) {
            let x: Vec<u32> = block
                .chunks(4)
                .map(|word| {
                    let word: [u8; 4] = word.try_into().unwrap();
                    if big_endian {
                        u32::from_be_bytes(word)
                    } else {
                        u32::from_le_bytes(word)
                    }
                })
                .collect();
            let [mut a, mut b, mut c, mut d] = state;
            for (round, (order, shifts, constant)) in rounds.iter().enumerate() {
                for (step, word) in order.iter().enumerate() {
                    let mix = match round {
                        0 => (b & c) | (!b & d),
                        1 => (b & c) | (b & d) | (c & d),
                        _ => b ^ c ^ d,
                    };
                    let next = a
                        .wrapping_add(mix)
                        .wrapping_add(x[*word])
                        .wrapping_add(*constant)
                        .rotate_left(shifts[step % 4]);
                    (a, b, c, d) = (d, next, b, c);
                }
            }
            for (word, value) in state.iter_mut().zip([a, b, c, d]) {
                *word = word.wrapping_add(value);
            }
        }
        state
    }

    fn hex(words: [u32; 4]) -> String {
        words
            .iter()
            .flat_map(|word| word.to_le_bytes())
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn noise(index: usize) -> u8 {
        (index * 31 + 17) as u8
    }

    fn repair(bytes: &mut [u8], end: usize) {
        let words = reference_md4(&bytes[HASH_START..end], true);
        for (index, word) in words.iter().enumerate() {
            bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
    }

    fn template(variant: usize) -> SaveDetectionInput {
        let mut bytes: Vec<u8> = (0..0x20000).map(noise).collect();
        bytes[SIGNATURE_OFFSET..SIGNATURE_OFFSET + SIGNATURE.len()].copy_from_slice(SIGNATURE);
        // A game-made save keeps the second course word equal to the packed course number.
        let course = u32::from(bytes[0x64 - VARIANTS[variant].shift] >> 5);
        bytes[NEXT_COURSE_OFFSET..NEXT_COURSE_OFFSET + 4].copy_from_slice(&course.to_be_bytes());
        repair(&mut bytes, VARIANTS[variant].end);
        SaveDetectionInput {
            bytes,
            selected_game: Some(format!(
                "pokemon-snap-canonical-flashram-{}",
                VARIANTS[variant].id
            )),
            rom_sha1: None,
        }
    }

    fn handler(variant: usize) -> (SchemaSaveHandler, SaveGameIdentity) {
        let handler = schemas().remove(variant);
        let identity = handler.definitions().remove(0).identity;
        (handler, identity)
    }

    fn run(
        variant: usize,
        input: &SaveDetectionInput,
        edits: &[(&str, SaveValue)],
    ) -> Result<Vec<u8>> {
        let (handler, identity) = handler(variant);
        let edits: Vec<_> = edits
            .iter()
            .map(|(field, value)| SaveEdit {
                field: (*field).into(),
                value: value.clone(),
            })
            .collect();
        handler
            .apply(input, &identity, &edits, false)
            .map(|result| result.bytes.unwrap_or_else(|| input.bytes.clone()))
    }

    #[test]
    fn reference_md4_matches_rfc_vectors() {
        for (message, digest) in [
            (&b""[..], "31d6cfe0d16ae931b73c59d7e0c089c0"),
            (b"abc", "a448017aaf21d8525fc10ae87aa6729d"),
            (b"message digest", "d9130a8164549fe818874806e1c7014b"),
            (
                b"12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                "e33b4ddc9c38f2199c3e7b164fcc0536",
            ),
        ] {
            assert_eq!(hex(reference_md4(message, false)), digest);
        }
    }

    #[test]
    fn checksum_matches_the_reference_for_every_tail_shape() {
        let data: Vec<u8> = (0..0x1f294).map(noise).collect();
        for length in [0, 4, 52, 64, 68, 116, 128, 0x1eb0c, 0x1f294] {
            assert_eq!(
                checksum(&data[..length]),
                reference_md4(&data[..length], true),
                "length {length}"
            );
        }
        for variant in VARIANTS {
            let length = variant.end - HASH_START;
            assert!(
                length % 64 < 56 && length.is_multiple_of(4),
                "{}",
                variant.id
            );
        }
    }

    #[test]
    fn edits_round_trip_and_keep_every_other_byte() {
        for (index, variant) in VARIANTS.iter().enumerate() {
            let (handler, identity) = handler(index);
            let input = template(index);
            let shift = variant.shift;
            let document = handler.parse(&input, &identity).unwrap();
            assert_eq!(document.fields.len(), 7 + 1 + 3);
            for (field, (id, _, offset)) in document.fields.iter().zip(SCORES) {
                assert_eq!(field.id, format!("scores.{id}"));
                for value in [0u32, 1, 99_999_999] {
                    let output = run(index, &input, &[(&field.id, SaveValue::U32(value))]).unwrap();
                    let mut expected = input.bytes.clone();
                    expected[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
                    repair(&mut expected, variant.end);
                    assert_eq!(output, expected, "{id} = {value}");
                }
                assert!(run(index, &input, &[(&field.id, SaveValue::U32(100_000_000))]).is_err());
            }
            for (course, name) in [
                "Beach",
                "Tunnel",
                "Volcano",
                "River",
                "Cave",
                "Valley",
                "Rainbow Cloud",
            ]
            .into_iter()
            .enumerate()
            {
                let output = run(
                    index,
                    &input,
                    &[("unlocked_course", SaveValue::Enum(name.into()))],
                )
                .unwrap();
                let mut expected = input.bytes.clone();
                expected[0x64 - shift] = (expected[0x64 - shift] & 0x1f) | (course as u8) << 5;
                expected[0x50..0x54].copy_from_slice(&(course as u32).to_be_bytes());
                repair(&mut expected, variant.end);
                assert_eq!(output, expected, "{name}");
                let reread = handler
                    .parse(
                        &SaveDetectionInput {
                            bytes: output,
                            ..input.clone()
                        },
                        &identity,
                    )
                    .unwrap();
                let field = reread
                    .fields
                    .iter()
                    .find(|f| f.id == "unlocked_course")
                    .unwrap();
                assert_eq!(field.value, SaveValue::Enum(name.into()));
            }
            assert!(
                run(
                    index,
                    &input,
                    &[("unlocked_course", SaveValue::Enum("raw:7".into()))]
                )
                .is_err()
            );
            for (id, bit, names) in [
                ("options.sound", 6, ["Stereo", "Mono"]),
                ("options.z_button", 2, ["Hold", "Switch"]),
                ("options.control_stick", 1, ["Reverse", "Normal"]),
            ] {
                for (value, name) in names.iter().enumerate() {
                    let output =
                        run(index, &input, &[(id, SaveValue::Enum((*name).into()))]).unwrap();
                    let mut expected = input.bytes.clone();
                    expected[0x67 - shift] =
                        (expected[0x67 - shift] & !(1 << bit)) | (value as u8) << bit;
                    repair(&mut expected, variant.end);
                    assert_eq!(output, expected, "{id} = {name}");
                }
            }
        }
    }

    #[test]
    fn hashed_range_is_region_specific_and_the_tail_is_preserved() {
        let japan_only = 0x1ed00;
        let mut input = template(1);
        input.bytes[japan_only] ^= 0xff;
        // Past the Japanese range end, the byte is outside the hash and survives an edit.
        let output = run(1, &input, &[("scores.beach", SaveValue::U32(7))]).unwrap();
        assert_eq!(output[japan_only], input.bytes[japan_only]);
        assert_eq!(output[0x1eb1c..], input.bytes[0x1eb1c..]);
        // The same flip is inside the other region's range and breaks its hash.
        let mut other = template(0);
        other.bytes[japan_only] ^= 0xff;
        let (handler, identity) = handler(0);
        assert!(handler.apply(&other, &identity, &[], false).is_err());
    }

    #[test]
    fn rejects_damage_and_wrong_sizes() {
        for (index, variant) in VARIANTS.iter().enumerate() {
            let (handler, identity) = handler(index);
            let input = template(index);
            assert!(
                handler
                    .apply(&input, &identity, &[], false)
                    .unwrap()
                    .bytes
                    .is_none()
            );
            let end = variant.end;
            for position in [0, 15, 0x10, 0x1b, 0x60, 0x1000, end - 1] {
                let mut damaged = input.clone();
                damaged.bytes[position] ^= 0x01;
                assert!(
                    handler.apply(&damaged, &identity, &[], false).is_err(),
                    "byte {position:#x}"
                );
            }
            let mut unsigned = input.clone();
            unsigned.bytes[SIGNATURE_OFFSET + 3] = b'X';
            repair(&mut unsigned.bytes, end);
            assert!(handler.apply(&unsigned, &identity, &[], false).is_err());
            for bytes in [
                vec![0; 0x20000],
                vec![0xff; 0x20000],
                vec![0; 0x1ffff],
                vec![0; 0x20001],
            ] {
                let input = SaveDetectionInput {
                    bytes,
                    ..input.clone()
                };
                assert!(handler.apply(&input, &identity, &[], false).is_err());
            }
        }
    }
}
