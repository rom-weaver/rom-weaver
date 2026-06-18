use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU8, AtomicU64, Ordering},
    sync::mpsc,
    thread,
};

use rayon::prelude::*;
use rom_weaver_checksum::{
    IdentityPrefix, RomIdentity, StreamingChecksum, StreamingVariantChecksums, VariantOutput,
    VariantRow, overlay_checksums,
};
use rom_weaver_core::{
    ContainerByteProgress, OperationContext, OperationFamily, OperationReport, OperationStatus,
    OrderedChunkWriter, OrderedStreamingMessages, ProgressEvent, Result, RomWeaverError,
    SharedThreadPool, ThreadCapability, ThreadExecution, bounded_items_for_threads,
    create_extract_output_file, detect_disc_sheet, emit_container_running_progress,
    is_rom_filter_candidate_name, maybe_emit_container_byte_progress, ordered_streaming_compress,
};
use serde_json::{Map, Value, json};

use crate::constants::{PARALLEL_COORDINATOR_STACK_SIZE_BYTES, copy_progress_buffer_size};

pub(crate) fn ensure_extract_output_available(output_path: &Path, overwrite: bool) -> Result<()> {
    if overwrite || !output_path.exists() {
        return Ok(());
    }
    Err(RomWeaverError::Validation(format!(
        "refusing to overwrite existing output `{}` (rerun without --no-overwrite to replace it)",
        output_path.display()
    )))
}

pub(crate) fn emit_container_indeterminate_progress(
    context: &OperationContext,
    command: &str,
    format: &str,
    stage: &str,
    label: impl Into<String>,
    thread_execution: Option<&ThreadExecution>,
) {
    context.emit(ProgressEvent {
        command: command.to_string(),
        family: OperationFamily::Container,
        format: Some(format.to_string()),
        stage: stage.to_string(),
        label: label.into(),
        details: None,
        percent: None,
        elapsed_ms: None,
        status: OperationStatus::Running,
        ..ProgressEvent::from_thread_execution(thread_execution)
    });
}

/// Surface a decoded output's detected platform identity mid-extraction as a `probe-identity`
/// progress event, the moment enough bytes have streamed to determine it (see
/// [`ExtractHasher::take_ready_identity`]) — so the host can light up the ROM-type tag without
/// waiting for the whole file. The payload mirrors the early `probe-manifest` shape
/// (`details.probe_manifest.{platform,disc_format}`) so the host consumes it through one path.
pub(crate) fn emit_extract_identity(
    context: &OperationContext,
    format: &str,
    identity: &RomIdentity,
) {
    let mut manifest = Map::new();
    identity.write_into(&mut manifest);
    if manifest.is_empty() {
        return;
    }
    let mut details = Map::new();
    details.insert("probe_manifest".to_string(), Value::Object(manifest));
    context.emit(ProgressEvent {
        command: "extract".to_string(),
        family: OperationFamily::Container,
        format: Some(format.to_string()),
        stage: "probe-identity".to_string(),
        label: "identified payload".to_string(),
        details: Some(Value::Object(details)),
        percent: None,
        elapsed_ms: None,
        status: OperationStatus::Running,
        ..ProgressEvent::from_thread_execution(None)
    });
}

/// Fold the next ordered slice of a decoded output into `identity` and, the moment the prefix
/// fills, emit the streaming `probe-identity` event exactly ONCE (tracked by `emitted`). Used by
/// the disc-image extract handlers that decode their own stream (rvz, cso, z3ds) so the ROM-type
/// tag pops mid-extraction instead of only in `emitted_files` at completion. Detection uses the
/// KNOWN final output length these handlers already have — more accurate than the bytes-consumed
/// length the prefix tracks, since it resolves size-dependent media (e.g. PS2 CD vs DVD) correctly.
pub(crate) fn stream_extract_identity(
    context: &OperationContext,
    format: &str,
    identity: &mut IdentityPrefix,
    emitted: &mut bool,
    total_len: u64,
    extension: Option<&str>,
    bytes: &[u8],
) {
    identity.push(bytes);
    if *emitted || !identity.is_full() {
        return;
    }
    *emitted = true;
    let detected = identity.detect_with_total_len(total_len, extension);
    if !detected.is_empty() {
        emit_extract_identity(context, format, &detected);
    }
}

/// The output file extension (with leading dot, lowercased by the caller's path) used to
/// disambiguate cartridge identity. Disc handlers pass their decoded output's extension.
fn output_extension(output_path: &Path) -> Option<String> {
    output_path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
}

/// The stable descriptor of a container progress stream: everything that stays constant across
/// per-step or per-byte progress calls for one create/extract operation.
#[derive(Clone, Copy)]
pub(crate) struct ContainerProgressContext<'a> {
    pub(crate) context: &'a OperationContext,
    pub(crate) command: &'a str,
    pub(crate) format: &'a str,
    pub(crate) stage: &'a str,
    pub(crate) thread_execution: Option<&'a ThreadExecution>,
}

pub(crate) fn emit_container_step_progress(
    progress: &ContainerProgressContext<'_>,
    completed_steps: usize,
    total_steps: usize,
    label: impl Into<String>,
) {
    if total_steps == 0 {
        return;
    }
    let completed = completed_steps.min(total_steps);
    let percent = (completed as f32 / total_steps as f32) * 100.0;
    let ContainerProgressContext {
        context,
        command,
        format,
        stage,
        thread_execution,
    } = *progress;
    emit_container_running_progress(
        context,
        command,
        format,
        stage,
        label,
        percent,
        thread_execution,
    );
}

pub(crate) fn copy_reader_with_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_bytes: u64,
    progress: &ContainerProgressContext<'_>,
    label: &str,
) -> Result<u64> {
    let ContainerProgressContext {
        context,
        command,
        format,
        stage,
        thread_execution,
    } = *progress;
    let buffer_size = copy_progress_buffer_size(total_bytes);
    let mut buffer = vec![0_u8; buffer_size];
    let mut bytes_written = 0_u64;
    let emitted_progress_bucket = AtomicU8::new(0);

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        writer.write_all(&buffer[..bytes_read])?;
        bytes_written = bytes_written.saturating_add(bytes_read as u64);
        if total_bytes > 0 {
            maybe_emit_container_byte_progress(
                context,
                bytes_written.min(total_bytes),
                total_bytes,
                ContainerByteProgress {
                    command,
                    format,
                    stage,
                    label,
                    thread_execution,
                    emitted_progress_bucket: &emitted_progress_bucket,
                },
            );
        }
    }

    Ok(bytes_written)
}

#[derive(Clone, Debug)]
pub(crate) struct ExtractedFileChecksum {
    pub(crate) path: PathBuf,
    pub(crate) values: BTreeMap<String, String>,
    /// Checksum variants (raw, remove-header, fix-header, n64 byte order) when
    /// computed inline during extract; empty for disc-image / unknown-size paths.
    pub(crate) variants: Vec<VariantRow>,
    /// Decode/checksum/overlap split for this entry, when measured (currently the
    /// single-file libarchive path). Surfaced in the report's `emitted_files` so the
    /// UI can show where the extract's time went. `None` on paths not yet instrumented.
    pub(crate) timing: Option<ExtractTiming>,
    /// Console + optical medium, detected from the streamed output (no extra read).
    /// Every producing path captures this via [`IdentityPrefix`] (or the variant
    /// engine), so it is always populated; empty when nothing matched.
    pub(crate) rom_identity: RomIdentity,
}

/// The wall-time split for one extracted entry, in milliseconds, surfaced to the UI.
/// `checksum_ms` is the hashing cost (worker wall when threaded, else inline); `overlap_ms`
/// is how much of it ran concurrently with decode.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ExtractTiming {
    pub(crate) total_ms: f64,
    pub(crate) decode_ms: f64,
    pub(crate) opfs_write_ms: f64,
    pub(crate) checksum_ms: f64,
    pub(crate) overlap_ms: f64,
    pub(crate) threaded: bool,
    pub(crate) workers: usize,
}

pub(crate) fn create_extract_checksum(
    context: &OperationContext,
) -> Result<Option<StreamingChecksum>> {
    StreamingChecksum::new_with_context(context.extract_checksum_algorithms(), context)
}

/// Timing for an inline extract checksum, surfaced from [`ExtractHasher::finish_timed`] so the
/// extract loop can log how much of the hashing overlapped decoding. `threaded`/`workers` describe a
/// worker-backed [`StreamingChecksum`]; the synchronous variant engine hashes inline on the extract
/// thread (its cost is the loop's own per-chunk feed timing) and reports the default — not threaded,
/// zero busy.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ExtractChecksumTiming {
    pub(crate) threaded: bool,
    pub(crate) workers: usize,
    pub(crate) hash_busy_ns: u128,
}

/// Inline extract hasher that folds output bytes into either a plain checksum or
/// the full streaming variant engine (when the output's total length is known),
/// so archive extracts emit the same `checksum_variants` as the `checksum`
/// command without a second read of the output.
/// Detect a decoded output's identity from an [`IdentityPrefix`] using the output
/// file's extension, mirroring how the file-based detection derives it.
fn detect_emitted_identity(identity: &IdentityPrefix, output_path: &Path) -> RomIdentity {
    identity.detect(output_extension(output_path).as_deref())
}

pub(crate) enum ExtractHasher {
    None,
    Plain {
        checksum: StreamingChecksum,
        identity: IdentityPrefix,
        identity_emitted: bool,
    },
    Variants {
        engine: StreamingVariantChecksums,
        algorithms: Vec<String>,
        identity: IdentityPrefix,
        identity_emitted: bool,
    },
}

impl ExtractHasher {
    /// Build a hasher for one extracted file. With a known `total_len` and a
    /// requested checksum algorithm set, computes variants; otherwise falls back
    /// to a plain checksum (or nothing when no algorithms were requested).
    pub(crate) fn new(
        context: &OperationContext,
        total_len: Option<u64>,
        output_path: &Path,
    ) -> Result<Self> {
        let algorithms = context.extract_checksum_algorithms();
        if algorithms.is_empty() {
            return Ok(Self::None);
        }
        // `--checksum-rom` only hashes ROM-like outputs; skip sidecar/non-ROM entries entirely
        // (no checksum and no identity for them). Single-payload disc-image handlers use a
        // different writer and always emit a ROM, so this gate only affects multi-entry archives.
        //
        // A `.cue`/`.gdi` disc sheet still counts as part of the ROM (it stays a ROM-filter
        // candidate and is extracted alongside its tracks) but is itself a text index, not data —
        // so it is never hashed here; only its referenced data tracks are.
        if context.extract_checksum_rom_only() {
            let is_rom = output_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_rom_filter_candidate_name);
            let is_disc_sheet = detect_disc_sheet(output_path).is_some();
            if !is_rom || is_disc_sheet {
                return Ok(Self::None);
            }
        }
        let Some(total_len) = total_len else {
            return Ok(match create_extract_checksum(context)? {
                Some(checksum) => Self::Plain {
                    checksum,
                    identity: IdentityPrefix::new(),
                    identity_emitted: false,
                },
                None => Self::None,
            });
        };
        let name_hint = output_path.file_name().and_then(|name| name.to_str());
        // Plan the variant hashers' worker budget against the full op budget, independent of the
        // extract's decode-threading decision (negotiate is pure, so this does not consume it). The
        // engine splits this budget across the active variants so each one's crc32/md5/sha1 hash in
        // parallel and overlap the producer instead of serializing on the decode thread. A lone ROM
        // with only the `raw` variant gets the whole budget (capped at the algorithm count); a ROM
        // with several variants (e.g. raw + fix-header) gives each a share so they run concurrently.
        let hash_thread_budget = context
            .plan_threads(ThreadCapability::parallel(None))
            .effective_threads;
        let engine =
            StreamingVariantChecksums::new(algorithms, total_len, name_hint, hash_thread_budget)?;
        Ok(Self::Variants {
            engine,
            algorithms: algorithms.to_vec(),
            identity: IdentityPrefix::new(),
            identity_emitted: false,
        })
    }

    /// Once the identity prefix has filled (enough bytes have streamed through to fully determine the
    /// platform/medium), return the detected identity exactly ONCE so the caller can surface it
    /// mid-extraction instead of waiting for the whole file. Returns `None` until it is ready, after
    /// it has already been taken, or when nothing was detected.
    pub(crate) fn take_ready_identity(&mut self, output_path: &Path) -> Option<RomIdentity> {
        match self {
            Self::None => None,
            Self::Plain {
                identity,
                identity_emitted,
                ..
            }
            | Self::Variants {
                identity,
                identity_emitted,
                ..
            } => {
                if *identity_emitted || !identity.is_full() {
                    return None;
                }
                *identity_emitted = true;
                let detected = detect_emitted_identity(identity, output_path);
                (!detected.is_empty()).then_some(detected)
            }
        }
    }

    pub(crate) fn update(&mut self, bytes: &[u8]) -> Result<()> {
        match self {
            Self::None => Ok(()),
            Self::Plain {
                checksum, identity, ..
            } => {
                identity.push(bytes);
                checksum.update(bytes)
            }
            Self::Variants {
                engine, identity, ..
            } => {
                identity.push(bytes);
                engine.update(bytes)
            }
        }
    }

    /// Finalize, returning the per-file checksum entry (and variants). A deferred
    /// `fix-header` (repair dependency over the in-memory cap) is completed with
    /// one extra read of the just-written output.
    pub(crate) fn finish(self, output_path: &Path) -> Result<Option<ExtractedFileChecksum>> {
        Ok(self.finish_timed(output_path)?.0)
    }

    /// Like [`finish`](Self::finish) but also returns the hashing timing so the caller can log how
    /// much of the checksum overlapped extraction. The worker-backed plain checksum reports its
    /// parallel hashing wall; the inline variant engine reports the default (its cost is the caller's
    /// own per-chunk feed timing).
    pub(crate) fn finish_timed(
        self,
        output_path: &Path,
    ) -> Result<(Option<ExtractedFileChecksum>, ExtractChecksumTiming)> {
        match self {
            Self::None => Ok((None, ExtractChecksumTiming::default())),
            Self::Plain {
                checksum, identity, ..
            } => {
                let rom_identity = detect_emitted_identity(&identity, output_path);
                let (values, timing) = checksum.finalize_timed()?;
                Ok((
                    Some(ExtractedFileChecksum {
                        path: output_path.to_path_buf(),
                        values,
                        variants: Vec::new(),
                        timing: None,
                        rom_identity,
                    }),
                    ExtractChecksumTiming {
                        threaded: timing.threaded,
                        workers: timing.workers,
                        hash_busy_ns: timing.hash_busy_ns,
                    },
                ))
            }
            Self::Variants {
                engine,
                algorithms,
                identity,
                ..
            } => {
                let rom_identity = detect_emitted_identity(&identity, output_path);
                let VariantOutput {
                    mut rows,
                    deferred_fix_header,
                    raw_timing,
                } = engine.finalize()?;
                if let Some(deferred) = deferred_fix_header {
                    let mut file = File::open(output_path)?;
                    let checksums = overlay_checksums(&mut file, &algorithms, &deferred.patches)?;
                    rows.push(VariantRow {
                        id: deferred.id,
                        label: deferred.label,
                        checksums,
                        apply_compatibility: deferred.apply_compatibility,
                        transforms: deferred.transforms,
                    });
                }
                let values = rows
                    .iter()
                    .find(|row| row.id == "raw")
                    .map(|row| row.checksums.clone())
                    .unwrap_or_default();
                Ok((
                    Some(ExtractedFileChecksum {
                        path: output_path.to_path_buf(),
                        values,
                        variants: rows,
                        timing: None,
                        rom_identity,
                    }),
                    ExtractChecksumTiming {
                        threaded: raw_timing.threaded,
                        workers: raw_timing.workers,
                        hash_busy_ns: raw_timing.hash_busy_ns,
                    },
                ))
            }
        }
    }
}

pub(crate) fn attach_extract_checksum_details(
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
        .filter_map(|entry| {
            build_extract_checksum_emitted_file_detail(
                &entry.path,
                entry.values,
                entry.variants,
                entry.timing,
                entry.rom_identity,
            )
        })
        .collect::<Vec<_>>();
    if !emitted.is_empty() {
        details.insert("emitted_files".to_string(), Value::Array(emitted));
    }
    report.details = Some(Value::Object(details));
    report
}

fn build_extract_checksum_emitted_file_detail(
    path: &Path,
    checksums: BTreeMap<String, String>,
    variants: Vec<VariantRow>,
    timing: Option<ExtractTiming>,
    rom_identity: RomIdentity,
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
    // Console + optical medium of this decoded entry (no exact-title lookup), detected
    // from the streamed output by the producing path — no extra read here.
    rom_identity.write_into(&mut entry);
    if let Some(timing) = timing {
        entry.insert(
            "timing".to_string(),
            json!({
                "total_ms": timing.total_ms,
                "decode_ms": timing.decode_ms,
                "opfs_write_ms": timing.opfs_write_ms,
                "checksum_ms": timing.checksum_ms,
                "overlap_ms": timing.overlap_ms,
                "threaded": timing.threaded,
                "workers": timing.workers,
            }),
        );
    }
    if !variants.is_empty() {
        let variant_rows = variants
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "label": row.label,
                    "checksums": row.checksums,
                    "applyCompatibility": row.apply_compatibility,
                    "transforms": row.transforms,
                })
            })
            .collect::<Vec<_>>();
        entry.insert("checksum_variants".to_string(), Value::Array(variant_rows));
    }
    Some(Value::Object(entry))
}

/// Run an ordered, threaded extract over `tasks`, decoding each task on a worker thread and handing
/// finished chunks to `write_chunk` in strict ascending task order.
///
/// This is the task-based decode wrapper shared by the seekable single-file extract handlers (cso,
/// z3ds): every one of them clones a task onto a worker, decodes it, and streams the decoded chunk
/// back in order alongside the task's expected length. The only per-format inputs are the channel
/// error messages, how to read a task's expected length, and the decode itself; pairing the chunk
/// with `task_len` lets `write_chunk` validate the decoded size without re-deriving it.
pub(crate) fn decode_tasks_ordered<TTask, TChunk, TaskLen, Decode, WriteChunk>(
    tasks: &[TTask],
    effective_threads: usize,
    messages: OrderedStreamingMessages,
    task_len: TaskLen,
    decode: Decode,
    mut write_chunk: WriteChunk,
) -> Result<()>
where
    TTask: Clone + Send,
    TChunk: Send,
    TaskLen: Fn(&TTask) -> u64 + Sync,
    Decode: Fn(TTask) -> Result<TChunk> + Sync,
    WriteChunk: FnMut(TChunk, u64) -> Result<()>,
{
    ordered_streaming_compress(
        tasks,
        effective_threads,
        messages,
        |_, task: &TTask| Ok(task.clone()),
        || (),
        |_, _, task: TTask| {
            let len = task_len(&task);
            decode(task).map(|chunk| (len, chunk))
        },
        |_, (len, chunk)| write_chunk(chunk, len),
    )
}

/// Ordered, checksum-and-progress aware sink for decoded extract chunks.
///
/// Wraps the write half shared by the seekable single-file extract handlers (cso, z3ds): each
/// decoded chunk is validated against its task's expected length, folded into the optional extract
/// checksum, written to the [`OrderedChunkWriter`] in ascending index order, and counted toward the
/// byte-progress stream. Hashing the bytes here — in their final on-disk order — computes a
/// requested `--checksum` during extract instead of forcing a second full read of the output.
pub(crate) struct ExtractChunkWriter<'a> {
    context: &'a OperationContext,
    execution: &'a ThreadExecution,
    format: &'static str,
    label: String,
    total_bytes: u64,
    writer: OrderedChunkWriter<BufWriter<File>>,
    checksum: Option<StreamingChecksum>,
    /// Identity prefix captured from the decoded output for detection at finish (the
    /// plain checksum here doesn't retain bytes). No extra read.
    identity: IdentityPrefix,
    /// Output extension (with leading dot) for identity detection; cached so each chunk write
    /// doesn't re-derive it.
    identity_extension: Option<String>,
    /// Whether the mid-extract `probe-identity` event has already fired for this output.
    identity_emitted: bool,
    progress_bytes: AtomicU64,
    progress_bucket: AtomicU8,
}

impl<'a> ExtractChunkWriter<'a> {
    pub(crate) fn new(
        context: &'a OperationContext,
        execution: &'a ThreadExecution,
        format: &'static str,
        label: String,
        total_bytes: u64,
        output_path: &Path,
        overwrite: bool,
    ) -> Result<Self> {
        let writer = OrderedChunkWriter::new(
            BufWriter::new(create_extract_output_file(output_path, overwrite)?),
            bounded_items_for_threads(execution.effective_threads),
        )?;
        let checksum = create_extract_checksum(context)?;
        Ok(Self {
            context,
            execution,
            format,
            label,
            total_bytes,
            writer,
            checksum,
            identity: IdentityPrefix::new(),
            identity_extension: output_extension(output_path),
            identity_emitted: false,
            progress_bytes: AtomicU64::new(0),
            progress_bucket: AtomicU8::new(0),
        })
    }

    /// Write one decoded chunk. `chunk_index` is the task index (used for ordered writes) and
    /// `expected_len` is the task's expected decoded length; a mismatch is a hard error.
    pub(crate) fn write(
        &mut self,
        chunk_index: usize,
        data: Vec<u8>,
        expected_len: u64,
    ) -> Result<()> {
        let chunk_len = u64::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation(format!("{} extract chunk length overflowed", self.format))
        })?;
        if chunk_len != expected_len {
            return Err(RomWeaverError::Validation(format!(
                "{} extract chunk {} wrote {} bytes but expected {}",
                self.format, chunk_index, chunk_len, expected_len
            )));
        }
        let ordered_index = u64::try_from(chunk_index).map_err(|_| {
            RomWeaverError::Validation(format!("{} extract chunk index overflowed", self.format))
        })?;
        // `write` is invoked in strict ascending index order, so hashing here folds the output bytes
        // into the checksum in their final on-disk order. Update before the value is moved into the
        // ordered writer below.
        if let Some(checksum) = self.checksum.as_mut() {
            checksum.update(&data)?;
            // Surface the platform/medium tag the instant enough bytes have decoded, using the
            // known final output length so size-dependent media resolves correctly.
            stream_extract_identity(
                self.context,
                self.format,
                &mut self.identity,
                &mut self.identity_emitted,
                self.total_bytes,
                self.identity_extension.as_deref(),
                &data,
            );
        }
        self.writer.write_chunk(ordered_index, data)?;
        if self.total_bytes > 0 {
            let completed = self
                .progress_bytes
                .fetch_add(chunk_len, Ordering::Relaxed)
                .saturating_add(chunk_len)
                .min(self.total_bytes);
            maybe_emit_container_byte_progress(
                self.context,
                completed,
                self.total_bytes,
                ContainerByteProgress {
                    command: "extract",
                    format: self.format,
                    stage: "extract",
                    label: &self.label,
                    thread_execution: Some(self.execution),
                    emitted_progress_bucket: &self.progress_bucket,
                },
            );
        }
        Ok(())
    }

    /// Flush the ordered writer and finalize the extract checksum, returning the per-file checksum
    /// entry (empty when no `--checksum` was requested) for `output_path`.
    pub(crate) fn finish(self, output_path: &Path) -> Result<Vec<ExtractedFileChecksum>> {
        self.writer.finish()?;
        let mut checksums = Vec::new();
        if let Some(checksum) = self.checksum {
            let rom_identity = detect_emitted_identity(&self.identity, output_path);
            checksums.push(ExtractedFileChecksum {
                path: output_path.to_path_buf(),
                values: checksum.finalize()?,
                variants: Vec::new(),
                timing: None,
                rom_identity,
            });
        }
        Ok(checksums)
    }
}

pub(crate) fn write_decoded_chunks_from_workers<TTask, TChunk, Decode, WriteChunk>(
    pool: &SharedThreadPool,
    tasks: &[TTask],
    max_in_flight_items: usize,
    receiver_closed_message: &'static str,
    decode: Decode,
    mut write_chunk: WriteChunk,
) -> Result<()>
where
    TTask: Sync,
    TChunk: Send,
    Decode: Fn(&TTask) -> Result<TChunk> + Send + Sync,
    WriteChunk: FnMut(TChunk) -> Result<()>,
{
    let (sender, receiver) = mpsc::sync_channel::<TChunk>(max_in_flight_items.max(1));
    let mut write_result = Ok(());

    // `par_iter` fans the decode across the full pool (the configured compute-worker budget). The
    // two coordination threads — the rayon driver below (it calls `pool.install` and parks, holding
    // no pool slot) and the consuming thread that drains the channel and writes/reorders chunks —
    // run on top of those workers, not subtracted from them.
    thread::scope(|scope| -> Result<()> {
        let producer = thread::Builder::new()
            .name("rom-weaver-decode".to_string())
            .stack_size(PARALLEL_COORDINATOR_STACK_SIZE_BYTES)
            .spawn_scoped(scope, || {
                pool.install(|| {
                    tasks.par_iter().try_for_each_with(sender, |sender, task| {
                        let chunk = decode(task)?;
                        sender.send(chunk).map_err(|_| {
                            RomWeaverError::Validation(receiver_closed_message.to_string())
                        })
                    })
                })
            })
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to start parallel decode coordinator: {error}"
                ))
            })?;

        let mut receiver = Some(receiver);
        while let Some(active_receiver) = receiver.as_ref() {
            match active_receiver.recv() {
                Ok(chunk) => {
                    if let Err(error) = write_chunk(chunk) {
                        write_result = Err(error);
                        drop(receiver.take());
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        let producer_result = producer.join().map_err(|_| {
            RomWeaverError::Validation("parallel decode coordinator panicked".into())
        })?;
        write_result?;
        producer_result
    })
}
