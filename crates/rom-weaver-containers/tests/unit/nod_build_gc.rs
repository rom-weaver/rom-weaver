//! Unit coverage for the GameCube partition builder (`src/nod/build/gc.rs`):
//! system-file location, header overrides, disc layout, junk-data insertion,
//! and the two output paths (`write_to` and `GCPartitionStream`).

use std::collections::HashMap;

use zerocopy::{FromBytes, big_endian::U32};

use super::*;
use crate::nod::disc::{ApploaderHeader, DolHeader};

const APPLOADER_PAYLOAD: usize = 0x100;
const DOL_PAYLOAD: usize = 0x20;
const APPLOADER_SIZE: u64 = (size_of::<ApploaderHeader>() + APPLOADER_PAYLOAD) as u64;
const DOL_SIZE: u64 = (size_of::<DolHeader>() + DOL_PAYLOAD) as u64;

/// Offsets the layout is expected to pick for the minimal GameCube fixture.
/// Derived by hand from `layout_system_data`: boot, BI2 and apploader are
/// packed, then the DOL is aligned to 128 and the FST follows it, also
/// aligned to 128.
const EXPECTED_DOL_OFFSET: u64 = 0x2580;
const EXPECTED_FST_OFFSET: u64 = 0x2700;
const USER_OFFSET: u64 = 0x8000;
const USER_SIZE: u64 = 0x40000;
const OUTER_OFFSET: u64 = 0x40000;
/// 5 nodes (root, `files`, three files) plus a 43-byte string table.
const EXPECTED_FST_SIZE: u64 = 103;

fn apploader_bytes() -> Vec<u8> {
    let mut header = ApploaderHeader::new_box_zeroed().expect("allocate apploader header");
    header.date[..8].copy_from_slice(b"20010101");
    header.entry_point = U32::new(0x8130_0000);
    header.size = U32::new(APPLOADER_PAYLOAD as u32);
    header.trailer_size = U32::new(0);
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend((0..APPLOADER_PAYLOAD).map(|i| (i % 251) as u8));
    bytes
}

fn dol_bytes() -> Vec<u8> {
    let mut header = DolHeader::new_box_zeroed().expect("allocate DOL header");
    // `read_dol` sizes the DOL from the highest section end, so at least one
    // section MUST be non-empty for the payload to be read back.
    header.text_offs[0] = U32::new(size_of::<DolHeader>() as u32);
    header.text_addrs[0] = U32::new(0x8000_3100);
    header.text_sizes[0] = U32::new(DOL_PAYLOAD as u32);
    header.entry_point = U32::new(0x8000_3154);
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend((0..DOL_PAYLOAD).map(|i| 0x80 ^ (i as u8)));
    bytes
}

fn payload(len: usize, seed: u8) -> Arc<[u8]> {
    Arc::from(
        (0..len)
            .map(|i| seed.wrapping_add((i * 7) as u8))
            .collect::<Vec<u8>>(),
    )
}

/// Files that back both `build` and `write_to` callbacks.
#[derive(Clone, Default)]
pub(super) struct FileMap(HashMap<String, Arc<[u8]>>);

impl FileMap {
    fn insert(&mut self, name: &str, data: Arc<[u8]>) {
        self.0.insert(name.to_string(), data);
    }

    fn get(&self, name: &str) -> io::Result<&Arc<[u8]>> {
        self.0
            .get(name)
            .ok_or_else(|| io::Error::other(format!("unknown file {name}")))
    }

    fn write_callback(&self) -> impl FnMut(&mut dyn Write, &str) -> io::Result<()> + '_ {
        move |out, name| out.write_all(self.get(name)?)
    }
}

impl FileCallback for FileMap {
    fn read_file(&mut self, out: &mut [u8], name: &str, offset: u64) -> io::Result<()> {
        let data = self.get(name)?;
        let start = offset as usize;
        let end = start + out.len();
        if end > data.len() {
            return Err(io::Error::other(format!("read past end of {name}")));
        }
        out.copy_from_slice(&data[start..end]);
        Ok(())
    }
}

fn base_overrides() -> PartitionOverrides {
    PartitionOverrides {
        game_id: Some(*b"RWTEST"),
        game_title: Some("rom weaver builder test".to_string()),
        disc_num: Some(0),
        disc_version: Some(1),
        audio_streaming: Some(true),
        audio_stream_buf_size: Some(0x0A),
        junk_id: None,
        region: Some(2),
    }
}

/// A GameCube disc with two packed user files and one placed on the outer rim,
/// which forces both junk-alignment branches in `insert_junk_data`.
fn minimal_disc() -> (GCPartitionBuilder, FileMap) {
    let mut files = FileMap::default();
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));
    files.insert("files/hello.txt", payload(16, 1));
    files.insert("files/world.bin", payload(32, 64));
    files.insert("files/outer.bin", payload(48, 128));

    let mut builder = GCPartitionBuilder::new(false, base_overrides());
    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    // Pinning the user region keeps the fixture small; an unset user size makes
    // the builder pad a GameCube disc out to MINI_DVD_SIZE.
    boot_header.user_offset = U32::new(USER_OFFSET as u32);
    boot_header.user_size = U32::new(USER_SIZE as u32);
    builder.set_boot_header(boot_header);

    for (name, size, offset, alignment) in [
        ("sys/apploader.img", APPLOADER_SIZE, None, None),
        ("sys/main.dol", DOL_SIZE, None, None),
        ("files/hello.txt", 16, None, None),
        ("files/world.bin", 32, None, None),
        ("files/outer.bin", 48, Some(OUTER_OFFSET), Some(0x8000)),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset,
                alignment,
            })
            .expect("add file");
    }
    (builder, files)
}

/// `GCPartitionWriter` is not `Debug`, so a failed build cannot go through
/// `expect_err`.
fn build_err(result: Result<GCPartitionWriter>) -> Error {
    match result {
        Ok(_) => panic!("expected the build to fail"),
        Err(err) => err,
    }
}

fn layout_summary(writer: &GCPartitionWriter) -> Vec<(&str, u64, u64)> {
    writer
        .write_info
        .iter()
        .map(|info| (info.kind.name(), info.offset, info.size))
        .collect()
}

fn aligned_fst(data: &[u8]) -> Vec<u32> {
    let mut words = vec![0u32; data.len().div_ceil(4)];
    words.as_mut_bytes()[..data.len()].copy_from_slice(data);
    words
}

#[test]
fn write_kind_names_identify_the_source_of_each_span() {
    assert_eq!(
        WriteKind::File("files/a.bin".to_string()).name(),
        "files/a.bin"
    );
    assert_eq!(
        WriteKind::Static(Arc::from(&b"x"[..]), "[FST]").name(),
        "[FST]"
    );
    assert_eq!(WriteKind::Junk.name(), "[junk data]");
}

#[test]
fn add_file_rejects_an_offset_that_is_not_aligned() {
    let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    let err = builder
        .add_file(FileInfo {
            name: "files/bad.bin".to_string(),
            size: 4,
            offset: Some(0x1004),
            alignment: Some(0x800),
        })
        .expect_err("misaligned offset");
    assert!(
        matches!(&err, Error::Other(msg) if msg.contains("is not aligned to 2048")),
        "unexpected error: {err}"
    );
}

#[test]
fn build_lays_out_system_files_then_user_files_with_junk_between() {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");

    assert_eq!(writer.disc_size, USER_OFFSET + USER_SIZE);
    assert_eq!(writer.disc_id, *b"RWTE");
    assert_eq!(writer.disc_num, 0);
    assert_eq!(
        layout_summary(&writer),
        vec![
            ("[BOOT]", 0, BOOT_SIZE as u64),
            ("[BI2]", BOOT_SIZE as u64, BI2_SIZE as u64),
            (
                "sys/apploader.img",
                BOOT_SIZE as u64 + BI2_SIZE as u64,
                APPLOADER_SIZE
            ),
            ("sys/main.dol", EXPECTED_DOL_OFFSET, DOL_SIZE),
            ("[FST]", EXPECTED_FST_OFFSET, EXPECTED_FST_SIZE),
            ("[junk data]", 0x2784, USER_OFFSET - 0x2784),
            ("files/hello.txt", USER_OFFSET, 16),
            ("files/world.bin", 0x8020, 32),
            // The outer-rim gap gets 4-byte alignment instead of the usual
            // 28-byte pad, which is what `find_file_gap` exists to detect.
            ("[junk data]", 0x8040, OUTER_OFFSET - 0x8040),
            ("files/outer.bin", OUTER_OFFSET, 48),
            ("[junk data]", 0x4004C, USER_OFFSET + USER_SIZE - 0x4004C),
        ]
    );
}

/// Writes the fixture disc and returns the whole image.
fn written_image() -> Vec<u8> {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut out = Vec::new();
    writer
        .write_to(&mut out, files.write_callback())
        .expect("write disc");
    out
}

#[test]
fn write_to_emits_the_disc_header_overrides() {
    let out = written_image();

    assert_eq!(out.len() as u64, USER_OFFSET + USER_SIZE);
    assert_eq!(&out[..6], b"RWTEST");
    assert_eq!(&out[0x1C..0x20], &GCN_MAGIC);
    assert_eq!(&out[0x20..0x37], b"rom weaver builder test");
    assert_eq!(out[0x37], 0);
    assert_eq!(out[6], 0, "disc number override");
    assert_eq!(out[7], 1, "disc version override");
    assert_eq!(out[8], 1, "audio streaming override");
    assert_eq!(out[9], 0x0A, "audio stream buffer size override");
    // BI2 carries the region override at offset 0x18.
    assert_eq!(
        &out[BOOT_SIZE + 0x18..BOOT_SIZE + 0x1C],
        &2u32.to_be_bytes()
    );

    let boot_header =
        BootHeader::read_from_bytes(&out[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("boot header");
    assert_eq!(boot_header.dol_offset(false), EXPECTED_DOL_OFFSET);
    assert_eq!(boot_header.fst_offset(false), EXPECTED_FST_OFFSET);
    assert_eq!(boot_header.fst_size(false), EXPECTED_FST_SIZE);
    assert_eq!(boot_header.fst_max_size(false), EXPECTED_FST_SIZE);
    assert_eq!(boot_header.user_offset.get() as u64, USER_OFFSET);
}

#[test]
fn write_to_emits_file_payloads_and_a_parseable_fst() {
    let out = written_image();

    assert_eq!(
        &out[0x2440..0x2440 + APPLOADER_SIZE as usize],
        apploader_bytes().as_slice()
    );
    assert_eq!(
        &out[EXPECTED_DOL_OFFSET as usize..(EXPECTED_DOL_OFFSET + DOL_SIZE) as usize],
        dol_bytes().as_slice()
    );
    // The gap between the apploader and the aligned DOL is zero-filled padding.
    assert!(
        out[0x2560..EXPECTED_DOL_OFFSET as usize]
            .iter()
            .all(|b| *b == 0)
    );

    assert_eq!(
        &out[USER_OFFSET as usize..USER_OFFSET as usize + 16],
        payload(16, 1).as_ref()
    );
    assert_eq!(&out[0x8020..0x8040], payload(32, 64).as_ref());
    assert_eq!(
        &out[OUTER_OFFSET as usize..OUTER_OFFSET as usize + 48],
        payload(48, 128).as_ref()
    );

    let fst_end = (EXPECTED_FST_OFFSET + EXPECTED_FST_SIZE) as usize;
    let raw_fst = aligned_fst(&out[EXPECTED_FST_OFFSET as usize..fst_end]);
    let fst =
        Fst::new(&raw_fst.as_bytes()[..EXPECTED_FST_SIZE as usize]).expect("parse generated FST");
    assert_eq!(fst.num_files(), 3);
    let (_, node) = fst.find("files/outer.bin").expect("outer file in FST");
    assert_eq!(node.offset(false), OUTER_OFFSET);
    assert_eq!(node.length(), 48);
    let (_, node) = fst.find("files/hello.txt").expect("hello file in FST");
    assert_eq!(node.offset(false), USER_OFFSET);
}

#[test]
fn junk_regions_are_not_zero_and_repeat_per_sector() {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut out = Vec::new();
    writer
        .write_to(&mut out, files.write_callback())
        .expect("write disc");

    let junk = &out[0x2784..USER_OFFSET as usize];
    assert!(
        junk.iter().any(|b| *b != 0),
        "junk region must not be zeroed"
    );

    // Junk is seeded from the disc id, disc number and absolute offset, so a
    // window inside a junk span is reproducible on its own.
    let mut lfg = LaggedFibonacci::default();
    let mut expected = vec![0u8; 0x1000];
    lfg.fill_sector_chunked(&mut expected, *b"RWTE", 0, 0x41000);
    assert_eq!(&out[0x41000..0x42000], expected.as_slice());
}

#[test]
fn gc_partition_stream_reproduces_the_written_image() {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut expected = Vec::new();
    writer
        .write_to(&mut expected, files.write_callback())
        .expect("write disc");

    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut stream = writer.into_gc_stream(files.clone());
    assert_eq!(stream.len(), expected.len() as u64);

    let mut actual = vec![0u8; expected.len()];
    stream.read_exact(&mut actual).expect("read whole image");
    assert_eq!(actual, expected);

    // A short read that starts inside the apploader and crosses into the
    // zero padding, the DOL, and the FST.
    stream.set_position(0x2500);
    let mut chunk = vec![0u8; 0x300];
    stream.read_exact(&mut chunk).expect("read across spans");
    assert_eq!(chunk.as_slice(), &expected[0x2500..0x2800]);

    // Reads past the end of the image return nothing.
    stream.set_position(expected.len() as u64);
    assert_eq!(stream.read(&mut chunk).expect("read past end"), 0);
}

#[test]
fn gc_partition_stream_seeks_from_every_anchor() {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let size = writer.disc_size;
    let mut stream = writer.into_gc_stream(files);

    assert_eq!(
        stream.seek(io::SeekFrom::Start(0x100)).expect("seek"),
        0x100
    );
    assert_eq!(
        stream.seek(io::SeekFrom::Current(0x10)).expect("seek"),
        0x110
    );
    assert_eq!(stream.seek(io::SeekFrom::Current(-0x200)).expect("seek"), 0);
    assert_eq!(stream.seek(io::SeekFrom::End(0)).expect("seek"), size);
    assert_eq!(
        stream.seek(io::SeekFrom::End(-16)).expect("seek"),
        size - 16
    );
}

#[test]
fn cloneable_and_non_cloneable_streams_expose_the_same_image() {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut expected = Vec::new();
    writer
        .write_to(&mut expected, files.write_callback())
        .expect("write disc");

    let (builder, files) = minimal_disc();
    let mut cloneable = builder
        .build(files.write_callback())
        .expect("build disc")
        .into_cloneable_stream(files.clone())
        .expect("cloneable stream");
    assert_eq!(cloneable.stream_len().expect("len"), expected.len() as u64);
    let mut buf = [0u8; 0x40];
    cloneable
        .read_exact_at(&mut buf, USER_OFFSET)
        .expect("read at user offset");
    assert_eq!(
        buf.as_slice(),
        &expected[USER_OFFSET as usize..USER_OFFSET as usize + 0x40]
    );

    let (builder, files) = minimal_disc();
    let mut non_cloneable = builder
        .build(files.write_callback())
        .expect("build disc")
        .into_non_cloneable_stream(files)
        .expect("non-cloneable stream");
    assert_eq!(
        non_cloneable.stream_len().expect("len"),
        expected.len() as u64
    );
    non_cloneable
        .read_exact_at(&mut buf, EXPECTED_FST_OFFSET)
        .expect("read at FST offset");
    assert_eq!(
        buf.as_slice(),
        &expected[EXPECTED_FST_OFFSET as usize..EXPECTED_FST_OFFSET as usize + 0x40]
    );
}

#[test]
fn write_to_reports_a_callback_that_writes_the_wrong_length() {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut out = Vec::new();
    let err = writer
        .write_to(&mut out, |w, name| {
            if name == "files/hello.txt" {
                w.write_all(&[0u8; 4])
            } else {
                w.write_all(files.get(name)?)
            }
        })
        .expect_err("short file write");
    assert!(
        matches!(&err, Error::Other(msg)
            if msg.contains("files/hello.txt") && msg.contains("Wrote 4 bytes, expected 16")),
        "unexpected error: {err}"
    );
}

#[test]
fn write_to_propagates_a_callback_error() {
    let (builder, files) = minimal_disc();
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut out = Vec::new();
    let err = writer
        .write_to(&mut out, |_, name| {
            Err(io::Error::other(format!("no data for {name}")))
        })
        .expect_err("callback failure");
    assert!(
        format!("{err}").contains("sys/apploader.img"),
        "unexpected error: {err}"
    );
}

#[test]
fn a_wii_partition_pads_the_user_region_to_a_sector() {
    let mut files = FileMap::default();
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));
    // The file name is chosen so the FST byte size is a multiple of four; see
    // `a_wii_fst_whose_size_is_not_a_multiple_of_four_is_padded`.
    files.insert("files/banner.bin", payload(64, 5));

    let mut builder = GCPartitionBuilder::new(true, base_overrides());
    for (name, size) in [
        ("sys/apploader.img", APPLOADER_SIZE),
        ("sys/main.dol", DOL_SIZE),
        ("files/banner.bin", 64),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset: None,
                alignment: None,
            })
            .expect("add file");
    }

    let writer = builder.build(files.write_callback()).expect("build disc");
    // An unset user offset is aligned up to a sector, and a Wii user region
    // ends at a sector boundary rather than MINI_DVD_SIZE.
    assert_eq!(writer.disc_size, 0x10000);

    let mut out = Vec::new();
    writer
        .write_to(&mut out, files.write_callback())
        .expect("write disc");
    assert_eq!(out.len(), 0x10000);
    assert_eq!(&out[0x18..0x1C], &WII_MAGIC);
    assert_eq!(&out[0x1C..0x20], &[0u8; 4]);

    let boot_header =
        BootHeader::read_from_bytes(&out[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("boot header");
    let fst_offset = boot_header.fst_offset(true);
    let fst_size = boot_header.fst_size(true) as usize;
    // Wii boot header offsets are stored shifted right by two.
    assert_eq!(boot_header.fst_offset.get() as u64 * 4, fst_offset);

    let raw_fst = aligned_fst(&out[fst_offset as usize..fst_offset as usize + fst_size]);
    let fst = Fst::new(&raw_fst.as_bytes()[..fst_size]).expect("parse generated FST");
    let (_, node) = fst.find("files/banner.bin").expect("file in FST");
    assert_eq!(node.offset(true), SECTOR_SIZE as u64);
    assert_eq!(node.length(), 64);
}

#[test]
fn a_wii_fst_whose_size_is_not_a_multiple_of_four_is_padded() {
    let mut files = FileMap::default();
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));
    files.insert("files/data.bin", payload(64, 5));

    let mut builder = GCPartitionBuilder::new(true, base_overrides());
    for (name, size) in [
        ("sys/apploader.img", APPLOADER_SIZE),
        ("sys/main.dol", DOL_SIZE),
        ("files/data.bin", 64),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset: None,
                alignment: None,
            })
            .expect("add file");
    }

    // `BootHeader::set_fst_size` stores a Wii FST size divided by four, so an
    // unpadded 58-byte FST used to read back as 56 and fail the build with an
    // FST size mismatch. FstBuilder now rounds a Wii FST up to 60.
    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut out = Vec::new();
    writer
        .write_to(&mut out, files.write_callback())
        .expect("write disc");

    let boot_header =
        BootHeader::read_from_bytes(&out[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("boot header");
    let fst_size = boot_header.fst_size(true);
    assert_eq!(fst_size, 60);
    assert_eq!(fst_size % 4, 0);
}

#[test]
fn a_gamecube_disc_without_a_user_size_is_padded_to_a_mini_dvd() {
    let mut files = FileMap::default();
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));
    files.insert("files/data.bin", payload(64, 5));

    let mut builder = GCPartitionBuilder::new(false, base_overrides());
    for (name, size) in [
        ("sys/apploader.img", APPLOADER_SIZE),
        ("sys/main.dol", DOL_SIZE),
        ("files/data.bin", 64),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset: None,
                alignment: None,
            })
            .expect("add file");
    }

    let writer = builder.build(files.write_callback()).expect("build disc");
    assert_eq!(writer.disc_size, MINI_DVD_SIZE);
    let (last_kind, last_offset, last_size) =
        *layout_summary(&writer).last().expect("trailing junk span");
    assert_eq!(last_kind, "[junk data]");
    assert_eq!(last_offset + last_size, MINI_DVD_SIZE);
}

#[test]
fn system_files_can_be_supplied_as_boot_bi2_and_fst_images() {
    let mut boot = vec![0u8; BOOT_SIZE];
    boot[..6].copy_from_slice(b"SUPPLI");
    boot[0x1C..0x20].copy_from_slice(&GCN_MAGIC);
    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    boot_header.user_offset = U32::new(USER_OFFSET as u32);
    boot_header.user_size = U32::new(0x8000);
    boot[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()].copy_from_slice(boot_header.as_bytes());

    let mut bi2 = vec![0u8; BI2_SIZE];
    bi2[0] = 0x5A;

    let mut fst_builder = FstBuilder::new(false);
    fst_builder.add_file("files/hello.txt", USER_OFFSET, 16);
    fst_builder.add_file("files/junk.bin", USER_OFFSET + 0x20, 16);
    let raw_fst = fst_builder.finalize();

    let mut files = FileMap::default();
    files.insert("sys/boot.bin", Arc::from(boot.clone()));
    files.insert("sys/bi2.bin", Arc::from(bi2.clone()));
    files.insert("sys/fst.bin", Arc::from(raw_fst.as_ref()));
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));
    files.insert("files/hello.txt", payload(16, 9));

    let mut builder = GCPartitionBuilder::new(
        false,
        PartitionOverrides {
            junk_id: Some(*b"JUNK"),
            ..PartitionOverrides::default()
        },
    );
    // A junk file is listed in the FST but excluded from the layout, so the
    // original FST is still usable.
    builder.add_junk_file("files/junk.bin".to_string());
    for (name, size) in [
        ("sys/boot.bin", BOOT_SIZE as u64),
        ("sys/bi2.bin", BI2_SIZE as u64),
        ("sys/fst.bin", raw_fst.len() as u64),
        ("sys/apploader.img", APPLOADER_SIZE),
        ("sys/main.dol", DOL_SIZE),
        ("files/hello.txt", 16),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset: None,
                alignment: None,
            })
            .expect("add file");
    }

    let writer = builder.build(files.write_callback()).expect("build disc");
    assert_eq!(writer.disc_id, *b"JUNK", "junk id override");
    let mut out = Vec::new();
    writer
        .write_to(&mut out, files.write_callback())
        .expect("write disc");

    // The supplied boot and BI2 images replace the generated ones, and the
    // supplied FST is reused verbatim.
    assert_eq!(&out[..6], b"SUPPLI");
    assert_eq!(&out[BOOT_SIZE..BOOT_SIZE + BI2_SIZE], bi2.as_slice());
    let boot_header =
        BootHeader::read_from_bytes(&out[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("boot header");
    let fst_offset = boot_header.fst_offset(false) as usize;
    assert_eq!(boot_header.fst_size(false), raw_fst.len() as u64);
    assert_eq!(
        &out[fst_offset..fst_offset + raw_fst.len()],
        raw_fst.as_ref()
    );
}

#[test]
fn an_original_fst_is_regenerated_when_it_lists_an_unknown_file() {
    let mut fst_builder = FstBuilder::new(false);
    fst_builder.add_file("files/hello.txt", USER_OFFSET, 16);
    fst_builder.add_file("files/gone.bin", USER_OFFSET + 0x20, 16);
    let raw_fst = fst_builder.finalize();

    let mut files = FileMap::default();
    files.insert("sys/fst.bin", Arc::from(raw_fst.as_ref()));
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));
    files.insert("files/hello.txt", payload(16, 9));

    let mut builder = GCPartitionBuilder::new(false, base_overrides());
    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    boot_header.user_offset = U32::new(USER_OFFSET as u32);
    boot_header.user_size = U32::new(0x8000);
    builder.set_boot_header(boot_header);
    for (name, size) in [
        ("sys/fst.bin", raw_fst.len() as u64),
        ("sys/apploader.img", APPLOADER_SIZE),
        ("sys/main.dol", DOL_SIZE),
        ("files/hello.txt", 16),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset: None,
                alignment: None,
            })
            .expect("add file");
    }

    let writer = builder.build(files.write_callback()).expect("build disc");
    let mut out = Vec::new();
    writer
        .write_to(&mut out, files.write_callback())
        .expect("write disc");

    let boot_header =
        BootHeader::read_from_bytes(&out[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("boot header");
    let fst_offset = boot_header.fst_offset(false) as usize;
    let fst_size = boot_header.fst_size(false) as usize;
    let rebuilt = &out[fst_offset..fst_offset + fst_size];
    assert_ne!(rebuilt, raw_fst.as_ref());

    let aligned = aligned_fst(rebuilt);
    let fst = Fst::new(&aligned.as_bytes()[..fst_size]).expect("parse regenerated FST");
    assert_eq!(fst.num_files(), 1);
    assert!(fst.find("files/gone.bin").is_none());
    // The string table ordering is inherited from the original FST.
    assert!(
        fst.string_table
            .starts_with(b"<root>\0files\0hello.txt\0gone.bin\0")
    );
}

#[test]
fn build_rejects_a_boot_image_of_the_wrong_size() {
    let mut files = FileMap::default();
    files.insert("sys/boot.bin", payload(16, 3));
    let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    builder
        .add_file(FileInfo {
            name: "sys/boot.bin".to_string(),
            size: 16,
            offset: None,
            alignment: None,
        })
        .expect("add file");

    let err = build_err(builder.build(files.write_callback()));
    assert!(
        matches!(&err, Error::Other(msg)
            if msg.contains("Boot file sys/boot.bin is 16 bytes, expected 1088")),
        "unexpected error: {err}"
    );
}

#[test]
fn build_rejects_a_bi2_image_of_the_wrong_size() {
    let mut files = FileMap::default();
    files.insert("sys/bi2.bin", payload(16, 3));
    let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    builder
        .add_file(FileInfo {
            name: "sys/bi2.bin".to_string(),
            size: 16,
            offset: None,
            alignment: None,
        })
        .expect("add file");

    let err = build_err(builder.build(files.write_callback()));
    assert!(
        matches!(&err, Error::Other(msg)
            if msg.contains("BI2 file sys/bi2.bin is 16 bytes, expected 8192")),
        "unexpected error: {err}"
    );
}

#[test]
fn build_rejects_an_fst_image_that_does_not_match_its_declared_size() {
    let mut files = FileMap::default();
    files.insert("sys/fst.bin", payload(16, 3));
    let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    builder
        .add_file(FileInfo {
            name: "sys/fst.bin".to_string(),
            size: 64,
            offset: None,
            alignment: None,
        })
        .expect("add file");

    let err = build_err(builder.build(files.write_callback()));
    assert!(
        matches!(&err, Error::Other(msg)
            if msg.contains("FST file sys/fst.bin is 16 bytes, expected 64")),
        "unexpected error: {err}"
    );
}

#[test]
fn build_propagates_a_system_file_read_error() {
    let builder = {
        let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
        builder
            .add_file(FileInfo {
                name: "sys/boot.bin".to_string(),
                size: BOOT_SIZE as u64,
                offset: None,
                alignment: None,
            })
            .expect("add file");
        builder
    };
    let err =
        build_err(builder.build(|_, name| Err(io::Error::other(format!("cannot read {name}")))));
    assert!(
        format!("{err}").contains("Failed to read file sys/boot.bin"),
        "unexpected error: {err}"
    );
}

#[test]
fn build_rejects_a_game_title_that_does_not_fit_the_header() {
    let mut builder = GCPartitionBuilder::new(
        false,
        PartitionOverrides {
            game_title: Some("t".repeat(64)),
            ..PartitionOverrides::default()
        },
    );
    builder
        .add_file(FileInfo {
            name: "sys/apploader.img".to_string(),
            size: APPLOADER_SIZE,
            offset: None,
            alignment: None,
        })
        .expect("add file");

    let err = build_err(builder.build(|_, _| Ok(())));
    assert!(
        matches!(&err, Error::Other(msg) if msg.contains("is too long (64 > 63)")),
        "unexpected error: {err}"
    );
}

#[test]
fn build_requires_an_apploader_and_a_dol() {
    let builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    let err = build_err(builder.build(|_, _| Ok(())));
    assert!(
        matches!(&err, Error::Other(msg) if msg == "Apploader not set"),
        "unexpected error: {err}"
    );

    let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    builder
        .add_file(FileInfo {
            name: "sys/apploader.img".to_string(),
            size: APPLOADER_SIZE,
            offset: None,
            alignment: None,
        })
        .expect("add file");
    let err = build_err(builder.build(|_, _| Ok(())));
    assert!(
        matches!(&err, Error::Other(msg) if msg == "DOL not set"),
        "unexpected error: {err}"
    );
}

#[test]
fn build_rejects_a_user_region_that_starts_before_the_fst() {
    let mut files = FileMap::default();
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));

    let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    boot_header.user_offset = U32::new(0x100);
    builder.set_boot_header(boot_header);
    for (name, size) in [
        ("sys/apploader.img", APPLOADER_SIZE),
        ("sys/main.dol", DOL_SIZE),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset: None,
                alignment: None,
            })
            .expect("add file");
    }

    let err = build_err(builder.build(files.write_callback()));
    assert!(
        matches!(&err, Error::Other(msg) if msg.contains("is before FST")),
        "unexpected error: {err}"
    );
}

#[test]
fn build_rejects_overlapping_user_files() {
    let mut files = FileMap::default();
    files.insert("sys/apploader.img", Arc::from(apploader_bytes()));
    files.insert("sys/main.dol", Arc::from(dol_bytes()));
    files.insert("files/a.bin", payload(0x100, 1));
    files.insert("files/b.bin", payload(0x100, 2));

    let mut builder = GCPartitionBuilder::new(false, PartitionOverrides::default());
    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    boot_header.user_offset = U32::new(USER_OFFSET as u32);
    boot_header.user_size = U32::new(0x8000);
    builder.set_boot_header(boot_header);
    for (name, size, offset) in [
        ("sys/apploader.img", APPLOADER_SIZE, None),
        ("sys/main.dol", DOL_SIZE, None),
        ("files/a.bin", 0x100, Some(USER_OFFSET)),
        ("files/b.bin", 0x100, Some(USER_OFFSET + 0x80)),
    ] {
        builder
            .add_file(FileInfo {
                name: name.to_string(),
                size,
                offset,
                alignment: None,
            })
            .expect("add file");
    }

    let err = build_err(builder.build(files.write_callback()));
    assert!(
        matches!(&err, Error::Other(msg)
            if msg.contains("files/b.bin") && msg.contains("overlaps with files/a.bin")),
        "unexpected error: {err}"
    );
}

#[test]
fn gcm_align_rounds_up_by_31_and_clears_the_low_two_bits() {
    assert_eq!(gcm_align(0), 28);
    assert_eq!(gcm_align(1), 32);
    assert_eq!(gcm_align(4), 32);
    assert_eq!(gcm_align(0x2751), 0x2770);
}

#[test]
fn find_file_gap_only_reports_a_gap_after_the_fst() {
    let file = |offset: u64, size: u64| WriteInfo {
        kind: WriteKind::File(format!("files/{offset:X}.bin")),
        size,
        offset,
    };
    let infos = vec![
        file(0, 0x1000),
        file(0x1000, 0x1000),
        file(0x40000, 0x100),
        file(0x80000, 0x100),
    ];

    // With an FST that ends past every candidate, no gap qualifies.
    assert_eq!(find_file_gap(&infos, 0x100000), None);
    assert_eq!(find_file_gap(&infos, 0x800), Some(0x2000));
    // Junk spans are ignored when scanning for the gap.
    assert_eq!(
        find_file_gap(
            &[WriteInfo {
                kind: WriteKind::Junk,
                size: 0x100000,
                offset: 0,
            }],
            0
        ),
        None
    );
}

#[test]
fn insert_junk_data_leaves_a_fully_packed_layout_untouched() {
    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    boot_header.set_fst_offset(0x1000, false);
    boot_header.set_fst_size(0x100, false);
    boot_header.user_offset = U32::new(0x1100);
    boot_header.user_size = U32::new(0);

    let write_info = vec![WriteInfo {
        kind: WriteKind::Static(Arc::from(&[0u8; 4][..]), "[FST]"),
        size: 0x100,
        offset: 0x1000,
    }];
    let result = insert_junk_data(write_info, &boot_header, false);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].kind.name(), "[FST]");
}
