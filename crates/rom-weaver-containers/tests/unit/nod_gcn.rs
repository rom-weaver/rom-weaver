//! Unit coverage for the GameCube partition reader (`src/nod/disc/gcn.rs`):
//! the `BufRead`/`Seek` surface of `PartitionReaderGC` and the partition
//! metadata readers it shares with the Wii reader.
//!
//! The fixture is a synthetic GameCube image produced by `GCPartitionBuilder`
//! and then reopened through `DiscReader`, so the reader is checked against
//! bytes a writer actually emitted rather than a hand-packed blob.

use std::{collections::HashMap, io::Cursor, io::Read as _};

use zerocopy::big_endian::U32;

use super::*;
use crate::nod::{
    build::gc::{FileInfo, GCPartitionBuilder, PartitionOverrides},
    common::PartitionKind,
    disc::{
        DiscHeader, SECTOR_SIZE,
        fst::Fst,
        preloader::{Preloader, SectorGroupLoader},
    },
    read::{CloneableStream, DiscOptions, DiscReader, PartitionOptions},
};

const APPLOADER_PAYLOAD: usize = 0x100;
const APPLOADER_TRAILER: usize = 0x20;
const DOL_PAYLOAD: usize = 0x40;
const USER_OFFSET: u64 = 0x8000;
const USER_SIZE: u64 = 0x8000;
const HELLO: &str = "files/hello.txt";
const HELLO_LEN: usize = 0x40;

fn apploader_bytes() -> Vec<u8> {
    let mut header = ApploaderHeader::new_box_zeroed().expect("allocate apploader header");
    header.date[..8].copy_from_slice(b"20240101");
    header.size = U32::new(APPLOADER_PAYLOAD as u32);
    header.trailer_size = U32::new(APPLOADER_TRAILER as u32);
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend((0..APPLOADER_PAYLOAD + APPLOADER_TRAILER).map(|i| (i % 253) as u8));
    bytes
}

fn dol_bytes() -> Vec<u8> {
    let mut header = DolHeader::new_box_zeroed().expect("allocate DOL header");
    header.text_offs[0] = U32::new(size_of::<DolHeader>() as u32);
    header.text_sizes[0] = U32::new(0x10);
    // The DOL size is the highest section end, so the data section decides it.
    header.data_offs[0] = U32::new(size_of::<DolHeader>() as u32 + 0x10);
    header.data_sizes[0] = U32::new(DOL_PAYLOAD as u32 - 0x10);
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend((0..DOL_PAYLOAD).map(|i| 0xC0 ^ (i as u8)));
    bytes
}

fn hello_bytes() -> Vec<u8> {
    (0..HELLO_LEN).map(|i| (i * 3 + 1) as u8).collect()
}

/// A complete GameCube image plus the file contents that went into it.
fn gamecube_iso() -> Vec<u8> {
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    files.insert("sys/apploader.img".to_string(), apploader_bytes());
    files.insert("sys/main.dol".to_string(), dol_bytes());
    files.insert(HELLO.to_string(), hello_bytes());

    let mut builder = GCPartitionBuilder::new(
        false,
        PartitionOverrides {
            game_id: Some(*b"GCNRWT"),
            game_title: Some("gcn reader fixture".to_string()),
            disc_version: Some(2),
            region: Some(1),
            ..PartitionOverrides::default()
        },
    );
    let mut boot_header = BootHeader::new_box_zeroed().expect("allocate boot header");
    boot_header.user_offset = U32::new(USER_OFFSET as u32);
    boot_header.user_size = U32::new(USER_SIZE as u32);
    builder.set_boot_header(boot_header);

    for (name, size) in [
        ("sys/apploader.img", apploader_bytes().len() as u64),
        ("sys/main.dol", dol_bytes().len() as u64),
        (HELLO, HELLO_LEN as u64),
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

    let write = |out: &mut dyn io::Write, name: &str| -> io::Result<()> {
        out.write_all(
            files
                .get(name)
                .ok_or_else(|| io::Error::other(format!("unknown file {name}")))?,
        )
    };
    let writer = builder.build(write).expect("build fixture disc");
    let mut iso = Vec::new();
    writer
        .write_to(&mut iso, write)
        .expect("write fixture disc");
    iso
}

fn open_disc(iso: &[u8], preloader_threads: usize) -> DiscReader {
    #[cfg(not(feature = "threading"))]
    let _ = preloader_threads;
    let options = DiscOptions {
        partition_encryption: PartitionEncryption::Original,
        #[cfg(feature = "threading")]
        preloader_threads,
    };
    DiscReader::new_from_cloneable_read(Cursor::new(iso.to_vec()), &options)
        .expect("open fixture disc")
}

fn open_partition(disc: &DiscReader) -> Box<dyn PartitionReader> {
    disc.open_partition_kind(PartitionKind::Data, &PartitionOptions::default())
        .expect("open data partition")
}

#[test]
fn a_gamecube_partition_reader_is_not_a_wii_reader() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let partition = open_partition(&disc);
    assert!(!partition.is_wii());
}

#[test]
fn partition_meta_reads_every_system_file() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);
    let meta = partition.meta().expect("read partition meta");

    assert_eq!(&meta.raw_boot[..6], b"GCNRWT");
    assert_eq!(meta.disc_header().game_id_str(), "GCNRWT");
    assert_eq!(meta.disc_header().game_title_str(), "gcn reader fixture");
    assert!(meta.disc_header().is_gamecube());
    assert!(!meta.disc_header().is_wii());
    assert_eq!(meta.raw_boot.len(), BOOT_SIZE);

    assert_eq!(meta.raw_bi2.len(), BI2_SIZE);
    assert_eq!(&meta.raw_bi2[0x18..0x1C], &1u32.to_be_bytes());

    assert_eq!(meta.raw_apploader.as_ref(), apploader_bytes().as_slice());
    assert_eq!(meta.apploader_header().date_str(), Some("20240101"));
    assert_eq!(meta.raw_dol.as_ref(), dol_bytes().as_slice());
    assert_eq!(
        meta.dol_header().data_offs[0].get(),
        size_of::<DolHeader>() as u32 + 0x10
    );

    // Wii-only blobs are absent on a GameCube partition.
    assert!(meta.raw_ticket.is_none());
    assert!(meta.raw_tmd.is_none());
    assert!(meta.raw_cert_chain.is_none());
    assert!(meta.raw_h3_table.is_none());

    let fst = meta.fst().expect("parse FST");
    assert_eq!(fst.num_files(), 1);
    let (_, node) = fst.find(HELLO).expect("fixture file in FST");
    assert_eq!(node.offset(false), USER_OFFSET);
    assert_eq!(node.length(), HELLO_LEN as u32);
}

#[test]
fn partition_meta_is_cached_after_the_first_read() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);

    let first = partition.meta().expect("read partition meta");
    let second = partition.meta().expect("read cached partition meta");
    assert!(Arc::ptr_eq(&first.raw_boot, &second.raw_boot));
    assert!(Arc::ptr_eq(&first.raw_fst, &second.raw_fst));
}

#[test]
fn partition_reader_streams_the_whole_image() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);

    let mut out = Vec::new();
    partition.read_to_end(&mut out).expect("read partition");
    assert_eq!(out, iso);

    // Past the end of the disc the reader yields nothing.
    assert!(partition.fill_buf().expect("fill_buf at end").is_empty());
    assert_eq!(partition.read(&mut [0u8; 16]).expect("read at end"), 0);
}

#[test]
fn partition_reader_seeks_from_every_anchor() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);
    let size = iso.len() as u64;

    assert_eq!(
        partition.seek(SeekFrom::Start(USER_OFFSET)).expect("seek"),
        USER_OFFSET
    );
    assert_eq!(partition.stream_position().expect("position"), USER_OFFSET);
    let mut buf = vec![0u8; HELLO_LEN];
    partition.read_exact(&mut buf).expect("read fixture file");
    assert_eq!(buf, hello_bytes());

    assert_eq!(partition.seek(SeekFrom::End(0)).expect("seek"), size);
    assert_eq!(partition.seek(SeekFrom::End(-16)).expect("seek"), size - 16);
    assert_eq!(
        partition.seek(SeekFrom::Current(-0x10)).expect("seek"),
        size - 32
    );
    // Seeking before the start saturates at zero.
    assert_eq!(
        partition.seek(SeekFrom::Current(-1 << 40)).expect("seek"),
        0
    );
}

#[test]
fn a_cloned_partition_reader_restarts_at_the_beginning() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);
    partition.meta().expect("read partition meta");
    partition
        .seek(SeekFrom::Start(USER_OFFSET))
        .expect("seek before clone");

    let mut cloned = dyn_clone::clone_box(&*partition);
    assert_eq!(cloned.stream_position().expect("position"), 0);
    let mut head = [0u8; 6];
    cloned.read_exact(&mut head).expect("read from clone");
    assert_eq!(&head, b"GCNRWT");
    // The cached metadata is carried across the clone.
    assert!(Arc::ptr_eq(
        &partition.meta().expect("meta").raw_boot,
        &cloned.meta().expect("cloned meta").raw_boot
    ));
}

#[test]
fn open_file_streams_a_file_listed_in_the_fst() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);
    let meta = partition.meta().expect("read partition meta");
    let fst = meta.fst().expect("parse FST");
    let (_, node) = fst.find(HELLO).expect("fixture file in FST");

    let mut contents = Vec::new();
    partition
        .open_file(node)
        .expect("open file stream")
        .read_to_end(&mut contents)
        .expect("read file");
    assert_eq!(contents, hello_bytes());
}

#[test]
fn the_preloader_serves_the_same_bytes_with_worker_threads() {
    let iso = gamecube_iso();
    let mut single = Vec::new();
    open_partition(&open_disc(&iso, 0))
        .read_to_end(&mut single)
        .expect("read single-threaded");

    let mut threaded = Vec::new();
    open_partition(&open_disc(&iso, 2))
        .read_to_end(&mut threaded)
        .expect("read with preloader threads");

    assert_eq!(threaded, single);
    assert_eq!(threaded, iso);
}

#[test]
fn a_reader_sized_past_the_image_stops_at_the_last_readable_sector() {
    let iso = gamecube_iso();
    let disc_header =
        DiscHeader::read_from_bytes(&iso[..size_of::<DiscHeader>()]).expect("parse disc header");
    let block_reader =
        crate::nod::io::block::new(Box::new(CloneableStream::new(Cursor::new(iso.clone()))))
            .expect("open block reader");
    let loader = SectorGroupLoader::new(
        block_reader,
        Arc::new(disc_header),
        Arc::from(Vec::new().into_boxed_slice()),
    );
    let preloader = Preloader::new(
        loader,
        #[cfg(feature = "threading")]
        0,
    );

    // Claim a disc twice the size of the backing image; the sectors past the
    // image are missing from the sector-group bitmap.
    let claimed_size = iso.len() as u64 * 2;
    let mut reader =
        PartitionReaderGC::new(preloader, claimed_size).expect("create partition reader");
    reader
        .seek(SeekFrom::Start(iso.len() as u64))
        .expect("seek past the image");
    assert!(reader.fill_buf().expect("fill_buf past image").is_empty());

    reader.seek(SeekFrom::Start(0)).expect("seek to start");
    let head = reader.fill_buf().expect("fill_buf at start");
    assert_eq!(head.len(), iso.len());
    assert_eq!(&head[..6], b"GCNRWT");
}

#[test]
fn read_dol_and_read_fst_follow_the_boot_header_offsets() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);
    let boot_header =
        BootHeader::read_from_bytes(&iso[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("parse boot header");

    let raw_dol = read_dol(partition.as_mut(), &boot_header, false).expect("read DOL");
    assert_eq!(raw_dol.as_ref(), dol_bytes().as_slice());

    let raw_fst = read_fst(partition.as_mut(), &boot_header, false).expect("read FST");
    assert_eq!(raw_fst.len() as u64, boot_header.fst_size(false));
    let fst = Fst::new(&raw_fst).expect("parse FST");
    assert!(fst.find(HELLO).is_some());

    let raw_apploader = read_apploader(partition.as_mut()).expect("read apploader");
    assert_eq!(raw_apploader.as_ref(), apploader_bytes().as_slice());
}

#[test]
fn read_fst_reports_an_out_of_range_offset() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);
    let mut boot_header =
        BootHeader::read_from_bytes(&iso[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("parse boot header");
    boot_header.set_fst_offset(iso.len() as u64 - 4, false);
    boot_header.set_fst_size(0x100, false);

    let err = read_fst(partition.as_mut(), &boot_header, false).expect_err("FST past end of disc");
    assert!(
        format!("{err}").contains("Reading partition FST"),
        "unexpected error: {err}"
    );
}

#[test]
fn read_part_meta_matches_the_partition_reader() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);
    partition.rewind().expect("rewind");

    let meta = read_part_meta(partition.as_mut(), false).expect("read part meta");
    assert_eq!(meta.raw_apploader.as_ref(), apploader_bytes().as_slice());
    assert_eq!(meta.raw_dol.as_ref(), dol_bytes().as_slice());
    assert_eq!(meta.raw_bi2.len(), BI2_SIZE);
    assert_eq!(
        meta.boot_header().user_offset.get() as u64 + meta.boot_header().user_size.get() as u64,
        iso.len() as u64
    );
}

#[test]
fn the_disc_reader_exposes_the_gamecube_fst_and_rejects_other_partition_kinds() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);

    assert_eq!(disc.disc_size(), iso.len() as u64);
    assert!(disc.partitions().is_empty());
    assert!(disc.region().is_none());
    assert!(disc.header().is_gamecube());

    let err = disc
        .open_partition_kind(PartitionKind::Update, &PartitionOptions::default())
        .err()
        .expect("GameCube discs only have a data partition");
    assert!(
        format!("{err}").contains("only have a data partition"),
        "unexpected error: {err}"
    );

    let err = disc
        .open_partition(1, &PartitionOptions::default())
        .err()
        .expect("GameCube discs only have one partition");
    assert!(
        format!("{err}").contains("only have one partition"),
        "unexpected error: {err}"
    );
}

#[test]
fn the_partition_reader_reads_across_a_sector_boundary() {
    let iso = gamecube_iso();
    let disc = open_disc(&iso, 0);
    let mut partition = open_partition(&disc);

    let start = SECTOR_SIZE as u64 - 0x10;
    partition
        .seek(SeekFrom::Start(start))
        .expect("seek to sector boundary");
    let mut buf = [0u8; 0x20];
    partition
        .read_exact(&mut buf)
        .expect("read across sector boundary");
    assert_eq!(buf.as_slice(), &iso[start as usize..start as usize + 0x20]);
}
