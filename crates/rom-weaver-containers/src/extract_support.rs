use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicU8,
    sync::mpsc,
    thread,
};

use rayon::prelude::*;
use rom_weaver_checksum::StreamingChecksum;
use rom_weaver_core::{
    ContainerByteProgress, OperationContext, OperationFamily, OperationReport, OperationStatus,
    ProgressEvent, Result, RomWeaverError, SharedThreadPool, ThreadExecution,
    emit_container_running_progress, maybe_emit_container_byte_progress,
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
}

pub(crate) fn create_extract_checksum(
    context: &OperationContext,
) -> Result<Option<StreamingChecksum>> {
    StreamingChecksum::new_with_context(context.extract_checksum_algorithms(), context)
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
        .filter_map(|entry| build_extract_checksum_emitted_file_detail(&entry.path, entry.values))
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
