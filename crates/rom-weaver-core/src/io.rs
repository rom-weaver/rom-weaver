use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    thread::ThreadId,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{IoOp, IoResultExt, Result, RomWeaverError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChunk {
    pub index: u64,
    pub offset: u64,
    pub len: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkPlanner {
    chunk_size: NonZeroU64,
}

impl ChunkPlanner {
    pub fn new(chunk_size: u64) -> Result<Self> {
        let chunk_size = NonZeroU64::new(chunk_size).ok_or_else(|| {
            RomWeaverError::Validation("chunk size must be greater than zero".into())
        })?;
        Ok(Self { chunk_size })
    }

    pub fn chunk_size(&self) -> u64 {
        self.chunk_size.get()
    }

    pub fn plan(&self, file_len: u64) -> Vec<FileChunk> {
        if file_len == 0 {
            return Vec::new();
        }

        let chunk_size = self.chunk_size();
        let chunk_count = file_len.div_ceil(chunk_size);
        (0..chunk_count)
            .map(|index| {
                let offset = index * chunk_size;
                let remaining = file_len.saturating_sub(offset);
                let len = remaining.min(chunk_size);
                FileChunk { index, offset, len }
            })
            .collect()
    }
}

pub const DEFAULT_CHUNK_SIZE_BYTES: u64 = 1 << 20;
pub const DEFAULT_BLOCK_CACHE_SIZE_BYTES: usize = 1 << 20;
pub const DEFAULT_BLOCK_CACHE_MAX_BLOCKS: usize = 32;

static NEXT_TEMP_NAMESPACE_ID: AtomicU64 = AtomicU64::new(1);

/// Random u64 fixed once per process/wasm instance, folded into every temp namespace so two
/// concurrent instances sharing an OPFS root cannot mint the same directory. `RandomState` seeds a
/// SipHash keyed from OS entropy (getrandom under the hood); finishing an empty hasher yields a
/// random value with no extra dependency.
fn namespace_entropy() -> u64 {
    use std::{
        hash::{BuildHasher, Hasher},
        sync::OnceLock,
    };
    static INSTANCE_ENTROPY: OnceLock<u64> = OnceLock::new();
    *INSTANCE_ENTROPY.get_or_init(|| {
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderedStreamingMessages {
    pub worker_closed: &'static str,
    pub result_closed: &'static str,
}

pub fn bounded_items_for_threads(effective_threads: usize) -> usize {
    let threads = effective_threads.max(1);
    threads.saturating_mul(2).max(2)
}

pub fn create_extract_output_file(output_path: &Path, overwrite: bool) -> Result<File> {
    if overwrite {
        return File::create(output_path).io_op(IoOp::Create, output_path);
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)
        .map_err(|error| {
            // `create_new` fails for two very different reasons. Only an existing
            // file is an overwrite refusal; a denied directory reported as one
            // sends the user hunting for a file that was never there.
            if error.kind() == ErrorKind::AlreadyExists {
                return RomWeaverError::Validation(format!(
                    "refusing to overwrite existing output `{}`: {error}",
                    output_path.display()
                ));
            }
            RomWeaverError::io_path(IoOp::Create, output_path, error)
        })
}

pub fn file_starts_with(source: &Path, signature: &[u8]) -> bool {
    let mut bytes = vec![0u8; signature.len()];
    if let Ok(mut file) = File::open(source) {
        return file.read_exact(&mut bytes).is_ok() && bytes == signature;
    }
    false
}

pub fn ordered_streaming_compress<
    Tasks,
    TTask,
    TWork,
    TOutput,
    TWorkerState,
    ReadTask,
    MakeWorkerState,
    CompressTask,
    CollectOutput,
>(
    tasks: Tasks,
    effective_threads: usize,
    messages: OrderedStreamingMessages,
    mut read_task: ReadTask,
    make_worker_state: MakeWorkerState,
    compress_task: CompressTask,
    mut collect_output: CollectOutput,
) -> Result<()>
where
    Tasks: IntoIterator<Item = TTask>,
    Tasks::IntoIter: ExactSizeIterator,
    TWork: Send,
    TOutput: Send,
    MakeWorkerState: Fn() -> TWorkerState + Sync,
    CompressTask: Fn(&mut TWorkerState, usize, TWork) -> Result<TOutput> + Sync,
    ReadTask: FnMut(usize, TTask) -> Result<TWork>,
    CollectOutput: FnMut(usize, TOutput) -> Result<()>,
{
    let mut tasks = tasks.into_iter();
    let total = tasks.len();
    if total == 0 {
        return Ok(());
    }

    // `effective_threads` is the compute-worker budget: spawn that many workers and let the calling
    // thread (which reads source data and collects/hashes results - e.g. CHD create folds the raw
    // SHA-1 here) coordinate on top. The coordinator is intentionally not subtracted from the
    // worker count, so a configured budget of N runs N parallel compressors.
    let worker_count = effective_threads.max(1).min(total);
    let inflight = bounded_items_for_threads(worker_count).max(1);
    let (work_tx, work_rx) = mpsc::sync_channel::<(usize, TWork)>(inflight);
    let work_rx = Mutex::new(work_rx);
    let (result_tx, result_rx) = mpsc::sync_channel::<Result<(usize, TOutput)>>(inflight);

    thread::scope(|scope| -> Result<()> {
        for _ in 0..worker_count {
            let work_rx = &work_rx;
            let result_tx = result_tx.clone();
            let make_worker_state = &make_worker_state;
            let compress_task = &compress_task;
            scope.spawn(move || {
                let mut worker_state =
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(make_worker_state))
                    {
                        Ok(worker_state) => worker_state,
                        Err(_) => {
                            let _ = result_tx.send(Err(RomWeaverError::Validation(
                                "ordered compression worker panicked while initializing"
                                    .to_string(),
                            )));
                            return;
                        }
                    };
                loop {
                    let received = {
                        let guard = work_rx.lock().unwrap_or_else(|err| err.into_inner());
                        guard.recv()
                    };
                    let Ok((index, work)) = received else {
                        break;
                    };
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        compress_task(&mut worker_state, index, work)
                    }))
                    .unwrap_or_else(|_| {
                        Err(RomWeaverError::Validation(format!(
                            "ordered compression worker panicked while processing task {index}"
                        )))
                    })
                    .map(|output| (index, output));
                    let failed = outcome.is_err();
                    if result_tx.send(outcome).is_err() || failed {
                        break;
                    }
                }
            });
        }
        drop(result_tx);

        let mut next_to_read = 0usize;
        let mut next_to_collect = 0usize;
        let mut outstanding = 0usize;
        let mut pending = BTreeMap::<usize, TOutput>::new();
        let mut pipeline_error: Option<RomWeaverError> = None;

        while next_to_collect < total {
            while pipeline_error.is_none() && outstanding < inflight && next_to_read < total {
                let Some(task) = tasks.next() else {
                    pipeline_error = Some(RomWeaverError::Validation(
                        "ordered compression pipeline task iterator ended early".into(),
                    ));
                    break;
                };
                match read_task(next_to_read, task) {
                    Ok(work) => {
                        if work_tx.send((next_to_read, work)).is_err() {
                            pipeline_error =
                                Some(RomWeaverError::Validation(messages.worker_closed.into()));
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

            if let Some(output) = pending.remove(&next_to_collect) {
                if let Err(error) = collect_output(next_to_collect, output) {
                    pipeline_error = Some(error);
                    break;
                }
                next_to_collect += 1;
                outstanding -= 1;
                continue;
            }

            match result_rx.recv() {
                Ok(Ok((index, output))) => {
                    if index >= total {
                        pipeline_error = Some(RomWeaverError::Validation(format!(
                            "ordered compression pipeline produced out-of-range task {index} for {total} tasks"
                        )));
                        break;
                    }
                    if index < next_to_collect || pending.insert(index, output).is_some() {
                        pipeline_error = Some(RomWeaverError::Validation(format!(
                            "ordered compression pipeline produced duplicate task {index}"
                        )));
                        break;
                    }

                    while let Some(output) = pending.remove(&next_to_collect) {
                        if let Err(error) = collect_output(next_to_collect, output) {
                            pipeline_error = Some(error);
                            break;
                        }
                        next_to_collect += 1;
                        outstanding -= 1;
                    }
                }
                Ok(Err(error)) => {
                    pipeline_error = Some(error);
                    break;
                }
                Err(_) => {
                    pipeline_error =
                        Some(RomWeaverError::Validation(messages.result_closed.into()));
                    break;
                }
            }
        }

        drop(work_tx);
        while result_rx.recv().is_ok() {}

        match pipeline_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IoWatermark {
    pub current_bytes: usize,
    pub max_bytes: usize,
}

impl IoWatermark {
    pub fn add_bytes(&mut self, bytes: usize) {
        self.current_bytes = self.current_bytes.saturating_add(bytes);
        self.max_bytes = self.max_bytes.max(self.current_bytes);
    }

    pub fn release_bytes(&mut self, bytes: usize) {
        self.current_bytes = self.current_bytes.saturating_sub(bytes);
    }
}

pub struct OrderedChunkWriter<W: Write> {
    writer: W,
    next_index: u64,
    max_reorder_items: usize,
    pending: BTreeMap<u64, Vec<u8>>,
    watermark: IoWatermark,
}

impl<W: Write> OrderedChunkWriter<W> {
    pub fn new(writer: W, max_reorder_items: usize) -> Result<Self> {
        if max_reorder_items == 0 {
            return Err(RomWeaverError::Validation(
                "ordered writer max_reorder_items must be greater than zero".to_string(),
            ));
        }
        Ok(Self {
            writer,
            next_index: 0,
            max_reorder_items,
            pending: BTreeMap::new(),
            watermark: IoWatermark::default(),
        })
    }

    pub fn write_chunk(&mut self, index: u64, bytes: Vec<u8>) -> Result<()> {
        let inserted_len = bytes.len();
        if self.pending.insert(index, bytes).is_none() {
            self.watermark.add_bytes(inserted_len);
        }

        if self.pending.len() > self.max_reorder_items {
            return Err(RomWeaverError::Validation(format!(
                "ordered writer exceeded max reorder window: {} > {}",
                self.pending.len(),
                self.max_reorder_items
            )));
        }

        while let Some(chunk) = self.pending.remove(&self.next_index) {
            self.writer.write_all(&chunk)?;
            self.watermark.release_bytes(chunk.len());
            self.next_index = self.next_index.saturating_add(1);
        }

        Ok(())
    }

    pub fn finish(mut self) -> Result<W> {
        if !self.pending.is_empty() {
            return Err(RomWeaverError::Validation(
                "ordered writer finished with unresolved chunk gaps".to_string(),
            ));
        }
        self.writer.flush()?;
        Ok(self.writer)
    }

    pub fn watermark(&self) -> IoWatermark {
        self.watermark
    }
}

pub struct BlockCacheReader {
    file: File,
    file_len: u64,
    block_size: usize,
    max_blocks: usize,
    cache: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
    watermark: IoWatermark,
    source: BlockCacheReaderSource,
}

pub struct SharedBlockCacheReader {
    block_size: usize,
    file_len: u64,
    max_blocks: usize,
    state: Mutex<SharedBlockCacheState>,
    source: BlockCacheReaderSource,
}

#[derive(Default)]
struct SharedBlockCacheState {
    cache: HashMap<u64, Arc<Vec<u8>>>,
    order: VecDeque<u64>,
}

impl SharedBlockCacheReader {
    pub fn open(path: &Path, block_size: usize, max_blocks: usize) -> Result<Self> {
        BlockCacheReader::validate_options(block_size, max_blocks)?;
        let file_len = File::open(path)?.metadata()?.len();
        Ok(Self {
            block_size,
            file_len,
            max_blocks,
            state: Mutex::new(SharedBlockCacheState::default()),
            source: BlockCacheReaderSource::new(path),
        })
    }

    pub fn read_exact_at(&self, offset: u64, output: &mut [u8]) -> Result<()> {
        if output.is_empty() {
            return Ok(());
        }
        let read_len = u64::try_from(output.len()).map_err(|_| {
            RomWeaverError::Validation("requested read length overflowed u64".to_string())
        })?;
        if offset
            .checked_add(read_len)
            .is_none_or(|end| end > self.file_len)
        {
            return Err(RomWeaverError::Validation(format!(
                "read range exceeds file bounds (offset={offset}, len={})",
                output.len()
            )));
        }

        let block_size = self.block_size as u64;
        let mut copied = 0usize;
        while copied < output.len() {
            let absolute_offset = offset.saturating_add(copied as u64);
            let block_index = absolute_offset / block_size;
            let block_offset = (absolute_offset % block_size) as usize;
            let block = self.get_block(block_index)?;
            let copy_len = (block.len() - block_offset).min(output.len() - copied);
            output[copied..copied + copy_len]
                .copy_from_slice(&block[block_offset..block_offset + copy_len]);
            copied += copy_len;
        }
        Ok(())
    }

    fn get_block(&self, block_index: u64) -> Result<Arc<Vec<u8>>> {
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(block) = state.cache.get(&block_index).cloned() {
                if let Some(position) = state.order.iter().position(|value| *value == block_index) {
                    state.order.remove(position);
                }
                state.order.push_back(block_index);
                return Ok(block);
            }
        }

        // Load misses outside the lock so unrelated blocks can be read in parallel. Two workers may
        // race to load the same missing block; the second insertion simply reuses the first.
        let start = block_index.saturating_mul(self.block_size as u64);
        let remaining = self.file_len.saturating_sub(start);
        let block_len = usize::try_from(remaining.min(self.block_size as u64)).map_err(|_| {
            RomWeaverError::Validation("shared block cache length overflowed usize".to_string())
        })?;
        let mut loaded = vec![0u8; block_len];
        read_exact_from_path(&self.source.path, start, &mut loaded)?;
        let loaded = Arc::new(loaded);

        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(block) = state.cache.get(&block_index).cloned() {
            return Ok(block);
        }
        state.cache.insert(block_index, Arc::clone(&loaded));
        state.order.push_back(block_index);
        while state.order.len() > self.max_blocks {
            if let Some(evicted) = state.order.pop_front() {
                state.cache.remove(&evicted);
            }
        }
        Ok(loaded)
    }
}

impl BlockCacheReader {
    pub fn open(path: &Path, block_size: usize, max_blocks: usize) -> Result<Self> {
        Self::open_with_source(BlockCacheReaderSource::new(path), block_size, max_blocks)
    }

    fn open_with_source(
        source: BlockCacheReaderSource,
        block_size: usize,
        max_blocks: usize,
    ) -> Result<Self> {
        Self::validate_options(block_size, max_blocks)?;
        let file = File::open(&source.path)?;
        let file_len = file.metadata()?.len();
        Ok(Self {
            file,
            file_len,
            block_size,
            max_blocks,
            cache: HashMap::new(),
            order: VecDeque::new(),
            watermark: IoWatermark::default(),
            source,
        })
    }

    fn validate_options(block_size: usize, max_blocks: usize) -> Result<()> {
        if block_size == 0 {
            return Err(RomWeaverError::Validation(
                "block cache block_size must be greater than zero".to_string(),
            ));
        }
        if max_blocks == 0 {
            return Err(RomWeaverError::Validation(
                "block cache max_blocks must be greater than zero".to_string(),
            ));
        }
        Ok(())
    }

    pub fn read_exact_at(&mut self, offset: u64, output: &mut [u8]) -> Result<()> {
        if output.is_empty() {
            return Ok(());
        }
        if !self.source.is_owned_by_current_thread() {
            return self.read_exact_at_on_current_thread(offset, output);
        }
        let read_len_u64 = u64::try_from(output.len()).map_err(|_| {
            RomWeaverError::Validation("requested read length overflowed u64".to_string())
        })?;
        if offset
            .checked_add(read_len_u64)
            .is_none_or(|end| end > self.file_len)
        {
            return Err(RomWeaverError::Validation(format!(
                "read range exceeds file bounds (offset={offset}, len={})",
                output.len()
            )));
        }

        let block_size_u64 = self.block_size as u64;
        let mut copied = 0usize;
        while copied < output.len() {
            let absolute_offset = offset.saturating_add(copied as u64);
            let block_index = absolute_offset / block_size_u64;
            let block_offset = (absolute_offset % block_size_u64) as usize;
            let block = self.get_block(block_index)?;
            let available = block.len().saturating_sub(block_offset);
            let needed = output.len().saturating_sub(copied);
            let copy_len = available.min(needed);
            if copy_len == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "block cache hit empty block while reading at offset {absolute_offset}"
                )));
            }
            output[copied..copied + copy_len]
                .copy_from_slice(&block[block_offset..block_offset + copy_len]);
            copied = copied.saturating_add(copy_len);
        }

        Ok(())
    }

    pub fn read_vec_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>> {
        let mut output = vec![0u8; len];
        self.read_exact_at(offset, &mut output)?;
        Ok(output)
    }

    pub fn watermark(&self) -> IoWatermark {
        self.watermark
    }

    pub fn block_size(&self) -> usize {
        self.block_size
    }

    pub fn max_blocks(&self) -> usize {
        self.max_blocks
    }

    fn get_block(&mut self, block_index: u64) -> Result<&Vec<u8>> {
        if self.cache.contains_key(&block_index) {
            self.touch_block(block_index);
            return self.cache.get(&block_index).ok_or_else(|| {
                RomWeaverError::Validation("block cache lookup failed".to_string())
            });
        }

        let start = block_index.saturating_mul(self.block_size as u64);
        self.file.seek(SeekFrom::Start(start))?;
        let mut block = vec![0u8; self.block_size];
        let bytes_read = self.file.read(&mut block)?;
        block.truncate(bytes_read);
        if block.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "block cache attempted to read beyond file length at block index {block_index}"
            )));
        }

        self.watermark.add_bytes(block.len());
        self.cache.insert(block_index, block);
        self.order.push_back(block_index);
        while self.order.len() > self.max_blocks {
            if let Some(evict_index) = self.order.pop_front()
                && let Some(evicted) = self.cache.remove(&evict_index)
            {
                self.watermark.release_bytes(evicted.len());
            }
        }

        self.cache
            .get(&block_index)
            .ok_or_else(|| RomWeaverError::Validation("block cache insert failed".to_string()))
    }

    fn touch_block(&mut self, block_index: u64) {
        if let Some(position) = self.order.iter().position(|value| *value == block_index) {
            self.order.remove(position);
            self.order.push_back(block_index);
        }
    }

    fn read_exact_at_on_current_thread(&self, offset: u64, output: &mut [u8]) -> Result<()> {
        read_exact_from_path(&self.source.path, offset, output)
    }
}

fn read_exact_from_path(path: &Path, offset: u64, output: &mut [u8]) -> Result<()> {
    if output.is_empty() {
        return Ok(());
    }
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let read_len_u64 = u64::try_from(output.len()).map_err(|_| {
        RomWeaverError::Validation("requested read length overflowed u64".to_string())
    })?;
    if offset
        .checked_add(read_len_u64)
        .is_none_or(|end| end > file_len)
    {
        return Err(RomWeaverError::Validation(format!(
            "read range exceeds file bounds (offset={offset}, len={})",
            output.len()
        )));
    }
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(output)?;
    Ok(())
}

#[derive(Clone, Debug)]
struct BlockCacheReaderSource {
    path: PathBuf,
    owner_thread_id: ThreadId,
}

impl BlockCacheReaderSource {
    fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            owner_thread_id: std::thread::current().id(),
        }
    }

    fn is_owned_by_current_thread(&self) -> bool {
        self.owner_thread_id == std::thread::current().id()
    }
}

#[derive(Debug)]
pub struct TempPathAllocator {
    root: PathBuf,
    namespace: String,
    counter: AtomicU64,
}

impl TempPathAllocator {
    pub fn new(root: PathBuf) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        #[cfg(target_family = "wasm")]
        let process_id = 1u32;
        #[cfg(not(target_family = "wasm"))]
        let process_id = std::process::id();
        let sequence = NEXT_TEMP_NAMESPACE_ID.fetch_add(1, Ordering::Relaxed);
        // On wasm `process_id` is a constant and the sequence counter + coarsened browser clock
        // can collide across concurrent runtime instances sharing one OPFS root, minting an
        // identical namespace so one instance's Drop removes the other's live temp dir. Mix in a
        // per-instance random u64 (SipHash-seeded from OS entropy, no new deps) to disambiguate.
        let entropy = namespace_entropy();
        let namespace = format!("rw-{timestamp}-{process_id}-{sequence}-{entropy:016x}");
        Self {
            root,
            namespace,
            counter: AtomicU64::new(0),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub fn next_path(&self, purpose: &str, extension: Option<&str>) -> PathBuf {
        let sequence = self.counter.fetch_add(1, Ordering::SeqCst);
        let label = purpose
            .chars()
            .map(|value| {
                if value.is_ascii_alphanumeric() || matches!(value, '-' | '_') {
                    value
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let mut file_name = format!("{label}-{sequence:08}");
        if let Some(extension) = extension {
            let extension = extension.trim_start_matches('.');
            if !extension.is_empty() {
                file_name.push('.');
                file_name.push_str(extension);
            }
        }
        self.root.join(&self.namespace).join(file_name)
    }
}

impl Drop for TempPathAllocator {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.root.join(&self.namespace));
    }
}

#[cfg(test)]
#[path = "../tests/unit/io.rs"]
mod tests;
