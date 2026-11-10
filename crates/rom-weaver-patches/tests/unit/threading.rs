use std::{
    fs,
    io::{self, Cursor, Seek, SeekFrom, Write},
    sync::atomic::{AtomicUsize, Ordering},
};

use rom_weaver_core::{CancellationToken, RomWeaverError, ThreadCapability};

use super::{
    PARALLEL_WRITE_CHUNK_BYTES, PreparedWrite, WholeWriteBatchOptions, apply_batched_whole_writes,
    apply_batched_writes, parallel_write_batch_bytes,
};
use crate::test_support::{TestDir, test_context_with_threads};

#[test]
fn oversized_records_flush_before_the_next_batch_is_prepared() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 2);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(2)))
        .expect("pool");
    let limit = parallel_write_batch_bytes(pool.size());
    let len = limit * 2 + 17;
    let output_path = temp.child("bounded.bin");
    let mut output = fs::File::create(&output_path).expect("output");
    apply_batched_writes(
        &mut output,
        &[len],
        Some(&pool),
        |&len| len,
        |_, range| {
            assert!(range.len() <= PARALLEL_WRITE_CHUNK_BYTES);
            let completed = (range.start / limit) * limit;
            assert!(fs::metadata(&output_path).expect("metadata").len() >= completed as u64);
            Ok(PreparedWrite {
                offset: range.start as u64,
                data: vec![0x5a; range.len()],
            })
        },
    )
    .expect("bounded apply");
    assert_eq!(fs::read(output_path).expect("output"), vec![0x5a; len]);
}

#[test]
fn batches_preserve_overlapping_record_order_and_empty_records() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 2);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(2)))
        .expect("pool");
    let len = parallel_write_batch_bytes(pool.size()) + 3;
    let output_path = temp.child("overlap.bin");
    let mut output = fs::File::create(&output_path).expect("output");
    let records = [(0, len, 1), (0, 0, 0), (1, len - 1, 2)];
    apply_batched_writes(
        &mut output,
        &records,
        Some(&pool),
        |record| record.1,
        |&(offset, _, byte), range| {
            Ok(PreparedWrite {
                offset: (offset + range.start) as u64,
                data: vec![byte; range.len()],
            })
        },
    )
    .expect("ordered apply");
    let bytes = fs::read(output_path).expect("output");
    assert_eq!(bytes.len(), len);
    assert_eq!(bytes[0], 1);
    assert!(bytes[1..].iter().all(|&byte| byte == 2));
}

#[test]
fn empty_records_still_validate_and_preparation_errors_stop_writes() {
    let temp = TestDir::new();
    let output_path = temp.child("failed.bin");
    let mut output = fs::File::create(&output_path).expect("output");
    output.write_all(b"unchanged").expect("fixture");
    let error = apply_batched_writes(
        &mut output,
        &[0],
        None,
        |&len| len,
        |_, range| {
            assert!(range.is_empty());
            Err(RomWeaverError::Validation("invalid empty record".into()))
        },
    )
    .expect_err("preparation must fail");
    assert!(error.to_string().contains("invalid empty record"));
    assert_eq!(fs::read(output_path).expect("output"), b"unchanged");
}

#[test]
fn batch_budget_uses_two_four_mebibyte_chunks_per_thread_and_saturates() {
    assert_eq!(PARALLEL_WRITE_CHUNK_BYTES, 4_194_304);
    assert_eq!(parallel_write_batch_bytes(0), 8_388_608);
    assert_eq!(parallel_write_batch_bytes(1), 8_388_608);
    assert_eq!(parallel_write_batch_bytes(2), 16_777_216);
    assert_eq!(parallel_write_batch_bytes(4), 33_554_432);
    assert_eq!(parallel_write_batch_bytes(usize::MAX), usize::MAX);
}

struct ObservedBatches<'a> {
    output: Cursor<Vec<u8>>,
    pending_bytes: &'a AtomicUsize,
    batch_sizes: Vec<usize>,
}

impl Write for ObservedBatches<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let prepared = self.pending_bytes.swap(0, Ordering::SeqCst);
        if prepared > 0 {
            self.batch_sizes.push(prepared);
        }
        self.output.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for ObservedBatches<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.output.seek(position)
    }
}

fn assert_serial_batch_sizes(lengths: &[usize], expected_batches: &[usize]) {
    let pending_bytes = AtomicUsize::new(0);
    let mut output = ObservedBatches {
        output: Cursor::new(Vec::new()),
        pending_bytes: &pending_bytes,
        batch_sizes: Vec::new(),
    };
    let mut expected = Vec::new();
    let records: Vec<_> = lengths
        .iter()
        .enumerate()
        .map(|(index, &len)| {
            let offset = expected.len();
            let byte = (index + 1) as u8;
            expected.resize(offset + len, byte);
            (offset, len, byte)
        })
        .collect();
    apply_batched_writes(
        &mut output,
        &records,
        None,
        |record| record.1,
        |&(offset, _, byte), range| {
            assert!(range.len() <= 4_194_304);
            let pending = pending_bytes.fetch_add(range.len(), Ordering::SeqCst) + range.len();
            assert!(
                pending <= 8_388_608,
                "prepared {pending} bytes before writing"
            );
            Ok(PreparedWrite {
                offset: (offset + range.start) as u64,
                data: vec![byte; range.len()],
            })
        },
    )
    .expect("batched writes");
    assert_eq!(pending_bytes.load(Ordering::SeqCst), 0);
    assert_eq!(output.batch_sizes, expected_batches);
    assert_eq!(output.output.into_inner(), expected);
}

#[test]
fn records_at_the_budget_flush_only_before_the_next_byte() {
    assert_serial_batch_sizes(&[4_194_304, 4_194_304, 1], &[8_388_608, 1]);
    assert_serial_batch_sizes(&[4_194_303, 4_194_305, 1], &[8_388_608, 1]);
}

#[test]
fn single_record_crosses_the_budget_with_exact_piece_offsets() {
    assert_serial_batch_sizes(&[8_388_608], &[8_388_608]);
    assert_serial_batch_sizes(&[8_388_609], &[8_388_608, 1]);
    assert_serial_batch_sizes(&[12_582_913], &[8_388_608, 4_194_305]);
}

#[test]
fn empty_record_at_the_full_budget_does_not_force_a_flush() {
    assert_serial_batch_sizes(&[8_388_608, 0, 1], &[8_388_608, 1]);
}

fn assert_whole_batch_sizes(lengths: &[usize], expected_batches: &[usize]) {
    let pending_bytes = AtomicUsize::new(0);
    let mut output = ObservedBatches {
        output: Cursor::new(Vec::new()),
        pending_bytes: &pending_bytes,
        batch_sizes: Vec::new(),
    };
    let mut expected = Vec::new();
    let records: Vec<_> = lengths
        .iter()
        .enumerate()
        .map(|(index, &len)| {
            let offset = expected.len();
            let byte = (index + 1) as u8;
            expected.resize(offset + len, byte);
            (offset, len, byte)
        })
        .collect();
    apply_batched_whole_writes(
        &mut output,
        &records,
        WholeWriteBatchOptions {
            pool: None,
            effective_threads: 1,
            memory_len: &|_| 0,
            fixed_memory_bytes: 0,
            cancel: &CancellationToken::new(),
            write_len: |record| record.1,
        },
        |&(offset, len, byte), _buffer| {
            pending_bytes.fetch_add(len, Ordering::SeqCst);
            Ok(PreparedWrite {
                offset: offset as u64,
                data: vec![byte; len],
            })
        },
    )
    .expect("whole writes");
    assert_eq!(output.batch_sizes, expected_batches);
    assert_eq!(output.output.into_inner(), expected);
}

#[test]
fn written_buffers_are_reused_only_when_large_enough() {
    let spares = super::SpareBuffers::default();
    let written = Vec::<u8>::with_capacity(64);
    let written_ptr = written.as_ptr();
    spares.put(written);
    assert_eq!(spares.0.lock().expect("spares").len(), 1);

    let reused = spares.take(64);
    assert_eq!(reused.as_ptr(), written_ptr);
    assert!(reused.is_empty());
    assert!(reused.capacity() >= 64);

    spares.put(reused);
    let grown = spares.take(128);
    assert!(grown.capacity() >= 128);
}

#[test]
fn whole_records_are_written_and_released_immediately_when_serial() {
    assert_whole_batch_sizes(&[5_242_880, 3_145_728, 1], &[5_242_880, 3_145_728, 1]);
    assert_whole_batch_sizes(&[5_242_880, 3_145_729], &[5_242_880, 3_145_729]);
    assert_whole_batch_sizes(&[9_000_000, 1], &[9_000_000, 1]);
}

#[test]
fn whole_record_preparation_errors_stop_later_batches() {
    let mut output = Cursor::new(Vec::new());
    let records = [8_388_608usize, 1];
    let error = apply_batched_whole_writes(
        &mut output,
        &records,
        WholeWriteBatchOptions {
            pool: None,
            effective_threads: 1,
            memory_len: &|_| 0,
            fixed_memory_bytes: 0,
            cancel: &CancellationToken::new(),
            write_len: |&len| len,
        },
        |&len, _buffer| {
            if len == 1 {
                return Err(RomWeaverError::Validation("second batch".into()));
            }
            Ok(PreparedWrite {
                offset: 0,
                data: vec![1; len],
            })
        },
    )
    .expect_err("second batch fails");
    assert!(error.to_string().contains("second batch"));
    assert_eq!(output.into_inner().len(), 8_388_608);
}

struct CallerWriter<F> {
    output: Cursor<Vec<u8>>,
    caller: std::thread::ThreadId,
    writes: std::rc::Rc<std::cell::Cell<usize>>,
    before_write: F,
}

impl<F: FnMut(&[u8])> Write for CallerWriter<F> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        assert_eq!(std::thread::current().id(), self.caller);
        (self.before_write)(bytes);
        self.writes.set(self.writes.get() + 1);
        self.output.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<F> Seek for CallerWriter<F> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.output.seek(position)
    }
}

#[test]
fn slow_first_decode_and_blocked_caller_write_keep_all_slots_charged() {
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;
    for admitted in [1, 4, 16] {
        let temp = TestDir::new();
        // The shared operation pool may be larger than this handler's capability.
        let context = test_context_with_threads(&temp, 16);
        let (execution, pool) = context
            .build_pool(ThreadCapability::parallel(Some(admitted)))
            .expect("pool");
        let (started, starts) = mpsc::channel();
        let (release_decode, decode_gate) = mpsc::channel();
        let decode_gate = Mutex::new(decode_gate);
        let (writing, writes) = mpsc::channel();
        let (release_write, write_gate) = mpsc::channel();
        let coordinator = std::thread::spawn(move || {
            let caller = std::thread::current().id();
            let observed_writes = std::rc::Rc::new(std::cell::Cell::new(0));
            let mut next_write = 0;
            let mut output = CallerWriter {
                output: Cursor::new(Vec::new()),
                caller,
                writes: observed_writes.clone(),
                before_write: |bytes: &[u8]| {
                    assert_eq!(bytes, [next_write as u8]);
                    next_write += 1;
                    if bytes[0] == 0 {
                        writing.send(()).expect("writer reached");
                        write_gate
                            .recv_timeout(Duration::from_secs(3))
                            .expect("release writer");
                    }
                },
            };
            let records: Vec<_> = (0..(admitted * 3 + 1)).collect();
            apply_batched_whole_writes(
                &mut output,
                &records,
                WholeWriteBatchOptions {
                    pool: Some(&pool),
                    effective_threads: execution.effective_threads,
                    write_len: |_| 1,
                    memory_len: &|_| 1,
                    fixed_memory_bytes: 0,
                    cancel: &CancellationToken::new(),
                },
                |&index, _buffer| {
                    started.send(index).expect("started");
                    if index == 0 {
                        decode_gate
                            .lock()
                            .expect("gate")
                            .recv_timeout(Duration::from_secs(3))
                            .expect("release decoder");
                    }
                    Ok(PreparedWrite {
                        offset: index as u64,
                        data: vec![index as u8],
                    })
                },
            )
            .expect("stream");
            assert_eq!(observed_writes.get(), records.len());
            output.output.into_inner()
        });
        for _ in 0..admitted {
            starts
                .recv_timeout(Duration::from_secs(3))
                .expect("admitted decoder");
        }
        assert!(matches!(
            starts.recv_timeout(Duration::from_millis(40)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release_decode.send(()).expect("release decode");
        writes
            .recv_timeout(Duration::from_secs(3))
            .expect("writing");
        // A decoder finishing is insufficient to release its credit: the write still owns it.
        assert!(matches!(
            starts.recv_timeout(Duration::from_millis(40)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release_write.send(()).expect("release write");
        let bytes = coordinator.join().expect("caller completed");
        assert_eq!(
            bytes,
            (0..(admitted * 3 + 1))
                .map(|index| index as u8)
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn memory_admission_includes_pending_outputs_and_oversized_items_run_alone() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(4)))
        .expect("pool");
    let written = AtomicUsize::new(0);
    let prepared = AtomicUsize::new(0);
    let records = [6u64, 6, 100, 4, 4, 4];
    let mut output = CallerWriter {
        output: Cursor::new(Vec::new()),
        caller: std::thread::current().id(),
        writes: std::rc::Rc::new(std::cell::Cell::new(0)),
        before_write: |bytes: &[u8]| {
            written.fetch_add(bytes.len(), Ordering::SeqCst);
        },
    };
    super::WholeWritePipeline::new(
        &records,
        WholeWriteBatchOptions {
            pool: Some(&pool),
            effective_threads: 4,
            write_len: |_| 1,
            memory_len: &|&memory| memory,
            fixed_memory_bytes: 7,
            cancel: &CancellationToken::new(),
        },
        |memory, _buffer| {
            let index = prepared.fetch_add(1, Ordering::SeqCst);
            if *memory == 100 {
                assert_eq!(written.load(Ordering::SeqCst), 2);
            }
            if index < 2 {
                assert!(index - written.load(Ordering::SeqCst) < 1);
            }
            if index >= 3 {
                assert!(written.load(Ordering::SeqCst) >= 3);
            }
            Ok(PreparedWrite {
                offset: index as u64,
                data: vec![*memory as u8],
            })
        },
    )
    .run(
        &mut output,
        rom_weaver_core::parallel_heap_reserve(pool.size()) as u64 + 7 + 8,
    )
    .expect("memory bounded stream");
    assert_eq!(output.output.into_inner(), [6, 6, 100, 4, 4, 4]);
}

#[test]
fn completed_writes_recycle_both_budgets_across_repeated_parallel_admissions() {
    use std::{sync::mpsc, time::Duration};

    for memory_limited in [false, true] {
        let temp = TestDir::new();
        let context = test_context_with_threads(&temp, 4);
        let (_, pool) = context
            .build_pool(ThreadCapability::parallel(Some(4)))
            .expect("pool");
        let (started, starts) = mpsc::channel();
        let seen = std::sync::Mutex::new([false; 12]);
        let mut next_write = 0;
        let mut output = CallerWriter {
            output: Cursor::new(Vec::new()),
            caller: std::thread::current().id(),
            writes: std::rc::Rc::new(std::cell::Cell::new(0)),
            before_write: |bytes: &[u8]| {
                assert_eq!(bytes, [next_write as u8]);
                if next_write == 0 {
                    let mut first = [
                        starts
                            .recv_timeout(Duration::from_secs(3))
                            .expect("first decoder"),
                        starts
                            .recv_timeout(Duration::from_secs(3))
                            .expect("second decoder"),
                    ];
                    first.sort();
                    assert_eq!(first, [0, 1]);
                } else if next_write < 11 {
                    assert_eq!(
                        starts.recv_timeout(Duration::from_secs(3)).expect(
                            "recycled credit must admit the next decoder before this write finishes"
                        ),
                        next_write + 1,
                    );
                }
                assert!(
                    matches!(
                        starts.recv_timeout(Duration::from_millis(30)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ),
                    "the currently written item must retain its credit"
                );
                next_write += 1;
            },
        };
        let records: Vec<_> = (0usize..12).collect();
        super::WholeWritePipeline::new(
            &records,
            WholeWriteBatchOptions {
                pool: Some(&pool),
                effective_threads: 4,
                write_len: if memory_limited {
                    |_| 1
                } else {
                    |_| parallel_write_batch_bytes(4) / 2
                },
                memory_len: &|_| if memory_limited { 6 } else { 0 },
                fixed_memory_bytes: 0,
                cancel: &CancellationToken::new(),
            },
            |&index, _buffer| {
                let mut seen = seen.lock().expect("seen items");
                if std::mem::replace(&mut seen[index], true) {
                    return Err(RomWeaverError::Validation("item prepared twice".into()));
                }
                drop(seen);
                started.send(index).expect("observe decoder");
                Ok(PreparedWrite {
                    offset: index as u64,
                    data: vec![index as u8],
                })
            },
        )
        .run(
            &mut output,
            rom_weaver_core::parallel_heap_reserve(pool.size()) as u64 + 12,
        )
        .expect("repeated parallel writes");
        assert_eq!(output.output.into_inner(), (0u8..12).collect::<Vec<_>>());
    }
}

#[test]
fn unequal_whole_writes_keep_the_remaining_byte_credit() {
    use std::{sync::mpsc, time::Duration};

    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(4)))
        .expect("pool");
    let (started, starts) = mpsc::channel();
    let mut next_write = 0;
    let mut output = CallerWriter {
        output: Cursor::new(Vec::new()),
        caller: std::thread::current().id(),
        writes: std::rc::Rc::new(std::cell::Cell::new(0)),
        before_write: |bytes: &[u8]| {
            assert_eq!(bytes, [next_write as u8]);
            let expected: &[usize] = match next_write {
                0 => &[0, 1],
                1 => &[2, 3],
                2 => &[4, 5],
                _ => &[],
            };
            let mut admitted: Vec<_> = expected
                .iter()
                .map(|_| {
                    starts
                        .recv_timeout(Duration::from_secs(3))
                        .expect("decoder")
                })
                .collect();
            admitted.sort();
            assert_eq!(admitted, expected);
            assert!(
                matches!(
                    starts.recv_timeout(Duration::from_millis(30)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ),
                "remaining large write must retain its byte credit"
            );
            next_write += 1;
        },
    };
    apply_batched_whole_writes(
        &mut output,
        &[0usize, 1, 2, 3, 4, 5],
        WholeWriteBatchOptions {
            pool: Some(&pool),
            effective_threads: 4,
            write_len: |index| parallel_write_batch_bytes(4) / if *index < 2 { 2 } else { 4 },
            memory_len: &|_| 0,
            fixed_memory_bytes: 0,
            cancel: &CancellationToken::new(),
        },
        |&index, _buffer| {
            started.send(index).expect("observe decoder");
            Ok(PreparedWrite {
                offset: index as u64,
                data: vec![index as u8],
            })
        },
    )
    .expect("unequal writes");
    assert_eq!(output.output.into_inner(), [0, 1, 2, 3, 4, 5]);
}

#[test]
fn parallel_whole_writes_prepare_each_item_once_and_preserve_order() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(4)))
        .expect("pool");
    let seen = std::sync::Mutex::new([false; 17]);
    let records: Vec<_> = (0usize..17).collect();
    let mut output = Cursor::new(Vec::new());
    apply_batched_whole_writes(
        &mut output,
        &records,
        WholeWriteBatchOptions {
            pool: Some(&pool),
            effective_threads: 4,
            write_len: |_| 1,
            memory_len: &|_| 1,
            fixed_memory_bytes: 0,
            cancel: &CancellationToken::new(),
        },
        |&index, _buffer| {
            if std::mem::replace(&mut seen.lock().expect("seen items")[index], true) {
                return Err(RomWeaverError::Validation("item prepared twice".into()));
            }
            Ok(PreparedWrite {
                offset: index as u64,
                data: vec![index as u8],
            })
        },
    )
    .expect("exactly one preparation per item");
    assert_eq!(output.into_inner(), (0u8..17).collect::<Vec<_>>());
}

#[test]
fn whole_write_target_byte_limit_still_admits_oversized_items_only_alone() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(4)))
        .expect("pool");
    let pending = AtomicUsize::new(0);
    let mut output = ObservedBatches {
        output: Cursor::new(Vec::new()),
        pending_bytes: &pending,
        batch_sizes: Vec::new(),
    };
    let limit = parallel_write_batch_bytes(4);
    let records = [limit, limit + 1, limit];
    apply_batched_whole_writes(
        &mut output,
        &records,
        WholeWriteBatchOptions {
            pool: Some(&pool),
            effective_threads: 4,
            write_len: |&len| len,
            memory_len: &|_| 0,
            fixed_memory_bytes: 0,
            cancel: &CancellationToken::new(),
        },
        |&len, _buffer| {
            assert_eq!(pending.fetch_add(1, Ordering::SeqCst), 0);
            // Admission uses the estimate, avoiding large allocations in this concurrency test.
            Ok(PreparedWrite {
                offset: 0,
                data: vec![(len > limit) as u8],
            })
        },
    )
    .expect("oversized serial stream");
    assert_eq!(output.batch_sizes, [1, 1, 1]);
}

#[test]
fn nested_pool_whole_writes_fall_back_to_immediate_serial_writes() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(4)))
        .expect("pool");
    pool.install(|| {
        let caller = std::thread::current().id();
        let written = AtomicUsize::new(0);
        let mut output = CallerWriter {
            output: Cursor::new(Vec::new()),
            caller,
            writes: std::rc::Rc::new(std::cell::Cell::new(0)),
            before_write: |bytes: &[u8]| {
                written.fetch_add(bytes.len(), Ordering::SeqCst);
            },
        };
        apply_batched_whole_writes(
            &mut output,
            &[0usize, 1, 2, 3],
            WholeWriteBatchOptions {
                pool: Some(&pool),
                effective_threads: 4,
                write_len: |_| 1,
                memory_len: &|_| 1,
                fixed_memory_bytes: 0,
                cancel: &CancellationToken::new(),
            },
            |&index, _buffer| {
                assert_eq!(std::thread::current().id(), caller);
                assert_eq!(written.load(Ordering::SeqCst), index);
                Ok(PreparedWrite {
                    offset: index as u64,
                    data: vec![index as u8],
                })
            },
        )
        .expect("nested stream");
        assert_eq!(output.output.into_inner(), [0, 1, 2, 3]);
    });
}

#[test]
fn cancellation_after_decode_never_writes_prepared_data() {
    for threads in [1, 4] {
        let temp = TestDir::new();
        let context = test_context_with_threads(&temp, threads);
        let (_, pool) = context
            .build_pool(ThreadCapability::parallel(Some(threads)))
            .expect("pool");
        let cancel = CancellationToken::new();
        let mut output = Cursor::new(Vec::new());
        let error = apply_batched_whole_writes(
            &mut output,
            &[0usize, 1, 2, 3],
            WholeWriteBatchOptions {
                pool: Some(&pool),
                effective_threads: threads,
                write_len: |_| 1,
                memory_len: &|_| 1,
                fixed_memory_bytes: 0,
                cancel: &cancel,
            },
            |_, _buffer| {
                cancel.cancel();
                Ok(PreparedWrite {
                    offset: 0,
                    data: vec![1],
                })
            },
        )
        .expect_err("cancel after decode");
        assert!(matches!(error, RomWeaverError::Cancelled));
        assert!(output.into_inner().is_empty());
    }
}

#[test]
fn prepare_and_write_failures_join_workers_before_partial_output_removal() {
    use super::PartialOutput;
    use std::sync::Arc;
    struct FailureWriter {
        file: fs::File,
        fail: bool,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }
    impl Write for FailureWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail {
                return Err(io::Error::other("writer failed"));
            }
            self.file.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.file.flush()
        }
    }
    impl Seek for FailureWriter {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.file.seek(position)
        }
    }
    impl Drop for FailureWriter {
        fn drop(&mut self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }
    for threads in [1, 4] {
        for fail_write in [false, true] {
            let temp = TestDir::new();
            let context = test_context_with_threads(&temp, threads);
            let (_, pool) = context
                .build_pool(ThreadCapability::parallel(Some(threads)))
                .expect("pool");
            let path = temp.child("partial.bin");
            let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut output = PartialOutput::new(
                FailureWriter {
                    file: fs::File::create(&path).expect("file"),
                    fail: fail_write,
                    closed: closed.clone(),
                },
                &path,
            );
            let result = apply_batched_whole_writes(
                output.output(),
                &[0usize, 1, 2, 3],
                WholeWriteBatchOptions {
                    pool: Some(&pool),
                    effective_threads: threads,
                    write_len: |_| 1,
                    memory_len: &|_| 1,
                    fixed_memory_bytes: 0,
                    cancel: &CancellationToken::new(),
                },
                |_, _buffer| {
                    assert!(!closed.load(Ordering::SeqCst));
                    assert!(path.exists());
                    if !fail_write {
                        return Err(RomWeaverError::Validation("prepare failed".into()));
                    }
                    Ok(PreparedWrite {
                        offset: 0,
                        data: vec![1],
                    })
                },
            );
            let error = result.expect_err("expected failure");
            assert!(error.to_string().contains(if fail_write {
                "writer failed"
            } else {
                "prepare failed"
            }));
            drop(output);
            assert!(closed.load(Ordering::SeqCst));
            assert!(!path.exists());
        }
    }
}

#[test]
fn worker_and_writer_unwind_join_without_hanging_and_remove_partial_output() {
    use super::PartialOutput;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    struct PanicWriter(fs::File);
    impl Write for PanicWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            panic!("writer panic");
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Seek for PanicWriter {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.0.seek(position)
        }
    }
    for threads in [1, 4] {
        for worker_panic in [false, true] {
            let temp = TestDir::new();
            let context = test_context_with_threads(&temp, threads);
            let (_, pool) = context
                .build_pool(ThreadCapability::parallel(Some(threads)))
                .expect("pool");
            let path = temp.child("panic.bin");
            let result = catch_unwind(AssertUnwindSafe(|| {
                let mut output =
                    PartialOutput::new(PanicWriter(fs::File::create(&path).expect("file")), &path);
                apply_batched_whole_writes(
                    output.output(),
                    &[0usize, 1, 2, 3, 4, 5],
                    WholeWriteBatchOptions {
                        pool: Some(&pool),
                        effective_threads: threads,
                        write_len: |_| 1,
                        memory_len: &|_| 1,
                        fixed_memory_bytes: 0,
                        cancel: &CancellationToken::new(),
                    },
                    |&index, _buffer| {
                        assert!(path.exists(), "output removed before workers joined");
                        if worker_panic && index == 0 {
                            panic!("decoder panic");
                        }
                        Ok(PreparedWrite {
                            offset: index as u64,
                            data: vec![index as u8],
                        })
                    },
                )
                .expect("scope must propagate panic");
            }));
            let panic = result.expect_err("panic propagated");
            let message = panic
                .downcast_ref::<&str>()
                .copied()
                .expect("original panic");
            assert_eq!(
                message,
                if worker_panic {
                    "decoder panic"
                } else {
                    "writer panic"
                }
            );
            assert!(!path.exists());
        }
    }
}

#[test]
fn cancellation_during_positioning_is_checked_immediately_before_write() {
    struct CancelOnSeek {
        bytes: Cursor<Vec<u8>>,
        cancel: CancellationToken,
    }
    impl Write for CancelOnSeek {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Seek for CancelOnSeek {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.cancel.cancel();
            self.bytes.seek(position)
        }
    }
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(4)))
        .expect("pool");
    let cancel = CancellationToken::new();
    let mut output = CancelOnSeek {
        bytes: Cursor::new(Vec::new()),
        cancel: cancel.clone(),
    };
    let error = apply_batched_whole_writes(
        &mut output,
        &[0usize, 1, 2, 3],
        WholeWriteBatchOptions {
            pool: Some(&pool),
            effective_threads: 4,
            write_len: |_| 1,
            memory_len: &|_| 1,
            fixed_memory_bytes: 0,
            cancel: &cancel,
        },
        |&index, _buffer| {
            Ok(PreparedWrite {
                offset: index as u64,
                data: vec![index as u8],
            })
        },
    )
    .expect_err("cancel during seek");
    assert!(matches!(error, RomWeaverError::Cancelled));
    assert!(output.bytes.into_inner().is_empty());
}
