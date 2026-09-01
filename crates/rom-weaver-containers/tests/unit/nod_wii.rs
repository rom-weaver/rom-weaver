//! Unit coverage for the Wii disc structures in `src/nod/disc/wii.rs`:
//! the shifted offset accessors on the partition table and partition header,
//! and title-key decryption across every certificate issuer and key index.

use std::io::{Cursor, Read as _};

use zerocopy::FromZeros as _;

use super::*;
use crate::nod::{
    common::PartitionKind,
    disc::preloader::SectorGroupLoader,
    disc::{
        ApploaderHeader, BB2_OFFSET, BI2_SIZE, BOOT_SIZE, BootHeader, DiscHeader, DolHeader,
        WII_MAGIC, fst::FstBuilder, hashes::hash_sector_group,
    },
    read::{CloneableStream, DiscOptions, DiscReader, DiscStream},
    util::aes::{aes_cbc_encrypt, encrypt_sector},
};

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

// --- Synthetic Wii disc fixture ------------------------------------------
//
// A Wii hash tree is defined over a whole 64-sector group, so the smallest
// image that can exercise `verify_hashes` still carries one full group of
// hashes. Only the first `DATA_SECTORS` of that group are stored on disc; the
// sector-group loader zero-fills and re-derives the rest, which reproduces the
// same tree because it hashes the same content.

const PART_OFFSET: u64 = 0x5_0000;
const TMD_OFF: u64 = 0x2C0;
const TMD_LEN: usize = size_of::<TmdHeader>() + size_of::<ContentMetadata>();
const CERT_CHAIN_OFF: u64 = 0x4C8;
const CERT_CHAIN_LEN: usize = 0xA00;
const H3_OFF: u64 = 0x8000;
const DATA_OFF: u64 = 0x2_0000;
const DATA_SECTORS: usize = 4;
const DATA_LEN: usize = DATA_SECTORS * SECTOR_SIZE;
const IMAGE_LEN: usize = (PART_OFFSET + DATA_OFF) as usize + DATA_LEN;

const APPLOADER_OFFSET: usize = BOOT_SIZE + BI2_SIZE;
const APPLOADER_PAYLOAD: usize = 0x100;
const APPLOADER_TRAILER: usize = 0x20;
const DOL_OFFSET: u64 = 0x2580;
const DOL_PAYLOAD: usize = 0x40;
const FST_OFFSET: u64 = 0x2700;
const BANNER_OFFSET: u64 = 0x3000;
const BANNER_LEN: usize = 0x40;
/// Past one sector of hashed partition data (0x7C00), so a read of this file
/// crosses a sector boundary and a hash block.
const SECOND_OFFSET: u64 = 0x8000;
const SECOND_LEN: usize = 0x40;
const PARTITION_CONTENT_LEN: usize = SECOND_OFFSET as usize + SECOND_LEN;

const TITLE_ID: [u8; 8] = [0x00, 0x01, 0x00, 0x05, b'R', b'W', b'I', b'I'];
const TITLE_KEY: KeyBytes = [
    0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF,
];

/// What to damage in an otherwise valid image, to drive one arm of
/// `verify_hashes`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Damage {
    None,
    SectorData,
    H1Block,
    H2Block,
    H3Table,
}

fn apploader_bytes() -> Vec<u8> {
    let mut header = ApploaderHeader::new_box_zeroed().expect("allocate apploader header");
    header.date[..8].copy_from_slice(b"20240701");
    header.size = U32::new(APPLOADER_PAYLOAD as u32);
    header.trailer_size = U32::new(APPLOADER_TRAILER as u32);
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend((0..APPLOADER_PAYLOAD + APPLOADER_TRAILER).map(|i| (i % 241) as u8));
    bytes
}

fn dol_bytes() -> Vec<u8> {
    let mut header = DolHeader::new_box_zeroed().expect("allocate DOL header");
    // At least one section MUST be non-empty; `read_dol` sizes the DOL from
    // the highest section end.
    header.text_offs[0] = U32::new(size_of::<DolHeader>() as u32);
    header.text_sizes[0] = U32::new(DOL_PAYLOAD as u32);
    header.entry_point = U32::new(0x8000_3154);
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend((0..DOL_PAYLOAD).map(|i| 0x40 ^ (i as u8)));
    bytes
}

fn banner_bytes() -> Vec<u8> {
    (0..BANNER_LEN).map(|i| (i * 5 + 3) as u8).collect()
}

fn second_bytes() -> Vec<u8> {
    (0..SECOND_LEN).map(|i| (i * 11 + 7) as u8).collect()
}

fn tmd_bytes() -> Vec<u8> {
    let mut header = TmdHeader::new_box_zeroed().expect("allocate TMD header");
    header.header.sig_type = U32::new(0x0001_0001);
    header.sig_issuer[..26].copy_from_slice(b"Root-CA00000001-CP00000004");
    header.title_id = TITLE_ID;
    header.num_contents = U16::new(1);
    header.title_version = U16::new(3);
    let mut content = ContentMetadata::new_box_zeroed().expect("allocate content metadata");
    content.content_id = U32::new(1);
    content.size = U64::new(DATA_LEN as u64);
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend_from_slice(content.as_bytes());
    bytes
}

fn cert_chain_bytes() -> Vec<u8> {
    (0..CERT_CHAIN_LEN).map(|i| (i % 251) as u8).collect()
}

/// The decrypted, hash-free byte stream a partition exposes to its reader.
fn partition_contents() -> Vec<u8> {
    let mut fst_builder = FstBuilder::new(true);
    fst_builder.add_file("files/banner.bin", BANNER_OFFSET, BANNER_LEN as u32);
    fst_builder.add_file("files/second.bin", SECOND_OFFSET, SECOND_LEN as u32);
    let raw_fst = fst_builder.finalize();
    // Wii boot header sizes are stored divided by four, so the FST region is
    // padded up to the next multiple of four.
    let fst_size = raw_fst.len().next_multiple_of(4);

    let mut out = vec![0u8; PARTITION_CONTENT_LEN];

    let mut disc_header = DiscHeader::new_box_zeroed().expect("allocate disc header");
    disc_header.game_id = *b"RWIIT0";
    disc_header.disc_version = 1;
    disc_header.wii_magic = WII_MAGIC;
    let title = b"rom weaver wii fixture";
    disc_header.game_title[..title.len()].copy_from_slice(title);
    out[..size_of::<DiscHeader>()].copy_from_slice(disc_header.as_bytes());

    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    boot_header.set_dol_offset(DOL_OFFSET, true);
    boot_header.set_fst_offset(FST_OFFSET, true);
    boot_header.set_fst_size(fst_size as u64, true);
    boot_header.set_fst_max_size(fst_size as u64, true);
    out[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()].copy_from_slice(boot_header.as_bytes());

    // bi2.bin carries the region code at offset 0x18.
    out[BOOT_SIZE + 0x18..BOOT_SIZE + 0x1C].copy_from_slice(&1u32.to_be_bytes());

    let apploader = apploader_bytes();
    out[APPLOADER_OFFSET..APPLOADER_OFFSET + apploader.len()].copy_from_slice(&apploader);
    let dol = dol_bytes();
    out[DOL_OFFSET as usize..DOL_OFFSET as usize + dol.len()].copy_from_slice(&dol);
    out[FST_OFFSET as usize..FST_OFFSET as usize + raw_fst.len()].copy_from_slice(&raw_fst);
    out[BANNER_OFFSET as usize..BANNER_OFFSET as usize + BANNER_LEN]
        .copy_from_slice(&banner_bytes());
    out[SECOND_OFFSET as usize..SECOND_OFFSET as usize + SECOND_LEN]
        .copy_from_slice(&second_bytes());
    out
}

fn sector_mut(group: &mut [u8], sector: usize) -> &mut [u8; SECTOR_SIZE] {
    (&mut group[sector * SECTOR_SIZE..(sector + 1) * SECTOR_SIZE])
        .try_into()
        .expect("sector slice")
}

/// Lays the partition byte stream into a 64-sector group, then hashes and
/// encrypts it when the disc uses hashes. Returns the group and the H3 hash.
fn build_sector_group_plaintext() -> (Vec<u8>, HashBytes) {
    build_sector_group_inner(true, Damage::None, false)
}

fn build_sector_group(hashed: bool, damage: Damage) -> (Vec<u8>, HashBytes) {
    build_sector_group_inner(hashed, damage, true)
}

fn build_sector_group_inner(hashed: bool, damage: Damage, encrypt: bool) -> (Vec<u8>, HashBytes) {
    let contents = partition_contents();
    let mut group = vec![0u8; SECTOR_GROUP_SIZE];
    if hashed {
        for (index, chunk) in contents.chunks(SECTOR_DATA_SIZE).enumerate() {
            let base = index * SECTOR_SIZE + HASHES_SIZE;
            group[base..base + chunk.len()].copy_from_slice(chunk);
        }
    } else {
        group[..contents.len()].copy_from_slice(&contents);
        return (group, [0u8; 20]);
    }

    let group_ref: &[u8; SECTOR_GROUP_SIZE] =
        group.as_slice().try_into().expect("sector group slice");
    let hashes = hash_sector_group(group_ref, false);
    let h3_hash = hashes.h3_hash;
    for sector in 0..64 {
        hashes.apply(sector_mut(&mut group, sector), sector);
    }

    match damage {
        // A byte inside the first H0 block's data range.
        Damage::SectorData => group[HASHES_SIZE] ^= 0xFF,
        Damage::H1Block => group[0x280] ^= 0xFF,
        Damage::H2Block => group[0x340] ^= 0xFF,
        Damage::None | Damage::H3Table => {}
    }

    if encrypt {
        for sector in 0..DATA_SECTORS {
            encrypt_sector(sector_mut(&mut group, sector), &TITLE_KEY);
        }
    }
    (group, h3_hash)
}

/// A complete single-partition Wii image.
fn build_wii_image(hashed: bool, damage: Damage) -> Vec<u8> {
    let (group, h3_hash) = build_sector_group(hashed, damage);

    let mut image = vec![0u8; IMAGE_LEN];

    let mut disc_header = DiscHeader::new_box_zeroed().expect("allocate disc header");
    disc_header.game_id = *b"RWIIT0";
    disc_header.disc_version = 1;
    disc_header.wii_magic = WII_MAGIC;
    disc_header.no_partition_hashes = u8::from(!hashed);
    // Encryption without hashes is rejected up front, so the two travel together.
    disc_header.no_partition_encryption = u8::from(!hashed);
    let title = b"rom weaver wii fixture";
    disc_header.game_title[..title.len()].copy_from_slice(title);
    image[..size_of::<DiscHeader>()].copy_from_slice(disc_header.as_bytes());

    let mut groups = <[WiiPartGroup; 4]>::new_box_zeroed().expect("allocate partition groups");
    groups[0].part_count = U32::new(1);
    groups[0].part_entry_off = U32::new(((WII_PART_GROUP_OFF + 0x20) >> 2) as u32);
    image[WII_PART_GROUP_OFF as usize..WII_PART_GROUP_OFF as usize + size_of_val(&*groups)]
        .copy_from_slice(groups.as_bytes());

    let mut entry = WiiPartEntry::new_box_zeroed().expect("allocate partition entry");
    entry.offset = U32::new((PART_OFFSET >> 2) as u32);
    entry.kind = U32::new(0);
    let entry_off = (WII_PART_GROUP_OFF + 0x20) as usize;
    image[entry_off..entry_off + size_of::<WiiPartEntry>()].copy_from_slice(entry.as_bytes());

    let region_off = REGION_OFFSET as usize;
    for (index, byte) in image[region_off..region_off + REGION_SIZE]
        .iter_mut()
        .enumerate()
    {
        *byte = (index * 3) as u8;
    }

    let tmd = tmd_bytes();
    let cert_chain = cert_chain_bytes();
    let mut header = WiiPartitionHeader::new_box_zeroed().expect("allocate partition header");
    header.ticket = ticket_with(RVL_CERT_ISSUER_PPKI_TICKET, 0, TITLE_ID, TITLE_KEY);
    // A partition without hashes also has nothing to point a TMD or cert chain
    // at in this fixture, which exercises the `None` arms of `meta`.
    if hashed {
        header.tmd_size = U32::new(tmd.len() as u32);
        header.tmd_off = U32::new((TMD_OFF >> 2) as u32);
        header.cert_chain_size = U32::new(cert_chain.len() as u32);
        header.cert_chain_off = U32::new((CERT_CHAIN_OFF >> 2) as u32);
    }
    header.h3_table_off = U32::new((H3_OFF >> 2) as u32);
    header.data_off = U32::new((DATA_OFF >> 2) as u32);
    header.data_size = U32::new((DATA_LEN >> 2) as u32);

    let part = PART_OFFSET as usize;
    image[part..part + size_of::<WiiPartitionHeader>()].copy_from_slice(header.as_bytes());
    if hashed {
        let tmd_at = part + TMD_OFF as usize;
        image[tmd_at..tmd_at + tmd.len()].copy_from_slice(&tmd);
        let cert_at = part + CERT_CHAIN_OFF as usize;
        image[cert_at..cert_at + cert_chain.len()].copy_from_slice(&cert_chain);

        let h3_at = part + H3_OFF as usize;
        image[h3_at..h3_at + 20].copy_from_slice(&h3_hash);
        if damage == Damage::H3Table {
            image[h3_at] ^= 0xFF;
        }
    }

    let data_at = part + DATA_OFF as usize;
    image[data_at..data_at + DATA_LEN].copy_from_slice(&group[..DATA_LEN]);
    image
}

fn open_wii_disc(image: &[u8]) -> DiscReader {
    DiscReader::new_stream(
        Box::new(CloneableStream::new(Cursor::new(image.to_vec()))),
        &DiscOptions::default(),
    )
    .expect("open Wii fixture disc")
}

fn open_wii_partition(disc: &DiscReader, validate_hashes: bool) -> Box<dyn PartitionReader> {
    disc.open_partition_kind(PartitionKind::Data, &PartitionOptions { validate_hashes })
        .expect("open data partition")
}

#[test]
fn the_disc_reader_parses_the_partition_table_of_a_wii_image() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);

    assert!(disc.header().is_wii());
    assert!(disc.header().has_partition_hashes());
    assert!(disc.header().has_partition_encryption());
    assert_eq!(disc.region().expect("region info")[3], 9);

    let partitions = disc.partitions();
    assert_eq!(partitions.len(), 1);
    let partition = &partitions[0];
    assert_eq!(partition.index, 0);
    assert_eq!(partition.kind, PartitionKind::Data);
    assert_eq!(
        partition.start_sector as u64 * SECTOR_SIZE as u64,
        PART_OFFSET
    );
    assert_eq!(
        partition.data_start_sector as u64 * SECTOR_SIZE as u64,
        PART_OFFSET + DATA_OFF
    );
    assert_eq!(partition.data_size(), DATA_LEN as u64);
    assert!(partition.has_hashes);
    assert!(partition.has_encryption);
    assert_eq!(partition.key, TITLE_KEY);
    assert_eq!(partition.header.tmd_size(), TMD_LEN as u64);
    assert_eq!(partition.header.h3_table_off(), H3_OFF);
}

#[test]
fn a_wii_partition_reader_reads_every_system_file() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);

    assert!(partition.is_wii());
    let meta = partition.meta().expect("read partition meta");

    assert_eq!(meta.disc_header().game_id_str(), "RWIIT0");
    assert_eq!(
        meta.disc_header().game_title_str(),
        "rom weaver wii fixture"
    );
    assert!(meta.disc_header().is_wii());
    assert_eq!(meta.raw_bi2.len(), BI2_SIZE);
    assert_eq!(&meta.raw_bi2[0x18..0x1C], &1u32.to_be_bytes());
    assert_eq!(meta.raw_apploader.as_ref(), apploader_bytes().as_slice());
    assert_eq!(meta.apploader_header().date_str(), Some("20240701"));
    assert_eq!(meta.raw_dol.as_ref(), dol_bytes().as_slice());

    let fst = meta.fst().expect("parse FST");
    assert_eq!(fst.num_files(), 2);
    let (_, node) = fst.find("files/second.bin").expect("second file in FST");
    assert_eq!(node.offset(true), SECOND_OFFSET);
    assert_eq!(node.length(), SECOND_LEN as u32);

    // Wii-only blobs are all present on a hashed, encrypted partition.
    let raw_ticket = meta.raw_ticket.as_deref().expect("ticket");
    assert_eq!(raw_ticket.len(), size_of::<Ticket>());
    assert_eq!(&raw_ticket[0x1DC..0x1E4], &TITLE_ID);
    assert_eq!(
        meta.raw_tmd.as_deref().expect("TMD"),
        tmd_bytes().as_slice()
    );
    assert_eq!(
        meta.raw_cert_chain.as_deref().expect("cert chain"),
        cert_chain_bytes().as_slice()
    );
    let h3 = meta.raw_h3_table.as_deref().expect("H3 table");
    assert_eq!(h3.len(), H3_TABLE_SIZE);
    assert!(h3[..20].iter().any(|b| *b != 0));
    assert!(h3[20..].iter().all(|b| *b == 0));
}

#[test]
fn a_wii_partition_reader_caches_its_metadata() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);

    let first = partition.meta().expect("read partition meta");
    let second = partition.meta().expect("read cached partition meta");
    assert!(Arc::ptr_eq(&first.raw_boot, &second.raw_boot));
    assert!(Arc::ptr_eq(
        first.raw_h3_table.as_ref().expect("H3 table"),
        second.raw_h3_table.as_ref().expect("H3 table")
    ));
}

#[test]
fn a_wii_partition_reader_returns_decrypted_data_without_hash_blocks() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);
    let expected = partition_contents();

    let mut buf = vec![0u8; expected.len()];
    partition.read_exact(&mut buf).expect("read partition data");
    assert_eq!(buf, expected);

    // A read that starts in one sector's data area and ends in the next has to
    // step over the intervening hash block.
    let start = SECTOR_DATA_SIZE as u64 - 0x20;
    partition
        .seek(SeekFrom::Start(start))
        .expect("seek across sector boundary");
    let mut crossing = [0u8; 0x40];
    partition
        .read_exact(&mut crossing)
        .expect("read across sector boundary");
    assert_eq!(
        crossing.as_slice(),
        &expected[start as usize..start as usize + 0x40]
    );
}

#[test]
fn a_wii_partition_reader_streams_a_file_listed_in_the_fst() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);
    let meta = partition.meta().expect("read partition meta");
    let fst = meta.fst().expect("parse FST");

    for (path, expected) in [
        ("files/banner.bin", banner_bytes()),
        ("files/second.bin", second_bytes()),
    ] {
        let (_, node) = fst.find(path).expect("file in FST");
        let mut contents = Vec::new();
        partition
            .open_file(node)
            .expect("open file stream")
            .read_to_end(&mut contents)
            .expect("read file");
        assert_eq!(contents, expected, "{path}");
    }
}

#[test]
fn a_wii_partition_reader_seeks_from_every_anchor() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);

    // `len` reports the raw sector span, hash blocks included.
    assert_eq!(
        partition.seek(SeekFrom::End(0)).expect("seek"),
        DATA_LEN as u64
    );
    assert_eq!(
        partition.seek(SeekFrom::End(-0x1000)).expect("seek"),
        DATA_LEN as u64 - 0x1000
    );
    assert_eq!(
        partition
            .seek(SeekFrom::Start(BANNER_OFFSET))
            .expect("seek"),
        BANNER_OFFSET
    );
    assert_eq!(
        partition.stream_position().expect("position"),
        BANNER_OFFSET
    );
    assert_eq!(
        partition.seek(SeekFrom::Current(0x40)).expect("seek"),
        BANNER_OFFSET + 0x40
    );
    assert_eq!(
        partition.seek(SeekFrom::Current(-1 << 40)).expect("seek"),
        0
    );

    let mut banner = vec![0u8; BANNER_LEN];
    partition
        .seek(SeekFrom::Start(BANNER_OFFSET))
        .expect("seek to banner");
    partition.read_exact(&mut banner).expect("read banner");
    assert_eq!(banner, banner_bytes());
}

#[test]
fn a_wii_partition_reader_stops_at_the_end_of_the_partition_data() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);

    // Hashed partitions expose 0x7C00 usable bytes per sector, so the readable
    // span ends before `len`.
    let usable = DATA_SECTORS as u64 * SECTOR_DATA_SIZE as u64;
    partition
        .seek(SeekFrom::Start(usable))
        .expect("seek to end of data");
    assert!(partition.fill_buf().expect("fill_buf at end").is_empty());
    assert_eq!(partition.read(&mut [0u8; 16]).expect("read at end"), 0);

    partition
        .seek(SeekFrom::Start(usable - 0x10))
        .expect("seek near end");
    let mut tail = [0u8; 0x10];
    partition.read_exact(&mut tail).expect("read last bytes");
    assert_eq!(tail, [0u8; 0x10]);
}

#[test]
fn a_cloned_wii_partition_reader_restarts_at_the_beginning() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);
    partition.meta().expect("read partition meta");
    partition
        .seek(SeekFrom::Start(BANNER_OFFSET))
        .expect("seek before clone");

    let mut cloned = dyn_clone::clone_box(&*partition);
    assert_eq!(cloned.stream_position().expect("position"), 0);
    let mut head = [0u8; 6];
    cloned.read_exact(&mut head).expect("read from clone");
    assert_eq!(&head, b"RWIIT0");
    assert!(Arc::ptr_eq(
        &partition.meta().expect("meta").raw_boot,
        &cloned.meta().expect("cloned meta").raw_boot
    ));
}

/// Hash validation only runs on a sector group the reader has not already
/// cached, so the check is driven through a clone, whose cache starts empty
/// while the H3 table stays in the carried-over metadata.
fn read_with_hash_validation(image: &[u8]) -> io::Result<Vec<u8>> {
    let disc = open_wii_disc(image);
    let partition = open_wii_partition(&disc, true);
    let mut cloned = dyn_clone::clone_box(&*partition);
    let mut out = vec![0u8; 0x40];
    cloned.read_exact(&mut out)?;
    Ok(out)
}

#[test]
fn hash_validation_accepts_a_correctly_hashed_partition() {
    let image = build_wii_image(true, Damage::None);
    let head = read_with_hash_validation(&image).expect("validated read");
    assert_eq!(&head[..6], b"RWIIT0");
}

#[test]
fn hash_validation_rejects_corrupted_sector_data() {
    let image = build_wii_image(true, Damage::SectorData);
    let err = read_with_hash_validation(&image).expect_err("corrupted sector data");
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(
        format!("{err}").contains("Invalid H0 hash"),
        "unexpected error: {err}"
    );
}

#[test]
fn hash_validation_rejects_a_corrupted_h1_block() {
    let image = build_wii_image(true, Damage::H1Block);
    let err = read_with_hash_validation(&image).expect_err("corrupted H1 block");
    assert!(
        format!("{err}").contains("Invalid H1 hash! (sector 0)"),
        "unexpected error: {err}"
    );
}

#[test]
fn hash_validation_rejects_a_corrupted_h2_block() {
    let image = build_wii_image(true, Damage::H2Block);
    let err = read_with_hash_validation(&image).expect_err("corrupted H2 block");
    assert!(
        format!("{err}").contains("Invalid H2 hash! (subgroup 0)"),
        "unexpected error: {err}"
    );
}

#[test]
fn hash_validation_rejects_a_corrupted_h3_table() {
    let image = build_wii_image(true, Damage::H3Table);
    let err = read_with_hash_validation(&image).expect_err("corrupted H3 table");
    assert!(
        format!("{err}").contains("Invalid H3 hash! (group 0)"),
        "unexpected error: {err}"
    );
}

#[test]
fn a_partition_without_hashes_reads_whole_sectors() {
    let image = build_wii_image(false, Damage::None);
    let disc = open_wii_disc(&image);
    assert!(!disc.header().has_partition_hashes());
    assert!(!disc.header().has_partition_encryption());

    let partition_info = &disc.partitions()[0];
    assert!(!partition_info.has_hashes);
    assert!(!partition_info.has_encryption);

    let mut partition = open_wii_partition(&disc, false);
    let meta = partition.meta().expect("read partition meta");
    // Without hashes there is no H3 table, and this fixture carries no TMD or
    // certificate chain either.
    assert!(meta.raw_h3_table.is_none());
    assert!(meta.raw_tmd.is_none());
    assert!(meta.raw_cert_chain.is_none());
    assert!(meta.raw_ticket.is_some());
    assert_eq!(meta.raw_dol.as_ref(), dol_bytes().as_slice());

    // The whole sector is data, so the readable span is the full partition.
    let expected = partition_contents();
    partition.rewind().expect("rewind");
    let mut buf = vec![0u8; expected.len()];
    partition.read_exact(&mut buf).expect("read partition data");
    assert_eq!(buf, expected);

    partition
        .seek(SeekFrom::Start(DATA_LEN as u64))
        .expect("seek to end");
    assert!(partition.fill_buf().expect("fill_buf at end").is_empty());
}

// --- Sector group loading -------------------------------------------------
//
// These drive `disc/preloader.rs` through the Wii fixture above, which is the
// only partition-aware source in this crate's tests.

fn loader_for(image: &[u8], partitions: &[PartitionInfo]) -> SectorGroupLoader {
    let disc_header =
        DiscHeader::read_from_bytes(&image[..size_of::<DiscHeader>()]).expect("parse disc header");
    let block_reader =
        crate::nod::io::block::new(Box::new(CloneableStream::new(Cursor::new(image.to_vec()))))
            .expect("open block reader");
    SectorGroupLoader::new(
        block_reader,
        Arc::new(disc_header),
        Arc::from(partitions.to_vec().into_boxed_slice()),
    )
}

fn partition_group_request(
    partition_idx: Option<u8>,
    group_idx: u32,
    mode: PartitionEncryption,
    force_rehash: bool,
) -> SectorGroupRequest {
    SectorGroupRequest {
        group_idx,
        partition_idx,
        mode,
        force_rehash,
    }
}

#[test]
fn a_sector_group_request_names_its_partition_and_group() {
    let partitioned = partition_group_request(Some(3), 7, PartitionEncryption::Original, false);
    assert_eq!(format!("{partitioned}"), "Partition 3 group 7");

    let raw = partition_group_request(None, 12, PartitionEncryption::Original, false);
    assert_eq!(format!("{raw}"), "Group 12");
}

#[test]
fn loading_a_group_for_an_unknown_partition_yields_no_sectors() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut loader = loader_for(&image, disc.partitions());

    let group = loader
        .load(partition_group_request(
            Some(9),
            0,
            PartitionEncryption::Original,
            false,
        ))
        .expect("load group");
    assert_eq!(group.sector_bitmap, 0);
    assert_eq!(group.start_sector, 0);
    assert_eq!(group.consecutive_sectors(0), 0);
}

#[test]
fn loading_a_group_past_the_partition_data_yields_no_sectors() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let mut loader = loader_for(&image, disc.partitions());

    // The fixture partition holds a single group, so group 1 starts past its
    // data end.
    let group = loader
        .load(partition_group_request(
            Some(0),
            1,
            PartitionEncryption::Original,
            false,
        ))
        .expect("load group");
    assert_eq!(group.sector_bitmap, 0);
    assert!(group.data.iter().all(|b| *b == 0));
}

#[test]
fn loading_a_group_in_original_mode_returns_the_sectors_as_stored() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let data_at = (PART_OFFSET + DATA_OFF) as usize;
    let mut loader = loader_for(&image, disc.partitions());

    for mode in [
        PartitionEncryption::Original,
        PartitionEncryption::ForceEncrypted,
    ] {
        let group = loader
            .load(partition_group_request(Some(0), 0, mode, false))
            .expect("load group");
        assert_eq!(group.sector_bitmap, (1 << DATA_SECTORS) - 1);
        assert_eq!(
            &group.data[..DATA_LEN],
            &image[data_at..data_at + DATA_LEN],
            "{mode:?}"
        );
    }
}

#[test]
fn loading_a_group_in_decrypted_mode_returns_the_plaintext_sectors() {
    let image = build_wii_image(true, Damage::None);
    let disc = open_wii_disc(&image);
    let (plaintext, _) = build_sector_group_plaintext();
    let mut loader = loader_for(&image, disc.partitions());

    let group = loader
        .load(partition_group_request(
            Some(0),
            0,
            PartitionEncryption::ForceDecrypted,
            false,
        ))
        .expect("load group");
    assert_eq!(&group.data[..DATA_LEN], &plaintext[..DATA_LEN]);

    // Rehashing from scratch reproduces the same tree, so the result does not
    // change.
    let rehashed = loader
        .load(partition_group_request(
            Some(0),
            0,
            PartitionEncryption::ForceDecrypted,
            true,
        ))
        .expect("load group with forced rehash");
    assert_eq!(&rehashed.data[..DATA_LEN], &plaintext[..DATA_LEN]);
}

#[test]
fn a_truncated_partition_stops_at_the_last_readable_sector() {
    let mut image = build_wii_image(true, Damage::None);
    // Keep only the first data sector; the partition header still claims four,
    // so the block reader runs out mid-group.
    image.truncate((PART_OFFSET + DATA_OFF) as usize + SECTOR_SIZE);

    let disc = open_wii_disc(&image);
    let mut partition = open_wii_partition(&disc, false);

    let mut head = [0u8; 6];
    partition.read_exact(&mut head).expect("read first sector");
    assert_eq!(&head, b"RWIIT0");

    // The second sector never made it into the group, so the reader reports
    // end of data rather than returning zeroes.
    partition
        .seek(SeekFrom::Start(SECTOR_DATA_SIZE as u64))
        .expect("seek to the missing sector");
    assert!(partition.fill_buf().expect("fill_buf on a hole").is_empty());
    assert_eq!(partition.read(&mut [0u8; 16]).expect("read on a hole"), 0);
}

/// A stream that serves the image up to `fail_from` and then reports an I/O
/// error, so a sector group load fails without the disc header parse failing.
#[derive(Clone)]
struct FailingStream {
    image: Arc<Vec<u8>>,
    fail_from: u64,
}

impl DiscStream for FailingStream {
    fn read_exact_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        if offset >= self.fail_from {
            return Err(io::Error::other("simulated read failure"));
        }
        let end = offset as usize + buf.len();
        if end > self.image.len() {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        buf.copy_from_slice(&self.image[offset as usize..end]);
        Ok(())
    }

    fn stream_len(&mut self) -> io::Result<u64> {
        Ok(self.image.len() as u64)
    }
}

#[test]
fn a_failed_sector_read_propagates_out_of_the_preloader() {
    let image = build_wii_image(true, Damage::None);
    let partitions = open_wii_disc(&image).partitions().to_vec();
    let disc_header =
        DiscHeader::read_from_bytes(&image[..size_of::<DiscHeader>()]).expect("parse disc header");

    let stream = FailingStream {
        fail_from: PART_OFFSET + DATA_OFF,
        image: Arc::new(image),
    };
    let block_reader = crate::nod::io::block::new(Box::new(stream)).expect("open block reader");
    let loader = SectorGroupLoader::new(
        block_reader,
        Arc::new(disc_header),
        Arc::from(partitions.into_boxed_slice()),
    );
    let preloader = Preloader::new(
        loader,
        #[cfg(feature = "threading")]
        0,
    );

    // `SectorGroup` is not `Debug`, so the error arm is unwrapped by hand.
    let Err(err) = preloader.fetch(
        partition_group_request(Some(0), 0, PartitionEncryption::Original, false),
        1,
    ) else {
        panic!("expected the sector read to fail");
    };
    assert!(
        format!("{err}").contains("simulated read failure"),
        "unexpected error: {err}"
    );
}
