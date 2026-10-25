use std::{
    collections::HashSet,
    fs,
    io::{self, ErrorKind, Read, Write},
    sync::{Arc, Mutex},
};

use super::{
    BlockCacheReader, ChunkPlanner, OrderedChunkWriter, OrderedStreamingMessages,
    SharedBlockCacheReader, StagedOutput, TempPathAllocator, bounded_items_for_threads,
    copy_file_retrying_interrupted, copy_file_retrying_with, copy_retrying_interrupted,
    create_extract_output_file, ensure_output_available, file_starts_with,
    ordered_streaming_compress, read_full, read_up_to, retry_interrupted,
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
fn private_temp_allocator_removes_its_whole_root_and_leaves_siblings() {
    let parent = io_temp_path("private-parent");
    fs::create_dir_all(&parent).expect("parent");
    let sibling = parent.join("rom-weaver-out-other");
    fs::create_dir_all(&sibling).expect("sibling run");
    let root;
    {
        let allocator = TempPathAllocator::new_private(&parent, "rom-weaver-out");
        root = allocator.root().to_path_buf();
        assert_ne!(root, sibling);
        let temp_path = allocator.next_path("scratch", Some("tmp"));
        fs::create_dir_all(temp_path.parent().expect("namespace parent")).expect("namespace");
        fs::write(&temp_path, b"scratch").expect("write");
        assert!(root.exists());
    }
    assert!(!root.exists(), "the private root is removed on drop");
    assert!(sibling.exists(), "another run's directory is untouched");
    let _ = fs::remove_dir_all(&parent);
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
fn ensure_output_available_handles_new_existing_and_forced_outputs() {
    let root = io_temp_path("ensure-output");
    fs::create_dir_all(&root).expect("create root");
    let existing = root.join("existing.bin");
    fs::write(&existing, b"old").expect("seed output");

    let refusal = ensure_output_available(&existing, false)
        .expect_err("an existing output must be refused without force");
    assert!(
        refusal
            .to_string()
            .starts_with("validation failed: refusing to overwrite existing output `"),
        "{refusal}"
    );
    ensure_output_available(&existing, true).expect("force allows an existing output");

    let new_output = root.join("new.bin");
    ensure_output_available(&new_output, false).expect("a new output is available");
    fs::write(&new_output, b"partial").expect("write partial output");
    // Mark this output complete before cleaning the fixture. This removes only
    // this test's registry entry and cannot delete a file another test owns.
    crate::complete_in_progress_output(&new_output);
    assert!(
        new_output.exists(),
        "completing an output must preserve the finished file"
    );

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn file_starts_with_distinguishes_matching_short_and_missing_sources() {
    let root = io_temp_path("signature");
    fs::create_dir_all(&root).expect("create root");
    let source = root.join("source.bin");
    fs::write(&source, b"RWFP1 payload").expect("write source");

    assert!(file_starts_with(&source, b"RWFP1"));
    assert!(file_starts_with(&source, b""));
    assert!(!file_starts_with(&source, b"WRONG"));

    let short = root.join("short.bin");
    fs::write(&short, b"abc").expect("write short source");
    assert!(!file_starts_with(&short, b"abcdef"));
    assert!(!file_starts_with(&root.join("missing.bin"), b"abc"));

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

/// Reader that fails its first call with `Interrupted`, then hands out at most `step` bytes
/// per call - the two ways a single `read` can fall short of a full buffer.
struct InterruptedShortReader {
    data: Vec<u8>,
    position: usize,
    step: usize,
    interrupted: bool,
}

impl InterruptedShortReader {
    fn new(data: &[u8], step: usize) -> Self {
        Self {
            data: data.to_vec(),
            position: 0,
            step,
            interrupted: false,
        }
    }
}

impl Read for InterruptedShortReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.interrupted {
            self.interrupted = true;
            return Err(ErrorKind::Interrupted.into());
        }
        let len = buf
            .len()
            .min(self.step)
            .min(self.data.len() - self.position);
        buf[..len].copy_from_slice(&self.data[self.position..self.position + len]);
        self.position += len;
        Ok(len)
    }
}

#[test]
fn read_full_retries_interrupted_and_short_reads_until_full() {
    let data: Vec<u8> = (0..=99).collect();
    let mut reader = InterruptedShortReader::new(&data, 7);
    let mut buffer = [0u8; 64];
    assert_eq!(read_full(&mut reader, &mut buffer).expect("first fill"), 64);
    assert_eq!(buffer, data[..64]);
    assert_eq!(read_full(&mut reader, &mut buffer).expect("tail"), 36);
    assert_eq!(buffer[..36], data[64..]);
    assert_eq!(read_full(&mut reader, &mut buffer).expect("eof"), 0);
}

#[test]
fn read_up_to_retries_interrupted_and_short_reads_until_full() {
    let data: Vec<u8> = (0..=99).collect();
    let bytes = read_up_to(InterruptedShortReader::new(&data, 7), 64).expect("read");
    assert_eq!(bytes, data[..64]);
}

#[test]
fn read_up_to_stops_at_end_of_input() {
    let data: Vec<u8> = (0..20).collect();
    let bytes = read_up_to(InterruptedShortReader::new(&data, 7), 64).expect("read");
    assert_eq!(bytes, data);
}

#[test]
fn block_cache_reader_returns_partial_last_block() {
    let temp_dir = std::env::temp_dir().join(format!(
        "rom-weaver-io-partial-block-{}",
        std::process::id()
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    let temp_file = temp_dir.join("input.bin");
    let data: Vec<u8> = (0..40).collect();
    fs::write(&temp_file, &data).expect("write");
    let mut reader = BlockCacheReader::open(&temp_file, 16, 2).expect("reader");
    assert_eq!(reader.read_vec_at(30, 10).expect("tail read"), data[30..]);
    assert!(reader.read_vec_at(36, 8).is_err());
    let _ = fs::remove_dir_all(&temp_dir);
}

/// The interrupting reader hits `io::copy`'s generic path, which retries reader `Interrupted`
/// itself; only the Linux kernel-copy path surfaces it. This checks the wrapper passes every
/// byte through unchanged.
#[test]
fn copy_retrying_interrupted_copies_all_bytes() {
    let data: Vec<u8> = (0..=255).cycle().take(10_000).collect();
    let mut output = Vec::new();
    copy_retrying_interrupted(&mut InterruptedShortReader::new(&data, 333), &mut output)
        .expect("copy");
    assert_eq!(output, data);
}

#[test]
fn retry_interrupted_reruns_an_interrupted_operation() {
    let mut calls = 0;
    let result = retry_interrupted(|| {
        calls += 1;
        if calls == 1 {
            Err(ErrorKind::Interrupted.into())
        } else {
            Ok(calls)
        }
    });
    assert_eq!(result.expect("retried"), 2);
}

#[test]
fn retry_interrupted_returns_other_errors_without_retrying() {
    let mut calls = 0;
    let error = retry_interrupted(|| -> io::Result<()> {
        calls += 1;
        Err(ErrorKind::NotFound.into())
    })
    .expect_err("not retried");
    assert_eq!(error.kind(), ErrorKind::NotFound);
    assert_eq!(calls, 1);
}

#[test]
fn copy_file_retrying_interrupted_copies_bytes_and_length() {
    let temp_dir =
        std::env::temp_dir().join(format!("rom-weaver-io-copy-file-{}", std::process::id()));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    let source = temp_dir.join("source.bin");
    let destination = temp_dir.join("destination.bin");
    let data: Vec<u8> = (0..=255).cycle().take(70_000).collect();
    fs::write(&source, &data).expect("write source");
    fs::write(&destination, vec![0xff; 100_000]).expect("write stale destination");
    let copied = copy_file_retrying_interrupted(&source, &destination).expect("copy");
    assert_eq!(copied, 70_000);
    assert_eq!(fs::read(&destination).expect("read destination"), data);
    let _ = fs::remove_dir_all(&temp_dir);
}

#[cfg(unix)]
#[test]
fn copy_file_retry_replaces_a_read_only_partial_destination() {
    use std::os::unix::fs::PermissionsExt;
    let temp_dir = std::env::temp_dir().join(format!(
        "rom-weaver-io-copy-retry-ro-{}",
        std::process::id()
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    let source = temp_dir.join("source.bin");
    let destination = temp_dir.join("destination.bin");
    fs::write(&source, b"read-only dump").expect("source");
    fs::set_permissions(&source, fs::Permissions::from_mode(0o444)).expect("chmod source");
    let _ = fs::remove_file(&destination);

    let mut calls = 0;
    let copied = copy_file_retrying_with(&source, &destination, |from, to| {
        calls += 1;
        if calls == 1 {
            // Mimic an interrupted first attempt that left a read-only destination behind.
            fs::write(to, b"partial").expect("partial destination");
            fs::set_permissions(to, fs::Permissions::from_mode(0o444)).expect("chmod partial");
            return Err(io::Error::from(ErrorKind::Interrupted));
        }
        fs::copy(from, to)
    })
    .expect("retry succeeds after removing the partial destination");

    assert_eq!(calls, 2);
    assert_eq!(copied, 14);
    assert_eq!(
        fs::read(&destination).expect("destination"),
        b"read-only dump"
    );
    let _ = fs::set_permissions(&destination, fs::Permissions::from_mode(0o644));
    let _ = fs::set_permissions(&source, fs::Permissions::from_mode(0o644));
    let _ = fs::remove_dir_all(&temp_dir);
}

struct FailingWriter;

impl Write for FailingWriter {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(ErrorKind::BrokenPipe, "closed"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn copy_cancelable_copies_all_bytes_across_blocks() {
    let input = vec![7_u8; 64 * 1024 * 2 + 5];
    let mut output = Vec::new();
    let copied = super::copy_cancelable(
        &mut input.as_slice(),
        &mut output,
        &crate::CancellationToken::new(),
    )
    .expect("copy");
    assert_eq!(copied, input.len() as u64);
    assert_eq!(output, input);
}

#[test]
fn copy_cancelable_stops_when_token_is_cancelled() {
    let token = crate::CancellationToken::new();
    token.cancel();
    let mut output = Vec::new();
    let error = super::copy_cancelable(&mut [1_u8, 2].as_slice(), &mut output, &token)
        .expect_err("cancelled");
    assert!(matches!(error, RomWeaverError::Cancelled));
    assert!(output.is_empty());
}

#[test]
fn copy_cancelable_reports_write_error_when_not_cancelled() {
    let error = super::copy_cancelable(
        &mut [1_u8].as_slice(),
        &mut FailingWriter,
        &crate::CancellationToken::new(),
    )
    .expect_err("write error");
    assert!(!matches!(error, RomWeaverError::Cancelled));
}

#[test]
fn copy_cancelable_prefers_cancellation_over_write_error() {
    struct CancelThenFail(crate::CancellationToken);
    impl Write for CancelThenFail {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            self.0.cancel();
            Err(io::Error::new(ErrorKind::BrokenPipe, "closed"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let token = crate::CancellationToken::new();
    let error = super::copy_cancelable(
        &mut [1_u8].as_slice(),
        &mut CancelThenFail(token.clone()),
        &token,
    )
    .expect_err("cancelled");
    assert!(matches!(error, RomWeaverError::Cancelled));
}

fn staged_siblings(dir: &std::path::Path) -> Vec<String> {
    fs::read_dir(dir)
        .expect("list dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.starts_with(".rw-partial-"))
        .collect()
}

#[test]
fn staged_output_writes_new_outputs_and_directories_in_place() {
    let root = io_temp_path("staged-in-place");
    fs::create_dir_all(&root).expect("create root");

    let fresh = root.join("fresh.7z");
    let staged = StagedOutput::new(&fresh).expect("stage a new output");
    assert!(!staged.is_staged());
    assert_eq!(staged.path(), fresh);
    staged.commit().expect("commit an in-place output");
    assert!(!fresh.exists(), "nothing is written for the caller");

    let dir = root.join("dir.7z");
    fs::create_dir_all(&dir).expect("create dir output");
    let staged = StagedOutput::new(&dir).expect("stage a directory");
    assert!(!staged.is_staged(), "only a regular file is replaced");
    drop(staged);
    assert!(dir.is_dir());
    assert!(staged_siblings(&root).is_empty());

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn staged_output_replaces_an_existing_file_only_on_commit() {
    if cfg!(target_arch = "wasm32") {
        return;
    }
    let root = io_temp_path("staged-commit");
    fs::create_dir_all(&root).expect("create root");
    let output = root.join("out.7z");
    fs::write(&output, b"old").expect("seed output");

    let staged = StagedOutput::new(&output).expect("stage over an existing file");
    assert!(staged.is_staged());
    assert_eq!(staged.path().parent(), Some(root.as_path()));
    assert_eq!(
        staged.path().file_name().and_then(|name| name.to_str()),
        Some(".rw-partial-out.7z")
    );
    fs::write(staged.path(), b"new").expect("write staged output");
    assert_eq!(fs::read(&output).expect("read original"), b"old");

    staged.commit().expect("commit");
    assert_eq!(fs::read(&output).expect("read replaced output"), b"new");
    assert!(staged_siblings(&root).is_empty());

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn dropping_a_staged_output_keeps_the_original() {
    if cfg!(target_arch = "wasm32") {
        return;
    }
    let root = io_temp_path("staged-drop");
    fs::create_dir_all(&root).expect("create root");
    let output = root.join("out.chd");
    fs::write(&output, b"old").expect("seed output");
    // Another file already holds the first sibling name; it must survive.
    let taken = root.join(".rw-partial-out.chd");
    fs::write(&taken, b"someone else's").expect("seed taken sibling");

    let staged = StagedOutput::new(&output).expect("stage over an existing file");
    assert_eq!(
        staged.path().file_name().and_then(|name| name.to_str()),
        Some(".rw-partial-1-out.chd")
    );
    fs::write(staged.path(), b"partial").expect("write staged output");
    drop(staged);

    assert_eq!(fs::read(&output).expect("read original"), b"old");
    assert_eq!(staged_siblings(&root), vec![".rw-partial-out.chd"]);
    assert_eq!(fs::read(&taken).expect("read taken"), b"someone else's");

    fs::remove_dir_all(&root).expect("cleanup");
}

#[cfg(unix)]
#[test]
fn staged_output_replaces_the_file_a_symlink_points_at() {
    let root = io_temp_path("staged-symlink");
    let store = root.join("store");
    let links = root.join("links");
    fs::create_dir_all(&store).expect("create store");
    fs::create_dir_all(&links).expect("create links");
    let target = store.join("out.rvz");
    fs::write(&target, b"old").expect("seed target");
    let link = links.join("out.rvz");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");

    let staged = StagedOutput::new(&link).expect("stage through a symlink");
    let store = fs::canonicalize(&store).expect("canonical store");
    assert_eq!(staged.path().parent(), Some(store.as_path()));
    fs::write(staged.path(), b"new").expect("write staged output");
    staged.commit().expect("commit");

    assert!(
        fs::symlink_metadata(&link)
            .expect("link metadata")
            .file_type()
            .is_symlink(),
        "the link stays a link"
    );
    assert_eq!(fs::read(&target).expect("read target"), b"new");

    fs::remove_dir_all(&root).expect("cleanup");
}

#[cfg(unix)]
#[test]
fn staged_output_keeps_the_replaced_files_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let root = io_temp_path("staged-mode");
    fs::create_dir_all(&root).expect("create root");
    let output = root.join("out.zip");
    fs::write(&output, b"old").expect("seed output");
    fs::set_permissions(&output, fs::Permissions::from_mode(0o640)).expect("chmod");

    let staged = StagedOutput::new(&output).expect("stage over an existing file");
    fs::write(staged.path(), b"new").expect("write staged output");
    staged.commit().expect("commit");

    let mode = fs::metadata(&output)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o640);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[cfg(unix)]
#[test]
fn staged_output_writes_in_place_when_no_sibling_can_replace_the_file() {
    use std::os::unix::fs::PermissionsExt;

    let root = io_temp_path("staged-fallback");
    fs::create_dir_all(&root).expect("create root");

    // A sibling name past the 255-byte limit cannot be created.
    let long = root.join(format!("{}.bin", "x".repeat(246)));
    fs::write(&long, b"old").expect("seed long name");
    assert!(!StagedOutput::new(&long).expect("stage").is_staged());

    // Root writes through permission bits, so these two cannot be checked as root.
    if crate::effective_ids().is_some_and(|(uid, _)| uid == 0) {
        fs::remove_dir_all(&root).expect("cleanup");
        return;
    }
    // A rename would replace a file the run could not write before.
    let read_only = root.join("read-only.zip");
    fs::write(&read_only, b"old").expect("seed read-only output");
    fs::set_permissions(&read_only, fs::Permissions::from_mode(0o444)).expect("chmod");
    assert!(!StagedOutput::new(&read_only).expect("stage").is_staged());

    // A writable file in a directory that takes no new names is still written in place.
    let locked_dir = root.join("locked");
    fs::create_dir_all(&locked_dir).expect("create locked dir");
    let in_locked = locked_dir.join("out.zip");
    fs::write(&in_locked, b"old").expect("seed output");
    fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o555)).expect("chmod");
    let staged = StagedOutput::new(&in_locked).expect("stage");
    assert!(!staged.is_staged());
    assert_eq!(staged.path(), in_locked);
    fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o755)).expect("restore");

    fs::remove_dir_all(&root).expect("cleanup");
}
