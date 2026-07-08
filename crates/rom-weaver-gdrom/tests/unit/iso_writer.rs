//! Round-trip tests for the ISO9660 writer: author an image, read it back with
//! [`GdRomFs`], and confirm the file tree and bytes survive — including through
//! raw `MODE1/2352` re-encoding (the real rebuilt-track path).

use std::io::Cursor;

use super::gdrom::{GD_HIGH_DENSITY_START_LBA, GdRomFs};
use super::iso_writer::{IsoFile, IsoTimestamp, build_iso};
use super::mode1::encode_mode1_sector;
use super::sector::{LOGICAL_SECTOR_SIZE, SectorFormat};

const SECTOR: usize = LOGICAL_SECTOR_SIZE;

fn file(path: &str, data: Vec<u8>) -> IsoFile {
    IsoFile {
        path: path.to_string(),
        data,
    }
}

fn sample_files() -> Vec<IsoFile> {
    vec![
        file("COSCAP.BIN", vec![0xAB; 100]),
        file("MAKUMA.AFS", vec![0xCD; SECTOR * 3 + 17]), // spans 4 sectors
        file("README.TXT", b"hello gd-rom rebuild".to_vec()),
    ]
}

fn assert_round_trips(files: &[IsoFile], bias: u32, image: Vec<u8>) {
    let mut fs = GdRomFs::open(Cursor::new(image), bias).expect("open authored image");
    for f in files {
        let entry = fs
            .file(&f.path)
            .unwrap_or_else(|| panic!("authored file `{}` missing after read-back", f.path))
            .clone();
        assert!(entry.extent_lba >= bias, "extent LBA must be biased");
        assert_eq!(
            fs.read_file(&entry).unwrap(),
            f.data,
            "bytes for `{}`",
            f.path
        );
    }
    assert_eq!(fs.files().len(), files.len());
}

#[test]
fn build_iso_round_trips_through_reader_with_bias() {
    let files = sample_files();
    let bias = GD_HIGH_DENSITY_START_LBA;
    let image = build_iso(&files, bias, IsoTimestamp::default()).expect("build");
    assert_round_trips(&files, bias, image);
}

#[test]
fn build_iso_round_trips_with_zero_bias() {
    let files = sample_files();
    let image = build_iso(&files, 0, IsoTimestamp::default()).expect("build");
    assert_round_trips(&files, 0, image);
}

#[test]
fn build_iso_round_trips_nested_directories() {
    let files = vec![
        file("ROOT.BIN", vec![1; 50]),
        file("DATA/R01.MLT", vec![2; SECTOR + 9]),
        file("DATA/R02.MLT", vec![3; 200]),
        file("DATA/SUB/DEEP.DAT", vec![4; 4096]),
    ];
    let bias = GD_HIGH_DENSITY_START_LBA;
    let image = build_iso(&files, bias, IsoTimestamp::default()).expect("build");

    let mut fs = GdRomFs::open(Cursor::new(image), bias).expect("open");
    let mut names: Vec<_> = fs.files().keys().cloned().collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "DATA/R01.MLT",
            "DATA/R02.MLT",
            "DATA/SUB/DEEP.DAT",
            "ROOT.BIN"
        ]
    );
    for f in &files {
        let entry = fs.file(&f.path).expect("nested file").clone();
        assert_eq!(fs.read_file(&entry).unwrap(), f.data);
    }
}

#[test]
fn build_iso_then_mode1_encode_round_trips_as_raw_track() {
    // Author a cooked image, re-encode every sector to raw MODE1/2352 (as a
    // rebuilt GD-ROM data track), then read the raw track straight back.
    let files = sample_files();
    let bias = GD_HIGH_DENSITY_START_LBA;
    let cooked = build_iso(&files, bias, IsoTimestamp::default()).expect("build");
    assert_eq!(cooked.len() % SECTOR, 0);

    let mut raw = Vec::with_capacity(cooked.len() / SECTOR * 2352);
    for (i, chunk) in cooked.chunks(SECTOR).enumerate() {
        let mut sector = [0u8; SECTOR];
        sector.copy_from_slice(chunk);
        let lba = bias + i as u32;
        raw.extend_from_slice(&encode_mode1_sector(lba, &sector));
    }

    let mut fs = GdRomFs::open(Cursor::new(raw), bias).expect("open raw rebuilt track");
    assert_eq!(fs.sector_format(), SectorFormat::MODE1_2352);
    for f in &files {
        let entry = fs.file(&f.path).expect("file in raw track").clone();
        assert_eq!(fs.read_file(&entry).unwrap(), f.data);
    }
}

#[test]
fn authored_directory_data_len_is_block_aligned() {
    // ECMA-119 requires a directory's recorded Data Length to be a whole number
    // of logical blocks; a strict reader does `data_len / 2048` to count
    // sectors, so a sub-2048 length would read zero entries.
    let files = vec![
        file("ROOT.BIN", vec![1; 50]),
        file("DATA/R01.MLT", vec![2; SECTOR + 9]),
        file("DATA/SUB/DEEP.DAT", vec![4; 4096]),
    ];
    let bias = GD_HIGH_DENSITY_START_LBA;
    let image = build_iso(&files, bias, IsoTimestamp::default()).expect("build");
    let fs = GdRomFs::open(Cursor::new(image.clone()), bias).expect("open");

    let root = fs.primary_volume_descriptor().root.clone();
    assert_eq!(
        root.data_len % SECTOR as u32,
        0,
        "root directory data_len {} is not a 2048 multiple",
        root.data_len
    );

    // Walk every directory record reachable from the root and confirm each
    // subdirectory's recorded Data Length is a whole-block multiple too.
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let sector = (dir.extent_lba - bias) as usize;
        let extent = &image[sector * SECTOR..sector * SECTOR + dir.data_len as usize];
        for child in super::iso9660::parse_directory(extent).expect("parse dir") {
            if child.is_dir {
                assert_eq!(
                    child.data_len % SECTOR as u32,
                    0,
                    "directory `{}` data_len {} is not a 2048 multiple",
                    child.name,
                    child.data_len
                );
                stack.push(child);
            }
        }
    }
}

#[test]
fn directory_records_merge_files_and_dirs_in_identifier_order() {
    // ECMA-119 9.3: files and subdirectories share one record list sorted by
    // identifier. With a file whose identifier sorts between two directories,
    // the on-disc order must interleave them (AAA, MID.BIN;1, ZZZ), not emit all
    // files before all dirs.
    let files = vec![
        file("MID.BIN", vec![1; 10]),
        file("AAA/A.DAT", vec![2; 10]),
        file("ZZZ/Z.DAT", vec![3; 10]),
    ];
    let bias = GD_HIGH_DENSITY_START_LBA;
    let image = build_iso(&files, bias, IsoTimestamp::default()).expect("build");
    let fs = GdRomFs::open(Cursor::new(image.clone()), bias).expect("open");

    let root = fs.primary_volume_descriptor().root.clone();
    let sector = (root.extent_lba - bias) as usize;
    let extent = &image[sector * SECTOR..sector * SECTOR + root.data_len as usize];
    let names: Vec<String> = super::iso9660::parse_directory(extent)
        .expect("parse root")
        .into_iter()
        .filter(|r| !r.name.is_empty()) // drop . and ..
        .map(|r| r.name)
        .collect();
    assert_eq!(names, vec!["AAA", "MID.BIN", "ZZZ"]);
}

#[test]
fn empty_file_is_authored_and_read_back() {
    let files = vec![file("EMPTY.DAT", Vec::new()), file("REAL.BIN", vec![9; 10])];
    let image = build_iso(&files, 0, IsoTimestamp::default()).expect("build");
    let mut fs = GdRomFs::open(Cursor::new(image), 0).expect("open");
    let empty = fs.file("EMPTY.DAT").expect("empty file").clone();
    assert_eq!(empty.size, 0);
    assert_eq!(fs.read_file(&empty).unwrap(), Vec::<u8>::new());
}
