use std::{fs, path::Path};

use rom_weaver_core::{PatchCreateRequest, PatchHandler};

use super::{PatchBasis, decide_basis, probe_patch_basis};
use crate::{
    IPS,
    ips::IpsPatchHandler,
    test_support::{TestDir, test_context_with_threads},
};

const HEADER_LEN: usize = 512;
const BODY_LEN: usize = 0x8000;

/// Deterministic pseudo-random ROM body. Real ROM data has enough entropy that
/// a record edge rarely matches the byte under it by chance; a body of zeros or
/// a repeating pattern would make every rule fire on coincidence.
fn rom_body(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

/// A ROM carrying a zeroed copier header, the case the whole module exists for.
fn headered_rom(seed: u64) -> Vec<u8> {
    let mut rom = vec![0_u8; HEADER_LEN];
    rom.extend_from_slice(&rom_body(BODY_LEN, seed));
    rom
}

fn build_ips(records: &[(u32, Vec<u8>)], truncate: Option<u32>) -> Vec<u8> {
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
    if let Some(truncate) = truncate {
        patch.extend_from_slice(&truncate.to_be_bytes()[1..]);
    }
    patch
}

/// Write a ROM and a patch into `temp`, then score the two bases.
fn decide(
    temp: &TestDir,
    rom: &[u8],
    patch: &[u8],
    header_len: usize,
    header_is_copier_junk: bool,
) -> Option<PatchBasis> {
    let rom_path = temp.child("rom.sfc");
    let patch_path = temp.child("update.ips");
    fs::write(&rom_path, rom).expect("rom fixture");
    fs::write(&patch_path, patch).expect("patch fixture");
    probe_and_decide(&patch_path, &rom_path, header_len, header_is_copier_junk)
}

fn probe_and_decide(
    patch_path: &Path,
    rom_path: &Path,
    header_len: usize,
    header_is_copier_junk: bool,
) -> Option<PatchBasis> {
    let probe = probe_patch_basis(
        patch_path,
        rom_path,
        header_len as u64,
        header_is_copier_junk,
    )
    .expect("probe")
    .expect("patch is IPS and the header leaves a headerless candidate");
    decide_basis(&probe).basis()
}

#[test]
fn records_inside_the_copier_header_choose_the_headerless_basis() {
    // Copier headers are padding left by dumping hardware. A patch writing at
    // offset 0x10 was addressing ROM data, so its offsets skip the header.
    let temp = TestDir::new();
    let patch = build_ips(
        &[
            (0x10, vec![0xAA; 8]),
            (0x2000, vec![0xBB; 8]),
            (0x4000, vec![0xCC; 8]),
        ],
        None,
    );
    assert_eq!(
        decide(&temp, &headered_rom(1), &patch, HEADER_LEN, true),
        Some(PatchBasis::Headerless)
    );
}

#[test]
fn format_headers_do_not_trigger_the_header_write_rule() {
    // An iNES header is ROM data an author may legitimately edit, so a write
    // inside it proves nothing. With no other rule firing this stays undecided
    // rather than guessing.
    let temp = TestDir::new();
    let patch = build_ips(
        &[
            (0x04, vec![0xAA; 8]),
            (0x2000, vec![0xBB; 8]),
            (0x4000, vec![0xCC; 8]),
        ],
        None,
    );
    assert_eq!(decide(&temp, &headered_rom(2), &patch, 16, false), None);
}

#[test]
fn records_past_the_headerless_end_choose_the_raw_basis() {
    // The headerless candidate is shorter by the header, so only it can leave a
    // record starting past the end - bytes no patcher would leave unwritten.
    let temp = TestDir::new();
    let rom = headered_rom(3);
    let past_headerless_end = u32::try_from(BODY_LEN + 0x100).expect("offset fits");
    let patch = build_ips(&[(past_headerless_end, vec![0xAA; 8])], None);
    assert_eq!(
        decide(&temp, &rom, &patch, HEADER_LEN, true),
        Some(PatchBasis::Raw)
    );
}

#[test]
fn untrimmed_record_edges_rule_out_the_basis_they_match() {
    // A differ trims unchanged bytes off both ends of every record, so at the
    // right basis a record's edge bytes always differ from the source. Here
    // every record's edges differ from the headerless bytes, and several match
    // the raw bytes - a pattern only the wrong basis produces.
    let temp = TestDir::new();
    let rom = headered_rom(6);
    let record_len = 8_usize;
    let mut records = Vec::new();
    let mut matched_on_raw = 0;
    for index in 0..12_u32 {
        // Stay clear of the copier header so the header-write rule cannot fire
        // first, and well inside both candidates so both edges are comparable.
        let offset = 0x1000 + index * 0x200;
        let at = offset as usize;
        let raw_first = rom[at];
        let headerless_first = rom[HEADER_LEN + at];
        let headerless_last = rom[HEADER_LEN + at + record_len - 1];
        let mut data = vec![0_u8; record_len];
        // Two records deliberately reproduce the raw byte under their first
        // edge; the rest simply differ from both.
        data[0] = if matched_on_raw < 2 && raw_first != headerless_first {
            matched_on_raw += 1;
            raw_first
        } else {
            headerless_first ^ 0xFF
        };
        data[record_len - 1] = headerless_last ^ 0xFF;
        records.push((offset, data));
    }
    assert_eq!(matched_on_raw, 2, "fixture must plant two raw-edge matches");
    let patch = build_ips(&records, None);
    assert_eq!(
        decide(&temp, &rom, &patch, HEADER_LEN, true),
        Some(PatchBasis::Headerless)
    );
}

#[test]
fn a_patch_created_against_headerless_bytes_is_recognised_as_headerless() {
    // The end-to-end shape: author a patch the way a hacker does - against the
    // headerless ROM - then hand the probe the headered dump a user actually
    // has.
    let temp = TestDir::new();
    let body = rom_body(BODY_LEN, 7);
    let mut modified = body.clone();
    for (index, offset) in [0x40_usize, 0x1800, 0x3000, 0x6000].iter().enumerate() {
        modified[*offset..*offset + 16].copy_from_slice(&[0xE0 | index as u8; 16]);
    }

    let original_path = temp.child("original.sfc");
    let modified_path = temp.child("modified.sfc");
    let patch_path = temp.child("update.ips");
    fs::write(&original_path, &body).expect("original fixture");
    fs::write(&modified_path, &modified).expect("modified fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
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

    let mut headered = vec![0_u8; HEADER_LEN];
    headered.extend_from_slice(&body);
    let rom_path = temp.child("dump.smc");
    fs::write(&rom_path, &headered).expect("dump fixture");

    assert_eq!(
        probe_and_decide(&patch_path, &rom_path, HEADER_LEN, true),
        Some(PatchBasis::Headerless)
    );
}

#[test]
fn a_patch_that_is_not_ips_is_not_probed() {
    let temp = TestDir::new();
    let rom_path = temp.child("rom.sfc");
    let patch_path = temp.child("update.bps");
    fs::write(&rom_path, headered_rom(8)).expect("rom fixture");
    fs::write(&patch_path, b"BPS1\0\0\0\0").expect("patch fixture");

    let probe = probe_patch_basis(&patch_path, &rom_path, HEADER_LEN as u64, true).expect("probe");
    assert!(probe.is_none());
}

#[test]
fn a_header_covering_the_whole_input_leaves_no_candidate() {
    let temp = TestDir::new();
    let rom_path = temp.child("rom.sfc");
    let patch_path = temp.child("update.ips");
    fs::write(&rom_path, vec![0_u8; HEADER_LEN]).expect("rom fixture");
    fs::write(&patch_path, build_ips(&[(0x10, vec![0xAA; 4])], None)).expect("patch fixture");

    let probe = probe_patch_basis(&patch_path, &rom_path, HEADER_LEN as u64, true).expect("probe");
    assert!(probe.is_none());
}

#[test]
fn overlapping_records_void_the_edge_rule() {
    // The edge rule only describes records a trimming differ produced, and such
    // a differ never writes one byte twice. The same fixture as above, with the
    // records packed close enough to overlap, must decide nothing.
    let temp = TestDir::new();
    let rom = headered_rom(6);
    let record_len = 8_usize;
    let mut records = Vec::new();
    let mut matched_on_raw = 0;
    for index in 0..12_u32 {
        // Half a record apart, so every record shares bytes with its neighbour.
        let offset = 0x1000 + index * 4;
        let at = offset as usize;
        let raw_first = rom[at];
        let headerless_first = rom[HEADER_LEN + at];
        let headerless_last = rom[HEADER_LEN + at + record_len - 1];
        let mut data = vec![0_u8; record_len];
        data[0] = if matched_on_raw < 2 && raw_first != headerless_first {
            matched_on_raw += 1;
            raw_first
        } else {
            headerless_first ^ 0xFF
        };
        data[record_len - 1] = headerless_last ^ 0xFF;
        records.push((offset, data));
    }
    assert_eq!(matched_on_raw, 2, "fixture must plant two raw-edge matches");
    let patch = build_ips(&records, None);
    assert_eq!(decide(&temp, &rom, &patch, HEADER_LEN, true), None);
}

#[test]
fn overlap_after_the_edge_sample_cap_still_voids_the_edge_rule() {
    let temp = TestDir::new();
    let rom = headered_rom(9);
    let mut records = Vec::with_capacity(4097);
    for index in 0..4096_u32 {
        records.push((0x1000 + index * 4, vec![0xAA]));
    }
    records.push((0x1000, vec![0xBB]));

    let patch = build_ips(&records, None);
    let rom_path = temp.child("rom.sfc");
    let patch_path = temp.child("update.ips");
    fs::write(&rom_path, &rom).expect("rom fixture");
    fs::write(&patch_path, patch).expect("patch fixture");
    let probe = probe_patch_basis(&patch_path, &rom_path, HEADER_LEN as u64, true)
        .expect("probe")
        .expect("patch is IPS and the header leaves a headerless candidate");
    assert!(probe.overlapping_records);
    assert!(decide_basis(&probe).basis().is_none());
}
