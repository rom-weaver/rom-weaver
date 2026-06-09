use super::{
    compute_checksum_values, compute_checksum_values_with_progress, hex_encode, render_label,
    resolve_algorithms, tuned_chunk_size,
};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::Path,
};

#[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
use std::{
    sync::{Arc, mpsc},
    thread,
};

use adler2::Adler32;
use blake3::Hasher as Blake3Hasher;
use crc16::{ARC, State as Crc16State};
use crc32c::crc32c_append;
use crc32fast::Hasher as Crc32Hasher;
use md5::{Digest as Md5Digest, Md5};
use rom_weaver_core::{
    ChecksumCapabilities, ChecksumEngine, ChecksumRequest, OperationContext, OperationFamily,
    OperationReport, Result, RomWeaverError, ThreadCapability, ThreadExecution,
};
use sha1::Sha1;
use sha2::{Digest as Sha2Digest, Sha256};
use tracing::trace;

pub(super) const SUPPORTED_ALGORITHMS: &[&str] = &[
    "crc32", "md5", "sha1", "sha256", "blake3", "crc32c", "crc16", "adler32",
];
pub(super) const MAX_EAGER_MAP_RANGE_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MIN_CHUNK_SIZE: usize = 256 * 1024;
pub(super) const MAX_CHUNK_SIZE: usize = 4 * 1024 * 1024;
pub(super) const TARGET_CHUNKS_PER_WORKER: u64 = 8;
pub(super) const FANOUT_PARALLEL_THRESHOLD: u64 = 8 * 1024 * 1024;
pub(super) const CRC32_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
pub(super) const CRC32_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
pub(super) const CRC32_PARALLEL_MAX_THREADS: usize = 4;
pub(super) const CRC32C_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
pub(super) const CRC32C_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
pub(super) const CRC32C_PARALLEL_MAX_THREADS: usize = 4;
pub(super) const CRC16_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
pub(super) const CRC16_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
pub(super) const CRC16_PARALLEL_MAX_THREADS: usize = 4;
pub(super) const ADLER32_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
pub(super) const ADLER32_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
pub(super) const ADLER32_PARALLEL_MAX_THREADS: usize = 4;
pub(super) const BLAKE3_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
pub(super) const BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
pub(super) const BLAKE3_PARALLEL_MAX_THREADS: usize = 8;
pub(super) const ADLER32_MODULO: u64 = 65_521;
pub(super) const CRC16_GF2_DIM: usize = 16;
pub(super) const CRC16_ARC_REFLECTED_POLY: u16 = 0xA001;
pub(super) const CRC16_CCITT_POLYNOMIAL: u16 = 0x1021;
pub(super) const MD5_IO_BUFFER_SIZE: usize = 64 * 1024;

pub struct NativeChecksumEngine;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChecksumValues {
    pub execution: ThreadExecution,
    pub values: BTreeMap<String, String>,
}

pub struct StreamingChecksum {
    inner: StreamingChecksumInner,
}

pub(super) enum StreamingChecksumInner {
    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    Async(Vec<AsyncStreamingChecksumWorker>),
    Sync(Vec<(Algorithm, HasherState)>),
}

#[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
pub(super) struct AsyncStreamingChecksumWorker {
    handle: thread::JoinHandle<BTreeMap<String, String>>,
    sender: Option<mpsc::SyncSender<Arc<[u8]>>>,
}

impl StreamingChecksum {
    pub fn requested_algorithm_count(algorithms: &[String]) -> Result<usize> {
        Ok(resolve_algorithms(algorithms)?.len())
    }

    pub fn new(algorithms: &[String]) -> Result<Option<Self>> {
        let algorithms = resolve_algorithms(algorithms)?;
        if algorithms.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self::from_algorithms_sync(algorithms)))
    }

    pub fn new_with_context(
        algorithms: &[String],
        context: &OperationContext,
    ) -> Result<Option<Self>> {
        let algorithms = resolve_algorithms(algorithms)?;
        if algorithms.is_empty() {
            return Ok(None);
        }
        #[cfg(all(target_family = "wasm", not(rom_weaver_wasi_threads)))]
        {
            let _ = context;
            Ok(Some(Self::from_algorithms_sync(algorithms)))
        }

        #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
        {
            let execution =
                context.plan_threads(ThreadCapability::parallel(Some(algorithms.len())));
            if execution.used_parallelism
                && execution.effective_threads > 1
                && let Some(checksum) =
                    Self::try_from_algorithms_async(algorithms.clone(), execution.effective_threads)
            {
                return Ok(Some(checksum));
            }
            Ok(Some(Self::from_algorithms_sync(algorithms)))
        }
    }

    pub(super) fn from_algorithms_sync(algorithms: Vec<Algorithm>) -> Self {
        Self {
            inner: StreamingChecksumInner::Sync(
                algorithms
                    .into_iter()
                    .map(|algorithm| (algorithm, HasherState::new(algorithm)))
                    .collect(),
            ),
        }
    }

    #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
    pub(super) fn try_from_algorithms_async(
        algorithms: Vec<Algorithm>,
        worker_count: usize,
    ) -> Option<Self> {
        let worker_algorithms = partition_streaming_algorithms(&algorithms, worker_count);
        let mut workers: Vec<AsyncStreamingChecksumWorker> = Vec::new();
        for algorithms in worker_algorithms {
            let (sender, receiver) = mpsc::sync_channel::<Arc<[u8]>>(2);
            let handle = match thread::Builder::new()
                .name("rom-weaver-streaming-checksum".to_string())
                .spawn(move || {
                    let mut states = algorithms
                        .into_iter()
                        .map(|algorithm| (algorithm, HasherState::new(algorithm)))
                        .collect::<Vec<_>>();
                    while let Ok(bytes) = receiver.recv() {
                        for (_, state) in &mut states {
                            state.update(&bytes);
                        }
                    }
                    states
                        .into_iter()
                        .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
                        .collect()
                }) {
                Ok(handle) => handle,
                Err(_) => {
                    for mut worker in workers {
                        drop(worker.sender.take());
                        let _ = worker.handle.join();
                    }
                    return None;
                }
            };
            workers.push(AsyncStreamingChecksumWorker {
                handle,
                sender: Some(sender),
            });
        }
        Some(Self {
            inner: StreamingChecksumInner::Async(workers),
        })
    }

    pub fn update(&mut self, bytes: &[u8]) -> Result<()> {
        match &mut self.inner {
            #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
            StreamingChecksumInner::Async(workers) => {
                let chunk = Arc::<[u8]>::from(bytes.to_vec());
                send_streaming_checksum_chunk(workers, chunk)
            }
            StreamingChecksumInner::Sync(states) => {
                for (_, state) in states {
                    state.update(bytes);
                }
                Ok(())
            }
        }
    }

    pub fn update_owned(&mut self, bytes: Vec<u8>) -> Result<()> {
        match &mut self.inner {
            #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
            StreamingChecksumInner::Async(workers) => {
                let chunk = Arc::<[u8]>::from(bytes.into_boxed_slice());
                send_streaming_checksum_chunk(workers, chunk)
            }
            StreamingChecksumInner::Sync(states) => {
                for (_, state) in states {
                    state.update(&bytes);
                }
                Ok(())
            }
        }
    }

    pub fn finalize(self) -> Result<BTreeMap<String, String>> {
        match self.inner {
            #[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
            StreamingChecksumInner::Async(mut workers) => {
                for worker in &mut workers {
                    drop(worker.sender.take());
                }
                let mut results = BTreeMap::new();
                for worker in workers {
                    let worker_results = worker.handle.join().map_err(|_| {
                        RomWeaverError::Validation("streaming checksum worker panicked".to_string())
                    })?;
                    results.extend(worker_results);
                }
                Ok(results)
            }
            StreamingChecksumInner::Sync(states) => Ok(states
                .into_iter()
                .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
                .collect()),
        }
    }
}

#[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
pub(super) fn send_streaming_checksum_chunk(
    workers: &mut [AsyncStreamingChecksumWorker],
    chunk: Arc<[u8]>,
) -> Result<()> {
    for worker in workers {
        let sender = worker.sender.as_ref().ok_or_else(|| {
            RomWeaverError::Validation(
                "streaming checksum worker closed before extraction finished".to_string(),
            )
        })?;
        sender.send(Arc::clone(&chunk)).map_err(|_| {
            RomWeaverError::Validation(
                "streaming checksum worker stopped before extraction finished".to_string(),
            )
        })?;
    }
    Ok(())
}

#[cfg(any(not(target_family = "wasm"), rom_weaver_wasi_threads))]
pub(super) fn partition_streaming_algorithms(
    algorithms: &[Algorithm],
    worker_count: usize,
) -> Vec<Vec<Algorithm>> {
    let worker_count = worker_count.min(algorithms.len()).max(1);
    let mut workers = vec![Vec::new(); worker_count];
    for (index, algorithm) in algorithms.iter().copied().enumerate() {
        workers[index % worker_count].push(algorithm);
    }
    workers
        .into_iter()
        .filter(|algorithms| !algorithms.is_empty())
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChecksumProgress {
    pub processed_bytes: u64,
    pub total_bytes: u64,
}

impl ChecksumProgress {
    pub fn percent(self) -> f32 {
        if self.total_bytes == 0 {
            return 100.0;
        }
        ((self.processed_bytes.min(self.total_bytes) as f64 / self.total_bytes as f64) * 100.0)
            as f32
    }
}

pub(super) struct ChecksumProgressTracker<'a> {
    total_bytes: u64,
    processed_bytes: u64,
    next_percent: u64,
    callback: &'a mut dyn FnMut(ChecksumProgress),
}

impl<'a> ChecksumProgressTracker<'a> {
    pub(super) fn new(total_bytes: u64, callback: &'a mut dyn FnMut(ChecksumProgress)) -> Self {
        Self {
            total_bytes,
            processed_bytes: 0,
            next_percent: 1,
            callback,
        }
    }

    pub(super) fn advance(&mut self, delta_bytes: u64) {
        if self.total_bytes == 0 {
            return;
        }
        self.processed_bytes = self
            .processed_bytes
            .saturating_add(delta_bytes)
            .min(self.total_bytes);
        self.maybe_emit();
    }

    pub(super) fn finish(&mut self) {
        if self.total_bytes == 0 {
            return;
        }
        self.processed_bytes = self.total_bytes;
        self.maybe_emit();
    }

    pub(super) fn maybe_emit(&mut self) {
        if self.total_bytes == 0 {
            return;
        }
        let percent = if self.processed_bytes >= self.total_bytes {
            100
        } else {
            self.processed_bytes.saturating_mul(100) / self.total_bytes
        };
        if percent < self.next_percent {
            return;
        }
        (self.callback)(ChecksumProgress {
            processed_bytes: self.processed_bytes,
            total_bytes: self.total_bytes,
        });
        self.next_percent = percent.saturating_add(1).min(101);
    }
}

impl Default for NativeChecksumEngine {
    fn default() -> Self {
        Self
    }
}

impl ChecksumEngine for NativeChecksumEngine {
    fn name(&self) -> &'static str {
        "native"
    }

    fn supported_algorithms(&self) -> &'static [&'static str] {
        SUPPORTED_ALGORITHMS
    }

    fn checksum_file(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.run_checksum(request, context, "checksum")
    }

    fn checksum_range(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.run_checksum(request, context, "checksum-range")
    }

    fn capabilities(&self) -> ChecksumCapabilities {
        ChecksumCapabilities {
            checksum_file: true,
            checksum_range: true,
            threaded_fanout: true,
        }
    }
}

impl NativeChecksumEngine {
    pub fn checksum_values(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
    ) -> Result<ChecksumValues> {
        compute_checksum_values(request, context)
    }

    pub fn checksum_report_with_progress<F>(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
        stage: &'static str,
        on_progress: &mut F,
    ) -> Result<OperationReport>
    where
        F: FnMut(ChecksumProgress),
    {
        self.run_checksum_with_progress(request, context, stage, on_progress)
    }

    pub(super) fn run_checksum(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
        stage: &'static str,
    ) -> Result<OperationReport> {
        let mut noop_progress = |_progress: ChecksumProgress| {};
        self.run_checksum_with_progress(request, context, stage, &mut noop_progress)
    }

    pub(super) fn run_checksum_with_progress<F>(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
        stage: &'static str,
        on_progress: &mut F,
    ) -> Result<OperationReport>
    where
        F: FnMut(ChecksumProgress),
    {
        trace!(
            stage,
            source = %request.source.display(),
            algorithms = ?request.algorithms,
            start = ?request.start,
            length = ?request.length,
            "running checksum operation"
        );
        let algorithms = resolve_algorithms(&request.algorithms)?;
        let range = ResolvedRange::from_request(&request.source, request.start, request.length)?;
        let computed = compute_checksum_values_with_progress(request, context, on_progress)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.name().to_string()),
            stage,
            render_label(&algorithms, &computed.values, &range),
            Some(100.0),
            Some(computed.execution),
        ))
    }
}

pub fn checksum_file_values(
    source: &Path,
    algorithms: &[&str],
    context: &OperationContext,
) -> Result<BTreeMap<String, String>> {
    let request = ChecksumRequest {
        source: source.to_path_buf(),
        algorithms: algorithms
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        start: None,
        length: None,
    };
    Ok(compute_checksum_values(&request, context)?.values)
}

pub fn checksum_reader_values_with_progress<R, F>(
    reader: &mut R,
    algorithms: &[String],
    context: &OperationContext,
    on_progress: &mut F,
) -> Result<ChecksumValues>
where
    R: Read + ?Sized,
    F: FnMut(ChecksumProgress),
{
    let algorithms = resolve_algorithms(algorithms)?;
    let execution = context.plan_threads(ThreadCapability::single_threaded());
    let chunk_size =
        tuned_chunk_size(MAX_EAGER_MAP_RANGE_BYTES, execution.effective_threads).max(1);
    let mut buffer = vec![0u8; chunk_size];
    let mut states = algorithms
        .iter()
        .copied()
        .map(|algorithm| (algorithm, HasherState::new(algorithm)))
        .collect::<Vec<_>>();
    let mut processed_bytes = 0u64;

    loop {
        context.cancel().check()?;
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        let chunk = &buffer[..bytes_read];
        for (_, state) in &mut states {
            state.update(chunk);
        }
        processed_bytes = processed_bytes.saturating_add(bytes_read as u64);
    }

    (on_progress)(ChecksumProgress {
        processed_bytes,
        total_bytes: processed_bytes,
    });

    Ok(ChecksumValues {
        execution,
        values: states
            .into_iter()
            .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
            .collect(),
    })
}

pub fn crc32_bytes(bytes: &[u8]) -> u32 {
    crc32fast::hash(bytes)
}

pub fn crc16_ccitt_bytes(bytes: &[u8]) -> u16 {
    let mut crc = 0xffffu16;
    for &value in bytes {
        crc ^= u16::from(value) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ CRC16_CCITT_POLYNOMIAL
            } else {
                crc << 1
            };
        }
    }
    crc
}

pub fn md5_bytes(bytes: &[u8]) -> [u8; 16] {
    Md5::digest(bytes).into()
}

pub fn md5_file(path: &Path) -> Result<[u8; 16]> {
    let mut file = File::open(path)?;
    let mut hasher = Md5::new();
    let mut buffer = vec![0u8; MD5_IO_BUFFER_SIZE];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Algorithm {
    Crc32,
    Md5,
    Sha1,
    Sha256,
    Blake3,
    Crc32c,
    Crc16,
    Adler32,
}

impl Algorithm {
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "crc32" => Some(Self::Crc32),
            "md5" => Some(Self::Md5),
            "sha1" => Some(Self::Sha1),
            "sha256" => Some(Self::Sha256),
            "blake3" => Some(Self::Blake3),
            "crc32c" => Some(Self::Crc32c),
            "crc16" => Some(Self::Crc16),
            "adler32" => Some(Self::Adler32),
            _ => None,
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Crc32 => "crc32",
            Self::Md5 => "md5",
            Self::Sha1 => "sha1",
            Self::Sha256 => "sha256",
            Self::Blake3 => "blake3",
            Self::Crc32c => "crc32c",
            Self::Crc16 => "crc16",
            Self::Adler32 => "adler32",
        }
    }
}

pub(super) enum HasherState {
    Crc32(Crc32Hasher),
    Md5(Md5),
    Sha1(Sha1),
    Sha256(Sha256),
    Blake3(Box<Blake3Hasher>),
    Crc32c(u32),
    Crc16(Crc16State<ARC>),
    Adler32(Adler32),
}

impl HasherState {
    pub(super) fn new(algorithm: Algorithm) -> Self {
        match algorithm {
            Algorithm::Crc32 => Self::Crc32(Crc32Hasher::new()),
            Algorithm::Md5 => Self::Md5(Md5::new()),
            Algorithm::Sha1 => Self::Sha1(Sha1::new()),
            Algorithm::Sha256 => Self::Sha256(Sha256::new()),
            Algorithm::Blake3 => Self::Blake3(Box::new(Blake3Hasher::new())),
            Algorithm::Crc32c => Self::Crc32c(0),
            Algorithm::Crc16 => Self::Crc16(Crc16State::<ARC>::new()),
            Algorithm::Adler32 => Self::Adler32(Adler32::new()),
        }
    }

    pub(super) fn update(&mut self, bytes: &[u8]) {
        match self {
            Self::Crc32(state) => state.update(bytes),
            Self::Md5(state) => state.update(bytes),
            Self::Sha1(state) => state.update(bytes),
            Self::Sha256(state) => state.update(bytes),
            Self::Blake3(state) => {
                state.update(bytes);
            }
            Self::Crc32c(state) => *state = crc32c_append(*state, bytes),
            Self::Crc16(state) => state.update(bytes),
            Self::Adler32(state) => state.write_slice(bytes),
        }
    }

    pub(super) fn finalize(self) -> String {
        match self {
            Self::Crc32(state) => format!("{:08x}", state.finalize()),
            Self::Md5(state) => hex_encode(&state.finalize()),
            Self::Sha1(state) => hex_encode(&state.finalize()),
            Self::Sha256(state) => hex_encode(&state.finalize()),
            Self::Blake3(state) => state.finalize().to_hex().to_string(),
            Self::Crc32c(state) => format!("{state:08x}"),
            Self::Crc16(state) => format!("{:04x}", state.get()),
            Self::Adler32(state) => format!("{:08x}", state.checksum()),
        }
    }
}

pub(super) struct WorkerBatch {
    states: Vec<(Algorithm, HasherState)>,
}

impl WorkerBatch {
    pub(super) fn new(algorithms: Vec<Algorithm>) -> Self {
        Self {
            states: algorithms
                .into_iter()
                .map(|algorithm| (algorithm, HasherState::new(algorithm)))
                .collect(),
        }
    }

    pub(super) fn update(&mut self, bytes: &[u8]) {
        for (_, state) in &mut self.states {
            state.update(bytes);
        }
    }

    pub(super) fn into_results(self) -> BTreeMap<String, String> {
        self.states
            .into_iter()
            .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ResolvedRange {
    pub(super) start: u64,
    pub(super) len: u64,
    pub(super) file_len: u64,
    pub(super) explicit: bool,
}

impl ResolvedRange {
    pub(super) fn from_request(
        source: &Path,
        start: Option<u64>,
        length: Option<u64>,
    ) -> Result<Self> {
        let metadata = fs::metadata(source)?;
        let file_len = metadata.len();
        let start = start.unwrap_or(0);
        if start > file_len {
            return Err(RomWeaverError::Validation(format!(
                "checksum range start {start} is past the end of `{}` ({file_len} bytes)",
                source.display()
            )));
        }

        let remaining = file_len.saturating_sub(start);
        let len = length.unwrap_or(remaining);
        if len > remaining {
            return Err(RomWeaverError::Validation(format!(
                "checksum range length {len} exceeds the remaining bytes in `{}`",
                source.display()
            )));
        }

        Ok(Self {
            start,
            len,
            file_len,
            explicit: start != 0 || length.is_some(),
        })
    }

    pub(super) fn end(&self) -> u64 {
        self.start + self.len
    }
}

pub(super) struct MappedRange {
    pub(super) bytes: Vec<u8>,
}

impl MappedRange {
    pub(super) fn bytes(&self) -> &[u8] {
        self.bytes.as_slice()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ChecksumMode {
    Sequential,
    ParallelFanout,
    ParallelCrc32,
    ParallelCrc32c,
    ParallelCrc16,
    ParallelAdler32,
    ParallelBlake3,
}

#[derive(Clone, Debug)]
pub(super) struct ChecksumPlan {
    pub(super) mode: ChecksumMode,
    pub(super) capability: ThreadCapability,
}

impl ChecksumPlan {
    pub(super) fn sequential() -> Self {
        Self {
            mode: ChecksumMode::Sequential,
            capability: ThreadCapability::single_threaded(),
        }
    }

    pub(super) fn parallel(mode: ChecksumMode, max_threads: usize) -> Self {
        Self {
            mode,
            capability: ThreadCapability::parallel(Some(max_threads.max(1))),
        }
    }
}
