use super::shared::*;

use rom_weaver_checksum::identify_catalog::IdentifySource;
use rom_weaver_checksum::identify_pack_types::{
    PackComponent, PackComponentRole, PackGame, UpstreamSource,
};

fn rwfp1_pack(entries: &[([u8; 4], &str)]) -> Vec<u8> {
    rwfp1_pack_with_size(entries, 5)
}

fn rwfp1_pack_with_size(entries: &[([u8; 4], &str)], size: u64) -> Vec<u8> {
    let games = entries
        .iter()
        .map(|(crc, name)| PackGame {
            name: (*name).to_string(),
            platform: "Test System".to_string(),
            source: IdentifySource::Libretro,
            upstream_source: UpstreamSource::Libretro,
            provenance: Vec::new(),
            legacy_variant: false,
            dump_tags: Vec::new(),
            game_id: None,
            region: None,
            language: None,
            disc_number: None,
            revision: None,
            parent: None,
            components: vec![PackComponent {
                role: PackComponentRole::PrimaryPayload,
                ordinal: 0,
                hash_scope: "full_file".to_string(),
                filename: None,
                size,
                crc32: Some(crc.iter().map(|byte| format!("{byte:02x}")).collect()),
                md5: None,
                sha1: None,
                sha256: None,
                required: true,
                discriminating: true,
                track: None,
                session: None,
            }],
        })
        .collect();
    rom_weaver_checksum::identify_pack_v1::encode(
        "Test System",
        IdentifySource::Libretro,
        "full_file",
        &serde_json::json!([]),
        games,
    )
    .expect("RWFP1 pack")
}

pub(crate) fn identify_pack_with_crc_size(crc32: [u8; 4], size: u64, name: &str) -> Vec<u8> {
    rwfp1_pack_with_size(&[(crc32, name)], size)
}

pub(crate) fn identify_pack_with_sized_entries(entries: &[([u8; 4], u64, &str)]) -> Vec<u8> {
    let games = entries
        .iter()
        .map(|(crc32, size, name)| PackGame {
            name: (*name).to_string(),
            platform: "Test System".to_string(),
            source: IdentifySource::Libretro,
            upstream_source: UpstreamSource::Libretro,
            provenance: Vec::new(),
            legacy_variant: false,
            dump_tags: Vec::new(),
            game_id: None,
            region: None,
            language: None,
            disc_number: None,
            revision: None,
            parent: None,
            components: vec![PackComponent {
                role: PackComponentRole::PrimaryPayload,
                ordinal: 0,
                hash_scope: "full_file".to_string(),
                filename: None,
                size: *size,
                crc32: Some(crc32.iter().map(|byte| format!("{byte:02x}")).collect()),
                md5: None,
                sha1: None,
                sha256: None,
                required: true,
                discriminating: true,
                track: None,
                session: None,
            }],
        })
        .collect();
    rom_weaver_checksum::identify_pack_v1::encode(
        "Test System",
        IdentifySource::Libretro,
        "full_file",
        &serde_json::json!([]),
        games,
    )
    .expect("RWFP1 pack")
}

/// A pack naming several ROMs by CRC32, for the archive tests where each member
/// needs its own verdict.
pub(crate) fn identify_pack_with_entries(entries: &[([u8; 4], &str)]) -> Vec<u8> {
    rwfp1_pack(entries)
}

fn identify_pack_with_hashes(crc32: [u8; 4], md5: [u8; 16], sha1: [u8; 20], name: &str) -> Vec<u8> {
    let game = PackGame {
        name: name.to_string(),
        platform: "Test System".to_string(),
        source: IdentifySource::Libretro,
        upstream_source: UpstreamSource::Libretro,
        provenance: Vec::new(),
        legacy_variant: false,
        dump_tags: Vec::new(),
        game_id: None,
        region: None,
        language: None,
        disc_number: None,
        revision: None,
        parent: None,
        components: vec![PackComponent {
            role: PackComponentRole::PrimaryPayload,
            ordinal: 0,
            hash_scope: "full_file".to_string(),
            filename: None,
            size: 5,
            crc32: Some(crc32.iter().map(|byte| format!("{byte:02x}")).collect()),
            md5: Some(md5.iter().map(|byte| format!("{byte:02x}")).collect()),
            sha1: Some(sha1.iter().map(|byte| format!("{byte:02x}")).collect()),
            sha256: None,
            required: true,
            discriminating: true,
            track: None,
            session: None,
        }],
    };
    rom_weaver_checksum::identify_pack_v1::encode(
        "Test System",
        IdentifySource::Libretro,
        "full_file",
        &serde_json::json!([]),
        vec![game],
    )
    .expect("RWFP1 pack")
}

pub(crate) fn identify_pack_with_crc(crc32: [u8; 4], name: &str) -> Vec<u8> {
    identify_pack_with_hashes(
        crc32,
        [
            0x5d, 0x41, 0x40, 0x2a, 0xbc, 0x4b, 0x2a, 0x76, 0xb9, 0x71, 0x9d, 0x91, 0x10, 0x17,
            0xc5, 0x92,
        ],
        [
            0xaa, 0xf4, 0xc6, 0x1d, 0xdc, 0xc5, 0xe8, 0xa2, 0xda, 0xbe, 0xde, 0x0f, 0x3b, 0x48,
            0x2c, 0xd9, 0xae, 0xa9, 0x43, 0x4d,
        ],
        name,
    )
}

pub(crate) fn identify_pack_with_md5(md5: [u8; 16], name: &str) -> Vec<u8> {
    identify_pack_with_hashes(
        [0x36, 0x10, 0xa6, 0x86],
        md5,
        [
            0xaa, 0xf4, 0xc6, 0x1d, 0xdc, 0xc5, 0xe8, 0xa2, 0xda, 0xbe, 0xde, 0x0f, 0x3b, 0x48,
            0x2c, 0xd9, 0xae, 0xa9, 0x43, 0x4d,
        ],
        name,
    )
}

fn identify_pack() -> Vec<u8> {
    identify_pack_with_crc([0x36, 0x10, 0xa6, 0x86], "Hello World (Test) [!]")
}

#[test]
fn identify_matches_an_external_pack() {
    let temp = setup_temp_dir();
    fs::write(temp.child("hello.bin").path(), b"hello").expect("ROM fixture");
    fs::write(temp.child("test.pack").path(), identify_pack()).expect("identify pack");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("hello.bin").path().to_str().expect("ROM path"),
            "--database",
            temp.child("test.pack").path().to_str().expect("pack path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(json["command"], "identify");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(identify["status"], "matched");
    assert_eq!(identify["matches"][0]["name"], "Hello World (Test) [!]");
    assert_eq!(identify["matches"][0]["platform"], "Test System");
    assert_eq!(identify["matches"][0]["algorithm"], "components");
    assert_eq!(identify["matches"][0]["variant"], "raw");
}

#[test]
fn identify_uses_built_in_packs_by_default() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("unknown.bin").path(),
        b"rom-weaver unknown fixture",
    )
    .expect("ROM fixture");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("unknown.bin").path().to_str().expect("ROM path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);

    assert_eq!(json["command"], "identify");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["identify"]["status"], "unknown");
    assert_eq!(
        json["details"]["identify"]["matches"],
        serde_json::json!([])
    );
}

#[test]
fn identify_reads_a_rom_from_stdin() {
    let temp = setup_temp_dir();
    fs::write(temp.child("test.pack").path(), identify_pack()).expect("identify pack");

    let output = command_stdout_with_stdin(
        &[
            "identify",
            "--input",
            "-",
            "--database",
            temp.child("test.pack").path().to_str().expect("pack path"),
            "--json",
        ],
        b"hello",
        0,
    );
    let json = parse_single_json_line(&output);

    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["identify"]["status"], "matched");
    assert_eq!(json["details"]["identify"]["matches"][0]["variant"], "raw");
}

#[test]
fn identify_matches_a_manual_hash() {
    let temp = setup_temp_dir();
    fs::write(temp.child("test.pack").path(), identify_pack()).expect("identify pack");

    let output = command_stdout(
        &[
            "identify",
            "--hash",
            "3610A686",
            "--database",
            temp.child("test.pack").path().to_str().expect("pack path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(json["command"], "identify");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(identify["status"], "matched");
    assert_eq!(identify["input"], "3610a686");
    assert_eq!(identify["checksums"]["crc32"], "3610a686");
    assert_eq!(identify["matches"][0]["name"], "Hello World (Test) [!]");
    assert_eq!(identify["matches"][0]["algorithm"], "components");
    assert_eq!(identify["matches"][0]["variant"], "manual");
}

#[test]
fn identify_reports_an_unknown_manual_hash() {
    let temp = setup_temp_dir();
    fs::write(temp.child("test.pack").path(), identify_pack()).expect("identify pack");

    let output = command_stdout(
        &[
            "identify",
            "--hash",
            "deadbeef",
            "--database",
            temp.child("test.pack").path().to_str().expect("pack path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);

    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["identify"]["status"], "unknown");
    assert_eq!(
        json["details"]["identify"]["matches"],
        serde_json::json!([])
    );
}

#[test]
fn identify_rejects_an_invalid_hash_length() {
    let output = command_stdout(&["identify", "--hash", "12345", "--json"], 1);
    let json = parse_single_json_line(&output);

    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("8 chars for crc32, 32 for md5, or 40 for sha1")
    );
}

#[test]
fn identify_requires_an_input_or_a_hash() {
    let output = command_stdout(&["identify", "--json"], 1);
    let json = parse_single_json_line(&output);

    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("exactly one of --input or --hash")
    );
}

#[test]
fn identify_matches_a_headerless_variant_inside_gzip() {
    let temp = setup_temp_dir();
    let payload = (0..4096)
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("payload.bin").path(), &payload).expect("payload fixture");
    let crc32 = u32::from_str_radix(
        &checksum_value(temp.child("payload.bin").path(), "crc32"),
        16,
    )
    .expect("CRC32")
    .to_be_bytes();
    fs::write(temp.child("headered.nes").path(), with_nes_header(&payload))
        .expect("headered ROM fixture");
    let compressed = temp.child("headered.nes.gz");
    let output = File::create(compressed.path()).expect("create gzip fixture");
    let mut encoder = GzEncoder::new(output, DeflateCompression::default());
    encoder
        .write_all(&fs::read(temp.child("headered.nes").path()).expect("read ROM fixture"))
        .expect("write gzip fixture");
    encoder.finish().expect("finish gzip fixture");
    fs::write(
        temp.child("test.pack").path(),
        rwfp1_pack_with_size(
            &[(crc32, "Compressed Header Test [!]")],
            payload.len() as u64,
        ),
    )
    .expect("identify pack");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            compressed.path().to_str().expect("ROM path"),
            "--database",
            temp.child("test.pack").path().to_str().expect("pack path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(identify["status"], "matched");
    assert_eq!(identify["matches"][0]["name"], "Compressed Header Test [!]");
    assert_eq!(identify["matches"][0]["variant"], "remove-header");
}
