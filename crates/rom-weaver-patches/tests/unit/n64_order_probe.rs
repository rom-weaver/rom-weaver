use std::{fs, path::Path};

use rom_weaver_core::{PatchCreateRequest, PatchHandler};

use super::{
    N64_ORDER_CANDIDATES, N64MagicEvidence, N64OrderCandidate, decide_n64_order, probe_n64_order,
};
use crate::{
    IPS,
    ips::IpsPatchHandler,
    test_support::{TestDir, test_context_with_threads},
};

const BIG_ENDIAN_MAGIC: [u8; 4] = [0x80, 0x37, 0x12, 0x40];
const LITTLE_ENDIAN_MAGIC: [u8; 4] = [0x40, 0x12, 0x37, 0x80];
const BYTE_SWAPPED_MAGIC: [u8; 4] = [0x37, 0x80, 0x40, 0x12];

const BODY_LEN: usize = 0x8000;

/// The three interleavings, as the within-word permutations the real rewrite
/// performs. Index 0 is big-endian, 1 little-endian, 2 byte-swapped, matching
/// the order the candidates are built in.
fn permute(order: usize, word: &mut [u8; 4]) {
    match order {
        0 => {}
        1 => word.reverse(),
        2 => {
            word.swap(0, 1);
            word.swap(2, 3);
        }
        _ => unreachable!("only three N64 byte orders exist"),
    }
}

fn magic(order: usize) -> [u8; 4] {
    match order {
        0 => BIG_ENDIAN_MAGIC,
        1 => LITTLE_ENDIAN_MAGIC,
        2 => BYTE_SWAPPED_MAGIC,
        _ => unreachable!("only three N64 byte orders exist"),
    }
}

fn label(order: usize) -> &'static str {
    match order {
        0 => "big-endian",
        1 => "little-endian",
        2 => "byte-swapped",
        _ => unreachable!("only three N64 byte orders exist"),
    }
}

/// Rewrite whole words from `source` order into `target` order, the same two
/// transforms the CLI's rewrite applies.
fn rewrite(bytes: &[u8], source: usize, target: usize) -> Vec<u8> {
    let mut rewritten = bytes.to_vec();
    for chunk in rewritten.chunks_exact_mut(4) {
        let mut word = [chunk[0], chunk[1], chunk[2], chunk[3]];
        permute(source, &mut word);
        permute(target, &mut word);
        chunk.copy_from_slice(&word);
    }
    rewritten
}

/// Build the candidate set the CLI would build for an input already in
/// `source` order.
fn candidates(source: usize) -> [N64OrderCandidate; N64_ORDER_CANDIDATES] {
    std::array::from_fn(|target| {
        let mut tags = [0_u8, 1, 2, 3];
        permute(source, &mut tags);
        permute(target, &mut tags);
        N64OrderCandidate {
            label: label(target),
            word_map: tags.map(usize::from),
            magic: magic(target),
        }
    })
}

/// A deterministic pseudo-random N64 ROM in big-endian order.
fn big_endian_rom(seed: u64) -> Vec<u8> {
    // Mix the seed before use: a bare `seed | 1` collides on consecutive seeds,
    // which would quietly hand two fixtures the same body.
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut rom = BIG_ENDIAN_MAGIC.to_vec();
    rom.extend((0..BODY_LEN - 4).map(|_| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 24) as u8
    }));
    rom
}

fn build_ips(records: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut patch = b"PATCH".to_vec();
    for (offset, data) in records {
        patch.extend_from_slice(&offset.to_be_bytes()[1..]);
        patch.extend_from_slice(
            &u16::try_from(data.len())
                .expect("record fits an IPS size field")
                .to_be_bytes(),
        );
        patch.extend_from_slice(data);
    }
    patch.extend_from_slice(b"EOF");
    patch
}

fn decide(temp: &TestDir, rom: &[u8], patch: &[u8], source: usize) -> Option<&'static str> {
    let rom_path = temp.child("rom.n64");
    let patch_path = temp.child("update.ips");
    fs::write(&rom_path, rom).expect("rom fixture");
    fs::write(&patch_path, patch).expect("patch fixture");
    decide_paths(&patch_path, &rom_path, source)
}

fn decide_paths(patch_path: &Path, rom_path: &Path, source: usize) -> Option<&'static str> {
    let probe = probe_n64_order(patch_path, rom_path, candidates(source))
        .expect("probe")
        .expect("patch is IPS and the input holds whole words");
    decide_n64_order(&probe)
        .candidate()
        .map(|index| probe.candidates[index].label)
}

// The word maps these tests build are checked against the real rewrite in the
// CLI's `patch_n64_order_decision` unit tests, which own the transform.

#[test]
fn a_record_writing_the_magic_names_its_own_order() {
    // The finished ROM has to start with the N64 magic, and each order spells it
    // differently, so a record covering offset 0 settles the question outright.
    let temp = TestDir::new();
    let rom = big_endian_rom(1);
    let patch = build_ips(&[(0, LITTLE_ENDIAN_MAGIC.to_vec())]);
    assert_eq!(decide(&temp, &rom, &patch, 0), Some("little-endian"));
}

#[test]
fn a_partial_first_word_write_is_completed_from_the_candidate_bytes() {
    // A record covering only part of the first word still decides: the bytes it
    // does not write come from the input, read through each candidate's map.
    let temp = TestDir::new();
    let rom = big_endian_rom(2);
    // The input is byte-swapped, so its first word already reads 37 80 40 12.
    // Rewriting the first two bytes to 0x80 0x37 leaves 80 37 40 12, which is a
    // valid magic only for the big-endian candidate.
    let swapped = rewrite(&rom, 0, 2);
    let patch = build_ips(&[(0, vec![0x80, 0x37])]);
    assert_eq!(decide(&temp, &swapped, &patch, 2), Some("big-endian"));
}

#[test]
fn a_first_word_that_is_no_magic_decides_nothing() {
    // A record that leaves a first word no order recognises proves nothing, and
    // with too few records to compare edges the probe stays quiet.
    let temp = TestDir::new();
    let rom = big_endian_rom(3);
    let patch = build_ips(&[(0, vec![0x11, 0x22, 0x33, 0x44])]);
    assert_eq!(decide(&temp, &rom, &patch, 0), None);
}

/// The first byte value that appears nowhere in `window`. Record edges built
/// from it cannot match any candidate's byte by accident.
fn byte_unlike(window: &[u8]) -> u8 {
    (0..=u8::MAX)
        .find(|byte| !window.contains(byte))
        .expect("a window this short cannot use every byte value")
}

#[test]
fn untrimmed_record_edges_rule_out_the_orders_they_match() {
    // Every record's edges differ from the byte-swapped bytes; several match
    // what the other two orders would put underneath them, which a trimming
    // differ never produces.
    const RECORD_LEN: usize = 8;
    let temp = TestDir::new();
    let swapped = rewrite(&big_endian_rom(4), 0, 2);
    let maps = candidates(2);
    let mut records = Vec::new();
    let mut planted = [0_usize; N64_ORDER_CANDIDATES];
    for index in 0..24_u32 {
        // Word-aligned, and clear of the first word so the magic rule cannot
        // fire first.
        let offset = 0x1000 + index * 0x40;
        let at = offset as usize;
        let window = &swapped[at..at + RECORD_LEN];
        // What each candidate would put under this record's first edge.
        let under = maps.map(|candidate| window[candidate.word_map[0]]);
        let mut data = vec![byte_unlike(window); RECORD_LEN];
        // Plant a first-edge match for each wrong order, twice over, while
        // keeping the byte-swapped edge different from all of them.
        for wrong in [0_usize, 1] {
            if planted[wrong] < 2 && under[wrong] != under[2] {
                planted[wrong] += 1;
                data[0] = under[wrong];
                break;
            }
        }
        records.push((offset, data));
    }
    assert_eq!(planted[0], 2, "fixture must plant two big-endian matches");
    assert_eq!(
        planted[1], 2,
        "fixture must plant two little-endian matches"
    );
    assert_eq!(
        decide(&temp, &swapped, &build_ips(&records), 2),
        Some("byte-swapped")
    );
}

#[test]
fn edges_that_fit_every_order_decide_nothing() {
    // With every record's edges differing from all three candidates, the edge
    // rule cannot separate them and the probe keeps quiet rather than guessing.
    const RECORD_LEN: usize = 8;
    let temp = TestDir::new();
    let rom = big_endian_rom(5);
    let mut records = Vec::new();
    for index in 0..24_u32 {
        let offset = 0x1000 + index * 0x40;
        let at = offset as usize;
        let data = vec![byte_unlike(&rom[at..at + RECORD_LEN]); RECORD_LEN];
        records.push((offset, data));
    }
    assert_eq!(decide(&temp, &rom, &build_ips(&records), 0), None);
}

#[test]
fn a_patch_created_against_another_order_is_recognised() {
    // The end-to-end shape: author the patch the way a hacker does - against the
    // big-endian ROM - then hand the probe the byte-swapped dump a user has.
    //
    // The big-endian records can never carry an untrimmed edge, because a differ
    // only ever emits bytes that changed. Ruling the other two orders out needs
    // edges that match what they would put underneath, so the fixture plants a
    // couple of each.
    const REGION_LEN: usize = 24;
    let temp = TestDir::new();
    let rom = big_endian_rom(6);
    let swapped = rewrite(&rom, 0, 2);
    let maps = candidates(2);
    let mut modified = rom.clone();
    let mut planted = [0_usize; N64_ORDER_CANDIDATES];
    for index in 0..16_usize {
        let at = 0x1000 + index * 0x400;
        let window = &rom[at..at + REGION_LEN];
        modified[at..at + REGION_LEN].fill(byte_unlike(window));
        for wrong in [1_usize, 2] {
            let under = swapped[at + maps[wrong].word_map[0]];
            if planted[wrong] < 2 && under != rom[at] {
                planted[wrong] += 1;
                modified[at] = under;
                break;
            }
        }
    }
    assert_eq!(
        planted[1], 2,
        "fixture must plant two little-endian matches"
    );
    assert_eq!(planted[2], 2, "fixture must plant two byte-swapped matches");

    let original_path = temp.child("original.z64");
    let modified_path = temp.child("modified.z64");
    let patch_path = temp.child("update.ips");
    fs::write(&original_path, &rom).expect("original fixture");
    fs::write(&modified_path, &modified).expect("modified fixture");
    IpsPatchHandler::new(&IPS)
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "ips".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let dump_path = temp.child("dump.v64");
    fs::write(&dump_path, &swapped).expect("dump fixture");
    assert_eq!(decide_paths(&patch_path, &dump_path, 2), Some("big-endian"));
}

#[test]
fn a_patch_that_is_not_ips_is_not_probed() {
    let temp = TestDir::new();
    let rom_path = temp.child("rom.z64");
    let patch_path = temp.child("update.bps");
    fs::write(&rom_path, big_endian_rom(7)).expect("rom fixture");
    fs::write(&patch_path, b"BPS1\0\0\0\0").expect("patch fixture");

    assert!(
        probe_n64_order(&patch_path, &rom_path, candidates(0))
            .expect("probe")
            .is_none()
    );
}

#[test]
fn an_input_that_is_not_whole_words_is_not_probed() {
    // A byte-order rewrite refuses a length that is not a multiple of four, so
    // no candidate could ever be produced for one.
    let temp = TestDir::new();
    let rom_path = temp.child("rom.z64");
    let patch_path = temp.child("update.ips");
    fs::write(&rom_path, &big_endian_rom(8)[..0x1001]).expect("rom fixture");
    fs::write(&patch_path, build_ips(&[(0x100, vec![0xAA; 4])])).expect("patch fixture");

    assert!(
        probe_n64_order(&patch_path, &rom_path, candidates(0))
            .expect("probe")
            .is_none()
    );
}

#[test]
fn records_writing_the_stored_checksums_are_counted() {
    // The CLI spends three speculative applies only when the patch rewrites the
    // stored boot checksums, so the count has to see a record that overlaps
    // 0x10..0x18 and ignore one that stops short of it.
    let temp = TestDir::new();
    let rom_path = temp.child("rom.z64");
    let patch_path = temp.child("update.ips");
    fs::write(&rom_path, big_endian_rom(9)).expect("rom fixture");
    fs::write(
        &patch_path,
        build_ips(&[(0x0C, vec![0xAA; 8]), (0x2000, vec![0xBB; 8])]),
    )
    .expect("patch fixture");
    let probe = probe_n64_order(&patch_path, &rom_path, candidates(0))
        .expect("probe")
        .expect("probe data");
    assert_eq!(probe.stored_checksum_writes, 1);

    fs::write(&patch_path, build_ips(&[(0x08, vec![0xAA; 8])])).expect("patch fixture");
    let probe = probe_n64_order(&patch_path, &rom_path, candidates(0))
        .expect("probe")
        .expect("probe data");
    assert_eq!(probe.stored_checksum_writes, 0);
}

#[test]
fn an_unwritten_first_word_leaves_the_magic_rule_silent() {
    let temp = TestDir::new();
    let rom_path = temp.child("rom.z64");
    let patch_path = temp.child("update.ips");
    fs::write(&rom_path, big_endian_rom(10)).expect("rom fixture");
    fs::write(&patch_path, build_ips(&[(0x2000, vec![0xAA; 8])])).expect("patch fixture");
    let probe = probe_n64_order(&patch_path, &rom_path, candidates(0))
        .expect("probe")
        .expect("probe data");
    assert!(
        probe
            .evidence
            .iter()
            .all(|evidence| evidence.magic == N64MagicEvidence::Unwritten)
    );
}
