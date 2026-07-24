use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU8, AtomicU64, Ordering},
};

use rom_weaver_checksum::{
    IdentityPrefix, RomIdentity, StreamingChecksum, StreamingVariantChecksums, VariantOutput,
    VariantRow, finish_deferred_fix_header,
};
use rom_weaver_core::{
    ContainerByteProgress, OperationContext, OperationFamily, OperationReport, OperationStatus,
    OrderedChunkWriter, OrderedStreamingMessages, ProgressEvent, Result, RomWeaverError,
    ThreadExecution, bounded_items_for_threads, build_emitted_file_detail,
    create_extract_output_file, detect_disc_sheet, emit_container_running_progress,
    is_rom_filter_candidate_name, maybe_emit_container_byte_progress, operation_report_details,
    ordered_streaming_compress,
};
use serde_json::{Map, Value, json};
use tracing::trace;

use crate::constants::copy_progress_buffer_size;

pub(crate) fn ensure_extract_output_available(output_path: &Path, overwrite: bool) -> Result<()> {
    if overwrite || !output_path.exists() {
        return Ok(());
    }
    Err(RomWeaverError::Validation(format!(
        "refusing to overwrite existing output `{}` (pass --force to overwrite it)",
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

/// Emit a decoded output's detected platform identity mid-extraction as a `probe-identity`
/// progress event so the host can light the ROM-type tag before the file completes. The payload
/// mirrors the early `probe-manifest` shape (`details.probe_manifest.{platform,disc_format}`)
/// so the host consumes both through one path.
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

/// Emit the container extract's planned checksum variants (`probe-variant-plan`) via the shared
/// core helper, so archive extracts reserve their checks rows the same way the bare-ROM `checksum`
/// path does. See [`rom_weaver_core::emit_variant_plan`].
///
/// The event names no entry, so the host attributes it to the staged source as a whole - sound only
/// because a ROM ingest extracts ONE selected payload (an ambiguous archive errors with
/// `AMBIGUOUS_SELECTION` and re-runs against a pick). A multi-payload extract would emit one plan
/// per hashed output and the host would keep whichever landed last; `output_path` is traced so that
/// shows up here rather than as an unexplained skeleton. Applies equally to `emit_extract_identity`.
pub(crate) fn emit_variant_plan(
    context: &OperationContext,
    format: &str,
    output_path: &Path,
    plan: &[(String, String)],
) {
    trace!(
        format,
        output = %output_path.display(),
        variants = ?plan.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
        "emitting extract checksum variant plan"
    );
    rom_weaver_core::emit_variant_plan(
        context,
        "extract",
        OperationFamily::Container,
        Some(format),
        plan,
    );
}

/// Fold the next ordered slice into `identity` and emit the `probe-identity` event exactly once
/// (tracked by `emitted`) when the prefix fills. Used by handlers that decode their own stream
/// (rvz, cso, z3ds). Detection uses the KNOWN final output length so size-dependent media
/// (e.g. PS2 CD vs DVD) resolves correctly.
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

/// Output extension (with leading dot) used to disambiguate cartridge identity.
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

/// Timing for an inline extract checksum from [`ExtractHasher::finish_timed`]. `threaded`/`workers`
/// describe a worker-backed [`StreamingChecksum`]; the synchronous variant engine hashes inline on
/// the extract thread and reports the default (not threaded, zero busy).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ExtractChecksumTiming {
    pub(crate) threaded: bool,
    pub(crate) workers: usize,
    pub(crate) hash_busy_ns: u128,
}

/// Detect a decoded output's identity from an [`IdentityPrefix`] using the output file's extension.
fn detect_emitted_identity(identity: &IdentityPrefix, output_path: &Path) -> RomIdentity {
    identity.detect(output_extension(output_path).as_deref())
}

/// Inline extract hasher folding output bytes into a plain checksum or the full streaming variant
/// engine (when the total length is known), so archive extracts emit the same `checksum_variants`
/// as the `checksum` command without a second read of the output.
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
        // `--checksum-rom` hashes only ROM-like outputs; sidecar/non-ROM entries get no checksum
        // and no identity. Single-payload disc-image handlers use a different writer, so this gate
        // only affects multi-entry archives. A `.cue`/`.gdi` disc sheet stays a ROM-filter
        // candidate but is a text index, not data, so only its referenced data tracks are hashed.
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
        // decode-threading decision (negotiate is pure, so this consumes nothing). The engine
        // splits it across the active variants so their hashes run in parallel and overlap the
        // producer. Shared with the standalone `checksum` command for identical parallelism.
        let hash_thread_budget = context.variant_hash_execution().effective_threads;
        let engine =
            StreamingVariantChecksums::new(algorithms, total_len, name_hint, hash_thread_budget)?;
        Ok(Self::Variants {
            engine,
            algorithms: algorithms.to_vec(),
            identity: IdentityPrefix::new(),
            identity_emitted: false,
        })
    }

    /// Return the detected identity exactly once, as soon as the identity prefix fills, so the
    /// caller can surface it mid-extraction. `None` until ready, after taken, or nothing matched.
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

    /// Return the planned checksum variants `(id, label)` exactly once, as soon as the variant
    /// engine has scanned the header and settled its plan, so the caller can reserve the UI rows
    /// before the checksums finish. `None` until planned, after taken, or when not hashing variants.
    pub(crate) fn take_ready_variant_plan(&mut self) -> Option<Vec<(String, String)>> {
        match self {
            Self::Variants { engine, .. } => engine.take_planned_variants(),
            _ => None,
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

    /// Like [`finish`](Self::finish) but also returns hashing timing. The worker-backed plain
    /// checksum reports its parallel hashing wall; the inline variant engine reports the default
    /// (its cost is the caller's own per-chunk feed timing).
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
                finish_deferred_fix_header(
                    &mut rows,
                    deferred_fix_header,
                    &algorithms,
                    output_path,
                )?;
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

    let mut details = operation_report_details(&mut report);
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
    let mut entry = build_emitted_file_detail(path)?;
    entry.insert("checksums".to_string(), json!(checksums));
    // Identity detected from the streamed output by the producing path - no extra read here.
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
        let variant_rows = variants.iter().map(VariantRow::to_json).collect::<Vec<_>>();
        entry.insert("checksum_variants".to_string(), Value::Array(variant_rows));
    }
    Some(Value::Object(entry))
}

/// Run an ordered, threaded extract over `tasks`: decode each on a worker and hand finished chunks
/// to `write_chunk` in strict ascending task order. Shared by the seekable single-file extract
/// handlers (cso, z3ds); pairing each chunk with `task_len` lets `write_chunk` validate the
/// decoded size without re-deriving it.
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

/// Ordered, checksum-and-progress aware sink for decoded extract chunks, shared by the seekable
/// single-file extract handlers (cso, z3ds). Each chunk is length-validated, folded into the
/// optional extract checksum, written in ascending index order, and counted toward byte progress.
/// Hashing here - in final on-disk order - computes a requested `--checksum` during extract
/// instead of forcing a second full read of the output.
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
        // `write` runs in strict ascending index order, so hashing here folds the bytes into the
        // checksum in their final on-disk order (before `data` moves into the ordered writer).
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: a real disc fans out into far more decode tasks than the writer's reorder
    /// window (~2x thread count) holds. `decode_tasks_ordered` must deliver chunks in strict
    /// ascending order so a small-window [`OrderedChunkWriter`] never trips "exceeded max reorder
    /// window"; the old `par_iter` fan-out delivered out of order and overflowed it.
    #[test]
    fn decode_tasks_ordered_keeps_writer_window_bounded() {
        let task_count = 64usize;
        let effective_threads = 4usize;
        let window = bounded_items_for_threads(effective_threads);
        assert!(
            window < task_count,
            "test must fan out beyond the reorder window ({window} >= {task_count})"
        );
        const CHUNK_LEN: usize = 8;

        let tasks: Vec<usize> = (0..task_count).collect();
        let mut writer = OrderedChunkWriter::new(Vec::new(), window).expect("writer");
        let messages = OrderedStreamingMessages {
            worker_closed: "test decode workers closed early",
            result_closed: "test decode pipeline closed early",
        };

        decode_tasks_ordered(
            &tasks,
            effective_threads,
            messages,
            |_task: &usize| CHUNK_LEN as u64,
            |task| Ok::<(usize, Vec<u8>), RomWeaverError>((task, vec![task as u8; CHUNK_LEN])),
            |(index, data): (usize, Vec<u8>), _task_len| {
                let chunk_index = u64::try_from(index).expect("chunk index fits u64");
                writer.write_chunk(chunk_index, data)
            },
        )
        .expect("ordered decode must keep the writer window bounded");

        let output = writer.finish().expect("writer finishes without gaps");
        assert_eq!(output.len(), task_count * CHUNK_LEN);
        for (task, chunk) in output.chunks_exact(CHUNK_LEN).enumerate() {
            assert!(
                chunk.iter().all(|byte| *byte == task as u8),
                "chunk {task} written out of order"
            );
        }
    }
}
