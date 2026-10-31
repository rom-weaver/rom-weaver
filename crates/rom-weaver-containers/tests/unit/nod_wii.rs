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
    disc.open_partition_kind(
        PartitionKind::Data,
        &PartitionOptions {
            validate_hashes,
            ..Default::default()
        },
    )
    .expect("open data partition")
}

fn wia_image(iso: &[u8], compression: crate::nod::common::Compression) -> Vec<u8> {
    wia_image_with_options(
        iso,
        compression,
        &crate::nod::write::ProcessOptions::default(),
    )
}

fn wia_image_with_options(
    iso: &[u8],
    compression: crate::nod::common::Compression,
    options: &crate::nod::write::ProcessOptions,
) -> Vec<u8> {
    disc_image_with_options(iso, crate::nod::common::Format::Wia, compression, options)
}

fn disc_image_with_options(
    iso: &[u8],
    format: crate::nod::common::Format,
    compression: crate::nod::common::Compression,
    options: &crate::nod::write::ProcessOptions,
) -> Vec<u8> {
    use crate::nod::write::{DiscWriter, FormatOptions};
    let writer = DiscWriter::new(
        open_wii_disc(iso),
        &FormatOptions {
            format,
            compression,
            block_size: format.default_block_size(),
        },
    )
    .expect("create WIA writer");
    let mut image = Vec::new();
    let finalization = writer
        .process(
            |data, _, _| {
                image.extend_from_slice(&data);
                Ok(())
            },
            options,
        )
        .expect("write WIA");
    image[..finalization.header.len()].copy_from_slice(&finalization.header);
    image
}

// The writer omits exceptions, so fixtures MUST append the mastered tables themselves.
fn set_wia_group_exceptions(
    image: &mut Vec<u8>,
    group_index: usize,
    exceptions: &[crate::nod::io::wia::WIAException],
) {
    use crate::nod::io::wia::{WIADisc, WIAFileHeader, WIAGroup, WIAPartition};
    let disc = WIADisc::read_from_bytes(
        &image[size_of::<WIAFileHeader>()..size_of::<WIAFileHeader>() + size_of::<WIADisc>()],
    )
    .unwrap();
    let partition_at = disc.partition_offset.get() as usize;
    let partition = WIAPartition::read_from_bytes(
        &image[partition_at..partition_at + size_of::<WIAPartition>()],
    )
    .unwrap();
    let group_at = disc.group_offset.get() as usize
        + (partition.partition_data[0].group_index.get() as usize + group_index)
            * size_of::<WIAGroup>();
    let mut entry =
        WIAGroup::read_from_bytes(&image[group_at..group_at + size_of::<WIAGroup>()]).unwrap();
    let old_at = entry.data_offset.get() as usize * 4;
    let mut payload = (exceptions.len() as u16).to_be_bytes().to_vec();
    payload.extend_from_slice(exceptions.as_bytes());
    payload.resize(payload.len().next_multiple_of(4), 0);
    if entry.data_size.get() == 0 {
        let sectors: usize = partition
            .partition_data
            .iter()
            .map(|data| data.num_sectors.get() as usize)
            .sum();
        let stored_sectors = (sectors - group_index * 64).min(64);
        payload.resize(payload.len() + stored_sectors * SECTOR_DATA_SIZE, 0);
    } else {
        assert_eq!(&image[old_at..old_at + 4], &[0; 4]);
        payload.extend_from_slice(&image[old_at + 4..old_at + entry.data_size.get() as usize]);
    }
    image.resize(image.len().next_multiple_of(4), 0);
    entry.data_offset = U32::new((image.len() / 4) as u32);
    entry.data_size = U32::new(payload.len() as u32);
    image.extend_from_slice(&payload);
    image[group_at..group_at + size_of::<WIAGroup>()].copy_from_slice(entry.as_bytes());
    let image_size = image.len() as u64;
    let header = WIAFileHeader::mut_from_bytes(&mut image[..size_of::<WIAFileHeader>()]).unwrap();
    header.wia_file_size = U64::new(image_size);
    header.file_head_hash = crate::nod::util::digest::sha1_hash(&header.as_bytes()[..0x34]);
}

fn multigroup_wia_image(damaged_sectors: &[(usize, usize)]) -> (Vec<u8>, Vec<u8>) {
    use crate::nod::{io::wia::WIAException, util::digest::sha1_hash};
    let data_at = (PART_OFFSET + DATA_OFF) as usize;
    let sectors = 128 + DATA_SECTORS;
    let mut iso = build_wii_image(true, Damage::None);
    iso.resize(data_at + sectors * SECTOR_SIZE, 0);
    let header = WiiPartitionHeader::mut_from_bytes(
        &mut iso[PART_OFFSET as usize..PART_OFFSET as usize + size_of::<WiiPartitionHeader>()],
    )
    .unwrap();
    header.data_size = U32::new((sectors * SECTOR_SIZE / 4) as u32);
    let mut all_exceptions = Vec::new();
    for group_index in 0..3 {
        let real_sectors = if group_index == 2 { DATA_SECTORS } else { 64 };
        let (mut group, mut h3) = if group_index == 0 {
            build_sector_group_plaintext()
        } else {
            let mut group = vec![0; SECTOR_GROUP_SIZE];
            for sector in 0..64 {
                for (offset, byte) in sector_mut(&mut group, sector)[HASHES_SIZE..]
                    .iter_mut()
                    .enumerate()
                {
                    *byte = (offset * 17 + group_index) as u8;
                }
            }
            let hashes = hash_sector_group(group.as_slice().try_into().unwrap(), false);
            for sector in 0..64 {
                hashes.apply(sector_mut(&mut group, sector), sector);
            }
            (group, hashes.h3_hash)
        };
        if group_index == 2 {
            let mut h1 = group[0x280..0x320].to_vec();
            h1[real_sectors * 20..].fill(0xA5);
            let mut h2 = vec![0x5A; 0xA0];
            h2[..20].copy_from_slice(&sha1_hash(&h1));
            h3 = sha1_hash(&h2);
            for sector in 0..real_sectors {
                let data = sector_mut(&mut group, sector);
                data[0x280..0x320].copy_from_slice(&h1);
                data[0x340..0x3E0].copy_from_slice(&h2);
            }
        }
        for &(damaged_group, sector) in damaged_sectors {
            if damaged_group == group_index {
                assert!(sector < real_sectors);
                sector_mut(&mut group, sector)[0x280 + (sector % 8) * 20] ^= 1;
            }
        }
        let mut exceptions = Vec::new();
        for sector in 0..real_sectors {
            let data = sector_mut(&mut group, sector);
            if group_index == 2 || damaged_sectors.contains(&(group_index, sector)) {
                for offset in (0x280..0x320).step_by(20).chain((0x340..0x3E0).step_by(20)) {
                    exceptions.push(WIAException {
                        offset: U16::new((sector * HASHES_SIZE + offset) as u16),
                        hash: data[offset..offset + 20].try_into().unwrap(),
                    });
                }
            }
            encrypt_sector(data, &TITLE_KEY);
        }
        let at = data_at + group_index * SECTOR_GROUP_SIZE;
        iso[at..at + real_sectors * SECTOR_SIZE]
            .copy_from_slice(&group[..real_sectors * SECTOR_SIZE]);
        let h3_at = (PART_OFFSET + H3_OFF) as usize + group_index * 20;
        iso[h3_at..h3_at + 20].copy_from_slice(&h3);
        all_exceptions.push(exceptions);
    }
    let mut image = wia_image(&iso, crate::nod::common::Compression::None);
    for (group_index, exceptions) in all_exceptions.iter().enumerate() {
        if !exceptions.is_empty() {
            set_wia_group_exceptions(&mut image, group_index, exceptions);
        }
    }
    (image, iso)
}

fn wia_image_exceeding_h3_bound(format: crate::nod::common::Format) -> Vec<u8> {
    use crate::nod::{
        io::wia::{RVZGroup, WIADisc, WIAFileHeader, WIAGroup, WIARawData},
        util::digest::sha1_hash,
    };
    let iso = build_wii_image(true, Damage::None);
    let mut image = disc_image_with_options(
        &iso,
        format,
        crate::nod::common::Compression::None,
        &Default::default(),
    );
    let disc = WIADisc::read_from_bytes(
        &image[size_of::<WIAFileHeader>()..size_of::<WIAFileHeader>() + size_of::<WIADisc>()],
    )
    .unwrap();
    let raw_at = disc.raw_data_offset.get() as usize;
    let raw = image[raw_at..raw_at + disc.num_raw_data.get() as usize * size_of::<WIARawData>()]
        .chunks_exact(size_of::<WIARawData>())
        .map(|bytes| WIARawData::read_from_bytes(bytes).unwrap())
        .find(|raw| raw.start_offset() == PART_OFFSET)
        .expect("raw partition header region");
    assert_eq!(raw.num_groups.get(), 1);
    let mut payload = iso[raw.start_offset() as usize..raw.end_offset() as usize].to_vec();
    let header =
        WiiPartitionHeader::mut_from_bytes(&mut payload[..size_of::<WiiPartitionHeader>()])
            .unwrap();
    header.data_size = U32::new((((H3_TABLE_SIZE / 20) * 64 + 1) * SECTOR_SIZE / 4) as u32);
    image.resize(image.len().next_multiple_of(4), 0);
    let offset = image.len() / 4;
    image.extend_from_slice(&payload);
    let group_size = if format == crate::nod::common::Format::Rvz {
        size_of::<RVZGroup>()
    } else {
        size_of::<WIAGroup>()
    };
    let group_at = disc.group_offset.get() as usize + raw.group_index.get() as usize * group_size;
    let group =
        WIAGroup::mut_from_bytes(&mut image[group_at..group_at + size_of::<WIAGroup>()]).unwrap();
    group.data_offset = U32::new(offset as u32);
    group.data_size = U32::new(payload.len() as u32);
    if format == crate::nod::common::Format::Rvz {
        let group = RVZGroup::mut_from_bytes(&mut image[group_at..group_at + group_size]).unwrap();
        group.rvz_packed_size = U32::new(0);
    }
    let size = image.len() as u64;
    let header = WIAFileHeader::mut_from_bytes(&mut image[..size_of::<WIAFileHeader>()]).unwrap();
    header.wia_file_size = U64::new(size);
    header.file_head_hash = sha1_hash(&header.as_bytes()[..0x34]);
    image
}

fn extract_wia_image(
    image: &[u8],
) -> (
    crate::test_support::TempPath,
    rom_weaver_core::Result<rom_weaver_core::OperationReport>,
) {
    let (temp, result, _) = extract_wia_image_with_output(image, None);
    (temp, result)
}

fn extract_wia_image_with_output(
    image: &[u8],
    existing_output: Option<&[u8]>,
) -> (
    crate::test_support::TempPath,
    rom_weaver_core::Result<rom_weaver_core::OperationReport>,
    Arc<rom_weaver_core::RecordingProgressSink>,
) {
    extract_wia_image_with_threads(image, existing_output, 1)
}

fn extract_wia_image_with_threads(
    image: &[u8],
    existing_output: Option<&[u8]>,
    threads: usize,
) -> (
    crate::test_support::TempPath,
    rom_weaver_core::Result<rom_weaver_core::OperationReport>,
    Arc<rom_weaver_core::RecordingProgressSink>,
) {
    extract_wia_image_with_controls(image, existing_output, threads, false, None)
}

struct WiaExtractProgress {
    sink: Arc<rom_weaver_core::RecordingProgressSink>,
    cancel: rom_weaver_core::CancellationToken,
    cancel_at: Option<f32>,
    output_path: std::path::PathBuf,
}

impl rom_weaver_core::ProgressSink for WiaExtractProgress {
    fn emit(&self, event: rom_weaver_core::ProgressEvent) {
        if event.stage == "extract"
            && let (Some(percent), Some(cancel_at)) = (event.percent, self.cancel_at)
            && percent >= cancel_at
            && percent < 100.0
        {
            assert!(std::fs::metadata(&self.output_path).unwrap().len() > 0);
            self.cancel.cancel();
        }
        self.sink.emit(event);
    }
}

fn extract_wia_image_with_controls(
    image: &[u8],
    existing_output: Option<&[u8]>,
    threads: usize,
    overwrite: bool,
    cancel_at: Option<f32>,
) -> (
    crate::test_support::TempPath,
    rom_weaver_core::Result<rom_weaver_core::OperationReport>,
    Arc<rom_weaver_core::RecordingProgressSink>,
) {
    use rom_weaver_core::{
        CancellationToken, ContainerExtractRequest, OperationContext, RecordingProgressSink,
        ThreadBudget,
    };
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = crate::test_support::TempPath::new(
        std::env::temp_dir().join(format!("wia-integrity-{}-{unique}", std::process::id())),
    );
    std::fs::create_dir_all(&temp).unwrap();
    let format = if image.starts_with(b"RVZ") {
        "rvz"
    } else {
        "wia"
    };
    let source = temp.join(format!("disc.{format}"));
    std::fs::write(&source, image).unwrap();
    if let Some(bytes) = existing_output {
        std::fs::create_dir_all(temp.join("out")).unwrap();
        std::fs::write(temp.join("out/disc.iso"), bytes).unwrap();
    }
    let request = ContainerExtractRequest {
        source,
        out_dir: temp.join("out"),
        selections: vec![],
        kind_filter: Default::default(),
        containing_archive: None,
        split_bin: false,
        ignore_common_files: false,
        overwrite,
        parent: None,
    };
    let sink = Arc::new(RecordingProgressSink::default());
    let cancel = CancellationToken::new();
    let progress = Arc::new(WiaExtractProgress {
        sink: sink.clone(),
        cancel: cancel.clone(),
        cancel_at,
        output_path: temp.join("out/disc.iso"),
    });
    let context = OperationContext::new(
        ThreadBudget::Fixed(threads),
        temp.join("scratch"),
        progress,
        cancel,
    );
    let registry = crate::ContainerRegistry::new();
    let result = registry
        .find_by_name(format)
        .unwrap()
        .extract(&request, &context);
    (temp, result, sink)
}

#[test]
fn wia_rvz_extract_preserves_valid_wii_bytes() {
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        for compression in [
            crate::nod::common::Compression::None,
            crate::nod::common::Compression::Lzma2(6),
        ] {
            let iso = build_wii_image(true, Damage::None);
            let image = disc_image_with_options(&iso, format, compression, &Default::default());
            let (temp, result) = extract_wia_image(&image);
            let report = result.expect("extract valid disc");
            assert!(
                report.details.as_ref().unwrap().get("warnings").is_none(),
                "{report:?}"
            );
            assert_eq!(std::fs::read(temp.join("out/disc.iso")).unwrap(), iso);
        }
    }
}

#[test]
fn wia_extract_preserves_partial_group_with_mastered_hash_exceptions() {
    use crate::nod::{
        io::wia::{WIADisc, WIAException, WIAFileHeader, WIAGroup, WIAPartition},
        util::digest::sha1_hash,
    };

    assert_ne!(DATA_LEN % SECTOR_GROUP_SIZE, 0);
    let (mut group, _) = build_sector_group_plaintext();
    let mut h1 = group[0x280..0x320].to_vec();
    h1[DATA_SECTORS * 20..].fill(0xA5);
    let mut h2 = vec![0x5A; 0xA0];
    h2[..20].copy_from_slice(&sha1_hash(&h1));
    let h3 = sha1_hash(&h2);
    let mut exceptions = Vec::new();
    for sector in 0..DATA_SECTORS {
        let data = sector_mut(&mut group, sector);
        data[0x280..0x320].copy_from_slice(&h1);
        data[0x340..0x3E0].copy_from_slice(&h2);
        for offset in (0x280..0x320).step_by(20).chain((0x340..0x3E0).step_by(20)) {
            exceptions.push(WIAException {
                offset: U16::new((sector * HASHES_SIZE + offset) as u16),
                hash: data[offset..offset + 20].try_into().unwrap(),
            });
        }
        encrypt_sector(data, &TITLE_KEY);
    }
    let mut iso = build_wii_image(true, Damage::None);
    let data_at = (PART_OFFSET + DATA_OFF) as usize;
    iso[data_at..data_at + DATA_LEN].copy_from_slice(&group[..DATA_LEN]);
    let h3_at = (PART_OFFSET + H3_OFF) as usize;
    iso[h3_at..h3_at + 20].copy_from_slice(&h3);

    // The writer omits exceptions, so this fixture MUST encode the mastered tables itself.
    let mut image = wia_image(&iso, crate::nod::common::Compression::None);
    let disc = WIADisc::read_from_bytes(
        &image[size_of::<WIAFileHeader>()..size_of::<WIAFileHeader>() + size_of::<WIADisc>()],
    )
    .unwrap();
    let partition_at = disc.partition_offset.get() as usize;
    let partition = WIAPartition::read_from_bytes(
        &image[partition_at..partition_at + size_of::<WIAPartition>()],
    )
    .unwrap();
    let group_at = disc.group_offset.get() as usize
        + partition.partition_data[0].group_index.get() as usize * size_of::<WIAGroup>();
    set_wia_group_exceptions(&mut image, 0, &exceptions);
    let entry =
        WIAGroup::read_from_bytes(&image[group_at..group_at + size_of::<WIAGroup>()]).unwrap();
    let (temp, result) = extract_wia_image(&image);
    let report = result.expect("real sectors with valid mastered hashes must extract");
    assert!(
        report.details.as_ref().unwrap().get("warnings").is_none(),
        "{report:?}"
    );
    assert_eq!(std::fs::read(temp.join("out/disc.iso")).unwrap(), iso);

    let exception_hash_at = entry.data_offset.get() as usize * 4 + 4;
    image[exception_hash_at] ^= 1;
    let (temp, result) = extract_wia_image(&image);
    let report = result.expect("hash exceptions on real sectors must warn");
    let warning = report.details.as_ref().unwrap()["warnings"][0]
        .as_str()
        .unwrap();
    assert!(warning.contains("Invalid H1 hash"), "{warning}");
    assert!(
        warning.contains("2 hashes in 1 sectors across 1 groups"),
        "{warning}"
    );
    assert!(temp.join("out/disc.iso").exists());
}

fn wii_image_with_boot_change(change: impl FnOnce(&mut [u8])) -> Vec<u8> {
    let (mut group, _) = build_sector_group_plaintext();
    change(&mut group[HASHES_SIZE..SECTOR_SIZE]);
    let hashes = hash_sector_group(group.as_slice().try_into().unwrap(), true);
    for sector in 0..DATA_SECTORS {
        hashes.apply(sector_mut(&mut group, sector), sector);
        encrypt_sector(sector_mut(&mut group, sector), &TITLE_KEY);
    }
    let mut iso = build_wii_image(true, Damage::None);
    let data_at = (PART_OFFSET + DATA_OFF) as usize;
    iso[data_at..data_at + DATA_LEN].copy_from_slice(&group[..DATA_LEN]);
    let h3_at = (PART_OFFSET + H3_OFF) as usize;
    iso[h3_at..h3_at + 20].copy_from_slice(&hashes.h3_hash);
    iso
}

fn overflow_apploader(boot: &mut [u8]) {
    let header = ApploaderHeader::mut_from_bytes(
        &mut boot[APPLOADER_OFFSET..APPLOADER_OFFSET + size_of::<ApploaderHeader>()],
    )
    .unwrap();
    header.size = U32::new(0xFFFF_FFFF);
    header.trailer_size = U32::new(0xFFFF_FFE1);
}

#[test]
fn partition_meta_rejects_overflowing_apploader_size() {
    let iso = wii_image_with_boot_change(overflow_apploader);
    let disc = open_wii_disc(&iso);
    let error = open_wii_partition(&disc, false)
        .meta()
        .expect_err("oversized apploader must fail before allocation");
    assert!(
        error
            .to_string()
            .contains("Apploader size exceeds partition"),
        "{error}"
    );
}

#[test]
fn wia_extract_preserves_unparseable_apploader() {
    assert_wia_extract_preserves_unparseable_boot_area(overflow_apploader);
}

#[test]
fn wia_extract_preserves_unparseable_dol() {
    assert_wia_extract_preserves_unparseable_boot_area(|boot| {
        let header = DolHeader::mut_from_bytes(
            &mut boot[DOL_OFFSET as usize..DOL_OFFSET as usize + size_of::<DolHeader>()],
        )
        .unwrap();
        header.text_sizes[0] = U32::new(DATA_LEN as u32);
    });
}

fn assert_wia_extract_preserves_unparseable_boot_area(change: impl FnOnce(&mut [u8])) {
    let iso = wii_image_with_boot_change(change);
    let disc = open_wii_disc(&iso);
    assert!(open_wii_partition(&disc, false).meta().is_err());
    for compression in [
        crate::nod::common::Compression::None,
        crate::nod::common::Compression::Lzma2(6),
    ] {
        let image = wia_image(&iso, compression);
        let (temp, result) = extract_wia_image(&image);
        let report = result.expect("hash verification must not parse boot metadata");
        assert!(
            report.details.as_ref().unwrap().get("warnings").is_none(),
            "{report:?}"
        );
        assert_eq!(std::fs::read(temp.join("out/disc.iso")).unwrap(), iso);
    }
}

#[test]
fn wia_rvz_extract_warns_on_wii_hash_mismatches() {
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        for damage in [Damage::SectorData, Damage::H3Table] {
            let iso = build_wii_image(true, damage);
            let image = disc_image_with_options(
                &iso,
                format,
                crate::nod::common::Compression::None,
                &Default::default(),
            );
            let mut expected = Vec::new();
            DiscReader::new_stream(
                Box::new(CloneableStream::new(Cursor::new(image.clone()))),
                &DiscOptions::default(),
            )
            .unwrap()
            .read_to_end(&mut expected)
            .unwrap();
            let (temp, result) = extract_wia_image(&image);
            let report = result.expect("source hash mismatches must warn and extract");
            let warnings = report.details.as_ref().unwrap()["warnings"]
                .as_array()
                .unwrap();
            assert_eq!(warnings.len(), 1, "{report:?}");
            let warning = warnings[0].as_str().unwrap();
            assert!(warning.contains("partition 0 hash mismatch"), "{warning}");
            assert!(warning.contains("first group 0, sector 0"), "{warning}");
            assert!(
                warning.contains(&format!(
                    "{DATA_SECTORS} hashes in {DATA_SECTORS} sectors across 1 groups"
                )),
                "{warning}"
            );
            assert!(warning.contains("ISO extracted as-is"), "{warning}");
            assert!(std::fs::read(temp.join("out/disc.iso")).unwrap() == expected);
        }
    }
}

#[test]
fn wia_extract_refuses_existing_output_before_verification() {
    let image = wia_image_exceeding_h3_bound(crate::nod::common::Format::Wia);
    let sentinel = b"existing ISO must survive";
    let (temp, result, sink) = extract_wia_image_with_output(&image, Some(sentinel));
    let error = result.expect_err("existing output must be refused before hash verification");
    assert!(
        error
            .to_string()
            .contains("refusing to overwrite existing output"),
        "{error}"
    );
    assert_eq!(std::fs::read(temp.join("out/disc.iso")).unwrap(), sentinel);
    assert!(
        !sink.snapshot().iter().any(|event| event.stage == "extract"),
        "refusal must precede copying"
    );
    let (temp, result) = extract_wia_image(&image);
    let error = result.expect_err("without an existing output, H3 bounds must fail");
    assert!(
        error
            .to_string()
            .contains("H3 table missing hash for group"),
        "{error}"
    );
    assert!(!temp.join("out/disc.iso").exists());
}

#[test]
fn wia_extract_replays_later_group_exceptions_in_order_across_threads() {
    let (valid, iso) = multigroup_wia_image(&[]);
    let (temp, result) = extract_wia_image(&valid);
    let report = result.expect("mastered later-group H1/H2 exceptions must be valid");
    assert!(
        report.details.as_ref().unwrap().get("warnings").is_none(),
        "{report:?}"
    );
    assert!(std::fs::read(temp.join("out/disc.iso")).unwrap() == iso);

    let (image, iso) = multigroup_wia_image(&[(1, 3), (2, 1)]);
    let disc = open_wii_disc(&image);
    let mut partition = disc
        .open_partition(
            0,
            &PartitionOptions {
                validate_hashes: true,
                hash_mismatch_warnings: true,
            },
        )
        .unwrap();
    std::io::copy(&mut partition, &mut std::io::sink()).unwrap();
    let summary = partition.hash_mismatches().unwrap();
    assert!(
        summary
            .first
            .as_ref()
            .unwrap()
            .starts_with("first group 1, sector 67: Invalid H1 hash"),
        "{summary:?}"
    );
    assert_eq!((summary.hashes, summary.sectors, summary.groups), (4, 2, 2));
    let expected = format!(
        "wia partition 0 hash mismatch: {}; 4 hashes in 2 sectors across 2 groups; ISO extracted as-is; source-disc errors and payload corruption cannot be distinguished",
        summary.first.as_ref().unwrap(),
    );
    let mut warnings = Vec::new();
    for threads in [1, 4] {
        let mut disc = DiscReader::new_stream(
            Box::new(CloneableStream::new(Cursor::new(image.clone()))),
            &DiscOptions {
                preloader_threads: if threads == 1 { 0 } else { threads },
                ..Default::default()
            },
        )
        .unwrap();
        disc.enable_hash_verification(0).unwrap();
        let mut copied = Vec::new();
        disc.read_to_end(&mut copied).unwrap();
        assert_eq!(disc.next_unverified_group(0), Some(3));
        let replayed = disc.hash_mismatches(0).unwrap();
        assert_eq!(
            (
                &replayed.first,
                replayed.hashes,
                replayed.sectors,
                replayed.groups
            ),
            (
                &summary.first,
                summary.hashes,
                summary.sectors,
                summary.groups
            )
        );
        assert!(copied == iso);
        let (temp, result, _) = extract_wia_image_with_threads(&image, None, threads);
        let report = result.expect("later group hash mismatches must warn");
        let actual = report.details.as_ref().unwrap()["warnings"]
            .as_array()
            .unwrap();
        assert_eq!(actual, &[serde_json::Value::String(expected.clone())]);
        assert!(std::fs::read(temp.join("out/disc.iso")).unwrap() == iso);
        warnings.push(actual.clone());
    }
    assert_eq!(warnings[0], warnings[1]);
}

#[test]
fn wia_extract_verifies_groups_past_disc_end_and_appends_warnings() {
    use crate::nod::{io::wia::WIAFileHeader, util::digest::sha1_hash};
    for damaged in [&[(2, 1)][..], &[(0, 3), (2, 1)][..]] {
        let (mut image, iso) = multigroup_wia_image(damaged);
        let copy_end = (PART_OFFSET + DATA_OFF) as usize + SECTOR_GROUP_SIZE;
        let header =
            WIAFileHeader::mut_from_bytes(&mut image[..size_of::<WIAFileHeader>()]).unwrap();
        header.iso_file_size = U64::new(copy_end as u64);
        header.file_head_hash = sha1_hash(&header.as_bytes()[..0x34]);

        let mut disc = open_wii_disc(&image);
        disc.enable_hash_verification(0).unwrap();
        let mut copied = Vec::new();
        disc.read_to_end(&mut copied).unwrap();
        assert_eq!(copied.len(), copy_end);
        assert_eq!(disc.next_unverified_group(0), Some(1));
        assert_eq!(
            disc.hash_mismatches(0).unwrap().groups,
            u64::from(damaged.len() == 2)
        );

        for threads in [1, 4] {
            let (temp, result, _) = extract_wia_image_with_threads(&image, None, threads);
            let report = result.expect("uncopied groups must still produce hash warnings");
            let warnings = report.details.as_ref().unwrap()["warnings"]
                .as_array()
                .unwrap();
            assert_eq!(warnings.len(), 1);
            let warning = warnings[0].as_str().unwrap();
            let (first, counts) = if damaged.len() == 1 {
                (
                    "first group 2, sector 129: Invalid H1 hash",
                    "2 hashes in 1 sectors across 1 groups",
                )
            } else {
                (
                    "first group 0, sector 3: Invalid H1 hash",
                    "4 hashes in 2 sectors across 2 groups",
                )
            };
            assert!(warning.contains(first), "{warning}");
            assert!(warning.contains(counts), "{warning}");
            assert!(std::fs::read(temp.join("out/disc.iso")).unwrap() == iso[..copy_end]);
        }
    }
}

#[test]
fn wia_rvz_extract_rejects_partition_exceeding_h3_table_before_output() {
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        let image = wia_image_exceeding_h3_bound(format);
        let (temp, result, sink) = extract_wia_image_with_output(&image, None);
        let error = result.expect_err("partition size must fit the H3 table");
        let format = if format == crate::nod::common::Format::Wia {
            "wia"
        } else {
            "rvz"
        };
        assert_eq!(
            error.to_string(),
            format!(
                "validation failed: {format} partition 0 integrity check failed: H3 table missing hash for group {}",
                H3_TABLE_SIZE / 20,
            )
        );
        assert!(!temp.join("out/disc.iso").exists());
        assert!(!sink.snapshot().iter().any(|event| event.stage == "extract"));
    }
}

struct WarningCounter(Arc<std::sync::atomic::AtomicUsize>);

impl tracing::Subscriber for WarningCounter {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        *metadata.level() == tracing::Level::WARN
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, _: &tracing::Event<'_>) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[test]
fn wia_rvz_extract_cancel_mid_copy_removes_output_without_warnings() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    // This test MUST run alone because tracing caches callsite interest across test threads.
    const CHILD: &str = "ROM_WEAVER_WIA_CANCEL_TRACE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let module = module_path!().split_once("::").unwrap().1;
        let test =
            format!("{module}::wia_rvz_extract_cancel_mid_copy_removes_output_without_warnings");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &test, "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}\n{stderr}");
        assert!(
            stdout.contains("1 passed; 0 failed"),
            "child must run the cancellation test: {stdout}"
        );
        return;
    }
    let warnings = Arc::new(AtomicUsize::new(0));
    tracing::subscriber::with_default(WarningCounter(warnings.clone()), || {
        for format in [
            crate::nod::common::Format::Wia,
            crate::nod::common::Format::Rvz,
        ] {
            let image = wii_image_with_hash_and_digest_damage(format);
            warnings.store(0, Ordering::SeqCst);
            let (temp, result, sink) =
                extract_wia_image_with_controls(&image, None, 1, false, Some(90.0));
            assert!(
                matches!(result, Err(rom_weaver_core::RomWeaverError::Cancelled)),
                "{result:?}"
            );
            let events = sink.snapshot();
            assert!(events.iter().any(|event| event.stage == "extract"
                && event.percent.is_some_and(|p| (90.0..100.0).contains(&p))));
            assert!(
                !events
                    .iter()
                    .any(|event| event.stage == "extract" && event.percent == Some(100.0))
            );
            assert!(!temp.join("out/disc.iso").exists());
            assert_eq!(
                warnings.load(Ordering::SeqCst),
                0,
                "cancelled extraction must not emit warnings"
            );
            let (_, result, _) = extract_wia_image_with_output(&image, None);
            let report = result.expect("uncancelled damaged input must extract with warnings");
            assert_eq!(
                report.details.as_ref().unwrap()["warnings"]
                    .as_array()
                    .unwrap()
                    .len(),
                5
            );
            assert_eq!(
                warnings.load(Ordering::SeqCst),
                5,
                "warning capture must see the uncancelled run"
            );
        }
    });
}

#[test]
fn wia_extract_reports_verification_progress() {
    let iso = build_wii_image(true, Damage::None);
    let image = wia_image_with_options(
        &iso,
        crate::nod::common::Compression::None,
        &crate::nod::write::ProcessOptions {
            digest_sha1: true,
            ..Default::default()
        },
    );
    let (temp, result, sink) = extract_wia_image_with_output(&image, None);
    let report = result.expect("verified extraction must succeed");
    assert!(
        report.details.as_ref().unwrap().get("warnings").is_none(),
        "{report:?}"
    );
    assert_eq!(std::fs::read(temp.join("out/disc.iso")).unwrap(), iso);
    // Hash and digest verification run inside the single output copy, so its progress covers
    // them; there are no separate verification passes.
    let events = sink.snapshot();
    assert!(
        events
            .iter()
            .any(|event| event.stage == "extract" && event.percent == Some(100.0)),
        "missing extract completion"
    );
    assert!(
        !events
            .iter()
            .any(|event| event.stage.starts_with("verify-")),
        "unexpected separate verification pass"
    );
}

/// A WIA/RVZ image of a Wii disc with a damaged H3 table and all four NKit digests, with one
/// raw-data byte flipped so every digest mismatches as well.
fn wii_image_with_hash_and_digest_damage(format: crate::nod::common::Format) -> Vec<u8> {
    use crate::nod::io::wia::{WIADisc, WIAFileHeader, WIAGroup, WIARawData};
    let mut image = disc_image_with_options(
        &build_wii_image(true, Damage::H3Table),
        format,
        crate::nod::common::Compression::None,
        &crate::nod::write::ProcessOptions {
            digest_crc32: true,
            digest_md5: true,
            digest_sha1: true,
            digest_xxh64: true,
            ..Default::default()
        },
    );
    let disc = WIADisc::read_from_bytes(
        &image[size_of::<WIAFileHeader>()..size_of::<WIAFileHeader>() + size_of::<WIADisc>()],
    )
    .unwrap();
    let raw_at = disc.raw_data_offset.get() as usize;
    let raw =
        WIARawData::read_from_bytes(&image[raw_at..raw_at + size_of::<WIARawData>()]).unwrap();
    let group_size = if format == crate::nod::common::Format::Rvz {
        size_of::<crate::nod::io::wia::RVZGroup>()
    } else {
        size_of::<WIAGroup>()
    };
    let group_at = disc.group_offset.get() as usize + raw.group_index.get() as usize * group_size;
    let group =
        WIAGroup::read_from_bytes(&image[group_at..group_at + size_of::<WIAGroup>()]).unwrap();
    image[group.data_offset.get() as usize * 4 + 0x10000] ^= 1;
    image
}

#[test]
fn wia_rvz_copy_pass_verification_matches_across_thread_budgets() {
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        let image = wii_image_with_hash_and_digest_damage(format);
        let mut expected = Vec::new();
        DiscReader::new_stream(
            Box::new(CloneableStream::new(Cursor::new(image.clone()))),
            &DiscOptions::default(),
        )
        .unwrap()
        .read_to_end(&mut expected)
        .unwrap();
        let mut reports = Vec::new();
        for threads in [1, 4] {
            let (temp, result, _) = extract_wia_image_with_threads(&image, None, threads);
            let report = result.expect("hash and digest mismatches must warn");
            let warnings: Vec<String> = report.details.as_ref().unwrap()["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|warning| warning.as_str().unwrap().to_string())
                .collect();
            assert_eq!(warnings.len(), 5, "{warnings:?}");
            assert!(
                warnings[0].contains("partition 0 hash mismatch"),
                "{warnings:?}"
            );
            for (warning, algorithm) in warnings[1..].iter().zip(["CRC32", "MD5", "SHA-1", "XXH64"])
            {
                assert!(
                    warning.contains(&format!("NKit {algorithm} checksum mismatch")),
                    "{warning}"
                );
            }
            assert!(std::fs::read(temp.join("out/disc.iso")).unwrap() == expected);
            reports.push(warnings);
        }
        assert_eq!(reports[0], reports[1]);
    }
}

#[test]
fn wia_rvz_extract_removes_partial_output_when_decoding_fails_after_hash_warnings() {
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        let (_, mut iso) = multigroup_wia_image(&[]);
        iso[(PART_OFFSET + H3_OFF) as usize] ^= 1;
        let mut image = disc_image_with_options(
            &iso,
            format,
            crate::nod::common::Compression::None,
            &Default::default(),
        );
        // The partition group payload is stored last; losing its tail fails mid-copy, after the
        // output exists, so the partial ISO must be removed.
        image.truncate(image.len() - 0x100);
        for existing in [None, Some(b"previous ISO".as_slice())] {
            let (temp, result, sink) =
                extract_wia_image_with_controls(&image, existing, 1, true, None);
            result.expect_err("a truncated payload must fail extraction");
            assert!(sink.snapshot().iter().any(|event| event.stage == "extract" && event.percent.is_some_and(|p| p > 0.0)));
            assert!(!temp.join("out/disc.iso").exists());
        }
    }
}

#[test]
fn wia_rvz_extract_warns_on_partition_payload_bitflip() {
    use crate::nod::io::wia::{RVZGroup, WIADisc, WIAFileHeader, WIAGroup, WIAPartition};
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        let mut image = disc_image_with_options(
            &build_wii_image(true, Damage::None),
            format,
            crate::nod::common::Compression::None,
            &Default::default(),
        );
        let disc = WIADisc::read_from_bytes(
            &image[size_of::<WIAFileHeader>()..size_of::<WIAFileHeader>() + size_of::<WIADisc>()],
        )
        .unwrap();
        let partition_at = disc.partition_offset.get() as usize;
        let partition = WIAPartition::read_from_bytes(
            &image[partition_at..partition_at + size_of::<WIAPartition>()],
        )
        .unwrap();
        let group_size = if format == crate::nod::common::Format::Rvz {
            size_of::<RVZGroup>()
        } else {
            size_of::<WIAGroup>()
        };
        let group_at = disc.group_offset.get() as usize
            + partition.partition_data[0].group_index.get() as usize * group_size;
        let group =
            WIAGroup::read_from_bytes(&image[group_at..group_at + size_of::<WIAGroup>()]).unwrap();
        let payload_at = group.data_offset.get() as usize * 4;
        let mut data_at = payload_at + 4;
        if format == crate::nod::common::Format::Rvz {
            let group = RVZGroup::read_from_bytes(&image[group_at..group_at + group_size]).unwrap();
            if group.rvz_packed_size.get() != 0 {
                let literal_size =
                    u32::from_be_bytes(image[data_at..data_at + 4].try_into().unwrap());
                assert!(literal_size > 0x100 && literal_size < 0x80000000);
                data_at += 4;
            }
        }
        assert_eq!(
            &image[payload_at..payload_at + 2],
            &[0, 0],
            "no hash exceptions"
        );
        image[data_at + 0x100] ^= 1;
        let mut expected = Vec::new();
        DiscReader::new_stream(
            Box::new(CloneableStream::new(Cursor::new(image.clone()))),
            &DiscOptions::default(),
        )
        .unwrap()
        .read_to_end(&mut expected)
        .unwrap();
        let (temp, result) = extract_wia_image(&image);
        let report = result.expect("partition payload corruption must warn");
        let warning = report.details.as_ref().unwrap()["warnings"][0]
            .as_str()
            .unwrap();
        assert!(warning.contains("Invalid H3 hash"), "{warning}");
        assert!(std::fs::read(temp.join("out/disc.iso")).unwrap() == expected);
    }
}

#[test]
fn wia_extract_checks_each_optional_nkit_digest() {
    use crate::nod::{
        io::wia::{WIADisc, WIAFileHeader, WIAGroup, WIARawData},
        write::ProcessOptions,
    };
    let iso = build_wii_image(false, Damage::None);
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        for (algorithm, options) in [
            (
                "CRC32",
                ProcessOptions {
                    digest_crc32: true,
                    ..Default::default()
                },
            ),
            (
                "MD5",
                ProcessOptions {
                    digest_md5: true,
                    ..Default::default()
                },
            ),
            (
                "SHA-1",
                ProcessOptions {
                    digest_sha1: true,
                    ..Default::default()
                },
            ),
            (
                "XXH64",
                ProcessOptions {
                    digest_xxh64: true,
                    ..Default::default()
                },
            ),
        ] {
            let mut image = disc_image_with_options(
                &iso,
                format,
                crate::nod::common::Compression::None,
                &options,
            );
            let (temp, result) = extract_wia_image(&image);
            let report = result.expect("matching NKit digest must extract");
            assert!(
                report.details.as_ref().unwrap().get("warnings").is_none(),
                "{report:?}"
            );
            assert_eq!(std::fs::read(temp.join("out/disc.iso")).unwrap(), iso);
            let disc = WIADisc::read_from_bytes(
                &image
                    [size_of::<WIAFileHeader>()..size_of::<WIAFileHeader>() + size_of::<WIADisc>()],
            )
            .unwrap();
            let raw_at = disc.raw_data_offset.get() as usize;
            let raw = WIARawData::read_from_bytes(&image[raw_at..raw_at + size_of::<WIARawData>()])
                .unwrap();
            let group_at = disc.group_offset.get() as usize
                + raw.group_index.get() as usize * size_of::<WIAGroup>();
            let group =
                WIAGroup::read_from_bytes(&image[group_at..group_at + size_of::<WIAGroup>()])
                    .unwrap();
            image[group.data_offset.get() as usize * 4 + 0x10000] ^= 1;
            let (temp, result) = extract_wia_image(&image);
            let report = result.expect("NKit digest mismatch must warn");
            let warning = report.details.as_ref().unwrap()["warnings"][0]
                .as_str()
                .unwrap();
            assert!(
                warning.contains(&format!("NKit {algorithm} checksum mismatch")),
                "{warning}"
            );
            assert!(warning.contains("ISO extracted as-is"), "{warning}");
            assert!(temp.join("out/disc.iso").exists());
        }
    }
}

#[test]
fn probe_details_report_the_wii_header_and_partitions() {
    let disc = open_wii_disc(&build_wii_image(true, Damage::None));
    let mut details = serde_json::Map::new();
    crate::write_disc_header_details(&disc, &mut details);
    assert_eq!(details["game_id"], "RWIIT0");
    assert_eq!(details["title"], "rom weaver wii fixture");
    assert_eq!(
        details["partitions"],
        serde_json::json!([{ "index": 0, "kind": "Data", "data_size": DATA_LEN }])
    );
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

fn read_with_hash_validation(image: &[u8]) -> io::Result<Vec<u8>> {
    let disc = open_wii_disc(image);
    let mut partition = open_wii_partition(&disc, true);
    let mut out = vec![0u8; 0x40];
    partition.read_exact(&mut out)?;
    Ok(out)
}

#[test]
fn hash_validation_accepts_a_correctly_hashed_partition() {
    let image = build_wii_image(true, Damage::None);
    let head = read_with_hash_validation(&image).expect("validated read");
    assert_eq!(&head[..6], b"RWIIT0");
}

#[test]
fn hash_validation_checks_h3_table_bounds() {
    let (group, h3) = build_sector_group_plaintext();
    let mut table = vec![0; H3_TABLE_SIZE];
    let last_group = H3_TABLE_SIZE / 20 - 1;
    table[last_group * 20..(last_group + 1) * 20].copy_from_slice(&h3);
    let group = group.as_slice().try_into().unwrap();
    verify_hashes(group, last_group as u32, &table, DATA_SECTORS, None).expect("last H3 entry");
    let error = verify_hashes(group, last_group as u32 + 1, &table, DATA_SECTORS, None)
        .expect_err("group beyond H3 table");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(error.to_string(), "H3 table missing hash for group 4915");
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
        verify_hashes: false,
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

#[test]
fn hash_warning_mode_checks_h0_through_h3_once_per_sector() {
    for (damage, hash, hashes, sectors) in [
        (Damage::SectorData, "H0", 1, 1),
        (Damage::H1Block, "H1", 2, 1),
        (Damage::H2Block, "H2", 2, 1),
        (
            Damage::H3Table,
            "H3",
            DATA_SECTORS as u64,
            DATA_SECTORS as u64,
        ),
    ] {
        let image = build_wii_image(true, damage);
        let disc = open_wii_disc(&image);
        let mut reader = disc
            .open_partition(
                0,
                &PartitionOptions {
                    validate_hashes: true,
                    hash_mismatch_warnings: true,
                },
            )
            .unwrap();
        reader.fill_buf().unwrap();
        reader.fill_buf().unwrap();
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        let summary = reader.hash_mismatches().unwrap();
        assert!(
            summary.first.as_ref().unwrap().contains(hash),
            "{summary:?}"
        );
        assert_eq!(
            (summary.hashes, summary.sectors, summary.groups),
            (hashes, sectors, 1)
        );
        assert_eq!(output.len(), DATA_SECTORS * SECTOR_DATA_SIZE);
    }
}

#[test]
fn wia_rvz_extract_summarizes_each_damaged_partition() {
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        let mut iso = build_wii_image(true, Damage::H3Table);
        let second_offset = iso.len();
        let partition = iso[PART_OFFSET as usize..].to_vec();
        iso.extend_from_slice(&partition);
        let table = WII_PART_GROUP_OFF as usize;
        iso[table..table + 4].copy_from_slice(&2u32.to_be_bytes());
        iso[table + 0x28..table + 0x2c]
            .copy_from_slice(&((second_offset / 4) as u32).to_be_bytes());
        let image = disc_image_with_options(
            &iso,
            format,
            crate::nod::common::Compression::None,
            &Default::default(),
        );
        let (temp, result) = extract_wia_image(&image);
        let report = result.unwrap();
        let warnings = report.details.as_ref().unwrap()["warnings"]
            .as_array()
            .unwrap();
        assert_eq!(warnings.len(), 2, "{report:?}");
        for (partition, warning) in warnings.iter().enumerate() {
            assert!(
                warning
                    .as_str()
                    .unwrap()
                    .contains(&format!("partition {partition} hash mismatch"))
            );
        }
        assert!(std::fs::read(temp.join("out/disc.iso")).unwrap() == iso);
    }
}

#[test]
fn hash_warning_summary_counts_ten_groups_and_rejects_missing_h3() {
    let (group, _) = build_sector_group_plaintext();
    let group = group.as_slice().try_into().unwrap();
    let mut summary = HashMismatchSummary::default();
    for index in 0..10 {
        verify_hashes(group, index, &[0; 200], DATA_SECTORS, Some(&mut summary)).unwrap();
    }
    assert_eq!(
        (summary.hashes, summary.sectors, summary.groups),
        (40, 40, 10)
    );
    let error = verify_hashes(group, 10, &[0; 200], DATA_SECTORS, Some(&mut summary)).unwrap_err();
    assert_eq!(error.to_string(), "H3 table missing hash for group 10");
}

#[test]
fn wia_rvz_extract_still_rejects_structural_sha1_mismatches() {
    use crate::nod::io::wia::{WIADisc, WIAFileHeader};
    for format in [
        crate::nod::common::Format::Wia,
        crate::nod::common::Format::Rvz,
    ] {
        let iso = build_wii_image(true, Damage::None);
        let image = disc_image_with_options(
            &iso,
            format,
            crate::nod::common::Compression::None,
            &Default::default(),
        );
        let disc = WIADisc::read_from_bytes(
            &image[size_of::<WIAFileHeader>()..size_of::<WIAFileHeader>() + size_of::<WIADisc>()],
        )
        .unwrap();
        for at in [0x10, 0x48 + 16, disc.partition_offset.get() as usize] {
            let mut damaged = image.clone();
            damaged[at] ^= 1;
            let (temp, result) = extract_wia_image(&damaged);
            let error = result.expect_err("structural SHA-1 mismatches remain fatal");
            assert!(
                error.to_string().contains("WIA/RVZ hash mismatch"),
                "{error}"
            );
            assert!(!temp.join("out/disc.iso").exists());
        }
    }
}
