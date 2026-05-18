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
    parse_json_lines(output)
        .into_iter()
        .last()
        .expect("json line")
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

fn build_spatch_patch(primary: Vec<u8>, secondary: Vec<u8>) -> Vec<u8> {
    let mut bytes = primary;
    bytes.extend_from_slice(&secondary);
    bytes
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

#[test]
fn trim_reports_percent_100_in_json() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let output = temp.child("sample.trim.nds");
    let rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false);
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_json_lines(&trim_output)
        .into_iter()
        .last()
        .expect("trim terminal event");
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["format"], "nds");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["percent"], 100.0);
}

#[test]
fn trim_nds_preserves_download_play_certificate_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["format"], "nds");
    assert_eq!(terminal["status"], "succeeded");

    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=ds"));
    assert!(label.contains("preserved_download_play_cert=true"));
    assert!(label.contains("trimmed_size=12936"));

    let trimmed_path = source.path().with_extension("trim.nds");
    let trimmed = fs::read(&trimmed_path).expect("trimmed output");
    assert_eq!(trimmed.len(), 0x3200 + 0x88);
    assert_eq!(&trimmed[..trimmed.len()], &rom[..trimmed.len()]);
}

#[test]
fn trim_dsi_uses_ntr_twl_size_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("enhanced.nds");
    let output = temp.child("enhanced.out.nds");
    let rom = build_test_nds_rom(0x02, 0x2800, 0x3A00, 0x7000, false);
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=dsi"));
    assert!(label.contains("trimmed_size=14848"));
    assert!(label.contains("preserved_download_play_cert=false"));

    let trimmed = fs::read(output.path()).expect("trimmed output");
    assert_eq!(trimmed.len(), 0x3A00);
    assert_eq!(&trimmed[..], &rom[..0x3A00]);
}

#[test]
fn trim_rejects_invalid_header_crc() {
    let temp = setup_temp_dir();
    let source = temp.child("bad.nds");
    let mut rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false);
    rom[0x15E] ^= 0x01;
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["format"], "nds");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("header CRC mismatch")
    );
}

#[test]
fn trim_supports_batch_inputs_with_custom_extension() {
    let temp = setup_temp_dir();
    let source_a = temp.child("a.nds");
    let source_b = temp.child("b.nds");
    fs::write(
        source_a.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");
    fs::write(
        source_b.path(),
        build_test_nds_rom(0x00, 0x3200, 0x3200, 0x5800, true),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source_a.path().to_str().expect("path"),
            source_b.path().to_str().expect("path"),
            "--extension",
            "tokyo.nds",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=2"));
    assert!(label.contains("trimmed=2"));

    let trimmed_a = source_a.path().with_extension("tokyo.nds");
    let trimmed_b = source_b.path().with_extension("tokyo.nds");
    assert_eq!(fs::read(trimmed_a).expect("trimmed a").len(), 0x3000);
    assert_eq!(fs::read(trimmed_b).expect("trimmed b").len(), 0x3200 + 0x88);
}

#[test]
fn trim_recursively_scans_directories_by_default() {
    let temp = setup_temp_dir();
    let root = temp.child("input");
    fs::create_dir_all(root.child("nested").path()).expect("mkdir");

    let top_level = root.child("top.nds");
    let nested = root.child("nested/deep.nds");
    fs::write(
        top_level.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");
    fs::write(
        nested.path(),
        build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true),
    )
    .expect("fixture");
    fs::write(root.child("readme.txt").path(), b"ignore me").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", root.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=2"));
    assert!(label.contains("skipped_non_nds=1"));
    assert!(top_level.path().with_extension("trim.nds").exists());
    assert!(nested.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_no_recursive_only_processes_top_level() {
    let temp = setup_temp_dir();
    let root = temp.child("input");
    fs::create_dir_all(root.child("nested").path()).expect("mkdir");

    let top_level = root.child("top.nds");
    let nested = root.child("nested/deep.nds");
    fs::write(
        top_level.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");
    fs::write(
        nested.path(),
        build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            root.path().to_str().expect("path"),
            "--no-recursive",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=1"));
    assert!(top_level.path().with_extension("trim.nds").exists());
    assert!(!nested.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_dry_run_does_not_write_outputs() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    fs::write(
        source.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("trim simulation complete")
    );
    assert!(!source.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_simulate_alias_does_not_write_outputs() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    fs::write(
        source.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--simulate",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("trim simulation complete")
    );
    assert!(!source.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_short_inplace_flag_trims_source_file() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, true);
    fs::write(source.path(), &rom).expect("fixture");
    let original_len = fs::metadata(source.path()).expect("metadata").len();

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "-i",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("output=")
    );
    let trimmed_len = fs::metadata(source.path()).expect("trimmed metadata").len();
    assert!(trimmed_len < original_len);
    assert_eq!(trimmed_len, 0x3000 + 0x88);
}

#[test]
fn trim_gba_uses_zero_padding_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0x00)).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=gba"));
    assert!(label.contains("trimmed_size=13398"));

    let trimmed = source.path().with_extension("trim.gba");
    assert_eq!(fs::read(trimmed).expect("trimmed gba").len(), 0x3456);
}

#[test]
fn trim_3ds_uses_ff_padding_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.3ds");
    fs::write(source.path(), build_test_padded_rom(0x4567, 0x8000, 0xFF)).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=3ds"));
    assert!(label.contains("trimmed_size=17767"));

    let trimmed = source.path().with_extension("trim.3ds");
    assert_eq!(fs::read(trimmed).expect("trimmed 3ds").len(), 0x4567);
}

#[test]
fn trim_xiso_rebuilds_and_warns_irreversible() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    let source = temp.child("source.iso");
    write_xiso_fixture_from_directory(source_tree.path(), source.path());

    let mut source_file = File::options()
        .append(true)
        .open(source.path())
        .expect("open xiso");
    source_file
        .write_all(&vec![0_u8; 64 * 1024])
        .expect("append trailing padding");
    source_file.flush().expect("flush xiso padding");
    drop(source_file);

    let original_len = fs::metadata(source.path()).expect("source metadata").len();
    let output = temp.child("trimmed.xiso");

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=xiso"));
    assert!(label.contains("revert_supported=false"));
    assert!(label.contains(
        "warning=trimmed xiso output cannot be reverted to original padding; keep backup"
    ));

    let trimmed_len = fs::metadata(output.path()).expect("trimmed metadata").len();
    assert!(trimmed_len < original_len);

    let output_file = File::open(output.path()).expect("trimmed xiso output");
    let output_reader = std::io::BufReader::new(output_file);
    let mut output_image = XdvdfsOffsetWrapper::new(output_reader).expect("offset wrapper");
    let volume = xdvdfs::read::read_volume(&mut output_image).expect("xdvdfs volume");
    let root_entries = volume
        .root_table
        .walk_dirent_tree(&mut output_image)
        .expect("root entry tree");
    let names = root_entries
        .into_iter()
        .map(|entry| {
            entry
                .name_str::<std::io::Error>()
                .expect("entry name")
                .into_owned()
        })
        .collect::<Vec<_>>();
    assert!(
        names
            .iter()
            .any(|name| name.eq_ignore_ascii_case("default.xbe"))
    );
}

#[test]
fn trim_xiso_revert_is_rejected() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    let source = temp.child("source.iso");
    write_xiso_fixture_from_directory(source_tree.path(), source.path());

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--revert",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("xiso trim revert is not supported")
    );
}

#[test]
fn trim_revert_restores_gba_to_next_power_of_two() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0x00)).expect("fixture");

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let trim_terminal = parse_single_json_line(&trim_output);
    assert_eq!(trim_terminal["status"], "succeeded");

    let trimmed = source.path().with_extension("trim.gba");
    assert_eq!(fs::read(&trimmed).expect("trimmed gba").len(), 0x3456);

    let revert_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            trimmed.to_str().expect("path"),
            "--revert",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let revert_terminal = parse_single_json_line(&revert_output);
    assert_eq!(revert_terminal["command"], "trim");
    assert_eq!(revert_terminal["status"], "succeeded");
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("reverted_size=16384")
    );
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("mode=gba")
    );

    let reverted = trimmed.with_extension("untrim.gba");
    assert_eq!(fs::read(reverted).expect("reverted gba").len(), 0x4000);
}

#[test]
fn trim_revert_restores_3ds_to_next_power_of_two() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.3ds");
    fs::write(source.path(), build_test_padded_rom(0x4567, 0x8000, 0xFF)).expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0);

    let trimmed = source.path().with_extension("trim.3ds");
    assert_eq!(fs::read(&trimmed).expect("trimmed 3ds").len(), 0x4567);

    let revert_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            trimmed.to_str().expect("path"),
            "--untrim",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let revert_terminal = parse_single_json_line(&revert_output);
    assert_eq!(revert_terminal["command"], "trim");
    assert_eq!(revert_terminal["status"], "succeeded");
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("reverted_size=32768")
    );
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("mode=3ds")
    );

    let reverted = trimmed.with_extension("untrim.3ds");
    assert_eq!(fs::read(reverted).expect("reverted 3ds").len(), 0x8000);
}

#[test]
fn trim_revert_restores_nds_to_power_of_two() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x8000, false);
    fs::write(source.path(), &rom).expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "-i",
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(fs::read(source.path()).expect("trimmed nds").len(), 0x3000);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--revert",
            "-i",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("mode=ds")
    );
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("reverted_size=16384")
    );
    assert_eq!(fs::read(source.path()).expect("reverted nds").len(), 0x4000);
}

#[test]
fn trim_skips_non_nds_inputs() {
    let temp = setup_temp_dir();
    let source = temp.child("notes.txt");
    fs::write(source.path(), b"not an nds file").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("no trim-eligible inputs found; skipped_non_nds=1")
    );
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
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("recommended_compress_format=chd"));
    assert!(label.contains("reason=not-wii-gc-or-unrecognized"));
}

#[test]
fn inspect_list_reports_selectable_zip_entries() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"payload").expect("fixture");
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
        .args([
            "inspect",
            archive.path().to_str().expect("path"),
            "--list",
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
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("selectable entries"));
    assert!(label.contains("sample.bin"));
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
fn inspect_reports_known_rom_header_as_supported() {
    let temp = setup_temp_dir();
    let payload = b"header-aware inspect payload".to_vec();
    fs::write(temp.child("headered.nes").path(), with_nes_header(&payload)).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("headered.nes").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "command");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("detected ROM header No-Intro_NES.xml"));
    assert!(label.contains("stripped_bytes=16"));
    assert!(label.contains("headered_extension=.nes"));
    assert!(label.contains("headerless_extension=.nes"));
}

#[test]
fn inspect_list_rejects_patch_inputs() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![0xAA],
            }],
            None,
        ),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.ips").path().to_str().expect("path"),
            "--list",
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
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("only supported for container formats")
    );
}

#[test]
fn inspect_list_reports_pbp_multi_disc_selectable_outputs() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 13);
    let disc2 = build_test_pbp_iso(80, 29);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            source.path().to_str().expect("path"),
            "--list",
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
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("multi.disc01.cue"));
    assert!(label.contains("multi.disc01.bin"));
    assert!(label.contains("multi.disc02.cue"));
    assert!(label.contains("multi.disc02.bin"));
}

#[test]
fn extract_pbp_without_select_emits_all_discs() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 7);
    let disc2 = build_test_pbp_iso(80, 23);
    let pbp = build_test_pbp_fixture(vec![
        ("SLUS00001", disc1.clone()),
        ("SLUS00002", disc2.clone()),
    ]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");
    let out_dir = temp.child("all");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            source.path().to_str().expect("path"),
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
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("multi.disc01.bin").path()).expect("disc01"),
        disc1
    );
    assert_eq!(
        fs::read(out_dir.child("multi.disc02.bin").path()).expect("disc02"),
        disc2
    );
    assert!(out_dir.child("multi.disc01.cue").path().exists());
    assert!(out_dir.child("multi.disc02.cue").path().exists());
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
fn extract_select_supports_glob_patterns() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("content").path()).expect("content dir");
    let payload = (0..8192)
        .map(|index| (index % 239) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("content/disc.iso").path(), &payload).expect("iso fixture");
    fs::write(temp.child("content/readme.txt").path(), b"notes").expect("sidecar fixture");

    let archive = temp.child("sample.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("content").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("selected");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "content/*.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    assert_eq!(
        fs::read(out_dir.child("content/disc.iso").path()).expect("iso extract"),
        payload
    );
    assert!(!out_dir.child("content/readme.txt").path().exists());
}

#[test]
fn extract_select_glob_reports_missing_match() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("content").path()).expect("content dir");
    fs::write(temp.child("content/disc.iso").path(), b"iso").expect("iso fixture");

    let archive = temp.child("sample.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("content").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("selected");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "content/*.cue",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let json = parse_single_json_line(&output);
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn extract_pbp_select_cue_emits_matching_bin_pair() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 41);
    let disc2 = build_test_pbp_iso(80, 73);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2.clone())]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");
    let out_dir = temp.child("selected");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            source.path().to_str().expect("path"),
            "--select",
            "multi.disc02.cue",
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
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "succeeded");
    assert!(out_dir.child("multi.disc02.cue").path().exists());
    assert!(out_dir.child("multi.disc02.bin").path().exists());
    assert!(!out_dir.child("multi.disc01.cue").path().exists());
    assert!(!out_dir.child("multi.disc01.bin").path().exists());
    assert_eq!(
        fs::read(out_dir.child("multi.disc02.bin").path()).expect("disc2 bin"),
        disc2
    );
}

#[test]
fn extract_pbp_select_missing_target_reports_not_found() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 5);
    let disc2 = build_test_pbp_iso(80, 9);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");
    let out_dir = temp.child("selected");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            source.path().to_str().expect("path"),
            "--select",
            "multi.disc09.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
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
fn checksum_auto_extract_resolves_nested_container_payload() {
    let temp = setup_temp_dir();
    let payload = (0..32_768)
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("outer.7z");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual, expected);
    assert!(label.contains("checksum source resolved via 2 container extract step(s)"));
}

#[test]
fn checksum_no_extract_hashes_container_bytes() {
    let temp = setup_temp_dir();
    let payload = (0..24_576)
        .map(|index| (index % 199) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("outer.7z");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let expected_payload = checksum_value(temp.child("game.bin").path(), "sha1");

    let auto_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let auto_label = parse_single_json_line(&auto_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let auto_digest = label_digest_value(&auto_label, "sha1")
        .expect("auto digest")
        .to_string();

    let raw_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let raw_label = parse_single_json_line(&raw_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let raw_digest = label_digest_value(&raw_label, "sha1")
        .expect("raw digest")
        .to_string();

    assert_eq!(auto_digest, expected_payload);
    assert_ne!(raw_digest, auto_digest);
}

#[test]
fn checksum_auto_extract_ambiguity_requires_select() {
    let temp = setup_temp_dir();
    fs::write(temp.child("alpha.bin").path(), b"alpha").expect("alpha fixture");
    fs::write(temp.child("beta.bin").path(), b"beta").expect("beta fixture");

    let archive = temp.child("dupe.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("alpha.bin").path().to_str().expect("path"),
            temp.child("beta.bin").path().to_str().expect("path"),
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
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let json = parse_single_json_line(&output);
    let label = json["label"].as_str().expect("label");
    assert_eq!(json["status"], "failed");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("alpha.bin"));
    assert!(label.contains("beta.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn checksum_auto_extract_pbp_multi_disc_requires_select() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 31);
    let disc2 = build_test_pbp_iso(80, 47);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("multi.disc01.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn checksum_auto_extract_ignores_sidecars_unless_no_ignore() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("__MACOSX").path()).expect("__MACOSX dir");

    let payload = (0..16_384)
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");
    fs::write(temp.child("notes.txt").path(), b"notes").expect("txt sidecar");
    fs::write(temp.child("meta.json").path(), b"{}").expect("json sidecar");
    fs::write(temp.child("maxcso-report.bin").path(), b"skip me").expect("maxcso sidecar");
    fs::write(temp.child("__MACOSX/ghost.bin").path(), b"ghost").expect("macosx sidecar");

    let archive = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            temp.child("notes.txt").path().to_str().expect("path"),
            temp.child("meta.json").path().to_str().expect("path"),
            temp.child("maxcso-report.bin")
                .path()
                .to_str()
                .expect("path"),
            temp.child("__MACOSX").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let label = parse_single_json_line(&output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let digest = label_digest_value(&label, "sha1")
        .expect("digest")
        .to_string();
    assert_eq!(digest, expected);

    let no_ignore_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-ignore",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let no_ignore_json = parse_single_json_line(&no_ignore_output);
    let no_ignore_label = no_ignore_json["label"].as_str().expect("label");
    assert_eq!(no_ignore_json["status"], "failed");
    assert!(no_ignore_label.contains("ambiguous"));
    assert!(no_ignore_label.contains("--select"));
}

#[test]
fn checksum_select_patterns_apply_at_each_recursion_depth() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.bin").path(), b"final payload").expect("payload fixture");
    fs::write(temp.child("decoy.rom").path(), b"decoy payload").expect("decoy fixture");

    let inner = temp.child("inner.bin");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            temp.child("decoy.rom").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    fs::write(temp.child("note.txt").path(), b"ignore me").expect("note fixture");

    let outer = temp.child("outer.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner.path().to_str().expect("path"),
            temp.child("note.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let failed_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let failed_json = parse_single_json_line(&failed_output);
    assert!(
        failed_json["label"]
            .as_str()
            .expect("label")
            .contains("ambiguous")
    );

    let selected_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--select",
            "*.bin",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let selected_json = parse_single_json_line(&selected_output);
    let selected_label = selected_json["label"].as_str().expect("label");
    let selected_digest = label_digest_value(selected_label, "sha1")
        .expect("selected digest")
        .to_string();
    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    assert_eq!(selected_digest, expected);
}

#[test]
fn checksum_xiso_does_not_auto_extract_payload() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    let xiso = temp.child("disc.xiso");
    write_xiso_fixture_from_directory(source_tree.path(), xiso.path());

    let auto_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            xiso.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let auto_label = parse_single_json_line(&auto_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let auto_digest = label_digest_value(&auto_label, "sha1")
        .expect("auto digest")
        .to_string();

    let raw_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            xiso.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let raw_label = parse_single_json_line(&raw_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let raw_digest = label_digest_value(&raw_label, "sha1")
        .expect("raw digest")
        .to_string();

    let payload_digest = checksum_value(source_tree.child("default.xbe").path(), "sha1");
    assert_eq!(auto_digest, raw_digest);
    assert_ne!(auto_digest, payload_digest);
}

#[test]
fn checksum_strip_header_matches_unheadered_digests() {
    let temp = setup_temp_dir();
    let payload = (0..1024)
        .map(|index| ((index * 11) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("plain.bin").path(), &payload).expect("fixture");
    fs::write(temp.child("headered.bin").path(), with_header(&payload)).expect("fixture");

    let plain_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("plain.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("headered.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let plain_json = parse_single_json_line(&plain_output);
    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(plain_json["command"], "checksum");
    assert_eq!(headered_json["command"], "checksum");
    assert_eq!(plain_json["status"], "succeeded");
    assert_eq!(headered_json["status"], "succeeded");

    let plain_label = plain_json["label"].as_str().expect("plain label");
    let headered_label = headered_json["label"].as_str().expect("headered label");
    assert_eq!(
        label_digest_value(plain_label, "crc32"),
        label_digest_value(headered_label, "crc32")
    );
    assert_eq!(
        label_digest_value(plain_label, "sha1"),
        label_digest_value(headered_label, "sha1")
    );
    assert!(headered_label.contains("input header stripped (512 bytes"));
}

#[test]
fn checksum_strip_header_supports_igir_header_profiles() {
    let temp = setup_temp_dir();
    let payload = (0..1536)
        .map(|index| ((index * 13) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("plain.bin").path(), &payload).expect("fixture");

    let plain_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("plain.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let plain_json = parse_single_json_line(&plain_output);
    let plain_label = plain_json["label"].as_str().expect("plain label");

    let cases = vec![
        (
            "headered.a78",
            with_a78_header(&payload),
            128,
            "No-Intro_A7800.xml",
        ),
        (
            "headered.lnx",
            with_lnx_header(&payload),
            64,
            "No-Intro_LNX.xml",
        ),
        (
            "headered.nes",
            with_nes_header(&payload),
            16,
            "No-Intro_NES.xml",
        ),
        (
            "headered.fds",
            with_fds_header(&payload),
            16,
            "No-Intro_FDS.xml",
        ),
        ("headered.smc", with_header(&payload), 512, "SMC"),
    ];

    for (name, bytes, stripped_len, profile_name) in cases {
        fs::write(temp.child(name).path(), bytes).expect("headered fixture");
        let output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args([
                "checksum",
                temp.child(name).path().to_str().expect("path"),
                "--algo",
                "crc32",
                "--algo",
                "sha1",
                "--strip-header",
                "--json",
            ])
            .assert()
            .code(0)
            .get_output()
            .stdout
            .clone();

        let json = parse_single_json_line(&output);
        assert_eq!(json["status"], "succeeded");
        let label = json["label"].as_str().expect("headered label");
        assert_eq!(
            label_digest_value(plain_label, "crc32"),
            label_digest_value(label, "crc32")
        );
        assert_eq!(
            label_digest_value(plain_label, "sha1"),
            label_digest_value(label, "sha1")
        );
        assert!(label.contains(&format!(
            "input header stripped ({stripped_len} bytes, {profile_name})"
        )));
    }
}

#[test]
fn checksum_strip_header_rejects_small_input() {
    let temp = setup_temp_dir();
    fs::write(temp.child("tiny.bin").path(), b"small").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("tiny.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["family"], "checksum");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("cannot strip 512-byte header")
    );
}

#[test]
fn checksum_auto_trim_fix_nds_matches_explicitly_trimmed_output() {
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let trimmed = temp.child("downloadplay-trimmed.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");
    fs::write(trimmed.path(), &rom[..0x3200 + 0x88]).expect("trimmed fixture");

    let trimmed_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let explicit_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            trimmed.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let trimmed_json = parse_single_json_line(&trimmed_output);
    let explicit_json = parse_single_json_line(&explicit_output);
    assert_eq!(trimmed_json["status"], "succeeded");
    assert_eq!(explicit_json["status"], "succeeded");

    let trimmed_label = trimmed_json["label"].as_str().expect("trimmed label");
    let explicit_label = explicit_json["label"].as_str().expect("explicit label");
    assert_eq!(
        label_digest_value(trimmed_label, "crc32"),
        label_digest_value(explicit_label, "crc32")
    );
    assert_eq!(
        label_digest_value(trimmed_label, "sha1"),
        label_digest_value(explicit_label, "sha1")
    );
    assert!(trimmed_label.contains("range=0..12936"));
    assert!(trimmed_label.contains("trimmed_input_bytes=12936"));
    assert!(trimmed_label.contains("mode=ds"));
    assert!(trimmed_label.contains("preserved_download_play_cert=true"));
}

#[test]
fn checksum_auto_trim_fix_supports_strip_header() {
    let temp = setup_temp_dir();
    let source = temp.child("base.nds");
    let headered = temp.child("base-headered.nds");
    let rom = build_test_nds_rom(0x02, 0x2800, 0x3A00, 0x7000, false);
    fs::write(source.path(), &rom).expect("fixture");
    fs::write(headered.path(), with_header(&rom)).expect("fixture");

    let source_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            headered.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let source_json = parse_single_json_line(&source_output);
    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(source_json["status"], "succeeded");
    assert_eq!(headered_json["status"], "succeeded");

    let source_label = source_json["label"].as_str().expect("source label");
    let headered_label = headered_json["label"].as_str().expect("headered label");
    assert_eq!(
        label_digest_value(source_label, "crc32"),
        label_digest_value(headered_label, "crc32")
    );
    assert!(headered_label.contains("input header stripped (512 bytes"));
    assert!(headered_label.contains("trimmed_input_bytes=14848"));
    assert!(headered_label.contains("mode=dsi"));
}

#[test]
fn checksum_no_trim_fix_disables_trimmed_boundary_fix() {
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");

    let auto_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let no_fix_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-trim-fix",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let auto_json = parse_single_json_line(&auto_output);
    let no_fix_json = parse_single_json_line(&no_fix_output);
    assert_eq!(auto_json["status"], "succeeded");
    assert_eq!(no_fix_json["status"], "succeeded");

    let auto_label = auto_json["label"].as_str().expect("auto label");
    let no_fix_label = no_fix_json["label"].as_str().expect("no-fix label");
    assert!(auto_label.contains("trimmed_input_bytes=12936"));
    assert!(!no_fix_label.contains("trimmed_input_bytes="));
    assert_ne!(
        label_digest_value(auto_label, "crc32"),
        label_digest_value(no_fix_label, "crc32")
    );
}

#[test]
fn checksum_auto_trim_fix_ignores_non_trim_eligible_extensions() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"hello").expect("fixture");

    let auto_output = Command::cargo_bin("rom-weaver")
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

    let no_fix_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-trim-fix",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let auto_json = parse_single_json_line(&auto_output);
    let no_fix_json = parse_single_json_line(&no_fix_output);
    assert_eq!(auto_json["command"], "checksum");
    assert_eq!(auto_json["family"], "checksum");
    assert_eq!(auto_json["status"], "succeeded");
    assert_eq!(no_fix_json["status"], "succeeded");
    let auto_label = auto_json["label"].as_str().expect("auto label");
    let no_fix_label = no_fix_json["label"].as_str().expect("no-fix label");
    assert!(!auto_label.contains("trimmed_input_bytes="));
    assert_eq!(
        label_digest_value(auto_label, "crc32"),
        label_digest_value(no_fix_label, "crc32")
    );
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

#[test]
fn compress_gcz_warns_and_rejects_output() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x4000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    let output_path = temp.child("out.gcz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "gcz",
            "--output",
            output_path.path().to_str().expect("path"),
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
    assert_eq!(json["format"], "gcz");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("warning: gcz compression is not supported")
    );
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("--format rvz")
    );
    assert!(!output_path.path().exists());
}

#[test]
fn compress_rejects_unregistered_output_format() {
    let temp = setup_temp_dir();
    let source = temp.child("source.bin");
    fs::write(source.path(), [0_u8; 16]).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source.path().to_str().expect("path"),
            "--format",
            "not-a-format",
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
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
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested output format is not registered")
    );
}

#[test]
fn compress_auto_mode_selects_chd_for_unrecognized_iso() {
    let temp = setup_temp_dir();
    let source_path = temp.child("source.iso");
    let payload = (0..(256 * 1024))
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(source_path.path(), payload).expect("fixture");
    let output_path = temp.child("out.chd");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source_path.path().to_str().expect("path"),
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
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=chd"));
    assert!(label.contains("reason=not-wii-gc-or-unrecognized"));
}

#[test]
fn compress_without_format_auto_selects_rvz_for_disc_like_inputs() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("source.iso").path(),
        build_test_gamecube_iso(512 * 1024),
    )
    .expect("fixture");
    let output_path = temp.child("out.rvz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.iso").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=rvz"));
    assert!(label.contains("reason=wii-gc-disc"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_with_explicit_auto_format_selects_rvz_for_disc_like_inputs() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("source.iso").path(),
        build_test_gamecube_iso(512 * 1024),
    )
    .expect("fixture");
    let output_path = temp.child("out.rvz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.iso").path().to_str().expect("path"),
            "--format",
            "auto",
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
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=rvz"));
    assert!(label.contains("reason=wii-gc-disc"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_auto_selects_chd_for_non_disc_inputs() {
    let temp = setup_temp_dir();
    let payload = (0..(256 * 1024))
        .map(|index| ((index * 13) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("source.bin").path(), payload).expect("fixture");
    let output_path = temp.child("out.chd");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.bin").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=chd"));
    assert!(label.contains("reason=not-wii-gc-or-unrecognized"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_auto_mode_rejects_multiple_inputs_without_explicit_format() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source-a.bin").path(), b"a").expect("fixture");
    fs::write(temp.child("source-b.bin").path(), b"b").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source-a.bin").path().to_str().expect("path"),
            temp.child("source-b.bin").path().to_str().expect("path"),
            "--output",
            temp.child("out.auto").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "auto");
    assert_eq!(json["stage"], "validate");
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("requires exactly one input file"));
    assert!(label.contains("--format"));
}

#[test]
fn compress_rejects_wua_output_format() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), [1_u8; 64]).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.bin").path().to_str().expect("path"),
            "--format",
            "wua",
            "--output",
            temp.child("out.wua").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "wua");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested output format is not registered")
    );
}

#[test]
fn compress_rejects_invalid_codec_level_spec() {
    let temp = setup_temp_dir();
    temp.child("file.bin")
        .write_str("payload")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("file.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            temp.child("out.zip").path().to_str().expect("path"),
            "--codec",
            "deflate:fast",
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
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("not a valid integer")
    );
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
        ("zipx", "sample.zipx", Some("zstd:3")),
        ("7z", "sample.7z", Some("lzma2")),
        ("tar", "sample.tar", None),
        ("tar.gz", "sample.tar.gz", Some("gzip:6")),
        ("tar.bz2", "sample.tar.bz2", Some("bzip2:6")),
        ("tar.xz", "sample.tar.xz", Some("xz:6")),
        ("tar.xz", "sample-lzma2.tar.xz", Some("lzma2:6")),
        ("gz", "source.bin.gz", Some("gzip:6")),
        ("bz2", "source.bin.bz2", Some("bzip2:6")),
        ("xz", "source.bin.xz", Some("xz:6")),
        ("xz", "source.bin.xz", Some("lzma2:6")),
        ("zst", "source.bin.zst", Some("zstd:3")),
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
    run_chd_round_trip("disc.bin", &source, "lzma2", "disc.bin");
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
fn chd_compress_and_extract_flac_round_trip() {
    let source = (0..16_384)
        .map(|index| ((index as i16).wrapping_mul(17) as u16).to_le_bytes())
        .flat_map(|bytes| bytes.into_iter())
        .collect::<Vec<_>>();
    run_chd_round_trip("audio.bin", &source, "flac", "disc.bin");
}

#[test]
fn chd_compress_and_extract_avhuff_round_trip() {
    let temp = setup_temp_dir();
    let source = build_test_chav_stream(4, 32, 16);
    fs::write(temp.child("video.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "avhu",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let compress_json = parse_single_json_line(&compress_output);
    assert_eq!(compress_json["status"], "succeeded");
    assert!(
        compress_json["label"]
            .as_str()
            .expect("label")
            .contains("avhuff")
    );

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
        fs::read(out_dir.child("disc.avi").path()).expect("extract bytes"),
        source
    );
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
fn chd_extract_split_bin_forces_per_track_outputs_and_reports_emitted_files() {
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

    let out_dir = temp.child("extract-split");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
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
    let label = extract_json["label"].as_str().expect("label");
    assert!(label.contains("splitbin=true"));
    assert!(label.contains("emitted_files=disc.cue,disc.track01.bin,disc.track02.bin"));

    assert!(out_dir.child("disc.cue").path().exists());
    assert!(out_dir.child("disc.track01.bin").path().exists());
    assert!(out_dir.child("disc.track02.bin").path().exists());
    assert!(!out_dir.child("disc.bin").path().exists());
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("FILE \"disc.track01.bin\" BINARY"));
    assert!(cue.contains("FILE \"disc.track02.bin\" BINARY"));
}

#[test]
fn chd_extract_split_bin_selecting_cue_fanouts_track_outputs() {
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

    let out_dir = temp.child("extract-selected-cue");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--select",
            "disc.cue",
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
    let label = extract_json["label"].as_str().expect("label");
    assert!(label.contains("splitbin=true"));

    assert!(out_dir.child("disc.cue").path().exists());
    assert!(out_dir.child("disc.track01.bin").path().exists());
    assert!(out_dir.child("disc.track02.bin").path().exists());
    assert!(!out_dir.child("disc.bin").path().exists());
}

#[test]
fn chd_extract_split_bin_rejects_non_cd_media() {
    let temp = setup_temp_dir();
    let source = (0..16_384)
        .map(|index| (index % 223) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

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

    let out_dir = temp.child("selected");
    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "chd");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("only supported for cd media")
    );
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
fn extract_split_bin_non_chd_is_ignored_with_warning() {
    let temp = setup_temp_dir();
    let expected = b"zip payload for extract split-bin ignore test".to_vec();
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
            "--split-bin",
            "--select",
            "disc.iso",
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
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("ignored --split-bin for non-CHD input")
    );
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extract"),
        expected
    );
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
fn chd_compress_accepts_level_for_supported_codecs() {
    let source = (0..16_384)
        .map(|index| (index % 199) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("disc.bin", &source, "zstd:5", "disc.bin");
}

#[test]
fn chd_compress_accepts_cd_codec_aliases() {
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
            "cdlz",
            "--json",
        ])
        .assert()
        .code(0);

    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", chd_path.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let inspect_json = parse_single_json_line(&inspect_output);
    assert_eq!(inspect_json["command"], "inspect");
    assert_eq!(inspect_json["status"], "succeeded");
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=cdlz")
    );

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
}

#[test]
fn chd_compress_rejects_level_for_unsupported_codecs() {
    let temp = setup_temp_dir();
    let source = (0..16_384)
        .map(|index| (index % 179) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "huffman:3",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("does not accept --level")
    );
}

#[test]
fn chd_extract_selects_cd_outputs() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 157) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
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

    let selected_bin_out = temp.child("selected-bin");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.bin",
            "--out-dir",
            selected_bin_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(selected_bin_out.child("disc.bin").path()).expect("extract bytes"),
        source
    );
    assert!(!selected_bin_out.child("disc.cue").path().exists());

    let selected_cue_out = temp.child("selected-cue");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.cue",
            "--out-dir",
            selected_cue_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert!(selected_cue_out.child("disc.cue").path().exists());
    assert_eq!(
        fs::read(selected_cue_out.child("disc.bin").path()).expect("extract bytes"),
        source
    );
}

#[test]
fn chd_extract_selects_raw_output_and_rejects_missing_selection() {
    let temp = setup_temp_dir();
    let source = (0..16_384)
        .map(|index| (index % 223) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

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

    let out_dir = temp.child("selected");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.bin",
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

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "missing.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "chd");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn chd_extract_selecting_gdi_descriptor_includes_tracks() {
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
            "--select",
            "disc.gdi",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert!(out_dir.child("disc.gdi").path().exists());
    assert_eq!(
        fs::read(out_dir.child("disc.track01.bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc.track02.bin").path()).expect("extract track02"),
        track02
    );
}

#[test]
fn gcz_inspect_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_gcz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.gcz").path());

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("disc.gcz").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "gcz");
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
fn gcz_extract_round_trips_to_iso() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_gcz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.gcz").path());

    let out_dir = temp.child("extract");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.gcz").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "gcz");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn gcz_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_gcz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.gcz").path());

    let selected_out = temp.child("selected");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            selected_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(selected_out.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--out-dir",
            selected_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "gcz");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
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
            "lzma2:6",
            "--threads",
            "8",
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
    assert_eq!(compress_json["requested_threads"], 8);
    assert_eq!(compress_json["effective_threads"], 8);
    assert_eq!(compress_json["used_parallelism"], true);
    assert_eq!(compress_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            rvz_path.path().to_str().expect("path"),
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
    assert_eq!(extract_json["format"], "rvz");
    assert_eq!(extract_json["requested_threads"], 8);
    assert_eq!(extract_json["effective_threads"], 8);
    assert_eq!(extract_json["used_parallelism"], true);
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
            "store:1",
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
fn rvz_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_rvz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.rvz").path());

    let out_dir = temp.child("selected");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "rvz");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
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
            "zstd:5",
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
            "zstd:4",
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
fn z3ds_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let source = (0..65_536)
        .map(|index| (index % 199) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("disc.z3ds");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd:4",
            "--json",
        ])
        .assert()
        .code(0);

    let selected_out = temp.child("selected");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            z3ds_path.path().to_str().expect("path"),
            "--select",
            "disc.3ds",
            "--out-dir",
            selected_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(selected_out.child("disc.3ds").path()).expect("extracted 3ds"),
        source
    );

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            z3ds_path.path().to_str().expect("path"),
            "--select",
            "missing.3ds",
            "--out-dir",
            selected_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "z3ds");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
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
            "zstd:4",
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
            "--no-compress",
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
fn patch_apply_defaults_to_compressed_output_and_appends_extension() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output_base = temp.child("patched-output");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
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
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as 7z"));
    assert!(apply_label.contains("auto format=7z reason=fallback-7z-lzma2"));

    let compressed_path = temp.child("patched-output.7z");
    assert!(compressed_path.path().exists());
    assert!(!output_base.path().exists());

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            compressed_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    assert_eq!(
        read_single_file_bytes(out_dir.path()),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_auto_prefers_outer_input_container_format() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let input_zip = temp.child("input.zip");
    let output_base = temp.child("patched-out");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            input_zip.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            input_zip.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
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
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as zip"));
    assert!(apply_label.contains("auto format=zip reason=outer-input-container"));

    let compressed_path = temp.child("patched-out.zip");
    assert!(compressed_path.path().exists());
    assert!(!output_base.path().exists());

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            compressed_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    assert_eq!(
        read_single_file_bytes(out_dir.path()),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_accepts_explicit_compress_format_and_codec() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output_base = temp.child("patched");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--compress-format",
            "zip",
            "--compress-codec",
            "deflate",
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
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as zip"));
    assert!(apply_label.contains("codec=deflate"));
    assert!(apply_label.contains("explicit format=zip"));

    let compressed_path = temp.child("patched.zip");
    assert!(compressed_path.path().exists());
    assert!(!output_base.path().exists());
}

#[test]
fn patch_apply_rejects_no_compress_with_compress_flags() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

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
            "--no-compress",
            "--compress-format",
            "zip",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "failed");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("--no-compress cannot be combined with --compress-format")
    );
}

#[test]
fn patch_apply_applies_multiple_patches_in_order() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let intermediate = temp.child("intermediate.bin");
    let expected = temp.child("expected.bin");
    let first_patch = temp.child("update-step-1.bps");
    let second_patch = temp.child("update-step-2.ips");
    let output = temp.child("output.bin");

    fs::write(input.path(), b"abcabcabcabc").expect("fixture");
    fs::write(intermediate.path(), b"abcabcZZabcabc").expect("fixture");
    fs::write(expected.path(), b"abcabcYYabcabc").expect("fixture");
    fs::write(first_patch.path(), SIMPLE_BPS_PATCH).expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            intermediate.path().to_str().expect("path"),
            "--modified",
            expected.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            second_patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            first_patch.path().to_str().expect("path"),
            "--patch",
            second_patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&apply_output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("applied 2 patches sequentially")
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(expected.path()).expect("expected")
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ips32_patch() {
    let temp = setup_temp_dir();
    write_sparse_bytes(
        temp.child("input.bin").path(),
        0x0100_0002,
        0x0100_0000,
        b"ab",
    );
    fs::write(
        temp.child("update.ips32").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0001,
            data: b"Z".to_vec(),
        }]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips32").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
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
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 8);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), 0x0100_0002);
    assert_eq!(output_bytes[0x0100_0000], b'a');
    assert_eq!(output_bytes[0x0100_0001], b'Z');
}

#[test]
fn patch_apply_succeeds_for_ips32_patch_with_ips_extension() {
    let temp = setup_temp_dir();
    write_sparse_bytes(
        temp.child("input.bin").path(),
        0x0100_0002,
        0x0100_0000,
        b"ab",
    );
    fs::write(
        temp.child("update.ips").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0001,
            data: b"Z".to_vec(),
        }]),
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
            "--no-compress",
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
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), 0x0100_0002);
    assert_eq!(output_bytes[0x0100_0000], b'a');
    assert_eq!(output_bytes[0x0100_0001], b'Z');
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
            "--no-compress",
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
fn patch_create_succeeds_for_ips32_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ips32");
    let output = temp.child("output.bin");
    write_sparse_bytes(original.path(), 0x0100_0002, 0x0100_0000, b"ab");
    write_sparse_bytes(modified.path(), 0x0100_0002, 0x0100_0000, b"aZ");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips32",
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
    assert_eq!(create_json["format"], "IPS32");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert!(patch_bytes.starts_with(b"IPS32"));
    assert!(patch_bytes.ends_with(b"EEOF"));

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
            "--no-compress",
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
    assert_eq!(apply_json["format"], "IPS32");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output")[0x0100_0000], b'a');
    assert_eq!(fs::read(output.path()).expect("output")[0x0100_0001], b'Z');
}

#[test]
fn patch_apply_succeeds_for_valid_ebp_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.ebp").path(),
        build_ebp_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                TestIpsRecord::Rle {
                    offset: 7,
                    len: 2,
                    value: b'!',
                },
            ],
            r#"{"patcher":"EBPatcher","Title":"Smoke"}"#,
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
            temp.child("update.ebp").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
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
    assert_eq!(json["format"], "EBP");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abXYZfg!!"
    );
}

#[test]
fn patch_create_succeeds_for_ebp_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.ebp");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ebp",
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
    assert_eq!(create_json["format"], "EBP");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert!(patch_bytes.ends_with(
        br#"{"patcher":"EBPatcher","Author":"Unknown","Description":"No description","Title":"Untitled"}"#
    ));

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
            "--no-compress",
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
    assert_eq!(apply_json["format"], "EBP");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_succeeds_for_valid_spatch_patch() {
    let temp = setup_temp_dir();
    let base_input = b"abcdefgh".to_vec();
    let headered_input = with_header(&base_input);
    fs::write(temp.child("input.bin").path(), &headered_input).expect("fixture");
    fs::write(
        temp.child("update.spatch").path(),
        build_spatch_patch(
            build_ips_patch(
                vec![TestIpsRecord::Literal {
                    offset: 0,
                    data: b"Z".to_vec(),
                }],
                Some(headered_input.len() as u32),
            ),
            build_ips_patch(
                vec![TestIpsRecord::Literal {
                    offset: 512,
                    data: b"Z".to_vec(),
                }],
                Some(headered_input.len() as u32),
            ),
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
            temp.child("update.spatch").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
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
    assert_eq!(json["format"], "SPATCH");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes[0], 0);
    assert_eq!(output_bytes[512], b'Z');
}

#[test]
fn patch_apply_succeeds_for_spatch_patch_with_ips_extension() {
    let temp = setup_temp_dir();
    let base_input = b"abcdefgh".to_vec();
    let headered_input = with_header(&base_input);
    fs::write(temp.child("input.bin").path(), &headered_input).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_spatch_patch(
            build_ips_patch(
                vec![TestIpsRecord::Literal {
                    offset: 0,
                    data: b"Z".to_vec(),
                }],
                Some(headered_input.len() as u32),
            ),
            build_ips_patch(
                vec![TestIpsRecord::Literal {
                    offset: 512,
                    data: b"Z".to_vec(),
                }],
                Some(headered_input.len() as u32),
            ),
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
            "--no-compress",
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
    assert_eq!(json["format"], "SPATCH");
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes[0], 0);
    assert_eq!(output_bytes[512], b'Z');
}

#[test]
fn patch_apply_supports_strip_and_add_header_flags() {
    let temp = setup_temp_dir();
    let base = b"abcdefgh".to_vec();
    let headered = with_header(&base);
    fs::write(temp.child("input.bin").path(), &headered).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"Z".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");

    let stripped_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-stripped.bin")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let stripped_json = parse_single_json_line(&stripped_output);
    assert_eq!(stripped_json["command"], "patch-apply");
    assert_eq!(stripped_json["family"], "patch");
    assert_eq!(stripped_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-stripped.bin").path()).expect("output"),
        b"Zbcdefgh".to_vec()
    );

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-headered.bin")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--add-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(headered_json["command"], "patch-apply");
    assert_eq!(headered_json["family"], "patch");
    assert_eq!(headered_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-headered.bin").path()).expect("output"),
        with_header(b"Zbcdefgh")
    );
}

#[test]
fn patch_apply_supports_nes_header_strip_and_add_flags() {
    let temp = setup_temp_dir();
    let base = b"abcdefgh".to_vec();
    let headered = with_nes_header(&base);
    fs::write(temp.child("input.nes").path(), &headered).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"Z".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");

    let stripped_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-stripped.nes")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let stripped_json = parse_single_json_line(&stripped_output);
    assert_eq!(stripped_json["command"], "patch-apply");
    assert_eq!(stripped_json["family"], "patch");
    assert_eq!(stripped_json["status"], "succeeded");
    assert!(
        stripped_json["label"]
            .as_str()
            .expect("label")
            .contains("input header stripped (16 bytes, No-Intro_NES.xml)")
    );
    assert_eq!(
        fs::read(temp.child("output-stripped.nes").path()).expect("output"),
        b"Zbcdefgh".to_vec()
    );

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-headered.nes")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--add-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(headered_json["command"], "patch-apply");
    assert_eq!(headered_json["family"], "patch");
    assert_eq!(headered_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-headered.nes").path()).expect("output"),
        with_nes_header(b"Zbcdefgh")
    );
}

#[test]
fn patch_apply_repair_checksum_repairs_genesis_header() {
    let temp = setup_temp_dir();
    let mut input = vec![0_u8; 0x260];
    input[0x100..0x104].copy_from_slice(b"SEGA");
    fs::write(temp.child("input.bin").path(), &input).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0x200,
                data: vec![0x12, 0x34, 0x56],
            }],
            Some(input.len() as u32),
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
            "--repair-checksum",
            "--no-compress",
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
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("repaired checksum (sega-genesis)")
    );

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    let expected = sega_genesis_checksum(&output_bytes);
    let actual = u16::from_be_bytes([output_bytes[0x18E], output_bytes[0x18F]]);
    assert_eq!(actual, expected);
}

#[test]
fn patch_apply_repair_checksum_rejects_unsupported_targets() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"plain-bytes").expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![0x41],
            }],
            Some(10),
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
            "--repair-checksum",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("could not auto-detect a supported checksum header")
    );
}

#[test]
fn patch_apply_succeeds_for_valid_solid_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"abcdefghij").expect("fixture");
    fs::write(modified.path(), b"abCDfgh").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "solid",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output_bytes = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output_bytes);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "SOLID");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_spatch_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.spatch");
    let output = temp.child("output.bin");
    let headered_input = temp.child("old-headered.bin");
    let headered_output = temp.child("output-headered.bin");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1cdefgh!").expect("fixture");
    fs::write(headered_input.path(), with_header(b"abcdefgh")).expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "spatch",
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
    assert_eq!(create_json["format"], "SPATCH");
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
            "--no-compress",
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
    assert_eq!(apply_json["format"], "SPATCH");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    let apply_headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            headered_input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            headered_output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_headered_json = parse_single_json_line(&apply_headered_output);
    assert_eq!(apply_headered_json["command"], "patch-apply");
    assert_eq!(apply_headered_json["family"], "patch");
    assert_eq!(apply_headered_json["format"], "SPATCH");
    assert_eq!(apply_headered_json["status"], "succeeded");
    assert_eq!(
        fs::read(headered_output.path()).expect("output"),
        with_header(&fs::read(modified.path()).expect("modified"))
    );
}

#[test]
fn patch_create_succeeds_for_solid_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"1234567890abcdef").expect("fixture");
    fs::write(modified.path(), b"1234XY7890abc!").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "solid",
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
    assert_eq!(create_json["format"], "SOLID");
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
            "--no-compress",
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
    assert_eq!(apply_json["format"], "SOLID");
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
            "--no-compress",
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
            "--no-compress",
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
fn patch_apply_auto_extracts_single_payload_by_default() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("input.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
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
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("patch apply input source resolved via 1 container extract step(s)")
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_no_extract_uses_raw_container_bytes() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("input.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-extract",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "failed");
    assert!(
        !apply_json["label"]
            .as_str()
            .expect("label")
            .contains("patch apply input source resolved via")
    );
}

#[test]
fn patch_apply_auto_extract_ambiguity_requires_select() {
    let temp = setup_temp_dir();
    let alpha = temp.child("alpha.bin");
    let alpha_modified = temp.child("alpha-modified.bin");
    let beta = temp.child("beta.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("bundle.zip");
    let output = temp.child("output.bin");
    fs::write(alpha.path(), b"alpha payload").expect("alpha fixture");
    fs::write(alpha_modified.path(), b"alpha payload patched").expect("alpha modified fixture");
    fs::write(beta.path(), b"beta payload").expect("beta fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            alpha.path().to_str().expect("path"),
            "--modified",
            alpha_modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            alpha.path().to_str().expect("path"),
            beta.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["status"], "failed");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("alpha.bin"));
    assert!(label.contains("beta.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn patch_apply_auto_extract_pbp_multi_disc_requires_select() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 53);
    let mut disc1_modified = disc1.clone();
    disc1_modified[2048..2065].copy_from_slice(b"patched-disc1-rom");
    let disc2 = build_test_pbp_iso(80, 71);
    let patch_source = temp.child("disc1.bin");
    let patch_target = temp.child("disc1-modified.bin");
    fs::write(patch_source.path(), &disc1).expect("disc1");
    fs::write(patch_target.path(), &disc1_modified).expect("disc1 modified");

    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let patch = temp.child("update.bps");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            patch_source.path().to_str().expect("path"),
            "--modified",
            patch_target.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = temp.child("output.bin");
    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            source.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "failed");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("multi.disc01.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn patch_apply_auto_extract_select_resolves_ambiguity() {
    let temp = setup_temp_dir();
    let alpha = temp.child("alpha.bin");
    let alpha_modified = temp.child("alpha-modified.bin");
    let beta = temp.child("beta.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("bundle.zip");
    let output = temp.child("output.bin");
    fs::write(alpha.path(), b"alpha payload").expect("alpha fixture");
    fs::write(alpha_modified.path(), b"alpha payload patched").expect("alpha modified fixture");
    fs::write(beta.path(), b"beta payload").expect("beta fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            alpha.path().to_str().expect("path"),
            "--modified",
            alpha_modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            alpha.path().to_str().expect("path"),
            beta.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--select",
            "alpha.bin",
            "--no-compress",
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
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("patch apply input source resolved via 1 container extract step(s)")
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(alpha_modified.path()).expect("alpha modified")
    );
}

#[test]
fn patch_apply_auto_extract_ignores_sidecars_unless_no_ignore() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified = temp.child("game-modified.bin");
    let sidecar_txt = temp.child("notes.txt");
    let sidecar_json = temp.child("meta.json");
    let patch = temp.child("update.bps");
    let archive = temp.child("bundle.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"game payload").expect("fixture");
    fs::write(modified.path(), b"game payload patched").expect("fixture");
    fs::write(sidecar_txt.path(), b"ignore txt").expect("fixture");
    fs::write(sidecar_json.path(), b"{}").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            sidecar_txt.path().to_str().expect("path"),
            sidecar_json.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let default_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let default_json = parse_single_json_line(&default_output);
    assert_eq!(default_json["command"], "patch-apply");
    assert_eq!(default_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    let no_ignore_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-ignore",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let no_ignore_json = parse_single_json_line(&no_ignore_output);
    assert_eq!(no_ignore_json["command"], "patch-apply");
    assert_eq!(no_ignore_json["status"], "failed");
    let no_ignore_label = no_ignore_json["label"].as_str().expect("label");
    assert!(no_ignore_label.contains("ambiguous"));
    assert!(no_ignore_label.contains("--select"));
}

#[test]
fn patch_apply_can_ignore_checksum_validation_for_bps() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let mismatched_input = temp.child("old-mismatch.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");
    fs::write(mismatched_input.path(), b"hello zld world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    let strict_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            mismatched_input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let strict_json = parse_single_json_line(&strict_output);
    assert_eq!(strict_json["command"], "patch-apply");
    assert_eq!(strict_json["family"], "patch");
    assert_eq!(strict_json["format"], "BPS");
    assert_eq!(strict_json["status"], "failed");
    assert!(
        strict_json["label"]
            .as_str()
            .expect("label")
            .contains("Input checksum invalid")
    );

    let ignored_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            mismatched_input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let ignored_json = parse_single_json_line(&ignored_output);
    assert_eq!(ignored_json["command"], "patch-apply");
    assert_eq!(ignored_json["family"], "patch");
    assert_eq!(ignored_json["format"], "BPS");
    assert_eq!(ignored_json["status"], "succeeded");
    assert!(
        ignored_json["label"]
            .as_str()
            .expect("label")
            .contains("checksum validation skipped")
    );
}

#[test]
fn patch_apply_accepts_multiple_validate_with_checksum_values() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    let input_crc32 = checksum_value(original.path(), "crc32");
    let input_sha1 = checksum_value(original.path(), "sha1");

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
            "--validate-with-checksum",
            &format!("crc32={input_crc32}"),
            "--validate-with-checksum",
            &format!("sha1={input_sha1}"),
            "--no-compress",
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
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("input checksum(s) verified"));
    assert!(label.contains("crc32="));
    assert!(label.contains("sha1="));
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_fails_on_mismatched_validate_with_checksum_value() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

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
            "--validate-with-checksum",
            "crc32=00000000",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["status"], "failed");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("input checksum mismatch for crc32")
    );
}

#[test]
fn patch_apply_uses_checksum_cache_for_validation() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

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
            "--checksum-cache",
            "sha1=0000000000000000000000000000000000000000",
            "--validate-with-checksum",
            "sha1=0000000000000000000000000000000000000000",
            "--no-compress",
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
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("input checksum(s) verified"));
    assert!(label.contains("sha1=0000000000000000000000000000000000000000"));
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn inspect_patch_reports_expected_checksums_for_bps() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
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
            "--json",
        ])
        .assert()
        .code(0);

    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let inspect_json = parse_single_json_line(&inspect_output);
    assert_eq!(inspect_json["command"], "inspect");
    assert_eq!(inspect_json["family"], "patch");
    assert_eq!(inspect_json["format"], "BPS");
    assert_eq!(inspect_json["status"], "succeeded");
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("source crc32")
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
fn patch_create_succeeds_for_dldi_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.nds");
    let seed_patch = temp.child("seed.dldi");
    let modified = temp.child("new.nds");
    let patch = temp.child("update.dldi");
    let output = temp.child("output.nds");

    fs::write(
        original.path(),
        build_nds_with_dldi_slot(0x300, 12, 0x0200_0000, "Default driver"),
    )
    .expect("fixture");
    fs::write(
        seed_patch.path(),
        build_dldi_driver(8, 0xBF80_0000u32 as i32, "Roundtrip driver"),
    )
    .expect("fixture");

    let seed_apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            seed_patch.path().to_str().expect("path"),
            "--output",
            modified.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let seed_apply_json = parse_single_json_line(&seed_apply_output);
    assert_eq!(seed_apply_json["command"], "patch-apply");
    assert_eq!(seed_apply_json["family"], "patch");
    assert_eq!(seed_apply_json["format"], "DLDI");
    assert_eq!(seed_apply_json["requested_threads"], 8);
    assert_eq!(seed_apply_json["effective_threads"], 1);
    assert_eq!(seed_apply_json["used_parallelism"], false);
    assert_eq!(seed_apply_json["status"], "succeeded");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "dldi",
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
    assert_eq!(create_json["format"], "DLDI");
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
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "DLDI");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_dps_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.dps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world + dps").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "dps",
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
    assert_eq!(create_json["format"], "DPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");
    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert!(patch_bytes.len() >= 198);
    assert_eq!(patch_bytes[193], 1);
    assert_ne!(&patch_bytes[..2], b"PK");
    assert_eq!(
        u32::from_le_bytes([
            patch_bytes[194],
            patch_bytes[195],
            patch_bytes[196],
            patch_bytes[197],
        ]),
        15
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
            "--no-compress",
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
    assert_eq!(apply_json["format"], "DPS");
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
            "--no-compress",
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
fn inspect_succeeds_for_valid_dldi_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.dldi").path(),
        build_dldi_driver(8, 0xBF80_0000u32 as i32, "Inspect driver"),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.dldi").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "DLDI");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_succeeds_for_valid_dps_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("update.dps");
    fs::write(original.path(), b"01234567").expect("fixture");
    fs::write(modified.path(), b"0123ZZ67").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "dps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "DPS");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_succeeds_for_valid_ebp_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ebp").path(),
        build_ebp_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"A".to_vec(),
            }],
            r#"{"patcher":"EBPatcher","Title":"Inspect"}"#,
        ),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.ebp").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "EBP");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_succeeds_for_valid_ips32_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ips32").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"A".to_vec(),
        }]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.ips32").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_succeeds_for_ips32_patch_with_ips_extension() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ips").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"A".to_vec(),
        }]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.ips").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_succeeds_for_spatch_patch_with_ips_extension() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ips").path(),
        build_spatch_patch(
            build_ips_patch(
                vec![TestIpsRecord::Literal {
                    offset: 0,
                    data: b"A".to_vec(),
                }],
                None,
            ),
            build_ips_patch(
                vec![TestIpsRecord::Literal {
                    offset: 1,
                    data: b"B".to_vec(),
                }],
                None,
            ),
        ),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("update.ips").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "SPATCH");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_succeeds_for_valid_solid_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("update.solid");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"abcZefgh").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "solid",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "SOLID");
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
    // Signature-based probing routes APS1 payloads to APSGBA even if extension is .aps.
    assert_eq!(json["format"], "APSGBA");
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
            "--no-compress",
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
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("recommended_compress_format=chd"));
    assert!(label.contains("reason=not-wii-gc-or-unrecognized"));
}
