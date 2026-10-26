use std::{
    fs,
    io::{self, Cursor, Seek, SeekFrom, Write},
    sync::atomic::{AtomicUsize, Ordering},
};

use rom_weaver_core::{RomWeaverError, ThreadCapability};

use super::{
    PARALLEL_WRITE_CHUNK_BYTES, PreparedWrite, apply_batched_writes, parallel_write_batch_bytes,
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
