//! Coverage for `src/nod/io/ciso.rs`: the CISO block reader (present,
//! missing, junk and out-of-bounds blocks), the writer's option validation,
//! and a full ISO -> CISO -> ISO round trip through the NKit 2 junk bitmap.

use bytes::Bytes;
use zerocopy::FromZeros;

use super::*;
use crate::nod::{
    read::{DiscOptions, DiscReader as PublicDiscReader},
    tests::{GC_DISC_SIZE, build_gamecube_iso},
    util::lfg::LaggedFibonacci,
    write::{DiscWriter as PublicDiscWriter, FormatOptions, ProcessOptions},
};

/// `DiscWriter`/`BlockReader` are not `Debug`, so unwrap error arms by hand
/// rather than using `expect_err`.
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

/// Runs a `DiscWriter` to completion and applies its finalization header the
/// way a file consumer would, returning the finished image.
fn write_to_vec(writer: &PublicDiscWriter, options: &ProcessOptions) -> Vec<u8> {
    let mut out = Vec::new();
    let finalization = writer
        .process(
            |data: Bytes, _progress, _total| {
                out.extend_from_slice(data.as_ref());
                Ok(())
            },
            options,
        )
        .expect("writer runs to completion");
    if !finalization.header.is_empty() {
        out[..finalization.header.len()].copy_from_slice(finalization.header.as_ref());
    }
    out
}

fn write_ciso(image: Vec<u8>) -> Vec<u8> {
    let disc = gamecube_reader(image);
    let writer = PublicDiscWriter::new(
        disc,
        &FormatOptions {
            format: Format::Ciso,
            compression: Compression::None,
            block_size: DEFAULT_BLOCK_SIZE,
        },
    )
    .expect("CISO writer");
    write_to_vec(&writer, &ProcessOptions::default())
}

/// A hand-built CISO whose map marks `present` blocks in order; absent blocks
/// read back as zeroes (or junk, if the NKit bitmap says so).
fn hand_built_ciso(block_size: u32, present: &[bool], payload: &[u8]) -> Vec<u8> {
    let mut header = CISOHeader::new_box_zeroed().expect("header");
    header.magic = CISO_MAGIC;
    header.block_size = block_size.into();
    for (index, flag) in present.iter().enumerate() {
        header.block_present[index] = u8::from(*flag);
    }
    let mut out = header.as_bytes().to_vec();
    out.extend_from_slice(payload);
    out
}

// --- BlockReaderCISO ------------------------------------------------------

#[test]
fn block_reader_rejects_a_bad_magic() {
    let mut data = vec![0u8; SECTOR_SIZE];
    data[..4].copy_from_slice(b"NOPE");
    let error = expect_error(BlockReaderCISO::new(Box::new(data)));
    assert!(
        error.to_string().contains("Invalid CISO magic"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_rejects_a_file_shorter_than_its_block_map_claims() {
    let block_size = SECTOR_SIZE as u32;
    // Two present blocks, but only one block of payload follows the header.
    let data = hand_built_ciso(block_size, &[true, true], &vec![0u8; SECTOR_SIZE]);
    let error = expect_error(BlockReaderCISO::new(Box::new(data)));
    assert!(
        error
            .to_string()
            .contains("CISO file size mismatch: expected at least"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_serves_present_missing_and_out_of_range_blocks() {
    let block_size = SECTOR_SIZE as u32;
    let mut payload = vec![0u8; 2 * SECTOR_SIZE];
    payload[0] = 0xA1;
    payload[SECTOR_SIZE] = 0xB2;
    // Block 1 is absent, so blocks 0 and 2 hold the two payload blocks.
    let data = hand_built_ciso(block_size, &[true, false, true], &payload);

    let mut reader = BlockReaderCISO::new(Box::new(data)).expect("CISO opens");
    assert_eq!(reader.block_size(), block_size);
    let meta = reader.meta();
    assert_eq!(meta.format, Format::Ciso);
    assert_eq!(meta.block_size, Some(block_size));

    let mut out = vec![0u8; SECTOR_SIZE];
    let block = reader.read_block(&mut out, 0).expect("block 0");
    assert_eq!(block.kind, BlockKind::Raw);
    assert_eq!(out[0], 0xA1);

    out.fill(0xFF);
    let block = reader.read_block(&mut out, 1).expect("block 1");
    assert_eq!(block.kind, BlockKind::Zero, "absent blocks read as zeroes");

    out.fill(0);
    let block = reader.read_block(&mut out, 2).expect("block 2");
    assert_eq!(block.kind, BlockKind::Raw);
    assert_eq!(out[0], 0xB2);

    let block = reader
        .read_block(&mut out, CISO_MAP_SIZE as u32)
        .expect("past the end of the map");
    assert_eq!(block.kind, BlockKind::None);
}

// --- DiscWriterCISO option validation -------------------------------------

#[test]
fn writer_rejects_a_mismatched_format_and_any_compression() {
    let error = expect_error(PublicDiscWriter::new(
        gamecube_reader(build_gamecube_iso()),
        &FormatOptions {
            format: Format::Iso,
            compression: Compression::Zstandard(3),
            block_size: 0,
        },
    ));
    assert!(
        error
            .to_string()
            .contains("ISO/GCM does not support compression"),
        "unexpected message: {error}"
    );

    let error = expect_error(PublicDiscWriter::new(
        gamecube_reader(build_gamecube_iso()),
        &FormatOptions {
            format: Format::Ciso,
            compression: Compression::Zstandard(3),
            block_size: DEFAULT_BLOCK_SIZE,
        },
    ));
    assert!(
        error
            .to_string()
            .contains("CISO does not support compression"),
        "unexpected message: {error}"
    );
}

#[test]
fn writer_rejects_a_format_other_than_ciso_at_the_writer_itself() {
    let disc = gamecube_reader(build_gamecube_iso()).into_inner();
    let error = expect_error(DiscWriterCISO::new(
        disc,
        &FormatOptions {
            format: Format::Wbfs,
            compression: Compression::None,
            block_size: DEFAULT_BLOCK_SIZE,
        },
    ));
    assert!(
        error.to_string().contains("Invalid format for CISO writer"),
        "unexpected message: {error}"
    );
}

#[test]
fn writer_reports_its_progress_bound_and_weight() {
    let disc = gamecube_reader(build_gamecube_iso());
    let writer = PublicDiscWriter::new(
        disc,
        &FormatOptions {
            format: Format::Ciso,
            compression: Compression::None,
            block_size: DEFAULT_BLOCK_SIZE,
        },
    )
    .expect("CISO writer");
    assert_eq!(writer.progress_bound(), GC_DISC_SIZE as u64);
    assert!(matches!(writer.weight(), DiscWriterWeight::Medium));
}

// --- Round trip -----------------------------------------------------------

#[test]
fn ciso_round_trip_restores_the_original_disc_bytes() {
    let image = build_gamecube_iso();
    let ciso = write_ciso(image.clone());

    assert_eq!(&ciso[..4], CISO_MAGIC.as_slice());
    let header =
        CISOHeader::read_from_bytes(&ciso[..size_of::<CISOHeader>()]).expect("CISO header");
    assert_eq!(header.block_size.get(), DEFAULT_BLOCK_SIZE);
    // Block 0 holds real data; the junk block and the trailing zero block are
    // both dropped from the file.
    assert_eq!(header.block_present[0], 1);
    assert_eq!(header.block_present[1], 0);
    assert_eq!(header.block_present[2], 0);
    assert!(
        ciso.len() < image.len(),
        "CISO must be smaller than the source ISO"
    );

    let mut restored = PublicDiscReader::new_stream(Box::new(ciso), &DiscOptions::default())
        .expect("CISO reopens");
    assert_eq!(restored.meta().format, Format::Ciso);
    assert_eq!(restored.disc_size(), image.len() as u64);

    let mut out = Vec::with_capacity(image.len());
    crate::nod::util::buf_copy(&mut restored, &mut out).expect("read the whole disc back");
    assert_eq!(out.len(), image.len());
    assert_eq!(out, image, "CISO round trip must be byte-identical");
}

#[test]
fn ciso_stores_the_junk_bitmap_and_digests_in_its_nkit_header() {
    let image = build_gamecube_iso();
    let options = ProcessOptions {
        digest_crc32: true,
        digest_xxh64: true,
        ..Default::default()
    };
    let disc = gamecube_reader(image.clone());
    let writer = PublicDiscWriter::new(
        disc,
        &FormatOptions {
            format: Format::Ciso,
            compression: Compression::None,
            block_size: DEFAULT_BLOCK_SIZE,
        },
    )
    .expect("CISO writer");

    let mut out = Vec::new();
    let finalization = writer
        .process(
            |data: Bytes, _progress, _total| {
                out.extend_from_slice(data.as_ref());
                Ok(())
            },
            &options,
        )
        .expect("writer runs");
    out[..finalization.header.len()].copy_from_slice(finalization.header.as_ref());

    let expected_crc = crc32fast::hash(&image);
    assert_eq!(finalization.crc32, Some(expected_crc));
    assert!(finalization.xxh64.is_some());
    assert!(finalization.md5.is_none());

    let reader = BlockReaderCISO::new(Box::new(out)).expect("CISO reopens");
    let meta = reader.meta();
    assert_eq!(meta.crc32, Some(expected_crc));
    assert_eq!(meta.disc_size, Some(image.len() as u64));
    assert!(meta.lossless, "the NKit junk bitmap makes CISO lossless");
}

#[test]
fn ciso_reader_regenerates_junk_blocks_recorded_by_nkit() {
    let image = build_gamecube_iso();
    let ciso = write_ciso(image.clone());
    let mut reader = BlockReaderCISO::new(Box::new(ciso)).expect("CISO reopens");

    let block_size = reader.block_size() as usize;
    let sectors_per_block = (block_size / SECTOR_SIZE) as u32;
    let mut out = vec![0u8; block_size];

    // The second 2 MiB block of the fixture is entirely junk data.
    let block = reader
        .read_block(&mut out, sectors_per_block)
        .expect("junk block");
    assert_eq!(block.kind, BlockKind::Junk);

    // The third is all zeroes.
    let block = reader
        .read_block(&mut out, sectors_per_block * 2)
        .expect("zero block");
    assert_eq!(block.kind, BlockKind::Zero);

    // A junk block carries no payload in the file; the reader tells the
    // caller to regenerate it, and the regenerated bytes match the source.
    let mut regenerated = vec![0u8; block_size];
    let mut lfg = LaggedFibonacci::default();
    lfg.fill_sector_chunked(
        &mut regenerated,
        crate::nod::tests::gc_disc_id(),
        0,
        block_size as u64,
    );
    assert_eq!(
        regenerated,
        image[block_size..block_size * 2],
        "the fixture's second block must be pure junk"
    );
}
