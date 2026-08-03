//! Unit coverage for the vendored xdvdfs write/read path
//! (`src/xdvdfs/{layout.rs,read.rs,write/dirtab.rs,write/img.rs}`), which
//! previously had zero direct coverage (only `util.rs` and `write/avl.rs`
//! had tests).
//!
//! Round-trips a small synthetic directory tree through
//! `write::img::create_xdvdfs_image` and back through
//! `write::fs::XDVDFSFilesystem` (the same pair the xiso container handler
//! uses to repack an image), plus direct unit coverage of the pure
//! `layout.rs` structures and `write::dirtab` table building.

use std::{
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use blockdev::OffsetWrapper;
use write::dirtab::DirectoryEntryTableWriter;
use write::fs::{Filesystem, PathVec, StdFilesystem, XDVDFSFilesystem};
use write::img::create_xdvdfs_image;

use super::*;

/// The generic `Filesystem<RawHandle, E>` trait only needs `RawHandle` to
/// pick a `BlockDeviceWrite` impl to write back through, which these
/// read-only round-trip tests never do; `std::fs::File` is used purely to
/// pin the otherwise-ambiguous type parameter.
type ImageFilesystem =
    XDVDFSFilesystem<std::io::Error, OffsetWrapper<BufReader<File>, std::io::Error>>;

fn read_dir(image_fs: &mut ImageFilesystem, dir: &PathVec) -> Vec<write::fs::FileEntry> {
    <ImageFilesystem as Filesystem<File, std::io::Error>>::read_dir(image_fs, dir).unwrap()
}

fn copy_file_buf(image_fs: &mut ImageFilesystem, path: &PathVec, buf: &mut [u8]) -> u64 {
    <ImageFilesystem as Filesystem<File, std::io::Error>>::copy_file_buf(image_fs, path, buf, 0)
        .unwrap()
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-xdvdfs-test-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Builds a small source directory tree:
/// ```text
/// root/
///   top.txt        (11 bytes)
///   sub/
///     nested.bin   (4096 bytes)
/// ```
fn build_source_tree(root: &Path) {
    fs::write(root.join("top.txt"), b"hello world").unwrap();
    let sub = root.join("sub");
    fs::create_dir_all(&sub).unwrap();
    let nested_payload: Vec<u8> = (0..4096_u32).map(|value| (value % 256) as u8).collect();
    fs::write(sub.join("nested.bin"), &nested_payload).unwrap();
}

/// Packs `source_root` into a fresh XDVDFS image file and returns its path.
fn pack_image(temp: &TempDir, source_root: &Path) -> PathBuf {
    let image_path = temp.path().join("image.iso");
    let mut image_file = File::create(&image_path).unwrap();
    let mut fs = StdFilesystem::create(source_root);
    create_xdvdfs_image(&mut fs, &mut image_file, |_progress| {}).expect("packing should succeed");
    image_path
}

fn open_image_filesystem(image_path: &Path) -> Option<ImageFilesystem> {
    let file = File::open(image_path).unwrap();
    let device = OffsetWrapper::new(BufReader::new(file)).ok()?;
    XDVDFSFilesystem::new(device)
}

// --- Round trip: write a directory tree, then read it back -----------------

#[test]
fn write_then_read_round_trips_directory_listing_and_file_sizes() {
    let temp = TempDir::new("round-trip");
    let source_root = temp.path().join("source");
    fs::create_dir_all(&source_root).unwrap();
    build_source_tree(&source_root);

    let image_path = pack_image(&temp, &source_root);
    let mut image_fs =
        open_image_filesystem(&image_path).expect("freshly packed image should be readable");

    let root_listing = read_dir(&mut image_fs, &PathVec::default());
    let mut names: Vec<_> = root_listing
        .iter()
        .map(|entry| entry.name.clone())
        .collect();
    names.sort();
    assert_eq!(names, vec!["sub", "top.txt"]);

    let top_entry = root_listing
        .iter()
        .find(|entry| entry.name == "top.txt")
        .unwrap();
    assert!(matches!(top_entry.file_type, write::fs::FileType::File));
    assert_eq!(top_entry.len, 11);

    let sub_entry = root_listing
        .iter()
        .find(|entry| entry.name == "sub")
        .unwrap();
    assert!(matches!(
        sub_entry.file_type,
        write::fs::FileType::Directory
    ));

    let sub_path = PathVec::from_base(&PathVec::default(), "sub");
    let sub_listing = read_dir(&mut image_fs, &sub_path);
    assert_eq!(sub_listing.len(), 1);
    assert_eq!(sub_listing[0].name, "nested.bin");
    assert_eq!(sub_listing[0].len, 4096);
}

#[test]
fn write_then_read_round_trips_file_bytes() {
    let temp = TempDir::new("round-trip-bytes");
    let source_root = temp.path().join("source");
    fs::create_dir_all(&source_root).unwrap();
    build_source_tree(&source_root);

    let image_path = pack_image(&temp, &source_root);
    let mut image_fs =
        open_image_filesystem(&image_path).expect("freshly packed image should be readable");

    let root_listing = read_dir(&mut image_fs, &PathVec::default());
    let top_entry = root_listing
        .iter()
        .find(|entry| entry.name == "top.txt")
        .unwrap();

    let mut buf = vec![0_u8; top_entry.len as usize];
    let path = PathVec::from_base(&PathVec::default(), "top.txt");
    let read = copy_file_buf(&mut image_fs, &path, &mut buf);
    assert_eq!(read as usize, buf.len());
    assert_eq!(&buf, b"hello world");
}

// --- Corrupt-image error case -----------------------------------------------

#[test]
fn opening_a_corrupted_image_fails_cleanly_rather_than_panicking() {
    let temp = TempDir::new("corrupt");
    let source_root = temp.path().join("source");
    fs::create_dir_all(&source_root).unwrap();
    build_source_tree(&source_root);

    let image_path = pack_image(&temp, &source_root);

    // The volume descriptor lives at sector 32 (offset 32 * SECTOR_SIZE) and
    // must start with the `VOLUME_HEADER_MAGIC` bytes. Corrupting that
    // header must make the image unreadable, not panic.
    let mut bytes = fs::read(&image_path).unwrap();
    let volume_offset = 32 * layout::SECTOR_SIZE as usize;
    bytes[volume_offset..volume_offset + 8].fill(0xFF);
    fs::write(&image_path, &bytes).unwrap();

    assert!(open_image_filesystem(&image_path).is_none());
}

#[test]
fn opening_a_truncated_image_fails_cleanly_rather_than_panicking() {
    let temp = TempDir::new("truncated");
    let source_root = temp.path().join("source");
    fs::create_dir_all(&source_root).unwrap();
    build_source_tree(&source_root);

    let image_path = pack_image(&temp, &source_root);

    // Cut the image off entirely before the volume descriptor sector.
    let bytes = fs::read(&image_path).unwrap();
    let truncated_len = (16 * layout::SECTOR_SIZE as usize).min(bytes.len());
    fs::write(&image_path, &bytes[..truncated_len]).unwrap();

    assert!(open_image_filesystem(&image_path).is_none());
}

// --- Pure layout.rs structures ----------------------------------------------

#[test]
fn directory_entry_table_offset_math() {
    let table = layout::DirectoryEntryTable::new(4096, 40);
    let offset = table.offset::<std::io::Error>(100).unwrap();
    assert_eq!(offset, 40 * layout::SECTOR_SIZE as u64 + 100);

    // An offset at or beyond the declared size is out of bounds.
    assert!(table.offset::<std::io::Error>(4096).is_err());
}

#[test]
fn volume_descriptor_round_trips_through_serialize_and_deserialize() {
    let root_table = layout::DirectoryEntryTable::new(2048, 33);
    let volume = layout::VolumeDescriptor::new(root_table);
    assert!(volume.is_valid());

    let serialized = volume.serialize::<std::io::Error>().unwrap();
    assert_eq!(serialized.len(), layout::SECTOR_SIZE as usize);

    let mut buf = [0_u8; 0x800];
    buf.copy_from_slice(&serialized);
    let deserialized = layout::VolumeDescriptor::deserialize::<std::io::Error>(&buf).unwrap();
    assert!(deserialized.is_valid());
    // `DiskRegion` is `#[repr(packed)]`; copy each field into a local before
    // comparing to avoid an unaligned-reference error.
    let region = deserialized.root_table.region;
    let sector = region.sector;
    let size = region.size;
    assert_eq!(sector, 33);
    assert_eq!(size, 2048);
}

#[test]
fn volume_descriptor_deserialize_rejects_garbage_bytes() {
    // A buffer of the right length but the wrong magic still deserializes
    // structurally (bincode has no magic-check of its own), but `is_valid`
    // must report it as not a real volume descriptor.
    let buf = [0x41_u8; 0x800];
    let volume = layout::VolumeDescriptor::deserialize::<std::io::Error>(&buf).unwrap();
    assert!(!volume.is_valid());
}

// --- write::dirtab table building -------------------------------------------

#[test]
fn directory_entry_table_writer_rejects_names_that_are_too_long() {
    let mut writer = DirectoryEntryTableWriter::default();
    let long_name = "a".repeat(300);
    let err = writer
        .add_file::<std::io::Error>(&long_name, 10)
        .unwrap_err();
    assert!(matches!(err, util::Error::NameTooLong));
}

#[test]
fn directory_entry_table_writer_rejects_duplicate_names() {
    let mut writer = DirectoryEntryTableWriter::default();
    writer.add_file::<std::io::Error>("dup.bin", 10).unwrap();
    let err = writer
        .add_file::<std::io::Error>("dup.bin", 20)
        .unwrap_err();
    assert!(matches!(err, util::Error::InvalidFileName));
}

#[test]
fn directory_entry_table_writer_computes_a_nonzero_size_for_entries() {
    let mut writer = DirectoryEntryTableWriter::default();
    writer.add_file::<std::io::Error>("a.bin", 100).unwrap();
    writer.add_file::<std::io::Error>("b.bin", 200).unwrap();
    writer.compute_size::<std::io::Error>().unwrap();
    assert!(writer.dirtab_size() > 0);
}
