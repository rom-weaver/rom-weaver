use super::shared::*;

const PACK_MAGIC: &[u8] = b"RWFP1\0\0\0";

fn hash_member(algorithm: u8, hash: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RWH1");
    bytes.extend_from_slice(&[algorithm, 0, hash.len() as u8, 0]);
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(hash);
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes
}

fn identify_pack_with_crc(crc32: [u8; 4], name: &str) -> Vec<u8> {
    let mut pairs = Vec::new();
    pairs.extend_from_slice(b"RWHP");
    pairs.extend_from_slice(&1u16.to_le_bytes());
    pairs.extend_from_slice(&6u16.to_le_bytes());
    pairs.extend_from_slice(&0u32.to_le_bytes());
    pairs.extend_from_slice(&0u16.to_le_bytes());

    let members = [
        ("crc32.bin", hash_member(0, &crc32)),
        (
            "md5.bin",
            hash_member(
                1,
                &[
                    0x5d, 0x41, 0x40, 0x2a, 0xbc, 0x4b, 0x2a, 0x76, 0xb9, 0x71, 0x9d, 0x91, 0x10,
                    0x17, 0xc5, 0x92,
                ],
            ),
        ),
        (
            "sha1.bin",
            hash_member(
                2,
                &[
                    0xaa, 0xf4, 0xc6, 0x1d, 0xdc, 0xc5, 0xe8, 0xa2, 0xda, 0xbe, 0xde, 0x0f, 0x3b,
                    0x48, 0x2c, 0xd9, 0xae, 0xa9, 0x43, 0x4d,
                ],
            ),
        ),
        ("name-platforms.bin", pairs),
        ("names.json", serde_json::to_vec(&[name]).expect("names")),
        (
            "platforms.json",
            serde_json::to_vec(&["Test System"]).expect("platforms"),
        ),
    ];

    let mut bytes = Vec::new();
    bytes.extend_from_slice(PACK_MAGIC);
    bytes.extend_from_slice(&(members.len() as u32).to_le_bytes());
    for (name, member) in &members {
        bytes.extend_from_slice(&(name.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&(member.len() as u64).to_le_bytes());
        bytes.extend_from_slice(name.as_bytes());
    }
    for (_, member) in members {
        bytes.extend_from_slice(&member);
    }
    bytes
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
    assert_eq!(identify["matches"][0]["algorithm"], "crc32");
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
        identify_pack_with_crc(crc32, "Compressed Header Test [!]"),
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
