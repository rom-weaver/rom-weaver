use std::collections::{BTreeMap, HashMap};
use std::{
    borrow::Cow,
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

use flacenc::{component::BitRepr as _, error::Verify as _};
use flate2::{Compression as GzipCompression, write::DeflateEncoder};
// The rayon parallel-iterator prelude is only needed by decode paths that do not use wasi threads
// paths (`par_chunks`); the wasi-threads build parallelises with scoped threads instead.
#[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
use rayon::prelude::*;
use rom_weaver_checksum::StreamingChecksum;
use rom_weaver_codecs::{CanonicalCodec, RequestedCodec, parse_requested_codec};
use rom_weaver_core::{
    ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest, ContainerHandler,
    ContainerInspectRequest, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    OperationStatus, ProbeConfidence, ProgressEvent, Result, RomWeaverError, ThreadCapability,
    ThreadExecution,
};
// Only the decode paths use a shared pool, and they are absent on the wasi-threads build.
#[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
use rom_weaver_core::SharedThreadPool;
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use zstd::bulk::compress as zstd_compress;

const CHD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "chd",
    aliases: &["chd-cd", "chd-dvd", "chd-raw", "chd-hd"],
    extensions: &[".chd"],
};

const CHD_SIGNATURE: [u8; 8] = *b"MComprHD";
const CHD_MAX_COMPRESSORS: usize = 4;
const CHD_METADATA_FLAG_CHECKSUM: u8 = 0x01;
const CD_FRAME_SIZE: u32 = 2352 + 96;
const HARD_DISK_METADATA_TAG: u32 = make_tag(b'G', b'D', b'D', b'D');
const CDROM_TRACK_METADATA2_TAG: u32 = make_tag(b'C', b'H', b'T', b'2');
const GDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'D');
const DVD_METADATA_TAG: u32 = make_tag(b'D', b'V', b'D', b' ');

const fn make_tag(a: u8, b: u8, c: u8, d: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((c as u32) << 8) | (d as u32)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChdCodec(u32);

impl ChdCodec {
    pub const NONE: Self = Self(0);
    pub const ZLIB: Self = Self(make_tag(b'z', b'l', b'i', b'b'));
    pub const ZSTD: Self = Self(make_tag(b'z', b's', b't', b'd'));
    pub const LZMA: Self = Self(make_tag(b'l', b'z', b'm', b'a'));
    pub const HUFFMAN: Self = Self(make_tag(b'h', b'u', b'f', b'f'));
    pub const AVHUFF: Self = Self(make_tag(b'a', b'v', b'h', b'u'));
    pub const FLAC: Self = Self(make_tag(b'f', b'l', b'a', b'c'));
    pub const CD_ZLIB: Self = Self(make_tag(b'c', b'd', b'z', b'l'));
    pub const CD_ZSTD: Self = Self(make_tag(b'c', b'd', b'z', b's'));
    pub const CD_LZMA: Self = Self(make_tag(b'c', b'd', b'l', b'z'));
    pub const CD_FLAC: Self = Self(make_tag(b'c', b'd', b'f', b'l'));

    const fn raw(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChdMediaKind {
    Raw,
    HardDisk,
    CdRom,
    GdRom,
    Dvd,
    Av,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChdHeader {
    version: u32,
    logical_bytes: u64,
    hunk_bytes: u32,
    hunk_count: u32,
    unit_bytes: u32,
    unit_count: u64,
    compressed: bool,
    compression: [ChdCodec; CHD_MAX_COMPRESSORS],
    sha1: Option<[u8; 20]>,
    raw_sha1: Option<[u8; 20]>,
}

fn file_starts_with(source: &Path, signature: &[u8]) -> bool {
    let mut bytes = vec![0u8; signature.len()];
    if let Ok(mut file) = File::open(source) {
        return file.read_exact(&mut bytes).is_ok() && bytes == signature;
    }
    false
}

fn emit_chd_running_progress(
    context: &OperationContext,
    command: &str,
    stage: &str,
    label: impl Into<String>,
    percent: f32,
    thread_execution: Option<&ThreadExecution>,
) {
    let clamped_percent = percent.clamp(0.0, 100.0);
    context.emit(ProgressEvent {
        command: command.to_string(),
        family: OperationFamily::Container,
        format: Some(CHD.name.to_string()),
        stage: stage.to_string(),
        label: label.into(),
        details: None,
        percent: Some(clamped_percent),
        requested_threads: thread_execution.map(|value| value.requested_threads),
        effective_threads: thread_execution.map(|value| value.effective_threads),
        thread_mode: thread_execution.map(|value| value.thread_mode),
        used_parallelism: thread_execution.map(|value| value.used_parallelism),
        thread_fallback: thread_execution.map(|value| value.thread_fallback),
        thread_fallback_reason: thread_execution
            .and_then(|value| value.thread_fallback_reason.clone()),
        status: OperationStatus::Running,
    });
}

fn create_extract_output_file(output_path: &Path, overwrite: bool) -> Result<File> {
    if overwrite {
        return File::create(output_path).map_err(RomWeaverError::from);
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)
        .map_err(|error| {
            RomWeaverError::Validation(format!(
                "refusing to overwrite existing output `{}`: {error}",
                output_path.display()
            ))
        })
}

#[allow(clippy::too_many_arguments)]
fn maybe_emit_chd_byte_progress(
    context: &OperationContext,
    command: &str,
    stage: &str,
    completed_bytes: u64,
    total_bytes: u64,
    label: &str,
    thread_execution: Option<&ThreadExecution>,
    emitted_progress_bucket: &AtomicU8,
) {
    if total_bytes == 0 || completed_bytes == 0 {
        return;
    }
    let completed = completed_bytes.min(total_bytes);
    let percent_bucket = completed
        .saturating_mul(100)
        .checked_div(total_bytes)
        .unwrap_or(100)
        .min(100) as u8;
    if percent_bucket == 0 {
        return;
    }

    let (start_bucket, end_bucket) = loop {
        let previous_bucket = emitted_progress_bucket.load(Ordering::Relaxed);
        if percent_bucket <= previous_bucket {
            return;
        }
        match emitted_progress_bucket.compare_exchange(
            previous_bucket,
            percent_bucket,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break (previous_bucket.saturating_add(1), percent_bucket),
            Err(_) => continue,
        }
    };

    for bucket in start_bucket..=end_bucket {
        emit_chd_running_progress(
            context,
            command,
            stage,
            label.to_string(),
            bucket as f32,
            thread_execution,
        );
    }
}

#[derive(Clone, Debug)]
enum SelectionPatternKind {
    ExactOrPrefix,
    Wildcard(WildcardPattern),
}

#[derive(Clone, Debug)]
struct SelectionPattern {
    requested: String,
    kind: SelectionPatternKind,
}

impl SelectionPattern {
    fn new(requested: String) -> Self {
        if Self::contains_glob_syntax(&requested) {
            let wildcard = WildcardPattern::new(&requested);
            return Self {
                requested,
                kind: SelectionPatternKind::Wildcard(wildcard),
            };
        }
        Self {
            requested,
            kind: SelectionPatternKind::ExactOrPrefix,
        }
    }

    fn contains_glob_syntax(value: &str) -> bool {
        value
            .bytes()
            .any(|byte| matches!(byte, b'*' | b'?' | b'[' | b'{' | b']' | b'}'))
    }

    fn matches(&self, entry_name: &str) -> bool {
        match &self.kind {
            SelectionPatternKind::ExactOrPrefix => {
                entry_name == self.requested
                    || entry_name.starts_with(&format!("{}/", self.requested))
            }
            SelectionPatternKind::Wildcard(pattern) => pattern.matches(entry_name),
        }
    }
}

#[derive(Clone, Debug)]
struct WildcardPattern {
    segments: Vec<PathPatternSegment>,
}

#[derive(Clone, Debug)]
enum PathPatternSegment {
    AnyDepth,
    OneSegment(String),
}

impl WildcardPattern {
    fn new(pattern: &str) -> Self {
        let segments = pattern
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                if segment == "**" {
                    PathPatternSegment::AnyDepth
                } else {
                    PathPatternSegment::OneSegment(segment.to_string())
                }
            })
            .collect::<Vec<_>>();
        Self { segments }
    }

    fn matches(&self, entry_name: &str) -> bool {
        let path_segments = entry_name
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        Self::matches_path_segments(&self.segments, &path_segments)
    }

    fn matches_path_segments(
        pattern_segments: &[PathPatternSegment],
        path_segments: &[&str],
    ) -> bool {
        match pattern_segments.split_first() {
            None => path_segments.is_empty(),
            Some((PathPatternSegment::AnyDepth, remaining)) => {
                if Self::matches_path_segments(remaining, path_segments) {
                    return true;
                }
                if let Some((_, tail)) = path_segments.split_first() {
                    return Self::matches_path_segments(pattern_segments, tail);
                }
                false
            }
            Some((PathPatternSegment::OneSegment(pattern), remaining)) => {
                let Some((segment, tail)) = path_segments.split_first() else {
                    return false;
                };
                if !matches_wildcard_segment(pattern, segment) {
                    return false;
                }
                Self::matches_path_segments(remaining, tail)
            }
        }
    }
}

fn matches_wildcard_segment(pattern: &str, candidate: &str) -> bool {
    let pattern_chars = pattern.chars().collect::<Vec<_>>();
    let candidate_chars = candidate.chars().collect::<Vec<_>>();
    matches_wildcard_segment_inner(&pattern_chars, &candidate_chars, 0, 0)
}

fn matches_wildcard_segment_inner(
    pattern: &[char],
    candidate: &[char],
    pattern_index: usize,
    candidate_index: usize,
) -> bool {
    let mut pattern_index = pattern_index;
    let mut candidate_index = candidate_index;

    while pattern_index < pattern.len() {
        match pattern[pattern_index] {
            '*' => {
                while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
                    pattern_index += 1;
                }
                if pattern_index == pattern.len() {
                    return true;
                }
                for next_candidate_index in candidate_index..=candidate.len() {
                    if matches_wildcard_segment_inner(
                        pattern,
                        candidate,
                        pattern_index,
                        next_candidate_index,
                    ) {
                        return true;
                    }
                }
                return false;
            }
            '?' => {
                if candidate_index == candidate.len() {
                    return false;
                }
                pattern_index += 1;
                candidate_index += 1;
            }
            '[' => {
                let Some(class_end) = find_character_class_end(pattern, pattern_index + 1) else {
                    if candidate_index == candidate.len() || candidate[candidate_index] != '[' {
                        return false;
                    }
                    pattern_index += 1;
                    candidate_index += 1;
                    continue;
                };
                if candidate_index == candidate.len() {
                    return false;
                }
                if !character_class_matches(
                    &pattern[pattern_index + 1..class_end],
                    candidate[candidate_index],
                ) {
                    return false;
                }
                pattern_index = class_end + 1;
                candidate_index += 1;
            }
            expected => {
                if candidate_index == candidate.len() || candidate[candidate_index] != expected {
                    return false;
                }
                pattern_index += 1;
                candidate_index += 1;
            }
        }
    }

    candidate_index == candidate.len()
}

fn find_character_class_end(pattern: &[char], class_start: usize) -> Option<usize> {
    let mut index = class_start;
    while index < pattern.len() {
        if pattern[index] == ']' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn character_class_matches(class: &[char], value: char) -> bool {
    if class.is_empty() {
        return false;
    }

    let mut index = 0usize;
    let mut negated = false;
    if matches!(class.first(), Some('!') | Some('^')) {
        negated = true;
        index = 1;
    }

    let mut matched = false;
    while index < class.len() {
        let current = class[index];
        if index + 2 < class.len() && class[index + 1] == '-' {
            let range_end = class[index + 2];
            if current <= value && value <= range_end {
                matched = true;
            }
            index += 3;
            continue;
        }

        if current == value {
            matched = true;
        }
        index += 1;
    }

    if negated { !matched } else { matched }
}

#[derive(Debug, Default)]
struct SelectionMatcher {
    requested: Vec<SelectionPattern>,
    matched: BTreeSet<String>,
}

impl SelectionMatcher {
    fn new(requested: &[String]) -> Self {
        let requested = requested
            .iter()
            .map(|value| normalize_archive_name(value))
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(SelectionPattern::new)
            .collect::<Vec<_>>();
        Self {
            requested,
            matched: BTreeSet::new(),
        }
    }

    fn matches(&mut self, entry_name: &str) -> bool {
        if self.requested.is_empty() {
            return true;
        }
        let entry_name = normalize_archive_name(entry_name);
        if entry_name.is_empty() {
            return false;
        }
        for requested in &self.requested {
            if requested.matches(&entry_name) {
                self.matched.insert(requested.requested.clone());
                return true;
            }
        }
        false
    }

    fn ensure_all_matched(&self) -> Result<()> {
        let missing = self
            .requested
            .iter()
            .filter_map(|requested| {
                (!self.matched.contains(&requested.requested))
                    .then_some(requested.requested.clone())
            })
            .collect::<Vec<_>>();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(RomWeaverError::Validation(format!(
                "requested selections were not found: {}",
                missing.join(", ")
            )))
        }
    }
}

fn normalize_archive_name(name: &str) -> String {
    name.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}

#[derive(Clone, Debug)]
struct ExtractedFileChecksum {
    path: PathBuf,
    values: BTreeMap<String, String>,
}

fn create_extract_checksum(context: &OperationContext) -> Result<Option<StreamingChecksum>> {
    StreamingChecksum::new_with_context(context.extract_checksum_algorithms(), context)
}

// Only the decode paths build a shared pool; the compressed-create path uses scoped threads. Both
// decode callers are absent on the wasi-threads build, so gate this to match and avoid dead code.
#[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
fn build_chd_thread_pool(
    label: &str,
    threads: usize,
) -> std::result::Result<SharedThreadPool, String> {
    SharedThreadPool::with_size(threads).map_err(|error| {
        let reason = match error {
            RomWeaverError::ThreadPoolBuild(reason) => reason,
            other => other.to_string(),
        };
        format!("failed to build CHD rust {label} pool (threads={threads}): {reason}")
    })
}

fn build_extract_checksum_emitted_file_detail(
    path: &Path,
    checksums: BTreeMap<String, String>,
) -> Option<Value> {
    if checksums.is_empty() {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let file_name = canonical.file_name()?.to_string_lossy().into_owned();
    let mut entry = Map::new();
    entry.insert(
        "path".to_string(),
        json!(canonical.to_string_lossy().replace('\\', "/")),
    );
    entry.insert("file_name".to_string(), json!(file_name));
    entry.insert("size_bytes".to_string(), json!(metadata.len()));
    entry.insert("checksums".to_string(), json!(checksums));
    Some(Value::Object(entry))
}

fn attach_extract_checksum_details(
    mut report: OperationReport,
    checksums: Vec<ExtractedFileChecksum>,
) -> OperationReport {
    if checksums.is_empty() || report.status != OperationStatus::Succeeded {
        return report;
    }
    let mut details = match report.details.take() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let emitted = checksums
        .into_iter()
        .filter_map(|entry| build_extract_checksum_emitted_file_detail(&entry.path, entry.values))
        .collect::<Vec<_>>();
    if !emitted.is_empty() {
        details.insert("emitted_files".to_string(), Value::Array(emitted));
    }
    report.details = Some(Value::Object(details));
    report
}

fn push_finalized_extract_checksum(
    output_checksums: &mut Vec<ExtractedFileChecksum>,
    path: PathBuf,
    checksum: Option<StreamingChecksum>,
) -> Result<()> {
    if let Some(checksum) = checksum {
        output_checksums.push(ExtractedFileChecksum {
            path,
            values: checksum.finalize()?,
        });
    }
    Ok(())
}

mod handler;

pub use handler::ChdContainerHandler;
