#![no_main]
use libfuzzer_sys::fuzz_target;
use rom_weaver_app::gdrom::iso9660::{
    parse_directory, parse_directory_record, parse_primary_volume_descriptor,
};

fn both_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
    bytes[at + 4..at + 8].copy_from_slice(&value.to_be_bytes());
}
fn record(name: &[u8], extent: u32, length: u32, directory: bool) -> Vec<u8> {
    let size = (33 + name.len()).next_multiple_of(2);
    let mut bytes = vec![0u8; size];
    bytes[0] = size as u8;
    both_u32(&mut bytes, 2, extent);
    both_u32(&mut bytes, 10, length);
    bytes[25] = if directory { 2 } else { 0 };
    bytes[28..30].copy_from_slice(&1u16.to_le_bytes());
    bytes[30..32].copy_from_slice(&1u16.to_be_bytes());
    bytes[32] = name.len() as u8;
    bytes[33..33 + name.len()].copy_from_slice(name);
    bytes
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 4 || data.len() > 8192 {
        return;
    }
    let extent = u32::from(u16::from_le_bytes([data[0], data[1]]));
    let length = u32::from(u16::from_le_bytes([data[2], data[3]]));
    let name = format!("F{:02X}.BIN;1", data[0]);
    let valid = record(name.as_bytes(), extent, length, data[0] & 1 != 0);
    let (parsed, consumed) = parse_directory_record(&valid).unwrap().unwrap();
    assert_eq!(consumed, valid.len());
    assert_eq!(parsed.extent_lba, extent);
    assert_eq!(parsed.data_len, length);
    assert_eq!(parsed.is_dir, data[0] & 1 != 0);
    assert_eq!(parsed.name, format!("F{:02X}.BIN", data[0]));
    let mut directory = vec![0u8; 4096];
    directory[..valid.len()].copy_from_slice(&valid);
    directory[2048..2048 + valid.len()].copy_from_slice(&valid);
    assert_eq!(
        parse_directory(&directory).unwrap(),
        vec![parsed.clone(), parsed]
    );
    let root = record(&[0], extent, 2048, true);
    let mut pvd = vec![0u8; 2048];
    pvd[..7].copy_from_slice(b"\x01CD001\x01");
    both_u32(&mut pvd, 80, extent + 1);
    pvd[128..130].copy_from_slice(&2048u16.to_le_bytes());
    pvd[130..132].copy_from_slice(&2048u16.to_be_bytes());
    pvd[156..190].copy_from_slice(&root);
    let volume = parse_primary_volume_descriptor(&pvd).unwrap();
    assert_eq!(volume.logical_block_size, 2048);
    assert_eq!(volume.volume_space_size, extent + 1);
    assert_eq!(volume.root.extent_lba, extent);
    assert!(volume.root.is_dir && volume.root.is_self_or_parent());
    let prefix = usize::from(data[0]) % valid.len();
    if prefix > 0 {
        assert!(parse_directory_record(&valid[..prefix]).is_err());
    }
    assert!(parse_primary_volume_descriptor(&pvd[..usize::from(data[0])]).is_err());
    let mut mutated = valid;
    for mutation in data[4..].chunks(3) {
        if mutation.len() == 3 {
            let offset =
                usize::from(u16::from_le_bytes([mutation[0], mutation[1]])) % mutated.len();
            mutated[offset] ^= mutation[2];
        }
    }
    if let Ok(Some((entry, consumed))) = parse_directory_record(&mutated) {
        assert!((33..=mutated.len()).contains(&consumed));
        assert!(!entry.name.contains(';'));
    }
    if let Ok(entries) = parse_directory(data) {
        assert!(entries.len() <= data.len() / 33);
        assert!(
            entries
                .iter()
                .all(|entry| !entry.is_self_or_parent() && !entry.name.contains(';'))
        );
    }
    let _ = parse_primary_volume_descriptor(data);
});
