use std::{
    io,
    io::{BufRead, Read},
};

use bytes::{Bytes, BytesMut};
use dyn_clone::DynClone;

use crate::{
    Result, ResultContext,
    common::{PartitionInfo, PartitionKind},
    disc::{
        SECTOR_SIZE,
        reader::DiscReader,
        wii::{HASHES_SIZE, SECTOR_DATA_SIZE},
    },
    util::{aes::decrypt_sector_b2b, array_ref, array_ref_mut, lfg::LaggedFibonacci},
    write::{DataCallback, DiscFinalization, DiscWriterWeight, ProcessOptions},
};

/// A trait for writing disc images.
pub trait DiscWriter: DynClone {
    /// Processes the disc writer to completion.
    ///
    /// The data callback will be called, in order, for each block of data to write to the output
    /// file. The callback should write all data before returning, or return an error if writing
    /// fails.
    fn process(
        &self,
        data_callback: &mut DataCallback,
        options: &ProcessOptions,
    ) -> Result<DiscFinalization>;

    /// Returns the progress upper bound for the disc writer.
    ///
    /// For most formats, this has no relation to the written disc size, but can be used to display
    /// progress.
    fn progress_bound(&self) -> u64;

    /// Returns the weight of the disc writer.
    ///
    /// This can help determine the number of threads to dedicate for output processing, and may
    /// differ based on the format's configuration, such as whether compression is enabled.
    fn weight(&self) -> DiscWriterWeight;
}

dyn_clone::clone_trait_object!(DiscWriter);

#[derive(Default)]
pub struct BlockResult<T> {
    /// Input block index
    pub block_idx: u32,
    /// Input disc data (before processing)
    pub disc_data: Bytes,
    /// Output block data (after processing). If None, the disc data is used.
    pub block_data: Bytes,
    /// Output metadata
    pub meta: T,
}

pub trait BlockProcessor: Clone + Send {
    type BlockMeta;

    fn process_block(&mut self, block_idx: u32) -> io::Result<BlockResult<Self::BlockMeta>>;

    /// Whether this processor supports the read-on-main pipeline (`read_block_data` +
    /// `process_block_data`).
    ///
    /// In the browser/wasm runtime only the main runner thread can open OPFS files; spawned
    /// worker threads cannot `path_open` an OPFS-backed source (the open fails with `os error 44`).
    /// Processors that return `true` let `par_process` read source blocks on the main thread and
    /// run only the CPU-bound compression on worker threads.
    fn supports_read_on_main(&self) -> bool { false }

    /// Reads the raw disc bytes for `block_idx` on the main thread. Only called when
    /// [`supports_read_on_main`](Self::supports_read_on_main) returns `true`.
    fn read_block_data(&mut self, _block_idx: u32) -> io::Result<Bytes> {
        Err(io::Error::other("read_block_data is not supported by this block processor"))
    }

    /// Processes a block from pre-read disc bytes, performing no source reads. Only called when
    /// [`supports_read_on_main`](Self::supports_read_on_main) returns `true`.
    fn process_block_data(
        &mut self,
        block_idx: u32,
        _data: Bytes,
    ) -> io::Result<BlockResult<Self::BlockMeta>> {
        self.process_block(block_idx)
    }
}

pub fn read_block(reader: &mut DiscReader, block_size: usize) -> io::Result<(Bytes, Bytes)> {
    let initial_block = reader.fill_buf_internal()?;
    if initial_block.len() >= block_size {
        // Happy path: we have a full block that we can cheaply slice
        let data = initial_block.slice(0..block_size);
        reader.consume(block_size);
        return Ok((data.clone(), data));
    } else if initial_block.is_empty() {
        return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
    }
    reader.consume(initial_block.len());

    // Combine smaller blocks into a new buffer
    let mut buf = BytesMut::zeroed(block_size);
    let mut len = initial_block.len();
    buf[..len].copy_from_slice(initial_block.as_ref());
    drop(initial_block);
    while len < block_size {
        let read = reader.read(&mut buf[len..])?;
        if read == 0 {
            break;
        }
        len += read;
    }
    // The block data is full size, padded with zeroes
    let block_data = buf.freeze();
    // The disc data is the actual data read, without padding
    let disc_data = block_data.slice(0..len);
    Ok((block_data, disc_data))
}

/// Whether the parallel block pipeline must read source blocks on the calling (main) thread.
///
/// In the browser/wasm runtime only the main runner thread can open OPFS files, so the dedicated
/// reader/worker threads cannot read the source themselves. On native this is off (workers read
/// directly), with an env escape hatch (`NOD_READ_ON_MAIN=1`) to exercise the path in tests.
#[cfg(feature = "threading")]
fn read_on_main_enabled() -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        true
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::var("NOD_READ_ON_MAIN").as_deref() == Ok("1")
    }
}

/// Process blocks in parallel, ensuring that they are written in order.
#[cfg_attr(not(feature = "threading"), inline)]
pub(crate) fn par_process<P, T>(
    mut processor: P,
    block_count: u32,
    #[cfg(feature = "threading")] num_threads: usize,
    mut callback: impl FnMut(BlockResult<T>) -> Result<()>,
) -> Result<()>
where
    T: Send,
    P: BlockProcessor<BlockMeta = T>,
{
    #[cfg(feature = "threading")]
    if num_threads > 0 {
        if read_on_main_enabled() {
            // Browser/wasm: only the main thread can open OPFS files. Use the read-on-main
            // pipeline when the processor supports it; otherwise fall through to single-threaded
            // processing (which also reads on the calling/main thread) rather than letting worker
            // threads attempt OPFS opens.
            if processor.supports_read_on_main() {
                return par_process_read_on_main(processor, block_count, num_threads, callback);
            }
        } else {
            return par_process_worker_read(processor, block_count, num_threads, callback);
        }
    }

    // Fall back to single-threaded processing
    for block_idx in 0..block_count {
        let block = processor
            .process_block(block_idx)
            .with_context(|| format!("Failed to process block {block_idx}"))?;
        callback(block)?;
    }
    Ok(())
}

/// Native parallel pipeline: each worker thread reads its own source block and processes it, while
/// the main thread reorders and writes results. Requires worker threads to open the source, so it
/// is only used off-wasm.
#[cfg(feature = "threading")]
fn par_process_worker_read<P, T>(
    processor: P,
    block_count: u32,
    num_threads: usize,
    mut callback: impl FnMut(BlockResult<T>) -> Result<()>,
) -> Result<()>
where
    T: Send,
    P: BlockProcessor<BlockMeta = T>,
{
    std::thread::scope(|s| {
        use std::collections::VecDeque;

        use crate::Error;

        let (block_tx, block_rx) = crossbeam_channel::bounded(block_count as usize);
        for block_idx in 0..block_count {
            block_tx.send(block_idx).unwrap();
        }
        drop(block_tx); // Disconnect channel

        // Buffer one finished block per worker instead of a rendezvous (capacity 0).
        // With a rendezvous channel a worker that finishes a block blocks until the main
        // thread is ready to receive, so while the main thread is busy writing one block
        // every other worker stalls. Giving the channel `num_threads` slots lets each
        // worker drop its result and immediately pick up the next block, keeping all cores
        // saturated while the main thread reorders and writes. Memory stays bounded: at most
        // `num_threads` extra blocks (each <= chunk_size) are in flight.
        let (result_tx, result_rx) = crossbeam_channel::bounded(num_threads);

        // Spawn threads to process blocks
        for _ in 0..num_threads - 1 {
            let block_rx = block_rx.clone();
            let result_tx = result_tx.clone();
            let mut processor = processor.clone();
            s.spawn(move || {
                while let Ok(block_idx) = block_rx.recv() {
                    let result = processor
                        .process_block(block_idx)
                        .with_context(|| format!("Failed to process block {block_idx}"));
                    let failed = result.is_err(); // Stop processing if an error occurs
                    if result_tx.send(result).is_err() || failed {
                        break;
                    }
                }
            });
        }

        // Last iteration moves instead of cloning
        let mut processor = processor;
        s.spawn(move || {
            while let Ok(block_idx) = block_rx.recv() {
                let result = processor
                    .process_block(block_idx)
                    .with_context(|| format!("Failed to process block {block_idx}"));
                let failed = result.is_err(); // Stop processing if an error occurs
                if result_tx.send(result).is_err() || failed {
                    break;
                }
            }
        });

        // Main thread processes results
        let mut current_block = 0;
        let mut out_of_order = VecDeque::<BlockResult<T>>::new();
        while let Ok(result) = result_rx.recv() {
            let result = result?;
            if result.block_idx == current_block {
                callback(result)?;
                current_block += 1;
                // Check if any out of order blocks can be written
                while out_of_order.front().is_some_and(|r| r.block_idx == current_block) {
                    callback(out_of_order.pop_front().unwrap())?;
                    current_block += 1;
                }
            } else {
                // Insert sorted
                match out_of_order.binary_search_by_key(&result.block_idx, |r| r.block_idx) {
                    Ok(idx) => Err(Error::Other(format!("Unexpected duplicate block {idx}")))?,
                    Err(idx) => out_of_order.insert(idx, result),
                }
            }
        }

        Ok(())
    })
}

/// Read-on-main parallel pipeline (browser/wasm): the main thread reads each source block and the
/// running bookkeeping, worker threads run the CPU-bound `process_block_data`, and the main thread
/// reorders and writes results. Source reads (and the output write in the callback) stay on the
/// main thread so no worker thread opens an OPFS file. Reads ahead up to `num_threads * 4` blocks
/// so the channels never block (bounded memory).
#[cfg(feature = "threading")]
fn par_process_read_on_main<P, T>(
    mut processor: P,
    block_count: u32,
    num_threads: usize,
    mut callback: impl FnMut(BlockResult<T>) -> Result<()>,
) -> Result<()>
where
    T: Send,
    P: BlockProcessor<BlockMeta = T>,
{
    std::thread::scope(|s| -> Result<()> {
        use std::collections::VecDeque;

        use crate::Error;

        let inflight = num_threads.saturating_mul(4).max(2);
        let (work_tx, work_rx) = crossbeam_channel::bounded::<(u32, Bytes)>(inflight);
        let (result_tx, result_rx) = crossbeam_channel::bounded::<Result<BlockResult<T>>>(inflight);

        for _ in 0..num_threads {
            let work_rx = work_rx.clone();
            let result_tx = result_tx.clone();
            let mut processor = processor.clone();
            s.spawn(move || {
                while let Ok((block_idx, data)) = work_rx.recv() {
                    let result = processor
                        .process_block_data(block_idx, data)
                        .with_context(|| format!("Failed to process block {block_idx}"));
                    let failed = result.is_err();
                    if result_tx.send(result).is_err() || failed {
                        break;
                    }
                }
            });
        }
        drop(result_tx);
        drop(work_rx); // workers hold their own clones; main keeps only the sender

        let mut next_to_read = 0u32;
        let mut current_block = 0u32;
        // Blocks dispatched to workers but not yet written; bounded so neither channel blocks.
        let mut outstanding = 0usize;
        let mut out_of_order = VecDeque::<BlockResult<T>>::new();
        let mut pipeline_error: Option<Error> = None;

        while current_block < block_count {
            while pipeline_error.is_none() && outstanding < inflight && next_to_read < block_count {
                match processor
                    .read_block_data(next_to_read)
                    .with_context(|| format!("Failed to read block {next_to_read}"))
                {
                    Ok(data) => {
                        if work_tx.send((next_to_read, data)).is_err() {
                            pipeline_error = Some(Error::Other(
                                "block compression workers ended before all blocks were consumed"
                                    .to_string(),
                            ));
                            break;
                        }
                        next_to_read += 1;
                        outstanding += 1;
                    }
                    Err(error) => {
                        pipeline_error = Some(error);
                        break;
                    }
                }
            }

            if pipeline_error.is_some() || outstanding == 0 {
                break;
            }

            match result_rx.recv() {
                Ok(Ok(result)) => {
                    if result.block_idx == current_block {
                        if let Err(error) = callback(result) {
                            pipeline_error = Some(error);
                            break;
                        }
                        current_block += 1;
                        outstanding -= 1;
                        while out_of_order.front().is_some_and(|r| r.block_idx == current_block) {
                            if let Err(error) = callback(out_of_order.pop_front().unwrap()) {
                                pipeline_error = Some(error);
                                break;
                            }
                            current_block += 1;
                            outstanding -= 1;
                        }
                        if pipeline_error.is_some() {
                            break;
                        }
                    } else {
                        match out_of_order.binary_search_by_key(&result.block_idx, |r| r.block_idx)
                        {
                            Ok(_) => {
                                pipeline_error = Some(Error::Other(format!(
                                    "Unexpected duplicate block {}",
                                    result.block_idx
                                )));
                                break;
                            }
                            Err(idx) => out_of_order.insert(idx, result),
                        }
                    }
                }
                Ok(Err(error)) => {
                    pipeline_error = Some(error);
                    break;
                }
                Err(_) => {
                    pipeline_error = Some(Error::Other(
                        "block compression pipeline ended before all blocks were produced"
                            .to_string(),
                    ));
                    break;
                }
            }
        }

        // Stop feeding and drain in-flight results so workers unblock and exit cleanly.
        drop(work_tx);
        while result_rx.recv().is_ok() {}

        match pipeline_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    })
}

/// The determined block type.
pub enum CheckBlockResult {
    Normal,
    Zeroed,
    Junk,
}

/// Check if a block is zeroed or junk data.
#[allow(clippy::too_many_arguments)]
pub(crate) fn check_block(
    buf: &[u8],
    decrypted_block: &mut [u8],
    input_position: u64,
    partition_info: &[PartitionInfo],
    lfg: &mut LaggedFibonacci,
    disc_id: [u8; 4],
    disc_num: u8,
    scrub_update_partition: bool,
) -> io::Result<CheckBlockResult> {
    let start_sector = (input_position / SECTOR_SIZE as u64) as u32;
    let end_sector = ((input_position + buf.len() as u64) / SECTOR_SIZE as u64) as u32;
    if let Some(partition) = partition_info.iter().find(|p| {
        p.has_hashes && start_sector >= p.data_start_sector && end_sector < p.data_end_sector
    }) {
        // Ignore update partition data
        if scrub_update_partition && partition.kind == PartitionKind::Update {
            return Ok(CheckBlockResult::Zeroed);
        }

        if input_position % SECTOR_SIZE as u64 != 0 {
            return Err(io::Error::other("Partition block not aligned to sector boundary"));
        }
        if buf.len() % SECTOR_SIZE != 0 {
            return Err(io::Error::other("Partition block not a multiple of sector size"));
        }
        let block = if partition.has_encryption {
            if decrypted_block.len() < buf.len() {
                return Err(io::Error::other("Decrypted block buffer too small"));
            }
            for i in 0..buf.len() / SECTOR_SIZE {
                decrypt_sector_b2b(
                    array_ref![buf, SECTOR_SIZE * i, SECTOR_SIZE],
                    array_ref_mut![decrypted_block, SECTOR_SIZE * i, SECTOR_SIZE],
                    &partition.key,
                );
            }
            &decrypted_block[..buf.len()]
        } else {
            buf
        };
        if sector_data_iter(block).all(|sector_data| sector_data.iter().all(|&b| b == 0)) {
            return Ok(CheckBlockResult::Zeroed);
        }
        let partition_start = partition.data_start_sector as u64 * SECTOR_SIZE as u64;
        let partition_offset =
            ((input_position - partition_start) / SECTOR_SIZE as u64) * SECTOR_DATA_SIZE as u64;
        // Junk data within a partition is seeded from the partition's own disc header, which is
        // also what junk regeneration uses at read time. It usually matches the outer disc
        // header, but nothing guarantees that.
        let partition_header = partition.disc_header();
        let disc_id = *array_ref![partition_header.game_id, 0, 4];
        let disc_num = partition_header.disc_num;
        if sector_data_iter(block).enumerate().all(|(i, sector_data)| {
            let sector_offset = partition_offset + i as u64 * SECTOR_DATA_SIZE as u64;
            lfg.check_sector_chunked(sector_data, disc_id, disc_num, sector_offset)
                == sector_data.len()
        }) {
            return Ok(CheckBlockResult::Junk);
        }
    } else {
        if buf.iter().all(|&b| b == 0) {
            return Ok(CheckBlockResult::Zeroed);
        }
        if lfg.check_sector_chunked(buf, disc_id, disc_num, input_position) == buf.len() {
            return Ok(CheckBlockResult::Junk);
        }
    }
    Ok(CheckBlockResult::Normal)
}

#[inline]
fn sector_data_iter(buf: &[u8]) -> impl Iterator<Item = &[u8; SECTOR_DATA_SIZE]> {
    buf.chunks_exact(SECTOR_SIZE).map(|chunk| (&chunk[HASHES_SIZE..]).try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use zerocopy::FromZeros;

    use super::*;
    use crate::{
        common::PartitionKind,
        disc::{BOOT_SIZE, wii::WiiPartitionHeader},
        util::lfg::LaggedFibonacci,
    };

    const PARTITION_ID: [u8; 4] = *b"GKQJ";
    const OUTER_ID: [u8; 4] = *b"GKQE";

    fn partition_info() -> PartitionInfo {
        let mut raw_boot = [0u8; BOOT_SIZE];
        raw_boot[..4].copy_from_slice(&PARTITION_ID);
        raw_boot[4..6].copy_from_slice(b"01");
        PartitionInfo {
            index: 0,
            kind: PartitionKind::Data,
            start_sector: 0,
            data_start_sector: 0,
            data_end_sector: 16,
            key: [0u8; 16],
            header: Arc::new(WiiPartitionHeader::new_zeroed()),
            has_encryption: false,
            has_hashes: true,
            raw_boot: Arc::new(raw_boot),
            raw_fst: None,
        }
    }

    fn junk_sector(disc_id: [u8; 4]) -> Vec<u8> {
        let mut buf = vec![0u8; SECTOR_SIZE];
        let mut lfg = LaggedFibonacci::default();
        lfg.fill_sector_chunked(&mut buf[HASHES_SIZE..], disc_id, 0, 0);
        buf
    }

    fn run_check_block(buf: &[u8], partition: &PartitionInfo) -> CheckBlockResult {
        let mut decrypted = vec![0u8; buf.len()];
        check_block(
            buf,
            &mut decrypted,
            0,
            std::slice::from_ref(partition),
            &mut LaggedFibonacci::default(),
            OUTER_ID,
            0,
            false,
        )
        .unwrap()
    }

    /// Junk inside a partition is seeded from the partition's own disc header, which may differ
    /// from the outer disc header (and is what read-time regeneration uses).
    #[test]
    fn check_block_seeds_partition_junk_from_partition_header() {
        let partition = partition_info();
        let result = run_check_block(&junk_sector(PARTITION_ID), &partition);
        assert!(matches!(result, CheckBlockResult::Junk));
    }

    /// Junk generated from the outer disc header's ID must NOT be detected inside a partition
    /// with a different ID: read-time regeneration would produce different bytes.
    #[test]
    fn check_block_rejects_outer_header_junk_in_partition() {
        let partition = partition_info();
        let result = run_check_block(&junk_sector(OUTER_ID), &partition);
        assert!(matches!(result, CheckBlockResult::Normal));
    }
}
