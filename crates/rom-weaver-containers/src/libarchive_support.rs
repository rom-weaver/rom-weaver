use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
        mpsc,
    },
    thread,
};

use rayon::prelude::*;
use rom_weaver_core::{
    ArchiveEntryKindFilter, ContainerByteProgress, ContainerCreateRequest, ContainerExtractRequest,
    ContainerListEntry, OperationContext, OperationFamily, OperationReport, ProbeConfidence,
    Result, RomWeaverError, SelectionMatcher, ThreadCapability, ThreadExecution,
    bounded_items_for_threads, create_extract_output_file, emit_container_running_progress,
    maybe_emit_container_byte_progress, normalize_archive_name,
    should_ignore_common_container_file,
};
use rom_weaver_libarchive::{
    EntryFileType, EntrySpec, ReadArchive, ReadFilter as LibarchiveReadFilter,
    RegularArchiveProbeFormat as LibarchiveProbeFormat, SelectedRegularArchiveEntry, WriteArchive,
    WriteFilter as LibarchiveCreateFilter, WriteFormat as LibarchiveCreateFormat,
    ZeroWriteBehavior, list_regular_archive_entries,
    probe_regular_archive as probe_regular_archive_with_libarchive_impl,
    probe_regular_archive_format, visit_selected_regular_archive_entries,
    visit_selected_regular_archive_entries_from_memory,
};
use tracing::{debug, trace};

use crate::{
    archive_entries::{ArchiveInputEntry, sanitize_archive_relative_path_from_str},
    attach_extraction_details,
    constants::{LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES, PARALLEL_COORDINATOR_STACK_SIZE_BYTES},
    container_reads_source_on_main_thread,
    extract_support::{
        ContainerProgressContext, ExtractHasher, ExtractedFileChecksum,
        attach_extract_checksum_details, emit_container_step_progress,
        ensure_extract_output_available,
    },
};

#[derive(Clone, Copy, Debug)]
pub(crate) struct LibarchiveCreateConfig {
    pub(crate) format_name: &'static str,
    pub(crate) format: LibarchiveCreateFormat,
    pub(crate) filter: LibarchiveCreateFilter,
    pub(crate) format_compression: Option<&'static str>,
    pub(crate) compression_level: Option<i32>,
    pub(crate) format_threads: Option<usize>,
    pub(crate) filter_threads: Option<usize>,
    pub(crate) io_buffer_bytes: usize,
}

fn libarchive_open_create_archive(
    output: &Path,
    config: LibarchiveCreateConfig,
    total_uncompressed_bytes: u64,
    on_codec_bytes_processed: Option<Box<dyn FnMut(u64)>>,
    on_compressed_bytes_written: Option<Box<dyn FnMut(u64)>>,
) -> Result<WriteArchive> {
    let mut archive = WriteArchive::new(&format!("{} create failed", config.format_name))?;
    let setup_result = (|| -> Result<()> {
        archive.set_format(
            config.format,
            &format!(
                "{} create failed while selecting {} format",
                config.format_name, config.format_name
            ),
        )?;

        if let LibarchiveCreateFormat::SevenZ = config.format
            && total_uncompressed_bytes > 0
        {
            archive.set_7zip_size_hint(
                total_uncompressed_bytes,
                &format!(
                    "{} create failed while setting 7z size hint",
                    config.format_name
                ),
            )?;
        }

        if let Some(on_codec_bytes_processed) = on_codec_bytes_processed
            && let LibarchiveCreateFormat::SevenZ = config.format
        {
            archive.set_7zip_progress_callback(
                on_codec_bytes_processed,
                &format!(
                    "{} create failed while setting 7z progress callback",
                    config.format_name
                ),
            )?;
        }

        archive.add_filter(
            config.filter,
            &format!(
                "{} create failed while enabling {} filter",
                config.format_name,
                config.filter.module_name().unwrap_or("no-op")
            ),
        )?;

        if let Some(compression) = config.format_compression {
            archive.set_format_option(
                None,
                "compression",
                compression,
                &format!(
                    "{} create failed while setting format option `compression`",
                    config.format_name
                ),
            )?;
        }

        if let Some(level) = config.compression_level
            && config.format_compression.is_some()
        {
            archive.set_format_option(
                None,
                "compression-level",
                &level.to_string(),
                &format!(
                    "{} create failed while setting format option `compression-level`",
                    config.format_name
                ),
            )?;
        }

        if let Some(threads) = config.format_threads
            && threads > 1
            && config.format_compression.is_some()
        {
            archive.try_set_format_option(
                None,
                "threads",
                &threads.to_string(),
                &format!(
                    "{} create failed while setting format option `threads`",
                    config.format_name
                ),
            )?;
        }

        if let Some(threads) = config.filter_threads
            && threads > 1
            && let Some(module) = config.filter.module_name()
        {
            archive.try_set_filter_option(
                module,
                "threads",
                &threads.to_string(),
                &format!(
                    "{} create failed while setting {module}:threads={threads}",
                    config.format_name
                ),
            )?;
        }

        let open_context = format!(
            "{} create failed while opening output `{}`",
            config.format_name,
            output.display()
        );
        if let Some(on_compressed_bytes_written) = on_compressed_bytes_written {
            archive.open_file_with_write_callback(
                output,
                on_compressed_bytes_written,
                &open_context,
            )?;
        } else {
            archive.open_filename(output, "container output", &open_context)?;
        }
        Ok(())
    })();

    setup_result?;

    Ok(archive)
}

fn libarchive_write_archive_entry<F>(
    archive: &mut WriteArchive,
    format_name: &str,
    entry: &ArchiveInputEntry,
    entry_size_bytes: u64,
    io_buffer_bytes: usize,
    progress_on_source_read: bool,
    mut on_source_bytes: F,
) -> Result<u64>
where
    F: FnMut(u64),
{
    let path_name = if entry.is_dir && !entry.archive_name.ends_with('/') {
        format!("{}/", entry.archive_name)
    } else {
        entry.archive_name.clone()
    };

    archive.start_entry(
        EntrySpec {
            pathname: &path_name,
            file_type: if entry.is_dir {
                EntryFileType::Directory
            } else {
                EntryFileType::Regular
            },
            perm: if entry.is_dir { 0o755 } else { 0o644 },
            size: entry_size_bytes,
        },
        &format!(
            "{format_name} create failed while writing header for `{}`",
            entry.archive_name
        ),
    )?;

    let mut logical_bytes = 0u64;
    if !entry.is_dir {
        let mut source = BufReader::new(File::open(&entry.source)?);
        let mut buffer = vec![0u8; io_buffer_bytes];
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            if progress_on_source_read {
                on_source_bytes(read as u64);
            }
            archive.write_data_all(
                &buffer[..read],
                &format!("{format_name} create failed while writing payload"),
                ZeroWriteBehavior::Error,
            )?;
            logical_bytes = logical_bytes.saturating_add(read as u64);
            if !progress_on_source_read {
                on_source_bytes(read as u64);
            }
        }
    }

    archive.finish_entry(&format!(
        "{format_name} create failed while finalizing entry `{}`",
        entry.archive_name
    ))?;
    Ok(logical_bytes)
}

fn libarchive_close_create_archive(archive: WriteArchive, format_name: &str) -> Result<()> {
    archive.close(
        &format!("{format_name} create failed while closing output"),
        &format!("{format_name} create failed while releasing writer"),
    )
}

pub(crate) fn write_archive_with_libarchive(
    request: &ContainerCreateRequest,
    entries: &[ArchiveInputEntry],
    context: &OperationContext,
    execution: &ThreadExecution,
    config: LibarchiveCreateConfig,
) -> Result<u64> {
    if let Some(parent) = request.output.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut entry_sizes = Vec::with_capacity(entries.len());
    let mut total_input_bytes = 0u64;
    for entry in entries {
        let size = if entry.is_dir {
            0u64
        } else {
            fs::metadata(&entry.source)?.len()
        };
        total_input_bytes = total_input_bytes.saturating_add(size);
        entry_sizes.push(size);
    }

    let compressed_bytes_written = Arc::new(AtomicU64::new(0));
    let emitted_compressed_progress_bucket = Arc::new(AtomicU64::new(0));
    let emitted_codec_progress_bucket = Arc::new(AtomicU8::new(0));
    let codec_progress_context = context.clone();
    let codec_progress_bucket = Arc::clone(&emitted_codec_progress_bucket);
    let final_codec_progress_bucket = Arc::clone(&emitted_codec_progress_bucket);
    let final_codec_progress_context = context.clone();
    let final_codec_progress_execution = execution.clone();
    let final_codec_progress_format = config.format_name;
    let codec_progress_execution = execution.clone();
    let codec_progress_format = config.format_name;
    let on_codec_bytes_processed: Option<Box<dyn FnMut(u64)>> =
        if matches!(config.format, LibarchiveCreateFormat::SevenZ) && total_input_bytes > 0 {
            Some(Box::new(move |processed_bytes| {
                let running_processed = processed_bytes.min(total_input_bytes.saturating_sub(1));
                let percent = running_processed
                    .saturating_mul(100)
                    .checked_div(total_input_bytes)
                    .unwrap_or(100);
                // Every codec callback is a raw progress event (one per streamed
                // block step), most of which are coalesced before reaching the
                // UI. Trace them all for progress debugging.
                trace!(
                    command = "compress",
                    format = codec_progress_format,
                    stage = "create",
                    processed_bytes,
                    running_processed,
                    total_input_bytes,
                    percent,
                    "7z codec progress event"
                );
                if running_processed == 0 {
                    return;
                }
                let percent_bucket = percent.min(99) as u8;
                if percent_bucket == 0 {
                    return;
                }
                loop {
                    let previous_bucket = codec_progress_bucket.load(Ordering::Relaxed);
                    if percent_bucket <= previous_bucket {
                        return;
                    }
                    if codec_progress_bucket
                        .compare_exchange(
                            previous_bucket,
                            percent_bucket,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        )
                        .is_ok()
                    {
                        break;
                    }
                }
                emit_container_running_progress(
                    &codec_progress_context,
                    "compress",
                    codec_progress_format,
                    "create",
                    format!("compressing `{codec_progress_format}`"),
                    percent_bucket as f32,
                    Some(&codec_progress_execution),
                );
            }))
        } else {
            None
        };
    let compressed_progress_bytes = Arc::clone(&compressed_bytes_written);
    let compressed_progress_bucket = Arc::clone(&emitted_compressed_progress_bucket);
    let compressed_progress_execution = execution.clone();
    let compressed_progress_format = config.format_name;
    let compressed_progress_output = request.output.clone();
    let on_compressed_bytes_written = move |delta: u64| {
        let total = compressed_progress_bytes
            .fetch_add(delta, Ordering::Relaxed)
            .saturating_add(delta);
        let bucket = (total / (1024 * 1024)).max(1);
        let previous = compressed_progress_bucket.load(Ordering::Relaxed);
        if bucket <= previous {
            return;
        }
        if compressed_progress_bucket
            .compare_exchange(previous, bucket, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        trace!(
            command = "compress",
            family = ?OperationFamily::Container,
            format = compressed_progress_format,
            stage = "write",
            compressed_bytes_written = total,
            output = %compressed_progress_output.display(),
            requested_threads = compressed_progress_execution.requested_threads,
            effective_threads = compressed_progress_execution.effective_threads,
            thread_mode = ?compressed_progress_execution.thread_mode,
            used_parallelism = compressed_progress_execution.used_parallelism,
            thread_fallback = compressed_progress_execution.thread_fallback,
            thread_fallback_reason = ?compressed_progress_execution.thread_fallback_reason,
            "wrote compressed archive bytes"
        );
    };

    let mut archive = libarchive_open_create_archive(
        &request.output,
        config,
        total_input_bytes,
        on_codec_bytes_processed,
        Some(Box::new(on_compressed_bytes_written)),
    )?;
    let input_progress_enabled =
        total_input_bytes > 0 && !matches!(config.format, LibarchiveCreateFormat::SevenZ);
    let observed_input_progress = false;
    let input_progress_label = format!("creating `{}`", config.format_name);
    let input_progress_bytes = Arc::new(AtomicU64::new(0));
    let emitted_input_progress_bucket = Arc::new(AtomicU8::new(0));
    let input_progress_context = context.clone();
    let input_progress_execution = execution.clone();
    let input_progress_format = config.format_name;
    let result = (|| -> Result<u64> {
        let total_entries = entries.len();
        let mut logical_bytes = 0u64;
        for (entry_index, (entry, entry_size_bytes)) in
            entries.iter().zip(entry_sizes.iter().copied()).enumerate()
        {
            logical_bytes = logical_bytes.saturating_add(libarchive_write_archive_entry(
                &mut archive,
                config.format_name,
                entry,
                entry_size_bytes,
                config.io_buffer_bytes,
                observed_input_progress,
                |delta| {
                    if !input_progress_enabled {
                        return;
                    }
                    let accepted = input_progress_bytes
                        .fetch_add(delta, Ordering::Relaxed)
                        .saturating_add(delta)
                        .min(total_input_bytes);
                    if accepted >= total_input_bytes {
                        return;
                    }
                    if observed_input_progress {
                        let percent_bucket = accepted
                            .saturating_mul(100)
                            .checked_div(total_input_bytes)
                            .unwrap_or(100)
                            .min(99) as u8;
                        if percent_bucket == 0 {
                            return;
                        }
                        loop {
                            let previous_bucket =
                                emitted_input_progress_bucket.load(Ordering::Relaxed);
                            if percent_bucket <= previous_bucket {
                                return;
                            }
                            if emitted_input_progress_bucket
                                .compare_exchange(
                                    previous_bucket,
                                    percent_bucket,
                                    Ordering::Relaxed,
                                    Ordering::Relaxed,
                                )
                                .is_ok()
                            {
                                break;
                            }
                        }
                        emit_container_running_progress(
                            &input_progress_context,
                            "compress",
                            input_progress_format,
                            "create",
                            input_progress_label.clone(),
                            percent_bucket as f32,
                            Some(&input_progress_execution),
                        );
                        return;
                    }
                    maybe_emit_container_byte_progress(
                        &input_progress_context,
                        accepted,
                        total_input_bytes,
                        ContainerByteProgress {
                            command: "compress",
                            format: input_progress_format,
                            stage: "create",
                            label: &input_progress_label,
                            thread_execution: Some(&input_progress_execution),
                            emitted_progress_bucket: emitted_input_progress_bucket.as_ref(),
                        },
                    );
                },
            )?);
            if total_input_bytes == 0 {
                emit_container_step_progress(
                    &ContainerProgressContext {
                        context,
                        command: "compress",
                        format: config.format_name,
                        stage: "create",
                        thread_execution: Some(execution),
                    },
                    entry_index.saturating_add(1),
                    total_entries,
                    format!(
                        "creating `{}` ({}/{})",
                        config.format_name,
                        entry_index.saturating_add(1),
                        total_entries
                    ),
                );
            }
        }
        Ok(logical_bytes)
    })();

    match (
        result,
        libarchive_close_create_archive(archive, config.format_name),
    ) {
        (Ok(bytes), Ok(())) => {
            emit_final_7zip_codec_progress(
                &final_codec_progress_context,
                final_codec_progress_format,
                &final_codec_progress_execution,
                &final_codec_progress_bucket,
            );
            Ok(bytes)
        }
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn emit_final_7zip_codec_progress(
    context: &OperationContext,
    format: &str,
    execution: &ThreadExecution,
    emitted_bucket: &AtomicU8,
) {
    loop {
        let previous = emitted_bucket.load(Ordering::Relaxed);
        if previous == 0 || previous >= 99 {
            return;
        }
        if emitted_bucket
            .compare_exchange(previous, 99, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            break;
        }
    }
    emit_container_running_progress(
        context,
        "compress",
        format,
        "create",
        format!("compressing `{format}`"),
        99.0,
        Some(execution),
    );
}

pub(crate) fn libarchive_open_read_stream(
    source: &Path,
    format_name: &str,
    filter: LibarchiveReadFilter,
) -> Result<ReadArchive> {
    let mut archive = ReadArchive::new(&format!("{format_name} probe failed"))?;
    let setup_result = (|| -> Result<()> {
        archive.support_raw_format(&format!(
            "{format_name} probe failed while enabling raw format"
        ))?;
        archive.support_filter(
            filter,
            &format!(
                "{format_name} probe failed while enabling {} filter",
                libarchive_read_filter_name(filter)
            ),
        )?;
        archive.open_filename(
            source,
            "container source",
            LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES,
            &format!(
                "{format_name} probe failed while opening input `{}`",
                source.display()
            ),
        )?;
        Ok(())
    })();

    setup_result?;
    Ok(archive)
}

fn libarchive_read_filter_name(filter: LibarchiveReadFilter) -> &'static str {
    match filter {
        LibarchiveReadFilter::Gzip => "gzip",
        LibarchiveReadFilter::Bzip2 => "bzip2",
        LibarchiveReadFilter::Xz => "xz",
        LibarchiveReadFilter::Zstd => "zstd",
    }
}

pub(crate) fn libarchive_close_read_stream(archive: ReadArchive, format_name: &str) -> Result<()> {
    archive.close(
        &format!("{format_name} probe failed while closing reader"),
        &format!("{format_name} probe failed while releasing reader"),
    )
}

pub(crate) fn probe_stream_with_libarchive(
    source: &Path,
    format_name: &str,
    filter: LibarchiveReadFilter,
) -> Result<u64> {
    trace!(
        format = format_name,
        source = %source.display(),
        "libarchive stream probe start"
    );
    let mut archive = libarchive_open_read_stream(source, format_name, filter)?;
    let result = (|| -> Result<u64> {
        if !archive.next_header(&format!("{format_name} probe failed while reading header"))? {
            return Err(RomWeaverError::Validation(format!(
                "{format_name} probe found no compressed payload entries"
            )));
        }

        let mut total = 0_u64;
        let mut buffer = vec![0_u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
        loop {
            let bytes = archive.read_data(
                &mut buffer,
                &format!("{format_name} probe failed while reading payload"),
            )?;
            if bytes == 0 {
                break;
            }
            let bytes_u64 = u64::try_from(bytes).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "{format_name} probe failed: decoded size exceeded u64 range"
                ))
            })?;
            total = total.checked_add(bytes_u64).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{format_name} probe failed: uncompressed size overflowed u64"
                ))
            })?;
        }
        trace!(
            format = format_name,
            logical_bytes = total,
            "libarchive stream probe result"
        );
        Ok(total)
    })();

    match (result, libarchive_close_read_stream(archive, format_name)) {
        (Ok(bytes), Ok(())) => Ok(bytes),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

type LibarchiveProbeSummary = rom_weaver_libarchive::RegularArchiveProbeSummary;

pub(crate) fn probe_regular_archive_with_libarchive(
    source: &Path,
    format_name: &str,
    expected: LibarchiveProbeFormat,
) -> ProbeConfidence {
    match probe_regular_archive_format(source, format_name, expected) {
        Ok(true) => ProbeConfidence::Signature,
        _ => ProbeConfidence::Extension,
    }
}

pub(crate) fn probe_regular_archive_details_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<LibarchiveProbeSummary> {
    probe_regular_archive_with_libarchive_impl(source, format_name)
}

pub(crate) fn list_regular_archive_entries_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<Vec<String>> {
    Ok(list_regular_archive_entries(source, format_name)?
        .into_iter()
        .map(|entry| normalize_archive_name(&entry.path))
        .filter(|entry| !entry.is_empty())
        .collect())
}

pub(crate) fn list_regular_archive_entry_records_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<Vec<ContainerListEntry>> {
    Ok(list_regular_archive_entries(source, format_name)?
        .into_iter()
        .filter_map(|entry| {
            let path = normalize_archive_name(&entry.path);
            if path.is_empty() {
                return None;
            }
            Some(ContainerListEntry {
                path,
                size: if entry.is_dir { None } else { entry.size },
            })
        })
        .collect())
}

#[derive(Clone, Debug)]
struct LibarchiveExtractTask {
    index: usize,
    archive_name: String,
    output_path: PathBuf,
    is_dir: bool,
    logical_bytes: Option<u64>,
}

// Below this total uncompressed size a multi-file archive extract runs serially instead of spawning a
// worker per file. Mirrors 7z create's `LZMA2_MT_SPLIT_THRESHOLD_BYTES` floor: standing up the
// budget-sized worker pool for a tiny archive costs more than it saves — each worker is a thread (a
// Worker + wasm instantiate + per-thread OPFS fd-build on wasm, ~tens of ms) that trivial decode
// never uses.
const LIBARCHIVE_EXTRACT_MT_THRESHOLD_BYTES: u64 = 4 << 20;

// Total uncompressed bytes of the file (non-directory) entries to extract. Uses the per-entry logical
// size from the archive header, so a small outer archive wrapping one large nested container still
// reports a large total and keeps its parallelism.
fn libarchive_extract_total_logical_bytes(tasks: &[LibarchiveExtractTask]) -> u64 {
    tasks
        .iter()
        .filter(|task| !task.is_dir)
        .map(|task| task.logical_bytes.unwrap_or(0))
        .fold(0u64, |total, bytes| total.saturating_add(bytes))
}

// Worker count for a libarchive extract: serial below the MT floor, otherwise one per file entry (the
// thread negotiator then clamps to the configured budget). Mirrors 7z create's `lzma2_achievable_blocks`.
fn libarchive_extract_achievable_threads(
    total_logical_bytes: u64,
    file_task_count: usize,
) -> usize {
    if total_logical_bytes <= LIBARCHIVE_EXTRACT_MT_THRESHOLD_BYTES {
        1
    } else {
        file_task_count.max(1)
    }
}

#[derive(Debug)]
enum LibarchiveExtractOutput {
    Directory {
        output_path: PathBuf,
    },
    FileStart {
        index: usize,
        archive_name: String,
        output_path: PathBuf,
        logical_bytes: Option<u64>,
    },
    FileData {
        index: usize,
        archive_name: String,
        bytes: Vec<u8>,
    },
    FileEnd {
        index: usize,
        archive_name: String,
    },
}

struct LibarchiveOpenExtractOutput {
    archive_name: String,
    hasher: ExtractHasher,
    output_path: PathBuf,
    writer: BufWriter<File>,
}

fn build_libarchive_extract_tasks(
    source: &Path,
    out_dir: &Path,
    selections: &[String],
    kind_filter: ArchiveEntryKindFilter,
    ignore_common_files: bool,
    include_nested_containers: bool,
    format_name: &str,
) -> Result<Vec<LibarchiveExtractTask>> {
    let mut matcher = SelectionMatcher::new(selections);
    let should_filter_common = ignore_common_files && selections.is_empty();
    let mut ignored_count = 0usize;
    let mut kind_filtered_count = 0usize;
    let mut tasks = Vec::new();
    let mut payload_kind_tasks = Vec::new();
    let mut container_fallback_tasks = Vec::new();

    for entry in list_regular_archive_entries(source, format_name)? {
        let entry_path = entry.path;
        let archive_name = normalize_archive_name(&entry_path);
        if archive_name.is_empty() || !matcher.matches(&archive_name) {
            continue;
        }
        if should_filter_common && should_ignore_common_container_file(&archive_name) {
            ignored_count = ignored_count.saturating_add(1);
            continue;
        }
        let relative = sanitize_archive_relative_path_from_str(&entry_path)?;
        let is_dir = entry.is_dir;
        let task = LibarchiveExtractTask {
            index: entry.index,
            archive_name: archive_name.clone(),
            output_path: out_dir.join(relative),
            is_dir,
            logical_bytes: if is_dir { Some(0) } else { entry.size },
        };
        if kind_filter.enabled() {
            if kind_filter.matches_payload_name(&archive_name) {
                payload_kind_tasks.push(task);
            } else if kind_filter.matches_container_fallback_name(&archive_name) {
                container_fallback_tasks.push(task);
            } else {
                kind_filtered_count = kind_filtered_count.saturating_add(1);
            }
        } else {
            tasks.push(task);
        }
    }

    matcher.ensure_all_matched()?;
    if kind_filter.enabled() {
        tasks = if include_nested_containers {
            // Exhaustive nested extract-all: keep the matched payloads AND any nested-container
            // entries, so descent continues into deeper sub-archives (e.g. a patch sitting beside
            // a further nested zip) instead of stopping once sibling payloads are found.
            payload_kind_tasks.append(&mut container_fallback_tasks);
            payload_kind_tasks
        } else if payload_kind_tasks.iter().any(|task| !task.is_dir) {
            payload_kind_tasks
        } else {
            container_fallback_tasks
        };
    }
    if should_filter_common && ignored_count > 0 && !tasks.iter().any(|task| !task.is_dir) {
        return Err(RomWeaverError::Validation(format!(
            "all extract entries from `{}` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>",
            source.display()
        )));
    }
    if kind_filter.enabled() && kind_filtered_count > 0 && !tasks.iter().any(|task| !task.is_dir) {
        return Err(RomWeaverError::Validation(format!(
            "no extract entries from `{}` matched {}",
            source.display(),
            kind_filter.flag_label()
        )));
    }
    Ok(tasks)
}

fn libarchive_extract_total_file_bytes(tasks: &[LibarchiveExtractTask]) -> Option<u64> {
    let mut total = 0u64;
    for task in tasks {
        if task.is_dir {
            continue;
        }
        total = total.saturating_add(task.logical_bytes?);
    }
    Some(total)
}

fn extract_libarchive_task_chunk<F, G>(
    source: &Path,
    chunk: &[LibarchiveExtractTask],
    format_name: &str,
    context: &OperationContext,
    overwrite: bool,
    mut on_bytes_written: F,
    mut on_task_complete: G,
) -> Result<(u64, Vec<ExtractedFileChecksum>)>
where
    F: FnMut(u64),
    G: FnMut(),
{
    if chunk.is_empty() {
        return Ok((0, Vec::new()));
    }

    let mut tasks_by_index = BTreeMap::new();
    for task in chunk {
        tasks_by_index.insert(task.index, task);
    }
    let selected_indices = tasks_by_index.keys().copied().collect::<BTreeSet<_>>();
    let mut written_bytes = 0u64;
    let mut output_checksums = Vec::new();
    let matched_tasks = visit_selected_regular_archive_entries(
        source,
        format_name,
        &selected_indices,
        |selected_entry| -> Result<()> {
            match selected_entry {
                SelectedRegularArchiveEntry::Directory { entry } => {
                    let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while resolving selected directory index {}",
                            entry.index
                        ))
                    })?;
                    fs::create_dir_all(&task.output_path)?;
                }
                SelectedRegularArchiveEntry::File { entry, reader } => {
                    let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while resolving selected file index {}",
                            entry.index
                        ))
                    })?;
                    if task.is_dir {
                        fs::create_dir_all(&task.output_path)?;
                    } else {
                        trace!(
                            format = format_name,
                            index = task.index,
                            name = %task.archive_name,
                            size = task.logical_bytes.unwrap_or(0),
                            "libarchive extract entry"
                        );
                        if let Some(parent) = task.output_path.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        let mut output = BufWriter::new(create_extract_output_file(
                            &task.output_path,
                            overwrite,
                        )?);
                        let mut hasher =
                            ExtractHasher::new(context, task.logical_bytes, &task.output_path)?;
                        let mut copied = 0u64;
                        let mut buffer = vec![0u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
                        loop {
                            let read = reader.read(&mut buffer).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while reading entry {} (`{}`): {error}",
                                    task.index, task.archive_name
                                ))
                            })?;
                            if read == 0 {
                                break;
                            }
                            output.write_all(&buffer[..read]).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while writing entry {} (`{}`): {error}",
                                    task.index, task.archive_name
                                ))
                            })?;
                            hasher.update(&buffer[..read])?;
                            let read_u64 = read as u64;
                            copied = copied.saturating_add(read_u64);
                            on_bytes_written(read_u64);
                        }
                        output.flush()?;
                        drop(output);
                        written_bytes = written_bytes.saturating_add(copied);
                        if let Some(entry) = hasher.finish(&task.output_path)? {
                            output_checksums.push(entry);
                        }
                    }
                }
            }
            on_task_complete();
            Ok(())
        },
    )?;

    if matched_tasks != tasks_by_index.len() {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} extract failed because selected entries changed while processing"
        )));
    }

    Ok((written_bytes, output_checksums))
}

fn send_libarchive_extract_output(
    sender: &mpsc::SyncSender<LibarchiveExtractOutput>,
    output: LibarchiveExtractOutput,
    format_name: &str,
) -> Result<()> {
    sender.send(output).map_err(|_| {
        RomWeaverError::Validation(format!("{format_name} extract output receiver closed"))
    })
}

/// Where a worker chunk reads the archive image. `Memory` carries the source bytes read once on the
/// main thread (the only thread that can open an OPFS-backed intermediate in the browser), so worker
/// threads read from shared memory instead of re-`open`ing the file and failing with `os error 44`.
enum ChunkArchiveSource<'a> {
    Path(&'a Path),
    Memory(Arc<[u8]>),
}

fn extract_libarchive_task_chunk_to_sender(
    source: ChunkArchiveSource<'_>,
    chunk: &[LibarchiveExtractTask],
    format_name: &str,
    sender: &mpsc::SyncSender<LibarchiveExtractOutput>,
) -> Result<()> {
    if chunk.is_empty() {
        return Ok(());
    }

    let mut tasks_by_index = BTreeMap::new();
    for task in chunk {
        tasks_by_index.insert(task.index, task);
    }
    let selected_indices = tasks_by_index.keys().copied().collect::<BTreeSet<_>>();
    let mut visit = |selected_entry: SelectedRegularArchiveEntry<'_>| -> Result<()> {
        match selected_entry {
            SelectedRegularArchiveEntry::Directory { entry } => {
                let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "{format_name} extract failed while resolving selected directory index {}",
                        entry.index
                    ))
                })?;
                send_libarchive_extract_output(
                    sender,
                    LibarchiveExtractOutput::Directory {
                        output_path: task.output_path.clone(),
                    },
                    format_name,
                )?;
            }
            SelectedRegularArchiveEntry::File { entry, reader } => {
                let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "{format_name} extract failed while resolving selected file index {}",
                        entry.index
                    ))
                })?;
                if task.is_dir {
                    send_libarchive_extract_output(
                        sender,
                        LibarchiveExtractOutput::Directory {
                            output_path: task.output_path.clone(),
                        },
                        format_name,
                    )?;
                } else {
                    trace!(
                        format = format_name,
                        index = task.index,
                        name = %task.archive_name,
                        size = task.logical_bytes.unwrap_or(0),
                        "libarchive extract entry (parallel)"
                    );
                    send_libarchive_extract_output(
                        sender,
                        LibarchiveExtractOutput::FileStart {
                            index: task.index,
                            archive_name: task.archive_name.clone(),
                            output_path: task.output_path.clone(),
                            logical_bytes: task.logical_bytes,
                        },
                        format_name,
                    )?;
                    let mut buffer = vec![0u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
                    loop {
                        let read = reader.read(&mut buffer).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while reading entry {} (`{}`): {error}",
                                    task.index, task.archive_name
                                ))
                            })?;
                        if read == 0 {
                            break;
                        }
                        send_libarchive_extract_output(
                            sender,
                            LibarchiveExtractOutput::FileData {
                                index: task.index,
                                archive_name: task.archive_name.clone(),
                                bytes: buffer[..read].to_vec(),
                            },
                            format_name,
                        )?;
                    }
                    send_libarchive_extract_output(
                        sender,
                        LibarchiveExtractOutput::FileEnd {
                            index: task.index,
                            archive_name: task.archive_name.clone(),
                        },
                        format_name,
                    )?;
                }
            }
        }
        Ok(())
    };
    let matched_tasks = match source {
        ChunkArchiveSource::Path(path) => visit_selected_regular_archive_entries(
            path,
            format_name,
            &selected_indices,
            &mut visit,
        )?,
        ChunkArchiveSource::Memory(bytes) => visit_selected_regular_archive_entries_from_memory(
            bytes,
            format_name,
            &selected_indices,
            &mut visit,
        )?,
    };

    if matched_tasks != tasks_by_index.len() {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} extract failed because selected entries changed while processing"
        )));
    }

    Ok(())
}

pub(crate) fn extract_regular_archive_with_libarchive(
    request: &ContainerExtractRequest,
    context: &OperationContext,
    format_name: &'static str,
) -> Result<OperationReport> {
    fs::create_dir_all(&request.out_dir)?;
    let tasks = build_libarchive_extract_tasks(
        &request.source,
        &request.out_dir,
        &request.selections,
        request.kind_filter,
        request.ignore_common_files,
        request.containing_archive.is_some(),
        format_name,
    )?;
    let total_tasks = tasks.len();
    let total_file_bytes = libarchive_extract_total_file_bytes(&tasks).filter(|total| *total > 0);
    debug!(
        format = format_name,
        tasks = total_tasks,
        total_file_bytes = total_file_bytes.unwrap_or(0),
        selections = request.selections.len(),
        nested = request.containing_archive.is_some(),
        "libarchive archive extract start"
    );

    let mut output_paths = BTreeSet::new();
    let mut duplicate_output_paths = false;
    for task in &tasks {
        if task.is_dir {
            continue;
        }
        ensure_extract_output_available(&task.output_path, request.overwrite)?;
        duplicate_output_paths |= !output_paths.insert(task.output_path.clone());
    }

    let (execution, written_bytes, output_checksums) = if tasks.is_empty() || duplicate_output_paths
    {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let emitted_progress_bucket = AtomicU8::new(0);
        let mut copied_bytes = 0u64;
        let mut completed = 0usize;
        let (written, output_checksums) = extract_libarchive_task_chunk(
            &request.source,
            &tasks,
            format_name,
            context,
            request.overwrite,
            |delta| {
                if let Some(total_bytes) = total_file_bytes {
                    copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                    maybe_emit_container_byte_progress(
                        context,
                        copied_bytes,
                        total_bytes,
                        ContainerByteProgress {
                            command: "extract",
                            format: format_name,
                            stage: "extract",
                            label: &format!("extracting `{format_name}`"),
                            thread_execution: Some(&execution),
                            emitted_progress_bucket: &emitted_progress_bucket,
                        },
                    );
                }
            },
            || {
                if total_file_bytes.is_none() {
                    completed = completed.saturating_add(1);
                    emit_container_step_progress(
                        &ContainerProgressContext {
                            context,
                            command: "extract",
                            format: format_name,
                            stage: "extract",
                            thread_execution: Some(&execution),
                        },
                        completed,
                        total_tasks,
                        format!("extracting `{format_name}` ({completed}/{total_tasks})"),
                    );
                }
            },
        )?;
        (execution, written, output_checksums)
    } else {
        let file_task_count = tasks.iter().filter(|task| !task.is_dir).count().max(1);
        let total_logical_bytes = libarchive_extract_total_logical_bytes(&tasks);
        let achievable_threads =
            libarchive_extract_achievable_threads(total_logical_bytes, file_task_count);
        // Only stand up the shared worker pool when this extract will actually parallelize. A small
        // archive (under the MT floor, or a single file) negotiates serial, and building the
        // budget-sized operation pool for it would spawn a worker per budget thread that the serial
        // decode never uses (the dominant cost on wasm). Skipping it keeps the operation pool lazy so
        // a later parallel extract — e.g. a large nested container — still builds and reuses it.
        // Mirrors 7z create, which skips its pool below the MT floor.
        let mut execution =
            context.plan_threads(ThreadCapability::parallel(Some(achievable_threads)));
        let pool = if execution.used_parallelism {
            let (pool_execution, pool) =
                context.build_pool(ThreadCapability::parallel(Some(achievable_threads)))?;
            execution = pool_execution;
            Some(pool)
        } else {
            None
        };
        let source = request.source.clone();
        let progress_context = context.clone();
        let progress_execution = execution.clone();
        // In the browser only the main runner thread can open an OPFS-backed source; read the whole
        // archive image here (on the calling thread) so the parallel workers extract from shared
        // bytes instead of re-opening the file, which fails with `os error 44`. This applies to any
        // OPFS-staged source, not just nested intermediates a prior extract step wrote: a top-level
        // extract (e.g. a patch archive staged to OPFS, `parent=None`) hits the same worker-open
        // wall on Safari iOS. Gated by `container_reads_source_on_main_thread()` (always true on
        // wasm; native opts in via env for tests), so native still opens per-worker for overlap.
        let source_bytes: Option<Arc<[u8]>> =
            if execution.used_parallelism && container_reads_source_on_main_thread() {
                Some(Arc::from(fs::read(&source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{format_name} extract failed while reading source on the main thread: {error}"
                ))
            })?))
            } else {
                None
            };
        trace!(
            format = format_name,
            used_parallelism = execution.used_parallelism,
            effective_threads = execution.effective_threads,
            read_on_main = source_bytes.is_some(),
            "libarchive parallel extract path selected"
        );

        let mut output_checksums = Vec::new();
        let written_bytes = if execution.used_parallelism {
            // `effective_threads` is the compute-worker budget. The two coordination threads — the
            // rayon driver below (it calls `pool.install` and parks, so it holds no pool slot) and
            // the consuming thread that drains the channel and hashes every extracted byte — run on
            // top of these workers, not subtracted from them, so a configured budget of N decodes
            // with N workers.
            let worker_count = execution.effective_threads.max(1);
            let chunk_size = tasks.len().div_ceil(worker_count).max(1);
            let (sender, receiver) = mpsc::sync_channel::<LibarchiveExtractOutput>(
                bounded_items_for_threads(execution.effective_threads),
            );
            let emitted_progress_bucket = AtomicU8::new(0);
            let mut copied_bytes = 0u64;
            let mut completed = 0usize;
            let mut written_bytes = 0u64;
            let mut open_outputs = BTreeMap::<usize, LibarchiveOpenExtractOutput>::new();
            let mut write_result = Ok(());

            thread::scope(|scope| -> Result<u64> {
                let producer = thread::Builder::new()
                    .name("rom-weaver-libarchive-extract".to_string())
                    .stack_size(PARALLEL_COORDINATOR_STACK_SIZE_BYTES)
                    .spawn_scoped(scope, || {
                        pool.as_ref()
                            .expect("parallel extract builds a worker pool")
                            .install(|| {
                                tasks.par_chunks(chunk_size).try_for_each_with(
                                    sender,
                                    |sender, chunk| {
                                        let chunk_source = match &source_bytes {
                                            Some(bytes) => {
                                                ChunkArchiveSource::Memory(Arc::clone(bytes))
                                            }
                                            None => ChunkArchiveSource::Path(&source),
                                        };
                                        extract_libarchive_task_chunk_to_sender(
                                            chunk_source,
                                            chunk,
                                            format_name,
                                            sender,
                                        )
                                    },
                                )
                            })
                    })
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to start parallel {format_name} extract coordinator: {error}"
                        ))
                    })?;

                let mut receiver = Some(receiver);
                while let Some(active_receiver) = receiver.as_ref() {
                    let item = match active_receiver.recv() {
                        Ok(item) => item,
                        Err(_) => break,
                    };
                    let item_result = match item {
                        LibarchiveExtractOutput::Directory { output_path } => {
                            fs::create_dir_all(output_path)?;
                            if total_file_bytes.is_none() {
                                completed = completed.saturating_add(1);
                                emit_container_step_progress(
                                    &ContainerProgressContext {
                                        context: &progress_context,
                                        command: "extract",
                                        format: format_name,
                                        stage: "extract",
                                        thread_execution: Some(&progress_execution),
                                    },
                                    completed,
                                    total_tasks,
                                    format!(
                                        "extracting `{format_name}` ({completed}/{total_tasks})"
                                    ),
                                );
                            }
                            Ok(())
                        }
                        LibarchiveExtractOutput::FileStart {
                            index,
                            archive_name,
                            output_path,
                            logical_bytes,
                        } => {
                            if let Some(parent) = output_path.parent() {
                                fs::create_dir_all(parent)?;
                            }
                            if let std::collections::btree_map::Entry::Vacant(e) =
                                open_outputs.entry(index)
                            {
                                let writer = BufWriter::new(create_extract_output_file(
                                    &output_path,
                                    request.overwrite,
                                )?);
                                let hasher =
                                    ExtractHasher::new(context, logical_bytes, &output_path)?;
                                e.insert(LibarchiveOpenExtractOutput {
                                    archive_name,
                                    hasher,
                                    output_path,
                                    writer,
                                });
                                Ok(())
                            } else {
                                Err(RomWeaverError::Validation(format!(
                                    "{format_name} extract received duplicate start for entry {index} (`{archive_name}`)"
                                )))
                            }
                        }
                        LibarchiveExtractOutput::FileData {
                            index,
                            archive_name,
                            bytes,
                        } => {
                            let output = open_outputs.get_mut(&index).ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract received data before start for entry {index} (`{archive_name}`)"
                                ))
                            })?;
                            output.writer.write_all(&bytes).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while writing entry {index} (`{archive_name}`): {error}"
                                ))
                            })?;
                            let delta = bytes.len() as u64;
                            output.hasher.update(&bytes)?;
                            written_bytes = written_bytes.saturating_add(delta);
                            if let Some(total_bytes) = total_file_bytes {
                                copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                                maybe_emit_container_byte_progress(
                                    &progress_context,
                                    copied_bytes,
                                    total_bytes,
                                    ContainerByteProgress {
                                        command: "extract",
                                        format: format_name,
                                        stage: "extract",
                                        label: &format!("extracting `{format_name}`"),
                                        thread_execution: Some(&progress_execution),
                                        emitted_progress_bucket: &emitted_progress_bucket,
                                    },
                                );
                            }
                            Ok(())
                        }
                        LibarchiveExtractOutput::FileEnd {
                            index,
                            archive_name,
                        } => {
                            let mut output = open_outputs.remove(&index).ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract received end before start for entry {index} (`{archive_name}`)"
                                ))
                            })?;
                            output.writer.flush().map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while flushing entry {index} (`{}`): {error}",
                                    output.archive_name
                                ))
                            })?;
                            let LibarchiveOpenExtractOutput {
                                hasher,
                                output_path,
                                writer,
                                ..
                            } = output;
                            drop(writer);
                            if let Some(entry) = hasher.finish(&output_path)? {
                                output_checksums.push(entry);
                            }
                            if total_file_bytes.is_none() {
                                completed = completed.saturating_add(1);
                                emit_container_step_progress(
                                    &ContainerProgressContext {
                                        context: &progress_context,
                                        command: "extract",
                                        format: format_name,
                                        stage: "extract",
                                        thread_execution: Some(&progress_execution),
                                    },
                                    completed,
                                    total_tasks,
                                    format!(
                                        "extracting `{format_name}` ({completed}/{total_tasks})"
                                    ),
                                );
                            }
                            Ok(())
                        }
                    };
                    if let Err(error) = item_result {
                        write_result = Err(error);
                        drop(receiver.take());
                        break;
                    }
                }

                let producer_result = producer.join().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "parallel {format_name} extract coordinator panicked"
                    ))
                })?;
                write_result?;
                producer_result?;
                if let Some((index, output)) = open_outputs.into_iter().next() {
                    return Err(RomWeaverError::Validation(format!(
                        "{format_name} extract finished with unclosed entry {index} (`{}`)",
                        output.archive_name
                    )));
                }
                Ok(written_bytes)
            })?
        } else {
            let emitted_progress_bucket = AtomicU8::new(0);
            let mut copied_bytes = 0u64;
            let mut completed = 0usize;
            let (written_bytes, checksums) = extract_libarchive_task_chunk(
                &source,
                &tasks,
                format_name,
                context,
                request.overwrite,
                |delta| {
                    if let Some(total_bytes) = total_file_bytes {
                        copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                        maybe_emit_container_byte_progress(
                            &progress_context,
                            copied_bytes,
                            total_bytes,
                            ContainerByteProgress {
                                command: "extract",
                                format: format_name,
                                stage: "extract",
                                label: &format!("extracting `{format_name}`"),
                                thread_execution: Some(&progress_execution),
                                emitted_progress_bucket: &emitted_progress_bucket,
                            },
                        );
                    }
                },
                || {
                    if total_file_bytes.is_none() {
                        completed = completed.saturating_add(1);
                        emit_container_step_progress(
                            &ContainerProgressContext {
                                context: &progress_context,
                                command: "extract",
                                format: format_name,
                                stage: "extract",
                                thread_execution: Some(&progress_execution),
                            },
                            completed,
                            total_tasks,
                            format!("extracting `{format_name}` ({completed}/{total_tasks})"),
                        );
                    }
                },
            )?;
            output_checksums = checksums;
            written_bytes
        };
        (execution, written_bytes, output_checksums)
    };

    let file_count = tasks.iter().filter(|task| !task.is_dir).count();
    debug!(
        format = format_name,
        files = file_count,
        written_bytes,
        used_parallelism = execution.used_parallelism,
        "libarchive archive extract complete"
    );
    let report = OperationReport::succeeded(
        OperationFamily::Container,
        Some(format_name.to_string()),
        "extract",
        format!(
            "extracted `{}` to `{}` ({} file(s), {} bytes written)",
            request.source.display(),
            request.out_dir.display(),
            file_count,
            written_bytes
        ),
        Some(100.0),
        Some(execution.clone()),
    );
    let report =
        attach_extraction_details(report, tasks.len(), file_count, written_bytes, &execution);
    Ok(attach_extract_checksum_details(report, output_checksums))
}
