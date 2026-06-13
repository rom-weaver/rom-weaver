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
    StreamingChecksum, StreamingVariantChecksums, VariantOutput, VariantRow, overlay_checksums,
};
use rom_weaver_core::{
    ContainerByteProgress, OperationContext, OperationFamily, OperationReport, OperationStatus,
    OrderedChunkWriter, OrderedStreamingMessages, ProgressEvent, Result, RomWeaverError,
    SharedThreadPool, ThreadExecution, bounded_items_for_threads, create_extract_output_file,
    emit_container_running_progress, maybe_emit_container_byte_progress,
    ordered_streaming_compress,
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
        requested_threads: thread_execution.map(|value| value.requested_threads),
        effective_threads: thread_execution.map(|value| value.effective_threads),
        thread_mode: thread_execution.map(|value| value.thread_mode),
        used_parallelism: thread_execution.map(|value| value.used_parallelism),
        thread_fallback: thread_execution.map(|value| value.thread_fallback),
        thread_fallback_reason: thread_execution
            .and_then(|value| value.thread_fallback_reason.clone()),
        elapsed_ms: None,
        status: OperationStatus::Running,
    });
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
}

pub(crate) fn create_extract_checksum(
    context: &OperationContext,
) -> Result<Option<StreamingChecksum>> {
    StreamingChecksum::new_with_context(context.extract_checksum_algorithms(), context)
}

/// Inline extract hasher that folds output bytes into either a plain checksum or
/// the full streaming variant engine (when the output's total length is known),
/// so archive extracts emit the same `checksum_variants` as the `checksum`
/// command without a second read of the output.
pub(crate) enum ExtractHasher {
    None,
    Plain(StreamingChecksum),
    Variants {
        engine: StreamingVariantChecksums,
        algorithms: Vec<String>,
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
        let Some(total_len) = total_len else {
            return Ok(match create_extract_checksum(context)? {
                Some(checksum) => Self::Plain(checksum),
                None => Self::None,
            });
        };
        let name_hint = output_path.file_name().and_then(|name| name.to_str());
        let engine = StreamingVariantChecksums::new(algorithms, total_len, name_hint)?;
        Ok(Self::Variants {
            engine,
            algorithms: algorithms.to_vec(),
        })
    }

    pub(crate) fn update(&mut self, bytes: &[u8]) -> Result<()> {
        match self {
            Self::None => Ok(()),
            Self::Plain(checksum) => checksum.update(bytes),
            Self::Variants { engine, .. } => engine.update(bytes),
        }
    }

    /// Finalize, returning the per-file checksum entry (and variants). A deferred
    /// `fix-header` (repair dependency over the in-memory cap) is completed with
    /// one extra read of the just-written output.
    pub(crate) fn finish(self, output_path: &Path) -> Result<Option<ExtractedFileChecksum>> {
        match self {
            Self::None => Ok(None),
            Self::Plain(checksum) => Ok(Some(ExtractedFileChecksum {
                path: output_path.to_path_buf(),
                values: checksum.finalize()?,
                variants: Vec::new(),
            })),
            Self::Variants { engine, algorithms } => {
                let VariantOutput {
                    mut rows,
                    deferred_fix_header,
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
                Ok(Some(ExtractedFileChecksum {
                    path: output_path.to_path_buf(),
                    values,
                    variants: rows,
                }))
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
            build_extract_checksum_emitted_file_detail(&entry.path, entry.values, entry.variants)
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
            checksums.push(ExtractedFileChecksum {
                path: output_path.to_path_buf(),
                values: checksum.finalize()?,
                variants: Vec::new(),
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
