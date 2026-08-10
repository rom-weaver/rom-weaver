use std::{env, fs};

use super::*;

const ORDERS: [N64ByteOrder; 3] = [
    N64ByteOrder::BigEndian,
    N64ByteOrder::LittleEndian,
    N64ByteOrder::ByteSwapped,
];

fn scratch_dir(label: &str) -> std::path::PathBuf {
    let dir = env::temp_dir().join(format!(
        "rom-weaver-n64-order-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A deterministic word-aligned body, distinct enough that a wrong word map
/// lands on a different byte.
fn rom_body(len: usize) -> Vec<u8> {
    let mut state = 0x9E37_79B9_u64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

#[test]
fn the_candidate_word_map_matches_a_real_rewrite() {
    // The probe never materializes a converted file: it reads the input through
    // this map instead. If the map and the rewrite ever disagree, every rule
    // reads the wrong bytes and the decision silently changes output bytes.
    let dir = scratch_dir("word-map");
    let body = rom_body(4096);
    for source in ORDERS {
        let input = dir.join(format!("input-{}.bin", source.id()));
        fs::write(&input, &body).expect("fixture");
        for target in ORDERS {
            let rewritten = dir.join(format!("rewritten-{}-{}.bin", source.id(), target.id()));
            CliApp::rewrite_n64_byte_order(&input, &rewritten, source, target).expect("rewrite");
            let expected = fs::read(&rewritten).expect("rewritten");
            let map = CliApp::n64_candidate_word_map(source, target);
            for (offset, byte) in expected.iter().enumerate() {
                let mapped = (offset & !3) + map[offset % 4];
                assert_eq!(
                    body[mapped],
                    *byte,
                    "{} -> {} at offset {offset}",
                    source.id(),
                    target.id()
                );
            }
        }
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn every_candidate_carries_its_own_magic() {
    // The magic rule compares the patched first word against this value, so each
    // candidate has to carry the magic of the order it names - not the order the
    // input happens to be in.
    for source in ORDERS {
        let candidates = CliApp::n64_order_candidates(source);
        assert_eq!(candidates[0].magic, N64_BIG_ENDIAN_MAGIC);
        assert_eq!(candidates[1].magic, N64_LITTLE_ENDIAN_MAGIC);
        assert_eq!(candidates[2].magic, N64_BYTE_SWAPPED_MAGIC);
        assert_eq!(candidates[0].label, "big-endian");
        assert_eq!(candidates[1].label, "little-endian");
        assert_eq!(candidates[2].label, "byte-swapped");
    }
}

#[test]
fn the_candidate_for_the_input_order_reads_the_input_unchanged() {
    // Keeping the current order has to be a no-op in the probe too, otherwise
    // the one candidate that needs no rewrite would be scored against shuffled
    // bytes.
    for source in ORDERS {
        assert_eq!(
            CliApp::n64_candidate_word_map(source, source),
            [0, 1, 2, 3],
            "{} maps onto itself",
            source.id()
        );
    }
}

#[test]
fn reading_a_magic_through_the_word_map_yields_the_candidate_magic() {
    // The whole point of the map: a valid ROM's first word, read through the map
    // of any candidate, spells that candidate's magic. This is what makes an
    // unwritten byte of the first word usable in the magic rule.
    for source in ORDERS {
        let input_magic = match source {
            N64ByteOrder::BigEndian => N64_BIG_ENDIAN_MAGIC,
            N64ByteOrder::LittleEndian => N64_LITTLE_ENDIAN_MAGIC,
            N64ByteOrder::ByteSwapped => N64_BYTE_SWAPPED_MAGIC,
        };
        for candidate in CliApp::n64_order_candidates(source) {
            let read = candidate.word_map.map(|index| input_magic[index]);
            assert_eq!(
                read,
                candidate.magic,
                "{} -> {}",
                source.id(),
                candidate.label
            );
        }
    }
}
