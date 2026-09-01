//! Coverage for `src/nod/common.rs`: the `Format`/`Compression` enums, the
//! compression level validator and parser, and the `PartitionInfo` views.

use std::{str::FromStr, sync::Arc};

use zerocopy::{FromZeros, IntoBytes};

use super::*;
use crate::nod::disc::{
    GCN_MAGIC, WII_MAGIC,
    fst::{FstBuilder, NodeKind},
};

fn partition_info(raw_fst: Option<Arc<[u8]>>) -> PartitionInfo {
    let mut raw_boot = Box::new([0u8; BOOT_SIZE]);
    let mut disc_header = DiscHeader::new_zeroed();
    disc_header.game_id = *b"RPARTX";
    disc_header.disc_num = 2;
    disc_header.wii_magic = WII_MAGIC;
    raw_boot[..size_of::<DiscHeader>()].copy_from_slice(disc_header.as_bytes());

    let mut debug_header = DebugHeader::new_zeroed();
    debug_header.debug_mon_offset = 0x1234.into();
    debug_header.debug_load_address = 0x8100_0000.into();
    let debug_offset = size_of::<DiscHeader>();
    raw_boot[debug_offset..debug_offset + size_of::<DebugHeader>()]
        .copy_from_slice(debug_header.as_bytes());

    let mut boot_header = BootHeader::new_zeroed();
    boot_header.set_fst_offset(0x8000, true);
    boot_header.set_fst_size(0x40, true);
    raw_boot[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()]
        .copy_from_slice(boot_header.as_bytes());

    PartitionInfo {
        index: 0,
        kind: PartitionKind::Data,
        start_sector: 4,
        data_start_sector: 8,
        data_end_sector: 24,
        key: [0x5A; 16],
        header: Arc::new(WiiPartitionHeader::new_zeroed()),
        has_encryption: true,
        has_hashes: true,
        raw_boot: Arc::from(raw_boot),
        raw_fst,
    }
}

// --- Format ---------------------------------------------------------------

#[test]
fn format_default_block_size_matches_each_format() {
    assert_eq!(Format::default(), Format::Iso);
    assert_eq!(Format::Iso.default_block_size(), 0);
    assert_eq!(Format::Nfs.default_block_size(), 0);
    assert_eq!(Format::Tgc.default_block_size(), 0);
    assert_eq!(
        Format::Ciso.default_block_size(),
        crate::nod::io::ciso::DEFAULT_BLOCK_SIZE
    );
    assert_eq!(
        Format::Gcz.default_block_size(),
        crate::nod::io::gcz::DEFAULT_BLOCK_SIZE
    );
    assert_eq!(
        Format::Rvz.default_block_size(),
        crate::nod::io::wia::RVZ_DEFAULT_CHUNK_SIZE
    );
    assert_eq!(
        Format::Wbfs.default_block_size(),
        crate::nod::io::wbfs::DEFAULT_BLOCK_SIZE
    );
    assert_eq!(
        Format::Wia.default_block_size(),
        crate::nod::io::wia::WIA_DEFAULT_CHUNK_SIZE
    );
}

#[test]
fn format_default_compression_matches_each_format() {
    assert_eq!(Format::Iso.default_compression(), Compression::None);
    assert_eq!(Format::Ciso.default_compression(), Compression::None);
    assert_eq!(Format::Wbfs.default_compression(), Compression::None);
    assert_eq!(Format::Tgc.default_compression(), Compression::None);
    assert_eq!(
        Format::Gcz.default_compression(),
        crate::nod::io::gcz::DEFAULT_COMPRESSION
    );
    assert_eq!(
        Format::Rvz.default_compression(),
        crate::nod::io::wia::RVZ_DEFAULT_COMPRESSION
    );
    assert_eq!(
        Format::Wia.default_compression(),
        crate::nod::io::wia::WIA_DEFAULT_COMPRESSION
    );
}

#[test]
fn format_display_names_every_variant() {
    let names = [
        (Format::Iso, "ISO"),
        (Format::Ciso, "CISO"),
        (Format::Gcz, "GCZ"),
        (Format::Nfs, "NFS"),
        (Format::Rvz, "RVZ"),
        (Format::Wbfs, "WBFS"),
        (Format::Wia, "WIA"),
        (Format::Tgc, "TGC"),
    ];
    for (format, name) in names {
        assert_eq!(format.to_string(), name);
    }
}

// --- Compression ----------------------------------------------------------

#[test]
fn validate_level_substitutes_the_default_for_zero() {
    let defaults = [
        (Compression::Bzip2(0), Compression::Bzip2(9)),
        (Compression::Deflate(0), Compression::Deflate(9)),
        (Compression::Lzma(0), Compression::Lzma(6)),
        (Compression::Lzma2(0), Compression::Lzma2(6)),
        (Compression::Zstandard(0), Compression::Zstandard(19)),
    ];
    for (mut compression, expected) in defaults {
        compression.validate_level().expect("level 0 is valid");
        assert_eq!(compression, expected);
    }

    let mut none = Compression::None;
    none.validate_level().expect("None has no level");
    assert_eq!(none, Compression::None);
}

#[test]
fn validate_level_accepts_in_range_levels() {
    for mut compression in [
        Compression::Bzip2(9),
        Compression::Deflate(10),
        Compression::Lzma(9),
        Compression::Lzma2(1),
        Compression::Zstandard(-22),
        Compression::Zstandard(22),
    ] {
        let before = compression;
        compression.validate_level().expect("level is in range");
        assert_eq!(compression, before, "an in-range level must not change");
    }
}

#[test]
fn validate_level_rejects_out_of_range_levels() {
    let cases = [
        (
            Compression::Bzip2(10),
            "Invalid BZIP2 compression level: 10",
        ),
        (
            Compression::Deflate(11),
            "Invalid Deflate compression level: 11",
        ),
        (Compression::Lzma(10), "Invalid LZMA compression level: 10"),
        (
            Compression::Lzma2(10),
            "Invalid LZMA2 compression level: 10",
        ),
        (
            Compression::Zstandard(-23),
            "Invalid Zstandard compression level: -23",
        ),
    ];
    for (mut compression, expected) in cases {
        let error = compression
            .validate_level()
            .expect_err("level is out of range");
        assert!(
            error.to_string().contains(expected),
            "unexpected message for {compression:?}: {error}"
        );
    }
}

#[test]
fn compression_display_omits_the_level_when_it_is_zero() {
    let cases = [
        (Compression::None, "None"),
        (Compression::Bzip2(0), "BZIP2"),
        (Compression::Bzip2(9), "BZIP2 (9)"),
        (Compression::Deflate(0), "Deflate"),
        (Compression::Deflate(6), "Deflate (6)"),
        (Compression::Lzma(0), "LZMA"),
        (Compression::Lzma(1), "LZMA (1)"),
        (Compression::Lzma2(0), "LZMA2"),
        (Compression::Lzma2(7), "LZMA2 (7)"),
        (Compression::Zstandard(0), "Zstandard"),
        (Compression::Zstandard(-3), "Zstandard (-3)"),
    ];
    for (compression, expected) in cases {
        assert_eq!(compression.to_string(), expected);
    }
}

#[test]
fn compression_from_str_accepts_every_alias_without_a_level() {
    let cases = [
        ("", Compression::None),
        ("none", Compression::None),
        ("NONE", Compression::None),
        ("bz2", Compression::Bzip2(0)),
        ("bzip2", Compression::Bzip2(0)),
        ("deflate", Compression::Deflate(0)),
        ("gz", Compression::Deflate(0)),
        ("gzip", Compression::Deflate(0)),
        ("lzma", Compression::Lzma(0)),
        ("lzma2", Compression::Lzma2(0)),
        ("xz", Compression::Lzma2(0)),
        ("zst", Compression::Zstandard(0)),
        ("zstd", Compression::Zstandard(0)),
        ("Zstandard", Compression::Zstandard(0)),
    ];
    for (input, expected) in cases {
        assert_eq!(
            Compression::from_str(input).expect("known alias"),
            expected,
            "parsing {input:?}"
        );
    }
}

#[test]
fn compression_from_str_accepts_colon_and_dot_level_separators() {
    assert_eq!(
        Compression::from_str("zstd:19").expect("colon separator"),
        Compression::Zstandard(19)
    );
    assert_eq!(
        Compression::from_str("lzma2.9").expect("dot separator"),
        Compression::Lzma2(9)
    );
    assert_eq!(
        Compression::from_str("zstd:-5").expect("negative level"),
        Compression::Zstandard(-5)
    );
}

#[test]
fn compression_from_str_rejects_unknown_names_and_unparsable_levels() {
    let error = Compression::from_str("brotli").expect_err("unknown algorithm");
    assert_eq!(error, "Unknown compression type: \"brotli\"");

    let error = Compression::from_str("zstd:high").expect_err("unparsable level");
    assert_eq!(error, "Failed to parse compression level: \"high\"");
}

// --- PartitionKind --------------------------------------------------------

#[test]
fn partition_kind_from_u32_maps_the_known_values() {
    assert_eq!(PartitionKind::from(0), PartitionKind::Data);
    assert_eq!(PartitionKind::from(1), PartitionKind::Update);
    assert_eq!(PartitionKind::from(2), PartitionKind::Channel);
    let other = u32::from_be_bytes(*b"INST");
    assert_eq!(PartitionKind::from(other), PartitionKind::Other(other));
}

#[test]
fn partition_kind_display_and_dir_name_cover_every_variant() {
    assert_eq!(PartitionKind::Data.to_string(), "Data");
    assert_eq!(PartitionKind::Update.to_string(), "Update");
    assert_eq!(PartitionKind::Channel.to_string(), "Channel");
    assert_eq!(PartitionKind::Data.dir_name(), "DATA");
    assert_eq!(PartitionKind::Update.dir_name(), "UPDATE");
    assert_eq!(PartitionKind::Channel.dir_name(), "CHANNEL");

    let other = PartitionKind::Other(u32::from_be_bytes(*b"INST"));
    assert_eq!(other.to_string(), "Other (494E5354, INST)");
    assert_eq!(other.dir_name(), "P-INST");
}

// --- PartitionInfo --------------------------------------------------------

#[test]
fn partition_info_data_size_and_sector_membership() {
    let info = partition_info(None);
    assert_eq!(info.data_size(), 16 * SECTOR_SIZE as u64);
    assert!(!info.data_contains_sector(7));
    assert!(info.data_contains_sector(8));
    assert!(info.data_contains_sector(23));
    assert!(!info.data_contains_sector(24));
}

#[test]
fn partition_info_exposes_views_into_raw_boot() {
    let info = partition_info(None);

    let disc_header = info.disc_header();
    assert_eq!(disc_header.game_id_str(), "RPARTX");
    assert_eq!(disc_header.disc_num, 2);
    assert!(disc_header.is_wii());
    assert!(!disc_header.is_gamecube());
    assert_ne!(disc_header.gcn_magic, GCN_MAGIC);

    let debug_header = info.debug_header();
    assert_eq!(debug_header.debug_mon_offset.get(), 0x1234);
    assert_eq!(debug_header.debug_load_address.get(), 0x8100_0000);

    let boot_header = info.boot_header();
    assert_eq!(boot_header.fst_offset(true), 0x8000);
    assert_eq!(boot_header.fst_size(true), 0x40);
}

#[test]
fn partition_info_fst_is_none_without_a_table_and_parses_one_when_present() {
    assert!(partition_info(None).fst().is_none());

    let mut builder = FstBuilder::new(true);
    builder.add_file("sound/bgm.brstm", 0x8000, 0x400);
    let raw_fst: Arc<[u8]> = Arc::from(builder.finalize());

    let info = partition_info(Some(raw_fst));
    let fst = info.fst().expect("FST parses");
    assert_eq!(fst.num_files(), 1);
    let (_, node) = fst.find("/sound/bgm.brstm").expect("file is present");
    assert_eq!(node.kind(), NodeKind::File);
    assert_eq!(node.offset(true), 0x8000);
    assert_eq!(node.length(), 0x400);
}
