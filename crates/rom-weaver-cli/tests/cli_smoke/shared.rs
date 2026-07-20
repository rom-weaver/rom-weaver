// Re-exported so sibling test modules can `use super::shared::*;` and recover the
// exact crate-root scope they relied on under the former `include!` layout.
pub(crate) use std::fs::{self, File};
pub(crate) use std::io::{Seek, Write};
pub(crate) use std::path::{Path, PathBuf};

pub(crate) use assert_cmd::Command;
pub(crate) use assert_fs::{
    TempDir,
    fixture::{FileWriteStr, PathChild},
};
pub(crate) use flate2::{
    Compression as DeflateCompression,
    write::{DeflateEncoder, GzEncoder},
};
pub(crate) use rom_weaver_containers::nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
    write::{
        DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
        ProcessOptions as NodProcessOptions,
    },
};
pub(crate) use rom_weaver_containers::xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper,
    write::{fs::StdFilesystem as XdvdfsStdFilesystem, img::create_xdvdfs_image},
};
pub(crate) use serde_json::Value;

pub(crate) fn parse_json_lines(output: &[u8]) -> Vec<Value> {
    let text = String::from_utf8(output.to_vec()).expect("utf8 stdout");
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(serde_json::from_str(trimmed).expect("valid json"))
            }
        })
        .collect()
}

pub(crate) fn parse_single_json_line(output: &[u8]) -> Value {
    let events = parse_json_lines(output);
    let terminal = events.last().expect("json line").clone();
    assert_patch_apply_running_progress(&events, &terminal);
    terminal
}

pub(crate) fn command_stdout(args: &[&str], expected_code: i32) -> Vec<u8> {
    let normalized_args = normalize_cli_args(args);
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.args(&normalized_args);
    command
        .assert()
        .code(expected_code)
        .get_output()
        .stdout
        .clone()
}

pub(crate) fn command_stdout_with_stdin(
    args: &[&str],
    stdin: &[u8],
    expected_code: i32,
) -> Vec<u8> {
    let normalized_args = normalize_cli_args(args);
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.args(&normalized_args);
    command.write_stdin(stdin.to_vec());
    command
        .assert()
        .code(expected_code)
        .get_output()
        .stdout
        .clone()
}

pub(crate) fn normalize_cli_args(args: &[&str]) -> Vec<String> {
    let mut normalized = Vec::with_capacity(args.len() + 1);
    let mut index = 0;
    while index < args.len() {
        match args[index] {
            "patch-apply" => {
                normalized.push("patch".to_string());
                normalized.push("apply".to_string());
            }
            "patch-create" => {
                normalized.push("patch".to_string());
                normalized.push("create".to_string());
            }
            "patch-validate" => {
                normalized.push("patch".to_string());
                normalized.push("validate".to_string());
            }
            value => normalized.push(value.to_string()),
        }
        index += 1;
    }
    normalized
}

pub(crate) fn run_json_events(args: &[&str], expected_code: i32) -> Vec<Value> {
    parse_json_lines(&command_stdout(args, expected_code))
}

pub(crate) fn run_single_json_event(args: &[&str], expected_code: i32) -> Value {
    parse_single_json_line(&command_stdout(args, expected_code))
}

/// Assert the standard patch-family JSON envelope quad emitted by every
/// `patch` subcommand terminal event: `command`, `family == "patch"`,
/// `format`, and `status`. This is the exact four-line
/// `assert_eq!(json["command"], ...)` / `["family"]` / `["format"]` /
/// `["status"]` block that recurs throughout the patch smoke tests.
pub(crate) fn assert_patch_envelope(json: &Value, command: &str, format: &str, status: &str) {
    assert_eq!(json["command"], command);
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], format);
    assert_eq!(json["status"], status);
}

pub(crate) fn assert_patch_apply_running_progress(events: &[Value], terminal: &Value) {
    if terminal["command"] != "patch-apply" || terminal["status"] != "succeeded" {
        return;
    }

    let has_running_apply_progress = events.iter().any(|event| {
        event["command"] == "patch-apply"
            && event["status"] == "running"
            && event["stage"] == "apply"
    });
    assert!(
        has_running_apply_progress,
        "expected successful patch-apply to emit a running apply progress event"
    );
}

pub(crate) fn assert_running_percent_event(events: &[Value], command: &str, format: &str) {
    assert!(
        events.iter().any(|event| {
            event["command"] == command
                && event["status"] == "running"
                && event["format"] == format
                && event["percent"]
                    .as_f64()
                    .map(|percent| percent > 0.0 && percent < 100.0)
                    .unwrap_or(false)
        }),
        "expected {command} ({format}) to emit running progress between 0 and 100"
    );
}

pub(crate) fn assert_running_percent_event_in_range(
    events: &[Value],
    command: &str,
    format: &str,
    lower_exclusive: f64,
    upper_exclusive: f64,
) {
    assert!(
        events.iter().any(|event| {
            event["command"] == command
                && event["status"] == "running"
                && event["format"] == format
                && event["percent"]
                    .as_f64()
                    .map(|percent| percent > lower_exclusive && percent < upper_exclusive)
                    .unwrap_or(false)
        }),
        "expected {command} ({format}) to emit running progress between {lower_exclusive} and {upper_exclusive}"
    );
}

pub(crate) fn emitted_file_entry<'a>(json: &'a Value, file_name: &str) -> &'a Value {
    json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array")
        .iter()
        .find(|entry| entry["file_name"].as_str() == Some(file_name))
        .unwrap_or_else(|| panic!("missing emitted file `{file_name}`"))
}

pub(crate) fn expected_event_path(path: &std::path::Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn assert_emitted_file(
    json: &Value,
    expected_path: &std::path::Path,
    expected_kind: Option<&str>,
) {
    let expected_name = expected_path
        .file_name()
        .and_then(|value| value.to_str())
        .expect("file name");
    let entry = emitted_file_entry(json, expected_name);
    assert_eq!(entry["path"], expected_event_path(expected_path));
    assert_eq!(entry["file_name"], expected_name);
    assert_eq!(
        entry["size_bytes"],
        fs::metadata(expected_path).expect("file metadata").len()
    );
    if let Some(kind) = expected_kind {
        assert_eq!(entry["kind"], kind)
    }
}

pub(crate) fn label_digest_value<'a>(label: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    label.split_whitespace().find_map(|part| {
        part.strip_prefix(prefix.as_str())
            .map(|value| value.trim_end_matches(';'))
    })
}

pub(crate) fn checksum_value(path: &std::path::Path, algorithm: &str) -> String {
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            "--input",
            path.to_str().expect("path"),
            "--algo",
            algorithm,
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    let label = json["label"].as_str().expect("label");
    label_digest_value(label, algorithm)
        .expect("checksum value in label")
        .to_string()
}

pub(crate) fn setup_temp_dir() -> TempDir {
    TempDir::new().expect("temp dir")
}

pub(crate) fn build_test_gamecube_iso(payload_len: usize) -> Vec<u8> {
    let total_len = (0x440 + payload_len).max(0x440);
    let mut bytes = vec![0_u8; total_len];
    bytes[..6].copy_from_slice(b"RWTEST");
    bytes[0x1C..0x20].copy_from_slice(&[0xC2, 0x33, 0x9F, 0x3D]);
    let title = b"rom-weaver-test\0";
    bytes[0x20..0x20 + title.len()].copy_from_slice(title);
    for (index, byte) in bytes[0x440..].iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    bytes
}

pub(crate) fn write_tar_gz_fixture(entries: &[(&Path, &str)], tar_gz_path: &Path) {
    let output = File::create(tar_gz_path).expect("create tar.gz fixture");
    let encoder = GzEncoder::new(output, DeflateCompression::default());
    let mut builder = tar::Builder::new(encoder);
    for (source_path, archive_name) in entries {
        builder
            .append_path_with_name(source_path, archive_name)
            .expect("append tar.gz entry");
    }
    let encoder = builder.into_inner().expect("finish tar fixture");
    encoder.finish().expect("finish tar.gz fixture");
}

pub(crate) fn write_wbfs_fixture_from_iso(iso_path: &std::path::Path, wbfs_path: &std::path::Path) {
    let disc = NodDiscReader::new(iso_path, &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Wbfs,
        compression: NodCompression::None,
        block_size: NodFormat::Wbfs.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create wbfs writer");
    let mut output = File::create(wbfs_path).expect("create wbfs");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write wbfs");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek wbfs");
        output
            .write_all(finalization.header.as_ref())
            .expect("write wbfs header");
    }
    output.flush().expect("flush wbfs");
}

pub(crate) fn write_wia_fixture_from_iso(iso_path: &std::path::Path, wia_path: &std::path::Path) {
    let disc = NodDiscReader::new(iso_path, &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Wia,
        compression: NodCompression::Lzma2(6),
        block_size: NodFormat::Wia.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create wia writer");
    let mut output = File::create(wia_path).expect("create wia");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write wia");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek wia");
        output
            .write_all(finalization.header.as_ref())
            .expect("write wia header");
    }
    output.flush().expect("flush wia");
}

pub(crate) fn write_xiso_fixture_from_directory(
    source_dir: &std::path::Path,
    xiso_path: &std::path::Path,
) {
    fs::create_dir_all(source_dir.join("media")).expect("source tree");
    fs::write(source_dir.join("default.xbe"), b"XBE-STUB").expect("xbe fixture");
    fs::write(source_dir.join("media").join("intro.txt"), b"welcome").expect("text fixture");

    let mut source_fs = XdvdfsStdFilesystem::create(source_dir);
    let output = File::create(xiso_path).expect("create xiso");
    let mut output = std::io::BufWriter::new(output);
    create_xdvdfs_image(&mut source_fs, &mut output, |_| {}).expect("build xiso");
    output.flush().expect("flush xiso");
}

pub(crate) const TEST_PBP_SECTOR_BYTES: usize = 0x930;
pub(crate) const TEST_PBP_BLOCK_BYTES: usize = TEST_PBP_SECTOR_BYTES * 16;
pub(crate) const TEST_PBP_PSAR_INDEX_OFFSET: usize = 0x4000;
pub(crate) const TEST_PBP_PSAR_ISO_OFFSET: usize = 0x100000;

pub(crate) fn encode_bcd(value: u8) -> u8 {
    ((value / 10) << 4) | (value % 10)
}

pub(crate) fn frames_to_msf(frames: u32) -> (u8, u8, u8) {
    let minutes = frames / (60 * 75);
    let seconds = (frames / 75) % 60;
    let frame = frames % 75;
    (minutes as u8, seconds as u8, frame as u8)
}

pub(crate) fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

pub(crate) fn build_test_pbp_iso(sector_count: u32, seed: u8) -> Vec<u8> {
    let mut bytes =
        vec![0u8; usize::try_from(sector_count).expect("sector count") * TEST_PBP_SECTOR_BYTES];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = seed.wrapping_add((index % 239) as u8);
    }
    assert!(
        bytes.len() >= TEST_PBP_BLOCK_BYTES * 2 + 108,
        "test iso must be large enough for popstation size metadata"
    );
    bytes[TEST_PBP_BLOCK_BYTES + 104..TEST_PBP_BLOCK_BYTES + 108]
        .copy_from_slice(&sector_count.to_le_bytes());
    bytes
}

pub(crate) fn compress_block_raw_deflate(block: &[u8]) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::new(), DeflateCompression::new(6));
    encoder.write_all(block).expect("deflate encode");
    encoder.finish().expect("deflate finish")
}

pub(crate) fn build_test_pbp_disc_psar(
    disc_id: &str,
    iso_data: &[u8],
    compress_alternate_blocks: bool,
) -> Vec<u8> {
    assert_eq!(disc_id.len(), 9, "disc id must be 9 chars");
    assert_eq!(
        iso_data.len() % TEST_PBP_SECTOR_BYTES,
        0,
        "iso data must align to 2352-byte sectors"
    );
    let mut padded_iso = iso_data.to_vec();
    if !padded_iso.len().is_multiple_of(TEST_PBP_BLOCK_BYTES) {
        let padded_len = padded_iso.len().div_ceil(TEST_PBP_BLOCK_BYTES) * TEST_PBP_BLOCK_BYTES;
        padded_iso.resize(padded_len, 0);
    }
    let block_count = padded_iso.len() / TEST_PBP_BLOCK_BYTES;
    let mut psar = vec![0u8; TEST_PBP_PSAR_ISO_OFFSET];
    psar[..12].copy_from_slice(b"PSISOIMG0000");
    write_u32_le(
        &mut psar,
        12,
        u32::try_from(TEST_PBP_PSAR_ISO_OFFSET + padded_iso.len()).expect("disc span"),
    );

    let disc_id_bytes = disc_id.as_bytes();
    psar[0x400] = b'_';
    psar[0x401..0x405].copy_from_slice(&disc_id_bytes[..4]);
    psar[0x405] = b'_';
    psar[0x406..0x40B].copy_from_slice(&disc_id_bytes[4..9]);

    let sector_count = u32::try_from(iso_data.len() / TEST_PBP_SECTOR_BYTES).expect("sectors");
    let leadout_frames = 150u32 + sector_count;
    let (leadout_m, leadout_s, leadout_f) = frames_to_msf(leadout_frames);
    psar[0x800 + 2] = 0xA0;
    psar[0x800 + 7] = encode_bcd(1);
    psar[0x80A + 2] = 0xA1;
    psar[0x80A + 7] = encode_bcd(1);
    psar[0x814 + 2] = 0xA2;
    psar[0x814 + 7] = encode_bcd(leadout_m);
    psar[0x814 + 8] = encode_bcd(leadout_s);
    psar[0x814 + 9] = encode_bcd(leadout_f);
    psar[0x81E] = 0x41;
    psar[0x81E + 2] = encode_bcd(1);
    psar[0x81E + 3] = encode_bcd(0);
    psar[0x81E + 4] = encode_bcd(2);
    psar[0x81E + 5] = encode_bcd(0);

    let mut block_bytes = Vec::new();
    for block_index in 0..block_count {
        let start = block_index * TEST_PBP_BLOCK_BYTES;
        let end = start + TEST_PBP_BLOCK_BYTES;
        let raw_block = &padded_iso[start..end];
        let mut payload = raw_block.to_vec();
        if compress_alternate_blocks && block_index % 2 == 1 {
            let compressed = compress_block_raw_deflate(raw_block);
            if compressed.len() < raw_block.len() {
                payload = compressed;
            }
        }
        let entry_offset = TEST_PBP_PSAR_INDEX_OFFSET + (block_index * 0x20);
        write_u32_le(
            &mut psar,
            entry_offset,
            u32::try_from(block_bytes.len()).expect("index offset"),
        );
        write_u32_le(
            &mut psar,
            entry_offset + 4,
            u32::try_from(payload.len()).expect("index length"),
        );
        block_bytes.extend_from_slice(&payload);
    }
    psar.extend_from_slice(&block_bytes);
    psar
}

pub(crate) fn build_test_pbp_fixture(discs: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    assert!(!discs.is_empty(), "at least one disc is required");
    let psar_offset = 0x100u32;
    let disc_payloads = discs
        .iter()
        .enumerate()
        .map(|(index, (disc_id, iso))| build_test_pbp_disc_psar(disc_id, iso, index % 2 == 0))
        .collect::<Vec<_>>();

    let psar = if disc_payloads.len() == 1 {
        disc_payloads[0].clone()
    } else {
        let mut data = Vec::new();
        data.extend_from_slice(b"PSTITLEIMG000000");
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&0x2CC9_C5BCu32.to_le_bytes());
        data.extend_from_slice(&0x33B5_A90Fu32.to_le_bytes());
        data.extend_from_slice(&0x06F6_B4B3u32.to_le_bytes());
        data.extend_from_slice(&0xB259_45BAu32.to_le_bytes());
        data.resize(0x200, 0);
        let position_table_offset = data.len();
        data.resize(position_table_offset + (5 * 4), 0);
        let mut cursor = 0x800usize;
        for (index, disc) in disc_payloads.iter().enumerate() {
            if data.len() < cursor {
                data.resize(cursor, 0);
            }
            write_u32_le(
                &mut data,
                position_table_offset + (index * 4),
                u32::try_from(cursor).expect("disc relative offset"),
            );
            data.extend_from_slice(disc);
            cursor = data.len();
        }
        data
    };

    let total_len = usize::try_from(psar_offset).expect("psar offset") + psar.len();
    let mut pbp = vec![0u8; total_len];
    pbp[..4].copy_from_slice(&[0x00, b'P', b'B', b'P']);
    write_u32_le(&mut pbp, 4, 0x0001_0000);
    for section in 0..8 {
        write_u32_le(&mut pbp, 8 + (section * 4), psar_offset);
    }
    let psar_start = usize::try_from(psar_offset).expect("psar offset usize");
    pbp[psar_start..psar_start + psar.len()].copy_from_slice(&psar);
    pbp
}

pub(crate) fn encode_varint(bytes: &mut Vec<u8>, mut value: u64) {
    if value == 0 {
        bytes.push(0);
        return;
    }

    let mut stack = Vec::new();
    while value > 0 {
        stack.push((value % 128) as u8);
        value /= 128;
    }

    for (index, digit) in stack.iter().rev().enumerate() {
        let is_last = index + 1 == stack.len();
        bytes.push(if is_last { *digit } else { *digit | 0x80 });
    }
}

pub(crate) fn encode_all_varints(values: &[u64]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for &value in values {
        encode_varint(&mut bytes, value);
    }
    bytes
}

pub(crate) fn adler32(bytes: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in bytes {
        a = (a + u32::from(byte)) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

pub(crate) const SIMPLE_BPS_PATCH: [u8; 25] = [
    0x42, 0x50, 0x53, 0x31, 0x8C, 0x8E, 0x80, 0x94, 0x85, 0x5A, 0x5A, 0x96, 0x8C, 0x34, 0x2A, 0x6E,
    0x5A, 0xB9, 0x87, 0x43, 0x50, 0xB0, 0xFC, 0x51, 0xA7,
];

pub(crate) enum TestIpsRecord {
    Literal { offset: u32, data: Vec<u8> },
    Rle { offset: u32, len: u16, value: u8 },
}

pub(crate) fn write_u24(bytes: &mut Vec<u8>, value: u32) {
    assert!(value <= 0x00FF_FFFF);
    bytes.push((value >> 16) as u8);
    bytes.push((value >> 8) as u8);
    bytes.push(value as u8);
}

pub(crate) fn write_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

pub(crate) fn build_ips_patch(records: Vec<TestIpsRecord>, truncate_size: Option<u32>) -> Vec<u8> {
    let mut bytes = b"PATCH".to_vec();
    for record in records {
        match record {
            TestIpsRecord::Literal { offset, data } => {
                write_u24(&mut bytes, offset);
                let len = u16::try_from(data.len()).expect("literal len");
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.extend_from_slice(&data);
            }
            TestIpsRecord::Rle { offset, len, value } => {
                write_u24(&mut bytes, offset);
                bytes.extend_from_slice(&0u16.to_be_bytes());
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.push(value);
            }
        }
    }
    bytes.extend_from_slice(b"EOF");
    if let Some(size) = truncate_size {
        write_u24(&mut bytes, size);
    }
    bytes
}

pub(crate) fn with_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 512];
    headered.extend_from_slice(bytes);
    headered
}

pub(crate) fn with_nsrt_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 512];
    headered[0x1e8..0x1ec].copy_from_slice(b"NSRT");
    headered.extend_from_slice(bytes);
    headered
}

pub(crate) fn with_nes_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 16];
    headered[..4].copy_from_slice(b"NES\x1A");
    headered.extend_from_slice(bytes);
    headered
}

pub(crate) fn with_a78_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 128];
    headered[1..10].copy_from_slice(b"ATARI7800");
    headered.extend_from_slice(bytes);
    headered
}

pub(crate) fn with_lnx_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 64];
    headered[..4].copy_from_slice(b"LYNX");
    headered.extend_from_slice(bytes);
    headered
}

pub(crate) fn with_fds_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 16];
    headered[..3].copy_from_slice(b"FDS");
    headered.extend_from_slice(bytes);
    headered
}

pub(crate) fn build_test_game_boy_rom(payload_len: usize) -> Vec<u8> {
    const GAME_BOY_LOGO: [u8; 48] = [
        0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00,
        0x0D, 0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD,
        0xD9, 0x99, 0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB,
        0xB9, 0x33, 0x3E,
    ];
    let rom_len = payload_len.max(0x200);
    let mut bytes = vec![0u8; rom_len];
    bytes[0x104..0x134].copy_from_slice(&GAME_BOY_LOGO);
    for (index, value) in bytes[0x134..=0x14C].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(7).wrapping_add(0x11);
    }
    for (index, value) in bytes[0x150..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(3).wrapping_add(0x42);
    }
    bytes
}

pub(crate) fn gba_header_checksum(bytes: &[u8]) -> u8 {
    let mut checksum = 0_i32;
    for value in &bytes[0xA0..=0xBC] {
        checksum -= i32::from(*value);
    }
    ((checksum - 0x19) & 0xFF) as u8
}

pub(crate) fn build_test_gba_rom(payload_len: usize) -> Vec<u8> {
    let rom_len = payload_len.max(0x200);
    let mut bytes = vec![0u8; rom_len];
    bytes[0x04..0x08].copy_from_slice(&[0x24, 0xFF, 0xAE, 0x51]);
    for (index, value) in bytes[0xA0..=0xBC].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(3).wrapping_add(7);
    }
    bytes[0x1BD] = gba_header_checksum(&bytes);
    for (index, value) in bytes[0x1BE..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(5).wrapping_add(0x31);
    }
    bytes
}

pub(crate) fn sega_genesis_checksum(bytes: &[u8]) -> u16 {
    let mut sum = 0_u32;
    let mut cursor = 0x200usize;
    while cursor + 1 < bytes.len() {
        let word = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]);
        sum = sum.wrapping_add(u32::from(word));
        cursor += 2;
    }
    if cursor < bytes.len() {
        sum = sum.wrapping_add(u32::from(bytes[cursor]) << 8);
    }
    (sum & 0xFFFF) as u16
}

pub(crate) fn crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0xffffu16;
    for &value in bytes {
        crc ^= u16::from(value) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

pub(crate) fn write_i32_le(bytes: &mut [u8], offset: usize, value: i32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

pub(crate) fn nds_crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0xFFFF_u16;
    for byte in bytes {
        crc ^= u16::from(*byte);
        for _ in 0..8 {
            let carry = (crc & 0x1) != 0;
            crc >>= 1;
            if carry {
                crc ^= 0xA001;
            }
        }
    }
    crc
}

pub(crate) fn build_test_nds_header(
    unit_code: u8,
    ntr_rom_size: u32,
    ntr_twl_rom_size: u32,
) -> Vec<u8> {
    const HEADER_BYTES: usize = 0x1000;
    const UNIT_CODE_OFFSET: usize = 0x12;
    const NTR_ROM_SIZE_OFFSET: usize = 0x80;
    const HEADER_SIZE_OFFSET: usize = 0x84;
    const LOGO_OFFSET: usize = 0x0C0;
    const LOGO_LENGTH: usize = 156;
    const LOGO_CRC_OFFSET: usize = 0x15C;
    const HEADER_CRC_OFFSET: usize = 0x15E;
    const NTR_TWL_ROM_SIZE_OFFSET: usize = 0x210;

    let mut header = vec![0_u8; HEADER_BYTES];
    header[..12].copy_from_slice(b"RW-TRIM-TEST");
    header[UNIT_CODE_OFFSET] = unit_code;
    header[NTR_ROM_SIZE_OFFSET..NTR_ROM_SIZE_OFFSET + 4]
        .copy_from_slice(&ntr_rom_size.to_le_bytes());
    header[HEADER_SIZE_OFFSET..HEADER_SIZE_OFFSET + 4]
        .copy_from_slice(&(HEADER_BYTES as u32).to_le_bytes());
    header[NTR_TWL_ROM_SIZE_OFFSET..NTR_TWL_ROM_SIZE_OFFSET + 4]
        .copy_from_slice(&ntr_twl_rom_size.to_le_bytes());
    for (index, byte) in header[LOGO_OFFSET..LOGO_OFFSET + LOGO_LENGTH]
        .iter_mut()
        .enumerate()
    {
        *byte = ((index * 37 + 11) % 251) as u8;
    }

    let logo_crc = nds_crc16(&header[LOGO_OFFSET..LOGO_OFFSET + LOGO_LENGTH]);
    header[LOGO_CRC_OFFSET..LOGO_CRC_OFFSET + 2].copy_from_slice(&logo_crc.to_le_bytes());
    let header_crc = nds_crc16(&header[..HEADER_CRC_OFFSET]);
    header[HEADER_CRC_OFFSET..HEADER_CRC_OFFSET + 2].copy_from_slice(&header_crc.to_le_bytes());
    header
}

pub(crate) fn build_test_nds_rom(
    unit_code: u8,
    ntr_rom_size: u32,
    ntr_twl_rom_size: u32,
    file_size: usize,
    include_download_play_cert: bool,
) -> Vec<u8> {
    const HEADER_BYTES: usize = 0x1000;

    assert!(
        file_size >= HEADER_BYTES,
        "test NDS ROM must fit the full header"
    );
    let mut rom = vec![0_u8; file_size];
    let header = build_test_nds_header(unit_code, ntr_rom_size, ntr_twl_rom_size);
    rom[..HEADER_BYTES].copy_from_slice(&header);

    for (index, byte) in rom.iter_mut().enumerate().skip(HEADER_BYTES) {
        *byte = ((index * 13 + 5) % 251) as u8;
    }

    if include_download_play_cert {
        let cert_offset = usize::try_from(ntr_rom_size).expect("ntr size fits usize");
        assert!(
            cert_offset + 0x88 <= rom.len(),
            "test NDS ROM must have room for download play cert"
        );
        rom[cert_offset] = 0x61;
        rom[cert_offset + 1] = 0x63;
        for byte in &mut rom[cert_offset + 2..cert_offset + 0x88] {
            *byte = 0xA5;
        }
    }

    rom
}

#[test]
pub(crate) fn json_mode_emits_running_progress_before_terminal_status() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert!(
        events.len() >= 2,
        "expected at least one running event and one terminal event"
    );
    assert_eq!(events[0]["command"], "checksum");
    assert_eq!(events[0]["status"], "running");

    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["command"], "checksum");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["elapsed_ms"].as_u64().is_some(),
        "expected terminal event to include elapsed_ms: {terminal}"
    );
}

#[test]
pub(crate) fn non_json_default_suppresses_running_progress_without_tty() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();

    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    // Default human output renders the result table on stdout...
    assert!(
        stdout.contains("CRC32"),
        "expected checksum result on stdout, got: {stdout}"
    );
    // ...and suppresses running progress without a tty or --progress.
    assert!(
        !stderr.contains('%'),
        "expected no running progress without a tty, got: {stderr}"
    );
}

#[test]
pub(crate) fn progress_flag_enables_running_progress_without_json() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--progress",
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();

    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    // `--progress` forces running progress even without a tty; it is drawn on stderr...
    assert!(
        stderr.contains('%'),
        "expected --progress to emit running progress on stderr, got: {stderr}"
    );
    // ...while the final result still renders on stdout.
    assert!(
        stdout.contains("CRC32"),
        "expected checksum result on stdout, got: {stdout}"
    );
}

#[test]
pub(crate) fn no_progress_flag_suppresses_running_progress_in_json_mode() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--no-progress",
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert!(
        events.iter().all(|event| event["status"] != "running"),
        "expected --no-progress to suppress running events"
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["command"], "checksum");
    assert_eq!(terminal["status"], "succeeded");
}

#[test]
pub(crate) fn terminal_progress_percent_uses_100_scale_for_core_commands() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let archive = temp.child("archive.zip");
    let extract_dir = temp.child("extract");
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("update.ips");
    let applied = temp.child("applied.bin");

    fs::write(input.path(), b"progress-check").expect("fixture");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!!").expect("fixture");

    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let compress_terminal = parse_json_lines(&compress_output)
        .into_iter()
        .last()
        .expect("compress terminal event");
    assert_eq!(compress_terminal["command"], "compress");
    assert_eq!(compress_terminal["status"], "succeeded");
    assert_eq!(compress_terminal["percent"], 100.0);

    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let extract_terminal = parse_json_lines(&extract_output)
        .into_iter()
        .last()
        .expect("extract terminal event");
    assert_eq!(extract_terminal["command"], "extract");
    assert_eq!(extract_terminal["status"], "succeeded");
    assert_eq!(extract_terminal["percent"], 100.0);

    let patch_create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let patch_create_terminal = parse_json_lines(&patch_create_output)
        .into_iter()
        .last()
        .expect("patch-create terminal event");
    assert_eq!(patch_create_terminal["command"], "patch-create");
    assert_eq!(patch_create_terminal["status"], "succeeded");
    assert_eq!(patch_create_terminal["percent"], 100.0);

    let patch_apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            applied.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let patch_apply_terminal = parse_json_lines(&patch_apply_output)
        .into_iter()
        .last()
        .expect("patch-apply terminal event");
    assert_eq!(patch_apply_terminal["command"], "patch-apply");
    assert_eq!(patch_apply_terminal["status"], "succeeded");
    assert_eq!(patch_apply_terminal["percent"], 100.0);
}
