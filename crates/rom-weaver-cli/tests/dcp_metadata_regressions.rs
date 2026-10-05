use rom_weaver_app::dcp::{ZipEntry, extract_entry};
use std::io::Cursor;

fn stored_entry(declared_size: u32) -> (Cursor<Vec<u8>>, ZipEntry) {
    // Independent minimal local ZIP header, followed by one literal byte.
    // CRC32("A") = 0xd3d99e8b; no production encoder constructs this fixture.
    let mut bytes = vec![0u8; 30];
    bytes[..4].copy_from_slice(&0x0403_4b50u32.to_le_bytes());
    bytes[4..6].copy_from_slice(&20u16.to_le_bytes());
    bytes[14..18].copy_from_slice(&0xd3d9_9e8bu32.to_le_bytes());
    bytes[18..22].copy_from_slice(&1u32.to_le_bytes());
    bytes[22..26].copy_from_slice(&declared_size.to_le_bytes());
    bytes[26..28].copy_from_slice(&5u16.to_le_bytes());
    bytes.extend_from_slice(b"a.binA");
    let entry = ZipEntry {
        name: "a.bin".into(),
        compressed_size: 1,
        uncompressed_size: declared_size,
        crc32: 0xd3d9_9e8b,
        method: 0,
        local_header_offset: 0,
    };
    (Cursor::new(bytes), entry)
}

#[test]
fn stored_entry_rejects_mismatched_uncompressed_size() {
    for declared in [0, 2, u32::MAX - 1] {
        let (mut reader, entry) = stored_entry(declared);
        assert!(
            extract_entry(&mut reader, &entry).is_err(),
            "stored size mismatch must be rejected: declared={declared}, actual=1"
        );
    }
}

#[test]
fn stored_entry_accepts_the_exact_declared_size() {
    let (mut reader, entry) = stored_entry(1);
    assert_eq!(extract_entry(&mut reader, &entry).unwrap(), b"A");
}
