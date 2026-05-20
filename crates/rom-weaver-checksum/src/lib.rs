use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use adler2::Adler32;
use blake3::Hasher as Blake3Hasher;
use crc16::{ARC, State as Crc16State};
use crc32c::{crc32c_append, crc32c_combine};
use crc32fast::Hasher as Crc32Hasher;
use md5::{Digest as Md5Digest, Md5};
use rayon::prelude::*;
use rom_weaver_core::{
    CancellationToken, ChecksumCapabilities, ChecksumEngine, ChecksumRequest, OperationContext,
    OperationFamily, OperationReport, Result, RomWeaverError, SharedThreadPool, ThreadBudget,
    ThreadCapability, ThreadExecution,
};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest as Sha2Digest, Sha256};
use tracing::trace;

const SUPPORTED_ALGORITHMS: &[&str] = &[
    "crc32", "md5", "sha1", "sha256", "blake3", "crc32c", "crc16", "adler32",
];
const CACHE_SCHEMA_VERSION: u32 = 1;
const CACHE_DIR_NAME: &str = "cache/checksums-v1";
const MIN_CHUNK_SIZE: usize = 256 * 1024;
const MAX_CHUNK_SIZE: usize = 4 * 1024 * 1024;
const TARGET_CHUNKS_PER_WORKER: u64 = 8;
const FANOUT_PARALLEL_THRESHOLD: u64 = 8 * 1024 * 1024;
const CRC32_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
const CRC32_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
const CRC32_PARALLEL_MAX_THREADS: usize = 4;
const CRC32C_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
const CRC32C_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
const CRC32C_PARALLEL_MAX_THREADS: usize = 4;
const CRC16_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
const CRC16_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
const CRC16_PARALLEL_MAX_THREADS: usize = 4;
const ADLER32_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
const ADLER32_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
const ADLER32_PARALLEL_MAX_THREADS: usize = 4;
const BLAKE3_PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024;
const BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD: u64 = 16 * 1024 * 1024;
const BLAKE3_PARALLEL_MAX_THREADS: usize = 8;
const ADLER32_MODULO: u64 = 65_521;
const CRC16_GF2_DIM: usize = 16;
const CRC16_ARC_REFLECTED_POLY: u16 = 0xA001;

pub struct NativeChecksumEngine;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChecksumValues {
    pub execution: ThreadExecution,
    pub cached_count: usize,
    pub values: BTreeMap<String, String>,
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

    fn run_checksum(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
        stage: &'static str,
    ) -> Result<OperationReport> {
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
        let computed = compute_checksum_values(request, context)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.name().to_string()),
            stage,
            render_label(&algorithms, &computed.values, &range, computed.cached_count),
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

pub fn seed_checksum_file_cache(
    source: &Path,
    algorithms: &BTreeMap<String, String>,
    context: &OperationContext,
) -> Result<()> {
    if algorithms.is_empty() {
        return Ok(());
    }

    let range = ResolvedRange::from_request(source, None, None)?;
    let fingerprint = SourceFingerprint::from_path(source)?;
    let cache = ChecksumCache::new(context.temp_root());
    let mut cached = cache.load(&fingerprint, &range).unwrap_or_default();
    cached.extend(algorithms.clone());
    cache.store(&fingerprint, &range, &cached)?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Algorithm {
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
    fn parse(value: &str) -> Option<Self> {
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

    fn name(self) -> &'static str {
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

enum HasherState {
    Crc32(Crc32Hasher),
    Md5(Md5),
    Sha1(Sha1),
    Sha256(Sha256),
    Blake3(Blake3Hasher),
    Crc32c(u32),
    Crc16(Crc16State<ARC>),
    Adler32(Adler32),
}

impl HasherState {
    fn new(algorithm: Algorithm) -> Self {
        match algorithm {
            Algorithm::Crc32 => Self::Crc32(Crc32Hasher::new()),
            Algorithm::Md5 => Self::Md5(Md5::new()),
            Algorithm::Sha1 => Self::Sha1(Sha1::new()),
            Algorithm::Sha256 => Self::Sha256(Sha256::new()),
            Algorithm::Blake3 => Self::Blake3(Blake3Hasher::new()),
            Algorithm::Crc32c => Self::Crc32c(0),
            Algorithm::Crc16 => Self::Crc16(Crc16State::<ARC>::new()),
            Algorithm::Adler32 => Self::Adler32(Adler32::new()),
        }
    }

    fn update(&mut self, bytes: &[u8]) {
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

    fn finalize(self) -> String {
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

struct WorkerBatch {
    states: Vec<(Algorithm, HasherState)>,
}

impl WorkerBatch {
    fn new(algorithms: Vec<Algorithm>) -> Self {
        Self {
            states: algorithms
                .into_iter()
                .map(|algorithm| (algorithm, HasherState::new(algorithm)))
                .collect(),
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        for (_, state) in &mut self.states {
            state.update(bytes);
        }
    }

    fn into_results(self) -> BTreeMap<String, String> {
        self.states
            .into_iter()
            .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedRange {
    start: u64,
    len: u64,
    file_len: u64,
    explicit: bool,
}

impl ResolvedRange {
    fn from_request(source: &Path, start: Option<u64>, length: Option<u64>) -> Result<Self> {
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

    fn end(&self) -> u64 {
        self.start + self.len
    }
}

#[derive(Clone, Debug)]
struct SourceFingerprint {
    canonical_path: PathBuf,
    file_len: u64,
    modified_ns: u128,
}

impl SourceFingerprint {
    fn from_path(path: &Path) -> Result<Self> {
        let metadata = fs::metadata(path)?;
        let canonical_path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();

        Ok(Self {
            canonical_path,
            file_len: metadata.len(),
            modified_ns,
        })
    }
}

struct MappedRange {
    bytes: Vec<u8>,
}

impl MappedRange {
    fn bytes(&self) -> &[u8] {
        self.bytes.as_slice()
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheEntry {
    version: u32,
    source: String,
    file_len: u64,
    modified_ns: u128,
    start: u64,
    len: u64,
    algorithms: BTreeMap<String, String>,
}

struct ChecksumCache {
    root: PathBuf,
}

impl ChecksumCache {
    fn new(temp_root: &Path) -> Self {
        Self {
            root: temp_root.join(CACHE_DIR_NAME),
        }
    }

    fn load(
        &self,
        fingerprint: &SourceFingerprint,
        range: &ResolvedRange,
    ) -> Option<BTreeMap<String, String>> {
        let path = self.entry_path(fingerprint, range);
        let bytes = fs::read(path).ok()?;
        let entry = serde_json::from_slice::<CacheEntry>(&bytes).ok()?;
        if entry.version != CACHE_SCHEMA_VERSION {
            return None;
        }
        Some(entry.algorithms)
    }

    fn store(
        &self,
        fingerprint: &SourceFingerprint,
        range: &ResolvedRange,
        algorithms: &BTreeMap<String, String>,
    ) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;

        let path = self.entry_path(fingerprint, range);
        let entry = CacheEntry {
            version: CACHE_SCHEMA_VERSION,
            source: fingerprint.canonical_path.display().to_string(),
            file_len: fingerprint.file_len,
            modified_ns: fingerprint.modified_ns,
            start: range.start,
            len: range.len,
            algorithms: algorithms.clone(),
        };
        let payload = serde_json::to_vec(&entry)?;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let temp_path = path.with_extension(format!("{unique}.tmp"));
        {
            let mut file = File::create(&temp_path)?;
            file.write_all(&payload)?;
        }

        if fs::rename(&temp_path, &path).is_err() {
            let _ = fs::remove_file(&path);
            fs::rename(&temp_path, &path)?;
        }
        Ok(())
    }

    fn entry_path(&self, fingerprint: &SourceFingerprint, range: &ResolvedRange) -> PathBuf {
        let key = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
            fingerprint.canonical_path.display(),
            fingerprint.file_len,
            fingerprint.modified_ns,
            range.start,
            range.len
        );
        let mut digest = Sha1::new();
        digest.update(key.as_bytes());
        let file_name = format!("{}.json", hex_encode(&digest.finalize()));
        self.root.join(file_name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChecksumMode {
    Sequential,
    ParallelFanout,
    ParallelCrc32,
    ParallelCrc32c,
    ParallelCrc16,
    ParallelAdler32,
    ParallelBlake3,
}

#[derive(Clone, Debug)]
struct ChecksumPlan {
    mode: ChecksumMode,
    capability: ThreadCapability,
}

impl ChecksumPlan {
    fn sequential() -> Self {
        Self {
            mode: ChecksumMode::Sequential,
            capability: ThreadCapability::single_threaded(),
        }
    }

    fn parallel(mode: ChecksumMode, max_threads: usize) -> Self {
        Self {
            mode,
            capability: ThreadCapability::parallel(Some(max_threads.max(1))),
        }
    }
}

fn resolve_algorithms(values: &[String]) -> Result<Vec<Algorithm>> {
    let mut algorithms = Vec::new();
    let mut seen = BTreeSet::new();
    for value in values {
        let algorithm = Algorithm::parse(value).ok_or_else(|| {
            RomWeaverError::Validation(format!("unsupported checksum algorithm `{value}`"))
        })?;
        if seen.insert(algorithm) {
            algorithms.push(algorithm);
        }
    }
    Ok(algorithms)
}

fn compute_checksum_values(
    request: &ChecksumRequest,
    context: &OperationContext,
) -> Result<ChecksumValues> {
    trace!(
        source = %request.source.display(),
        algorithms = ?request.algorithms,
        start = ?request.start,
        length = ?request.length,
        "computing checksum values"
    );
    let algorithms = resolve_algorithms(&request.algorithms)?;
    let range = ResolvedRange::from_request(&request.source, request.start, request.length)?;
    let fingerprint = SourceFingerprint::from_path(&request.source)?;
    let cache = ChecksumCache::new(context.temp_root());

    let mut cached_results = cache.load(&fingerprint, &range).unwrap_or_default();
    let missing_algorithms = algorithms
        .iter()
        .copied()
        .filter(|algorithm| !cached_results.contains_key(algorithm.name()))
        .collect::<Vec<_>>();

    let cached_count = algorithms.len().saturating_sub(missing_algorithms.len());
    trace!(
        source = %request.source.display(),
        total_algorithms = algorithms.len(),
        missing_algorithms = missing_algorithms.len(),
        cached_algorithms = cached_count,
        "resolved checksum cache coverage"
    );
    let execution = if missing_algorithms.is_empty() {
        trace!(source = %request.source.display(), "checksum cache hit for all algorithms");
        cache_hit_execution(context.thread_budget())
    } else {
        let plan = plan_checksum(&missing_algorithms, &range);
        trace!(
            source = %request.source.display(),
            mode = ?plan.mode,
            capability = ?plan.capability,
            "selected checksum execution plan"
        );
        let (execution, computed) =
            execute_plan(&request.source, &range, &missing_algorithms, context, &plan)?;
        cached_results.extend(computed);
        let _ = cache.store(&fingerprint, &range, &cached_results);
        execution
    };

    Ok(ChecksumValues {
        execution,
        cached_count,
        values: cached_results,
    })
}

fn plan_checksum(algorithms: &[Algorithm], range: &ResolvedRange) -> ChecksumPlan {
    if algorithms == [Algorithm::Crc32] && range.len >= CRC32_PARALLEL_THRESHOLD {
        let max_threads = parallel_crc32_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelCrc32, max_threads);
        }
    }

    if algorithms == [Algorithm::Crc32c] && range.len >= CRC32C_PARALLEL_THRESHOLD {
        let max_threads = parallel_crc32c_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelCrc32c, max_threads);
        }
    }

    if algorithms == [Algorithm::Crc16] && range.len >= CRC16_PARALLEL_THRESHOLD {
        let max_threads = parallel_crc16_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelCrc16, max_threads);
        }
    }

    if algorithms == [Algorithm::Adler32] && range.len >= ADLER32_PARALLEL_THRESHOLD {
        let max_threads = parallel_adler32_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelAdler32, max_threads);
        }
    }

    if algorithms == [Algorithm::Blake3] && range.len >= BLAKE3_PARALLEL_THRESHOLD {
        let max_threads = parallel_blake3_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelBlake3, max_threads);
        }
    }

    if algorithms.len() > 1 && range.len >= FANOUT_PARALLEL_THRESHOLD {
        return ChecksumPlan::parallel(ChecksumMode::ParallelFanout, algorithms.len());
    }

    ChecksumPlan::sequential()
}

fn execute_plan(
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    context: &OperationContext,
    plan: &ChecksumPlan,
) -> Result<(ThreadExecution, BTreeMap<String, String>)> {
    trace!(
        source = %source.display(),
        start = range.start,
        length = range.len,
        algorithms = ?algorithms,
        mode = ?plan.mode,
        capability = ?plan.capability,
        "executing checksum plan"
    );
    let mapped = map_range(source, range);
    let execution = context.plan_threads(plan.capability.clone());
    trace!(
        source = %source.display(),
        mapped = mapped.is_some(),
        requested_threads = execution.requested_threads,
        effective_threads = execution.effective_threads,
        used_parallelism = execution.used_parallelism,
        "checksum execution thread plan resolved"
    );
    if !execution.used_parallelism || execution.effective_threads == 1 {
        let computed = compute_sequential(
            mapped.as_ref(),
            source,
            range,
            algorithms,
            &execution,
            context.cancel(),
        )?;
        trace!(
            source = %source.display(),
            algorithm_count = computed.len(),
            "checksum plan completed with sequential execution"
        );
        return Ok((execution, computed));
    }

    let (_, pool) = context.build_pool(plan.capability.clone())?;
    let computed = match plan.mode {
        ChecksumMode::Sequential => compute_sequential(
            mapped.as_ref(),
            source,
            range,
            algorithms,
            &execution,
            context.cancel(),
        )?,
        ChecksumMode::ParallelFanout => compute_parallel_fanout(
            mapped.as_ref(),
            source,
            range,
            algorithms,
            &pool,
            &execution,
            context.cancel(),
        )?,
        ChecksumMode::ParallelCrc32 => compute_parallel_crc32(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
        )?,
        ChecksumMode::ParallelCrc32c => compute_parallel_crc32c(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
        )?,
        ChecksumMode::ParallelCrc16 => compute_parallel_crc16(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
        )?,
        ChecksumMode::ParallelAdler32 => compute_parallel_adler32(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
        )?,
        ChecksumMode::ParallelBlake3 => compute_parallel_blake3(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
        )?,
    };
    trace!(
        source = %source.display(),
        algorithm_count = computed.len(),
        "checksum plan completed with pooled execution"
    );

    Ok((execution, computed))
}

fn compute_sequential(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_sequential_mapped(mapped.bytes(), algorithms, execution, cancel);
    }

    compute_sequential_stream(source, range, algorithms, execution, cancel)
}

fn compute_sequential_mapped(
    bytes: &[u8],
    algorithms: &[Algorithm],
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = tuned_chunk_size(bytes.len() as u64, execution.effective_threads);
    let mut states = algorithms
        .iter()
        .copied()
        .map(|algorithm| (algorithm, HasherState::new(algorithm)))
        .collect::<Vec<_>>();

    for chunk in bytes.chunks(chunk_size.max(1)) {
        cancel.check()?;
        for (_, state) in &mut states {
            state.update(chunk);
        }
    }

    Ok(states
        .into_iter()
        .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
        .collect())
}

fn compute_sequential_stream(
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let chunk_size = tuned_chunk_size(range.len, execution.effective_threads);
    let mut buffer = vec![0u8; chunk_size];
    let mut states = algorithms
        .iter()
        .copied()
        .map(|algorithm| (algorithm, HasherState::new(algorithm)))
        .collect::<Vec<_>>();

    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range was fully read",
            )));
        }
        let chunk = &buffer[..bytes_read];
        for (_, state) in &mut states {
            state.update(chunk);
        }
        remaining -= bytes_read as u64;
    }

    Ok(states
        .into_iter()
        .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
        .collect())
}

fn compute_parallel_fanout(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_fanout_mapped(mapped.bytes(), algorithms, pool, execution, cancel);
    }

    compute_parallel_fanout_stream(source, range, algorithms, pool, execution, cancel)
}

fn compute_parallel_fanout_mapped(
    bytes: &[u8],
    algorithms: &[Algorithm],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let worker_count = execution.effective_threads.min(algorithms.len()).max(1);
    let mut workers = partition_algorithms(algorithms, worker_count)
        .into_iter()
        .map(WorkerBatch::new)
        .collect::<Vec<_>>();

    let chunk_size = tuned_chunk_size(bytes.len() as u64, worker_count);
    for chunk in bytes.chunks(chunk_size.max(1)) {
        cancel.check()?;
        pool.install(|| {
            workers
                .par_iter_mut()
                .for_each(|worker| worker.update(chunk));
        });
    }

    let mut results = BTreeMap::new();
    for worker in workers {
        results.extend(worker.into_results());
    }
    Ok(results)
}

fn compute_parallel_fanout_stream(
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let worker_count = execution.effective_threads.min(algorithms.len()).max(1);
    let mut workers = partition_algorithms(algorithms, worker_count)
        .into_iter()
        .map(WorkerBatch::new)
        .collect::<Vec<_>>();

    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let chunk_size = tuned_chunk_size(range.len, worker_count);
    let mut buffer = vec![0u8; chunk_size];

    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        pool.install(|| {
            workers
                .par_iter_mut()
                .for_each(|worker| worker.update(chunk));
        });
        remaining -= bytes_read as u64;
    }

    let mut results = BTreeMap::new();
    for worker in workers {
        results.extend(worker.into_results());
    }
    Ok(results)
}

fn compute_parallel_crc32(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_crc32_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_crc32_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_crc32_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                let mut hasher = Crc32Hasher::new();
                hasher.update(chunk);
                Ok::<_, RomWeaverError>(hasher)
            })
            .collect::<Vec<_>>()
    });

    let combined = combine_crc32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert("crc32".to_string(), format!("{:08x}", combined.finalize()));
    Ok(results)
}

fn compute_parallel_crc32_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];

    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| {
            let mut hasher = Crc32Hasher::new();
            hasher.update(chunk);
            hasher
        });
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }

    let combined = combine_crc32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert("crc32".to_string(), format!("{:08x}", combined.finalize()));
    Ok(results)
}

fn compute_parallel_crc32c(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_crc32c_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_crc32c_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_crc32c_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                Ok::<_, RomWeaverError>((crc32c_append(0, chunk), chunk.len()))
            })
            .collect::<Vec<_>>()
    });
    let combined = combine_crc32c_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc32c.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_crc32c_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];
    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| (crc32c_append(0, chunk), chunk.len()));
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }
    let combined = combine_crc32c_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc32c.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_crc16(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_crc16_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_crc16_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_crc16_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                let mut state = Crc16State::<ARC>::new();
                state.update(chunk);
                Ok::<_, RomWeaverError>((state.get(), chunk.len()))
            })
            .collect::<Vec<_>>()
    });
    let combined = combine_crc16_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc16.name().to_string(),
        format!("{combined:04x}"),
    );
    Ok(results)
}

fn compute_parallel_crc16_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];
    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| {
            let mut state = Crc16State::<ARC>::new();
            state.update(chunk);
            (state.get(), chunk.len())
        });
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }
    let combined = combine_crc16_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc16.name().to_string(),
        format!("{combined:04x}"),
    );
    Ok(results)
}

fn compute_parallel_adler32(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_adler32_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_adler32_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_adler32_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                Ok::<_, RomWeaverError>((adler32_checksum(chunk), chunk.len()))
            })
            .collect::<Vec<_>>()
    });
    let combined = combine_adler32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Adler32.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_adler32_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];
    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| (adler32_checksum(chunk), chunk.len()));
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }
    let combined = combine_adler32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Adler32.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_blake3(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let mut hasher = Blake3Hasher::new();

    if let Some(mapped) = mapped {
        cancel.check()?;
        pool.install(|| {
            hasher.update_rayon(mapped.bytes());
        });
    } else {
        let mut file = File::open(source)?;
        file.seek(SeekFrom::Start(range.start))?;

        let mut remaining = range.len;
        let chunk_size = tuned_chunk_size(range.len, execution.effective_threads);
        let mut buffer = vec![0u8; chunk_size];
        while remaining > 0 {
            cancel.check()?;
            let limit = remaining.min(buffer.len() as u64) as usize;
            let bytes_read = file.read(&mut buffer[..limit])?;
            if bytes_read == 0 {
                return Err(RomWeaverError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "source ended before checksum range was fully read",
                )));
            }

            let chunk = &buffer[..bytes_read];
            pool.install(|| {
                hasher.update_rayon(chunk);
            });
            remaining -= bytes_read as u64;
        }
    }

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Blake3.name().to_string(),
        hasher.finalize().to_hex().to_string(),
    );
    Ok(results)
}

fn combine_crc32_partials(partials: Vec<Result<Crc32Hasher>>) -> Result<Crc32Hasher> {
    let mut partials = partials.into_iter();
    let mut combined = match partials.next() {
        Some(partial) => partial?,
        None => Crc32Hasher::new(),
    };
    for partial in partials {
        combined.combine(&partial?);
    }
    Ok(combined)
}

fn combine_crc32c_partials(partials: Vec<Result<(u32, usize)>>) -> Result<u32> {
    let mut partials = partials.into_iter();
    let (mut combined, _) = match partials.next() {
        Some(partial) => partial?,
        None => (0, 0),
    };
    for partial in partials {
        let (crc, len) = partial?;
        combined = crc32c_combine(combined, crc, len);
    }
    Ok(combined)
}

fn gf2_matrix_times_u16(mat: &[u16; CRC16_GF2_DIM], mut vec: u16) -> u16 {
    let mut sum = 0u16;
    let mut idx = 0usize;
    while vec > 0 {
        if vec & 1 == 1 {
            sum ^= mat[idx];
        }
        vec >>= 1;
        idx += 1;
    }
    sum
}

fn gf2_matrix_square_u16(square: &mut [u16; CRC16_GF2_DIM], mat: &[u16; CRC16_GF2_DIM]) {
    for n in 0..CRC16_GF2_DIM {
        square[n] = gf2_matrix_times_u16(mat, mat[n]);
    }
}

fn crc16_arc_combine(mut crc1: u16, crc2: u16, mut len2: usize) -> u16 {
    let mut row = 1u16;
    let mut even = [0u16; CRC16_GF2_DIM];
    let mut odd = [0u16; CRC16_GF2_DIM];

    if len2 == 0 {
        return crc1;
    }

    odd[0] = CRC16_ARC_REFLECTED_POLY;
    for value in odd.iter_mut().skip(1) {
        *value = row;
        row <<= 1;
    }

    gf2_matrix_square_u16(&mut even, &odd);
    gf2_matrix_square_u16(&mut odd, &even);

    loop {
        gf2_matrix_square_u16(&mut even, &odd);
        if len2 & 1 == 1 {
            crc1 = gf2_matrix_times_u16(&even, crc1);
        }
        len2 >>= 1;
        if len2 == 0 {
            break;
        }

        gf2_matrix_square_u16(&mut odd, &even);
        if len2 & 1 == 1 {
            crc1 = gf2_matrix_times_u16(&odd, crc1);
        }
        len2 >>= 1;
        if len2 == 0 {
            break;
        }
    }

    crc1 ^ crc2
}

fn combine_crc16_partials(partials: Vec<Result<(u16, usize)>>) -> Result<u16> {
    let mut partials = partials.into_iter();
    let (mut combined, _) = match partials.next() {
        Some(partial) => partial?,
        None => (0, 0),
    };
    for partial in partials {
        let (crc, len) = partial?;
        combined = crc16_arc_combine(combined, crc, len);
    }
    Ok(combined)
}

fn adler32_checksum(bytes: &[u8]) -> u32 {
    let mut state = Adler32::new();
    state.write_slice(bytes);
    state.checksum()
}

fn adler32_combine(adler1: u32, adler2: u32, len2: usize) -> u32 {
    if len2 == 0 {
        return adler1;
    }

    let a1 = u64::from(adler1 & 0xffff);
    let b1 = u64::from((adler1 >> 16) & 0xffff);
    let a2 = u64::from(adler2 & 0xffff);
    let b2 = u64::from((adler2 >> 16) & 0xffff);

    let a = (a1 + a2 + ADLER32_MODULO - 1) % ADLER32_MODULO;
    let len2_mod = (len2 as u64) % ADLER32_MODULO;
    let a1_minus_one = (a1 + ADLER32_MODULO - 1) % ADLER32_MODULO;
    let b = (b1 + b2 + (len2_mod * a1_minus_one)) % ADLER32_MODULO;

    ((b as u32) << 16) | (a as u32)
}

fn combine_adler32_partials(partials: Vec<Result<(u32, usize)>>) -> Result<u32> {
    let mut partials = partials.into_iter();
    let (mut combined, _) = match partials.next() {
        Some(partial) => partial?,
        None => (1, 0),
    };
    for partial in partials {
        let (crc, len) = partial?;
        combined = adler32_combine(combined, crc, len);
    }
    Ok(combined)
}

fn partition_algorithms(algorithms: &[Algorithm], worker_count: usize) -> Vec<Vec<Algorithm>> {
    let mut groups = vec![Vec::new(); worker_count];
    for (index, algorithm) in algorithms.iter().copied().enumerate() {
        groups[index % worker_count].push(algorithm);
    }
    groups
        .into_iter()
        .filter(|group| !group.is_empty())
        .collect()
}

fn parallel_crc32_max_threads(range_len: u64) -> usize {
    ((range_len / CRC32_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, CRC32_PARALLEL_MAX_THREADS)
}

fn parallel_crc32c_max_threads(range_len: u64) -> usize {
    ((range_len / CRC32C_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, CRC32C_PARALLEL_MAX_THREADS)
}

fn parallel_crc16_max_threads(range_len: u64) -> usize {
    ((range_len / CRC16_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, CRC16_PARALLEL_MAX_THREADS)
}

fn parallel_adler32_max_threads(range_len: u64) -> usize {
    ((range_len / ADLER32_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, ADLER32_PARALLEL_MAX_THREADS)
}

fn parallel_blake3_max_threads(range_len: u64) -> usize {
    ((range_len / BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, BLAKE3_PARALLEL_MAX_THREADS)
}

fn crc32_parallel_chunk_size(range_len: u64, worker_count: usize) -> u64 {
    range_len.div_ceil(worker_count.max(1) as u64).max(1)
}

fn map_range(source: &Path, range: &ResolvedRange) -> Option<MappedRange> {
    if range.file_len == 0 || range.len == 0 {
        return None;
    }

    let mut file = File::open(source).ok()?;
    let len = usize::try_from(range.len).ok()?;
    file.seek(SeekFrom::Start(range.start)).ok()?;
    let mut bytes = vec![0u8; len];
    if file.read_exact(&mut bytes).is_err() {
        return None;
    }
    Some(MappedRange { bytes })
}

fn cache_hit_execution(budget: ThreadBudget) -> ThreadExecution {
    ThreadExecution {
        requested_threads: budget.requested_threads(),
        effective_threads: 1,
        thread_mode: budget.mode(),
        used_parallelism: false,
        thread_fallback: false,
        thread_fallback_reason: None,
    }
}

fn tuned_chunk_size(range_len: u64, worker_count: usize) -> usize {
    let worker_count = worker_count.max(1) as u64;
    let suggested = (range_len / (worker_count * TARGET_CHUNKS_PER_WORKER)).max(1);
    suggested.clamp(MIN_CHUNK_SIZE as u64, MAX_CHUNK_SIZE as u64) as usize
}

fn render_label(
    algorithms: &[Algorithm],
    results: &BTreeMap<String, String>,
    range: &ResolvedRange,
    cached_count: usize,
) -> String {
    let mut parts = Vec::with_capacity(algorithms.len() + 2);
    if range.explicit {
        parts.push(format!("range={}..{}", range.start, range.end()));
    }
    for algorithm in algorithms {
        if let Some(value) = results.get(algorithm.name()) {
            parts.push(format!("{}={value}", algorithm.name()));
        }
    }
    if cached_count == algorithms.len() {
        parts.push("cache=hit".to_string());
    } else if cached_count > 0 {
        parts.push(format!(
            "cache=partial({cached_count}/{})",
            algorithms.len()
        ));
    }
    parts.join(" ")
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub fn supported_algorithms() -> &'static [&'static str] {
    SUPPORTED_ALGORITHMS
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::Write,
        path::{Path, PathBuf},
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use proptest::prelude::*;
    use rom_weaver_core::{
        CancellationToken, ChecksumEngine, ChecksumRequest, NoopProgressSink, OperationContext,
        ThreadBudget,
    };

    use super::{
        ADLER32_PARALLEL_MIN_BYTES_PER_THREAD, ADLER32_PARALLEL_THRESHOLD, ARC,
        BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD, BLAKE3_PARALLEL_THRESHOLD,
        CRC16_PARALLEL_MIN_BYTES_PER_THREAD, CRC16_PARALLEL_THRESHOLD,
        CRC32_PARALLEL_MIN_BYTES_PER_THREAD, CRC32_PARALLEL_THRESHOLD,
        CRC32C_PARALLEL_MIN_BYTES_PER_THREAD, CRC32C_PARALLEL_THRESHOLD, ChecksumMode, Crc16State,
        FANOUT_PARALLEL_THRESHOLD, NativeChecksumEngine, ResolvedRange, adler32_checksum,
        combine_adler32_partials, combine_crc16_partials, combine_crc32c_partials, crc32c_append,
        plan_checksum, supported_algorithms,
    };

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let sequence = TEST_DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "rom-weaver-checksum-tests-{}-{unique}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn checksum_context(root: &Path, threads: ThreadBudget) -> OperationContext {
        OperationContext::new(
            threads,
            root.join("op"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn write_patterned_file(path: &Path, len: usize) {
        let pattern = (0..(64 * 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut file = File::create(path).expect("fixture");
        let mut remaining = len;
        while remaining > 0 {
            let chunk = remaining.min(pattern.len());
            file.write_all(&pattern[..chunk]).expect("write fixture");
            remaining -= chunk;
        }
    }

    fn chunk_boundaries(data_len: usize, split_hints: &[u16]) -> Vec<usize> {
        let mut boundaries = Vec::with_capacity(split_hints.len() + 2);
        boundaries.push(0);
        boundaries.push(data_len);
        for hint in split_hints {
            boundaries.push(usize::from(*hint) % (data_len.saturating_add(1)));
        }
        boundaries.sort_unstable();
        boundaries.dedup();
        if boundaries.first().copied() != Some(0) {
            boundaries.insert(0, 0);
        }
        if boundaries.last().copied() != Some(data_len) {
            boundaries.push(data_len);
        }
        boundaries
    }

    fn assert_parallel_range_for_algorithm(
        algorithm: &str,
        file_name: &str,
        threshold: u64,
        min_bytes_per_thread: u64,
    ) {
        let temp = TestDir::new();
        let source = temp.path().join(file_name);
        let range_start = 1_u64 << 20;
        let range_len = threshold + min_bytes_per_thread;
        let file_len = range_start + range_len + (1_u64 << 20);
        write_patterned_file(
            &source,
            usize::try_from(file_len).expect("range fixture length fits usize"),
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec![algorithm.into()],
            start: Some(range_start),
            length: Some(range_len),
        };

        let sequential = NativeChecksumEngine
            .checksum_range(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_range(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        assert!(parallel.label.contains(&format!(
            "range={}..{}",
            range_start,
            range_start + range_len
        )));
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    proptest! {
        #[test]
        fn crc32c_chunk_combine_matches_sequential(
            data in proptest::collection::vec(any::<u8>(), 0..(512 * 1024)),
            split_hints in proptest::collection::vec(any::<u16>(), 0..32),
        ) {
            let boundaries = chunk_boundaries(data.len(), &split_hints);
            let mut partials = Vec::with_capacity(boundaries.len().saturating_sub(1));
            for window in boundaries.windows(2) {
                let start = window[0];
                let end = window[1];
                let chunk = &data[start..end];
                partials.push(Ok((crc32c_append(0, chunk), chunk.len())));
            }

            let combined = combine_crc32c_partials(partials).expect("combine");
            let sequential = crc32c_append(0, &data);
            prop_assert_eq!(combined, sequential);
        }
    }

    proptest! {
        #[test]
        fn crc16_chunk_combine_matches_sequential(
            data in proptest::collection::vec(any::<u8>(), 0..(512 * 1024)),
            split_hints in proptest::collection::vec(any::<u16>(), 0..32),
        ) {
            let boundaries = chunk_boundaries(data.len(), &split_hints);
            let mut partials = Vec::with_capacity(boundaries.len().saturating_sub(1));
            for window in boundaries.windows(2) {
                let start = window[0];
                let end = window[1];
                let chunk = &data[start..end];
                let mut state = Crc16State::<ARC>::new();
                state.update(chunk);
                partials.push(Ok((state.get(), chunk.len())));
            }

            let combined = combine_crc16_partials(partials).expect("combine");
            let mut sequential_state = Crc16State::<ARC>::new();
            sequential_state.update(&data);
            let sequential = sequential_state.get();
            prop_assert_eq!(combined, sequential);
        }
    }

    proptest! {
        #[test]
        fn adler32_chunk_combine_matches_sequential(
            data in proptest::collection::vec(any::<u8>(), 0..(512 * 1024)),
            split_hints in proptest::collection::vec(any::<u16>(), 0..32),
        ) {
            let boundaries = chunk_boundaries(data.len(), &split_hints);
            let mut partials = Vec::with_capacity(boundaries.len().saturating_sub(1));
            for window in boundaries.windows(2) {
                let start = window[0];
                let end = window[1];
                let chunk = &data[start..end];
                partials.push(Ok((adler32_checksum(chunk), chunk.len())));
            }

            let combined = combine_adler32_partials(partials).expect("combine");
            let sequential = adler32_checksum(&data);
            prop_assert_eq!(combined, sequential);
        }
    }

    #[test]
    fn registry_contains_planned_algorithms() {
        assert_eq!(
            supported_algorithms(),
            &[
                "crc32", "md5", "sha1", "sha256", "blake3", "crc32c", "crc16", "adler32",
            ]
        );
    }

    #[test]
    fn checksum_file_reports_expected_digests() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let context = checksum_context(temp.path(), ThreadBudget::Fixed(4));
        let request = ChecksumRequest {
            source,
            algorithms: vec![
                "crc32".into(),
                "md5".into(),
                "sha1".into(),
                "sha256".into(),
                "blake3".into(),
                "crc32c".into(),
            ],
            start: None,
            length: None,
        };

        let report = NativeChecksumEngine
            .checksum_file(&request, &context)
            .expect("checksum report");

        assert_eq!(report.stage, "checksum");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(report.label.contains("crc32=0d4a1185"));
        assert!(
            report
                .label
                .contains("md5=5eb63bbbe01eeed093cb22bb8f5acdc3")
        );
        assert!(
            report
                .label
                .contains("sha1=2aae6c35c94fcfb415dbe95f408b9ce91ee846ed")
        );
        assert!(
            report.label.contains(
                "sha256=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
            )
        );
        assert!(
            report.label.contains(
                "blake3=d74981efa70a0c880b8d8c1985d075dbcbf679b99a5f9914e5aaf96b831a9e24"
            )
        );
        assert!(report.label.contains("crc32c=c99465aa"));
        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
    }

    #[test]
    fn large_multi_algorithm_request_uses_parallel_fanout() {
        let temp = TestDir::new();
        let source = temp.path().join("large.bin");
        write_patterned_file(&source, FANOUT_PARALLEL_THRESHOLD as usize + (1 << 20));

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into(), "md5".into(), "sha1".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert_eq!(execution.effective_threads, 3);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_crc32_uses_parallel_chunks_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-crc32.bin");
        write_patterned_file(
            &source,
            (CRC32_PARALLEL_THRESHOLD + CRC32_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_blake3_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-blake3.bin");
        write_patterned_file(
            &source,
            (BLAKE3_PARALLEL_THRESHOLD + BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["blake3".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_crc32c_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-crc32c.bin");
        write_patterned_file(
            &source,
            (CRC32C_PARALLEL_THRESHOLD + CRC32C_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32c".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_crc16_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-crc16.bin");
        write_patterned_file(
            &source,
            (CRC16_PARALLEL_THRESHOLD + CRC16_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc16".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_adler32_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-adler32.bin");
        write_patterned_file(
            &source,
            (ADLER32_PARALLEL_THRESHOLD + ADLER32_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["adler32".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_crc32c_range_uses_parallel_mode_on_large_files() {
        assert_parallel_range_for_algorithm(
            "crc32c",
            "large-range-crc32c.bin",
            CRC32C_PARALLEL_THRESHOLD,
            CRC32C_PARALLEL_MIN_BYTES_PER_THREAD,
        );
    }

    #[test]
    fn standalone_crc16_range_uses_parallel_mode_on_large_files() {
        assert_parallel_range_for_algorithm(
            "crc16",
            "large-range-crc16.bin",
            CRC16_PARALLEL_THRESHOLD,
            CRC16_PARALLEL_MIN_BYTES_PER_THREAD,
        );
    }

    #[test]
    fn standalone_adler32_range_uses_parallel_mode_on_large_files() {
        assert_parallel_range_for_algorithm(
            "adler32",
            "large-range-adler32.bin",
            ADLER32_PARALLEL_THRESHOLD,
            ADLER32_PARALLEL_MIN_BYTES_PER_THREAD,
        );
    }

    #[test]
    fn planner_keeps_standalone_algorithms_sequential_below_threshold() {
        let cases: &[(Vec<String>, u64)] = &[
            (vec!["crc32".into()], CRC32_PARALLEL_THRESHOLD - 1),
            (vec!["crc32c".into()], CRC32C_PARALLEL_THRESHOLD - 1),
            (vec!["crc16".into()], CRC16_PARALLEL_THRESHOLD - 1),
            (vec!["adler32".into()], ADLER32_PARALLEL_THRESHOLD - 1),
            (vec!["blake3".into()], BLAKE3_PARALLEL_THRESHOLD - 1),
        ];
        for (values, len) in cases {
            let algorithms = super::resolve_algorithms(values).expect("algorithms");
            let range = ResolvedRange {
                start: 0,
                len: *len,
                file_len: *len,
                explicit: false,
            };
            let plan = plan_checksum(&algorithms, &range);
            assert_eq!(plan.mode, ChecksumMode::Sequential);
        }
    }

    #[test]
    fn checksum_range_respects_requested_slice() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let context = checksum_context(temp.path(), ThreadBudget::Fixed(8));
        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into(), "md5".into(), "sha1".into()],
            start: Some(6),
            length: Some(5),
        };

        let report = NativeChecksumEngine
            .checksum_range(&request, &context)
            .expect("checksum report");

        assert_eq!(report.stage, "checksum-range");
        assert!(report.label.contains("range=6..11"));
        assert!(report.label.contains("crc32=3a771143"));
        assert!(
            report
                .label
                .contains("md5=7d793037a0760186574b0282f2f435e7")
        );
        assert!(
            report
                .label
                .contains("sha1=7c211433f02071597741e6ff5a8ea34789abbf43")
        );
    }

    #[test]
    fn checksum_cache_hits_on_repeat_requests() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into(), "md5".into()],
            start: None,
            length: None,
        };

        let first = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(4)),
            )
            .expect("first report");
        let second = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(4)),
            )
            .expect("second report");

        assert!(!first.label.contains("cache=hit"));
        assert!(second.label.contains("cache=hit"));
        let execution = second.thread_execution.expect("thread execution");
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
    }

    #[test]
    fn checksum_cache_invalidates_when_source_changes() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let request = ChecksumRequest {
            source: source.clone(),
            algorithms: vec!["crc32".into()],
            start: None,
            length: None,
        };

        let first = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(2)),
            )
            .expect("first report");

        fs::write(&source, b"hello world!").expect("updated fixture");

        let second = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(2)),
            )
            .expect("second report");

        assert_ne!(first.label, second.label);
        assert!(!second.label.contains("cache=hit"));
    }

    #[test]
    fn checksum_range_rejects_out_of_bounds_requests() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello").expect("fixture");

        let request = ChecksumRequest {
            source,
            algorithms: vec!["sha1".into()],
            start: Some(6),
            length: Some(1),
        };

        let error = NativeChecksumEngine
            .checksum_range(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(1)),
            )
            .expect_err("range should fail");

        assert!(
            error
                .to_string()
                .contains("checksum range start 6 is past the end")
        );
    }
}
