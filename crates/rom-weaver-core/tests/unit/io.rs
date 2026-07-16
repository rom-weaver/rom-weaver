use std::{
    collections::HashSet,
    fs,
    io::Write,
    sync::{Arc, Mutex},
};

use super::{
    BlockCacheReader, ChunkPlanner, OrderedChunkWriter, OrderedStreamingMessages,
    SharedBlockCacheReader, TempPathAllocator, bounded_items_for_threads,
    ordered_streaming_compress,
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
