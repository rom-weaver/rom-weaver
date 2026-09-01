//! Coverage for the Wii half of `src/nod/disc/reader.rs`: `read_partition_info`
//! and the branches `DiscReader::new` only takes for a Wii disc, plus
//! `guess_disc_size` and the seek/partition accessors.
//!
//! Everything is driven from a synthetic Wii disc built in memory by
//! [`build_wii_iso`]: two partitions in the first partition group, a ticket
//! whose title key really decrypts under the retail common key, and partition
//! data carrying a correct H0/H1/H2/H3 hash tree so the AES-CBC sector
//! encryption round trips through the real reader path.

use std::io::Read;

use zerocopy::{FromBytes, FromZeros, IntoBytes};

use super::*;
use crate::nod::{
    common::{Format, HashBytes, KeyBytes},
    disc::{
        ApploaderHeader, BI2_SIZE, DebugHeader, DolHeader, SECTOR_GROUP_SIZE, WII_MAGIC,
        fst::FstBuilder,
        hashes::hash_sector_group,
        wii::{
            DEBUG_COMMON_KEYS, H3_TABLE_SIZE, HASHES_SIZE, RETAIL_COMMON_KEYS,
            RVL_CERT_ISSUER_DPKI_TICKET, RVL_CERT_ISSUER_PPKI_TICKET, SECTOR_DATA_SIZE, Ticket,
        },
    },
    read::{DiscReader as PublicDiscReader, DiscStream},
    util::aes::{aes_cbc_encrypt, decrypt_sector, decrypt_sector_b2b, encrypt_sector},
};

// --- Fixture geometry -----------------------------------------------------

pub(crate) const WII_GAME_ID: [u8; 6] = *b"RTEST0";
const WII_GAME_TITLE: &str = "rom-weaver wii fixture";
/// Title ID doubles as the AES-CBC IV for the ticket's title key.
const WII_TITLE_ID: [u8; 8] = [0x00, 0x01, 0x00, 0x00, 0x52, 0x54, 0x45, 0x53];
/// The decrypted title key the fixture's ticket must yield.
const WII_TITLE_KEY: KeyBytes = [
    0x0F, 0x1E, 0x2D, 0x3C, 0x4B, 0x5A, 0x69, 0x78, 0x87, 0x96, 0xA5, 0xB4, 0xC3, 0xD2, 0xE1, 0xF0,
];

const PART_GROUP_ENTRY_OFF: u64 = WII_PART_GROUP_OFF + 0x20;
const PART0_OFFSET: u64 = 0x10_0000;
const PART1_OFFSET: u64 = 0x40_0000;
const PART_TMD_OFF: u32 = 0x2C0;
const PART_TMD_SIZE: u32 = 0x208;
const PART_CERT_OFF: u32 = 0x4C8;
const PART_CERT_SIZE: u32 = 0x100;
const PART_H3_OFF: u32 = 0x8000;
const PART_DATA_OFF: u32 = 0x2_0000;
/// One full sector group, so the hash tree covers every sector the reader
/// hands to `verify_hashes`.
const PART_SECTORS: usize = 64;
const PART_DATA_SIZE: u64 = (PART_SECTORS * SECTOR_SIZE) as u64;
const PART_SPAN: u64 = PART_DATA_OFF as u64 + PART_DATA_SIZE;
const WII_DISC_SIZE: usize = (PART1_OFFSET + PART_SPAN) as usize;

const CONTENT_DOL_OFFSET: u64 = 0x2500;
const CONTENT_DOL_SIZE: u64 = 0x200;
const CONTENT_FST_OFFSET: u64 = 0x3000;
const CONTENT_FILE_OFFSET: u64 = 0x8000;
const CONTENT_FILE_SIZE: u32 = 0x1000;
const CONTENT_FILE_PATH: &str = "files/data.bin";
const CONTENT_APPLOADER_OFFSET: usize = BOOT_SIZE + BI2_SIZE;

/// Byte offsets of the trailing `WiiPartitionHeader` fields, which are private
/// to `disc::wii` and so are written and patched as raw big-endian words.
const FIELD_TMD_SIZE: usize = 0x2A4;
const FIELD_CERT_CHAIN_SIZE: usize = 0x2AC;
const FIELD_H3_TABLE_OFF: usize = 0x2B4;
const FIELD_DATA_OFF: usize = 0x2B8;
const FIELD_DATA_SIZE: usize = 0x2BC;
const PART_HEADER_SIZE: usize = 0x2C0;

/// Offset of the ticket's `sig_issuer` inside a `WiiPartitionHeader`.
const FIELD_SIG_ISSUER: usize = size_of::<crate::nod::disc::wii::SignedHeader>();

fn set_be_u32(buf: &mut [u8], offset: usize, value: u32) {
    buf[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

// --- Fixture construction -------------------------------------------------

/// The decrypted contents of one partition: a Wii boot header, an apploader,
/// a DOL, an FST and a single user file.
fn build_partition_content(fst_data: &[u8]) -> Vec<u8> {
    let mut content = vec![0u8; PART_SECTORS * SECTOR_DATA_SIZE];

    let mut disc_header = DiscHeader::new_zeroed();
    disc_header.game_id = WII_GAME_ID;
    disc_header.wii_magic = WII_MAGIC;
    disc_header.game_title[..WII_GAME_TITLE.len()].copy_from_slice(WII_GAME_TITLE.as_bytes());
    content[..size_of::<DiscHeader>()].copy_from_slice(disc_header.as_bytes());

    let mut debug_header = DebugHeader::new_zeroed();
    debug_header.debug_load_address = 0x8130_0000.into();
    let debug_offset = size_of::<DiscHeader>();
    content[debug_offset..debug_offset + size_of::<DebugHeader>()]
        .copy_from_slice(debug_header.as_bytes());

    let mut boot_header = BootHeader::new_zeroed();
    boot_header.set_dol_offset(CONTENT_DOL_OFFSET, true);
    boot_header.set_fst_offset(CONTENT_FST_OFFSET, true);
    // The FST length is stored shifted right by two, so round it up rather
    // than truncating the tail of the string table away.
    boot_header.set_fst_size(fst_data.len().next_multiple_of(4) as u64, true);
    boot_header.set_fst_max_size(fst_data.len().next_multiple_of(4) as u64, true);
    boot_header.user_offset = ((CONTENT_FILE_OFFSET / 4) as u32).into();
    boot_header.user_size = (CONTENT_FILE_SIZE / 4).into();
    content[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()]
        .copy_from_slice(boot_header.as_bytes());

    let mut apploader = ApploaderHeader::new_zeroed();
    apploader.date[..10].copy_from_slice(b"2024/02/02");
    apploader.entry_point = 0x8130_0000.into();
    apploader.size = 0x40.into();
    apploader.trailer_size = 0x20.into();
    content[CONTENT_APPLOADER_OFFSET..CONTENT_APPLOADER_OFFSET + size_of::<ApploaderHeader>()]
        .copy_from_slice(apploader.as_bytes());
    let apploader_body = CONTENT_APPLOADER_OFFSET + size_of::<ApploaderHeader>();
    for (index, byte) in content[apploader_body..apploader_body + 0x60]
        .iter_mut()
        .enumerate()
    {
        *byte = (index % 193) as u8;
    }

    let mut dol = DolHeader::new_zeroed();
    dol.text_offs[0] = 0x100.into();
    dol.text_sizes[0] = 0x100.into();
    dol.text_addrs[0] = 0x8000_3100.into();
    dol.entry_point = 0x8000_3100.into();
    let dol_start = CONTENT_DOL_OFFSET as usize;
    content[dol_start..dol_start + size_of::<DolHeader>()].copy_from_slice(dol.as_bytes());
    for (index, byte) in content
        [dol_start + size_of::<DolHeader>()..dol_start + CONTENT_DOL_SIZE as usize]
        .iter_mut()
        .enumerate()
    {
        *byte = (index % 239) as u8;
    }

    let fst_start = CONTENT_FST_OFFSET as usize;
    content[fst_start..fst_start + fst_data.len()].copy_from_slice(fst_data);

    let file_start = CONTENT_FILE_OFFSET as usize;
    for (index, byte) in content[file_start..file_start + CONTENT_FILE_SIZE as usize]
        .iter_mut()
        .enumerate()
    {
        *byte = (index % 251) as u8 ^ 0x5A;
    }

    content
}

fn wii_fst_bytes() -> Box<[u8]> {
    let mut builder = FstBuilder::new(true);
    builder.add_file(CONTENT_FILE_PATH, CONTENT_FILE_OFFSET, CONTENT_FILE_SIZE);
    builder.finalize()
}

/// Wraps the decrypted content in Wii sectors, fills in the H0/H1/H2 hash
/// blocks, encrypts every sector, and returns the sectors plus the group's H3
/// hash.
fn build_partition_data(content: &[u8], key: &KeyBytes, encrypt: bool) -> (Vec<u8>, HashBytes) {
    let mut group = <[u8; SECTOR_GROUP_SIZE]>::new_box_zeroed().expect("sector group");
    for sector in 0..PART_SECTORS {
        let src = &content[sector * SECTOR_DATA_SIZE..(sector + 1) * SECTOR_DATA_SIZE];
        let start = sector * SECTOR_SIZE + HASHES_SIZE;
        group[start..start + SECTOR_DATA_SIZE].copy_from_slice(src);
    }

    let hashes = hash_sector_group(&group, true);
    for sector in 0..PART_SECTORS {
        let sector_data: &mut [u8; SECTOR_SIZE] = (&mut group
            [sector * SECTOR_SIZE..(sector + 1) * SECTOR_SIZE])
            .try_into()
            .expect("sector slice");
        hashes.apply(sector_data, sector);
        if encrypt {
            encrypt_sector(sector_data, key);
        }
    }

    (group.to_vec(), hashes.h3_hash)
}

/// A ticket whose `title_key` decrypts to [`WII_TITLE_KEY`] under the common
/// key selected by `common_key_idx`.
fn build_ticket(issuer: &str, common_key_idx: u8, keys: &[KeyBytes; 3]) -> Ticket {
    let mut ticket = Ticket::new_zeroed();
    ticket.header.sig_type = 0x0001_0001.into();
    ticket.sig_issuer[..issuer.len()].copy_from_slice(issuer.as_bytes());
    ticket.title_id = WII_TITLE_ID;
    ticket.ticket_id = *b"ROMWEAVE";
    ticket.version = 0;
    ticket.common_key_idx = common_key_idx;

    let mut iv: KeyBytes = [0; 16];
    iv[..8].copy_from_slice(&WII_TITLE_ID);
    let mut title_key = WII_TITLE_KEY;
    if let Some(common_key) = keys.get(common_key_idx as usize) {
        aes_cbc_encrypt(common_key, &iv, &mut title_key);
    }
    ticket.title_key = title_key;
    ticket
}

fn build_partition_header(ticket: &Ticket) -> Vec<u8> {
    let mut header = vec![0u8; PART_HEADER_SIZE];
    header[..size_of::<Ticket>()].copy_from_slice(ticket.as_bytes());
    set_be_u32(&mut header, FIELD_TMD_SIZE, PART_TMD_SIZE);
    set_be_u32(&mut header, FIELD_TMD_SIZE + 4, PART_TMD_OFF >> 2);
    set_be_u32(&mut header, FIELD_CERT_CHAIN_SIZE, PART_CERT_SIZE);
    set_be_u32(&mut header, FIELD_CERT_CHAIN_SIZE + 4, PART_CERT_OFF >> 2);
    set_be_u32(&mut header, FIELD_H3_TABLE_OFF, PART_H3_OFF >> 2);
    set_be_u32(&mut header, FIELD_DATA_OFF, PART_DATA_OFF >> 2);
    set_be_u32(&mut header, FIELD_DATA_SIZE, (PART_DATA_SIZE >> 2) as u32);
    header
}

fn filler(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|index| seed.wrapping_add((index % 251) as u8))
        .collect()
}

/// Builds the full synthetic Wii disc. `no_partition_hashes` and
/// `no_partition_encryption` are written into the disc header exactly as the
/// format stores them, so callers can produce the decrypted and hashless
/// variants the reader has separate branches for.
pub(crate) fn build_wii_iso_with(no_partition_hashes: u8, no_partition_encryption: u8) -> Vec<u8> {
    let mut image = vec![0u8; WII_DISC_SIZE];

    let mut disc_header = DiscHeader::new_zeroed();
    disc_header.game_id = WII_GAME_ID;
    disc_header.wii_magic = WII_MAGIC;
    disc_header.game_title[..WII_GAME_TITLE.len()].copy_from_slice(WII_GAME_TITLE.as_bytes());
    disc_header.no_partition_hashes = no_partition_hashes;
    disc_header.no_partition_encryption = no_partition_encryption;
    image[..size_of::<DiscHeader>()].copy_from_slice(disc_header.as_bytes());

    // Partition group 0 holds both partitions; groups 1-3 stay empty.
    let group_start = WII_PART_GROUP_OFF as usize;
    set_be_u32(&mut image, group_start, 2);
    set_be_u32(
        &mut image,
        group_start + 4,
        (PART_GROUP_ENTRY_OFF >> 2) as u32,
    );

    let entry_start = PART_GROUP_ENTRY_OFF as usize;
    for (index, (offset, kind)) in [(PART0_OFFSET, 1u32), (PART1_OFFSET, 0u32)]
        .into_iter()
        .enumerate()
    {
        set_be_u32(&mut image, entry_start + index * 8, (offset >> 2) as u32);
        set_be_u32(&mut image, entry_start + index * 8 + 4, kind);
    }

    let region_start = REGION_OFFSET as usize;
    image[region_start..region_start + REGION_SIZE].copy_from_slice(&filler(REGION_SIZE, 0x30));

    let fst_data = wii_fst_bytes();
    let content = build_partition_content(&fst_data);
    let (data, h3_hash) =
        build_partition_data(&content, &WII_TITLE_KEY, no_partition_encryption == 0);
    let ticket = build_ticket(RVL_CERT_ISSUER_PPKI_TICKET, 0, &RETAIL_COMMON_KEYS);
    let header = build_partition_header(&ticket);

    for (index, partition_offset) in [PART0_OFFSET, PART1_OFFSET].into_iter().enumerate() {
        let base = partition_offset as usize;
        image[base..base + PART_HEADER_SIZE].copy_from_slice(&header);

        let tmd_start = base + PART_TMD_OFF as usize;
        image[tmd_start..tmd_start + PART_TMD_SIZE as usize]
            .copy_from_slice(&filler(PART_TMD_SIZE as usize, 0x10 + index as u8));

        let cert_start = base + PART_CERT_OFF as usize;
        image[cert_start..cert_start + PART_CERT_SIZE as usize]
            .copy_from_slice(&filler(PART_CERT_SIZE as usize, 0x80 + index as u8));

        let h3_start = base + PART_H3_OFF as usize;
        image[h3_start..h3_start + 20].copy_from_slice(&h3_hash);

        let data_start = base + PART_DATA_OFF as usize;
        image[data_start..data_start + data.len()].copy_from_slice(&data);
    }

    image
}

pub(crate) fn build_wii_iso() -> Vec<u8> {
    build_wii_iso_with(0, 0)
}

fn open_wii(image: Vec<u8>, options: &DiscOptions) -> PublicDiscReader {
    PublicDiscReader::new_stream(Box::new(image), options).expect("Wii fixture opens")
}

/// `DiscReader` is not `Debug`, so unwrap error arms by hand rather than
/// using `expect_err`.
fn expect_error<T>(result: Result<T>) -> Error {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(error) => error,
    }
}

/// Offset of a partition header field within the whole disc image.
fn part_field(partition_offset: u64, field: usize) -> usize {
    partition_offset as usize + field
}

// --- Fixture self-checks --------------------------------------------------

#[test]
fn fixture_ticket_title_key_decrypts_under_the_retail_common_key() {
    let ticket = build_ticket(RVL_CERT_ISSUER_PPKI_TICKET, 0, &RETAIL_COMMON_KEYS);
    assert_eq!(
        ticket.decrypt_title_key().expect("title key decrypts"),
        WII_TITLE_KEY
    );
    assert_ne!(
        ticket.title_key, WII_TITLE_KEY,
        "the stored title key must be encrypted"
    );

    let debug = build_ticket(RVL_CERT_ISSUER_DPKI_TICKET, 2, &DEBUG_COMMON_KEYS);
    assert_eq!(
        debug.decrypt_title_key().expect("debug title key decrypts"),
        WII_TITLE_KEY
    );
}

#[test]
fn fixture_partition_sectors_decrypt_back_to_the_hashed_content() {
    let fst_data = wii_fst_bytes();
    let content = build_partition_content(&fst_data);
    let (data, _) = build_partition_data(&content, &WII_TITLE_KEY, true);

    let mut sector: [u8; SECTOR_SIZE] = data[..SECTOR_SIZE].try_into().expect("first sector");
    decrypt_sector(&mut sector, &WII_TITLE_KEY);
    assert_eq!(
        &sector[HASHES_SIZE..],
        &content[..SECTOR_DATA_SIZE],
        "sector 0 must decrypt back to the partition content"
    );

    // The buffer-to-buffer variant must agree with the in-place one.
    let encrypted: [u8; SECTOR_SIZE] = data[..SECTOR_SIZE].try_into().expect("first sector");
    let mut b2b = [0u8; SECTOR_SIZE];
    decrypt_sector_b2b(&encrypted, &mut b2b, &WII_TITLE_KEY);
    assert_eq!(b2b, sector);
}

// --- DiscReader::new, Wii branches ---------------------------------------

#[test]
fn new_reads_the_disc_header_region_and_partition_extents() {
    let disc = open_wii(build_wii_iso(), &DiscOptions::default());

    assert_eq!(disc.header().game_id, WII_GAME_ID);
    assert!(disc.header().is_wii());
    assert_eq!(disc.disc_size(), WII_DISC_SIZE as u64);
    assert_eq!(disc.meta().format, Format::Iso);
    assert_eq!(disc.region().expect("Wii discs carry region info")[0], 0x30);

    let partitions = disc.partitions();
    assert_eq!(partitions.len(), 2);

    let update = &partitions[0];
    assert_eq!((update.index, update.kind), (0, PartitionKind::Update));
    assert_eq!(
        update.start_sector,
        (PART0_OFFSET / SECTOR_SIZE as u64) as u32
    );
    assert_eq!(
        update.data_start_sector,
        ((PART0_OFFSET + PART_DATA_OFF as u64) / SECTOR_SIZE as u64) as u32
    );
    assert_eq!(
        update.data_end_sector,
        update.data_start_sector + PART_SECTORS as u32
    );
    assert_eq!(update.data_size(), PART_DATA_SIZE);
    assert!(update.data_contains_sector(update.data_start_sector));
    assert!(!update.data_contains_sector(update.data_end_sector));

    let data = &partitions[1];
    assert_eq!((data.index, data.kind), (1, PartitionKind::Data));
    assert_eq!(
        data.start_sector,
        (PART1_OFFSET / SECTOR_SIZE as u64) as u32
    );
}

#[test]
fn new_decrypts_each_partition_boot_block_and_fst() {
    let disc = open_wii(build_wii_iso(), &DiscOptions::default());
    let partitions = disc.partitions();

    for partition in partitions {
        assert_eq!(partition.key, WII_TITLE_KEY);
        assert!(partition.has_encryption);
        assert!(partition.has_hashes);
    }

    let data = &partitions[1];
    // The partition's own boot block and FST were decrypted during parsing.
    assert!(data.disc_header().is_wii());
    assert_eq!(data.boot_header().fst_offset(true), CONTENT_FST_OFFSET);
    let fst = data.fst().expect("partition FST parses");
    assert_eq!(fst.num_files(), 1);
    let (_, node) = fst
        .find(CONTENT_FILE_PATH)
        .expect("the fixture file is in the FST");
    assert_eq!(node.offset(true), CONTENT_FILE_OFFSET);
    assert_eq!(node.length(), CONTENT_FILE_SIZE);
}

#[test]
fn new_rejects_a_disc_that_is_neither_gamecube_nor_wii() {
    let mut image = vec![0u8; 2 * SECTOR_SIZE];
    image[..4].copy_from_slice(b"JUNK");
    let io = crate::nod::io::iso::BlockReaderISO::new(Box::new(image) as Box<dyn DiscStream>)
        .expect("raw ISO reader accepts any stream");
    let error = expect_error(DiscReader::new(io, &DiscOptions::default()));
    assert!(
        error.to_string().contains("Invalid disc header"),
        "unexpected message: {error}"
    );
}

#[test]
fn new_rejects_an_encrypted_disc_without_partition_hashes() {
    let image = build_wii_iso_with(1, 0);
    let error = expect_error(PublicDiscReader::new_stream(
        Box::new(image),
        &DiscOptions::default(),
    ));
    assert!(
        error
            .to_string()
            .contains("Wii disc is encrypted but has no partition hashes"),
        "unexpected message: {error}"
    );
}

#[test]
fn new_rejects_rebuilding_encryption_for_a_disc_without_hashes() {
    let image = build_wii_iso_with(1, 1);
    let error = expect_error(PublicDiscReader::new_stream(
        Box::new(image),
        &DiscOptions {
            partition_encryption: PartitionEncryption::ForceEncrypted,
            ..Default::default()
        },
    ));
    assert!(
        error
            .to_string()
            .contains("Rebuilding encryption for Wii disc without hashes"),
        "unexpected message: {error}"
    );
}

#[test]
fn force_decrypted_rewrites_the_disc_header_and_partition_flags() {
    let disc = open_wii(
        build_wii_iso(),
        &DiscOptions {
            partition_encryption: PartitionEncryption::ForceDecrypted,
            ..Default::default()
        },
    );

    assert_eq!(disc.header().no_partition_encryption, 1);
    assert!(!disc.header().has_partition_encryption());
    for partition in disc.partitions() {
        assert!(
            !partition.has_encryption,
            "the alternate partition list must drop encryption"
        );
    }

    // The original partition list keeps the on-disc flags.
    let inner = disc.into_inner();
    for partition in inner.orig_partitions() {
        assert!(partition.has_encryption);
    }
    assert!(!inner.partitions()[0].has_encryption);
}

#[test]
fn force_encrypted_leaves_the_partitions_marked_encrypted() {
    let disc = open_wii(
        build_wii_iso(),
        &DiscOptions {
            partition_encryption: PartitionEncryption::ForceEncrypted,
            ..Default::default()
        },
    );
    assert_eq!(disc.header().no_partition_encryption, 0);
    assert!(disc.partitions().iter().all(|p| p.has_encryption));
}

#[test]
fn force_decrypted_serves_the_rewritten_header_from_the_read_stream() {
    let mut disc = open_wii(
        build_wii_iso(),
        &DiscOptions {
            partition_encryption: PartitionEncryption::ForceDecrypted,
            ..Default::default()
        },
    );
    let mut head = vec![0u8; size_of::<DiscHeader>()];
    disc.read_exact(&mut head).expect("read the disc header");
    let header = DiscHeader::read_from_bytes(&head).expect("disc header");
    assert_eq!(header.no_partition_encryption, 1);
    assert!(header.is_wii());
}

// --- Partition access -----------------------------------------------------

#[test]
fn open_partition_reads_the_decrypted_partition_contents() {
    let disc = open_wii(build_wii_iso(), &DiscOptions::default());
    let mut partition = disc
        .open_partition_kind(PartitionKind::Data, &PartitionOptions::default())
        .expect("data partition opens");
    assert!(partition.is_wii());

    let meta = partition.meta().expect("partition metadata");
    assert!(meta.disc_header().is_wii());
    assert_eq!(meta.raw_dol.len(), CONTENT_DOL_SIZE as usize);
    assert_eq!(
        meta.raw_ticket.as_deref().expect("ticket").len(),
        size_of::<Ticket>()
    );
    assert_eq!(
        meta.raw_tmd.as_deref().expect("TMD"),
        filler(PART_TMD_SIZE as usize, 0x11).as_slice()
    );
    assert_eq!(
        meta.raw_cert_chain.as_deref().expect("cert chain"),
        filler(PART_CERT_SIZE as usize, 0x81).as_slice()
    );
    let h3 = meta.raw_h3_table.as_deref().expect("H3 table");
    assert_eq!(h3.len(), H3_TABLE_SIZE);
    assert!(h3[..20].iter().any(|&b| b != 0), "H3 hash must be present");

    let expected = build_partition_content(&wii_fst_bytes());
    let mut out = vec![0u8; CONTENT_FILE_SIZE as usize];
    partition
        .seek(SeekFrom::Start(CONTENT_FILE_OFFSET))
        .expect("seek to the user file");
    partition.read_exact(&mut out).expect("read the user file");
    assert_eq!(
        out,
        expected[CONTENT_FILE_OFFSET as usize
            ..CONTENT_FILE_OFFSET as usize + CONTENT_FILE_SIZE as usize],
        "AES-CBC decryption must return the original file bytes"
    );
}

#[test]
fn open_partition_validates_the_hash_tree_when_asked() {
    let disc = open_wii(build_wii_iso(), &DiscOptions::default());
    let mut partition = disc
        .open_partition(
            1,
            &PartitionOptions {
                validate_hashes: true,
            },
        )
        .expect("data partition opens with hash validation");

    let expected = build_partition_content(&wii_fst_bytes());
    let mut out = vec![0u8; CONTENT_FILE_SIZE as usize];
    partition
        .seek(SeekFrom::Start(CONTENT_FILE_OFFSET))
        .expect("seek to the user file");
    partition
        .read_exact(&mut out)
        .expect("hash validation must accept the fixture's hash tree");
    assert_eq!(
        out,
        expected[CONTENT_FILE_OFFSET as usize
            ..CONTENT_FILE_OFFSET as usize + CONTENT_FILE_SIZE as usize]
    );
}

#[test]
fn open_partition_rejects_an_index_or_kind_that_is_not_present() {
    let disc = open_wii(build_wii_iso(), &DiscOptions::default());

    let error = expect_error(disc.open_partition(2, &PartitionOptions::default()));
    assert!(
        error.to_string().contains("Partition 2 not found"),
        "unexpected message: {error}"
    );

    let error = expect_error(
        disc.open_partition_kind(PartitionKind::Channel, &PartitionOptions::default()),
    );
    assert!(
        error
            .to_string()
            .contains("Partition type Channel not found"),
        "unexpected message: {error}"
    );
}

#[test]
fn wii_discs_expose_no_gamecube_boot_header_or_fst() {
    let disc = open_wii(build_wii_iso(), &DiscOptions::default()).into_inner();
    assert!(disc.boot_header().is_none());
    assert!(disc.fst().is_none());
}

// --- read_partition_info error branches -----------------------------------

#[test]
fn read_partition_info_rejects_an_unaligned_partition_offset() {
    let mut image = build_wii_iso();
    // The ticket is decrypted before the alignment check, so the misaligned
    // offset still has to point at a readable partition header.
    let base = PART0_OFFSET as usize;
    let header = image[base..base + PART_HEADER_SIZE].to_vec();
    image[base + 4..base + 4 + PART_HEADER_SIZE].copy_from_slice(&header);
    let entry = PART_GROUP_ENTRY_OFF as usize;
    set_be_u32(&mut image, entry, ((PART0_OFFSET + 4) >> 2) as u32);

    let error = expect_error(PublicDiscReader::new_stream(
        Box::new(image),
        &DiscOptions::default(),
    ));
    assert!(
        error
            .to_string()
            .contains("Partition 0:0 offset is not sector aligned"),
        "unexpected message: {error}"
    );
}

#[test]
fn read_partition_info_rejects_unaligned_partition_data() {
    let mut image = build_wii_iso();
    set_be_u32(
        &mut image,
        part_field(PART0_OFFSET, FIELD_DATA_OFF),
        (PART_DATA_OFF + 4) >> 2,
    );

    let error = expect_error(PublicDiscReader::new_stream(
        Box::new(image),
        &DiscOptions::default(),
    ));
    assert!(
        error
            .to_string()
            .contains("Partition 0:0 data is not sector aligned"),
        "unexpected message: {error}"
    );
}

#[test]
fn read_partition_info_rejects_an_fst_that_runs_past_the_data_size() {
    let mut image = build_wii_iso();
    // One sector of data cannot hold a file that ends at 0x9000.
    set_be_u32(
        &mut image,
        part_field(PART0_OFFSET, FIELD_DATA_SIZE),
        (SECTOR_SIZE >> 2) as u32,
    );

    let error = expect_error(PublicDiscReader::new_stream(
        Box::new(image),
        &DiscOptions::default(),
    ));
    assert!(
        error
            .to_string()
            .contains("Partition 0:0 FST exceeds data size"),
        "unexpected message: {error}"
    );
}

#[test]
fn read_partition_info_guesses_the_data_end_for_a_zero_sized_partition() {
    let mut image = build_wii_iso();
    set_be_u32(&mut image, part_field(PART0_OFFSET, FIELD_DATA_SIZE), 0);

    let disc = open_wii(image, &DiscOptions::default());
    let partition = &disc.partitions()[0];
    // The guess is derived from the highest FST file end, rounded up to a whole
    // sector. `data_end_sector` is an absolute disc sector, so the
    // partition-relative count is added to the partition's data start.
    let expected = partition.data_start_sector
        + (CONTENT_FILE_OFFSET + CONTENT_FILE_SIZE as u64).div_ceil(SECTOR_SIZE as u64) as u32;
    assert_eq!(partition.data_end_sector, expected);
    // Absolute means the partition describes a non-empty region, which the
    // relative count did not: data_size() underflowed and data_contains_sector
    // was false everywhere.
    assert!(partition.data_end_sector > partition.data_start_sector);
    assert!(partition.data_contains_sector(partition.data_start_sector));
}

#[test]
fn read_partition_info_keeps_a_partition_whose_fst_is_unparsable() {
    let mut image = build_wii_iso();
    // Corrupt the FST root node's length so `Fst::new` reports the string
    // table as out of bounds, then re-seal the partition data. The value stays
    // well under `u32::MAX / 12`, which `Fst::new` multiplies without checking.
    let fst_data = wii_fst_bytes();
    let mut content = build_partition_content(&fst_data);
    let root_length = CONTENT_FST_OFFSET as usize + 8;
    content[root_length..root_length + 4].copy_from_slice(&0x1000u32.to_be_bytes());
    let (data, _) = build_partition_data(&content, &WII_TITLE_KEY, true);
    let data_start = (PART0_OFFSET + PART_DATA_OFF as u64) as usize;
    image[data_start..data_start + data.len()].copy_from_slice(&data);

    let disc = open_wii(image, &DiscOptions::default());
    let partition = &disc.partitions()[0];
    assert!(
        partition.raw_fst.is_none(),
        "an unparsable FST is dropped, not fatal"
    );
    assert!(partition.fst().is_none());
    // The rest of the partition is still described.
    assert_eq!(partition.kind, PartitionKind::Update);
    assert_eq!(partition.key, WII_TITLE_KEY);
}

#[test]
fn read_partition_info_keeps_a_partition_whose_header_is_not_wii() {
    let mut image = build_wii_iso();
    let fst_data = wii_fst_bytes();
    let mut content = build_partition_content(&fst_data);
    // Clear the partition's own Wii magic.
    content[0x18..0x1C].fill(0);
    let (data, _) = build_partition_data(&content, &WII_TITLE_KEY, true);
    let data_start = (PART0_OFFSET + PART_DATA_OFF as u64) as usize;
    image[data_start..data_start + data.len()].copy_from_slice(&data);

    let disc = open_wii(image, &DiscOptions::default());
    let partition = &disc.partitions()[0];
    assert!(partition.raw_fst.is_none());
    assert!(!partition.disc_header().is_wii());
}

#[test]
fn read_partition_info_rejects_a_ticket_with_an_unknown_issuer() {
    let mut image = build_wii_iso();
    let issuer = part_field(PART0_OFFSET, FIELD_SIG_ISSUER);
    image[issuer..issuer + 64].fill(0);
    image[issuer..issuer + 12].copy_from_slice(b"Root-CA9999\0");

    let error = expect_error(PublicDiscReader::new_stream(
        Box::new(image),
        &DiscOptions::default(),
    ));
    assert!(
        error.to_string().contains("unknown certificate issuer"),
        "unexpected message: {error}"
    );
}

#[test]
fn read_partition_info_rejects_a_ticket_with_an_unknown_common_key_index() {
    let mut image = build_wii_iso();
    let mut ticket = Ticket::read_from_bytes(
        &image[PART0_OFFSET as usize..PART0_OFFSET as usize + size_of::<Ticket>()],
    )
    .expect("ticket");
    ticket.common_key_idx = 9;
    image[PART0_OFFSET as usize..PART0_OFFSET as usize + size_of::<Ticket>()]
        .copy_from_slice(ticket.as_bytes());

    let error = expect_error(PublicDiscReader::new_stream(
        Box::new(image),
        &DiscOptions::default(),
    ));
    assert!(
        error.to_string().contains("unknown common key index 9"),
        "unexpected message: {error}"
    );
}

#[test]
fn read_partition_info_skips_empty_partition_groups() {
    let mut image = build_wii_iso();
    // Move both partitions into the last group; the first three are empty.
    set_be_u32(&mut image, WII_PART_GROUP_OFF as usize, 0);
    set_be_u32(&mut image, WII_PART_GROUP_OFF as usize + 4, 0);
    let last = WII_PART_GROUP_OFF as usize + 3 * 8;
    set_be_u32(&mut image, last, 2);
    set_be_u32(&mut image, last + 4, (PART_GROUP_ENTRY_OFF >> 2) as u32);

    let disc = open_wii(image, &DiscOptions::default());
    assert_eq!(disc.partitions().len(), 2);
    assert_eq!(disc.partitions()[0].index, 0);
    assert_eq!(disc.partitions()[1].kind, PartitionKind::Data);
}

// --- guess_disc_size and seeking ------------------------------------------

#[test]
fn guess_disc_size_picks_a_layout_from_the_partition_extents() {
    assert_eq!(guess_disc_size(&[]), MINI_DVD_SIZE);

    let disc = open_wii(build_wii_iso(), &DiscOptions::default());
    let partitions = disc.partitions().to_vec();

    // A data partition that fits on a single layer.
    assert_eq!(guess_disc_size(&partitions), SL_DVD_SIZE);

    // Without a data partition, a small disc is treated as a Datel MiniDVD.
    let update_only = [partitions[0].clone()];
    assert_eq!(guess_disc_size(&update_only), MINI_DVD_SIZE);

    // Anything past the single-layer size needs a dual-layer disc.
    let mut huge = partitions[1].clone();
    huge.data_end_sector = (SL_DVD_SIZE / SECTOR_SIZE as u64) as u32 + 1;
    assert_eq!(guess_disc_size(&[huge]), DL_DVD_SIZE);
}

#[test]
fn seek_supports_start_and_current_but_not_end() {
    let mut disc = open_wii(build_wii_iso(), &DiscOptions::default()).into_inner();
    assert_eq!(disc.position(), 0);

    assert_eq!(
        disc.seek(SeekFrom::Start(SECTOR_SIZE as u64))
            .expect("seek from start"),
        SECTOR_SIZE as u64
    );
    assert_eq!(disc.position(), SECTOR_SIZE as u64);

    assert_eq!(
        disc.seek(SeekFrom::Current(-16))
            .expect("seek from current"),
        SECTOR_SIZE as u64 - 16
    );
    // Seeking before the start saturates rather than wrapping.
    assert_eq!(
        disc.seek(SeekFrom::Current(-(SECTOR_SIZE as i64)))
            .expect("saturating seek"),
        0
    );

    let error = disc
        .seek(SeekFrom::End(0))
        .expect_err("SeekFrom::End is unsupported");
    assert_eq!(error.kind(), io::ErrorKind::Unsupported);

    disc.seek(SeekFrom::Start(64)).expect("seek");
    disc.reset();
    assert_eq!(disc.position(), 0);
}

#[test]
fn reading_past_the_end_of_the_disc_yields_nothing() {
    let mut disc = open_wii(build_wii_iso(), &DiscOptions::default()).into_inner();
    disc.seek(SeekFrom::Start(WII_DISC_SIZE as u64))
        .expect("seek to the end");
    assert!(disc.fill_buf().expect("fill_buf at the end").is_empty());
    assert!(
        disc.fill_buf_internal()
            .expect("fill_buf_internal at the end")
            .is_empty()
    );
}

#[test]
fn fill_buf_internal_matches_fill_buf_across_a_partition_boundary() {
    let mut disc = open_wii(build_wii_iso(), &DiscOptions::default()).into_inner();
    let start = PART1_OFFSET + PART_DATA_OFF as u64;
    disc.seek(SeekFrom::Start(start)).expect("seek");
    let internal = disc
        .fill_buf_internal()
        .expect("fill_buf_internal")
        .to_vec();

    let mut disc = open_wii(build_wii_iso(), &DiscOptions::default()).into_inner();
    disc.seek(SeekFrom::Start(start)).expect("seek");
    let direct = disc.fill_buf().expect("fill_buf").to_vec();

    assert!(!internal.is_empty());
    assert_eq!(internal, direct);
}

#[test]
fn load_sector_group_reports_partition_and_raw_groups() {
    let mut disc = open_wii(build_wii_iso(), &DiscOptions::default()).into_inner();

    let data_start = ((PART1_OFFSET + PART_DATA_OFF as u64) / SECTOR_SIZE as u64) as u32;
    let (group, _) = disc
        .load_sector_group(data_start, false)
        .expect("partition group loads");
    assert_eq!(group.start_sector, data_start);

    // A sector outside every partition is served from the raw disc grid.
    let (group, _) = disc.load_sector_group(0, false).expect("raw group loads");
    assert_eq!(group.start_sector, 0);
}

#[test]
fn the_whole_wii_disc_reads_back_byte_for_byte() {
    let image = build_wii_iso();
    let mut disc = open_wii(image.clone(), &DiscOptions::default());
    let mut out = Vec::with_capacity(image.len());
    crate::nod::util::buf_copy(&mut disc, &mut out).expect("read the whole disc");
    assert_eq!(out.len(), image.len());
    assert_eq!(
        out, image,
        "re-encrypting every partition sector must reproduce the source disc"
    );
}

// --- GameCube branches of the same accessors ------------------------------

#[test]
fn gamecube_discs_have_one_data_partition_and_no_region_info() {
    let disc = PublicDiscReader::new_stream(
        Box::new(crate::nod::tests::build_gamecube_iso()),
        &DiscOptions::default(),
    )
    .expect("GameCube fixture opens");

    assert!(disc.region().is_none());
    assert!(disc.partitions().is_empty());

    let mut partition = disc
        .open_partition(0, &PartitionOptions::default())
        .expect("the only GameCube partition opens");
    assert!(!partition.is_wii());
    assert!(partition.meta().is_ok());

    let error = expect_error(disc.open_partition(1, &PartitionOptions::default()));
    assert!(
        error
            .to_string()
            .contains("GameCube discs only have one partition"),
        "unexpected message: {error}"
    );

    disc.open_partition_kind(PartitionKind::Data, &PartitionOptions::default())
        .expect("the data partition opens by kind");
    let error =
        expect_error(disc.open_partition_kind(PartitionKind::Update, &PartitionOptions::default()));
    assert!(
        error
            .to_string()
            .contains("GameCube discs only have a data partition"),
        "unexpected message: {error}"
    );

    // A GameCube disc exposes its boot header and FST directly.
    let inner = disc.into_inner();
    assert!(inner.boot_header().is_some());
    assert!(inner.fst().is_some());
    assert!(inner.orig_partitions().is_empty());
}

#[test]
fn fill_buf_internal_serves_the_rewritten_disc_header() {
    let mut disc = open_wii(
        build_wii_iso(),
        &DiscOptions {
            partition_encryption: PartitionEncryption::ForceDecrypted,
            ..Default::default()
        },
    )
    .into_inner();

    let head = disc.fill_buf_internal().expect("fill_buf_internal");
    assert_eq!(head.len(), size_of::<DiscHeader>());
    let header = DiscHeader::read_from_bytes(&head).expect("disc header");
    assert_eq!(header.no_partition_encryption, 1);

    // Part-way into the header the same rewritten bytes are served from the
    // requested offset onwards.
    disc.seek(SeekFrom::Start(0x20)).expect("seek");
    let tail = disc.fill_buf_internal().expect("fill_buf_internal");
    assert_eq!(tail.len(), size_of::<DiscHeader>() - 0x20);
    // `game_title` starts at 0x20, so the slice begins mid-header.
    assert_eq!(&tail[..WII_GAME_TITLE.len()], WII_GAME_TITLE.as_bytes());
}

// --- util/aes buffer-to-buffer helpers ------------------------------------

#[test]
fn decrypt_sector_data_b2b_matches_the_in_place_decryption() {
    let fst_data = wii_fst_bytes();
    let content = build_partition_content(&fst_data);
    let (data, _) = build_partition_data(&content, &WII_TITLE_KEY, true);

    let encrypted: [u8; SECTOR_SIZE] = data[SECTOR_SIZE..2 * SECTOR_SIZE]
        .try_into()
        .expect("second sector");
    let mut out = [0u8; SECTOR_DATA_SIZE];
    crate::nod::util::aes::decrypt_sector_data_b2b(&encrypted, &mut out, &WII_TITLE_KEY);

    let mut in_place = encrypted;
    decrypt_sector(&mut in_place, &WII_TITLE_KEY);
    assert_eq!(out, in_place[HASHES_SIZE..]);
    assert_eq!(
        out.as_slice(),
        &content[SECTOR_DATA_SIZE..2 * SECTOR_DATA_SIZE],
        "the data half must match the partition content"
    );
}
