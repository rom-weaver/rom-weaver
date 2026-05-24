use std::{
    collections::HashSet,
    fs,
    io::Write,
    sync::{Arc, Mutex},
};

use super::{
    BlockCacheReader, ChunkPlanner, OrderedChunkWriter, SharedBlockCacheReader, TempPathAllocator,
    bounded_items_for_threads,
};

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
