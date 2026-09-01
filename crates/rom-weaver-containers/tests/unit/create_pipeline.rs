//! Unit coverage for the rust-only CHD create pipeline
//! (`src/chd/create_pipeline.rs`): the uncompressed (store) writer, the
//! sequential and threaded compressed writers, hunk deduplication against the
//! output itself and against a parent image, and the geometry/codec
//! validation that guards all of them.

use super::*;

fn scratch_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rw-chd-create-pipeline-{}-{label}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

/// Deterministic pseudo-random bytes; xorshift keeps the payload
/// incompressible enough that the codecs take their real encode paths.
fn payload(len: usize, seed: u32) -> Vec<u8> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state & 0xff) as u8
        })
        .collect()
}

/// Streams a created CHD back to raw bytes so a create can be checked against
/// the payload it was built from.
fn read_back(path: &Path) -> Vec<u8> {
    let session = ChdReadSession::open(path, None).expect("open created chd");
    let mut out = Vec::new();
    session
        .stream_with_progress(1, None, |chunk| {
            out.extend_from_slice(chunk);
            Ok(())
        })
        .expect("stream created chd");
    out
}

fn hd_geometry() -> HdGeometry {
    HdGeometry {
        cylinders: 1,
        heads: 1,
        sectors: 8,
        bytes_per_sector: 512,
    }
}

// --- Uncompressed (store) create ---------------------------------------------

#[test]
fn create_uncompressed_rust_raw_round_trips_a_partial_final_hunk() {
    let dir = scratch_dir("store-raw");
    let source = payload(4096 * 5 + 100, 0x1234_5678);
    let input = dir.join("payload.bin");
    fs::write(&input, &source).expect("write payload");
    let output = dir.join("payload.chd");

    let reported = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let sink = reported.clone();
    let progress: Arc<dyn Fn(u64) + Send + Sync> = Arc::new(move |bytes| {
        sink.fetch_add(bytes, Ordering::Relaxed);
    });

    let handler = ChdContainerHandler;
    let header = handler
        .create_uncompressed_rust_raw(
            &input,
            &output,
            source.len() as u64,
            &ChdCreateKind::Raw,
            Some(&progress),
        )
        .expect("store-mode create");

    assert_eq!(header.version, 5);
    assert!(!header.compressed);
    assert_eq!(header.logical_bytes, source.len() as u64);
    assert_eq!(header.hunk_bytes, ChdContainerHandler::DEFAULT_HUNK_BYTES);
    assert_eq!(header.unit_bytes, 1);
    assert_eq!(header.hunk_count, 6, "the 100-byte tail needs a sixth hunk");
    assert_eq!(header.unit_count, source.len() as u64);
    assert_eq!(
        reported.load(Ordering::Relaxed),
        source.len() as u64,
        "progress must report every source byte exactly once"
    );

    assert_eq!(read_back(&output), source);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn create_uncompressed_rust_stream_handles_an_empty_source() {
    let dir = scratch_dir("store-empty");
    let output = dir.join("empty.chd");
    let handler = ChdContainerHandler;
    let header = handler
        .create_uncompressed_rust_stream(
            &mut Cursor::new(Vec::new()),
            "empty",
            &output,
            0,
            &ChdCreateKind::Raw,
            None,
        )
        .expect("store-mode create of an empty source");

    assert_eq!(header.hunk_count, 0);
    assert_eq!(header.logical_bytes, 0);
    assert!(read_back(&output).is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn create_uncompressed_rust_stream_writes_hard_disk_geometry() {
    let dir = scratch_dir("store-hd");
    let source = payload(512 * 16, 0x2222);
    let output = dir.join("disk.chd");
    let create_kind = ChdCreateKind::HardDisk(hd_geometry());

    let header = ChdContainerHandler
        .create_uncompressed_rust_stream(
            &mut Cursor::new(source.clone()),
            "disk",
            &output,
            source.len() as u64,
            &create_kind,
            None,
        )
        .expect("store-mode hard disk create");
    assert_eq!(header.unit_bytes, 512);
    assert_eq!(header.unit_count, 16);
    assert_eq!(read_back(&output), source);

    let session = ChdReadSession::open(&output, None).expect("open created chd");
    assert_eq!(session.media_kind(), ChdMediaKind::HardDisk);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn create_uncompressed_rust_stream_rejects_av_media() {
    let dir = scratch_dir("store-av");
    let create_kind = ChdCreateKind::Av(AvProfile {
        frame_bytes: 1024,
        fps: 30,
        fpsfrac: 0,
        width: 32,
        height: 32,
        interlaced: 0,
        channels: 2,
        sample_rate: 48_000,
    });
    let err = ChdContainerHandler
        .create_uncompressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 1024]),
            "av",
            &dir.join("av.chd"),
            1024,
            &create_kind,
            None,
        )
        .expect_err("av media has no store-mode rust writer");
    assert!(matches!(
        err,
        RomWeaverError::Unsupported(UnsupportedOp::ChdStoreModeOnly)
    ));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn create_uncompressed_rust_stream_rejects_degenerate_geometry() {
    let dir = scratch_dir("store-geometry");
    // A zero-byte sector makes `unit_bytes` zero, so no hunk/unit division is
    // possible.
    let create_kind = ChdCreateKind::HardDisk(HdGeometry {
        bytes_per_sector: 0,
        ..hd_geometry()
    });
    let err = ChdContainerHandler
        .create_uncompressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 512]),
            "disk",
            &dir.join("disk.chd"),
            512,
            &create_kind,
            None,
        )
        .expect_err("zero unit size must be rejected");
    assert!(
        err.to_string().contains("invalid CHD geometry"),
        "unexpected error: {err}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn create_uncompressed_rust_raw_reports_unreadable_inputs_and_outputs() {
    let dir = scratch_dir("store-io-errors");
    let handler = ChdContainerHandler;

    let err = handler
        .create_uncompressed_rust_raw(
            &dir.join("missing.bin"),
            &dir.join("out.chd"),
            0,
            &ChdCreateKind::Raw,
            None,
        )
        .expect_err("a missing input must not create an output");
    assert!(err.to_string().contains("failed to open"), "{err}");

    let err = handler
        .create_uncompressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 16]),
            "payload",
            &dir.join("no-such-dir").join("out.chd"),
            16,
            &ChdCreateKind::Raw,
            None,
        )
        .expect_err("an unwritable output path must be reported");
    assert!(err.to_string().contains("failed to create"), "{err}");

    // A source shorter than the declared logical size fails while reading.
    let err = handler
        .create_uncompressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 16]),
            "payload",
            &dir.join("short.chd"),
            8192,
            &ChdCreateKind::Raw,
            None,
        )
        .expect_err("a truncated source must be reported");
    assert!(err.to_string().contains("failed to read source"), "{err}");

    let _ = fs::remove_dir_all(&dir);
}

// --- Compressed create -------------------------------------------------------

fn codec_slots(codecs: &[ChdCodec]) -> [ChdCodec; CHD_MAX_COMPRESSORS] {
    let mut slots = [ChdCodec::NONE; CHD_MAX_COMPRESSORS];
    slots[..codecs.len()].copy_from_slice(codecs);
    slots
}

fn compressed_params<'a>(
    output: &'a Path,
    logical_bytes: u64,
    create_kind: &'a ChdCreateKind,
    codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
    thread_count: usize,
    parent_source: Option<&'a Path>,
) -> CompressedCreateParams<'a> {
    CompressedCreateParams {
        output,
        logical_bytes,
        create_kind,
        codecs,
        compression_level: 3,
        thread_count,
        parent_source,
        on_progress: None,
    }
}

#[test]
fn compressed_create_matches_between_the_sequential_and_threaded_paths() {
    let dir = scratch_dir("compressed-parity");
    let source = payload(4096 * 9 + 7, 0xABCD);
    let create_kind = ChdCreateKind::Raw;
    let codecs = codec_slots(&[ChdCodec::ZSTD]);

    let sequential = dir.join("sequential.chd");
    let threaded = dir.join("threaded.chd");
    let handler = ChdContainerHandler;
    for (output, threads) in [(&sequential, 1_usize), (&threaded, 4_usize)] {
        handler
            .create_compressed_rust_stream(
                &mut Cursor::new(source.clone()),
                "payload",
                compressed_params(
                    output,
                    source.len() as u64,
                    &create_kind,
                    codecs,
                    threads,
                    None,
                ),
            )
            .expect("compressed create");
    }

    // Byte-identical output between the two paths is the parity guarantee that
    // lets the pipeline pick a thread count freely.
    assert_eq!(
        fs::read(&sequential).expect("read sequential chd"),
        fs::read(&threaded).expect("read threaded chd"),
        "the threaded pipeline must emit the same bytes as the sequential one"
    );
    assert_eq!(read_back(&sequential), source);
    assert_eq!(read_back(&threaded), source);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compressed_create_reports_geometry_in_its_header() {
    let dir = scratch_dir("compressed-header");
    let source = payload(4096 * 3, 0x77);
    let output = dir.join("payload.chd");
    let create_kind = ChdCreateKind::Raw;
    let codecs = codec_slots(&[ChdCodec::ZSTD, ChdCodec::ZLIB]);

    let header = ChdContainerHandler
        .create_compressed_rust_stream(
            &mut Cursor::new(source.clone()),
            "payload",
            compressed_params(&output, source.len() as u64, &create_kind, codecs, 1, None),
        )
        .expect("compressed create");
    assert!(header.compressed);
    assert_eq!(header.hunk_count, 3);
    assert_eq!(header.compression, codecs);
    assert_eq!(read_back(&output), source);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compressed_create_deduplicates_repeated_hunks_within_one_image() {
    let dir = scratch_dir("compressed-selfref");
    // Four identical hunks: only the first is stored, the rest become
    // self-references in the v5 map.
    let hunk = payload(4096, 0x5150);
    let source = hunk.repeat(4);
    let unique = dir.join("unique.chd");
    let repeated = dir.join("repeated.chd");
    let create_kind = ChdCreateKind::Raw;
    let codecs = codec_slots(&[ChdCodec::ZSTD]);
    let handler = ChdContainerHandler;

    handler
        .create_compressed_rust_stream(
            &mut Cursor::new(hunk.clone()),
            "unique",
            compressed_params(&unique, hunk.len() as u64, &create_kind, codecs, 1, None),
        )
        .expect("single-hunk create");
    handler
        .create_compressed_rust_stream(
            &mut Cursor::new(source.clone()),
            "repeated",
            compressed_params(
                &repeated,
                source.len() as u64,
                &create_kind,
                codecs,
                1,
                None,
            ),
        )
        .expect("repeated-hunk create");

    assert_eq!(read_back(&repeated), source);
    let unique_len = fs::metadata(&unique).expect("stat unique").len();
    let repeated_len = fs::metadata(&repeated).expect("stat repeated").len();
    assert!(
        repeated_len < unique_len + 4096,
        "three duplicate hunks must cost map entries, not payload: {repeated_len} vs {unique_len}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compressed_create_rejects_codecs_the_media_cannot_use() {
    let dir = scratch_dir("compressed-codec-errors");
    let create_kind = ChdCreateKind::Raw;
    let handler = ChdContainerHandler;

    // CD codecs are only valid for disc media.
    let err = handler
        .create_compressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 4096]),
            "payload",
            compressed_params(
                &dir.join("bad-codec.chd"),
                4096,
                &create_kind,
                codec_slots(&[ChdCodec::CD_ZSTD]),
                1,
                None,
            ),
        )
        .expect_err("cd codecs are invalid for raw media");
    assert!(matches!(
        err,
        RomWeaverError::Unsupported(UnsupportedOp::ChdCodecInvalidForMedia { .. })
    ));

    let err = handler
        .create_compressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 4096]),
            "payload",
            compressed_params(
                &dir.join("no-codec.chd"),
                4096,
                &create_kind,
                [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
                1,
                None,
            ),
        )
        .expect_err("a compressed create needs at least one codec");
    assert!(
        err.to_string().contains("at least one codec"),
        "unexpected error: {err}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compressed_create_rejects_degenerate_geometry_and_unwritable_outputs() {
    let dir = scratch_dir("compressed-geometry");
    let handler = ChdContainerHandler;
    let bad_geometry = ChdCreateKind::HardDisk(HdGeometry {
        bytes_per_sector: 0,
        ..hd_geometry()
    });
    let err = handler
        .create_compressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 512]),
            "disk",
            compressed_params(
                &dir.join("disk.chd"),
                512,
                &bad_geometry,
                codec_slots(&[ChdCodec::ZSTD]),
                1,
                None,
            ),
        )
        .expect_err("zero unit size must be rejected");
    assert!(
        err.to_string().contains("invalid CHD geometry"),
        "unexpected error: {err}"
    );

    let raw = ChdCreateKind::Raw;
    let err = handler
        .create_compressed_rust_stream(
            &mut Cursor::new(vec![0_u8; 4096]),
            "payload",
            compressed_params(
                &dir.join("no-such-dir").join("out.chd"),
                4096,
                &raw,
                codec_slots(&[ChdCodec::ZSTD]),
                1,
                None,
            ),
        )
        .expect_err("an unwritable output path must be reported");
    assert!(err.to_string().contains("failed to create"), "{err}");

    let err = handler
        .create_compressed_rust_raw(
            &dir.join("missing.bin"),
            compressed_params(
                &dir.join("out.chd"),
                4096,
                &raw,
                codec_slots(&[ChdCodec::ZSTD]),
                1,
                None,
            ),
        )
        .expect_err("a missing input must be reported");
    assert!(err.to_string().contains("failed to open"), "{err}");

    let _ = fs::remove_dir_all(&dir);
}

// --- Differential create against a parent -------------------------------------

#[test]
fn compressed_create_reuses_parent_hunks_for_identical_data() {
    let dir = scratch_dir("parent-reuse");
    let source = payload(4096 * 6, 0x9911);
    let create_kind = ChdCreateKind::Raw;
    let codecs = codec_slots(&[ChdCodec::ZSTD]);
    let handler = ChdContainerHandler;

    let parent = dir.join("parent.chd");
    handler
        .create_compressed_rust_stream(
            &mut Cursor::new(source.clone()),
            "parent",
            compressed_params(&parent, source.len() as u64, &create_kind, codecs, 1, None),
        )
        .expect("parent create");

    let standalone = dir.join("standalone.chd");
    handler
        .create_compressed_rust_stream(
            &mut Cursor::new(source.clone()),
            "standalone",
            compressed_params(
                &standalone,
                source.len() as u64,
                &create_kind,
                codecs,
                1,
                None,
            ),
        )
        .expect("standalone create");

    let child = dir.join("child.chd");
    handler
        .create_compressed_rust_stream(
            &mut Cursor::new(source.clone()),
            "child",
            compressed_params(
                &child,
                source.len() as u64,
                &create_kind,
                codecs,
                1,
                Some(&parent),
            ),
        )
        .expect("differential create");

    assert!(
        fs::metadata(&child).expect("stat child").len()
            < fs::metadata(&standalone).expect("stat standalone").len(),
        "every hunk matches the parent, so the child stores only map entries"
    );
    assert_eq!(
        read_back_with_parent(&child, &parent),
        source,
        "the child must decode back to the original payload through its parent"
    );
    let _ = fs::remove_dir_all(&dir);
}

fn read_back_with_parent(path: &Path, parent: &Path) -> Vec<u8> {
    let session = ChdReadSession::open(path, Some(parent)).expect("open differential chd");
    let mut out = Vec::new();
    session
        .stream_with_progress(1, None, |chunk| {
            out.extend_from_slice(chunk);
            Ok(())
        })
        .expect("stream differential chd");
    out
}

/// `ParentReuseIndex` does not implement `Debug`, so `Result::expect_err` is
/// unavailable for the parent-index calls.
fn parent_index_err(result: Result<ParentReuseIndex>, context: &str) -> RomWeaverError {
    match result {
        Ok(_) => panic!("expected an error: {context}"),
        Err(err) => err,
    }
}

#[test]
fn load_parent_reuse_index_rejects_mismatched_parents() {
    let dir = scratch_dir("parent-mismatch");
    let source = payload(4096 * 2, 0x4242);
    let parent = dir.join("parent.chd");
    let handler = ChdContainerHandler;
    handler
        .create_uncompressed_rust_stream(
            &mut Cursor::new(source.clone()),
            "parent",
            &parent,
            source.len() as u64,
            &ChdCreateKind::Raw,
            None,
        )
        .expect("parent create");

    // The real geometry is unit 1 / hunk 4096.
    handler
        .load_parent_reuse_index(&parent, 1, ChdContainerHandler::DEFAULT_HUNK_BYTES)
        .expect("matching geometry");

    let err = parent_index_err(
        handler.load_parent_reuse_index(&parent, 2048, ChdContainerHandler::DEFAULT_HUNK_BYTES),
        "unit size mismatch",
    );
    assert!(err.to_string().contains("unit size"), "{err}");

    let err = parent_index_err(
        handler.load_parent_reuse_index(&parent, 1, 8192),
        "hunk size mismatch",
    );
    assert!(err.to_string().contains("hunk size"), "{err}");

    let err = parent_index_err(
        handler.load_parent_reuse_index(&dir.join("missing.chd"), 1, 4096),
        "missing parent",
    );
    assert!(
        err.to_string().contains("failed to open parent chd"),
        "{err}"
    );

    let _ = fs::remove_dir_all(&dir);
}

// --- Hunk hashing and payload selection ---------------------------------------

#[test]
fn hunk_hash_key_pairs_a_crc16_with_a_sha1() {
    let key = ChdContainerHandler::hunk_hash_key(b"123456789");
    assert_eq!(key.crc16, ChdContainerHandler::crc16_ibm3740(b"123456789"));
    assert_eq!(key.sha1.as_slice(), Sha1::digest(b"123456789").as_slice());

    // Distinct payloads must not collide on the combined key.
    assert_ne!(key, ChdContainerHandler::hunk_hash_key(b"12345678A"));
    assert_eq!(key, ChdContainerHandler::hunk_hash_key(b"123456789"));
}

#[test]
fn payload_selection_forces_compression_only_for_self_describing_codecs() {
    // HUFFMAN and AVHUFF payloads carry their own headers, so the writer must
    // keep the compressed form even when it is not smaller.
    assert!(ChdContainerHandler::force_compressed_payload_for_primary_codec(ChdCodec::HUFFMAN));
    assert!(ChdContainerHandler::force_compressed_payload_for_primary_codec(ChdCodec::AVHUFF));
    assert!(!ChdContainerHandler::force_compressed_payload_for_primary_codec(ChdCodec::ZSTD));

    let handler = ChdContainerHandler;
    assert!(handler.prefer_compressed_payload(ChdCodec::ZSTD, 10, 20));
    assert!(!handler.prefer_compressed_payload(ChdCodec::ZSTD, 20, 20));
    assert!(!handler.prefer_compressed_payload(ChdCodec::ZSTD, 30, 20));
    assert!(
        handler.prefer_compressed_payload(ChdCodec::HUFFMAN, 30, 20),
        "huffman keeps its compressed payload even when it grows"
    );
}

// --- record_pipeline_hunk ------------------------------------------------------

/// A `Write` that always fails, so the writer's I/O error mapping can be
/// exercised without an unwritable filesystem.
struct FailingWriter;

impl Write for FailingWriter {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("synthetic write failure"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Calls `record_pipeline_hunk` with fresh accumulators, returning them with
/// the call's result so each map-entry shape can be asserted in isolation.
fn record_one(
    output_file: &mut dyn Write,
    hash_key: HunkHashKey,
    payload: Vec<u8>,
    self_hunks: &mut HashMap<HunkHashKey, u64>,
    parent_hunks: Option<&HashMap<HunkHashKey, u64>>,
) -> (Result<()>, Vec<RustCompressedHunkEntry>, u64) {
    let mut entries = Vec::new();
    let mut current_offset = ChdContainerHandler::CHD_V5_HEADER_BYTES;
    let result = ChdContainerHandler.record_pipeline_hunk(
        output_file,
        PipelineHunkRecord {
            output: Path::new("out.chd"),
            entries: &mut entries,
            current_offset: &mut current_offset,
            self_hunks_by_hash: self_hunks,
            parent_hunks_by_hash: parent_hunks,
            hunk_index: 3,
            hash_key,
            compression_type: 0,
            payload,
        },
    );
    (result, entries, current_offset)
}

#[test]
fn record_pipeline_hunk_emits_self_and_parent_references() {
    let key = ChdContainerHandler::hunk_hash_key(b"hunk payload");
    let mut sink = Vec::new();

    // A hash already stored in this image becomes a self reference.
    let mut self_hunks = HashMap::from([(key, 7_u64)]);
    let (result, entries, offset) =
        record_one(&mut sink, key, vec![1, 2, 3], &mut self_hunks, None);
    result.expect("self reference");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].compression_type,
        ChdContainerHandler::CHD_V5_MAP_TYPE_SELF
    );
    assert_eq!(entries[0].offset, 7);
    assert_eq!(entries[0].length, 0);
    assert_eq!(offset, ChdContainerHandler::CHD_V5_HEADER_BYTES);
    assert!(sink.is_empty(), "a reference stores no payload bytes");

    // A hash only present in the parent becomes a parent reference.
    let parent_hunks = HashMap::from([(key, 11_u64)]);
    let mut self_hunks = HashMap::new();
    let (result, entries, _) = record_one(
        &mut sink,
        key,
        vec![1, 2, 3],
        &mut self_hunks,
        Some(&parent_hunks),
    );
    result.expect("parent reference");
    assert_eq!(
        entries[0].compression_type,
        ChdContainerHandler::CHD_V5_MAP_TYPE_PARENT
    );
    assert_eq!(entries[0].offset, 11);
    assert!(sink.is_empty());
}

#[test]
fn record_pipeline_hunk_stores_a_new_payload_and_advances_the_offset() {
    let key = ChdContainerHandler::hunk_hash_key(b"fresh hunk");
    let mut sink = Vec::new();
    let mut self_hunks = HashMap::new();
    let payload = vec![9_u8; 40];
    let (result, entries, offset) =
        record_one(&mut sink, key, payload.clone(), &mut self_hunks, None);
    result.expect("stored hunk");

    assert_eq!(sink, payload);
    assert_eq!(entries[0].length, 40);
    assert_eq!(entries[0].crc16, key.crc16);
    assert_eq!(entries[0].offset, ChdContainerHandler::CHD_V5_HEADER_BYTES);
    assert_eq!(offset, ChdContainerHandler::CHD_V5_HEADER_BYTES + 40);
    assert_eq!(
        self_hunks.get(&key),
        Some(&3_u64),
        "a stored hunk registers its own index for later self references"
    );
}

#[test]
fn record_pipeline_hunk_rejects_a_payload_past_the_v5_map_limit() {
    let key = ChdContainerHandler::hunk_hash_key(b"huge");
    let mut self_hunks = HashMap::new();
    // The v5 map stores each chunk length in 24 bits.
    let payload = vec![0_u8; 0x0100_0000];
    let (result, entries, _) = record_one(&mut Vec::new(), key, payload, &mut self_hunks, None);
    let err = result.expect_err("an oversized chunk must be refused");
    assert!(
        err.to_string().contains("exceeds v5 map limit"),
        "unexpected error: {err}"
    );
    assert!(entries.is_empty(), "no map entry is emitted for a refusal");
}

#[test]
fn record_pipeline_hunk_reports_a_failed_payload_write() {
    let key = ChdContainerHandler::hunk_hash_key(b"unwritable");
    let mut self_hunks = HashMap::new();
    let (result, _, _) = record_one(
        &mut FailingWriter,
        key,
        vec![1, 2, 3, 4],
        &mut self_hunks,
        None,
    );
    let err = result.expect_err("a failed write must surface");
    assert!(
        err.to_string().contains("failed to write CHD data"),
        "unexpected error: {err}"
    );
}
