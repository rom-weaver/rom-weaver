use std::fs::{self, File};
use std::io::{Seek, Write};
use std::path::PathBuf;

use assert_cmd::Command;
use assert_fs::{
    TempDir,
    fixture::{FileWriteStr, PathChild},
};
use nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
    write::{
        DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
        ProcessOptions as NodProcessOptions,
    },
};
use serde_json::Value;

fn parse_single_json_line(output: &[u8]) -> Value {
    let text = String::from_utf8(output.to_vec()).expect("utf8 stdout");
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .expect("json line");
    serde_json::from_str(line).expect("valid json")
}

fn setup_temp_dir() -> TempDir {
    TempDir::new().expect("temp dir")
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

    let compress_json = parse_single_json_line(&compress_output);
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

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child(expected_extract_name).path()).expect("extract bytes"),
        source
    );
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

#[test]
fn inspect_reports_known_container_as_supported() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder payload")
        .expect("fixture");
    let archive = temp.child("sample.zip");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", archive.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_reports_rar_container_as_supported() {
    let temp = setup_temp_dir();
    let source = temp.child("version.rar");
    fs::copy(rar_fixture_path("version.rar"), source.path()).expect("copy fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rar");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn extract_reports_thread_fallback_in_json() {
    let temp = setup_temp_dir();
    let expected = b"zip payload for extract test".to_vec();
    fs::write(temp.child("disc.iso").path(), &expected).expect("fixture");
    let archive = temp.child("sample.zip");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("out");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extract"),
        expected
    );
}

#[test]
fn extract_rar_reports_thread_fallback_in_json() {
    let temp = setup_temp_dir();
    let archive = temp.child("version.rar");
    fs::copy(rar_fixture_path("version.rar"), archive.path()).expect("copy fixture");
    let out_dir = temp.child("out");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "VERSION",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rar");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("VERSION").path()).expect("extract"),
        b"unrar-0.4.0".to_vec()
    );
}

#[test]
fn checksum_reports_auto_thread_mode() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--threads",
            "auto",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["family"], "checksum");
    assert_eq!(json["format"], "native");
    assert_eq!(json["thread_mode"], "auto");
    assert!(
        json["requested_threads"]
            .as_u64()
            .expect("requested threads")
            >= 1
    );
    assert!(
        json["effective_threads"]
            .as_u64()
            .expect("effective threads")
            <= 2
    );
    assert_eq!(
        json["used_parallelism"]
            .as_bool()
            .expect("parallelism flag"),
        json["effective_threads"]
            .as_u64()
            .expect("effective threads")
            > 1
    );
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("crc32="));
    assert!(label.contains("sha1="));
}

#[test]
fn checksum_supports_sha256_blake3_and_crc32c() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("hello world")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--algo",
            "blake3",
            "--algo",
            "crc32c",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["family"], "checksum");
    assert_eq!(json["format"], "native");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(
        label.contains("sha256=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
    );
    assert!(
        label.contains("blake3=d74981efa70a0c880b8d8c1985d075dbcbf679b99a5f9914e5aaf96b831a9e24")
    );
    assert!(label.contains("crc32c=c99465aa"));
}

#[test]
fn compress_routes_through_registered_container_format() {
    let temp = setup_temp_dir();
    temp.child("file.bin")
        .write_str("payload")
        .expect("fixture");
    let output_path = temp.child("out.zip");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("file.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert!(output_path.path().exists());
}

fn run_archive_round_trip(format: &str, archive_name: &str, codec: Option<&str>) {
    let temp = setup_temp_dir();
    let payload = (0..8192)
        .map(|index| ((index * 7) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("source.bin").path(), &payload).expect("fixture");

    let archive = temp.child(archive_name);
    let mut compress = Command::cargo_bin("rom-weaver").expect("binary");
    compress
        .arg("compress")
        .arg(temp.child("source.bin").path())
        .arg("--format")
        .arg(format)
        .arg("--output")
        .arg(archive.path());
    if let Some(codec) = codec {
        compress.arg("--codec").arg(codec);
    }
    compress.arg("--json");
    let compress_output = compress.assert().code(0).get_output().stdout.clone();

    let compress_json = parse_single_json_line(&compress_output);
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], format);
    assert_eq!(compress_json["status"], "succeeded");

    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", archive.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let inspect_json = parse_single_json_line(&inspect_output);
    assert_eq!(inspect_json["command"], "inspect");
    assert_eq!(inspect_json["family"], "container");
    assert_eq!(inspect_json["format"], format);
    assert_eq!(inspect_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "source.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], format);
    assert_eq!(extract_json["requested_threads"], 8);
    assert_eq!(extract_json["effective_threads"], 1);
    assert_eq!(extract_json["thread_mode"], "fixed");
    assert_eq!(extract_json["used_parallelism"], false);
    assert_eq!(extract_json["status"], "succeeded");

    let extracted = fs::read(out_dir.child("source.bin").path()).expect("read extract");
    assert_eq!(extracted, payload);
}

#[test]
fn archive_container_formats_round_trip() {
    let cases = [
        ("zip", "sample.zip", None),
        ("zipx", "sample.zipx", Some("zstd")),
        ("7z", "sample.7z", Some("lzma2")),
        ("tar", "sample.tar", None),
        ("tar.gz", "sample.tar.gz", Some("gzip")),
        ("tar.bz2", "sample.tar.bz2", Some("bzip2")),
        ("tar.xz", "sample.tar.xz", Some("xz")),
        ("gz", "source.bin.gz", Some("gzip")),
        ("bz2", "source.bin.bz2", Some("bzip2")),
        ("xz", "source.bin.xz", Some("xz")),
        ("zst", "source.bin.zst", Some("zstd")),
    ];

    for (format, archive_name, codec) in cases {
        run_archive_round_trip(format, archive_name, codec);
    }
}

#[test]
fn extract_recursively_handles_nested_containers() {
    let temp = setup_temp_dir();
    let payload = (0..24_576)
        .map(|index| (index % 197) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &payload).expect("fixture");

    let chd_path = temp.child("disc.chd");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let zip_path = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            chd_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            zip_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let seven_z_path = temp.child("outer.7z");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            zip_path.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            seven_z_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            seven_z_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "7z");
    assert_eq!(extract_json["status"], "succeeded");
    assert!(
        extract_json["label"]
            .as_str()
            .expect("label")
            .contains("recursively extracted 2 nested container(s)")
    );

    assert_eq!(
        fs::read(out_dir.child("inner/disc/disc.bin").path()).expect("nested extract payload"),
        payload
    );
}

#[test]
fn chd_compress_and_extract_raw_round_trip() {
    let source = (0..16_384)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("disc.bin", &source, "lzma", "disc.bin");
}

#[test]
fn chd_compress_and_extract_dvd_round_trip() {
    let source = (0..16_384)
        .map(|index| (index % 193) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("movie.iso", &source, "zstd", "disc.iso");
}

#[test]
fn chd_compress_and_extract_hd_round_trip() {
    let source = (0..16_384)
        .map(|index| (index % 149) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("disk.img", &source, "zlib", "disc.img");
}

#[test]
fn chd_compress_and_extract_cd_cue_round_trip() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_json = parse_single_json_line(&compress_output);
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

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("TRACK 01 MODE1/2352"));
    assert!(cue.contains("INDEX 01 00:00:00"));
}

#[test]
fn chd_compress_and_extract_cd_with_index00_round_trip() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:00:04\n    INDEX 01 00:00:06\n",
        )
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("TRACK 02 AUDIO"));
    assert!(cue.contains("INDEX 00 00:00:04"));
    assert!(cue.contains("INDEX 01 00:00:06"));
}

#[test]
fn chd_compress_and_extract_wave_audio_cue_round_trip() {
    let temp = setup_temp_dir();
    let pcm = (0..(4 * 2352))
        .map(|index| (index % 127) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("audio.wav").path(), build_pcm_wave(&pcm)).expect("wave fixture");
    temp.child("disc.cue")
        .write_str("FILE \"audio.wav\" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zlib",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        pcm
    );
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("TRACK 01 AUDIO"));
}

#[test]
fn chd_compress_and_extract_gdi_round_trip() {
    let temp = setup_temp_dir();
    let track01 = (0..(4 * 2352))
        .map(|index| (index % 101) as u8)
        .collect::<Vec<_>>();
    let track02 = (0..(3 * 2048))
        .map(|index| (index % 89) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("track01.bin").path(), &track01).expect("track01");
    fs::write(temp.child("track02.bin").path(), &track02).expect("track02");
    temp.child("disc.gdi")
        .write_str("2\n1 0 4 2352 track01.bin 0\n2 4 4 2048 track02.bin 0\n")
        .expect("gdi fixture");

    let chd_path = temp.child("disc.chd");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(out_dir.child("disc.track01.bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc.track02.bin").path()).expect("extract track02"),
        track02
    );
    let gdi = fs::read_to_string(out_dir.child("disc.gdi").path()).expect("gdi output");
    assert!(gdi.contains("2\n"));
    assert!(gdi.contains("1 0 4 2352 disc.track01.bin 0"));
    assert!(gdi.contains("2 4 4 2048 disc.track02.bin 0"));
}

#[test]
fn rvz_inspect_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_rvz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.rvz").path());

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .to_ascii_lowercase()
            .contains("compression")
    );
}

#[test]
fn rvz_compress_and_extract_round_trips() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0xA000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");

    let rvz_path = temp.child("disc.rvz");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "rvz",
            "--output",
            rvz_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--level",
            "6",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_json = parse_single_json_line(&compress_output);
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "rvz");
    assert_eq!(compress_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            rvz_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "rvz");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn rvz_compress_store_rejects_level() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x4000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "rvz",
            "--output",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--codec",
            "store",
            "--level",
            "1",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("does not accept --level")
    );
}

#[test]
fn rvz_extract_round_trips_to_iso() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_rvz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.rvz").path());

    let out_dir = temp.child("extract");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn z3ds_compress_inspect_and_extract_round_trip() {
    let temp = setup_temp_dir();
    let source = (0..65_536)
        .map(|index| (index % 239) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("disc.z3ds");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--level",
            "5",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_json = parse_single_json_line(&compress_output);
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "z3ds");
    assert_eq!(compress_json["status"], "succeeded");

    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            z3ds_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let inspect_json = parse_single_json_line(&inspect_output);
    assert_eq!(inspect_json["command"], "inspect");
    assert_eq!(inspect_json["family"], "container");
    assert_eq!(inspect_json["format"], "z3ds");
    assert_eq!(inspect_json["status"], "succeeded");
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("underlying_magic")
    );

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            z3ds_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "z3ds");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.3ds").path()).expect("extracted 3ds"),
        source
    );
}

#[test]
fn z3ds_extract_reports_parallel_threads_for_large_file() {
    let temp = setup_temp_dir();
    let source = (0..(10 * 1024 * 1024))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("large.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("large.z3ds");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("large.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--level",
            "4",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            z3ds_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&extract_output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "z3ds");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 2);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("large.3ds").path()).expect("extracted 3ds"),
        source
    );
}

#[test]
fn z3ds_compress_reports_parallel_threads_for_large_file() {
    let temp = setup_temp_dir();
    let source = (0..(10 * 1024 * 1024))
        .map(|index| (index % 241) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("large.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("large.z3ds");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("large.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--level",
            "4",
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&compress_output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "z3ds");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 8);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert!(z3ds_path.path().exists());
}

#[test]
fn z3ds_extract_rejects_invalid_header() {
    let temp = setup_temp_dir();
    let invalid = temp.child("invalid.z3ds");
    let mut bytes = vec![0_u8; 32];
    bytes[..4].copy_from_slice(b"BAD!");
    fs::write(invalid.path(), bytes).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            invalid.path().to_str().expect("path"),
            "--out-dir",
            temp.child("out").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "z3ds");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("missing Z3DS magic")
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ips_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                TestIpsRecord::Rle {
                    offset: 7,
                    len: 4,
                    value: b'!',
                },
            ],
            Some(11),
        ),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abXYZfg!!!!"
    );
}

#[test]
fn patch_create_succeeds_for_ips_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ips");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!!").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
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
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "IPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "IPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_vcdiff_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.vcdiff");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "vcdiff",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "VCDIFF");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "VCDIFF");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_bps_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "BPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_bdf_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bdf");
    let output = temp.child("output.bin");
    fs::write(
        original.path(),
        b"The quick brown fox jumps over the lazy dog.",
    )
    .expect("fixture");
    fs::write(
        modified.path(),
        b"The quick brown cat jumps over two lazy dogs!",
    )
    .expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bdf",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "BDF/BSDIFF40");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert_eq!(&patch_bytes[..8], b"BSDIFF40");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "BDF/BSDIFF40");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_ups_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.ups");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ups",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "UPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "UPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_rup_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.rup");
    let output = temp.child("output.bin");
    let reverse = temp.child("reverse.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world + tail").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "rup",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "RUP");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "RUP");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    let reverse_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            output.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            reverse.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let reverse_json = parse_single_json_line(&reverse_output);
    assert_eq!(reverse_json["command"], "patch-apply");
    assert_eq!(reverse_json["format"], "RUP");
    assert_eq!(reverse_json["status"], "succeeded");
    assert_eq!(
        fs::read(reverse.path()).expect("reverse"),
        fs::read(original.path()).expect("original")
    );
}

#[test]
fn patch_create_succeeds_for_ppf_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.ppf");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world\0\0").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ppf",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "PPF");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "PPF");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_aps_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.gba");
    let modified = temp.child("new.gba");
    let patch = temp.child("update.aps");
    let output = temp.child("output.gba");

    let mut source = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    let mut target = source.clone();
    target[0x1234] ^= 0xff;
    target[0x8000] = 0x5a;

    fs::write(original.path(), &source).expect("fixture");
    fs::write(modified.path(), &target).expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "aps",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "APS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "APS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target);
}

#[test]
fn patch_create_succeeds_for_mod_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.mod");
    let output = temp.child("output.bin");
    fs::write(original.path(), [0x01, 0x02]).expect("fixture");
    fs::write(modified.path(), [0x01, 0x02, 0x00, 0x00]).expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "mod",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "MOD");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "MOD");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_xdelta_with_secondary_when_helpful() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.xdelta");
    let output = temp.child("output.bin");
    fs::copy(fixture_path("secondary-source.bin"), original.path()).expect("copy source fixture");
    fs::copy(fixture_path("secondary-target.bin"), modified.path()).expect("copy target fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "xdelta",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "xdelta");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert_eq!(&patch_bytes[..4], &[0xD6, 0xC3, 0xC4, 0x00]);
    assert_ne!(
        patch_bytes[4] & 0x01,
        0,
        "expected secondary-compressed xdelta output"
    );

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "xdelta");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn inspect_succeeds_for_valid_vcdiff_patch() {
    let temp = setup_temp_dir();
    let patch = build_patch(
        None,
        vec![TestWindow {
            win_indicator: 1,
            source_segment_size: Some(5),
            source_segment_position: Some(0),
            target_window_size: 5,
            checksum: None,
            data: Vec::new(),
            inst: vec![21],
            addr: encode_all_varints(&[0]),
        }],
    );
    fs::write(temp.child("update.vcdiff").path(), patch).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.vcdiff").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "VCDIFF");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_succeeds_for_valid_mod_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.mod").path(),
        build_mod_patch(vec![(1, b"X".to_vec())]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.mod").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "MOD");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn patch_apply_succeeds_for_valid_xdelta_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcabcabcabc").expect("fixture");
    let expected = b"abcabcZZabcabc";
    let checksum = adler32(expected);
    let patch = build_patch(
        Some(b"xdelta-cli"),
        vec![TestWindow {
            win_indicator: 0x01 | 0x04,
            source_segment_size: Some(12),
            source_segment_position: Some(0),
            target_window_size: expected.len() as u64,
            checksum: Some(checksum),
            data: b"ZZ".to_vec(),
            inst: vec![22, 3, 22],
            addr: encode_all_varints(&[0, 6]),
        }],
    );
    fs::write(temp.child("update.xdelta").path(), patch).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        expected
    );
}

#[test]
fn patch_apply_succeeds_for_valid_bps_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcabcabcabc").expect("fixture");
    fs::write(temp.child("update.bps").path(), SIMPLE_BPS_PATCH).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abcabcZZabcabc"
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ppf_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcabcabcabc").expect("fixture");
    fs::write(
        temp.child("update.ppf").path(),
        build_ppf1_patch(
            "cli test patch",
            vec![TestPpfRecord {
                offset: 6,
                data: b"ZZ".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ppf").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "PPF");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abcabcZZcabc"
    );
}

#[test]
fn patch_apply_succeeds_for_valid_aps_patch() {
    let temp = setup_temp_dir();
    let mut source = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    let mut target = source.clone();
    target[0x0123] ^= 0x3f;
    target[0x8000] = 0x5a;

    fs::write(temp.child("input.gba").path(), &source).expect("fixture");
    fs::write(
        temp.child("update.aps").path(),
        build_apsgba_patch(&source, &target),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.gba").path().to_str().expect("path"),
            "--patch",
            temp.child("update.aps").path().to_str().expect("path"),
            "--output",
            temp.child("output.gba").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "APS");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.gba").path()).expect("output"),
        target
    );
}

#[test]
fn patch_apply_succeeds_for_valid_mod_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"ORIGINAL").expect("fixture");
    fs::write(
        temp.child("update.mod").path(),
        build_mod_patch(vec![(1, b"X".to_vec())]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.mod").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "MOD");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"OXIGINAL"
    );
}

#[test]
fn patch_apply_uses_parallel_threads_for_large_ips_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), []).expect("fixture");

    let total_len = (2 * 1024 * 1024 + 321) as u32;
    let mut records = Vec::new();
    let mut offset = 0u32;
    while offset < total_len {
        let remaining = total_len - offset;
        let len = remaining.min(u16::MAX as u32) as u16;
        records.push(TestIpsRecord::Rle {
            offset,
            len,
            value: b'Z',
        });
        offset += u32::from(len);
    }

    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(records, Some(total_len)),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 2);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), total_len as usize);
    assert!(output_bytes.iter().all(|byte| *byte == b'Z'));
}

#[test]
fn patch_apply_succeeds_for_secondary_xdelta_patch_with_parallel_threads() {
    let temp = setup_temp_dir();
    fs::copy(
        fixture_path("secondary-source.bin"),
        temp.child("input.bin").path(),
    )
    .expect("copy source fixture");
    fs::copy(
        fixture_path("secondary-djw.xdelta"),
        temp.child("update.xdelta").path(),
    )
    .expect("copy patch fixture");
    let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        expected
    );
}

#[test]
fn patch_apply_uses_parallel_threads_for_multi_window_xdelta_patch() {
    let temp = setup_temp_dir();
    let input = b"hello old world";
    let expected = b"hello new world";
    fs::write(temp.child("input.bin").path(), input).expect("fixture");
    let patch = build_patch(
        Some(b"xdelta-cli"),
        vec![
            TestWindow {
                win_indicator: 0x01,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 6,
                checksum: None,
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            },
            TestWindow {
                win_indicator: 0x01,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 9,
                checksum: None,
                data: b"new".to_vec(),
                inst: vec![4, 22],
                addr: encode_all_varints(&[9]),
            },
        ],
    );
    fs::write(temp.child("update.xdelta").path(), patch).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 2);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        expected
    );
}

#[test]
fn inspect_reports_invalid_vcdiff_content_as_failed() {
    let temp = setup_temp_dir();
    temp.child("broken.vcdiff")
        .write_str("not-a-patch")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("broken.vcdiff").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "VCDIFF");
    assert_eq!(json["status"], "failed");
}

#[test]
fn inspect_reports_unknown_formats_cleanly() {
    let temp = setup_temp_dir();
    temp.child("unknown.bin")
        .write_str("payload")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("unknown.bin").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "command");
    assert!(json["format"].is_null());
    assert_eq!(json["stage"], "probe");
    assert_eq!(json["status"], "failed");
}
