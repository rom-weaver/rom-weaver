//! Unit tests for the GD-ROM data-track reader.
//!
//! Rather than depend on a multi-gigabyte real disc, these tests synthesize
//! tiny but standard ISO9660 images in memory (a miniature CD builder) and read
//! them back, exercising sector-format detection, the absolute-LBA bias, and
//! nested directories.

use std::io::Cursor;

use super::filesystem::{GD_HIGH_DENSITY_START_LBA, GdRomFs};
use super::iso9660::{self, parse_directory, parse_primary_volume_descriptor};
use super::sector::{LOGICAL_SECTOR_SIZE, SectorFormat};

const SECTOR: usize = LOGICAL_SECTOR_SIZE;

/// A file to place in a synthesized volume.
struct FileSpec {
    name: &'static str,
    data: Vec<u8>,
}

/// Encode an ISO9660 both-endian u32 (LE copy then BE copy).
fn both_endian_u32(value: u32) -> [u8; 8] {
    let le = value.to_le_bytes();
    let be = value.to_be_bytes();
    [le[0], le[1], le[2], le[3], be[0], be[1], be[2], be[3]]
}

/// Encode an ISO9660 both-endian u16.
fn both_endian_u16(value: u16) -> [u8; 4] {
    let le = value.to_le_bytes();
    let be = value.to_be_bytes();
    [le[0], le[1], be[0], be[1]]
}

/// Build one directory record. `name_bytes` is the raw identifier (e.g.
/// `b"HELLO.TXT;1"`, or `&[0x00]` / `&[0x01]` for `.` / `..`).
fn directory_record(extent_lba: u32, data_len: u32, is_dir: bool, name_bytes: &[u8]) -> Vec<u8> {
    let name_len = name_bytes.len();
    let mut record_len = 33 + name_len;
    if record_len % 2 == 1 {
        record_len += 1; // pad to even length
    }
    let mut rec = vec![0u8; record_len];
    rec[0] = record_len as u8;
    rec[1] = 0; // extended attribute record length
    rec[2..10].copy_from_slice(&both_endian_u32(extent_lba));
    rec[10..18].copy_from_slice(&both_endian_u32(data_len));
    // bytes 18..25: recording date/time, left zero
    rec[25] = if is_dir { 0x02 } else { 0x00 };
    // bytes 26..28: file unit size / interleave gap, zero
    rec[28..32].copy_from_slice(&both_endian_u16(1)); // volume sequence number
    rec[32] = name_len as u8;
    rec[33..33 + name_len].copy_from_slice(name_bytes);
    rec
}

/// Assemble a directory extent (`.`, `..`, then `children`) padded to whole
/// sectors. `self_lba`/`parent_lba` are the directory's own and its parent's
/// extent LBAs; `children` are pre-built child records.
fn directory_extent(self_lba: u32, parent_lba: u32, children: &[Vec<u8>]) -> Vec<u8> {
    let mut buf = Vec::new();
    // The . and .. self-records reference their own extents; data_len here is
    // a single sector, which is enough for these tiny test directories.
    buf.extend(directory_record(self_lba, SECTOR as u32, true, &[0x00]));
    buf.extend(directory_record(parent_lba, SECTOR as u32, true, &[0x01]));
    for child in children {
        // A directory record may not straddle a logical-sector boundary.
        let pos_in_sector = buf.len() % SECTOR;
        if pos_in_sector + child.len() > SECTOR {
            buf.resize(buf.len() + (SECTOR - pos_in_sector), 0);
        }
        buf.extend_from_slice(child);
    }
    let padded = buf.len().div_ceil(SECTOR) * SECTOR;
    buf.resize(padded, 0);
    buf
}

/// Build a cooked (2048-byte logical sectors) ISO9660 image with `bias` applied
/// to every recorded extent LBA. Layout: 0..16 system area, 16 PVD, 17
/// terminator, 18 root dir, optional subdir, then file data. `subdir` is an
/// optional `(name, files)` placed in the root.
fn build_iso(
    bias: u32,
    root_files: &[FileSpec],
    subdir: Option<(&'static str, &[FileSpec])>,
) -> Vec<u8> {
    // Sector assignment (track-relative; recorded LBA = sector + bias).
    let root_sector = 18u32;
    let mut next = 19u32;
    let subdir_sector = subdir.as_ref().map(|_| {
        let s = next;
        next += 1;
        s
    });

    // Allocate file data extents.
    let mut placed_root: Vec<(&FileSpec, u32)> = Vec::new();
    for f in root_files {
        placed_root.push((f, next));
        next += (f.data.len().div_ceil(SECTOR)).max(1) as u32;
    }
    let mut placed_sub: Vec<(&FileSpec, u32)> = Vec::new();
    if let Some((_, files)) = subdir {
        for f in files {
            placed_sub.push((f, next));
            next += (f.data.len().div_ceil(SECTOR)).max(1) as u32;
        }
    }
    let total_sectors = next;

    let mut image = vec![0u8; total_sectors as usize * SECTOR];
    let put = |image: &mut [u8], sector: u32, bytes: &[u8]| {
        let off = sector as usize * SECTOR;
        image[off..off + bytes.len()].copy_from_slice(bytes);
    };

    // Primary Volume Descriptor at sector 16.
    let mut pvd = vec![0u8; SECTOR];
    pvd[0] = 1; // primary
    pvd[1..6].copy_from_slice(b"CD001");
    pvd[6] = 1; // version
    pvd[80..88].copy_from_slice(&both_endian_u32(total_sectors)); // volume space size
    pvd[128..132].copy_from_slice(&both_endian_u16(SECTOR as u16)); // logical block size
    let root_record = directory_record(root_sector + bias, SECTOR as u32, true, &[0x00]);
    pvd[156..156 + root_record.len()].copy_from_slice(&root_record);
    put(&mut image, 16, &pvd);

    // Volume descriptor set terminator at sector 17.
    let mut term = vec![0u8; SECTOR];
    term[0] = 255;
    term[1..6].copy_from_slice(b"CD001");
    term[6] = 1;
    put(&mut image, 17, &term);

    // Root directory.
    let mut root_children = Vec::new();
    for (f, lba) in &placed_root {
        root_children.push(directory_record(
            lba + bias,
            f.data.len() as u32,
            false,
            format!("{};1", f.name).as_bytes(),
        ));
    }
    if let (Some((name, _)), Some(sub_lba)) = (subdir, subdir_sector) {
        root_children.push(directory_record(
            sub_lba + bias,
            SECTOR as u32,
            true,
            name.as_bytes(),
        ));
    }
    let root_extent = directory_extent(root_sector + bias, root_sector + bias, &root_children);
    put(&mut image, root_sector, &root_extent);

    // Subdirectory.
    if let Some(sub_lba) = subdir_sector {
        let mut sub_children = Vec::new();
        for (f, lba) in &placed_sub {
            sub_children.push(directory_record(
                lba + bias,
                f.data.len() as u32,
                false,
                format!("{};1", f.name).as_bytes(),
            ));
        }
        let sub_extent = directory_extent(sub_lba + bias, root_sector + bias, &sub_children);
        put(&mut image, sub_lba, &sub_extent);
    }

    // File data.
    for (f, lba) in placed_root.iter().chain(placed_sub.iter()) {
        put(&mut image, *lba, &f.data);
    }

    image
}

/// Wrap a cooked image's 2048-byte sectors into raw `MODE1/2352` physical
/// sectors (sync + header + data + zero EDC/ECC). The reader ignores EDC/ECC,
/// so zero-filling them is fine for read tests.
fn wrap_mode1_2352(cooked: &[u8]) -> Vec<u8> {
    assert_eq!(cooked.len() % SECTOR, 0);
    let sync = [
        0x00u8, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00,
    ];
    let mut out = Vec::with_capacity(cooked.len() / SECTOR * 2352);
    for chunk in cooked.chunks(SECTOR) {
        let mut raw = vec![0u8; 2352];
        raw[..12].copy_from_slice(&sync);
        raw[15] = 1; // MODE1
        raw[16..16 + SECTOR].copy_from_slice(chunk);
        out.extend_from_slice(&raw);
    }
    out
}

fn sample_files() -> Vec<FileSpec> {
    vec![
        FileSpec {
            name: "COSCAP.BIN",
            data: vec![0xAB; 100],
        },
        FileSpec {
            name: "MAKUMA.AFS",
            data: vec![0xCD; SECTOR + 500],
        }, // spans 2 sectors
        FileSpec {
            name: "README.TXT",
            data: b"hello gd-rom".to_vec(),
        },
    ]
}

#[test]
fn detect_distinguishes_cooked_and_raw_modes() {
    let cooked = build_iso(0, &sample_files(), None);
    assert_eq!(
        SectorFormat::detect(&cooked[..16], cooked.len() as u64).unwrap(),
        SectorFormat::COOKED_2048
    );
    let raw = wrap_mode1_2352(&cooked);
    assert_eq!(
        SectorFormat::detect(&raw[..16], raw.len() as u64).unwrap(),
        SectorFormat::MODE1_2352
    );
}

#[test]
fn reads_pvd_and_files_from_cooked_image_with_bias() {
    let bias = GD_HIGH_DENSITY_START_LBA;
    let cooked = build_iso(bias, &sample_files(), None);
    let mut fs = GdRomFs::open(Cursor::new(cooked), bias).expect("open fs");

    assert_eq!(fs.primary_volume_descriptor().logical_block_size, 2048);
    let names: Vec<_> = fs.files().keys().cloned().collect();
    assert_eq!(names, vec!["COSCAP.BIN", "MAKUMA.AFS", "README.TXT"]);

    // Recorded extents are absolute (biased); the reader resolves them.
    let readme = fs.file("README.TXT").expect("readme entry").clone();
    assert!(readme.extent_lba >= bias);
    assert_eq!(fs.read_file(&readme).unwrap(), b"hello gd-rom");

    let makuma = fs.file("MAKUMA.AFS").expect("makuma entry").clone();
    let bytes = fs.read_file(&makuma).unwrap();
    assert_eq!(bytes.len(), SECTOR + 500);
    assert!(bytes.iter().all(|&b| b == 0xCD));
}

#[test]
fn reads_files_through_raw_mode1_2352_framing() {
    let bias = GD_HIGH_DENSITY_START_LBA;
    let cooked = build_iso(bias, &sample_files(), None);
    let raw = wrap_mode1_2352(&cooked);
    let mut fs = GdRomFs::open(Cursor::new(raw), bias).expect("open raw fs");
    assert_eq!(fs.sector_format(), SectorFormat::MODE1_2352);

    let coscap = fs.file("COSCAP.BIN").expect("coscap entry").clone();
    assert_eq!(fs.read_file(&coscap).unwrap(), vec![0xAB; 100]);
}

#[test]
fn walks_nested_subdirectory() {
    let bias = 0;
    let sub = [FileSpec {
        name: "NESTED.DAT",
        data: vec![0x42; 64],
    }];
    let cooked = build_iso(bias, &sample_files(), Some(("SUBDIR", &sub)));
    let mut fs = GdRomFs::open(Cursor::new(cooked), bias).expect("open nested fs");

    let nested = fs.file("SUBDIR/NESTED.DAT").expect("nested entry").clone();
    assert_eq!(fs.read_file(&nested).unwrap(), vec![0x42; 64]);
    assert!(fs.file("COSCAP.BIN").is_some());
}

#[test]
fn read_logical_range_rejects_overrun_without_huge_alloc() {
    use super::sector::TrackSectors;

    // A small 4-sector cooked track.
    let track = vec![0xEEu8; 4 * SECTOR];
    let mut sectors = TrackSectors::open(Cursor::new(track)).expect("open track");
    assert_eq!(sectors.logical_sector_count(), 4);

    // An in-bounds read still works.
    let ok = sectors
        .read_logical_range(1, SECTOR as u64)
        .expect("in-bounds read");
    assert_eq!(ok.len(), SECTOR);

    // A bogus ~4 GiB length (as an untrusted extent size could carry) overruns
    // the track and must be rejected before reserving any capacity.
    let err = sectors
        .read_logical_range(0, u64::from(u32::MAX))
        .expect_err("overrun must be rejected");
    assert!(matches!(
        err,
        rom_weaver_core::RomWeaverError::Validation(_)
    ));

    // A start sector past the end of the track is rejected too.
    let err = sectors
        .read_logical_range(99, SECTOR as u64)
        .expect_err("past-end start must be rejected");
    assert!(matches!(
        err,
        rom_weaver_core::RomWeaverError::Validation(_)
    ));
}

#[test]
fn rejects_image_without_primary_descriptor() {
    let mut junk = vec![0u8; 32 * SECTOR];
    junk[16 * SECTOR] = 99; // wrong descriptor type at sector 16
    let err = match GdRomFs::open(Cursor::new(junk), 0) {
        Ok(_) => panic!("should reject image without a primary descriptor"),
        Err(e) => e,
    };
    assert!(matches!(
        err,
        rom_weaver_core::RomWeaverError::Validation(_)
    ));
}

#[test]
fn parse_directory_skips_self_and_parent_records() {
    let bias = 0;
    let cooked = build_iso(bias, &sample_files(), None);
    // Root directory sits at sector 18.
    let root = &cooked[18 * SECTOR..19 * SECTOR];
    let records = parse_directory(root).unwrap();
    assert_eq!(records.len(), 3, "three files, no . or .. entries");
    assert!(records.iter().all(|r| !r.is_self_or_parent()));
}

#[test]
fn parse_pvd_reports_root_and_block_size() {
    let cooked = build_iso(7, &sample_files(), None);
    let pvd = parse_primary_volume_descriptor(&cooked[16 * SECTOR..17 * SECTOR]).unwrap();
    assert_eq!(pvd.logical_block_size, 2048);
    assert!(pvd.root.is_dir);
    assert_eq!(pvd.root.extent_lba, 18 + 7);
    let _ = iso9660::FIRST_VOLUME_DESCRIPTOR_SECTOR;
}
