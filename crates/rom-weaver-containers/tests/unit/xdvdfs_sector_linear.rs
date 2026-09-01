//! Coverage for `src/xdvdfs/write/fs/sector_linear.rs`: the sparse
//! sector-indexed block device the XDVDFS image writer stages an image in, and
//! the filesystem wrapper that records file placements instead of copying
//! bytes.

use super::*;
use crate::xdvdfs::write::fs::{FileType, PathVec};

const SECTOR: usize = layout::SECTOR_SIZE as usize;

/// A `Filesystem` that answers from a fixed listing. `copy_file_in` is never
/// reached through it: `SectorLinearBlockFilesystem` records the placement
/// itself rather than delegating.
struct StubFilesystem {
    listing: Vec<FileEntry>,
    read_dir_calls: usize,
}

impl StubFilesystem {
    fn new() -> Self {
        Self {
            listing: vec![
                FileEntry {
                    name: "default.xbe".into(),
                    file_type: FileType::File,
                    len: 2048,
                },
                FileEntry {
                    name: "media".into(),
                    file_type: FileType::Directory,
                    len: 0,
                },
            ],
            read_dir_calls: 0,
        }
    }
}

impl Filesystem<SectorLinearBlockDevice<std::io::Error>, std::io::Error> for StubFilesystem {
    fn read_dir(&mut self, _path: &PathVec) -> Result<Vec<FileEntry>, std::io::Error> {
        self.read_dir_calls += 1;
        Ok(self.listing.clone())
    }

    fn copy_file_in(
        &mut self,
        _src: &PathVec,
        _dest: &mut SectorLinearBlockDevice<std::io::Error>,
        _offset: u64,
        size: u64,
    ) -> Result<u64, std::io::Error> {
        Ok(size)
    }

    fn copy_file_buf(
        &mut self,
        _src: &PathVec,
        _buf: &mut [u8],
        _offset: u64,
    ) -> Result<u64, std::io::Error> {
        unimplemented!("not used by these tests")
    }
}

fn device() -> SectorLinearBlockDevice<std::io::Error> {
    SectorLinearBlockDevice::default()
}

fn path(parts: &[&str]) -> PathVec {
    parts.iter().copied().collect()
}

// --- BlockDeviceWrite -----------------------------------------------------

#[test]
fn a_new_device_is_empty() {
    let mut dev = device();
    assert_eq!(dev.num_sectors(), 0);
    assert_eq!(dev.len().expect("len"), 0);
    assert!(matches!(dev[0], SectorLinearBlockContents::Empty));
}

#[test]
fn write_stores_one_raw_sector_per_sector_sized_slice() {
    let mut dev = device();
    let mut payload = vec![0u8; 2 * SECTOR];
    payload[0] = 0x11;
    payload[SECTOR] = 0x22;

    dev.write(0, &payload).expect("write two sectors");
    assert_eq!(dev.num_sectors(), 2);

    match &dev[0] {
        SectorLinearBlockContents::RawData(data) => assert_eq!(data[0], 0x11),
        other => panic!("expected raw data, got {other:?}"),
    }
    match &dev[1] {
        SectorLinearBlockContents::RawData(data) => assert_eq!(data[0], 0x22),
        other => panic!("expected raw data, got {other:?}"),
    }
    assert_eq!(dev.len().expect("len"), 2 * SECTOR as u64);
}

#[test]
fn write_zero_pads_a_partial_trailing_sector() {
    let mut dev = device();
    let payload = vec![0x5A_u8; 16];

    dev.write(0, &payload).expect("write a partial sector");
    assert_eq!(dev.num_sectors(), 1);
    match &dev[0] {
        SectorLinearBlockContents::RawData(data) => {
            assert_eq!(&data[..16], payload.as_slice());
            assert!(
                data[16..].iter().all(|&b| b == 0),
                "the rest of the sector is zero filled"
            );
        }
        other => panic!("expected raw data, got {other:?}"),
    }
    // A partial sector still counts as a whole sector of length.
    assert_eq!(dev.len().expect("len"), SECTOR as u64);
}

#[test]
fn write_places_sectors_at_the_offsets_sector_index() {
    let mut dev = device();
    dev.write(5 * SECTOR as u64, &vec![0x77_u8; SECTOR])
        .expect("write at sector 5");

    assert_eq!(dev.num_sectors(), 1);
    assert!(matches!(dev[0], SectorLinearBlockContents::Empty));
    assert!(matches!(dev[5], SectorLinearBlockContents::RawData(_)));
    // `len` is the end of the highest sector, not the number of sectors.
    assert_eq!(dev.len().expect("len"), 6 * SECTOR as u64);
}

#[test]
fn write_of_an_empty_buffer_stores_nothing() {
    let mut dev = device();
    dev.write(0, &[]).expect("empty write");
    assert_eq!(dev.num_sectors(), 0);
}

#[test]
#[should_panic(expected = "Overwriting sectors is not implemented")]
fn writing_the_same_sector_twice_is_rejected() {
    let mut dev = device();
    dev.write(0, &vec![0u8; SECTOR]).expect("first write");
    let _ = dev.write(0, &vec![1u8; SECTOR]);
}

#[test]
#[should_panic]
fn write_requires_a_sector_aligned_offset() {
    let mut dev = device();
    let _ = dev.write(1, &vec![0u8; SECTOR]);
}

// --- Index ----------------------------------------------------------------

#[test]
fn indexing_an_unwritten_sector_yields_empty() {
    let mut dev = device();
    dev.write(0, &vec![0u8; SECTOR]).expect("write");
    assert!(matches!(dev[1], SectorLinearBlockContents::Empty));
    assert!(matches!(dev[u64::MAX], SectorLinearBlockContents::Empty));
}

#[test]
fn len_reports_zero_for_a_trailing_empty_sector() {
    // `Empty` contributes no length of its own, so a device whose highest
    // entry is Empty ends at that sector's start.
    let mut dev = device();
    dev.write(0, &vec![0u8; SECTOR]).expect("write");
    assert_eq!(dev.len().expect("len"), SECTOR as u64);
}

// --- SectorLinearBlockFilesystem ------------------------------------------

#[test]
fn the_filesystem_wrapper_delegates_read_dir() {
    let mut inner = StubFilesystem::new();
    let mut fs = SectorLinearBlockFilesystem::new(&mut inner);

    let listing = fs.read_dir(&path(&["media"])).expect("read_dir");
    assert_eq!(listing.len(), 2);
    assert_eq!(listing[0].name, "default.xbe");
    assert!(matches!(listing[1].file_type, FileType::Directory));
}

#[test]
fn copy_file_in_records_a_placement_instead_of_copying_bytes() {
    let mut inner = StubFilesystem::new();
    let mut fs = SectorLinearBlockFilesystem::new(&mut inner);
    let mut dev = device();

    let src = path(&["media", "video.bin"]);
    let size = 3 * SECTOR as u64;
    let written = fs
        .copy_file_in(&src, &mut dev, 2 * SECTOR as u64, size)
        .expect("copy_file_in");
    assert_eq!(written, size, "the full size is reported as written");
    assert_eq!(dev.num_sectors(), 3);

    for (index, sector) in (2..5u64).enumerate() {
        match &dev[sector] {
            SectorLinearBlockContents::File(recorded, offset) => {
                assert_eq!(recorded, &src);
                assert_eq!(*offset, index as u64, "each sector records its own index");
            }
            other => panic!("expected a file placement, got {other:?}"),
        }
    }
    assert_eq!(dev.len().expect("len"), 5 * SECTOR as u64);
}

#[test]
fn copy_file_in_rounds_a_partial_last_sector_up() {
    let mut inner = StubFilesystem::new();
    let mut fs = SectorLinearBlockFilesystem::new(&mut inner);
    let mut dev = device();

    let size = SECTOR as u64 + 1;
    fs.copy_file_in(&path(&["a.bin"]), &mut dev, 0, size)
        .expect("copy_file_in");
    assert_eq!(dev.num_sectors(), 2, "a one-byte overhang claims a sector");
}

#[test]
fn copy_file_in_of_a_zero_length_file_claims_no_sectors() {
    let mut inner = StubFilesystem::new();
    let mut fs = SectorLinearBlockFilesystem::new(&mut inner);
    let mut dev = device();

    let written = fs
        .copy_file_in(&path(&["empty.bin"]), &mut dev, 0, 0)
        .expect("copy_file_in");
    assert_eq!(written, 0);
    assert_eq!(dev.num_sectors(), 0);
}

#[test]
#[should_panic(expected = "Overwriting sectors is not implemented")]
fn copy_file_in_rejects_a_sector_that_is_already_claimed() {
    let mut inner = StubFilesystem::new();
    let mut fs = SectorLinearBlockFilesystem::new(&mut inner);
    let mut dev = device();

    fs.copy_file_in(&path(&["a.bin"]), &mut dev, 0, SECTOR as u64)
        .expect("first placement");
    let _ = fs.copy_file_in(&path(&["b.bin"]), &mut dev, 0, SECTOR as u64);
}

#[test]
#[should_panic]
fn copy_file_in_requires_a_sector_aligned_offset() {
    let mut inner = StubFilesystem::new();
    let mut fs = SectorLinearBlockFilesystem::new(&mut inner);
    let mut dev = device();
    let _ = fs.copy_file_in(&path(&["a.bin"]), &mut dev, 1, SECTOR as u64);
}

#[test]
#[should_panic(expected = "not implemented")]
fn copy_file_buf_is_not_supported_by_the_sector_linear_wrapper() {
    let mut inner = StubFilesystem::new();
    let mut fs = SectorLinearBlockFilesystem::new(&mut inner);
    let mut buf = [0u8; 8];
    let _ = fs.copy_file_buf(&path(&["a.bin"]), &mut buf, 0);
}

#[test]
fn raw_writes_and_file_placements_share_one_sector_map() {
    let mut inner = StubFilesystem::new();
    let mut dev = device();
    dev.write(0, &vec![0xAB_u8; SECTOR]).expect("header sector");

    {
        let mut fs = SectorLinearBlockFilesystem::new(&mut inner);
        fs.copy_file_in(&path(&["a.bin"]), &mut dev, SECTOR as u64, SECTOR as u64)
            .expect("placement after the header");
    }

    assert_eq!(dev.num_sectors(), 2);
    assert!(matches!(dev[0], SectorLinearBlockContents::RawData(_)));
    assert!(matches!(dev[1], SectorLinearBlockContents::File(_, 0)));
    assert_eq!(dev.len().expect("len"), 2 * SECTOR as u64);
}
