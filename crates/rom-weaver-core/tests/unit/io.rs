use std::{
    collections::HashSet,
    fs,
    io::Write,
    sync::{Arc, Mutex},
};

use super::{
    BlockCacheReader, ChunkPlanner, OrderedChunkWriter, OrderedStreamingMessages,
    SharedBlockCacheReader, TempPathAllocator, bounded_items_for_threads,
    create_extract_output_file, ordered_streaming_compress,
};
use crate::RomWeaverError;

#[test]
fn chunk_planner_splits_ranges() {
    let planner = ChunkPlanner::new(4).expect("planner");
    let chunks = planner.plan(10);
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0].offset, 0);
    assert_eq!(chunks[0].len, 4);
    assert_eq!(chunks[1].offset, 4);
    assert_eq!(chunks[1].len, 4);
    assert_eq!(chunks[2].offset, 8);
    assert_eq!(chunks[2].len, 2);
}

#[test]
fn temp_paths_are_unique() {
    let allocator = TempPathAllocator::new(std::env::temp_dir().join("rom-weaver-tests"));
    let paths = (0..16)
        .map(|_| allocator.next_path("checksum stage", Some("tmp")))
        .collect::<Vec<_>>();
    let unique = paths.iter().collect::<HashSet<_>>();
    assert_eq!(paths.len(), unique.len());
    assert!(
        paths
            .iter()
            .all(|path| path.to_string_lossy().contains("checksum-stage"))
    );
}

#[test]
fn temp_allocator_drop_removes_namespace_directory() {
    let root = std::env::temp_dir().join(format!(
        "rom-weaver-tests-cleanup-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));

    let namespace_dir = {
        let allocator = TempPathAllocator::new(root.clone());
        let temp_path = allocator.next_path("cleanup", Some("tmp"));
        let namespace_dir = temp_path.parent().expect("namespace parent").to_path_buf();
        fs::create_dir_all(&namespace_dir).expect("create namespace dir");
        fs::write(&temp_path, b"cleanup").expect("write namespace file");
        assert!(namespace_dir.exists());
        namespace_dir
    };

    assert!(!namespace_dir.exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn bounded_items_scale_with_threads() {
    assert_eq!(bounded_items_for_threads(0), 2);
    assert_eq!(bounded_items_for_threads(1), 2);
    assert_eq!(bounded_items_for_threads(2), 4);
    assert_eq!(bounded_items_for_threads(6), 12);
}

#[test]
fn ordered_writer_flushes_in_order() {
    let mut writer = OrderedChunkWriter::new(Vec::new(), 4).expect("writer");
    writer.write_chunk(2, b"cc".to_vec()).expect("chunk 2");
    writer.write_chunk(0, b"aa".to_vec()).expect("chunk 0");
    writer.write_chunk(1, b"bb".to_vec()).expect("chunk 1");
    writer.write_chunk(3, b"dd".to_vec()).expect("chunk 3");
    let output = writer.finish().expect("finish");
    assert_eq!(output, b"aabbccdd");
}

#[test]
fn ordered_streaming_compress_collects_worker_results_in_task_order() {
    let tasks = [0usize, 1, 2, 3, 4, 5];
    let mut collected = Vec::new();

    ordered_streaming_compress(
        &tasks,
        3,
        OrderedStreamingMessages {
            worker_closed: "workers closed",
            result_closed: "results closed",
        },
        |_, task| Ok(*task),
        || (),
        |_, _, task| {
            if task % 2 == 0 {
                std::thread::yield_now();
            }
            Ok(task * 10)
        },
        |_, output| {
            collected.push(output);
            Ok(())
        },
    )
    .expect("pipeline");

    assert_eq!(collected, vec![0, 10, 20, 30, 40, 50]);
}

#[test]
fn ordered_streaming_compress_returns_collector_errors_without_deadlock() {
    let tasks = 0usize..64usize;
    let result = ordered_streaming_compress(
        tasks,
        4,
        OrderedStreamingMessages {
            worker_closed: "workers closed",
            result_closed: "results closed",
        },
        |_, task| Ok(task),
        || (),
        |_, _, task| Ok(task),
        |_, output| {
            if output == 2 {
                return Err(RomWeaverError::Validation("stop collecting".into()));
            }
            Ok(())
        },
    );

    let Err(RomWeaverError::Validation(message)) = result else {
        panic!("expected collector validation error");
    };
    assert_eq!(message, "stop collecting");
}

#[test]
fn ordered_streaming_compress_returns_worker_panics_without_deadlock() {
    let result = ordered_streaming_compress(
        0usize..8,
        3,
        OrderedStreamingMessages {
            worker_closed: "workers closed",
            result_closed: "results closed",
        },
        |_, task| Ok(task),
        || (),
        |_, _, task| {
            if task == 0 {
                panic!("test worker panic");
            }
            Ok(task)
        },
        |_, _| Ok(()),
    );

    let Err(RomWeaverError::Validation(message)) = result else {
        panic!("expected worker panic validation error");
    };
    assert_eq!(
        message,
        "ordered compression worker panicked while processing task 0"
    );
}

#[test]
fn ordered_streaming_compress_returns_worker_initialization_panics_without_deadlock() {
    let result = ordered_streaming_compress(
        0usize..8,
        3,
        OrderedStreamingMessages {
            worker_closed: "workers closed",
            result_closed: "results closed",
        },
        |_, task| Ok(task),
        || -> () { panic!("test worker initialization panic") },
        |_, _, task| Ok(task),
        |_, _| Ok(()),
    );

    let Err(RomWeaverError::Validation(message)) = result else {
        panic!("expected worker initialization panic validation error");
    };
    assert_eq!(
        message,
        "ordered compression worker panicked while initializing"
    );
}

#[test]
fn block_cache_reader_reads_across_block_boundaries() {
    let temp_file = std::env::temp_dir().join(format!(
        "rom-weaver-core-io-{}-{}.bin",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let mut file = fs::File::create(&temp_file).expect("create temp file");
    let mut payload = Vec::new();
    for value in 0u8..=127u8 {
        payload.push(value);
    }
    file.write_all(&payload).expect("write payload");
    file.flush().expect("flush payload");

    let mut reader = BlockCacheReader::open(&temp_file, 16, 2).expect("reader");
    let mut slice = vec![0u8; 20];
    reader.read_exact_at(10, &mut slice).expect("read");
    assert_eq!(slice, payload[10..30]);
    assert!(reader.watermark().max_bytes <= 32);

    fs::remove_file(&temp_file).expect("cleanup temp file");
}
#[test]
fn block_cache_reader_supports_cross_thread_reads() {
    let temp_file = std::env::temp_dir().join(format!(
        "rom-weaver-core-io-cross-thread-{}-{}.bin",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let payload = (0..=255u8).collect::<Vec<_>>();
    let mut file = fs::File::create(&temp_file).expect("create temp file");
    file.write_all(&payload).expect("write payload");
    file.flush().expect("flush payload");

    let reader = Arc::new(Mutex::new(
        BlockCacheReader::open(&temp_file, 16, 2).expect("reader"),
    ));
    let worker_reader = Arc::clone(&reader);
    let actual = std::thread::spawn(move || {
        let mut slice = vec![0u8; 31];
        let mut reader = worker_reader.lock().expect("reader lock");
        reader.read_exact_at(37, &mut slice).expect("read");
        slice
    })
    .join()
    .expect("worker");

    assert_eq!(actual, payload[37..68]);

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn shared_block_cache_reader_supports_parallel_reads() {
    let temp_file = std::env::temp_dir().join(format!(
        "rom-weaver-core-shared-io-{}-{}.bin",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let payload = (0..=255u8).cycle().take(4096).collect::<Vec<_>>();
    let mut file = fs::File::create(&temp_file).expect("create temp file");
    file.write_all(&payload).expect("write payload");
    file.flush().expect("flush payload");

    let reader = Arc::new(SharedBlockCacheReader::open(&temp_file, 64, 4).expect("reader"));
    let workers = (0..8)
        .map(|index| {
            let reader = Arc::clone(&reader);
            std::thread::spawn(move || {
                let offset = index * 97;
                let mut slice = vec![0u8; 113];
                reader
                    .read_exact_at(offset as u64, &mut slice)
                    .expect("read");
                (offset, slice)
            })
        })
        .collect::<Vec<_>>();

    for worker in workers {
        let (offset, slice) = worker.join().expect("worker");
        assert_eq!(slice, payload[offset..offset + 113]);
    }

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn shared_block_cache_reader_reuses_cached_blocks() {
    let temp_file = std::env::temp_dir().join(format!(
        "rom-weaver-core-shared-cache-{}-{}.bin",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let payload = (0..128u8).collect::<Vec<_>>();
    fs::write(&temp_file, &payload).expect("write payload");
    let reader = SharedBlockCacheReader::open(&temp_file, 64, 2).expect("reader");

    let mut first = [0u8; 8];
    reader.read_exact_at(8, &mut first).expect("prime cache");
    fs::remove_file(&temp_file).expect("remove source after cache fill");

    let mut cached = [0u8; 8];
    reader
        .read_exact_at(16, &mut cached)
        .expect("same block should be cached");
    assert_eq!(first, payload[8..16]);
    assert_eq!(cached, payload[16..24]);
    assert!(reader.read_exact_at(72, &mut cached).is_err());
}

fn io_temp_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "rom-weaver-core-io-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ))
}

#[test]
fn chunk_planner_rejects_a_zero_chunk_size_and_plans_nothing_for_an_empty_file() {
    let error = ChunkPlanner::new(0).expect_err("zero chunk size must fail");
    assert_eq!(
        error.to_string(),
        "validation failed: chunk size must be greater than zero"
    );

    let planner = ChunkPlanner::new(8).expect("planner");
    assert_eq!(planner.chunk_size(), 8);
    assert!(planner.plan(0).is_empty());
    let exact = planner.plan(16);
    assert_eq!(exact.len(), 2);
    assert_eq!(exact[1].index, 1);
    assert_eq!(exact[1].len, 8);
}

#[test]
fn create_extract_output_file_separates_overwrite_refusal_from_other_failures() {
    let root = io_temp_path("create-output");
    fs::create_dir_all(&root).expect("create root");
    let existing = root.join("taken.bin");
    fs::write(&existing, b"old").expect("seed output");

    // An existing file is an overwrite refusal the user can clear with --force.
    let refusal = create_extract_output_file(&existing, false)
        .map(|_| ())
        .expect_err("an existing output must be refused");
    assert!(
        matches!(&refusal, RomWeaverError::Validation(message)
            if message.starts_with("refusing to overwrite existing output `")),
        "{refusal}"
    );
    assert!(create_extract_output_file(&existing, true).is_ok());

    // A missing parent directory is NOT an overwrite refusal: reporting it as
    // one sends the user hunting for a file that was never there.
    let unreachable = root.join("absent-dir").join("out.bin");
    let error = create_extract_output_file(&unreachable, false)
        .map(|_| ())
        .expect_err("a missing parent must fail");
    assert!(
        matches!(&error, RomWeaverError::IoPath { op, path, .. }
            if *op == crate::IoOp::Create && path == &unreachable),
        "{error}"
    );
    assert!(
        create_extract_output_file(&unreachable, true).is_err(),
        "the overwrite path must fail on a missing parent too"
    );

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn ordered_streaming_compress_does_no_work_for_an_empty_task_list() {
    let mut collected = 0usize;
    ordered_streaming_compress(
        Vec::<usize>::new(),
        4,
        OrderedStreamingMessages {
            worker_closed: "workers closed",
            result_closed: "results closed",
        },
        |_, task| Ok(task),
        || panic!("no worker state may be built for zero tasks"),
        |_: &mut (), _, task: usize| Ok(task),
        |_, _| {
            collected += 1;
            Ok(())
        },
    )
    .expect("empty pipeline");
    assert_eq!(collected, 0);
}

/// Reports more tasks than it yields, which is exactly the `ExactSizeIterator`
/// contract violation the pipeline's early-end guard exists to catch.
struct ShortTaskIterator {
    remaining: usize,
    claimed: usize,
}

impl Iterator for ShortTaskIterator {
    type Item = usize;

    fn next(&mut self) -> Option<usize> {
        self.remaining = self.remaining.checked_sub(1)?;
        Some(self.remaining)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.claimed, Some(self.claimed))
    }
}

impl ExactSizeIterator for ShortTaskIterator {}

#[test]
fn ordered_streaming_compress_reports_a_task_iterator_that_ends_early() {
    let result = ordered_streaming_compress(
        ShortTaskIterator {
            remaining: 1,
            claimed: 8,
        },
        1,
        OrderedStreamingMessages {
            worker_closed: "workers closed",
            result_closed: "results closed",
        },
        |_, task| Ok(task),
        || (),
        |_, _, task| Ok(task),
        |_, _| Ok(()),
    );

    let Err(RomWeaverError::Validation(message)) = result else {
        panic!("expected an early-end validation error");
    };
    assert_eq!(
        message,
        "ordered compression pipeline task iterator ended early"
    );
}

#[test]
fn ordered_streaming_compress_returns_read_errors_without_deadlock() {
    let result = ordered_streaming_compress(
        0usize..32,
        4,
        OrderedStreamingMessages {
            worker_closed: "workers closed",
            result_closed: "results closed",
        },
        |index, task| {
            if index == 3 {
                return Err(RomWeaverError::Validation("stop reading".into()));
            }
            Ok(task)
        },
        || (),
        |_, _, task| Ok(task),
        |_, _| Ok(()),
    );

    let Err(RomWeaverError::Validation(message)) = result else {
        panic!("expected a reader validation error");
    };
    assert_eq!(message, "stop reading");
}

#[test]
fn ordered_writer_rejects_a_zero_reorder_window() {
    let error = OrderedChunkWriter::new(Vec::new(), 0)
        .map(|_| ())
        .expect_err("a zero reorder window must fail");
    assert_eq!(
        error.to_string(),
        "validation failed: ordered writer max_reorder_items must be greater than zero"
    );
}

#[test]
fn ordered_writer_refuses_to_buffer_past_the_reorder_window() {
    let mut writer = OrderedChunkWriter::new(Vec::new(), 2).expect("writer");
    writer.write_chunk(1, b"bb".to_vec()).expect("chunk 1");
    writer.write_chunk(2, b"cc".to_vec()).expect("chunk 2");
    let error = writer
        .write_chunk(3, b"dd".to_vec())
        .expect_err("a fourth pending chunk must exceed the window");
    assert_eq!(
        error.to_string(),
        "validation failed: ordered writer exceeded max reorder window: 3 > 2"
    );
}

#[test]
fn ordered_writer_refuses_to_finish_with_a_gap() {
    let mut writer = OrderedChunkWriter::new(Vec::new(), 4).expect("writer");
    writer.write_chunk(0, b"aa".to_vec()).expect("chunk 0");
    writer.write_chunk(2, b"cc".to_vec()).expect("chunk 2");
    // Chunk 0 flushed straight through and released its bytes; chunk 2 is still
    // pending because chunk 1 never arrived.
    assert_eq!(writer.watermark().current_bytes, 2);
    assert_eq!(writer.watermark().max_bytes, 2);
    let error = writer
        .finish()
        .map(|_| ())
        .expect_err("an unresolved gap must fail");
    assert_eq!(
        error.to_string(),
        "validation failed: ordered writer finished with unresolved chunk gaps"
    );
}

#[test]
fn block_cache_reader_validates_its_options() {
    let temp_file = io_temp_path("validate-options.bin");
    fs::write(&temp_file, b"payload").expect("write payload");

    for (block_size, max_blocks, expected) in [
        (
            0usize,
            4usize,
            "block cache block_size must be greater than zero",
        ),
        (16, 0, "block cache max_blocks must be greater than zero"),
    ] {
        let error = BlockCacheReader::open(&temp_file, block_size, max_blocks)
            .map(|_| ())
            .expect_err("invalid options must fail");
        assert_eq!(error.to_string(), format!("validation failed: {expected}"));
        let shared = SharedBlockCacheReader::open(&temp_file, block_size, max_blocks)
            .map(|_| ())
            .expect_err("invalid options must fail for the shared reader too");
        assert_eq!(shared.to_string(), format!("validation failed: {expected}"));
    }

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn block_cache_reader_reports_its_options_and_serves_short_and_vector_reads() {
    let temp_file = io_temp_path("options.bin");
    let payload = (0..128u8).collect::<Vec<_>>();
    fs::write(&temp_file, &payload).expect("write payload");

    let mut reader = BlockCacheReader::open(&temp_file, 32, 3).expect("reader");
    assert_eq!(reader.block_size(), 32);
    assert_eq!(reader.max_blocks(), 3);

    // An empty read touches no block at all.
    reader.read_exact_at(0, &mut []).expect("empty read");
    assert_eq!(reader.watermark().max_bytes, 0);

    assert_eq!(
        reader.read_vec_at(40, 24).expect("vec read"),
        payload[40..64]
    );

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn block_cache_readers_reject_reads_past_the_file() {
    let temp_file = io_temp_path("bounds.bin");
    let payload = (0..64u8).collect::<Vec<_>>();
    fs::write(&temp_file, &payload).expect("write payload");

    let mut reader = BlockCacheReader::open(&temp_file, 16, 2).expect("reader");
    let mut output = vec![0u8; 8];
    let error = reader
        .read_exact_at(60, &mut output)
        .expect_err("a read past the end must fail");
    assert_eq!(
        error.to_string(),
        "validation failed: read range exceeds file bounds (offset=60, len=8)"
    );
    assert!(reader.read_exact_at(u64::MAX, &mut output).is_err());

    let shared = SharedBlockCacheReader::open(&temp_file, 16, 2).expect("shared reader");
    let shared_error = shared
        .read_exact_at(60, &mut output)
        .expect_err("a read past the end must fail");
    assert_eq!(
        shared_error.to_string(),
        "validation failed: read range exceeds file bounds (offset=60, len=8)"
    );
    shared.read_exact_at(0, &mut []).expect("empty read");

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn block_cache_reader_evicts_the_least_recently_used_block() {
    let temp_file = io_temp_path("eviction.bin");
    let payload = (0..=255u8).collect::<Vec<_>>();
    fs::write(&temp_file, &payload).expect("write payload");

    let mut reader = BlockCacheReader::open(&temp_file, 32, 2).expect("reader");
    for block in 0..8u64 {
        let offset = block * 32;
        let slice = reader.read_vec_at(offset, 32).expect("read block");
        assert_eq!(slice, payload[offset as usize..offset as usize + 32]);
    }
    // Only `max_blocks` blocks stay resident (plus the one being inserted), so
    // memory does not grow with the file.
    assert!(
        reader.watermark().max_bytes <= 32 * 3,
        "watermark {:?}",
        reader.watermark()
    );
    assert!(reader.watermark().current_bytes <= 32 * 2);

    // A re-read of an evicted block reloads it and still returns the right bytes.
    assert_eq!(reader.read_vec_at(0, 32).expect("re-read"), payload[0..32]);

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn block_cache_reader_reports_a_source_that_shrank_after_it_was_opened() {
    let temp_file = io_temp_path("shrunk.bin");
    let payload = (0..128u8).collect::<Vec<_>>();
    fs::write(&temp_file, &payload).expect("write payload");

    let mut reader = BlockCacheReader::open(&temp_file, 32, 4).expect("reader");
    assert_eq!(
        reader.read_vec_at(0, 32).expect("first block"),
        payload[0..32]
    );

    // The bounds check uses the length captured at open, so a source truncated
    // afterwards fails inside the block load instead of silently short-reading.
    fs::write(&temp_file, b"tiny").expect("truncate payload");
    let error = reader
        .read_vec_at(96, 8)
        .map(|_| ())
        .expect_err("a shrunken source must fail");
    assert_eq!(
        error.to_string(),
        "validation failed: block cache attempted to read beyond file length at block index 3"
    );

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn block_cache_reader_bounds_check_survives_the_cross_thread_read_path() {
    let temp_file = io_temp_path("cross-thread-bounds.bin");
    let payload = (0..64u8).collect::<Vec<_>>();
    fs::write(&temp_file, &payload).expect("write payload");

    let reader = Arc::new(Mutex::new(
        BlockCacheReader::open(&temp_file, 16, 2).expect("reader"),
    ));
    let worker_reader = Arc::clone(&reader);
    let error = std::thread::spawn(move || {
        let mut output = vec![0u8; 8];
        let mut reader = worker_reader.lock().expect("reader lock");
        reader
            .read_exact_at(60, &mut output)
            .map(|_| ())
            .expect_err("a read past the end must fail off-thread too")
    })
    .join()
    .expect("worker");
    assert_eq!(
        error.to_string(),
        "validation failed: read range exceeds file bounds (offset=60, len=8)"
    );

    fs::remove_file(&temp_file).expect("cleanup temp file");
}

#[test]
fn temp_allocator_exposes_its_root_and_namespace_and_handles_extension_shapes() {
    let root = io_temp_path("allocator");
    let allocator = TempPathAllocator::new(root.clone());
    assert_eq!(allocator.root(), root.as_path());
    assert!(allocator.namespace().starts_with("rw-"));

    let namespace_dir = root.join(allocator.namespace());
    assert_eq!(
        allocator.next_path("stage", None),
        namespace_dir.join("stage-00000000")
    );
    // A leading dot is trimmed and an extension that is only dots is dropped.
    assert_eq!(
        allocator.next_path("stage", Some(".bin")),
        namespace_dir.join("stage-00000001.bin")
    );
    assert_eq!(
        allocator.next_path("stage", Some(".")),
        namespace_dir.join("stage-00000002")
    );
    // Anything outside [A-Za-z0-9-_] in the purpose becomes a hyphen.
    assert_eq!(
        allocator.next_path("a b/c.d", Some("tmp")),
        namespace_dir.join("a-b-c-d-00000003.tmp")
    );
}
