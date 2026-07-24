use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, SystemTime},
};

use crate::libarchive::{
    EntryFileType, EntrySpec, ReadArchive, ReadFilter as LibarchiveReadFilter,
    RegularArchiveProbeFormat as LibarchiveProbeFormat, SelectedRegularArchiveEntry, WriteArchive,
    WriteFilter as LibarchiveCreateFilter, WriteFormat as LibarchiveCreateFormat,
    ZeroWriteBehavior, list_regular_archive_entries,
    probe_regular_archive as probe_regular_archive_with_libarchive_impl,
    probe_regular_archive_format, visit_selected_regular_archive_entries,
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
use tracing::{debug, trace};

use crate::{
    archive_entries::{ArchiveInputEntry, sanitize_archive_relative_path_from_str},
    attach_emitted_file_paths, attach_extraction_details,
    constants::{LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES, PARALLEL_COORDINATOR_STACK_SIZE_BYTES},
    extract_support::{
        ContainerProgressContext, ExtractChecksumTiming, ExtractHasher, ExtractTiming,
        ExtractedFileChecksum, attach_extract_checksum_details, emit_container_step_progress,
        emit_extract_identity, emit_variant_plan, ensure_extract_output_available,
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
                let previous_bucket = loop {
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
                        break previous_bucket;
                    }
                };
                // The main archive thread samples the shared encoded-bytes
                // counter only at drain points, so a fast multi-threaded
                // encode can skip many percent levels between callbacks (and
                // observe only the final one). Fill the gap like
                // maybe_emit_container_byte_progress does, so progress stays
                // dense no matter how sparsely the counter was sampled.
                for bucket in previous_bucket.saturating_add(1)..=percent_bucket {
                    emit_container_running_progress(
                        &codec_progress_context,
                        "compress",
                        codec_progress_format,
                        "create",
                        format!("compressing `{codec_progress_format}`"),
                        bucket as f32,
                        Some(&codec_progress_execution),
                    );
                }
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
        // No `previous == 0` early-out: a fast encode can finish before the
        // running path ever observes a nonzero bucket, and suppressing the
        // terminal event then would leave the whole compress without progress.
        if previous >= 99 {
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

type LibarchiveProbeSummary = crate::libarchive::RegularArchiveProbeSummary;

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
    relative_path: PathBuf,
    output_path: PathBuf,
    write_path: PathBuf,
    is_dir: bool,
    logical_bytes: Option<u64>,
}

// Below this total uncompressed size a multi-file archive extract runs serially instead of spawning a
// worker per file. Mirrors 7z create's `LZMA2_MT_SPLIT_THRESHOLD_BYTES` floor: standing up the
// budget-sized worker pool for a tiny archive costs more than it saves - each worker is a thread (a
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
        write_path: PathBuf,
        logical_bytes: Option<u64>,
    },
    FileData {
        index: usize,
        bytes: Vec<u8>,
    },
    FileEnd {
        index: usize,
    },
}

struct LibarchiveOpenExtractOutput {
    archive_name: String,
    hasher: ExtractHasher,
    output_path: PathBuf,
    write_path: PathBuf,
    writer: BufWriter<File>,
}

#[cfg(windows)]
fn extract_path_metadata_is_link(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn extract_path_metadata_is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// Reject pre-existing links below the extraction root before directory creation or file writes can
/// follow them outside that root. The root itself may be a caller-selected symlink (for example a
/// platform temp-directory alias); only archive-controlled descendants are forbidden.
fn ensure_extract_path_has_no_links(out_dir: &Path, output_path: &Path) -> Result<()> {
    let relative = output_path.strip_prefix(out_dir).map_err(|_| {
        RomWeaverError::Validation(format!(
            "archive output `{}` is outside extraction directory `{}`",
            output_path.display(),
            out_dir.display()
        ))
    })?;
    let mut current = out_dir.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if extract_path_metadata_is_link(&metadata) => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to extract through existing link `{}`",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(any(test, target_family = "wasm"))]
fn normalize_confined_extract_root(out_dir: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in out_dir.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(RomWeaverError::Validation(format!(
                        "extraction directory `{}` escapes its confined filesystem root",
                        out_dir.display()
                    )));
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        normalized.push(".");
    }
    Ok(normalized)
}

#[cfg(target_family = "wasm")]
fn resolve_extract_root(out_dir: &Path) -> Result<PathBuf> {
    // Browser WASI paths are already confined to the preopened OPFS mount, whose shim does not
    // implement canonicalize/readlink. Lexical normalization is sufficient because parent escapes
    // are rejected and the mount does not expose symlinks.
    normalize_confined_extract_root(out_dir)
}

#[cfg(not(target_family = "wasm"))]
fn resolve_extract_root(out_dir: &Path) -> Result<PathBuf> {
    Ok(fs::canonicalize(out_dir)?)
}

static NEXT_EXTRACT_TRANSACTION_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(any(test, target_family = "wasm"))]
fn wasm_extract_transaction_owner_id(now: SystemTime) -> String {
    let epoch_nanos = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("wasm-{epoch_nanos:x}")
}

#[cfg(target_family = "wasm")]
fn extract_transaction_owner_id() -> String {
    // WASI preview1 does not implement std::process::id(). A time-based module nonce prevents a
    // fresh worker from exhausting its create-new collision loop on staging directories left by a
    // killed predecessor. Unknown directories are never removed because another tab may own them.
    wasm_extract_transaction_owner_id(SystemTime::now())
}

#[cfg(not(target_family = "wasm"))]
fn extract_transaction_owner_id() -> String {
    std::process::id().to_string()
}

#[cfg(unix)]
fn create_private_extract_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = DirBuilder::new();
    builder.mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_extract_directory(path: &Path) -> std::io::Result<()> {
    DirBuilder::new().create(path)
}

#[cfg(not(target_family = "wasm"))]
fn copy_extract_file_create_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut source_file = File::open(source)?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copy_result = std::io::copy(&mut source_file, &mut destination_file)
        .and_then(|_| destination_file.flush());
    drop(destination_file);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

#[cfg(target_family = "wasm")]
fn copy_extract_file_create_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut source_file = File::open(source)?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copy_result = (|| {
        let mut buffer = vec![0_u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
        loop {
            let read = source_file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            destination_file.write_all(&buffer[..read])?;
        }
        destination_file.flush()
    })();
    drop(destination_file);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn install_staged_no_overwrite_with<F>(
    staged_path: &Path,
    destination_path: &Path,
    hard_link: F,
) -> std::io::Result<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    match hard_link(staged_path, destination_path) {
        Ok(()) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::NotFound
            ) =>
        {
            return Err(error);
        }
        Err(_) => copy_extract_file_create_new(staged_path, destination_path)?,
    }
    // The installed file is complete. Transaction cleanup retries the staging removal, so failure
    // to remove its old name is not a reason to roll the destination back.
    let _ = fs::remove_file(staged_path);
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn install_staged_no_overwrite(staged_path: &Path, destination_path: &Path) -> std::io::Result<()> {
    install_staged_no_overwrite_with(staged_path, destination_path, |source, destination| {
        fs::hard_link(source, destination)
    })
}

#[cfg(target_family = "wasm")]
fn install_staged_no_overwrite(staged_path: &Path, destination_path: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(staged_path, destination_path)?;
    let _ = fs::remove_file(staged_path);
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn backup_extract_output(source: &Path, backup: &Path) -> std::io::Result<()> {
    fs::rename(source, backup)
}

#[cfg(target_family = "wasm")]
fn backup_extract_output(source: &Path, backup: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(source, backup)?;
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(backup);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn install_staged_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(target_family = "wasm")]
fn install_staged_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(source, destination)?;
    let _ = fs::remove_file(source);
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn restore_extract_backup(backup: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(backup, destination)
}

#[cfg(target_family = "wasm")]
fn restore_extract_backup(backup: &Path, destination: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(backup, destination)?;
    let _ = fs::remove_file(backup);
    Ok(())
}

#[derive(Debug)]
struct CommittedExtractOutput {
    destination_path: PathBuf,
    backup_path: Option<PathBuf>,
}

/// Stages every decoded archive member before publishing it. Existing outputs are first moved into
/// the private backup tree so an error (or panic) during a later install can restore them instead of
/// leaving truncated files.
struct LibarchiveExtractTransaction<'a> {
    format_name: &'a str,
    overwrite: bool,
    root_path: PathBuf,
    staging_dir: PathBuf,
    staged_outputs_dir: PathBuf,
    backup_dir: PathBuf,
    committed_outputs: Vec<CommittedExtractOutput>,
    created_destination_dirs: Vec<PathBuf>,
    committed: bool,
    preserve_staging: bool,
}

impl<'a> LibarchiveExtractTransaction<'a> {
    fn new(out_dir: &Path, overwrite: bool, format_name: &'a str) -> Result<Self> {
        // Resolve a caller-selected root symlink once. Every subsequent path is rooted at the same
        // physical directory, so retargeting that symlink cannot redirect an in-flight extract.
        let root_path = resolve_extract_root(out_dir)?;
        // Keep staging inside the output root so native rename/hard-link installs stay on one
        // filesystem, including when out_dir itself is a mount point. stage_tasks reserves this
        // hidden namespace so archive members cannot address the transaction's new/backup trees.
        let mut staging_dir = None;
        let owner_id = extract_transaction_owner_id();
        for _ in 0..100 {
            let sequence = NEXT_EXTRACT_TRANSACTION_ID.fetch_add(1, Ordering::Relaxed);
            let candidate = root_path.join(format!(".rom-weaver-extract-{owner_id}-{sequence}"));
            match create_private_extract_directory(&candidate) {
                Ok(()) => {
                    staging_dir = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        let staging_dir = staging_dir.ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{format_name} extract could not allocate a private staging directory"
            ))
        })?;
        let staged_outputs_dir = staging_dir.join("new");
        let backup_dir = staging_dir.join("old");
        if let Err(error) = create_private_extract_directory(&staged_outputs_dir)
            .and_then(|()| create_private_extract_directory(&backup_dir))
        {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(error.into());
        }
        Ok(Self {
            format_name,
            overwrite,
            root_path,
            staging_dir,
            staged_outputs_dir,
            backup_dir,
            committed_outputs: Vec::new(),
            created_destination_dirs: Vec::new(),
            committed: false,
            preserve_staging: false,
        })
    }

    fn stage_tasks(&self, tasks: &[LibarchiveExtractTask]) -> Result<Vec<LibarchiveExtractTask>> {
        tasks
            .iter()
            .cloned()
            .map(|mut task| -> Result<LibarchiveExtractTask> {
                let uses_reserved_namespace = task
                    .relative_path
                    .components()
                    .next()
                    .and_then(|component| match component {
                        std::path::Component::Normal(component) => component.to_str(),
                        _ => None,
                    })
                    .is_some_and(|component| {
                        component
                            .to_ascii_lowercase()
                            .starts_with(".rom-weaver-extract-")
                    });
                if uses_reserved_namespace {
                    return Err(RomWeaverError::Validation(format!(
                        "{} extract entry `{}` uses the reserved transaction namespace",
                        self.format_name, task.archive_name
                    )));
                }
                // Archive names that alias on a case-insensitive filesystem must still decode into
                // independent files. Preserve only the extension needed by checksum/identity logic;
                // the entry index supplies uniqueness without recreating the archive's directory
                // chain inside the private staging tree.
                let mut staging_name = OsString::from(task.index.to_string());
                if let Some(extension) = task.output_path.extension() {
                    staging_name.push(".");
                    staging_name.push(extension);
                }
                task.write_path = self.staged_outputs_dir.join(staging_name);
                Ok(task)
            })
            .collect()
    }

    fn ensure_destination_directory(&mut self, relative: &Path) -> Result<()> {
        let mut current = self.root_path.clone();
        for component in relative.components() {
            let std::path::Component::Normal(component) = component else {
                return Err(RomWeaverError::Validation(format!(
                    "{} extract produced invalid destination path `{}`",
                    self.format_name,
                    relative.display()
                )));
            };
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if extract_path_metadata_is_link(&metadata) => {
                    return Err(RomWeaverError::Validation(format!(
                        "refusing to extract through existing link `{}`",
                        current.display()
                    )));
                }
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(RomWeaverError::Validation(format!(
                        "refusing to replace non-directory extraction parent `{}`",
                        current.display()
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match fs::create_dir(&current) {
                        Ok(()) => self.created_destination_dirs.push(current.clone()),
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            let metadata = fs::symlink_metadata(&current)?;
                            if extract_path_metadata_is_link(&metadata) || !metadata.is_dir() {
                                return Err(RomWeaverError::Validation(format!(
                                    "refusing to extract through replaced parent `{}`",
                                    current.display()
                                )));
                            }
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn commit_file(&mut self, task: &LibarchiveExtractTask) -> Result<()> {
        let destination_path = self.root_path.join(&task.relative_path);
        let staged_path = &task.write_path;
        let parent = task.relative_path.parent().unwrap_or_else(|| Path::new(""));
        self.ensure_destination_directory(parent)?;
        // Revalidate at the mutation boundary rather than relying on the preflight performed before
        // decoding. Completed bytes remain private until this check succeeds.
        ensure_extract_path_has_no_links(&self.root_path, &destination_path)?;

        let backup_path = match fs::symlink_metadata(&destination_path) {
            Ok(metadata) if extract_path_metadata_is_link(&metadata) => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to overwrite existing link `{}`",
                    destination_path.display()
                )));
            }
            Ok(metadata) if metadata.is_file() && self.overwrite => {
                // Each archive entry gets its own backup. When several entries alias the same
                // destination, rollback walks these generations in reverse and restores the
                // original chain exactly.
                let backup_path = self.backup_dir.join(task.index.to_string());
                if let Some(parent) = backup_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                backup_extract_output(&destination_path, &backup_path)?;
                Some(backup_path)
            }
            Ok(metadata) if metadata.is_file() => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to overwrite existing output `{}`",
                    destination_path.display()
                )));
            }
            Ok(_) => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to replace non-file extraction output `{}`",
                    destination_path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        // Record a moved original before installing its replacement. If unwinding occurs between
        // those two filesystem operations, Drop can still put the original back.
        if backup_path.is_some() {
            self.committed_outputs.push(CommittedExtractOutput {
                destination_path: destination_path.clone(),
                backup_path: backup_path.clone(),
            });
        }

        ensure_extract_path_has_no_links(&self.root_path, &destination_path)?;
        let install_result = if self.overwrite || backup_path.is_some() {
            install_staged_overwrite(staged_path, &destination_path)
        } else {
            install_staged_no_overwrite(staged_path, &destination_path)
        };
        if let Err(error) = install_result {
            return Err(RomWeaverError::Validation(format!(
                "{} extract failed while installing `{}`: {error}",
                self.format_name,
                destination_path.display()
            )));
        }

        if backup_path.is_none() {
            self.committed_outputs.push(CommittedExtractOutput {
                destination_path,
                backup_path: None,
            });
        }
        Ok(())
    }

    fn rollback(&mut self) -> std::result::Result<(), String> {
        let mut errors = Vec::new();
        for output in self.committed_outputs.drain(..).rev() {
            if let Err(error) = fs::remove_file(&output.destination_path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                errors.push(format!(
                    "remove `{}`: {error}",
                    output.destination_path.display()
                ));
            }
            if let Some(backup_path) = output.backup_path
                && let Err(error) = restore_extract_backup(&backup_path, &output.destination_path)
            {
                errors.push(format!(
                    "restore `{}` from `{}`: {error}",
                    output.destination_path.display(),
                    backup_path.display()
                ));
            }
        }
        for path in self.created_destination_dirs.drain(..).rev() {
            if let Err(error) = fs::remove_dir(&path)
                && error.kind() != std::io::ErrorKind::NotFound
                && error.kind() != std::io::ErrorKind::DirectoryNotEmpty
            {
                errors.push(format!("remove directory `{}`: {error}", path.display()));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            self.preserve_staging = true;
            Err(errors.join("; "))
        }
    }

    fn commit(&mut self, tasks: &[LibarchiveExtractTask]) -> Result<()> {
        let mut directories = tasks
            .iter()
            .filter(|task| task.is_dir)
            .map(|task| task.relative_path.clone())
            .collect::<Vec<_>>();
        directories.sort_by_key(|path| path.components().count());
        directories.dedup();
        for directory in directories {
            if let Err(error) = self.ensure_destination_directory(&directory) {
                let rollback_error = self.rollback().err();
                return Err(match rollback_error {
                    Some(rollback_error) => RomWeaverError::Validation(format!(
                        "{error}; rollback failed: {rollback_error}"
                    )),
                    None => error,
                });
            }
        }

        for task in tasks.iter().filter(|task| !task.is_dir) {
            if let Err(error) = self.commit_file(task) {
                let rollback_error = self.rollback().err();
                return Err(match rollback_error {
                    Some(rollback_error) => RomWeaverError::Validation(format!(
                        "{error}; rollback failed: {rollback_error}"
                    )),
                    None => error,
                });
            }
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for LibarchiveExtractTransaction<'_> {
    fn drop(&mut self) {
        if !self.committed
            && let Err(error) = self.rollback()
        {
            trace!(
                format = self.format_name,
                %error,
                "archive extract rollback was incomplete"
            );
        }
        if !self.preserve_staging {
            let _ = fs::remove_dir_all(&self.staging_dir);
        }
    }
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
        let output_path = out_dir.join(&relative);
        let task = LibarchiveExtractTask {
            index: entry.index,
            archive_name: archive_name.clone(),
            relative_path: relative,
            write_path: output_path.clone(),
            output_path,
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
                    fs::create_dir_all(&task.write_path)?;
                }
                SelectedRegularArchiveEntry::File { entry, reader } => {
                    let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while resolving selected file index {}",
                            entry.index
                        ))
                    })?;
                    if task.is_dir {
                        fs::create_dir_all(&task.write_path)?;
                    } else {
                        trace!(
                            format = format_name,
                            index = task.index,
                            name = %task.archive_name,
                            size = task.logical_bytes.unwrap_or(0),
                            "libarchive extract entry"
                        );
                        if let Some(parent) = task.write_path.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        let mut output = BufWriter::new(create_extract_output_file(
                            &task.write_path,
                            overwrite,
                        )?);
                        let mut hasher =
                            ExtractHasher::new(context, task.logical_bytes, &task.output_path)?;
                        let mut copied = 0u64;
                        let mut buffer = vec![0u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
                        // Split this entry's wall time into decode (libarchive read), output write, and
                        // inline checksum feed so the trace below shows whether hashing overlaps decoding
                        // or runs serially on this thread. `SystemTime` is the wasm-supported clock here.
                        let entry_started = SystemTime::now();
                        let mut decode = Duration::ZERO;
                        let mut write = Duration::ZERO;
                        let mut hash_feed = Duration::ZERO;
                        loop {
                            let read_at = SystemTime::now();
                            let read = reader.read(&mut buffer).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while reading entry {} (`{}`): {error}",
                                    task.index, task.archive_name
                                ))
                            })?;
                            decode += read_at.elapsed().unwrap_or_default();
                            if read == 0 {
                                break;
                            }
                            let write_at = SystemTime::now();
                            output.write_all(&buffer[..read]).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while writing entry {} (`{}`): {error}",
                                    task.index, task.archive_name
                                ))
                            })?;
                            write += write_at.elapsed().unwrap_or_default();
                            let hash_at = SystemTime::now();
                            hasher.update(&buffer[..read])?;
                            // Surface the payload's platform identity the moment enough bytes have
                            // streamed to determine it, rather than waiting for the whole file.
                            if let Some(identity) = hasher.take_ready_identity(&task.output_path) {
                                emit_extract_identity(context, format_name, &identity);
                            }
                            if let Some(plan) = hasher.take_ready_variant_plan() {
                                emit_variant_plan(context, format_name, &plan);
                            }
                            hash_feed += hash_at.elapsed().unwrap_or_default();
                            let read_u64 = read as u64;
                            copied = copied.saturating_add(read_u64);
                            on_bytes_written(read_u64);
                        }
                        output.flush()?;
                        drop(output);
                        written_bytes = written_bytes.saturating_add(copied);
                        let finalize_at = SystemTime::now();
                        let (finished, checksum_timing) = hasher.finish_timed(&task.write_path)?;
                        let timing = ExtractChecksumTimingSample {
                            format: format_name,
                            file: task.archive_name.as_str(),
                            bytes: copied,
                            decode,
                            write,
                            hash_feed,
                            drain: finalize_at.elapsed().unwrap_or_default(),
                            total: entry_started.elapsed().unwrap_or_default(),
                            checksum: checksum_timing,
                        }
                        .finish();
                        if let Some(mut entry) = finished {
                            entry.path = task.output_path.clone();
                            entry.timing = Some(timing);
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

/// One extracted entry's wall-time split, emitted as a single trace line so the checksum/extract
/// overlap is visible in trace captures (the primary wasm/browser debugging tool). Grouping the
/// fields in a struct keeps the trace call at the loop site to one statement.
struct ExtractChecksumTimingSample<'a> {
    format: &'a str,
    file: &'a str,
    bytes: u64,
    decode: Duration,
    write: Duration,
    hash_feed: Duration,
    drain: Duration,
    total: Duration,
    checksum: ExtractChecksumTiming,
}

impl ExtractChecksumTimingSample<'_> {
    /// Compute the displayable wall-time split, emit the trace line, and return the timing so the
    /// caller can attach it to the entry's report detail for the UI.
    fn finish(self) -> ExtractTiming {
        // Microsecond-rounded milliseconds keep sub-millisecond chunks from collapsing to zero.
        let ms = |duration: Duration| (duration.as_secs_f64() * 1_000_000.0).round() / 1000.0;
        let decode_ms = ms(self.decode);
        let opfs_write_ms = ms(self.write);
        // The checksum's own cost: the parallel worker hashing wall when threaded, otherwise the
        // inline per-chunk feed time measured on the extract thread.
        let checksum_ms = if self.checksum.threaded {
            (self.checksum.hash_busy_ns as f64) / 1_000_000.0
        } else {
            ms(self.hash_feed)
        };
        // How much of the checksum ran while decoding was still in flight. The synchronous fan-out
        // hashes inline between reads, so it never overlaps (its cost is already serial in the total);
        // the worker-backed path overlaps up to the decode+write window, any remainder paid as drain.
        let overlap_ms = if self.checksum.threaded {
            checksum_ms.min(decode_ms + opfs_write_ms)
        } else {
            0.0
        };
        let total_ms = ms(self.total);
        trace!(
            format = self.format,
            file = self.file,
            bytes = self.bytes,
            total_ms,
            decode_ms,
            opfs_write_ms,
            checksum_ms,
            checksum_feed_ms = ms(self.hash_feed),
            checksum_drain_ms = ms(self.drain),
            overlap_ms,
            threaded = self.checksum.threaded,
            workers = self.checksum.workers,
            "extract+checksum timing"
        );
        ExtractTiming {
            total_ms,
            decode_ms,
            opfs_write_ms,
            checksum_ms,
            overlap_ms,
            threaded: self.checksum.threaded,
            workers: self.checksum.workers,
        }
    }
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

fn extract_libarchive_task_chunk_to_sender(
    source: &Path,
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
                        output_path: task.write_path.clone(),
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
                            output_path: task.write_path.clone(),
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
                            write_path: task.write_path.clone(),
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
                                bytes: buffer[..read].to_vec(),
                            },
                            format_name,
                        )?;
                    }
                    send_libarchive_extract_output(
                        sender,
                        LibarchiveExtractOutput::FileEnd { index: task.index },
                        format_name,
                    )?;
                }
            }
        }
        Ok(())
    };
    let matched_tasks =
        visit_selected_regular_archive_entries(source, format_name, &selected_indices, &mut visit)?;

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
    let destination_tasks = build_libarchive_extract_tasks(
        &request.source,
        &request.out_dir,
        &request.selections,
        request.kind_filter,
        request.ignore_common_files,
        request.containing_archive.is_some(),
        format_name,
    )?;
    let total_tasks = destination_tasks.len();
    let total_file_bytes =
        libarchive_extract_total_file_bytes(&destination_tasks).filter(|total| *total > 0);
    debug!(
        format = format_name,
        tasks = total_tasks,
        total_file_bytes = total_file_bytes.unwrap_or(0),
        selections = request.selections.len(),
        nested = request.containing_archive.is_some(),
        "libarchive archive extract start"
    );

    for task in &destination_tasks {
        ensure_extract_path_has_no_links(&request.out_dir, &task.output_path)?;
        if task.is_dir {
            continue;
        }
        ensure_extract_output_available(&task.output_path, request.overwrite)?;
    }
    let mut transaction =
        LibarchiveExtractTransaction::new(&request.out_dir, request.overwrite, format_name)?;
    let tasks = transaction.stage_tasks(&destination_tasks)?;

    let (execution, written_bytes, output_checksums) = if tasks.is_empty() {
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
        // a later parallel extract - e.g. a large nested container - still builds and reuses it.
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
        // Each worker opens its own reader over the source and extracts its assigned entries. In
        // the browser the OPFS proxy worker owns every SyncAccessHandle, so a spawned wasm thread's
        // `path_open` is marshalled to it and succeeds - the old "read the whole archive on the main
        // thread first" workaround for `os error 44` is no longer needed. Peak memory is one entry's
        // working set per worker rather than the whole compressed archive.
        trace!(
            format = format_name,
            used_parallelism = execution.used_parallelism,
            effective_threads = execution.effective_threads,
            "libarchive parallel extract path selected"
        );

        let mut output_checksums = Vec::new();
        let written_bytes = if execution.used_parallelism {
            // `effective_threads` is the compute-worker budget. The two coordination threads - the
            // rayon driver below (it calls `pool.install` and parks, so it holds no pool slot) and
            // the consuming thread that drains the channel and hashes every extracted byte - run on
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
                                        extract_libarchive_task_chunk_to_sender(
                                            &source,
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
                            write_path,
                            logical_bytes,
                        } => {
                            if let Some(parent) = write_path.parent() {
                                fs::create_dir_all(parent)?;
                            }
                            if let std::collections::btree_map::Entry::Vacant(e) =
                                open_outputs.entry(index)
                            {
                                let writer = BufWriter::new(create_extract_output_file(
                                    &write_path,
                                    request.overwrite,
                                )?);
                                let hasher =
                                    ExtractHasher::new(context, logical_bytes, &output_path)?;
                                e.insert(LibarchiveOpenExtractOutput {
                                    archive_name,
                                    hasher,
                                    output_path,
                                    write_path,
                                    writer,
                                });
                                Ok(())
                            } else {
                                Err(RomWeaverError::Validation(format!(
                                    "{format_name} extract received duplicate start for entry {index} (`{archive_name}`)"
                                )))
                            }
                        }
                        LibarchiveExtractOutput::FileData { index, bytes } => {
                            let output = open_outputs.get_mut(&index).ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract received data before start for entry {index}"
                                ))
                            })?;
                            let archive_name = &output.archive_name;
                            output.writer.write_all(&bytes).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while writing entry {index} (`{archive_name}`): {error}"
                                ))
                            })?;
                            let delta = bytes.len() as u64;
                            output.hasher.update(&bytes)?;
                            // Surface the payload's platform identity as soon as enough bytes have
                            // streamed to determine it, rather than waiting for the whole file.
                            if let Some(identity) =
                                output.hasher.take_ready_identity(&output.output_path)
                            {
                                emit_extract_identity(context, format_name, &identity);
                            }
                            if let Some(plan) = output.hasher.take_ready_variant_plan() {
                                emit_variant_plan(context, format_name, &plan);
                            }
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
                        LibarchiveExtractOutput::FileEnd { index } => {
                            let mut output = open_outputs.remove(&index).ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract received end before start for entry {index}"
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
                                write_path,
                                writer,
                                ..
                            } = output;
                            drop(writer);
                            if let Some(mut entry) = hasher.finish(&write_path)? {
                                entry.path = output_path;
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

    transaction.commit(&tasks)?;

    let file_count = destination_tasks.iter().filter(|task| !task.is_dir).count();
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
    let report = attach_extraction_details(
        report,
        destination_tasks.len(),
        file_count,
        written_bytes,
        &execution,
    );
    let report = attach_extract_checksum_details(report, output_checksums);
    // Report every file this extract wrote (path-attach skips directory tasks via its is_file gate),
    // so the app treats this report as authoritative and never infers outputs from an out_dir scan.
    let produced_outputs = destination_tasks
        .iter()
        .map(|task| task.output_path.clone())
        .collect::<Vec<_>>();
    Ok(attach_emitted_file_paths(report, &produced_outputs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after the unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "rom-weaver-libarchive-cleanup-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create test output parent");
        }
        let mut file = File::create(path).expect("create test output file");
        file.write_all(bytes).expect("write test output file");
    }

    fn extract_task(out_dir: &Path, index: usize, relative_path: &str) -> LibarchiveExtractTask {
        let relative_path = PathBuf::from(relative_path);
        let output_path = out_dir.join(&relative_path);
        LibarchiveExtractTask {
            index,
            archive_name: relative_path.to_string_lossy().into_owned(),
            relative_path,
            write_path: output_path.clone(),
            output_path,
            is_dir: false,
            logical_bytes: Some(3),
        }
    }

    #[test]
    fn extract_transaction_removes_uncommitted_staging_outputs() {
        let dir = unique_temp_dir("uncommitted");
        let task = extract_task(&dir, 0, "a.bin");
        let transaction =
            LibarchiveExtractTransaction::new(&dir, true, "zip").expect("transaction");
        let staging_dir = transaction.staging_dir.clone();
        let staged = transaction.stage_tasks(&[task]).expect("stage tasks");
        write_file(&staged[0].write_path, b"partial");

        drop(transaction);

        assert!(
            !staging_dir.exists() && !dir.join("a.bin").exists(),
            "an uncommitted transaction must remove staging without publishing partial output"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extract_transaction_atomically_replaces_existing_output() {
        let dir = unique_temp_dir("committed");
        let destination = dir.join("a.bin");
        write_file(&destination, b"old");
        let tasks = vec![extract_task(&dir, 0, "a.bin")];
        let mut transaction =
            LibarchiveExtractTransaction::new(&dir, true, "zip").expect("transaction");
        let staging_dir = transaction.staging_dir.clone();
        let staged = transaction.stage_tasks(&tasks).expect("stage tasks");
        write_file(&staged[0].write_path, b"new");

        transaction.commit(&staged).expect("commit transaction");
        drop(transaction);

        assert_eq!(fs::read(&destination).expect("read output"), b"new");
        assert!(!staging_dir.exists(), "committed staging tree is removed");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_overwrite_transaction_rejects_destination_created_after_staging() {
        let dir = unique_temp_dir("no-overwrite-race");
        let destination = dir.join("a.bin");
        let tasks = vec![extract_task(&dir, 0, "a.bin")];
        let mut transaction =
            LibarchiveExtractTransaction::new(&dir, false, "zip").expect("transaction");
        let staged = transaction.stage_tasks(&tasks).expect("stage tasks");
        write_file(&staged[0].write_path, b"new");
        write_file(&destination, b"concurrent");

        transaction
            .commit(&staged)
            .expect_err("no-overwrite commit must recheck the destination");

        assert_eq!(
            fs::read(&destination).expect("read concurrent output"),
            b"concurrent"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_overwrite_transaction_installs_completed_staged_output() {
        let dir = unique_temp_dir("no-overwrite");
        let tasks = vec![extract_task(&dir, 0, "a.bin")];
        let mut transaction =
            LibarchiveExtractTransaction::new(&dir, false, "zip").expect("transaction");
        let staged = transaction.stage_tasks(&tasks).expect("stage tasks");
        write_file(&staged[0].write_path, b"new");

        transaction.commit(&staged).expect("commit transaction");

        assert_eq!(fs::read(dir.join("a.bin")).expect("read output"), b"new");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extract_transaction_restores_all_overwrites_when_later_install_fails() {
        let dir = unique_temp_dir("rollback");
        let first = dir.join("a.bin");
        let second = dir.join("b.bin");
        write_file(&first, b"old-a");
        write_file(&second, b"old-b");
        let tasks = vec![
            extract_task(&dir, 0, "a.bin"),
            extract_task(&dir, 1, "b.bin"),
        ];
        let mut transaction =
            LibarchiveExtractTransaction::new(&dir, true, "zip").expect("transaction");
        let staged = transaction.stage_tasks(&tasks).expect("stage tasks");
        write_file(&staged[0].write_path, b"new-a");
        // Leave the second staged output absent so the first install succeeds and the second fails.

        transaction
            .commit(&staged)
            .expect_err("missing staged output must fail commit");

        assert_eq!(fs::read(&first).expect("read first output"), b"old-a");
        assert_eq!(fs::read(&second).expect("read second output"), b"old-b");
        fs::remove_dir_all(&dir).ok();
    }

    fn filesystem_is_case_insensitive(dir: &Path) -> bool {
        let upper = dir.join("rom-weaver-case-probe-A");
        let lower = dir.join("rom-weaver-case-probe-a");
        write_file(&upper, b"probe");
        let insensitive = lower.exists();
        fs::remove_file(&upper).ok();
        if !insensitive {
            fs::remove_file(&lower).ok();
        }
        insensitive
    }

    #[test]
    fn entry_unique_staging_preserves_alias_last_wins_and_rollback() {
        let dir = unique_temp_dir("aliases");
        let case_insensitive = filesystem_is_case_insensitive(&dir);
        let second_name = if case_insensitive { "a.bin" } else { "A.bin" };
        let destination = dir.join("A.bin");
        let tasks = vec![
            extract_task(&dir, 0, "A.bin"),
            extract_task(&dir, 1, second_name),
        ];
        write_file(&destination, b"old");

        let mut transaction =
            LibarchiveExtractTransaction::new(&dir, true, "zip").expect("transaction");
        let staged = transaction.stage_tasks(&tasks).expect("stage tasks");
        assert_ne!(
            staged[0].write_path, staged[1].write_path,
            "every archive entry needs a distinct staging path"
        );
        write_file(&staged[0].write_path, b"first");
        write_file(&staged[1].write_path, b"last");
        transaction.commit(&staged).expect("commit aliases");
        drop(transaction);
        assert_eq!(
            fs::read(dir.join(second_name)).expect("read last alias"),
            b"last",
            "archive order must remain last-wins"
        );

        write_file(&destination, b"old");
        let mut rollback_tasks = tasks;
        rollback_tasks.push(extract_task(&dir, 2, "later.bin"));
        let mut transaction =
            LibarchiveExtractTransaction::new(&dir, true, "zip").expect("transaction");
        let staged = transaction
            .stage_tasks(&rollback_tasks)
            .expect("stage rollback tasks");
        write_file(&staged[0].write_path, b"first");
        write_file(&staged[1].write_path, b"last");
        transaction
            .commit(&staged)
            .expect_err("missing later entry must roll every alias generation back");
        assert_eq!(
            fs::read(&destination).expect("read restored original"),
            b"old"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn no_overwrite_install_falls_back_when_hard_links_are_unsupported() {
        let dir = unique_temp_dir("hard-link-fallback");
        let staged = dir.join("staged.bin");
        let destination = dir.join("output.bin");
        write_file(&staged, b"complete");

        install_staged_no_overwrite_with(&staged, &destination, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "hard links unsupported",
            ))
        })
        .expect("copy fallback");

        assert_eq!(
            fs::read(&destination).expect("read fallback output"),
            b"complete"
        );
        assert!(!staged.exists(), "successful fallback removes staging file");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn confined_wasm_root_normalization_rejects_parent_escape() {
        assert_eq!(
            normalize_confined_extract_root(Path::new("/work/./outputs")).expect("normalize"),
            PathBuf::from("/work/outputs")
        );
        normalize_confined_extract_root(Path::new("/../outside"))
            .expect_err("normalization must reject a mount escape");
    }

    #[test]
    fn wasm_transaction_owner_changes_across_module_start_times() {
        let first = wasm_extract_transaction_owner_id(std::time::UNIX_EPOCH);
        let later =
            wasm_extract_transaction_owner_id(std::time::UNIX_EPOCH + Duration::from_millis(1));

        assert_ne!(first, later);
        assert!(first.starts_with("wasm-"));
        assert!(!later.contains('/') && !later.contains('\\'));
    }

    #[test]
    fn extract_transaction_rejects_reserved_staging_namespace() {
        let dir = unique_temp_dir("reserved");
        let task = extract_task(&dir, 0, ".rom-weaver-extract-attacker/new/payload.bin");
        let transaction =
            LibarchiveExtractTransaction::new(&dir, true, "zip").expect("transaction");

        let error = transaction
            .stage_tasks(&[task])
            .expect_err("archive entries must not overlap the private transaction namespace");

        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("reserved transaction namespace")),
            "unexpected error: {error:?}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn extract_transaction_rejects_parent_replaced_with_symlink_after_staging() {
        use std::os::unix::fs::symlink;

        let dir = unique_temp_dir("symlink-parent");
        let out_dir = dir.join("out");
        let outside = dir.join("outside");
        fs::create_dir_all(&out_dir).expect("create output dir");
        fs::create_dir_all(&outside).expect("create outside dir");
        let tasks = vec![extract_task(&out_dir, 0, "link/escaped.bin")];
        let mut transaction =
            LibarchiveExtractTransaction::new(&out_dir, true, "zip").expect("transaction");
        let staged = transaction.stage_tasks(&tasks).expect("stage tasks");
        write_file(&staged[0].write_path, b"new");
        symlink(&outside, out_dir.join("link")).expect("create parent symlink");

        let error = transaction
            .commit(&staged)
            .expect_err("a parent replaced after preflight must be rejected");

        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains("existing link")),
            "unexpected error: {error:?}"
        );
        assert!(!outside.join("escaped.bin").exists());
        fs::remove_dir_all(&dir).ok();
    }
}
