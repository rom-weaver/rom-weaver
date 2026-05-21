use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    fs::{self, File},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use adler2::Adler32;
use blake3::Hasher as Blake3Hasher;
use crc16::{State as Crc16State, ARC};
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
const MAX_EAGER_MAP_RANGE_BYTES: u64 = 32 * 1024 * 1024;
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
const CRC16_CCITT_POLYNOMIAL: u16 = 0x1021;
const MD5_IO_BUFFER_SIZE: usize = 64 * 1024;

pub struct NativeChecksumEngine;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChecksumValues {
    pub execution: ThreadExecution,
    pub cached_count: usize,
    pub values: BTreeMap<String, String>,
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

struct ChecksumProgressTracker<'a> {
    total_bytes: u64,
    processed_bytes: u64,
    next_percent: u64,
    callback: &'a mut dyn FnMut(ChecksumProgress),
}

impl<'a> ChecksumProgressTracker<'a> {
    fn new(total_bytes: u64, callback: &'a mut dyn FnMut(ChecksumProgress)) -> Self {
        Self {
            total_bytes,
            processed_bytes: 0,
            next_percent: 1,
            callback,
        }
    }

    fn advance(&mut self, delta_bytes: u64) {
        if self.total_bytes == 0 {
            return;
        }
        self.processed_bytes = self
            .processed_bytes
            .saturating_add(delta_bytes)
            .min(self.total_bytes);
        self.maybe_emit();
    }

    fn finish(&mut self) {
        if self.total_bytes == 0 {
            return;
        }
        self.processed_bytes = self.total_bytes;
        self.maybe_emit();
    }

    fn maybe_emit(&mut self) {
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

    fn run_checksum(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
        stage: &'static str,
    ) -> Result<OperationReport> {
        let mut noop_progress = |_progress: ChecksumProgress| {};
        self.run_checksum_with_progress(request, context, stage, &mut noop_progress)
    }

    fn run_checksum_with_progress<F>(
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
    let chunk_size = tuned_chunk_size(MAX_EAGER_MAP_RANGE_BYTES, execution.effective_threads).max(1);
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
        cached_count: 0,
        values: states
            .into_iter()
            .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
            .collect(),
    })
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
        let reader = BufReader::new(File::open(path).ok()?);
        let entry = serde_json::from_reader::<_, CacheEntry>(reader).ok()?;
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
