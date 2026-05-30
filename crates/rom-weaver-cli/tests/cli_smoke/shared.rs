use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Seek, Write};
use std::path::PathBuf;

use assert_cmd::Command;
use assert_fs::{
    TempDir,
    fixture::{FileWriteStr, PathChild},
};
use flate2::{Compression as DeflateCompression, write::DeflateEncoder};
use nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
    write::{
        DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
        ProcessOptions as NodProcessOptions,
    },
};
use serde_json::Value;
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper,
    write::{fs::StdFilesystem as XdvdfsStdFilesystem, img::create_xdvdfs_image},
};

fn parse_json_lines(output: &[u8]) -> Vec<Value> {
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

fn parse_single_json_line(output: &[u8]) -> Value {
    let events = parse_json_lines(output);
    let terminal = events.last().expect("json line").clone();
    assert_patch_apply_running_progress(&events, &terminal);
    terminal
}

fn command_stdout(args: &[&str], expected_code: i32) -> Vec<u8> {
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(args)
        .assert()
        .code(expected_code)
        .get_output()
        .stdout
        .clone()
}

fn run_json_events(args: &[&str], expected_code: i32) -> Vec<Value> {
    parse_json_lines(&command_stdout(args, expected_code))
}

fn run_single_json_event(args: &[&str], expected_code: i32) -> Value {
    parse_single_json_line(&command_stdout(args, expected_code))
}

fn assert_patch_apply_running_progress(events: &[Value], terminal: &Value) {
    if terminal["command"] != "patch-apply" || terminal["status"] != "succeeded" {
        return;
    }

    let has_running_apply_progress = events.iter().any(|event| {
        event["command"] == "patch-apply"
            && event["status"] == "running"
            && event["stage"] == "apply"
            && event["percent"]
                .as_f64()
                .map(|percent| percent > 0.0 && percent < 100.0)
                .unwrap_or(false)
    });
    assert!(
        has_running_apply_progress,
        "expected successful patch-apply to emit running apply progress with percent in (0, 100)"
    );
}

fn assert_running_percent_event(events: &[Value], command: &str, format: &str) {
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

fn assert_running_percent_event_in_range(
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

fn assert_unique_integer_running_progress(
    events: &[Value],
    command: &str,
    format: &str,
    label_prefix: &str,
) {
    let mut seen = BTreeSet::new();
    for event in events {
        if event["command"] != command || event["status"] != "running" || event["format"] != format
        {
            continue;
        }
        if !event["label"]
            .as_str()
            .map(|label| label.starts_with(label_prefix))
            .unwrap_or(false)
        {
            continue;
        }
        let Some(percent) = event["percent"].as_f64() else {
            continue;
        };
        if percent <= 0.0 {
            continue;
        }
        assert!(
            (1.0..=100.0).contains(&percent),
            "expected {command} ({format}) running percent to stay in 1..=100, got {percent}"
        );
        assert!(
            (percent.fract()).abs() < f64::EPSILON,
            "expected {command} ({format}) running percent to be an integer, got {percent}"
        );
        let bucket = percent as u8;
        assert!(
            seen.insert(bucket),
            "expected {command} ({format}) `{label_prefix}` to emit each integer percent once; duplicate {bucket}%"
        );
    }
    assert!(
        !seen.is_empty(),
        "expected {command} ({format}) to emit at least one running percent event"
    );
    assert_eq!(seen.iter().next().copied(), Some(1));
    assert_eq!(seen.iter().next_back().copied(), Some(100));
}

fn emitted_file_entry<'a>(json: &'a Value, file_name: &str) -> &'a Value {
    json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array")
        .iter()
        .find(|entry| entry["file_name"].as_str() == Some(file_name))
        .unwrap_or_else(|| panic!("missing emitted file `{file_name}`"))
}

fn expected_event_path(path: &std::path::Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn assert_emitted_file(json: &Value, expected_path: &std::path::Path, expected_kind: Option<&str>) {
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
    match expected_kind {
        Some(kind) => assert_eq!(entry["kind"], kind),
        None => {}
    }
}

fn label_digest_value<'a>(label: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    label.split_whitespace().find_map(|part| {
        part.strip_prefix(prefix.as_str())
            .map(|value| value.trim_end_matches(';'))
    })
}

fn checksum_value(path: &std::path::Path, algorithm: &str) -> String {
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
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

fn setup_temp_dir() -> TempDir {
    TempDir::new().expect("temp dir")
}

fn read_single_file_bytes(dir: &std::path::Path) -> Vec<u8> {
    let mut files = fs::read_dir(dir)
        .expect("read dir")
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(files.len(), 1, "expected one extracted file");
    fs::read(&files[0]).expect("read extracted file")
}

fn run_chd_round_trip(input_name: &str, source: &[u8], codec: &str, expected_extract_name: &str) {
    let temp = setup_temp_dir();
    fs::write(temp.child(input_name).path(), source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child(input_name).path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            codec,
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "chd");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "chd");
    assert_eq!(compress_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "chd");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child(expected_extract_name).path()).expect("extract bytes"),
        source
    );
}

fn build_test_chav_stream(frame_count: usize, width: u16, height: u16) -> Vec<u8> {
    let pixels_per_frame = usize::from(width) * usize::from(height) * 2;
    let frame_bytes = 12 + pixels_per_frame;
    let mut data = Vec::with_capacity(frame_count * frame_bytes);
    for frame in 0..frame_count {
        data.extend_from_slice(b"chav");
        data.push(0); // metadata bytes
        data.push(0); // channels
        data.extend_from_slice(&0_u16.to_be_bytes()); // samples per channel
        data.extend_from_slice(&width.to_be_bytes());
        data.extend_from_slice(&height.to_be_bytes());
        for pixel in 0..pixels_per_frame {
            data.push(((frame * 29 + pixel) % 251) as u8);
        }
    }
    data
}

fn build_test_gamecube_iso(payload_len: usize) -> Vec<u8> {
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

fn write_rvz_fixture_from_iso(iso_path: &std::path::Path, rvz_path: &std::path::Path) {
    let disc = NodDiscReader::new(iso_path, &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Rvz,
        compression: NodCompression::Zstandard(5),
        block_size: NodFormat::Rvz.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create rvz writer");
    let mut output = File::create(rvz_path).expect("create rvz");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write rvz");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek rvz");
        output
            .write_all(finalization.header.as_ref())
            .expect("write rvz header");
    }
    output.flush().expect("flush rvz");
}

fn write_gcz_fixture_from_iso(iso_path: &std::path::Path, gcz_path: &std::path::Path) {
    let disc = NodDiscReader::new(iso_path, &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Gcz,
        compression: NodCompression::Deflate(6),
        block_size: NodFormat::Gcz.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create gcz writer");
    let mut output = File::create(gcz_path).expect("create gcz");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write gcz");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek gcz");
        output
            .write_all(finalization.header.as_ref())
            .expect("write gcz header");
    }
    output.flush().expect("flush gcz");
}

fn write_wbfs_fixture_from_iso(iso_path: &std::path::Path, wbfs_path: &std::path::Path) {
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

fn write_wia_fixture_from_iso(iso_path: &std::path::Path, wia_path: &std::path::Path) {
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

fn write_xiso_fixture_from_directory(source_dir: &std::path::Path, xiso_path: &std::path::Path) {
    fs::create_dir_all(source_dir.join("media")).expect("source tree");
    fs::write(source_dir.join("default.xbe"), b"XBE-STUB").expect("xbe fixture");
    fs::write(source_dir.join("media").join("intro.txt"), b"welcome").expect("text fixture");

    let mut source_fs = XdvdfsStdFilesystem::create(source_dir);
    let output = File::create(xiso_path).expect("create xiso");
    let mut output = std::io::BufWriter::new(output);
    create_xdvdfs_image(&mut source_fs, &mut output, |_| {}).expect("build xiso");
    output.flush().expect("flush xiso");
}

const TEST_PBP_SECTOR_BYTES: usize = 0x930;
const TEST_PBP_BLOCK_BYTES: usize = TEST_PBP_SECTOR_BYTES * 16;
const TEST_PBP_PSAR_INDEX_OFFSET: usize = 0x4000;
const TEST_PBP_PSAR_ISO_OFFSET: usize = 0x100000;

fn encode_bcd(value: u8) -> u8 {
    ((value / 10) << 4) | (value % 10)
}

fn frames_to_msf(frames: u32) -> (u8, u8, u8) {
    let minutes = frames / (60 * 75);
    let seconds = (frames / 75) % 60;
    let frame = frames % 75;
    (minutes as u8, seconds as u8, frame as u8)
}

fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn build_test_pbp_iso(sector_count: u32, seed: u8) -> Vec<u8> {
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

fn compress_block_raw_deflate(block: &[u8]) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::new(), DeflateCompression::new(6));
    encoder.write_all(block).expect("deflate encode");
    encoder.finish().expect("deflate finish")
}

fn build_test_pbp_disc_psar(
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
    if padded_iso.len() % TEST_PBP_BLOCK_BYTES != 0 {
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

fn build_test_pbp_fixture(discs: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
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

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/vcdiff")
        .join(name)
}

fn rar_fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/rar")
        .join(name)
}

fn trim_fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/trim")
        .join(name)
}

fn encode_varint(bytes: &mut Vec<u8>, mut value: u64) {
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

fn encode_all_varints(values: &[u64]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for &value in values {
        encode_varint(&mut bytes, value);
    }
    bytes
}

fn build_hdiff13_nocomp_patch(old: &[u8], new: &[u8]) -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        u64::try_from(new.len()).expect("new size"),
        u64::try_from(old.len()).expect("old size"),
        0, // cover_count
        0, // cover_buf_size
        0, // compress_cover_buf_size
        0, // rle_ctrl_buf_size
        0, // compress_rle_ctrl_buf_size
        0, // rle_code_buf_size
        0, // compress_rle_code_buf_size
        u64::try_from(new.len()).expect("new diff size"),
        0, // compress_new_data_diff_size
    ]));
    patch.extend_from_slice(new);
    patch
}

fn build_hdiff13_identity_patch_with_cover_and_rle(source: &[u8]) -> Vec<u8> {
    let source_size = u64::try_from(source.len()).expect("source size");
    let mut cover = Vec::new();
    cover.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover, 0); // copy_length
    encode_varint(&mut cover, source_size); // cover_length

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        source_size, // new_data_size
        source_size, // old_data_size
        1,           // cover_count
        u64::try_from(cover.len()).expect("cover size"),
        0, // compress_cover_buf_size
        1, // rle_ctrl_buf_size
        0, // compress_rle_ctrl_buf_size
        1, // rle_code_buf_size
        0, // compress_rle_code_buf_size
        0, // new_data_diff_size
        0, // compress_new_data_diff_size
    ]));
    patch.extend_from_slice(&cover);
    patch.push(0xC0); // rle_type=copy, length=1
    patch.push(0x00); // add 0 to keep bytes unchanged
    patch
}

fn build_hdiffsf20_nocomp_identity_two_steps(source: &[u8]) -> Vec<u8> {
    assert!(source.len() >= 2, "fixture requires at least two bytes");
    let split = source.len() / 2;
    let tail = source.len() - split;
    assert!(split > 0 && tail > 0, "fixture split invalid");

    let mut payload = Vec::new();

    let mut cover1 = Vec::new();
    cover1.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover1, 0); // new_gap
    encode_varint(&mut cover1, u64::try_from(split).expect("split"));
    let mut rle1 = Vec::new();
    encode_varint(&mut rle1, u64::try_from(split).expect("split"));
    encode_varint(
        &mut payload,
        u64::try_from(cover1.len()).expect("cover1 len"),
    );
    encode_varint(&mut payload, u64::try_from(rle1.len()).expect("rle1 len"));
    payload.extend_from_slice(&cover1);
    payload.extend_from_slice(&rle1);

    let mut cover2 = Vec::new();
    cover2.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover2, 0); // new_gap
    encode_varint(&mut cover2, u64::try_from(tail).expect("tail"));
    let mut rle2 = Vec::new();
    encode_varint(&mut rle2, u64::try_from(tail).expect("tail"));
    encode_varint(
        &mut payload,
        u64::try_from(cover2.len()).expect("cover2 len"),
    );
    encode_varint(&mut payload, u64::try_from(rle2.len()).expect("rle2 len"));
    payload.extend_from_slice(&cover2);
    payload.extend_from_slice(&rle2);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        u64::try_from(source.len()).expect("new size"),
        u64::try_from(source.len()).expect("old size"),
        2,   // cover_count
        256, // step_mem_size
        u64::try_from(payload.len()).expect("payload size"),
        0, // compressed_size
    ]));
    patch.extend_from_slice(&payload);
    patch
}

fn build_hdiffsf20_nocomp_identity_single_step_two_covers(source: &[u8]) -> Vec<u8> {
    assert!(source.len() >= 2, "fixture requires at least two bytes");
    let split = source.len() / 2;
    let tail = source.len() - split;
    assert!(split > 0 && tail > 0, "fixture split invalid");

    let mut cover = Vec::new();
    cover.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover, 0); // new_gap
    encode_varint(&mut cover, u64::try_from(split).expect("split"));
    cover.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover, 0); // new_gap
    encode_varint(&mut cover, u64::try_from(tail).expect("tail"));

    let mut rle = Vec::new();
    encode_varint(&mut rle, u64::try_from(split).expect("split"));
    encode_varint(&mut rle, 0); // len_value for second cover transition
    encode_varint(&mut rle, u64::try_from(tail).expect("tail"));

    let mut payload = Vec::new();
    encode_varint(&mut payload, u64::try_from(cover.len()).expect("cover len"));
    encode_varint(&mut payload, u64::try_from(rle.len()).expect("rle len"));
    payload.extend_from_slice(&cover);
    payload.extend_from_slice(&rle);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        u64::try_from(source.len()).expect("new size"),
        u64::try_from(source.len()).expect("old size"),
        2,   // cover_count
        256, // step_mem_size
        u64::try_from(payload.len()).expect("payload size"),
        0, // compressed_size
    ]));
    patch.extend_from_slice(&payload);
    patch
}

fn build_hdiff19_nocomp_directory_patch() -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF19&nocomp");
    patch.push(0);
    patch.push(1); // is_input_dir
    patch.push(1); // is_output_dir
    patch.extend_from_slice(&encode_all_varints(&[
        0, // input_dir_count
        0, // input_sum_size
        0, // output_dir_count
        0, // output_sum_size
    ]));
    patch
}

fn adler32(bytes: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in bytes {
        a = (a + u32::from(byte)) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

fn build_pcm_wave(data: &[u8]) -> Vec<u8> {
    let fmt_chunk_size = 16_u32;
    let data_chunk_size = u32::try_from(data.len()).expect("wave data fits");
    let riff_size = 4 + (8 + fmt_chunk_size) + (8 + data_chunk_size);

    let mut bytes = Vec::with_capacity(44 + data.len());
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_size.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&fmt_chunk_size.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&44_100u32.to_le_bytes());
    bytes.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_chunk_size.to_le_bytes());
    bytes.extend_from_slice(data);
    bytes
}

struct TestWindow {
    win_indicator: u8,
    source_segment_size: Option<u64>,
    source_segment_position: Option<u64>,
    target_window_size: u64,
    checksum: Option<u32>,
    data: Vec<u8>,
    inst: Vec<u8>,
    addr: Vec<u8>,
}

fn build_patch(app_header: Option<&[u8]>, windows: Vec<TestWindow>) -> Vec<u8> {
    const MAGIC: [u8; 4] = [0xD6, 0xC3, 0xC4, 0x00];
    const HDR_APP_HEADER: u8 = 0x04;

    let mut bytes = Vec::new();
    bytes.extend_from_slice(&MAGIC);
    if let Some(header) = app_header {
        bytes.push(HDR_APP_HEADER);
        encode_varint(&mut bytes, header.len() as u64);
        bytes.extend_from_slice(header);
    } else {
        bytes.push(0);
    }

    for window in windows {
        bytes.push(window.win_indicator);
        if let (Some(size), Some(position)) =
            (window.source_segment_size, window.source_segment_position)
        {
            encode_varint(&mut bytes, size);
            encode_varint(&mut bytes, position);
        }

        let mut delta = Vec::new();
        encode_varint(&mut delta, window.target_window_size);
        delta.push(0);
        encode_varint(&mut delta, window.data.len() as u64);
        encode_varint(&mut delta, window.inst.len() as u64);
        encode_varint(&mut delta, window.addr.len() as u64);
        if let Some(checksum) = window.checksum {
            delta.extend_from_slice(&checksum.to_be_bytes());
        }
        delta.extend_from_slice(&window.data);
        delta.extend_from_slice(&window.inst);
        delta.extend_from_slice(&window.addr);

        encode_varint(&mut bytes, delta.len() as u64);
        bytes.extend_from_slice(&delta);
    }

    bytes
}

const SIMPLE_BPS_PATCH: [u8; 25] = [
    0x42, 0x50, 0x53, 0x31, 0x8C, 0x8E, 0x80, 0x94, 0x85, 0x5A, 0x5A, 0x96, 0x8C, 0x34, 0x2A, 0x6E,
    0x5A, 0xB9, 0x87, 0x43, 0x50, 0xB0, 0xFC, 0x51, 0xA7,
];
const APS_GBA_BLOCK_SIZE: usize = 0x01_0000;
const DLDI_VERSION: u8 = 1;
const DLDI_MAGIC: [u8; 12] = [
    0xED, 0xA5, 0x8D, 0xBF, b' ', b'C', b'h', b'i', b's', b'h', b'm', 0x00,
];
const DLDI_FIX_ALL: u8 = 0x01;
const DLDI_FIX_GLUE: u8 = 0x02;
const DLDI_FIX_GOT: u8 = 0x04;
const DLDI_FIX_BSS: u8 = 0x08;
const DLDI_DO_MAGIC_STRING: usize = 0x00;
const DLDI_DO_VERSION: usize = 0x0C;
const DLDI_DO_DRIVER_SIZE: usize = 0x0D;
const DLDI_DO_FIX_SECTIONS: usize = 0x0E;
const DLDI_DO_ALLOCATED_SPACE: usize = 0x0F;
const DLDI_DO_FRIENDLY_NAME: usize = 0x10;
const DLDI_DO_TEXT_START: usize = 0x40;
const DLDI_DO_DATA_END: usize = 0x44;
const DLDI_DO_GLUE_START: usize = 0x48;
const DLDI_DO_GLUE_END: usize = 0x4C;
const DLDI_DO_GOT_START: usize = 0x50;
const DLDI_DO_GOT_END: usize = 0x54;
const DLDI_DO_BSS_START: usize = 0x58;
const DLDI_DO_BSS_END: usize = 0x5C;
const DLDI_DO_STARTUP: usize = 0x68;
const DLDI_DO_READ_SECTORS: usize = 0x70;
const DLDI_DO_WRITE_SECTORS: usize = 0x74;
const DLDI_DO_SHUTDOWN: usize = 0x7C;
const DLDI_DO_CODE: usize = 0x80;

enum TestIpsRecord {
    Literal { offset: u32, data: Vec<u8> },
    Rle { offset: u32, len: u16, value: u8 },
}

fn write_u24(bytes: &mut Vec<u8>, value: u32) {
    assert!(value <= 0x00FF_FFFF);
    bytes.push((value >> 16) as u8);
    bytes.push((value >> 8) as u8);
    bytes.push(value as u8);
}

fn write_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn build_ips_patch(records: Vec<TestIpsRecord>, truncate_size: Option<u32>) -> Vec<u8> {
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

fn build_ips32_patch(records: Vec<TestIpsRecord>) -> Vec<u8> {
    let mut bytes = b"IPS32".to_vec();
    for record in records {
        match record {
            TestIpsRecord::Literal { offset, data } => {
                write_u32(&mut bytes, offset);
                let len = u16::try_from(data.len()).expect("literal len");
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.extend_from_slice(&data);
            }
            TestIpsRecord::Rle { offset, len, value } => {
                write_u32(&mut bytes, offset);
                bytes.extend_from_slice(&0u16.to_be_bytes());
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.push(value);
            }
        }
    }
    bytes.extend_from_slice(b"EEOF");
    bytes
}

fn build_ebp_patch(records: Vec<TestIpsRecord>, metadata_json: &str) -> Vec<u8> {
    let mut bytes = build_ips_patch(records, None);
    bytes.extend_from_slice(metadata_json.as_bytes());
    bytes
}

fn write_sparse_bytes(path: &std::path::Path, len: u64, offset: u64, bytes: &[u8]) {
    let mut file = File::create(path).expect("create sparse file");
    file.set_len(len).expect("set len");
    file.seek(std::io::SeekFrom::Start(offset)).expect("seek");
    file.write_all(bytes).expect("write bytes");
    file.flush().expect("flush");
}

fn with_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 512];
    headered.extend_from_slice(bytes);
    headered
}

fn with_a78_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 128];
    headered[1..10].copy_from_slice(b"ATARI7800");
    headered.extend_from_slice(bytes);
    headered
}

fn with_lnx_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 64];
    headered[..4].copy_from_slice(b"LYNX");
    headered.extend_from_slice(bytes);
    headered
}

fn with_nes_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 16];
    headered[..4].copy_from_slice(b"NES\x1A");
    headered.extend_from_slice(bytes);
    headered
}

fn with_fds_header(bytes: &[u8]) -> Vec<u8> {
    let mut headered = vec![0u8; 16];
    headered[..3].copy_from_slice(b"FDS");
    headered.extend_from_slice(bytes);
    headered
}

fn gba_header_checksum(bytes: &[u8]) -> u8 {
    let mut checksum = 0_i32;
    for value in &bytes[0xA0..=0xBC] {
        checksum -= i32::from(*value);
    }
    ((checksum - 0x19) & 0xFF) as u8
}

fn build_test_gba_rom(payload_len: usize) -> Vec<u8> {
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

fn build_test_game_boy_rom(payload_len: usize) -> Vec<u8> {
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

fn sega_genesis_checksum(bytes: &[u8]) -> u16 {
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

struct TestPpfRecord {
    offset: u32,
    data: Vec<u8>,
}

fn build_ppf1_patch(description: &str, records: Vec<TestPpfRecord>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PPF10");
    bytes.push(0);

    let mut desc = [0u8; 50];
    let src = description.as_bytes();
    let copy_len = src.len().min(desc.len());
    desc[..copy_len].copy_from_slice(&src[..copy_len]);
    bytes.extend_from_slice(&desc);

    for record in records {
        bytes.extend_from_slice(&record.offset.to_le_bytes());
        bytes.push(record.data.len() as u8);
        bytes.extend_from_slice(&record.data);
    }

    bytes
}

fn crc16(bytes: &[u8]) -> u16 {
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

fn build_apsgba_patch(source: &[u8], target: &[u8]) -> Vec<u8> {
    assert_eq!(source.len(), APS_GBA_BLOCK_SIZE);
    assert_eq!(target.len(), APS_GBA_BLOCK_SIZE);

    let mut xor_bytes = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in xor_bytes.iter_mut().enumerate() {
        *byte = source[index] ^ target[index];
    }

    let mut bytes = Vec::with_capacity(12 + 4 + 2 + 2 + APS_GBA_BLOCK_SIZE);
    bytes.extend_from_slice(b"APS1");
    bytes.extend_from_slice(&(source.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(target.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&crc16(source).to_le_bytes());
    bytes.extend_from_slice(&crc16(target).to_le_bytes());
    bytes.extend_from_slice(&xor_bytes);
    bytes
}

fn build_mod_patch(records: Vec<(u32, Vec<u8>)>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PMSR");
    bytes.extend_from_slice(&(records.len() as u32).to_be_bytes());
    for (offset, data) in records {
        bytes.extend_from_slice(&offset.to_be_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&data);
    }
    bytes
}

enum TestGdiffCommand {
    Data(Vec<u8>),
    Copy { offset: u64, len: u64 },
}

fn build_gdiff_patch(commands: Vec<TestGdiffCommand>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&[0xD1, 0xFF, 0xD1, 0xFF, 4]);
    for command in commands {
        match command {
            TestGdiffCommand::Data(data) => {
                if data.len() <= 246 {
                    bytes.push(u8::try_from(data.len()).expect("len <= 246"));
                } else if data.len() <= usize::from(u16::MAX) {
                    bytes.push(247);
                    bytes.extend_from_slice(
                        &u16::try_from(data.len())
                            .expect("len <= u16::MAX")
                            .to_be_bytes(),
                    );
                } else {
                    bytes.push(248);
                    bytes.extend_from_slice(
                        &i32::try_from(data.len())
                            .expect("len <= i32::MAX")
                            .to_be_bytes(),
                    );
                }
                bytes.extend_from_slice(&data);
            }
            TestGdiffCommand::Copy { offset, len } => {
                if offset <= u64::from(u16::MAX) && len <= u64::from(u8::MAX) {
                    bytes.push(249);
                    bytes.extend_from_slice(&(offset as u16).to_be_bytes());
                    bytes.push(len as u8);
                } else if offset <= u64::from(u16::MAX) && len <= u64::from(u16::MAX) {
                    bytes.push(250);
                    bytes.extend_from_slice(&(offset as u16).to_be_bytes());
                    bytes.extend_from_slice(&(len as u16).to_be_bytes());
                } else if offset <= u64::from(i32::MAX as u32) && len <= u64::from(u8::MAX) {
                    bytes.push(252);
                    bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                    bytes.push(len as u8);
                } else if offset <= u64::from(i32::MAX as u32) && len <= u64::from(u16::MAX) {
                    bytes.push(253);
                    bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                    bytes.extend_from_slice(&(len as u16).to_be_bytes());
                } else if offset <= u64::from(i32::MAX as u32) && len <= u64::from(i32::MAX as u32)
                {
                    bytes.push(254);
                    bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                    bytes.extend_from_slice(&(len as u32).to_be_bytes());
                } else {
                    bytes.push(255);
                    bytes.extend_from_slice(
                        &i64::try_from(offset)
                            .expect("offset <= i64::MAX")
                            .to_be_bytes(),
                    );
                    bytes.extend_from_slice(
                        &i32::try_from(len).expect("len <= i32::MAX").to_be_bytes(),
                    );
                }
            }
        }
    }
    bytes.push(0);
    bytes
}

fn write_i32_le(bytes: &mut [u8], offset: usize, value: i32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn build_dldi_driver(driver_log2: u8, base_address: i32, friendly_name: &str) -> Vec<u8> {
    let size = 1usize << driver_log2;
    let mut bytes = vec![0u8; size];

    bytes[DLDI_DO_MAGIC_STRING..DLDI_DO_MAGIC_STRING + DLDI_MAGIC.len()]
        .copy_from_slice(&DLDI_MAGIC);
    bytes[DLDI_DO_VERSION] = DLDI_VERSION;
    bytes[DLDI_DO_DRIVER_SIZE] = driver_log2;
    bytes[DLDI_DO_FIX_SECTIONS] = DLDI_FIX_ALL | DLDI_FIX_GLUE | DLDI_FIX_GOT | DLDI_FIX_BSS;
    bytes[DLDI_DO_ALLOCATED_SPACE] = driver_log2;

    let name_bytes = friendly_name.as_bytes();
    let max_name_len = DLDI_DO_TEXT_START - DLDI_DO_FRIENDLY_NAME;
    let copy_len = name_bytes.len().min(max_name_len.saturating_sub(1));
    bytes[DLDI_DO_FRIENDLY_NAME..DLDI_DO_FRIENDLY_NAME + copy_len]
        .copy_from_slice(&name_bytes[..copy_len]);

    let size_i32 = i32::try_from(size).expect("size fits");
    write_i32_le(&mut bytes, DLDI_DO_TEXT_START, base_address);
    write_i32_le(&mut bytes, DLDI_DO_DATA_END, base_address + size_i32);
    write_i32_le(&mut bytes, DLDI_DO_GLUE_START, base_address + 0xA0);
    write_i32_le(&mut bytes, DLDI_DO_GLUE_END, base_address + 0xA8);
    write_i32_le(&mut bytes, DLDI_DO_GOT_START, base_address + 0xA8);
    write_i32_le(&mut bytes, DLDI_DO_GOT_END, base_address + 0xB0);
    write_i32_le(&mut bytes, DLDI_DO_BSS_START, base_address + 0xB0);
    write_i32_le(&mut bytes, DLDI_DO_BSS_END, base_address + 0xC0);
    write_i32_le(
        &mut bytes,
        DLDI_DO_STARTUP,
        base_address + i32::try_from(DLDI_DO_CODE).expect("fits"),
    );
    write_i32_le(
        &mut bytes,
        DLDI_DO_READ_SECTORS,
        base_address + i32::try_from(DLDI_DO_CODE + 8).expect("fits"),
    );
    write_i32_le(
        &mut bytes,
        DLDI_DO_WRITE_SECTORS,
        base_address + i32::try_from(DLDI_DO_CODE + 12).expect("fits"),
    );
    write_i32_le(
        &mut bytes,
        DLDI_DO_SHUTDOWN,
        base_address + i32::try_from(DLDI_DO_CODE + 16).expect("fits"),
    );

    write_i32_le(&mut bytes, DLDI_DO_CODE + 4, base_address + 0xD0);
    write_i32_le(&mut bytes, DLDI_DO_CODE + 12, base_address + 0xD8);
    write_i32_le(&mut bytes, 0xA0, base_address + 0x80);
    write_i32_le(&mut bytes, 0xA8, base_address + 0x84);
    bytes[0xB0..0xC0].fill(0x7F);
    bytes
}

fn build_nds_with_dldi_slot(
    slot_offset: usize,
    allocated_log2: u8,
    base_address: i32,
    friendly_name: &str,
) -> Vec<u8> {
    let slot_size = 1usize << allocated_log2;
    let mut file = vec![0xCDu8; slot_offset + slot_size + 0x80];
    let mut slot = build_dldi_driver(allocated_log2, base_address, friendly_name);
    slot[DLDI_DO_ALLOCATED_SPACE] = allocated_log2;
    file[slot_offset..slot_offset + slot_size].copy_from_slice(&slot);
    file
}

fn nds_crc16(bytes: &[u8]) -> u16 {
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

fn build_test_nds_header(unit_code: u8, ntr_rom_size: u32, ntr_twl_rom_size: u32) -> Vec<u8> {
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

fn build_test_nds_rom(
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

fn build_test_padded_rom(payload_size: usize, full_size: usize, pad_byte: u8) -> Vec<u8> {
    assert!(payload_size > 0, "payload size must be non-zero");
    assert!(
        full_size > payload_size,
        "full ROM size must exceed payload size"
    );

    let mut rom = vec![pad_byte; full_size];
    for (index, byte) in rom[..payload_size].iter_mut().enumerate() {
        let mut value = ((index * 17 + 3) % 253 + 1) as u8;
        if value == pad_byte {
            value = value.wrapping_sub(1);
            if value == pad_byte {
                value = value.wrapping_add(2);
            }
        }
        *byte = value;
    }
    rom
}

#[test]
fn json_mode_emits_running_progress_before_terminal_status() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
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
}

#[test]
fn non_json_default_suppresses_running_progress_without_tty() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let text = String::from_utf8(output).expect("utf8 stdout");
    assert!(!text.contains("[checksum] computing"));
    assert!(text.contains("[checksum] succeeded:"));
}

#[test]
fn progress_flag_enables_running_progress_without_json() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--progress",
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let text = String::from_utf8(output).expect("utf8 stdout");
    assert!(text.contains("[checksum] computing"));
    assert!(text.contains("[checksum] succeeded:"));
    assert!(text.contains("[checksum] elapsed:"));
}

#[test]
fn no_progress_flag_suppresses_running_progress_in_json_mode() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"progress-check").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--no-progress",
            "checksum",
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
fn extract_progress_text_reports_elapsed_and_files() {
    let temp = setup_temp_dir();
    let input = temp.child("sample.bin");
    let archive = temp.child("sample.zip");
    let extract_dir = temp.child("extract");
    fs::write(input.path(), b"extract-progress-check").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            input.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ])
        .assert()
        .code(0);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--progress",
            "extract",
            archive.path().to_str().expect("path"),
            "--out-dir",
            extract_dir.path().to_str().expect("path"),
            "--no-nested-extract",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let text = String::from_utf8(output).expect("utf8 stdout");
    assert!(text.contains("[extract] extracted `sample.zip`"));
    assert!(text.contains(" in "));
    assert!(text.contains(" to:"));
    assert!(text.contains("[extract]   `sample.bin` ("));
}

#[test]
fn extract_no_overwrite_fails_when_output_exists() {
    let temp = setup_temp_dir();
    let input = temp.child("sample.bin");
    let archive = temp.child("sample.zip");
    let extract_dir = temp.child("extract");
    fs::write(input.path(), b"overwrite-check").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            input.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ])
        .assert()
        .code(0);

    fs::create_dir_all(extract_dir.path()).expect("extract dir");
    fs::write(extract_dir.child("sample.bin").path(), b"existing").expect("existing output");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--out-dir",
            extract_dir.path().to_str().expect("path"),
            "--no-overwrite",
            "--no-nested-extract",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let text = String::from_utf8(output).expect("utf8 stdout");
    assert!(text.contains("refusing to overwrite existing output"));
}

#[test]
fn terminal_progress_percent_uses_100_scale_for_core_commands() {
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
            archive.path().to_str().expect("path"),
            "--out-dir",
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
            "patch-create",
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
            "patch-apply",
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
