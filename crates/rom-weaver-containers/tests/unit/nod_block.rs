//! Coverage for `src/nod/io/block.rs`: format detection, the `Block` view
//! helpers that carve sectors out of a block buffer, junk regeneration, and
//! the entry points that build a `BlockReader` from a stream or a path.

use std::{
    fs,
    io::Cursor,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use zerocopy::FromZeros;

use super::*;
use crate::nod::{
    common::PartitionKind,
    disc::{BOOT_SIZE, wii::WiiPartitionHeader},
    tests::{GC_GAME_ID, build_gamecube_iso, gc_disc_id},
    util::aes::encrypt_sector,
};

const TEST_KEY: KeyBytes = [0x42; 16];

fn temp_dir(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "rom-weaver-nod-block-{label}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn gamecube_disc_header() -> DiscHeader {
    let mut header = DiscHeader::new_zeroed();
    header.game_id = GC_GAME_ID;
    header.gcn_magic = crate::nod::disc::GCN_MAGIC;
    header
}

fn partition_info(has_encryption: bool, has_hashes: bool) -> PartitionInfo {
    PartitionInfo {
        index: 0,
        kind: PartitionKind::Data,
        start_sector: 0,
        data_start_sector: 4,
        data_end_sector: 68,
        key: TEST_KEY,
        header: Arc::new(WiiPartitionHeader::new_zeroed()),
        has_encryption,
        has_hashes,
        raw_boot: Arc::new([0u8; BOOT_SIZE]),
        raw_fst: None,
    }
}

/// `Box<dyn BlockReader>` is not `Debug`, so unwrap the error arm by hand
/// rather than using `expect_err`.
fn block_reader_error(result: Result<Box<dyn BlockReader>>) -> Error {
    match result {
        Ok(_) => panic!("expected a BlockReader error"),
        Err(error) => error,
    }
}

fn magic_header(magic: &[u8; 4]) -> [u8; 0x20] {
    let mut data = [0u8; 0x20];
    data[..4].copy_from_slice(magic);
    data
}

// --- Format detection -----------------------------------------------------

#[test]
fn detect_recognizes_every_container_magic() {
    let cases = [
        (CISO_MAGIC, Format::Ciso),
        (GCZ_MAGIC, Format::Gcz),
        (NFS_MAGIC, Format::Nfs),
        (TGC_MAGIC, Format::Tgc),
        (WBFS_MAGIC, Format::Wbfs),
        (WIA_MAGIC, Format::Wia),
        (RVZ_MAGIC, Format::Rvz),
    ];
    for (magic, expected) in cases {
        let mut cursor = Cursor::new(magic_header(&magic));
        assert_eq!(
            detect(&mut cursor).expect("detect succeeds"),
            Some(expected),
            "magic {magic:02X?}"
        );
    }
}

#[test]
fn detect_recognizes_raw_gamecube_and_wii_headers() {
    let mut gamecube = [0u8; 0x20];
    gamecube[0x1C..0x20].copy_from_slice(&GCN_MAGIC);
    assert_eq!(
        detect(&mut Cursor::new(gamecube)).expect("detect"),
        Some(Format::Iso)
    );

    let mut wii = [0u8; 0x20];
    wii[0x18..0x1C].copy_from_slice(&WII_MAGIC);
    assert_eq!(
        detect(&mut Cursor::new(wii)).expect("detect"),
        Some(Format::Iso)
    );
}

#[test]
fn detect_returns_none_for_unknown_data_and_short_streams() {
    assert_eq!(
        detect(&mut Cursor::new([0x11u8; 0x20])).expect("detect"),
        None
    );
    // A stream shorter than the 0x20-byte probe is "unknown", not an error.
    assert_eq!(detect(&mut Cursor::new([0u8; 4])).expect("detect"), None);
    assert_eq!(detect(&mut Cursor::new([0u8; 0])).expect("detect"), None);
}

// --- BlockReader construction --------------------------------------------

#[test]
fn new_from_stream_opens_a_raw_gamecube_image() {
    let image = build_gamecube_iso();
    let len = image.len() as u64;
    let reader = new(Box::new(image) as Box<dyn DiscStream>).expect("ISO stream opens");
    assert_eq!(reader.block_size(), SECTOR_SIZE as u32);
    let meta = reader.meta();
    assert_eq!(meta.format, Format::Iso);
    assert_eq!(meta.disc_size, Some(len));
}

#[test]
fn new_from_stream_rejects_nfs_and_unknown_data() {
    let mut nfs = vec![0u8; 0x200];
    nfs[..4].copy_from_slice(&NFS_MAGIC);
    let error = block_reader_error(new(Box::new(nfs) as Box<dyn DiscStream>));
    assert!(
        error.to_string().contains("NFS requires a filesystem path"),
        "unexpected message: {error}"
    );

    let error = block_reader_error(new(Box::new(vec![0x11u8; 0x40]) as Box<dyn DiscStream>));
    assert!(
        error.to_string().contains("Unknown disc format"),
        "unexpected message: {error}"
    );
}

#[test]
fn open_rejects_a_missing_path_and_a_directory() {
    let dir = temp_dir("open-errors");

    let missing = dir.join("absent.iso");
    let error = block_reader_error(open(&missing));
    assert!(
        error.to_string().contains("Failed to open"),
        "unexpected message: {error}"
    );

    let error = block_reader_error(open(&dir));
    assert!(
        error.to_string().contains("Input is not a file"),
        "unexpected message: {error}"
    );

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn open_reads_a_gamecube_image_from_disk() {
    let dir = temp_dir("open-iso");
    let path = dir.join("game.iso");
    let image = build_gamecube_iso();
    fs::write(&path, &image).expect("write fixture");

    let reader = open(&path).expect("ISO opens");
    assert_eq!(reader.meta().format, Format::Iso);
    assert_eq!(reader.meta().disc_size, Some(image.len() as u64));

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn open_rejects_an_unknown_format_on_disk() {
    let dir = temp_dir("open-unknown");
    let path = dir.join("garbage.bin");
    fs::write(&path, [0x11u8; 0x40]).expect("write fixture");

    let error = block_reader_error(open(&path));
    assert!(
        error.to_string().contains("Unknown disc format"),
        "unexpected message: {error}"
    );

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

// --- Block geometry -------------------------------------------------------

#[test]
fn block_constructors_derive_the_sector_range() {
    let block = Block::new(3, 4 * SECTOR_SIZE as u32, BlockKind::Raw);
    assert_eq!(block.sector, 12);
    assert_eq!(block.count, 4);
    assert!(block.contains(12));
    assert!(block.contains(15));
    assert!(!block.contains(11));
    assert!(!block.contains(16));

    let single = Block::sector(9, BlockKind::Zero);
    assert_eq!((single.sector, single.count), (9, 1));

    let range = Block::sectors(9, 5, BlockKind::Junk);
    assert_eq!((range.sector, range.count), (9, 5));

    let default = Block::default();
    assert_eq!(default.kind, BlockKind::None);
    assert!(default.io_duration.is_none());
}

#[test]
fn ensure_contains_names_the_block_range_it_rejected() {
    let block = Block::sectors(4, 2, BlockKind::Raw);
    block.ensure_contains(5).expect("sector is inside");
    let error = block.ensure_contains(6).expect_err("sector is outside");
    assert!(
        error
            .to_string()
            .contains("Sector 6 not in block range 4-6"),
        "unexpected message: {error}"
    );
}

// --- decrypt_block --------------------------------------------------------

#[test]
fn decrypt_block_decrypts_every_raw_sector_with_the_partition_key() {
    let mut plain = vec![0u8; 2 * SECTOR_SIZE];
    for (index, byte) in plain.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    let mut data = plain.clone();
    for sector in 0..2 {
        let start = sector * SECTOR_SIZE;
        encrypt_sector(
            (&mut data[start..start + SECTOR_SIZE]).try_into().unwrap(),
            &TEST_KEY,
        );
    }
    assert_ne!(data, plain, "the fixture must actually be encrypted");

    let block = Block::sectors(0, 2, BlockKind::Raw);
    block
        .decrypt_block(&mut data, Some(TEST_KEY))
        .expect("decrypts");
    assert_eq!(data, plain);
}

#[test]
fn decrypt_block_leaves_raw_data_alone_without_a_key() {
    let mut data = vec![0xABu8; SECTOR_SIZE];
    Block::sector(0, BlockKind::Raw)
        .decrypt_block(&mut data, None)
        .expect("no key, no change");
    assert!(data.iter().all(|&b| b == 0xAB));
}

#[test]
fn decrypt_block_zeroes_junk_and_zero_blocks_but_not_none_or_decrypted() {
    for kind in [BlockKind::Junk, BlockKind::Zero] {
        let mut data = vec![0xABu8; SECTOR_SIZE];
        Block::sector(0, kind)
            .decrypt_block(&mut data, Some(TEST_KEY))
            .expect("fills with zeroes");
        assert!(
            data.iter().all(|&b| b == 0),
            "{kind:?} must zero the buffer"
        );
    }

    for kind in [
        BlockKind::None,
        BlockKind::PartDecrypted { hash_block: true },
    ] {
        let mut data = vec![0xABu8; SECTOR_SIZE];
        Block::sector(0, kind)
            .decrypt_block(&mut data, Some(TEST_KEY))
            .expect("no-op");
        assert!(
            data.iter().all(|&b| b == 0xAB),
            "{kind:?} must leave the buffer untouched"
        );
    }
}

// --- copy_sector ----------------------------------------------------------

#[test]
fn copy_sector_reports_encryption_and_hashes_for_raw_partition_data() {
    let mut data = vec![0u8; SECTOR_SIZE];
    data[0] = 0x5A;
    let block = Block::sector(0, BlockKind::Raw);
    let header = gamecube_disc_header();

    let mut out = [0u8; SECTOR_SIZE];
    let partition = partition_info(true, true);
    let (encrypted, has_hashes) = block
        .copy_sector(&mut out, &data, 0, &header, Some(&partition))
        .expect("copies");
    assert!(encrypted);
    assert!(has_hashes);
    assert_eq!(out[0], 0x5A);

    let mut out = [0u8; SECTOR_SIZE];
    let (encrypted, has_hashes) = block
        .copy_sector(&mut out, &data, 0, &header, None)
        .expect("copies");
    assert!(!encrypted);
    assert!(!has_hashes);
}

#[test]
fn copy_sector_writes_only_the_data_half_for_a_decrypted_non_hash_block() {
    let mut data = vec![0u8; SECTOR_DATA_SIZE];
    data[0] = 0x33;
    let block = Block::sector(0, BlockKind::PartDecrypted { hash_block: false });

    let mut out = [0xFFu8; SECTOR_SIZE];
    let (encrypted, has_hashes) = block
        .copy_sector(
            &mut out,
            &data,
            0,
            &gamecube_disc_header(),
            Some(&partition_info(true, true)),
        )
        .expect("copies");
    assert!(!encrypted);
    assert!(!has_hashes);
    assert!(
        out[..HASHES_SIZE].iter().all(|&b| b == 0xFF),
        "the hash block must be left untouched"
    );
    assert_eq!(out[HASHES_SIZE], 0x33);
}

#[test]
fn copy_sector_keeps_the_hash_block_for_a_decrypted_hash_block() {
    let mut data = vec![0u8; SECTOR_SIZE];
    data[3] = 0x77;
    let block = Block::sector(0, BlockKind::PartDecrypted { hash_block: true });

    let mut out = [0u8; SECTOR_SIZE];
    let (encrypted, has_hashes) = block
        .copy_sector(
            &mut out,
            &data,
            0,
            &gamecube_disc_header(),
            Some(&partition_info(true, true)),
        )
        .expect("copies");
    assert!(!encrypted);
    assert!(has_hashes);
    assert_eq!(out[3], 0x77);
}

#[test]
fn copy_sector_fills_zero_blocks_and_leaves_empty_blocks_alone() {
    let data = vec![0x11u8; SECTOR_SIZE];
    let header = gamecube_disc_header();

    let mut out = [0xFFu8; SECTOR_SIZE];
    Block::sector(0, BlockKind::Zero)
        .copy_sector(&mut out, &data, 0, &header, None)
        .expect("zero block");
    assert!(out.iter().all(|&b| b == 0));

    let mut out = [0xFFu8; SECTOR_SIZE];
    Block::sector(0, BlockKind::None)
        .copy_sector(&mut out, &data, 0, &header, None)
        .expect("empty block");
    assert!(out.iter().all(|&b| b == 0xFF));
}

#[test]
fn copy_sector_regenerates_junk_matching_generate_junk_sector() {
    let header = gamecube_disc_header();
    let data = Vec::new();

    let mut out = [0u8; SECTOR_SIZE];
    Block::sector(5, BlockKind::Junk)
        .copy_sector(&mut out, &data, 5, &header, None)
        .expect("junk block");

    let mut expected = [0u8; SECTOR_SIZE];
    generate_junk_sector(&mut expected, 5, None, &header);
    assert_eq!(out, expected);

    let mut lfg = LaggedFibonacci::default();
    assert_eq!(
        lfg.check_sector_chunked(&out, gc_disc_id(), 0, 5 * SECTOR_SIZE as u64),
        SECTOR_SIZE
    );
}

#[test]
fn generate_junk_sector_skips_the_hash_block_inside_a_hashed_partition() {
    let header = gamecube_disc_header();
    let partition = partition_info(true, true);

    let mut out = [0xFFu8; SECTOR_SIZE];
    generate_junk_sector(&mut out, 6, Some(&partition), &header);
    assert!(
        out[..HASHES_SIZE].iter().all(|&b| b == 0),
        "the hash block is zeroed, not junk-filled"
    );

    let mut lfg = LaggedFibonacci::default();
    let sector_offset = (6 - partition.data_start_sector) as u64 * SECTOR_DATA_SIZE as u64;
    assert_eq!(
        lfg.check_sector_chunked(&out[HASHES_SIZE..], gc_disc_id(), 0, sector_offset),
        SECTOR_DATA_SIZE
    );
}

// --- Buffer views ---------------------------------------------------------

#[test]
fn sector_buf_and_sector_data_buf_index_from_the_block_start() {
    let mut data = vec![0u8; 3 * SECTOR_SIZE];
    data[SECTOR_SIZE] = 0x21;
    let block = Block::sectors(10, 3, BlockKind::Raw);

    assert_eq!(block.sector_buf(&data, 11).expect("in range")[0], 0x21);
    assert!(block.sector_buf(&data, 13).is_err());

    let mut data = vec![0u8; 3 * SECTOR_DATA_SIZE];
    data[SECTOR_DATA_SIZE] = 0x22;
    assert_eq!(block.sector_data_buf(&data, 11).expect("in range")[0], 0x22);
    assert!(block.sector_data_buf(&data, 9).is_err());
}

#[test]
fn data_returns_an_empty_slice_for_an_empty_block() {
    let data = vec![0x5Au8; SECTOR_SIZE];
    assert!(
        Block::sector(0, BlockKind::None)
            .data(&data, 0)
            .expect("empty block")
            .is_empty()
    );
}

#[test]
fn data_slices_from_the_requested_position_to_the_end_of_the_block() {
    let mut data = vec![0u8; 2 * SECTOR_SIZE];
    data[SECTOR_SIZE + 16] = 0x9A;
    let block = Block::sectors(4, 2, BlockKind::Raw);

    let pos = 4 * SECTOR_SIZE as u64 + SECTOR_SIZE as u64 + 16;
    let slice = block.data(&data, pos).expect("in range");
    assert_eq!(slice.len(), SECTOR_SIZE - 16);
    assert_eq!(slice[0], 0x9A);

    assert!(block.data(&data, 6 * SECTOR_SIZE as u64).is_err());
}

#[test]
fn partition_data_stops_at_the_sector_boundary_when_hashes_are_present() {
    let mut data = vec![0u8; 2 * SECTOR_SIZE];
    data[HASHES_SIZE + 8] = 0x40;
    let block = Block::sectors(4, 2, BlockKind::Raw);

    let slice = block.partition_data(&data, 8, 4, true).expect("in range");
    assert_eq!(
        slice.len(),
        SECTOR_DATA_SIZE - 8,
        "a hashed block must not read into the next sector's hashes"
    );
    assert_eq!(slice[0], 0x40);
}

#[test]
fn partition_data_spans_the_whole_block_when_hashes_are_absent() {
    let mut data = vec![0u8; 2 * SECTOR_SIZE];
    data[8] = 0x41;
    let block = Block::sectors(4, 2, BlockKind::Raw);

    let slice = block.partition_data(&data, 8, 4, false).expect("in range");
    assert_eq!(slice.len(), 2 * SECTOR_SIZE - 8);
    assert_eq!(slice[0], 0x41);
}

#[test]
fn partition_data_uses_hashless_stride_for_a_stripped_decrypted_block() {
    let mut data = vec![0u8; 2 * SECTOR_DATA_SIZE];
    data[SECTOR_DATA_SIZE + 4] = 0x42;
    let block = Block::sectors(4, 2, BlockKind::PartDecrypted { hash_block: false });

    let slice = block
        .partition_data(&data, SECTOR_DATA_SIZE as u64 + 4, 4, true)
        .expect("in range");
    assert_eq!(slice.len(), 2 * SECTOR_DATA_SIZE - SECTOR_DATA_SIZE - 4);
    assert_eq!(slice[0], 0x42);
}

#[test]
fn partition_data_returns_an_empty_slice_for_an_empty_block() {
    let data = vec![0u8; SECTOR_SIZE];
    assert!(
        Block::sector(4, BlockKind::None)
            .partition_data(&data, 0, 4, true)
            .expect("empty block")
            .is_empty()
    );
}

#[test]
fn partition_data_treats_junk_and_zero_blocks_as_hashless() {
    let mut data = vec![0u8; SECTOR_SIZE];
    data[0] = 0x43;
    for kind in [BlockKind::Junk, BlockKind::Zero] {
        let block = Block::sector(4, kind);
        let slice = block.partition_data(&data, 0, 4, true).expect("in range");
        assert_eq!(slice.len(), SECTOR_DATA_SIZE, "{kind:?}");
        assert_eq!(slice[0], 0x43, "{kind:?}");
    }
}

// --- Hash exceptions ------------------------------------------------------

#[test]
fn append_hash_exceptions_rebases_offsets_into_the_target_sector() {
    let mut block = Block::sectors(0, 64, BlockKind::Raw);
    let in_range = WIAException {
        offset: (2 * HASHES_SIZE as u16 + 0x10).into(),
        hash: [0x01; 20],
    };
    let out_of_range = WIAException {
        offset: (5 * HASHES_SIZE as u16).into(),
        hash: [0x02; 20],
    };
    block.hash_exceptions =
        vec![vec![in_range, out_of_range].into_boxed_slice()].into_boxed_slice();

    let mut out = Vec::new();
    block
        .append_hash_exceptions(2, 0, &mut out)
        .expect("sector is in the block");
    assert_eq!(out.len(), 1, "only the exceptions for sector 2 are kept");
    assert_eq!(out[0].offset.get(), 0x10);
    assert_eq!(out[0].hash, [0x01; 20]);

    let mut out = Vec::new();
    block
        .append_hash_exceptions(2, 3, &mut out)
        .expect("sector is in the block");
    assert_eq!(out[0].offset.get(), 3 * HASHES_SIZE as u16 + 0x10);
}

#[test]
fn append_hash_exceptions_yields_nothing_for_a_group_without_a_list() {
    let block = Block::sectors(0, 64, BlockKind::Raw);
    let mut out = Vec::new();
    block
        .append_hash_exceptions(1, 0, &mut out)
        .expect("sector is in the block");
    assert!(out.is_empty());

    assert!(block.append_hash_exceptions(64, 0, &mut out).is_err());
}
