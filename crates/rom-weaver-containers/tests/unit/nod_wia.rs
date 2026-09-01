//! Unit coverage for the WIA/RVZ block reader and disc writer
//! (`src/nod/io/wia.rs`) beyond the header/validation cases in that file's
//! inline `tests` module: the group-geometry helpers, the exception-list and
//! RVZ-packing codecs, and full ISO -> WIA/RVZ -> ISO round trips that drive
//! `DiscWriterWIA` and `BlockReaderWIA` against each other.

use super::*;

// --- read_exception_lists ---------------------------------------------------

/// One serialized `WIAExceptionList`: a `u16` count followed by that many
/// 22-byte `WIAException` records.
fn exception_list_bytes(offsets: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(offsets.len() as u16).to_be_bytes());
    for (index, offset) in offsets.iter().enumerate() {
        bytes.extend_from_slice(&offset.to_be_bytes());
        bytes.extend_from_slice(&[index as u8; 20]);
    }
    bytes
}

#[test]
fn read_exception_lists_parses_counts_and_entries() {
    let mut bytes = Bytes::from(exception_list_bytes(&[0x10, 0x20]));
    let lists = read_exception_lists(&mut bytes, 0x200000, false).expect("read exception lists");
    assert_eq!(lists.len(), 1, "one list per 2 MiB of chunk");
    assert_eq!(lists[0].len(), 2);
    assert_eq!(lists[0][0].offset.get(), 0x10);
    assert_eq!(lists[0][1].offset.get(), 0x20);
    assert_eq!(lists[0][1].hash, [1u8; 20]);
    assert_eq!(bytes.remaining(), 0);
}

#[test]
fn read_exception_lists_makes_one_list_per_two_mib_of_chunk() {
    let mut payload = exception_list_bytes(&[1]);
    payload.extend_from_slice(&exception_list_bytes(&[]));
    let mut bytes = Bytes::from(payload);
    let lists = read_exception_lists(&mut bytes, 0x400000, false).expect("read exception lists");
    assert_eq!(lists.len(), 2);
    assert_eq!(lists[0].len(), 1);
    assert!(lists[1].is_empty());
}

#[test]
fn read_exception_lists_aligns_to_four_bytes_when_requested() {
    // 2 count bytes + one 22-byte exception = 24 consumed, already a multiple
    // of 4, so nothing is skipped.
    let mut aligned = Bytes::from({
        let mut bytes = exception_list_bytes(&[1]);
        bytes.extend_from_slice(&[0xAA; 4]);
        bytes
    });
    read_exception_lists(&mut aligned, 0x200000, true).expect("aligned read");
    assert_eq!(aligned.remaining(), 4);

    // An empty list consumes only the 2 count bytes, so 2 padding bytes are
    // skipped to reach the next 4-byte boundary.
    let mut unaligned = Bytes::from({
        let mut bytes = exception_list_bytes(&[]);
        bytes.extend_from_slice(&[0xAA; 4]);
        bytes
    });
    read_exception_lists(&mut unaligned, 0x200000, true).expect("unaligned read");
    assert_eq!(unaligned.remaining(), 2);
}

#[test]
fn read_exception_lists_rejects_truncated_input() {
    let mut short_count = Bytes::from(vec![0u8]);
    let err = read_exception_lists(&mut short_count, 0x200000, false).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);

    // Declares two exceptions but supplies none of their bytes.
    let mut short_entries = Bytes::from(vec![0x00, 0x02]);
    let err = read_exception_lists(&mut short_entries, 0x200000, false).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
}

// --- GroupInfo geometry ------------------------------------------------------

fn test_disc(chunk_size: u32, encrypted: bool) -> WIADisc {
    let mut disc_head = [0u8; DISC_HEAD_SIZE];
    // 0x61 is the "no crypto" flag: 0 means the partition data is encrypted.
    disc_head[0x61] = u8::from(!encrypted);
    WIADisc {
        disc_type: DiscKind::Wii.into(),
        compression: WIACompression::None.into(),
        compression_level: I32::new(0),
        chunk_size: U32::new(chunk_size),
        disc_head,
        num_partitions: U32::new(1),
        partition_type_size: U32::new(size_of::<WIAPartition>() as u32),
        partition_offset: U64::new(0),
        partition_hash: sha1_hash(&[]),
        num_raw_data: U32::new(1),
        raw_data_offset: U64::new(0),
        raw_data_size: U32::new(0),
        num_groups: U32::new(0),
        group_offset: U64::new(0),
        group_size: U32::new(0),
        compr_data_len: 0,
        compr_data: [0u8; 7],
    }
}

fn test_partition(
    first_sector: u32,
    num_sectors: u32,
    group_index: u32,
    num_groups: u32,
) -> WIAPartition {
    WIAPartition {
        partition_key: [7u8; 16],
        partition_data: [
            WIAPartitionData {
                first_sector: U32::new(first_sector),
                num_sectors: U32::new(num_sectors),
                group_index: U32::new(group_index),
                num_groups: U32::new(num_groups),
            },
            WIAPartitionData {
                first_sector: U32::new(0),
                num_sectors: U32::new(0),
                group_index: U32::new(0),
                num_groups: U32::new(0),
            },
        ],
    }
}

#[test]
fn group_info_from_partition_derives_sector_size_and_offset() {
    // 4 sectors per chunk, a partition covering sectors 100..110, groups 5..8.
    let disc = test_disc(4 * SECTOR_SIZE as u32, true);
    let partition = test_partition(100, 10, 5, 3);
    let pd = &partition.partition_data[0];

    let first = GroupInfo::from_partition(5, &disc, &partition, pd);
    assert_eq!(first.sector, 100);
    assert_eq!(first.num_sectors, 4);
    assert_eq!(first.size, 4 * SECTOR_DATA_SIZE as u32);
    assert_eq!(first.section_offset, 0);
    assert!(first.in_partition);
    assert_eq!(
        first.partition_key,
        Some([7u8; 16]),
        "an encrypted partition carries its title key"
    );

    // The last group is clipped by the end of the partition data.
    let last = GroupInfo::from_partition(7, &disc, &partition, pd);
    assert_eq!(last.sector, 108);
    assert_eq!(last.num_sectors, 2, "sectors 108..110 only");
    assert_eq!(last.size, 2 * SECTOR_DATA_SIZE as u32);
    assert_eq!(last.section_offset, 8 * SECTOR_DATA_SIZE as u64);
}

#[test]
fn group_info_from_partition_omits_the_key_for_unencrypted_data() {
    let disc = test_disc(4 * SECTOR_SIZE as u32, false);
    let partition = test_partition(0, 4, 0, 1);
    let info = GroupInfo::from_partition(0, &disc, &partition, &partition.partition_data[0]);
    assert_eq!(info.partition_key, None);
}

#[test]
fn group_info_from_raw_data_clips_the_last_group_to_the_region_end() {
    let disc = test_disc(4 * SECTOR_SIZE as u32, true);
    // Raw data covering 6 sectors, so the second group holds only 2.
    let rd = WIARawData {
        raw_data_offset: U64::new(0),
        raw_data_size: U64::new(6 * SECTOR_SIZE as u64),
        group_index: U32::new(0),
        num_groups: U32::new(2),
    };

    let first = GroupInfo::from_raw_data(0, &disc, &rd);
    assert_eq!(first.sector, 0);
    assert_eq!(first.size, 4 * SECTOR_SIZE as u32);
    assert_eq!(first.num_sectors, 4);
    assert_eq!(first.section_offset, 0);
    assert!(!first.in_partition);
    assert_eq!(first.partition_key, None);

    let second = GroupInfo::from_raw_data(1, &disc, &rd);
    assert_eq!(second.sector, 4);
    assert_eq!(second.size, 2 * SECTOR_SIZE as u32);
    assert_eq!(second.num_sectors, 2);
    assert_eq!(second.section_offset, 4 * SECTOR_SIZE as u64);
}

#[test]
fn find_group_info_prefers_partitions_over_raw_data() {
    let disc = test_disc(4 * SECTOR_SIZE as u32, true);
    let partitions = [test_partition(0, 4, 0, 1)];
    let raw_data = [WIARawData {
        raw_data_offset: U64::new(0),
        raw_data_size: U64::new(8 * SECTOR_SIZE as u64),
        group_index: U32::new(0),
        num_groups: U32::new(2),
    }];

    // Group 0 is claimed by both; the partition wins.
    let info = find_group_info(0, &disc, &partitions, &raw_data).expect("group 0");
    assert!(info.in_partition);

    // Group 1 belongs only to the raw-data region.
    let info = find_group_info(1, &disc, &partitions, &raw_data).expect("group 1");
    assert!(!info.in_partition);

    assert!(find_group_info(9, &disc, &partitions, &raw_data).is_none());
}

#[test]
fn find_group_info_for_sector_maps_sectors_back_to_their_group() {
    let disc = test_disc(4 * SECTOR_SIZE as u32, true);
    let partitions = [test_partition(0, 8, 0, 2)];
    let raw_data = [WIARawData {
        raw_data_offset: U64::new(8 * SECTOR_SIZE as u64),
        raw_data_size: U64::new(4 * SECTOR_SIZE as u64),
        group_index: U32::new(2),
        num_groups: U32::new(1),
    }];

    let info = find_group_info_for_sector(5, &disc, &partitions, &raw_data).expect("sector 5");
    assert_eq!(
        info.index, 1,
        "sector 5 falls in the partition's second group"
    );
    assert!(info.in_partition);

    let info = find_group_info_for_sector(9, &disc, &partitions, &raw_data).expect("sector 9");
    assert_eq!(info.index, 2);
    assert!(!info.in_partition);

    assert!(find_group_info_for_sector(99, &disc, &partitions, &raw_data).is_none());
}

// --- rvz_unpack --------------------------------------------------------------

fn raw_data_group_info(size: u32) -> GroupInfo {
    GroupInfo {
        index: 0,
        sector: 0,
        num_sectors: size.div_ceil(SECTOR_SIZE as u32),
        size,
        section_offset: 0,
        in_partition: false,
        partition_key: None,
    }
}

#[test]
fn rvz_unpack_copies_raw_segments_verbatim() {
    let payload = (0..64_u8).collect::<Vec<_>>();
    let mut packed = Vec::new();
    packed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    packed.extend_from_slice(&payload);

    let info = raw_data_group_info(payload.len() as u32);
    let mut out = vec![0u8; payload.len()];
    rvz_unpack(&mut Bytes::from(packed), &mut out, &info).expect("unpack raw segment");
    assert_eq!(out, payload);
}

#[test]
fn rvz_unpack_regenerates_junk_from_a_packed_seed() {
    // A junk segment stores a big-endian LFG seed instead of the data itself;
    // unpacking must reproduce exactly what the same seed generates.
    let mut seed = [0u32; SEED_SIZE];
    LaggedFibonacci::generate_seed_be(&mut seed, *b"RWTE", 0, 0);
    let junk_len = 256_u32;

    let mut packed = Vec::new();
    packed.extend_from_slice(&(junk_len | COMPRESSED_BIT).to_be_bytes());
    packed.extend_from_slice(seed.as_bytes());

    let info = raw_data_group_info(junk_len);
    let mut out = vec![0u8; junk_len as usize];
    rvz_unpack(&mut Bytes::from(packed), &mut out, &info).expect("unpack junk segment");

    let mut expected = vec![0u8; junk_len as usize];
    let mut lfg = LaggedFibonacci::default();
    lfg.init_with_seed(*b"RWTE", 0, 0);
    lfg.fill(&mut expected);
    assert_eq!(out, expected);
    assert_ne!(out, vec![0u8; junk_len as usize], "junk must not be zeroes");
}

#[test]
fn rvz_unpack_rejects_oversized_segments_and_size_mismatches() {
    let info = raw_data_group_info(16);

    // Raw segment longer than the output buffer.
    let mut packed = Vec::new();
    packed.extend_from_slice(&999_u32.to_be_bytes());
    let mut out = vec![0u8; 16];
    let err = rvz_unpack(&mut Bytes::from(packed), &mut out, &info).unwrap_err();
    assert!(format!("{err}").contains("RVZ packed data size too large"));

    // Junk segment longer than the output buffer.
    let mut packed = Vec::new();
    packed.extend_from_slice(&(999_u32 | COMPRESSED_BIT).to_be_bytes());
    let err = rvz_unpack(&mut Bytes::from(packed), &mut out, &info).unwrap_err();
    assert!(format!("{err}").contains("RVZ packed junk size too large"));

    // A well-formed segment that does not fill the declared group size.
    let mut packed = Vec::new();
    packed.extend_from_slice(&4_u32.to_be_bytes());
    packed.extend_from_slice(&[0xAA; 4]);
    let err = rvz_unpack(&mut Bytes::from(packed), &mut out, &info).unwrap_err();
    assert!(format!("{err}").contains("RVZ packed data size mismatch"));
}

// --- Compression parameter mapping -------------------------------------------

#[test]
fn compression_to_wia_maps_every_supported_algorithm() {
    assert_eq!(
        compression_to_wia(Compression::None),
        Some((WIACompression::None, 0))
    );
    assert_eq!(
        compression_to_wia(Compression::Bzip2(9)),
        Some((WIACompression::Bzip2, 9))
    );
    assert_eq!(
        compression_to_wia(Compression::Lzma(6)),
        Some((WIACompression::Lzma, 6))
    );
    assert_eq!(
        compression_to_wia(Compression::Lzma2(6)),
        Some((WIACompression::Lzma2, 6))
    );
    assert_eq!(
        compression_to_wia(Compression::Zstandard(-3)),
        Some((WIACompression::Zstandard, -3))
    );
    // Deflate is a GCZ-only codec with no WIA/RVZ representation.
    assert_eq!(compression_to_wia(Compression::Deflate(6)), None);
}

#[test]
fn compress_bound_grows_with_each_codecs_worst_case() {
    assert_eq!(compress_bound(Compression::None, 1000), 1000);
    assert_eq!(compress_bound(Compression::Bzip2(9), 1000), 1250);
    assert_eq!(compress_bound(Compression::Lzma(6), 1000), 65100);
    assert_eq!(compress_bound(Compression::Lzma2(6), 1000), 2001);
    assert!(
        compress_bound(Compression::Zstandard(3), 1000) >= 1000,
        "a codec bound must never undercut the input size"
    );
}

#[test]
fn compr_data_emits_props_only_for_the_lzma_family() {
    assert!(
        compr_data(Compression::None).expect("none").is_empty(),
        "codecs without props store an empty compr_data blob"
    );
    assert!(
        compr_data(Compression::Zstandard(3))
            .expect("zstd")
            .is_empty()
    );
    // LZMA props are 5 bytes; LZMA2 props are 1.
    assert_eq!(compr_data(Compression::Lzma(6)).expect("lzma").len(), 5);
    assert_eq!(compr_data(Compression::Lzma2(6)).expect("lzma2").len(), 1);
}

#[test]
fn partition_offset_to_raw_rescales_hash_stripped_offsets() {
    assert_eq!(partition_offset_to_raw(0), 0);
    assert_eq!(
        partition_offset_to_raw(SECTOR_DATA_SIZE as u64),
        SECTOR_SIZE as u64
    );
    // A partial sector rounds down to the containing sector's raw start.
    assert_eq!(partition_offset_to_raw(SECTOR_DATA_SIZE as u64 - 1), 0);
    assert_eq!(
        partition_offset_to_raw(3 * SECTOR_DATA_SIZE as u64 + 10),
        3 * SECTOR_SIZE as u64
    );
}

#[test]
fn verify_hash_reports_both_digests_on_a_mismatch() {
    verify_hash(b"payload", &sha1_hash(b"payload")).expect("matching hash");
    let err = verify_hash(b"payload", &[0u8; 20]).unwrap_err();
    let message = format!("{err}");
    assert!(message.contains("WIA/RVZ hash mismatch"), "{message}");
    assert!(
        message.contains("0000000000000000000000000000000000000000"),
        "the expected digest is spelled out in hex: {message}"
    );
}

// --- DiscMeta reporting ------------------------------------------------------

/// A `BlockReaderWIA` over an empty backing stream, built directly so the
/// metadata mapping can be checked for each compression kind without
/// producing a real image per codec.
fn meta_reader(magic: MagicBytes, compression: WIACompression, level: i32) -> BlockReaderWIA {
    let mut disc = test_disc(0x200000, true);
    disc.compression = compression.into();
    disc.compression_level = I32::new(level);
    disc.num_partitions = U32::new(0);
    disc.num_raw_data = U32::new(0);
    BlockReaderWIA {
        inner: Box::new(Vec::new()),
        header: WIAFileHeader {
            magic,
            version: U32::new(WIA_VERSION),
            version_compatible: U32::new(WIA_VERSION_READ_COMPATIBLE),
            disc_size: U32::new(0),
            disc_hash: [0u8; 20],
            iso_file_size: U64::new(0x4000),
            wia_file_size: U64::new(0),
            file_head_hash: [0u8; 20],
        },
        disc,
        partitions: Arc::from(Vec::<WIAPartition>::new()),
        raw_data: Arc::from(Vec::<WIARawData>::new()),
        groups: Arc::from(Vec::<RVZGroup>::new()),
        nkit_header: None,
        decompressor: DecompressionKind::None,
    }
}

#[test]
fn meta_maps_each_wia_compression_kind_and_format() {
    let cases = [
        (WIACompression::None, 0, Compression::None),
        (WIACompression::Purge, 0, Compression::None),
        (WIACompression::Bzip2, 9, Compression::Bzip2(9)),
        (WIACompression::Lzma, 6, Compression::Lzma(6)),
        (WIACompression::Lzma2, 6, Compression::Lzma2(6)),
        (WIACompression::Zstandard, -3, Compression::Zstandard(-3)),
    ];
    for (wia_compression, level, expected) in cases {
        let meta = meta_reader(WIA_MAGIC, wia_compression, level).meta();
        assert_eq!(meta.format, Format::Wia);
        assert_eq!(meta.compression, expected, "for {wia_compression:?}");
        assert_eq!(meta.block_size, Some(0x200000));
        assert_eq!(meta.disc_size, Some(0x4000));
        assert!(meta.decrypted);
        assert!(meta.needs_hash_recovery);
        assert!(meta.lossless);
    }

    let rvz_meta = meta_reader(RVZ_MAGIC, WIACompression::Zstandard, 5).meta();
    assert_eq!(rvz_meta.format, Format::Rvz);
}

#[test]
fn block_size_reports_the_disc_chunk_size() {
    assert_eq!(
        meta_reader(WIA_MAGIC, WIACompression::None, 0).block_size(),
        0x200000
    );
}

// --- ISO -> WIA/RVZ -> ISO round trips ---------------------------------------

const FIXTURE_SECTORS: usize = 16;

/// A synthetic GameCube image whose sectors deliberately exercise every RVZ
/// group shape: real data, an all-zero group, lagged-Fibonacci junk generated
/// from this disc's own ID, and junk generated from a foreign ID (which the
/// packer can only store by recovering the seed from the data itself).
fn gamecube_iso_fixture() -> Vec<u8> {
    let mut bytes = vec![0u8; FIXTURE_SECTORS * SECTOR_SIZE];
    bytes[..6].copy_from_slice(b"RWTEST");
    // GameCube disc magic.
    bytes[0x1C..0x20].copy_from_slice(&[0xC2, 0x33, 0x9F, 0x3D]);
    bytes[0x20..0x30].copy_from_slice(b"rom-weaver-test\0");

    let mut state = 0x1234_5678_u32;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state & 0xff) as u8
    };
    // Sector 0 tail and sector 3 hold incompressible-looking real data.
    for byte in bytes[0x440..SECTOR_SIZE].iter_mut() {
        *byte = next();
    }
    for byte in bytes[3 * SECTOR_SIZE..4 * SECTOR_SIZE].iter_mut() {
        *byte = next();
    }
    // Sectors 1-2 stay zero (a long zero run inside a non-zero group) and
    // sectors 4-7 stay zero (a wholly empty group).

    fill_junk_sectors(&mut bytes, 8..12, *b"RWTE");
    fill_junk_sectors(&mut bytes, 12..16, *b"ZZZZ");
    bytes
}

/// Writes per-sector LFG junk exactly as nod generates it, so the RVZ packer
/// recognizes each sector as junk rather than storing it verbatim.
fn fill_junk_sectors(bytes: &mut [u8], sectors: std::ops::Range<usize>, disc_id: [u8; 4]) {
    let mut lfg = LaggedFibonacci::default();
    for sector in sectors {
        lfg.init_with_seed(disc_id, 0, sector as u64 * SECTOR_SIZE as u64);
        lfg.fill(&mut bytes[sector * SECTOR_SIZE..(sector + 1) * SECTOR_SIZE]);
    }
}

/// Runs the fixture through `DiscWriterWIA`, applying the finalization header
/// the way a real caller must, and returns the complete image bytes.
fn write_wia_image(iso: &[u8], format: Format, compression: Compression) -> Vec<u8> {
    let disc = crate::nod::read::DiscReader::new_stream(
        Box::new(iso.to_vec()),
        &crate::nod::read::DiscOptions::default(),
    )
    .expect("open synthetic iso");
    let options = FormatOptions {
        format,
        compression,
        block_size: format.default_block_size(),
    };
    let writer = crate::nod::write::DiscWriter::new(disc, &options).expect("create wia/rvz writer");
    let mut out = Vec::new();
    let finalization = writer
        .process(
            |data, _processed, _total| {
                out.extend_from_slice(data.as_ref());
                Ok(())
            },
            &ProcessOptions::default(),
        )
        .expect("process wia/rvz image");
    assert!(
        !finalization.header.is_empty(),
        "WIA/RVZ always rewrites its header at finalization"
    );
    out[..finalization.header.len()].copy_from_slice(finalization.header.as_ref());
    out
}

/// Reads a written image back through nod's format detection into raw ISO bytes.
fn read_image_to_iso(image: &[u8]) -> Vec<u8> {
    let mut disc = crate::nod::read::DiscReader::new_stream(
        Box::new(image.to_vec()),
        &crate::nod::read::DiscOptions::default(),
    )
    .expect("open written wia/rvz image");
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut disc, &mut out).expect("read image back to iso");
    out
}

fn assert_round_trip(format: Format, compression: Compression) -> Vec<u8> {
    let iso = gamecube_iso_fixture();
    let image = write_wia_image(&iso, format, compression);
    assert_eq!(
        read_image_to_iso(&image),
        iso,
        "{format:?}/{compression:?} must round-trip byte for byte"
    );
    image
}

#[test]
fn rvz_zstandard_round_trips_the_fixture() {
    let image = assert_round_trip(Format::Rvz, Compression::Zstandard(5));
    assert_eq!(&image[..4], RVZ_MAGIC.as_slice());
    assert!(
        image.len() < FIXTURE_SECTORS * SECTOR_SIZE / 2,
        "junk packing and compression must shrink the image: {} bytes",
        image.len()
    );
}

#[test]
fn rvz_uncompressed_round_trips_and_packs_junk() {
    // With no compressor, RVZ packing is the only size reduction available,
    // so a smaller output proves the junk and zero runs were packed as seeds.
    let image = assert_round_trip(Format::Rvz, Compression::None);
    assert!(
        image.len() < FIXTURE_SECTORS * SECTOR_SIZE,
        "uncompressed RVZ must still pack junk runs: {} bytes",
        image.len()
    );
}

#[test]
fn wia_lzma_round_trips_the_fixture() {
    let image = assert_round_trip(Format::Wia, Compression::Lzma(6));
    assert_eq!(&image[..4], WIA_MAGIC.as_slice());
}

#[test]
fn wia_lzma2_round_trips_the_fixture() {
    assert_round_trip(Format::Wia, Compression::Lzma2(6));
}

#[test]
fn block_reader_reads_a_written_rvz_group_by_group() {
    let iso = gamecube_iso_fixture();
    let image = write_wia_image(&iso, Format::Rvz, Compression::Zstandard(5));
    let mut reader = BlockReaderWIA::new(Box::new(image)).expect("parse written rvz");
    assert_eq!(reader.block_size(), Format::Rvz.default_block_size());

    let sectors_per_chunk = reader.block_size() as usize / SECTOR_SIZE;
    let mut out = vec![0u8; reader.block_size() as usize];

    // The all-zero group is stored as the documented zero special case.
    let zero_block = reader
        .read_block(&mut out, 4)
        .expect("read the all-zero group");
    assert_eq!(zero_block.kind, BlockKind::Zero);

    // Every other group decodes back to the matching slice of the source ISO.
    for group_start in [0, 8, 12] {
        let block = reader
            .read_block(&mut out, group_start as u32)
            .expect("read group");
        assert_eq!(block.kind, BlockKind::Raw);
        assert_eq!(block.sector, group_start as u32);
        assert_eq!(block.count, sectors_per_chunk as u32);
        let start = group_start * SECTOR_SIZE;
        assert_eq!(
            &out[..sectors_per_chunk * SECTOR_SIZE],
            &iso[start..start + sectors_per_chunk * SECTOR_SIZE],
            "group at sector {group_start}"
        );
    }
}

/// Builds an RVZ writer over the fixture with the given compression.
fn rvz_writer(compression: Compression) -> crate::nod::write::DiscWriter {
    let disc = crate::nod::read::DiscReader::new_stream(
        Box::new(gamecube_iso_fixture()),
        &crate::nod::read::DiscOptions::default(),
    )
    .expect("open synthetic iso");
    crate::nod::write::DiscWriter::new(
        disc,
        &FormatOptions {
            format: Format::Rvz,
            compression,
            block_size: Format::Rvz.default_block_size(),
        },
    )
    .expect("create rvz writer")
}

#[test]
fn disc_writer_reports_weight_from_its_compression() {
    // `DiscWriterWeight` implements neither `PartialEq` nor `Debug`, so each
    // weight is checked by pattern rather than by comparison.
    let stored = rvz_writer(Compression::None);
    assert!(matches!(stored.weight(), DiscWriterWeight::Medium));
    assert_eq!(
        stored.progress_bound(),
        (FIXTURE_SECTORS * SECTOR_SIZE) as u64
    );

    let compressed = rvz_writer(Compression::Zstandard(5));
    assert!(matches!(compressed.weight(), DiscWriterWeight::Heavy));
}

#[test]
fn disc_writer_rejects_a_codec_wia_cannot_represent() {
    let iso = gamecube_iso_fixture();
    let disc = crate::nod::read::DiscReader::new_stream(
        Box::new(iso),
        &crate::nod::read::DiscOptions::default(),
    )
    .expect("open synthetic iso");
    // Deflate is GCZ-only; WIA/RVZ has no compression id for it.
    let result = crate::nod::write::DiscWriter::new(
        disc,
        &FormatOptions {
            format: Format::Rvz,
            compression: Compression::Deflate(6),
            block_size: Format::Rvz.default_block_size(),
        },
    );
    let err = match result {
        Ok(_) => panic!("expected an unsupported-compression error"),
        Err(err) => err,
    };
    assert!(
        format!("{err}").contains("Unsupported compression for WIA/RVZ"),
        "unexpected error: {err}"
    );
}

// --- Additional reader rejections --------------------------------------------

#[test]
fn file_header_validate_rejects_a_pre_v3_compatible_version() {
    // A version pair that clears the read-compatibility window but still
    // declares a `version_compatible` older than 0x30000 must be refused.
    let mut header = WIAFileHeader {
        magic: WIA_MAGIC,
        version: U32::new(WIA_VERSION),
        version_compatible: U32::new(0x0002_0000),
        disc_size: U32::new(size_of::<WIADisc>() as u32),
        disc_hash: [0u8; 20],
        iso_file_size: U64::new(0),
        wia_file_size: U64::new(0),
        file_head_hash: [0u8; 20],
    };
    let bytes = header.as_bytes().to_vec();
    header.file_head_hash = sha1_hash(&bytes[..bytes.len() - size_of::<HashBytes>()]);

    let err = header.validate().unwrap_err();
    assert!(
        format!("{err}").contains("is not supported"),
        "unexpected error: {err}"
    );
}

/// A reader over one uncompressed raw-data region with caller-supplied groups,
/// so `read_block`'s group-data consistency checks can be driven directly.
fn raw_reader(backing: Vec<u8>, num_sectors: u32, groups: Vec<RVZGroup>) -> BlockReaderWIA {
    let mut reader = meta_reader(RVZ_MAGIC, WIACompression::None, 0);
    reader.inner = Box::new(backing);
    reader.raw_data = Arc::from(vec![WIARawData {
        raw_data_offset: U64::new(0),
        raw_data_size: U64::new(num_sectors as u64 * SECTOR_SIZE as u64),
        group_index: U32::new(0),
        num_groups: U32::new(groups.len() as u32),
    }]);
    reader.groups = Arc::from(groups);
    reader
}

#[test]
fn read_block_rejects_a_group_shorter_than_its_declared_region() {
    // The group holds 16 bytes but its raw-data region covers four sectors.
    let group = RVZGroup {
        data_offset: U32::new(0),
        data_size_and_flag: U32::new(16),
        rvz_packed_size: U32::new(0),
    };
    let mut reader = raw_reader(vec![0u8; 16], 4, vec![group]);
    let mut out = vec![0u8; 4 * SECTOR_SIZE];
    let err = reader.read_block(&mut out, 0).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(
        format!("{err}").contains("data size mismatch"),
        "unexpected error: {err}"
    );
}

#[test]
fn read_block_rejects_rvz_group_data_left_unconsumed() {
    // One junk segment fills the whole sector, but three stray bytes follow it
    // inside the group payload.
    let mut seed = [0u32; SEED_SIZE];
    LaggedFibonacci::generate_seed_be(&mut seed, *b"RWTE", 0, 0);
    let mut backing = Vec::new();
    backing.extend_from_slice(&((SECTOR_SIZE as u32) | COMPRESSED_BIT).to_be_bytes());
    backing.extend_from_slice(seed.as_bytes());
    backing.extend_from_slice(&[0xAA; 3]);

    let group = RVZGroup {
        data_offset: U32::new(0),
        data_size_and_flag: U32::new(backing.len() as u32),
        rvz_packed_size: U32::new(SECTOR_SIZE as u32),
    };
    let mut reader = raw_reader(backing, 1, vec![group]);
    let mut out = vec![0u8; SECTOR_SIZE];
    let err = reader.read_block(&mut out, 0).unwrap_err();
    assert!(
        format!("{err}").contains("Failed to consume all group data"),
        "unexpected error: {err}"
    );
}
