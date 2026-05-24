use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, VecDeque, hash_map::Entry},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread::ThreadId,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{Result, RomWeaverError};

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

static NEXT_BLOCK_CACHE_READER_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_TEMP_NAMESPACE_ID: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static THREAD_LOCAL_BLOCK_CACHE_READERS: RefCell<HashMap<u64, BlockCacheReader>> =
        RefCell::new(HashMap::new());
}

pub fn bounded_items_for_threads(effective_threads: usize) -> usize {
    let threads = effective_threads.max(1);
    threads.saturating_mul(2).max(2)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoundedIoPolicy {
    pub chunk_size_bytes: u64,
    pub max_in_flight_items: usize,
    pub max_reorder_items: usize,
}

impl BoundedIoPolicy {
    pub fn for_effective_threads(effective_threads: usize) -> Self {
        let bounded_items = bounded_items_for_threads(effective_threads);
        Self {
            chunk_size_bytes: DEFAULT_CHUNK_SIZE_BYTES,
            max_in_flight_items: bounded_items,
            max_reorder_items: bounded_items,
        }
    }
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
    source: BlockCacheReaderSource,
    block_size: usize,
    max_blocks: usize,
}

impl SharedBlockCacheReader {
    pub fn open(path: &Path, block_size: usize, max_blocks: usize) -> Result<Self> {
        BlockCacheReader::validate_options(block_size, max_blocks)?;
        Ok(Self {
            source: BlockCacheReaderSource::new(path),
            block_size,
            max_blocks,
        })
    }

    pub fn read_exact_at(&self, offset: u64, output: &mut [u8]) -> Result<()> {
        with_thread_local_block_cache_reader(
            self.source.for_current_thread(),
            self.block_size,
            self.max_blocks,
            |reader| reader.read_exact_at(offset, output),
        )
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
        with_thread_local_block_cache_reader(
            self.source.for_current_thread(),
            self.block_size,
            self.max_blocks,
            |reader| reader.read_exact_at(offset, output),
        )
    }
}

fn with_thread_local_block_cache_reader<T>(
    source: BlockCacheReaderSource,
    block_size: usize,
    max_blocks: usize,
    f: impl FnOnce(&mut BlockCacheReader) -> Result<T>,
) -> Result<T> {
    THREAD_LOCAL_BLOCK_CACHE_READERS.with(|readers| {
        let mut readers = readers.borrow_mut();
        let reader = match readers.entry(source.id) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let reader =
                    BlockCacheReader::open_with_source(source.clone(), block_size, max_blocks)?;
                entry.insert(reader)
            }
        };
        f(reader)
    })
}

#[derive(Clone, Debug)]
struct BlockCacheReaderSource {
    id: u64,
    path: PathBuf,
    owner_thread_id: ThreadId,
}

impl BlockCacheReaderSource {
    fn new(path: &Path) -> Self {
        Self {
            id: NEXT_BLOCK_CACHE_READER_ID.fetch_add(1, Ordering::Relaxed),
            path: path.to_path_buf(),
            owner_thread_id: std::thread::current().id(),
        }
    }

    fn for_current_thread(&self) -> Self {
        Self {
            id: self.id,
            path: self.path.clone(),
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
        let sequence = NEXT_TEMP_NAMESPACE_ID.fetch_add(1, Ordering::Relaxed);
        let namespace = format!("rw-{timestamp}-{sequence}");
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

#[cfg(test)]
#[path = "../tests/unit/io.rs"]
mod tests;
