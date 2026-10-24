#![no_main]
use libfuzzer_sys::fuzz_target;
use rom_weaver_app::dcp::{DcpOperation, extract_entry, read_central_directory, read_manifest};
use std::io::Cursor;

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}
fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn stored_zip(name: &str, data: &[u8]) -> (Vec<u8>, usize) {
    let mut bytes = vec![0u8; 30];
    put_u32(&mut bytes, 0, 0x04034b50);
    put_u16(&mut bytes, 4, 20);
    put_u32(&mut bytes, 14, crc32fast::hash(data));
    put_u32(&mut bytes, 18, data.len() as u32);
    put_u32(&mut bytes, 22, data.len() as u32);
    put_u16(&mut bytes, 26, name.len() as u16);
    bytes.extend_from_slice(name.as_bytes());
    bytes.extend_from_slice(data);
    let central = bytes.len();
    let mut header = vec![0u8; 46];
    put_u32(&mut header, 0, 0x02014b50);
    put_u16(&mut header, 4, 20);
    put_u16(&mut header, 6, 20);
    put_u32(&mut header, 16, crc32fast::hash(data));
    put_u32(&mut header, 20, data.len() as u32);
    put_u32(&mut header, 24, data.len() as u32);
    put_u16(&mut header, 28, name.len() as u16);
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(name.as_bytes());
    let size = bytes.len() - central;
    let mut footer = vec![0u8; 22];
    put_u32(&mut footer, 0, 0x06054b50);
    put_u16(&mut footer, 8, 1);
    put_u16(&mut footer, 10, 1);
    put_u32(&mut footer, 12, size as u32);
    put_u32(&mut footer, 16, central as u32);
    bytes.extend_from_slice(&footer);
    (bytes, central)
}

fuzz_target!(|data: &[u8]| {
    if data.is_empty() || data.len() > 4096 {
        return;
    }
    let (name, kind) = match data[0] % 4 {
        0 => ("files/GAME.BIN", 0),
        1 => ("files/GAME.BIN.xdelta", 1),
        2 => ("bootsector/IP.BIN", 2),
        _ => ("files/", 3),
    };
    let payload = &data[1..];
    let (bytes, central) = stored_zip(name, payload);
    let entries = read_central_directory(&mut Cursor::new(&bytes)).expect("generated ZIP metadata");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, name);
    assert_eq!(entries[0].compressed_size as usize, payload.len());
    assert_eq!(entries[0].uncompressed_size as usize, payload.len());
    assert_eq!(
        extract_entry(&mut Cursor::new(&bytes), &entries[0]).unwrap(),
        payload
    );
    let manifest = read_manifest(&mut Cursor::new(&bytes)).unwrap();
    if kind == 3 {
        assert!(manifest.operations.is_empty());
    } else {
        assert_eq!(manifest.operations.len(), 1);
        assert_eq!(manifest.operations[0].entry(), &entries[0]);
        match &manifest.operations[0] {
            DcpOperation::Verbatim { path, .. } => {
                assert_eq!(kind, 0);
                assert_eq!(path, name);
            }
            DcpOperation::Delta { target, .. } => {
                assert_eq!(kind, 1);
                assert_eq!(target, "files/GAME.BIN");
            }
            DcpOperation::BootSector { .. } => assert_eq!(kind, 2),
        }
    }
    let mut wrong_length = entries[0].clone();
    wrong_length.uncompressed_size += 1;
    assert!(extract_entry(&mut Cursor::new(&bytes), &wrong_length).is_err());
    let mut corrupted_crc = entries[0].clone();
    corrupted_crc.crc32 ^= 1;
    assert!(extract_entry(&mut Cursor::new(&bytes), &corrupted_crc).is_err());
    let mut oversized = entries[0].clone();
    oversized.compressed_size = u32::MAX - 1;
    assert!(extract_entry(&mut Cursor::new(&bytes), &oversized).is_err());
    let mut oversized_cd = bytes.clone();
    let footer = oversized_cd.len() - 22;
    put_u32(&mut oversized_cd, footer + 12, u32::MAX - 1);
    assert!(read_central_directory(&mut Cursor::new(&oversized_cd)).is_err());
    // Arbitrary metadata mutations MUST remain bounded by this small actual archive.
    let mut mutated = bytes;
    for triplet in data[1..].chunks(3) {
        if triplet.len() == 3 {
            let offset = central
                + usize::from(u16::from_le_bytes([triplet[0], triplet[1]]))
                    % (mutated.len() - central);
            mutated[offset] ^= triplet[2];
        }
    }
    if let Ok(entries) = read_central_directory(&mut Cursor::new(&mutated)) {
        assert!(entries.len() <= mutated.len() / 46);
        for entry in entries {
            // Inflation is explored only below a declared 64KiB cap; larger metadata
            // is still parsed, but MUST not direct this harness to allocate huge output.
            if entry.uncompressed_size <= 65536 {
                if let Ok(output) = extract_entry(&mut Cursor::new(&mutated), &entry) {
                    assert_eq!(crc32fast::hash(&output), entry.crc32);
                    assert_eq!(output.len(), entry.uncompressed_size as usize);
                    assert!(output.len() <= 65536);
                }
            }
        }
    }
});
