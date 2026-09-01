//! Unit coverage for the PSP PBP container handler (`src/handlers/pbp.rs`).
//!
//! Every fixture is assembled in memory from the popstation layout the handler
//! parses, so the tests need no real PBP dump and stay hermetic. The default
//! disc carries two ISO blocks because `read_iso_size_from_index` reads the
//! sector count out of block 1.

use std::sync::atomic::AtomicUsize;

use flate2::{Compression as DeflateCompression, write::DeflateEncoder};
use rom_weaver_core::{ArchiveEntryKindFilter, CancellationToken, NoopProgressSink, ThreadBudget};

use super::*;

const SECTOR_BYTES: usize = 0x930;
const BLOCK_BYTES: usize = SECTOR_BYTES * 16;
const PSAR_INDEX_OFFSET: usize = 0x4000;
const PSAR_ISO_OFFSET: usize = 0x100000;
const INDEX_ENTRY_BYTES: usize = 0x20;
const PSAR_FILE_OFFSET: usize = 0x100;
const TOC_OFFSET: usize = 0x800;
const MULTI_DISC_KEYS: [u32; 4] = [0x2CC9_C5BC, 0x33B5_A90F, 0x06F6_B4B3, 0xB259_45BA];
const MULTI_DISC_KEY_OFFSET: usize = 24;
const MULTI_DISC_TABLE_OFFSET: usize = 0x200;
const MULTI_DISC_FIRST_DISC_OFFSET: usize = 0x800;

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir();
        for _ in 0..100 {
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = base.join(format!(
                "rom-weaver-pbp-{label}-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create temporary directory: {error}"),
            }
        }
        panic!("find a unique temporary directory");
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn encode_bcd(value: u8) -> u8 {
    ((value / 10) << 4) | (value % 10)
}

fn frames_to_msf(frames: u32) -> (u8, u8, u8) {
    (
        u8::try_from(frames / (60 * 75)).expect("minutes"),
        u8::try_from((frames / 75) % 60).expect("seconds"),
        u8::try_from(frames % 75).expect("frames"),
    )
}

fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn raw_deflate(payload: &[u8]) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::new(), DeflateCompression::new(6));
    encoder.write_all(payload).expect("deflate encode");
    encoder.finish().expect("deflate finish")
}

#[derive(Clone)]
struct DiscSpec {
    disc_id: String,
    /// `(track type byte, absolute start frame)` per track, in track order.
    tracks: Vec<(u8, u32)>,
    /// Stamped into block 1's size descriptor; drives `iso_size`.
    sector_count: u32,
    block_count: usize,
}

impl DiscSpec {
    /// 32 sectors is exactly two ISO blocks, the smallest disc the index-table
    /// validation accepts.
    fn single_track() -> Self {
        Self {
            disc_id: "SLUS01234".to_string(),
            tracks: vec![(0x41, 150)],
            sector_count: 32,
            block_count: 2,
        }
    }
}

fn default_stored_blocks(spec: &DiscSpec) -> Vec<Vec<u8>> {
    (0..spec.block_count)
        .map(|block_index| {
            let mut block = vec![0u8; BLOCK_BYTES];
            for (offset, byte) in block.iter_mut().enumerate() {
                *byte = u8::try_from((block_index * 7 + offset) % 251).expect("fixture byte");
            }
            if block_index == 1 {
                write_u32_le(&mut block, 104, spec.sector_count);
            }
            block
        })
        .collect()
}

fn write_toc(psar: &mut [u8], tracks: &[(u8, u32)], leadout_frames: u32) {
    let end_track = u8::try_from(tracks.len()).expect("track count");
    psar[TOC_OFFSET + 2] = 0xA0;
    psar[TOC_OFFSET + 7] = encode_bcd(1);
    psar[TOC_OFFSET + 12] = 0xA1;
    psar[TOC_OFFSET + 17] = encode_bcd(end_track);
    let (minutes, seconds, frames) = frames_to_msf(leadout_frames);
    psar[TOC_OFFSET + 22] = 0xA2;
    psar[TOC_OFFSET + 27] = encode_bcd(minutes);
    psar[TOC_OFFSET + 28] = encode_bcd(seconds);
    psar[TOC_OFFSET + 29] = encode_bcd(frames);
    for (index, (track_type, start_frames)) in tracks.iter().enumerate() {
        let entry = TOC_OFFSET + 30 + (index * 10);
        let (minutes, seconds, frames) = frames_to_msf(*start_frames);
        psar[entry] = *track_type;
        psar[entry + 2] = encode_bcd(u8::try_from(index + 1).expect("track number"));
        psar[entry + 3] = encode_bcd(minutes);
        psar[entry + 4] = encode_bcd(seconds);
        psar[entry + 5] = encode_bcd(frames);
    }
}

fn build_disc_psar_with_blocks(spec: &DiscSpec, stored_blocks: &[Vec<u8>]) -> Vec<u8> {
    let mut psar = vec![0u8; PSAR_ISO_OFFSET];
    psar[..12].copy_from_slice(b"PSISOIMG0000");
    let disc_id = spec.disc_id.as_bytes();
    psar[0x400] = b'_';
    psar[0x401..0x405].copy_from_slice(&disc_id[..4]);
    psar[0x405] = b'_';
    psar[0x406..0x40B].copy_from_slice(&disc_id[4..9]);
    write_toc(&mut psar, &spec.tracks, 150 + spec.sector_count);

    let mut payload = Vec::new();
    for (block_index, block) in stored_blocks.iter().enumerate() {
        let entry = PSAR_INDEX_OFFSET + (block_index * INDEX_ENTRY_BYTES);
        write_u32_le(
            &mut psar,
            entry,
            u32::try_from(payload.len()).expect("index offset"),
        );
        write_u32_le(
            &mut psar,
            entry + 4,
            u32::try_from(block.len()).expect("index length"),
        );
        payload.extend_from_slice(block);
    }
    psar.extend_from_slice(&payload);
    psar
}

fn build_disc_psar(spec: &DiscSpec) -> Vec<u8> {
    build_disc_psar_with_blocks(spec, &default_stored_blocks(spec))
}

fn wrap_psar_in_pbp(psar: &[u8]) -> Vec<u8> {
    let mut pbp = vec![0u8; PSAR_FILE_OFFSET + psar.len()];
    pbp[..4].copy_from_slice(&PBP_SIGNATURE);
    write_u32_le(&mut pbp, 4, 0x0001_0000);
    let psar_offset = u32::try_from(PSAR_FILE_OFFSET).expect("psar offset");
    for section in 0..8 {
        write_u32_le(&mut pbp, 8 + (section * 4), psar_offset);
    }
    pbp[PSAR_FILE_OFFSET..].copy_from_slice(psar);
    pbp
}

fn single_disc_pbp(spec: &DiscSpec) -> Vec<u8> {
    wrap_psar_in_pbp(&build_disc_psar(spec))
}

fn build_multi_disc_psar(discs: &[Vec<u8>]) -> Vec<u8> {
    let mut psar = vec![0u8; MULTI_DISC_TABLE_OFFSET + (5 * 4)];
    psar[..16].copy_from_slice(b"PSTITLEIMG000000");
    for (index, key) in MULTI_DISC_KEYS.iter().enumerate() {
        write_u32_le(&mut psar, MULTI_DISC_KEY_OFFSET + (index * 4), *key);
    }
    let mut cursor = MULTI_DISC_FIRST_DISC_OFFSET;
    for (index, disc) in discs.iter().enumerate() {
        if psar.len() < cursor {
            psar.resize(cursor, 0);
        }
        write_u32_le(
            &mut psar,
            MULTI_DISC_TABLE_OFFSET + (index * 4),
            u32::try_from(cursor).expect("disc offset"),
        );
        psar.extend_from_slice(disc);
        cursor = psar.len();
    }
    psar
}

fn write_fixture(temp: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
    let path = temp.join(name);
    fs::write(&path, bytes).expect("write pbp fixture");
    path
}

fn parse_error(temp: &TempDir, name: &str, bytes: &[u8]) -> String {
    let path = write_fixture(temp, name, bytes);
    PbpContainerHandler
        .parse_archive(&path)
        .expect_err("parse must reject this fixture")
        .to_string()
}

fn corrupt_psar_parse_error(temp: &TempDir, name: &str, corrupt: impl FnOnce(&mut [u8])) -> String {
    let mut psar = build_disc_psar(&DiscSpec::single_track());
    corrupt(&mut psar);
    parse_error(temp, name, &wrap_psar_in_pbp(&psar))
}

fn test_context(temp_root: &Path) -> OperationContext {
    OperationContext::new(
        ThreadBudget::Fixed(1),
        temp_root.to_path_buf(),
        Arc::new(NoopProgressSink),
        CancellationToken::new(),
    )
}

fn extract_request(source: &Path, out_dir: &Path) -> ContainerExtractRequest {
    ContainerExtractRequest {
        source: source.to_path_buf(),
        selections: Vec::new(),
        kind_filter: ArchiveEntryKindFilter::default(),
        out_dir: out_dir.to_path_buf(),
        split_bin: false,
        ignore_common_files: false,
        overwrite: true,
        parent: None,
        containing_archive: None,
    }
}

/// A file whose ISO payload area holds `payloads` back to back, plus the index
/// entries that address them. Used to drive `read_iso_block` directly with
/// shapes the index-table validation would otherwise reject.
fn block_payload_file(
    temp: &TempDir,
    name: &str,
    payloads: &[Vec<u8>],
) -> (PathBuf, Vec<PbpIsoIndexEntry>) {
    let mut data = vec![0u8; PSAR_ISO_OFFSET];
    let mut indexes = Vec::new();
    for payload in payloads {
        indexes.push(PbpIsoIndexEntry {
            offset: u64::try_from(data.len() - PSAR_ISO_OFFSET).expect("payload offset"),
            length: u64::try_from(payload.len()).expect("payload length"),
        });
        data.extend_from_slice(payload);
    }
    (write_fixture(temp, name, &data), indexes)
}

fn disc_entry(iso_size: u64, iso_indexes: Vec<PbpIsoIndexEntry>) -> PbpDiscEntry {
    PbpDiscEntry {
        disc_number: 1,
        disc_id: "SLUS01234".to_string(),
        psar_offset: 0,
        iso_size,
        toc_tracks: Vec::new(),
        iso_indexes,
    }
}

fn extract_task(block_count: usize, expected_len: u64) -> PbpDiscExtractTask {
    PbpDiscExtractTask {
        disc_index: 0,
        task_index: 0,
        start_block: 0,
        block_count,
        expected_len,
    }
}

fn read_block_error(
    temp: &TempDir,
    name: &str,
    payloads: &[Vec<u8>],
    block_index: usize,
) -> String {
    let (path, indexes) = block_payload_file(temp, name, payloads);
    let mut file = File::open(&path).expect("open block fixture");
    let mut output = vec![0u8; BLOCK_BYTES];
    PbpContainerHandler
        .read_iso_block(&path, &mut file, 0, &indexes, block_index, &mut output)
        .expect_err("read_iso_block must reject this block")
        .to_string()
}

#[test]
fn cue_track_types_cover_data_and_audio_and_reject_anything_else() {
    let data = PbpTocTrack {
        track_type: 0x41,
        track_number: 1,
        start_frames: 150,
    };
    let audio = PbpTocTrack {
        track_type: 0x01,
        track_number: 2,
        start_frames: 300,
    };
    let unknown = PbpTocTrack {
        track_type: 0x7F,
        track_number: 3,
        start_frames: 450,
    };

    assert_eq!(
        data.cue_track_type().expect("data track type"),
        "MODE2/2352"
    );
    assert_eq!(audio.cue_track_type().expect("audio track type"), "AUDIO");
    let error = unknown
        .cue_track_type()
        .expect_err("an unknown track type must be rejected");
    assert!(
        error.to_string().contains("unsupported track type 0x7F"),
        "unexpected error: {error}"
    );
}

#[test]
fn decode_bcd_rejects_nibbles_above_nine() {
    assert_eq!(
        PbpContainerHandler::decode_bcd(0x59, "test").expect("valid bcd"),
        59
    );
    let error = PbpContainerHandler::decode_bcd(0x1A, "TOC start track")
        .expect_err("0x1A is not a BCD pair");
    assert!(
        error
            .to_string()
            .contains("invalid BCD value for TOC start track: 0x1A"),
        "unexpected error: {error}"
    );
}

#[test]
fn msf_to_frames_rejects_out_of_range_seconds_and_frames() {
    assert_eq!(
        PbpContainerHandler::msf_to_frames(1, 2, 3).expect("valid msf"),
        (60 * 75) + (2 * 75) + 3
    );
    for (minutes, seconds, frames) in [(0u8, 60u8, 0u8), (0, 0, 75)] {
        let error = PbpContainerHandler::msf_to_frames(minutes, seconds, frames)
            .expect_err("an out-of-range timestamp must be rejected");
        assert!(
            error.to_string().contains("invalid MSF timestamp"),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn an_empty_iso_needs_no_blocks_and_produces_no_extract_tasks() {
    let handler = PbpContainerHandler;
    assert_eq!(handler.required_block_count(0).expect("block count"), 0);
    assert_eq!(handler.required_block_count(1).expect("block count"), 1);
    assert_eq!(
        handler
            .required_block_count(BLOCK_BYTES as u64 + 1)
            .expect("block count"),
        2
    );

    let disc = disc_entry(0, Vec::new());
    assert!(
        handler
            .build_disc_extract_tasks(0, &disc)
            .expect("extract tasks")
            .is_empty(),
        "a zero-length ISO must plan no decode tasks"
    );
}

#[test]
fn the_handler_describes_pbp_and_refuses_to_create_one() {
    let handler = PbpContainerHandler;
    assert_eq!(handler.descriptor().name, PBP.name);

    let temp = TempDir::new("create");
    let context = test_context(temp.path());
    let request = ContainerCreateRequest {
        inputs: vec![temp.join("input.iso")],
        output: temp.join("output.pbp"),
        format: PBP.name.to_string(),
        codec: None,
        level: None,
        parent: None,
    };
    let error = handler
        .create(&request, &context)
        .expect_err("pbp create must be rejected");
    assert!(
        error.to_string().contains("extract-only"),
        "unexpected error: {error}"
    );
}

#[test]
fn read_iso_block_rejects_an_index_past_the_end_of_the_table() {
    let temp = TempDir::new("block-index");
    let error = read_block_error(&temp, "blocks.bin", &[vec![0u8; 8]], 4);
    assert!(
        error.contains("is missing ISO block index 4"),
        "unexpected error: {error}"
    );
}

#[test]
fn read_iso_block_rejects_a_zero_length_index_entry() {
    let temp = TempDir::new("block-empty");
    let (path, _) = block_payload_file(&temp, "blocks.bin", &[vec![0u8; 8]]);
    let mut file = File::open(&path).expect("open block fixture");
    let mut output = vec![0u8; BLOCK_BYTES];
    let indexes = vec![PbpIsoIndexEntry {
        offset: 16,
        length: 0,
    }];
    let error = PbpContainerHandler
        .read_iso_block(&path, &mut file, 0, &indexes, 0, &mut output)
        .expect_err("a zero-length entry must be rejected")
        .to_string();
    assert!(
        error.contains("contains an empty ISO block entry"),
        "unexpected error: {error}"
    );
}

#[test]
fn read_iso_block_reports_a_payload_that_runs_past_the_end_of_the_file() {
    let temp = TempDir::new("block-truncated");
    let (path, _) = block_payload_file(&temp, "blocks.bin", &[vec![0u8; 8]]);
    let mut file = File::open(&path).expect("open block fixture");
    let mut output = vec![0u8; BLOCK_BYTES];
    let indexes = vec![PbpIsoIndexEntry {
        offset: 4096,
        length: 64,
    }];
    let error = PbpContainerHandler
        .read_iso_block(&path, &mut file, 0, &indexes, 0, &mut output)
        .expect_err("a payload past the end of the file must be rejected")
        .to_string();
    assert!(
        error.contains("is truncated while reading ISO block payload"),
        "unexpected error: {error}"
    );
}

#[test]
fn read_iso_block_rejects_undecodable_deflate_payloads() {
    let temp = TempDir::new("block-garbage");
    let error = read_block_error(&temp, "blocks.bin", &[vec![0xFF; 16]], 0);
    assert!(
        error.contains("undecodable deflate ISO block: "),
        "unexpected error: {error}"
    );
}

#[test]
fn read_iso_block_rejects_a_block_that_decodes_past_one_block() {
    let temp = TempDir::new("block-oversized");
    let oversized = raw_deflate(&vec![0u8; BLOCK_BYTES + 1]);
    let error = read_block_error(&temp, "blocks.bin", &[oversized], 0);
    assert!(
        error.contains("contains an oversized deflate ISO block"),
        "unexpected error: {error}"
    );
}

#[test]
fn read_iso_block_rejects_a_block_that_decodes_to_nothing() {
    let temp = TempDir::new("block-nothing");
    let error = read_block_error(&temp, "blocks.bin", &[raw_deflate(&[])], 0);
    assert!(
        error.ends_with("contains an undecodable deflate ISO block"),
        "unexpected error: {error}"
    );
}

#[test]
fn decode_disc_extract_task_stops_once_the_expected_length_is_met() {
    let temp = TempDir::new("decode-stop");
    let block = vec![7u8; BLOCK_BYTES];
    let (path, indexes) = block_payload_file(&temp, "blocks.bin", &[block.clone(), block]);
    let disc = disc_entry((BLOCK_BYTES * 2) as u64, indexes);
    // The task spans two blocks but only owes one block of payload, so the
    // second iteration must break instead of over-reading.
    let task = extract_task(2, BLOCK_BYTES as u64);

    let chunk = PbpContainerHandler
        .decode_disc_extract_task(&path, &disc, &task)
        .expect("decode extract task");

    assert_eq!(chunk.data.len(), BLOCK_BYTES);
    assert!(chunk.data.iter().all(|byte| *byte == 7));
}

#[test]
fn decode_disc_extract_task_rejects_a_block_shorter_than_its_task() {
    let temp = TempDir::new("decode-short");
    let short = raw_deflate(&[3u8; 100]);
    let (path, indexes) = block_payload_file(&temp, "blocks.bin", &[short]);
    let disc = disc_entry(BLOCK_BYTES as u64, indexes);
    let task = extract_task(1, BLOCK_BYTES as u64);

    let error = PbpContainerHandler
        .decode_disc_extract_task(&path, &disc, &task)
        .expect_err("a short decode must be rejected")
        .to_string();

    assert!(
        error.contains(&format!("wrote 100 bytes but expected {BLOCK_BYTES}")),
        "unexpected error: {error}"
    );
}

#[test]
fn decode_disc_extract_task_reports_a_missing_source() {
    let temp = TempDir::new("decode-missing");
    let disc = disc_entry(
        BLOCK_BYTES as u64,
        vec![PbpIsoIndexEntry {
            offset: 0,
            length: BLOCK_BYTES as u64,
        }],
    );

    let error = PbpContainerHandler
        .decode_disc_extract_task(&temp.join("absent.pbp"), &disc, &extract_task(1, 1))
        .expect_err("a missing source must be reported")
        .to_string();

    assert!(
        error.contains("failed to open pbp source"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_archive_reports_a_missing_source() {
    let temp = TempDir::new("parse-missing");
    let error = PbpContainerHandler
        .parse_archive(&temp.join("absent.pbp"))
        .expect_err("a missing source must be reported")
        .to_string();
    assert!(
        error.contains("failed to open pbp source"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_non_monotonic_section_offsets() {
    let temp = TempDir::new("sections-order");
    let mut bytes = single_disc_pbp(&DiscSpec::single_track());
    write_u32_le(&mut bytes, 8, 0x200);
    let error = parse_error(&temp, "non-monotonic.pbp", &bytes);
    assert!(
        error.contains("non-monotonic PBP section offsets"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_section_offset_past_the_end_of_the_file() {
    let temp = TempDir::new("sections-range");
    let mut bytes = single_disc_pbp(&DiscSpec::single_track());
    for section in 0..8 {
        write_u32_le(&mut bytes, 8 + (section * 4), 0xFFFF_FF00);
    }
    let error = parse_error(&temp, "out-of-range.pbp", &bytes);
    assert!(
        error.contains("out-of-range PBP section offset (0xFFFFFF00)"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_reports_a_truncated_psar_signature() {
    let temp = TempDir::new("psar-truncated");
    let mut bytes = single_disc_pbp(&DiscSpec::single_track());
    bytes.truncate(PSAR_FILE_OFFSET + 8);
    let error = parse_error(&temp, "truncated.pbp", &bytes);
    assert!(
        error.contains("is truncated while reading DATA.PSAR signature"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_reports_a_truncated_disc_id() {
    let temp = TempDir::new("disc-id-truncated");
    let mut bytes = single_disc_pbp(&DiscSpec::single_track());
    bytes.truncate(PSAR_FILE_OFFSET + 0x400 + 5);
    let error = parse_error(&temp, "truncated.pbp", &bytes);
    assert!(
        error.contains("is truncated while reading disc id"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_reports_a_truncated_toc() {
    let temp = TempDir::new("toc-truncated");
    let spec = DiscSpec::single_track();
    for (label, keep_bytes, expected) in [
        ("leadout", TOC_OFFSET + 25, "TOC leadout entry"),
        ("track", TOC_OFFSET + 35, "TOC track entry"),
        ("index", PSAR_INDEX_OFFSET + 100, "ISO index table"),
    ] {
        let mut bytes = single_disc_pbp(&spec);
        bytes.truncate(PSAR_FILE_OFFSET + keep_bytes);
        let error = parse_error(&temp, &format!("truncated-{label}.pbp"), &bytes);
        assert!(
            error.contains(&format!("is truncated while reading {expected}")),
            "unexpected error for {label}: {error}"
        );
    }
}

#[test]
fn parse_rejects_an_unexpected_multi_disc_key() {
    let temp = TempDir::new("multi-key");
    let mut psar = build_multi_disc_psar(&[build_disc_psar(&DiscSpec::single_track())]);
    write_u32_le(&mut psar, MULTI_DISC_KEY_OFFSET + 4, 0);
    let error = parse_error(&temp, "bad-key.pbp", &wrap_psar_in_pbp(&psar));
    assert!(
        error.contains("unexpected multi-disc key at slot 2"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_reports_a_truncated_multi_disc_offset_table() {
    let temp = TempDir::new("multi-table");
    let psar = build_multi_disc_psar(&[build_disc_psar(&DiscSpec::single_track())]);
    let mut bytes = wrap_psar_in_pbp(&psar);
    bytes.truncate(PSAR_FILE_OFFSET + MULTI_DISC_TABLE_OFFSET + 4);
    let error = parse_error(&temp, "truncated-table.pbp", &bytes);
    assert!(
        error.contains("is truncated while reading multi-disc offset table"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_an_out_of_range_disc_offset() {
    let temp = TempDir::new("multi-range");
    let mut psar = build_multi_disc_psar(&[build_disc_psar(&DiscSpec::single_track())]);
    write_u32_le(&mut psar, MULTI_DISC_TABLE_OFFSET, 0xFFFF_0000);
    let error = parse_error(&temp, "bad-offset.pbp", &wrap_psar_in_pbp(&psar));
    assert!(
        error.contains("contains an out-of-range disc offset"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_multi_disc_header_with_no_disc_offsets() {
    let temp = TempDir::new("multi-empty");
    let mut psar = build_multi_disc_psar(&[build_disc_psar(&DiscSpec::single_track())]);
    for slot in 0..5 {
        write_u32_le(&mut psar, MULTI_DISC_TABLE_OFFSET + (slot * 4), 0);
    }
    let error = parse_error(&temp, "no-discs.pbp", &wrap_psar_in_pbp(&psar));
    assert!(
        error.contains("contains a multi-disc header with no disc offsets"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_disc_slot_without_a_psisoimg_section() {
    let temp = TempDir::new("multi-magic");
    let mut psar = build_multi_disc_psar(&[build_disc_psar(&DiscSpec::single_track())]);
    // 0x300 is inside the zero-filled gap between the offset table and disc 1.
    write_u32_le(&mut psar, MULTI_DISC_TABLE_OFFSET, 0x300);
    let error = parse_error(&temp, "bad-disc.pbp", &wrap_psar_in_pbp(&psar));
    assert!(
        error.contains("disc 1 does not start with a PSISOIMG section"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_disc_with_too_few_index_blocks() {
    let temp = TempDir::new("index-short");
    let spec = DiscSpec {
        block_count: 1,
        ..DiscSpec::single_track()
    };
    let error = parse_error(&temp, "one-block.pbp", &single_disc_pbp(&spec));
    assert!(
        error.contains("disc 1 has too few ISO index blocks"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_an_index_table_shorter_than_the_iso() {
    let temp = TempDir::new("index-incomplete");
    let spec = DiscSpec {
        sector_count: 64,
        ..DiscSpec::single_track()
    };
    let error = parse_error(&temp, "incomplete.pbp", &single_disc_pbp(&spec));
    assert!(
        error.contains("index table is incomplete (4 blocks required, 2 present)"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_malformed_iso_index_entry() {
    let temp = TempDir::new("index-malformed");
    let error = corrupt_psar_parse_error(&temp, "malformed.pbp", |psar| {
        write_u32_le(psar, PSAR_INDEX_OFFSET + INDEX_ENTRY_BYTES + 4, 0);
    });
    assert!(
        error.contains("has a malformed ISO index entry"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_an_iso_index_entry_past_the_end_of_the_file() {
    let temp = TempDir::new("index-range");
    let error = corrupt_psar_parse_error(&temp, "out-of-range.pbp", |psar| {
        write_u32_le(psar, PSAR_INDEX_OFFSET + INDEX_ENTRY_BYTES + 4, 0xFFFF_FFFF);
    });
    assert!(
        error.contains("has an out-of-range ISO index entry"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_disc_without_any_iso_index_blocks() {
    let temp = TempDir::new("index-absent");
    let error = corrupt_psar_parse_error(&temp, "no-index.pbp", |psar| {
        psar[PSAR_INDEX_OFFSET..PSAR_ISO_OFFSET].fill(0);
    });
    assert!(
        error.contains("does not contain any ISO index blocks"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_truncated_iso_size_descriptor_block() {
    let temp = TempDir::new("size-truncated");
    let spec = DiscSpec::single_track();
    let mut blocks = default_stored_blocks(&spec);
    // Block 1 carries the popstation size descriptor at byte 104; a block that
    // decodes shorter than that cannot supply one.
    blocks[1] = raw_deflate(&[0u8; 50]);
    let psar = build_disc_psar_with_blocks(&spec, &blocks);
    let error = parse_error(&temp, "short-descriptor.pbp", &wrap_psar_in_pbp(&psar));
    assert!(
        error.contains("has a truncated ISO size descriptor block"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_zero_iso_sector_count() {
    let temp = TempDir::new("size-zero");
    let spec = DiscSpec {
        sector_count: 0,
        ..DiscSpec::single_track()
    };
    let error = parse_error(&temp, "zero-sectors.pbp", &single_disc_pbp(&spec));
    assert!(
        error.contains("reported an invalid ISO sector count of zero"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_toc_without_its_marker_entries() {
    let temp = TempDir::new("toc-markers");
    for (label, marker_offset, expected) in [
        ("a0", 2usize, "missing A0 entry"),
        ("a1", 12, "missing A1 entry"),
        ("a2", 22, "missing A2 entry"),
    ] {
        let error = corrupt_psar_parse_error(&temp, &format!("toc-{label}.pbp"), |psar| {
            psar[TOC_OFFSET + marker_offset] = 0;
        });
        assert!(
            error.contains(expected),
            "unexpected error for {label}: {error}"
        );
    }
}

#[test]
fn parse_rejects_an_inverted_toc_track_range() {
    let temp = TempDir::new("toc-range");
    let error = corrupt_psar_parse_error(&temp, "inverted.pbp", |psar| {
        psar[TOC_OFFSET + 7] = encode_bcd(2);
    });
    assert!(
        error.contains("has an invalid TOC track range (2..=1)"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_out_of_order_toc_tracks() {
    let temp = TempDir::new("toc-order");
    let spec = DiscSpec {
        tracks: vec![(0x41, 150), (0x01, 180)],
        ..DiscSpec::single_track()
    };
    let mut psar = build_disc_psar(&spec);
    psar[TOC_OFFSET + 30 + 2] = encode_bcd(2);
    let error = parse_error(&temp, "out-of-order.pbp", &wrap_psar_in_pbp(&psar));
    assert!(
        error.contains("has an invalid TOC track order (expected 1, found 2)"),
        "unexpected error: {error}"
    );
}

#[test]
fn a_blank_disc_id_header_probes_as_unknown() {
    let temp = TempDir::new("disc-id-blank");
    let mut psar = build_disc_psar(&DiscSpec::single_track());
    psar[0x400..0x40B].fill(0);
    let path = write_fixture(&temp, "blank-id.pbp", &wrap_psar_in_pbp(&psar));
    let context = test_context(temp.path());

    let report = PbpContainerHandler
        .probe_details(
            &ContainerProbeRequest {
                source: path,
                split_bin: false,
            },
            &context,
        )
        .expect("probe a blank disc id");

    assert!(
        report.label.contains("disc_ids=[1=unknown]"),
        "unexpected probe label: {}",
        report.label
    );
}

#[test]
fn extract_writes_an_index_00_for_audio_tracks() {
    let temp = TempDir::new("extract-audio");
    let spec = DiscSpec {
        tracks: vec![(0x41, 150), (0x01, 180)],
        ..DiscSpec::single_track()
    };
    let source = write_fixture(&temp, "game.pbp", &single_disc_pbp(&spec));
    let out_dir = temp.join("out");
    let context = test_context(temp.path());

    PbpContainerHandler
        .extract(&extract_request(&source, &out_dir), &context)
        .expect("extract the audio-track fixture");

    let cue = fs::read_to_string(out_dir.join("game.cue")).expect("read cue sheet");
    assert!(cue.contains("FILE \"game.bin\" BINARY"), "cue was: {cue}");
    assert!(cue.contains("  TRACK 01 MODE2/2352"), "cue was: {cue}");
    assert!(cue.contains("  TRACK 02 AUDIO"), "cue was: {cue}");
    assert!(cue.contains("    INDEX 00 00:00:00"), "cue was: {cue}");
    assert!(cue.contains("    INDEX 01 00:00:30"), "cue was: {cue}");
    assert_eq!(
        fs::metadata(out_dir.join("game.bin"))
            .expect("read bin metadata")
            .len(),
        (32 * SECTOR_BYTES) as u64
    );
}

#[test]
fn extract_rejects_a_kind_filter_that_matches_no_output() {
    let temp = TempDir::new("extract-filter");
    let source = write_fixture(
        &temp,
        "game.pbp",
        &single_disc_pbp(&DiscSpec::single_track()),
    );
    let out_dir = temp.join("out");
    let context = test_context(temp.path());
    let mut request = extract_request(&source, &out_dir);
    request.kind_filter = ArchiveEntryKindFilter::new(false, true);

    let error = PbpContainerHandler
        .extract(&request, &context)
        .expect_err("a patch-only filter must match no pbp output")
        .to_string();

    assert!(
        error.contains("matched --filter patch"),
        "unexpected error: {error}"
    );
}

#[test]
fn extract_removes_the_bin_when_a_block_fails_to_decode() {
    let temp = TempDir::new("extract-bad-block");
    let spec = DiscSpec::single_track();
    let mut blocks = default_stored_blocks(&spec);
    // Only block 1 is read during parse, so a corrupt block 0 fails at extract.
    blocks[0] = vec![0xFF; 16];
    let source = write_fixture(
        &temp,
        "game.pbp",
        &wrap_psar_in_pbp(&build_disc_psar_with_blocks(&spec, &blocks)),
    );
    let out_dir = temp.join("out");
    let context = test_context(temp.path());

    let error = PbpContainerHandler
        .extract(&extract_request(&source, &out_dir), &context)
        .expect_err("a corrupt block must fail the extract")
        .to_string();

    assert!(
        error.contains("undecodable deflate ISO block"),
        "unexpected error: {error}"
    );
    assert!(
        !out_dir.join("game.bin").exists(),
        "the partial bin must be removed when the decode fails"
    );
}

#[test]
fn extract_reports_a_cue_that_already_exists_without_overwrite() {
    let temp = TempDir::new("extract-no-overwrite");
    let source = write_fixture(
        &temp,
        "game.pbp",
        &single_disc_pbp(&DiscSpec::single_track()),
    );
    let out_dir = temp.join("out");
    fs::create_dir_all(&out_dir).expect("create output directory");
    fs::write(out_dir.join("game.cue"), b"stale").expect("seed an existing cue");
    let context = test_context(temp.path());
    let mut request = extract_request(&source, &out_dir);
    request.overwrite = false;

    let error = PbpContainerHandler
        .extract(&request, &context)
        .expect_err("an existing cue must not be overwritten")
        .to_string();

    assert!(
        error.contains("refusing to overwrite existing output"),
        "unexpected error: {error}"
    );
    assert_eq!(
        fs::read(out_dir.join("game.cue")).expect("read the seeded cue"),
        b"stale"
    );
}

#[test]
fn multi_disc_extract_without_selections_writes_every_pair() {
    let temp = TempDir::new("extract-multi");
    let first = DiscSpec::single_track();
    let second = DiscSpec {
        disc_id: "SLUS56789".to_string(),
        ..DiscSpec::single_track()
    };
    let psar = build_multi_disc_psar(&[build_disc_psar(&first), build_disc_psar(&second)]);
    let source = write_fixture(&temp, "game.pbp", &wrap_psar_in_pbp(&psar));
    let out_dir = temp.join("out");
    let context = test_context(temp.path());

    let report = PbpContainerHandler
        .extract(&extract_request(&source, &out_dir), &context)
        .expect("extract both discs");

    assert!(
        report.label.contains("to 2 cue/bin pair(s)"),
        "unexpected report label: {}",
        report.label
    );
    for disc in ["disc01", "disc02"] {
        assert!(
            out_dir.join(format!("game.{disc}.cue")).exists(),
            "missing cue for {disc}"
        );
        assert_eq!(
            fs::metadata(out_dir.join(format!("game.{disc}.bin")))
                .expect("read bin metadata")
                .len(),
            (32 * SECTOR_BYTES) as u64,
            "unexpected bin size for {disc}"
        );
    }
}
