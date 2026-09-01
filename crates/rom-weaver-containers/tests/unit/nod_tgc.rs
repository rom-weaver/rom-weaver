//! Coverage for `src/nod/io/tgc.rs`: the TGC writer's system-file layout, the
//! block reader that rebuilds a GCM from a TGC's relocated user data, and the
//! FST-driven file callback.

use std::io::Read;

use super::*;
use crate::nod::{
    read::{DiscOptions, DiscReader as PublicDiscReader},
    tests::{
        GC_DOL_OFFSET, GC_DOL_SIZE, GC_FILE_A_OFFSET, GC_FILE_A_PATH, GC_FILE_B_OFFSET,
        GC_FILE_B_PATH, GC_FILE_SIZE, GC_FST_OFFSET, GC_GAME_ID, GC_USER_END, build_gamecube_iso,
    },
    write::{DiscWriter as PublicDiscWriter, FormatOptions},
};

/// `DiscWriter` and `BlockReader` are not `Debug`, so unwrap error arms by
/// hand rather than using `expect_err`.
fn expect_error<T>(result: Result<T>) -> Error {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(error) => error,
    }
}

fn gamecube_reader(image: Vec<u8>) -> PublicDiscReader {
    PublicDiscReader::new_stream(Box::new(image), &DiscOptions::default())
        .expect("GameCube fixture opens")
}

fn write_tgc(image: Vec<u8>) -> Vec<u8> {
    let writer = PublicDiscWriter::new(
        gamecube_reader(image),
        &FormatOptions {
            format: Format::Tgc,
            compression: Compression::None,
            block_size: 0,
        },
    )
    .expect("TGC writer");
    let mut out = Vec::new();
    let finalization = writer
        .process(
            |data, _progress, _total| {
                out.extend_from_slice(data.as_ref());
                Ok(())
            },
            &ProcessOptions::default(),
        )
        .expect("writer runs to completion");
    assert!(
        finalization.header.is_empty(),
        "TGC writes its header up front"
    );
    out
}

fn tgc_header(tgc: &[u8]) -> TGCHeader {
    TGCHeader::read_from_bytes(&tgc[..size_of::<TGCHeader>()]).expect("TGC header")
}

// --- Writer option validation --------------------------------------------

#[test]
fn writer_rejects_a_mismatched_format_and_any_compression() {
    let disc = gamecube_reader(build_gamecube_iso()).into_inner();
    let error = expect_error(DiscWriterTGC::new(
        disc,
        &FormatOptions {
            format: Format::Wbfs,
            compression: Compression::None,
            block_size: 0,
        },
    ));
    assert!(
        error.to_string().contains("Invalid format for TGC writer"),
        "unexpected message: {error}"
    );

    let error = expect_error(PublicDiscWriter::new(
        gamecube_reader(build_gamecube_iso()),
        &FormatOptions {
            format: Format::Tgc,
            compression: Compression::Zstandard(3),
            block_size: 0,
        },
    ));
    assert!(
        error
            .to_string()
            .contains("TGC does not support compression"),
        "unexpected message: {error}"
    );
}

// --- Writer layout --------------------------------------------------------

#[test]
fn writer_lays_out_the_system_files_ahead_of_the_relocated_user_data() {
    let image = build_gamecube_iso();
    let tgc = write_tgc(image.clone());
    let header = tgc_header(&tgc);

    assert_eq!(header.magic, TGC_MAGIC);
    assert_eq!(header.version.get(), 0);
    assert_eq!(header.header_offset.get(), SECTOR_SIZE as u32);
    assert_eq!(header.header_size.get(), GCM_HEADER_SIZE as u32);
    assert_eq!(
        header.fst_offset.get(),
        SECTOR_SIZE as u32 + GCM_HEADER_SIZE as u32
    );
    assert_eq!(header.gcm_files_start.get(), GC_FILE_A_OFFSET as u32);
    assert_eq!(
        header.user_size.get(),
        (GC_USER_END - GC_FILE_A_OFFSET) as u32
    );
    assert_eq!(header.dol_size.get(), GC_DOL_SIZE as u32);
    assert_eq!(header.banner_offset.get(), 0);
    assert_eq!(header.banner_size.get(), 0);
    // The user region ends on a sector boundary, which is what pins
    // `user_offset` once `user_size` is known.
    assert_eq!(
        (header.user_offset.get() as u64 + header.user_size.get() as u64) % SECTOR_SIZE as u64,
        0
    );
    assert!(
        header.dol_offset.get() % 32 == 0,
        "the DOL is 32-byte aligned"
    );

    // The GCM header copied into the TGC is the first megabyte of the source.
    let start = header.header_offset.get() as usize;
    assert_eq!(
        &tgc[start..start + GCM_HEADER_SIZE],
        &image[..GCM_HEADER_SIZE]
    );

    // The DOL and FST are copied verbatim from the source image.
    let dol_start = header.dol_offset.get() as usize;
    assert_eq!(
        &tgc[dol_start..dol_start + GC_DOL_SIZE as usize],
        &image[GC_DOL_OFFSET as usize..(GC_DOL_OFFSET + GC_DOL_SIZE) as usize]
    );
    let fst_start = header.fst_offset.get() as usize;
    let fst_size = header.fst_size.get() as usize;
    assert_eq!(
        &tgc[fst_start..fst_start + fst_size],
        &image[GC_FST_OFFSET as usize..GC_FST_OFFSET as usize + fst_size]
    );

    // User data starts at `user_offset` with the first file's bytes.
    let user_start = header.user_offset.get() as usize;
    assert_eq!(
        &tgc[user_start..user_start + GC_FILE_SIZE as usize],
        &image[GC_FILE_A_OFFSET as usize..(GC_FILE_A_OFFSET + GC_FILE_SIZE as u64) as usize]
    );
}

#[test]
fn writer_reports_its_progress_bound_and_weight() {
    let writer = PublicDiscWriter::new(
        gamecube_reader(build_gamecube_iso()),
        &FormatOptions {
            format: Format::Tgc,
            compression: Compression::None,
            block_size: 0,
        },
    )
    .expect("TGC writer");
    assert!(matches!(writer.weight(), DiscWriterWeight::Light));
    assert!(writer.progress_bound() >= GC_USER_END);
}

// --- Block reader ---------------------------------------------------------

#[test]
fn block_reader_rejects_a_bad_magic() {
    let mut data = vec![0u8; 0x1000];
    data[..4].copy_from_slice(b"NOPE");
    let error = expect_error(BlockReaderTGC::new(Box::new(data)));
    assert!(
        error.to_string().contains("Invalid TGC magic"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_rebuilds_the_original_gcm_byte_for_byte() {
    let image = build_gamecube_iso();
    let tgc = write_tgc(image.clone());

    let mut restored =
        PublicDiscReader::new_stream(Box::new(tgc), &DiscOptions::default()).expect("TGC reopens");
    let meta = restored.meta();
    assert_eq!(meta.format, Format::Tgc);
    // A TGC only stores up to the end of the user region, not the zero-filled
    // tail of the source image.
    assert_eq!(restored.disc_size(), GC_USER_END);
    assert_eq!(meta.disc_size, Some(GC_USER_END));
    assert_eq!(restored.header().game_id, GC_GAME_ID);

    let mut out = Vec::with_capacity(GC_USER_END as usize);
    restored.read_to_end(&mut out).expect("read the whole disc");
    assert_eq!(out.len(), GC_USER_END as usize);
    assert_eq!(
        out,
        image[..GC_USER_END as usize],
        "the rebuilt GCM must match the source, junk data included"
    );
}

#[test]
fn block_reader_reports_empty_blocks_past_the_end_of_the_disc() {
    let tgc = write_tgc(build_gamecube_iso());
    let mut reader = BlockReaderTGC::new(Box::new(tgc)).expect("TGC opens");
    assert_eq!(reader.block_size(), SECTOR_SIZE as u32);

    let mut out = vec![0u8; SECTOR_SIZE];
    let block = reader.read_block(&mut out, 0).expect("first sector");
    assert_eq!(block.kind, BlockKind::Raw);
    assert_eq!(block.count, 1);

    let past_end = (GC_USER_END / SECTOR_SIZE as u64) as u32;
    let block = reader.read_block(&mut out, past_end).expect("past the end");
    assert_eq!(block.kind, BlockKind::None);
}

#[test]
fn file_callback_maps_fst_offsets_into_the_tgc_user_region() {
    let image = build_gamecube_iso();
    let tgc = write_tgc(image.clone());
    let header = tgc_header(&tgc);
    let fst_start = header.fst_offset.get() as usize;
    let raw_fst: Arc<[u8]> = Arc::from(&tgc[fst_start..fst_start + header.fst_size.get() as usize]);

    let mut callback = FileCallbackTGC::new(Box::new(tgc), raw_fst, header);

    for (path, offset) in [
        (GC_FILE_A_PATH, GC_FILE_A_OFFSET),
        (GC_FILE_B_PATH, GC_FILE_B_OFFSET),
    ] {
        let mut out = vec![0u8; GC_FILE_SIZE as usize];
        callback.read_file(&mut out, path, 0).expect("file reads");
        assert_eq!(
            out,
            image[offset as usize..offset as usize + GC_FILE_SIZE as usize],
            "{path} content mismatch"
        );

        // A non-zero offset reads from inside the file.
        let mut tail = vec![0u8; 16];
        callback.read_file(&mut tail, path, 32).expect("tail reads");
        assert_eq!(tail, out[32..48], "{path} tail mismatch");
    }
}

#[test]
fn file_callback_rejects_unknown_paths_and_directories() {
    let tgc = write_tgc(build_gamecube_iso());
    let header = tgc_header(&tgc);
    let fst_start = header.fst_offset.get() as usize;
    let raw_fst: Arc<[u8]> = Arc::from(&tgc[fst_start..fst_start + header.fst_size.get() as usize]);
    let mut callback = FileCallbackTGC::new(Box::new(tgc), raw_fst, header);

    let mut out = [0u8; 16];
    let error = callback
        .read_file(&mut out, "files/missing.bin", 0)
        .expect_err("path is not in the FST");
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert!(
        error.to_string().contains("File not found in FST"),
        "unexpected message: {error}"
    );

    let error = callback
        .read_file(&mut out, "files", 0)
        .expect_err("path is a directory");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("Path is a directory"),
        "unexpected message: {error}"
    );
}
