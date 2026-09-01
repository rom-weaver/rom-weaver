//! Coverage for `src/nod/io/gcz.rs`: the GCZ writer's option validation and
//! block map, plus the reader's checksum, block-size and decompression
//! guards.

use std::io::Write;

use adler2::adler32_slice;
use flate2::{Compression as DeflateLevel, write::ZlibEncoder};

use super::*;
use crate::nod::{
    read::{DiscOptions, DiscReader as PublicDiscReader},
    tests::{GC_DISC_SIZE, build_gamecube_iso},
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

fn gcz_options(block_size: u32) -> FormatOptions {
    FormatOptions {
        format: Format::Gcz,
        compression: DEFAULT_COMPRESSION,
        block_size,
    }
}

fn write_gcz(image: Vec<u8>, block_size: u32) -> Vec<u8> {
    let writer = PublicDiscWriter::new(gamecube_reader(image), &gcz_options(block_size))
        .expect("GCZ writer");
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
    out[..finalization.header.len()].copy_from_slice(finalization.header.as_ref());
    out
}

fn gcz_header(gcz: &[u8]) -> GCZHeader {
    GCZHeader::read_from_bytes(&gcz[..size_of::<GCZHeader>()]).expect("GCZ header")
}

fn zlib_stream(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), DeflateLevel::new(6));
    encoder.write_all(data).expect("deflate");
    encoder.finish().expect("finish deflate")
}

/// Assembles a GCZ from explicit `(stored, payload)` blocks so the reader's
/// guards can be aimed at one block at a time. `stored` sets the block map's
/// high bit, which tells the reader the payload is raw rather than deflated.
fn hand_built_gcz(block_size: u32, disc_size: u64, blocks: &[(bool, Vec<u8>)]) -> Vec<u8> {
    let total: usize = blocks.iter().map(|(_, data)| data.len()).sum();
    let header = GCZHeader {
        magic: GCZ_MAGIC,
        disc_type: 0.into(),
        compressed_size: (total as u64).into(),
        disc_size: disc_size.into(),
        block_size: block_size.into(),
        block_count: (blocks.len() as u32).into(),
    };

    let mut out = header.as_bytes().to_vec();
    let mut offset = 0u64;
    for (stored, data) in blocks {
        let entry = offset | (u64::from(*stored) << 63);
        out.extend_from_slice(&entry.to_le_bytes());
        offset += data.len() as u64;
    }
    for (_, data) in blocks {
        out.extend_from_slice(&adler32_slice(data).to_le_bytes());
    }
    for (_, data) in blocks {
        out.extend_from_slice(data);
    }
    out
}

// --- Writer option validation --------------------------------------------

#[test]
fn writer_rejects_a_mismatched_format() {
    let disc = gamecube_reader(build_gamecube_iso()).into_inner();
    let error = expect_error(DiscWriterGCZ::new(
        disc,
        &FormatOptions {
            format: Format::Wbfs,
            compression: DEFAULT_COMPRESSION,
            block_size: DEFAULT_BLOCK_SIZE,
        },
    ));
    assert!(
        error.to_string().contains("Invalid format for GCZ writer"),
        "unexpected message: {error}"
    );
}

#[test]
fn writer_rejects_a_non_deflate_compression() {
    let error = expect_error(PublicDiscWriter::new(
        gamecube_reader(build_gamecube_iso()),
        &FormatOptions {
            format: Format::Gcz,
            compression: Compression::Zstandard(3),
            block_size: DEFAULT_BLOCK_SIZE,
        },
    ));
    assert!(
        error
            .to_string()
            .contains("Unsupported compression for GCZ"),
        "unexpected message: {error}"
    );
}

#[test]
fn writer_rejects_a_block_size_that_is_not_a_sector_multiple() {
    for block_size in [0, SECTOR_SIZE as u32 / 2, SECTOR_SIZE as u32 + 1] {
        let error = expect_error(PublicDiscWriter::new(
            gamecube_reader(build_gamecube_iso()),
            &gcz_options(block_size),
        ));
        assert!(
            error.to_string().contains("Invalid block size for GCZ"),
            "block size {block_size}: unexpected message: {error}"
        );
    }
}

#[test]
fn writer_reports_its_progress_bound_and_weight() {
    let writer = PublicDiscWriter::new(
        gamecube_reader(build_gamecube_iso()),
        &gcz_options(DEFAULT_BLOCK_SIZE),
    )
    .expect("GCZ writer");
    assert_eq!(writer.progress_bound(), GC_DISC_SIZE as u64);
    assert!(matches!(writer.weight(), DiscWriterWeight::Heavy));
}

// --- Round trip -----------------------------------------------------------

#[test]
fn gcz_round_trip_restores_the_original_disc_bytes() {
    let image = build_gamecube_iso();
    let gcz = write_gcz(image.clone(), DEFAULT_BLOCK_SIZE);

    let header = gcz_header(&gcz);
    assert_eq!(header.magic, GCZ_MAGIC);
    assert_eq!(header.disc_type.get(), 0, "the fixture is a GameCube disc");
    assert_eq!(header.disc_size.get(), image.len() as u64);
    assert_eq!(header.block_size.get(), DEFAULT_BLOCK_SIZE);
    assert_eq!(
        header.block_count.get(),
        (image.len() as u64).div_ceil(DEFAULT_BLOCK_SIZE as u64) as u32
    );
    assert_eq!(
        header.compressed_size.get(),
        (gcz.len() - size_of::<GCZHeader>() - header.block_count.get() as usize * 12) as u64
    );
    assert!(gcz.len() < image.len(), "GCZ must compress the fixture");

    let mut restored =
        PublicDiscReader::new_stream(Box::new(gcz), &DiscOptions::default()).expect("GCZ reopens");
    let meta = restored.meta();
    assert_eq!(meta.format, Format::Gcz);
    assert_eq!(meta.compression, Compression::Deflate(0));
    assert_eq!(meta.block_size, Some(DEFAULT_BLOCK_SIZE));
    assert!(meta.lossless);
    assert_eq!(restored.disc_size(), image.len() as u64);

    let mut out = Vec::with_capacity(image.len());
    crate::nod::util::buf_copy(&mut restored, &mut out).expect("read the whole disc back");
    assert_eq!(out, image, "GCZ round trip must be byte-identical");
}

#[test]
fn gcz_block_map_offsets_and_checksums_describe_the_stored_payloads() {
    let gcz = write_gcz(build_gamecube_iso(), DEFAULT_BLOCK_SIZE);
    let header = gcz_header(&gcz);

    let block_count = header.block_count.get() as usize;
    let map_start = size_of::<GCZHeader>();
    let block_map =
        <[U64]>::ref_from_bytes(&gcz[map_start..map_start + block_count * 8]).expect("block map");
    let hashes_start = map_start + block_count * 8;
    let block_hashes = <[U32]>::ref_from_bytes(&gcz[hashes_start..hashes_start + block_count * 4])
        .expect("block hashes");

    let data_offset = size_of::<GCZHeader>() + block_count * 12;
    for index in 0..block_count {
        let raw = block_map[index].get();
        let offset = raw & !(1 << 63);
        let end = block_map
            .get(index + 1)
            .map(|next| next.get() & !(1 << 63))
            .unwrap_or_else(|| header.compressed_size.get());
        let start = data_offset + offset as usize;
        let stop = data_offset + end as usize;
        assert_eq!(
            adler32_slice(&gcz[start..stop]),
            block_hashes[index].get(),
            "block {index} checksum must cover exactly its stored bytes"
        );
        assert!(
            stop - start <= DEFAULT_BLOCK_SIZE as usize,
            "block {index} must not exceed one block"
        );
    }
}

// --- Reader guards --------------------------------------------------------

#[test]
fn block_reader_rejects_a_bad_magic() {
    let mut data = vec![0u8; 0x100];
    data[..4].copy_from_slice(b"NOPE");
    let error = expect_error(BlockReaderGCZ::new(Box::new(data)));
    assert!(
        error.to_string().contains("Invalid GCZ magic"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_reports_blocks_past_the_end_of_the_map_as_empty() {
    let gcz = write_gcz(build_gamecube_iso(), DEFAULT_BLOCK_SIZE);
    let mut reader = BlockReaderGCZ::new(Box::new(gcz)).expect("GCZ opens");
    assert_eq!(reader.block_size(), DEFAULT_BLOCK_SIZE);

    let sectors_per_block = DEFAULT_BLOCK_SIZE / SECTOR_SIZE as u32;
    let past_end = sectors_per_block * (GC_DISC_SIZE as u32 / DEFAULT_BLOCK_SIZE + 1);
    let mut out = vec![0u8; DEFAULT_BLOCK_SIZE as usize];
    let block = reader.read_block(&mut out, past_end).expect("past the end");
    assert_eq!(block.kind, BlockKind::None);
}

#[test]
fn block_reader_serves_a_stored_block_verbatim() {
    let block_size = SECTOR_SIZE as u32;
    let mut payload = vec![0u8; SECTOR_SIZE];
    payload[0] = 0x5A;
    payload[SECTOR_SIZE - 1] = 0xA5;
    let gcz = hand_built_gcz(block_size, SECTOR_SIZE as u64, &[(true, payload.clone())]);

    let mut reader = BlockReaderGCZ::new(Box::new(gcz)).expect("GCZ opens");
    let mut out = vec![0u8; SECTOR_SIZE];
    let block = reader.read_block(&mut out, 0).expect("stored block");
    assert_eq!(block.kind, BlockKind::Raw);
    assert_eq!(out, payload);
}

#[test]
fn block_reader_rejects_a_block_whose_checksum_does_not_match() {
    let mut gcz = write_gcz(build_gamecube_iso(), DEFAULT_BLOCK_SIZE);
    let header = gcz_header(&gcz);
    let data_offset = size_of::<GCZHeader>() + header.block_count.get() as usize * 12;
    gcz[data_offset] ^= 0xFF;

    let mut reader = BlockReaderGCZ::new(Box::new(gcz)).expect("GCZ opens");
    let mut out = vec![0u8; DEFAULT_BLOCK_SIZE as usize];
    let error = reader
        .read_block(&mut out, 0)
        .expect_err("the first block is corrupt");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("checksum mismatch"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_rejects_a_compressed_block_larger_than_the_block_size() {
    let block_size = SECTOR_SIZE as u32;
    let gcz = hand_built_gcz(
        block_size,
        SECTOR_SIZE as u64,
        &[(false, vec![0u8; SECTOR_SIZE + 1])],
    );

    let mut reader = BlockReaderGCZ::new(Box::new(gcz)).expect("GCZ opens");
    let mut out = vec![0u8; SECTOR_SIZE];
    let error = reader
        .read_block(&mut out, 0)
        .expect_err("the block claims to be too large");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("Compressed block size exceeds block size"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_rejects_a_stored_block_that_is_not_exactly_one_block() {
    let block_size = SECTOR_SIZE as u32;
    let gcz = hand_built_gcz(
        block_size,
        SECTOR_SIZE as u64,
        &[(true, vec![0u8; SECTOR_SIZE / 2])],
    );

    let mut reader = BlockReaderGCZ::new(Box::new(gcz)).expect("GCZ opens");
    let mut out = vec![0u8; SECTOR_SIZE];
    let error = reader
        .read_block(&mut out, 0)
        .expect_err("a stored block must be a full block");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("Uncompressed block size does not match block size"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_rejects_a_block_that_decompresses_to_the_wrong_length() {
    let block_size = SECTOR_SIZE as u32;
    // A valid deflate stream, but it expands to 16 bytes rather than a block.
    let gcz = hand_built_gcz(
        block_size,
        SECTOR_SIZE as u64,
        &[(false, zlib_stream(&[0x42u8; 16]))],
    );

    let mut reader = BlockReaderGCZ::new(Box::new(gcz)).expect("GCZ opens");
    let mut out = vec![0u8; SECTOR_SIZE];
    let error = reader
        .read_block(&mut out, 0)
        .expect_err("the block is short");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("decompression failed"),
        "unexpected message: {error}"
    );
}

#[test]
fn block_reader_clone_gets_its_own_scratch_buffer() {
    let gcz = write_gcz(build_gamecube_iso(), DEFAULT_BLOCK_SIZE);
    let reader = BlockReaderGCZ::new(Box::new(gcz)).expect("GCZ opens");
    let mut clone = reader.clone();

    let mut out = vec![0u8; DEFAULT_BLOCK_SIZE as usize];
    let block = clone.read_block(&mut out, 0).expect("the clone can read");
    assert_eq!(block.kind, BlockKind::Raw);
    assert_eq!(clone.block_size(), DEFAULT_BLOCK_SIZE);
}
