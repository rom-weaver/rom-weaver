//! Unit coverage for the Wii disc structures in `src/nod/disc/wii.rs`:
//! the shifted offset accessors on the partition table and partition header,
//! and title-key decryption across every certificate issuer and key index.

use zerocopy::FromZeros as _;

use crate::nod::util::aes::aes_cbc_encrypt;

use super::*;

/// A ticket carrying `title_key` encrypted the way a real disc stores it, so
/// `decrypt_title_key` MUST return `title_key` unchanged.
fn ticket_with(issuer: &str, common_key_idx: u8, title_id: [u8; 8], title_key: KeyBytes) -> Ticket {
    let mut ticket = Ticket::new_box_zeroed().expect("allocate ticket");
    ticket.sig_issuer[..issuer.len()].copy_from_slice(issuer.as_bytes());
    ticket.common_key_idx = common_key_idx;
    ticket.title_id = title_id;

    let common_keys = match issuer {
        RVL_CERT_ISSUER_PPKI_TICKET => &RETAIL_COMMON_KEYS,
        _ => &DEBUG_COMMON_KEYS,
    };
    let mut iv: KeyBytes = [0; 16];
    iv[..8].copy_from_slice(&title_id);
    let mut encrypted = title_key;
    aes_cbc_encrypt(&common_keys[common_key_idx as usize], &iv, &mut encrypted);
    ticket.title_key = encrypted;
    *ticket
}

#[test]
fn partition_table_offsets_are_stored_shifted_right_by_two() {
    let mut entry = WiiPartEntry::new_box_zeroed().expect("allocate partition entry");
    entry.offset = U32::new(0x4_0000 >> 2);
    entry.kind = U32::new(1);
    assert_eq!(entry.offset(), 0x4_0000);

    let mut group = WiiPartGroup::new_box_zeroed().expect("allocate partition group");
    group.part_count = U32::new(2);
    group.part_entry_off = U32::new(0x4_0020 >> 2);
    assert_eq!(group.part_entry_off(), 0x4_0020);
}

#[test]
fn partition_header_accessors_apply_the_right_shift_per_field() {
    let mut header = WiiPartitionHeader::new_box_zeroed().expect("allocate partition header");
    // Sizes are plain byte counts; offsets are stored shifted right by two.
    header.tmd_size = U32::new(0x208);
    header.tmd_off = U32::new(0x2C0 >> 2);
    header.cert_chain_size = U32::new(0xA00);
    header.cert_chain_off = U32::new(0x4C8 >> 2);
    header.h3_table_off = U32::new(0x8000 >> 2);
    header.data_off = U32::new(0x2_0000 >> 2);
    header.data_size = U32::new(0x40_0000 >> 2);

    assert_eq!(header.tmd_size(), 0x208);
    assert_eq!(header.tmd_off(), 0x2C0);
    assert_eq!(header.cert_chain_size(), 0xA00);
    assert_eq!(header.cert_chain_off(), 0x4C8);
    assert_eq!(header.h3_table_off(), 0x8000);
    assert_eq!(header.h3_table_size(), H3_TABLE_SIZE as u64);
    assert_eq!(header.data_off(), 0x2_0000);
    assert_eq!(header.data_size(), 0x40_0000);
}

#[test]
fn decrypt_title_key_round_trips_every_retail_common_key() {
    let title_key: KeyBytes = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF,
    ];
    let title_id = [0x00, 0x01, 0x00, 0x00, b'R', b'W', b'T', b'E'];

    for idx in 0..RETAIL_COMMON_KEYS.len() as u8 {
        let ticket = ticket_with(RVL_CERT_ISSUER_PPKI_TICKET, idx, title_id, title_key);
        assert_eq!(
            ticket
                .decrypt_title_key()
                .expect("decrypt retail title key"),
            title_key,
            "retail common key index {idx}"
        );
    }
}

#[test]
fn decrypt_title_key_round_trips_every_debug_common_key() {
    let title_key: KeyBytes = [0x5A; 16];
    let title_id = [0x00, 0x01, 0x00, 0x01, b'D', b'B', b'G', b'0'];

    for idx in 0..DEBUG_COMMON_KEYS.len() as u8 {
        let ticket = ticket_with(RVL_CERT_ISSUER_DPKI_TICKET, idx, title_id, title_key);
        assert_eq!(
            ticket.decrypt_title_key().expect("decrypt debug title key"),
            title_key,
            "debug common key index {idx}"
        );
    }
}

#[test]
fn decrypt_title_key_rejects_an_unknown_certificate_issuer() {
    let mut ticket = ticket_with(RVL_CERT_ISSUER_PPKI_TICKET, 0, [0; 8], [0; 16]);
    ticket.sig_issuer.fill(0);
    ticket.sig_issuer[..7].copy_from_slice(b"Root-XX");

    let err = ticket
        .decrypt_title_key()
        .expect_err("unknown certificate issuer");
    assert!(
        matches!(&err, Error::DiscFormat(msg) if msg.contains("unknown certificate issuer")),
        "unexpected error: {err}"
    );
}

#[test]
fn decrypt_title_key_rejects_an_unparseable_certificate_issuer() {
    let mut ticket = ticket_with(RVL_CERT_ISSUER_PPKI_TICKET, 0, [0; 8], [0; 16]);
    // No nul terminator anywhere in the field.
    ticket.sig_issuer.fill(b'A');

    let err = ticket
        .decrypt_title_key()
        .expect_err("unparseable certificate issuer");
    assert!(
        matches!(&err, Error::DiscFormat(msg) if msg.contains("failed to parse certificate issuer")),
        "unexpected error: {err}"
    );
}

#[test]
fn decrypt_title_key_rejects_a_common_key_index_out_of_range() {
    let mut ticket = ticket_with(RVL_CERT_ISSUER_PPKI_TICKET, 0, [0; 8], [0; 16]);
    ticket.common_key_idx = 9;

    let err = ticket
        .decrypt_title_key()
        .expect_err("common key index out of range");
    assert!(
        matches!(&err, Error::DiscFormat(msg) if msg.contains("unknown common key index 9")),
        "unexpected error: {err}"
    );
}
