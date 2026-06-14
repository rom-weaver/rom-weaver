use std::{
    cmp::max,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use tracing::{debug, info, trace};

use crate::checksum_validation_suffix;
use crate::shared::checksum_io::{crc32_path_cached, crc32_prefix, read_u32_le};
use crate::shared::labels::byuu_parse_report;
use crate::shared::threading::{
    PreparedWrite, apply_prepared_writes, parallel_chunked_capability,
    parallel_per_record_capability, pool_map, run_with_optional_pool,
};
use crate::varint::push_varint;
use crc32fast::Hasher;
use rayon::prelude::*;
use rom_weaver_checksum::crc32_bytes;
use rom_weaver_core::{
    DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES, FormatDescriptor,
    OperationContext, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence, Result,
    RomWeaverError, SharedBlockCacheReader, SharedThreadPool,
};

const UPS_MAGIC: &[u8; 4] = b"UPS1";
const UPS_FOOTER_SIZE: usize = 12;
const UPS_IO_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

pub struct UpsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl UpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for UpsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_ups_file(patch_path)?;
        Ok(byuu_parse_report(
            self.descriptor,
            patch.changes.len(),
            patch.source_size,
            patch.target_size,
            patch.source_checksum,
            patch.target_checksum,
            patch.patch_checksum,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        debug!(
            format = self.descriptor.name,
            patch = %patch_path.display(),
            "ups patch apply start"
        );
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let patch = parse_ups_file_with_checksum_validation(patch_path, validate_checksums)?;
        let input_len = fs::metadata(&request.input)?.len();
        let input_checksum = crc32_path_cached(&request.input, context)?;
        let (output_size, output_checksum) =
            resolve_apply_target(&patch, input_len, input_checksum, validate_checksums)?;
        let working_size = max(patch.source_size, patch.target_size);
        trace!(
            format = self.descriptor.name,
            changes = patch.changes.len(),
            source_size = patch.source_size,
            target_size = patch.target_size,
            output_size,
            read_on_main = crate::patches_reads_source_on_main_thread(),
            "ups parsed; apply prepares via worker pool unless read-on-main"
        );

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &request.output)?;
        let thread_capability = parallel_per_record_capability(patch.changes.len());
        let execution = {
            let mut output = OpenOptions::new().write(true).open(&request.output)?;
            output.set_len(working_size)?;
            let (execution, prepared) = run_with_optional_pool(
                context,
                thread_capability,
                // Parallel prepare reads the source from worker threads, which cannot
                // open OPFS files in wasm (os error 44); use the serial main-thread
                // path there.
                !crate::patches_reads_source_on_main_thread(),
                |pool| {
                    prepare_ups_writes_parallel(
                        &patch,
                        &request.input,
                        input_len,
                        working_size,
                        pool,
                        context,
                    )
                    .map(Some)
                },
                || {
                    apply_changes_from_input(
                        &patch,
                        &request.input,
                        input_len,
                        working_size,
                        &mut output,
                    )?;
                    Ok(None)
                },
            )?;
            if let Some(prepared) = prepared {
                apply_prepared_writes(&mut output, &prepared)?;
            }
            output.set_len(output_size)?;
            output.flush()?;
            execution
        };

        if validate_checksums {
            let actual_output_checksum = crc32_path_cached(&request.output, context)?;
            if actual_output_checksum != output_checksum {
                return Err(RomWeaverError::Validation(format!(
                    "Output checksum invalid; expected: {output_checksum:08x}, Actual: {actual_output_checksum:08x}"
                )));
            }
        }

        let checksum_suffix = checksum_validation_suffix(validate_checksums);
        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch with {} record(s){}",
                self.descriptor.name,
                patch.changes.len(),
                checksum_suffix
            ),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let source_size = fs::metadata(&request.original)?.len();
        let target_size = fs::metadata(&request.modified)?.len();
        debug!(
            format = self.descriptor.name,
            source_size, target_size, "ups patch create start"
        );
        let scan_size = max(source_size, target_size);
        let (execution, pool) = context.build_pool(parallel_chunked_capability(
            scan_size,
            CREATE_THREAD_SCAN_CHUNK_BYTES as u64,
        ))?;
        trace!(
            format = self.descriptor.name,
            parallel = execution.used_parallelism,
            threads = execution.effective_threads,
            scan_size,
            "ups create thread plan"
        );
        let created = create_ups_patch(
            &request.original,
            &request.modified,
            &pool,
            execution.used_parallelism,
            context,
        )?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, created.bytes)?;

        Ok(crate::shared::labels::patch_create_report(
            self.descriptor,
            created.record_count,
            execution,
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
    }
}

#[derive(Debug)]
struct ParsedUpsPatch {
    source_size: u64,
    target_size: u64,
    source_checksum: u32,
    target_checksum: u32,
    patch_checksum: u32,
    changes: Vec<UpsChange>,
}

#[derive(Debug)]
struct UpsChange {
    offset: u64,
    xor_bytes: Vec<u8>,
}

#[derive(Debug)]
struct CreatedUpsPatch {
    bytes: Vec<u8>,
    record_count: usize,
}

fn parse_ups_file(path: &Path) -> Result<ParsedUpsPatch> {
    parse_ups_file_with_checksum_validation(path, true)
}

fn parse_ups_file_with_checksum_validation(
    path: &Path,
    validate_patch_checksum: bool,
) -> Result<ParsedUpsPatch> {
    let file_len = fs::metadata(path)?.len();
    let minimum_len = (UPS_MAGIC.len() + UPS_FOOTER_SIZE) as u64;
    if file_len < minimum_len {
        return Err(RomWeaverError::Validation(
            "UPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let footer_offset = file_len
        .checked_sub(UPS_FOOTER_SIZE as u64)
        .expect("validated footer size");
    let mut parser = UpsFileParser::new(BufReader::new(File::open(path)?), footer_offset);

    if parser.read_exact(UPS_MAGIC.len())?.as_slice() != UPS_MAGIC {
        return Err(crate::coded_validation(
            "UPS_HEADER_INVALID",
            "Patch header invalid",
        ));
    }

    let source_size = parser.read_varint()?;
    let target_size = parser.read_varint()?;

    let mut next_offset = 0u64;
    let mut changes = Vec::new();
    while !parser.is_at_end() {
        let delta = parser.read_varint()?;
        next_offset = checked_add(next_offset, delta, "UPS record offset")?;

        let mut xor_bytes = Vec::new();
        loop {
            let byte = parser.read_u8()?;
            if byte == 0 {
                break;
            }
            xor_bytes.push(byte);
        }

        let change_len = u64::try_from(xor_bytes.len()).map_err(|_| {
            RomWeaverError::Validation("UPS record length exceeded addressable memory".into())
        })?;
        changes.push(UpsChange {
            offset: next_offset,
            xor_bytes,
        });
        next_offset = checked_add(next_offset, change_len, "UPS record end")?;
        next_offset = checked_add(next_offset, 1, "UPS record separator")?;
    }

    let footer = read_ups_footer(path, footer_offset)?;
    let source_checksum = read_u32_le(&footer[0..4]);
    let target_checksum = read_u32_le(&footer[4..8]);
    let patch_checksum = read_u32_le(&footer[8..12]);
    if validate_patch_checksum {
        let actual_patch_checksum = crc32_prefix(
            path,
            file_len - 4,
            UPS_IO_BUFFER_SIZE,
            "UPS checksum chunk exceeded usize",
        )?;
        if actual_patch_checksum != patch_checksum {
            return Err(RomWeaverError::Validation(format!(
                "Patch checksum invalid; expected: {patch_checksum:08x}, Actual: {actual_patch_checksum:08x}"
            )));
        }
    }

    Ok(ParsedUpsPatch {
        source_size,
        target_size,
        source_checksum,
        target_checksum,
        patch_checksum,
        changes,
    })
}

#[cfg(test)]
fn parse_ups_bytes(bytes: &[u8]) -> Result<ParsedUpsPatch> {
    parse_ups_bytes_with_checksum_validation(bytes, true)
}

#[cfg(test)]
fn parse_ups_bytes_with_checksum_validation(
    bytes: &[u8],
    validate_patch_checksum: bool,
) -> Result<ParsedUpsPatch> {
    if bytes.len() < UPS_MAGIC.len() + UPS_FOOTER_SIZE {
        return Err(RomWeaverError::Validation(
            "UPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let footer_offset = bytes
        .len()
        .checked_sub(UPS_FOOTER_SIZE)
        .expect("validated footer size");
    let mut parser = UpsParser::new(bytes, footer_offset);

    if parser.read_exact(UPS_MAGIC.len())? != UPS_MAGIC {
        return Err(crate::coded_validation(
            "UPS_HEADER_INVALID",
            "Patch header invalid",
        ));
    }

    let source_size = parser.read_varint()?;
    let target_size = parser.read_varint()?;

    let mut next_offset = 0u64;
    let mut changes = Vec::new();
    while !parser.is_at_end() {
        let delta = parser.read_varint()?;
        next_offset = checked_add(next_offset, delta, "UPS record offset")?;

        let mut xor_bytes = Vec::new();
        loop {
            let byte = parser.read_u8()?;
            if byte == 0 {
                break;
            }
            xor_bytes.push(byte);
        }

        let change_len = u64::try_from(xor_bytes.len()).map_err(|_| {
            RomWeaverError::Validation("UPS record length exceeded addressable memory".into())
        })?;
        changes.push(UpsChange {
            offset: next_offset,
            xor_bytes,
        });
        next_offset = checked_add(next_offset, change_len, "UPS record end")?;
        next_offset = checked_add(next_offset, 1, "UPS record separator")?;
    }

    let footer = &bytes[footer_offset..];
    let source_checksum = read_u32_le(&footer[0..4]);
    let target_checksum = read_u32_le(&footer[4..8]);
    let patch_checksum = read_u32_le(&footer[8..12]);
    if validate_patch_checksum {
        let actual_patch_checksum = crc32_bytes(&bytes[..bytes.len() - 4]);
        if actual_patch_checksum != patch_checksum {
            return Err(RomWeaverError::Validation(format!(
                "Patch checksum invalid; expected: {patch_checksum:08x}, Actual: {actual_patch_checksum:08x}"
            )));
        }
    }

    Ok(ParsedUpsPatch {
        source_size,
        target_size,
        source_checksum,
        target_checksum,
        patch_checksum,
        changes,
    })
}

fn resolve_apply_target(
    patch: &ParsedUpsPatch,
    input_len: u64,
    input_checksum: u32,
    validate_checksums: bool,
) -> Result<(u64, u32)> {
    let matches_source = input_len == patch.source_size && input_checksum == patch.source_checksum;
    let matches_target = input_len == patch.target_size && input_checksum == patch.target_checksum;

    if matches_source {
        return Ok((patch.target_size, patch.target_checksum));
    }
    if matches_target {
        return Ok((patch.source_size, patch.source_checksum));
    }

    if !validate_checksums {
        if input_len == patch.source_size {
            return Ok((patch.target_size, patch.target_checksum));
        }
        if input_len == patch.target_size {
            return Ok((patch.source_size, patch.source_checksum));
        }
        if patch.source_size == patch.target_size {
            return Ok((patch.target_size, patch.target_checksum));
        }
    }

    Err(RomWeaverError::Validation(format!(
        "UPS input validation failed; expected source size/checksum {} / {:08x} or target size/checksum {} / {:08x}, got {} / {:08x}",
        patch.source_size,
        patch.source_checksum,
        patch.target_size,
        patch.target_checksum,
        input_len,
        input_checksum
    )))
}

fn apply_changes_from_input(
    patch: &ParsedUpsPatch,
    input_path: &Path,
    input_len: u64,
    output_len: u64,
    output: &mut File,
) -> Result<()> {
    let mut input = File::open(input_path)?;
    let mut buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    for change in &patch.changes {
        let change_len = u64::try_from(change.xor_bytes.len()).map_err(|_| {
            RomWeaverError::Validation("UPS record length exceeded addressable memory".into())
        })?;
        let change_end = checked_add(change.offset, change_len, "UPS change end")?;
        if change_end > output_len {
            return Err(RomWeaverError::Validation(
                "UPS change exceeds declared patch file bounds".into(),
            ));
        }

        let mut remaining = change.xor_bytes.len();
        let mut xor_cursor = 0usize;
        let mut write_offset = change.offset;
        while remaining > 0 {
            let chunk_len = remaining.min(buffer.len());
            buffer[..chunk_len].fill(0);
            if write_offset < input_len {
                let readable = usize::try_from((input_len - write_offset).min(chunk_len as u64))
                    .map_err(|_| {
                        RomWeaverError::Validation("UPS input range exceeded usize".into())
                    })?;
                if readable > 0 {
                    input.seek(SeekFrom::Start(write_offset))?;
                    input.read_exact(&mut buffer[..readable])?;
                }
            }
            for (index, byte) in buffer[..chunk_len].iter_mut().enumerate() {
                *byte ^= change.xor_bytes[xor_cursor + index];
            }
            output.seek(SeekFrom::Start(write_offset))?;
            output.write_all(&buffer[..chunk_len])?;

            write_offset = checked_add(
                write_offset,
                u64::try_from(chunk_len).expect("chunk len fits u64"),
                "UPS output offset",
            )?;
            xor_cursor = checked_add_usize(xor_cursor, chunk_len, "UPS xor cursor")?;
            remaining -= chunk_len;
        }
    }

    Ok(())
}

fn prepare_ups_writes_parallel(
    patch: &ParsedUpsPatch,
    source_path: &Path,
    source_len: u64,
    output_len: u64,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedWrite>> {
    let shared_source = Arc::new(SharedBlockCacheReader::open(
        source_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?);
    pool_map(pool, &patch.changes, |change| {
        context.cancel().check()?;
        prepare_ups_write(change, source_len, output_len, &shared_source)
    })
}

fn prepare_ups_write(
    change: &UpsChange,
    source_len: u64,
    output_len: u64,
    source: &Arc<SharedBlockCacheReader>,
) -> Result<PreparedWrite> {
    let change_len = u64::try_from(change.xor_bytes.len()).map_err(|_| {
        RomWeaverError::Validation("UPS record length exceeded addressable memory".into())
    })?;
    let change_end = checked_add(change.offset, change_len, "UPS change end")?;
    if change_end > output_len {
        return Err(RomWeaverError::Validation(
            "UPS change exceeds declared patch file bounds".into(),
        ));
    }

    let mut source_bytes = vec![0u8; change.xor_bytes.len()];
    if change.offset < source_len {
        let readable = usize::try_from((source_len - change.offset).min(change_len))
            .map_err(|_| RomWeaverError::Validation("UPS source range exceeded usize".into()))?;
        if readable > 0 {
            source.read_exact_at(change.offset, &mut source_bytes[..readable])?;
        }
    }

    let mut patched = vec![0u8; change.xor_bytes.len()];
    for (index, byte) in patched.iter_mut().enumerate() {
        *byte = source_bytes[index] ^ change.xor_bytes[index];
    }

    Ok(PreparedWrite {
        offset: change.offset,
        data: patched,
    })
}

fn create_ups_patch(
    source_path: &Path,
    target_path: &Path,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
    context: &OperationContext,
) -> Result<CreatedUpsPatch> {
    if use_parallel_scan {
        create_ups_patch_parallel(source_path, target_path, pool, context)
    } else {
        create_ups_patch_streaming(source_path, target_path)
    }
}

fn create_ups_patch_parallel(
    source_path: &Path,
    target_path: &Path,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<CreatedUpsPatch> {
    let source_size = fs::metadata(source_path)?.len();
    let target_size = fs::metadata(target_path)?.len();

    if crate::create_exceeds_main_thread_cap(source_size.saturating_add(target_size)) {
        info!(
            source_size,
            target_size,
            "UPS create: combined size exceeds in-memory limit; falling back to serial path"
        );
        return create_ups_patch_streaming(source_path, target_path);
    }

    let source_checksum = crc32_path_cached(source_path, context)?;
    let target_checksum = crc32_path_cached(target_path, context)?;
    let changes =
        collect_ups_changes_parallel(source_path, source_size, target_path, target_size, pool)?;

    encode_ups_patch(
        &changes,
        source_size,
        target_size,
        source_checksum,
        target_checksum,
    )
}

fn collect_ups_changes_parallel(
    source_path: &Path,
    source_size: u64,
    target_path: &Path,
    target_size: u64,
    pool: &SharedThreadPool,
) -> Result<Vec<UpsChange>> {
    let scan_size = max(source_size, target_size);
    if scan_size == 0 {
        return Ok(Vec::new());
    }

    let chunk_size = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_ranges = (0..scan_size)
        .step_by(CREATE_THREAD_SCAN_CHUNK_BYTES)
        .map(|start| {
            let end = start.saturating_add(chunk_size).min(scan_size);
            start..end
        })
        .collect::<Vec<_>>();

    let per_chunk_changes = if crate::patches_reads_source_on_main_thread() {
        let buffered = chunk_ranges
            .iter()
            .map(|range| {
                read_ups_create_chunk(
                    source_path,
                    source_size,
                    target_path,
                    target_size,
                    range.start,
                    range.end,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        pool.install(|| {
            buffered
                .into_par_iter()
                .zip(chunk_ranges.into_par_iter())
                .map(|((source_bytes, target_bytes), range)| {
                    collect_ups_chunk_changes_from_bytes(range.start, &source_bytes, &target_bytes)
                })
                .collect::<Vec<_>>()
        })
    } else {
        pool.install(|| {
            chunk_ranges
                .into_par_iter()
                .map(|range| {
                    collect_ups_chunk_changes(
                        source_path,
                        source_size,
                        target_path,
                        target_size,
                        range.start,
                        range.end,
                    )
                })
                .collect::<Vec<_>>()
        })
    };

    let mut merged: Vec<UpsChange> = Vec::new();
    for changes in per_chunk_changes {
        let changes = changes?;
        for mut change in changes {
            if let Some(last) = merged.last_mut() {
                let last_len = u64::try_from(last.xor_bytes.len()).expect("len fits u64");
                if last
                    .offset
                    .checked_add(last_len)
                    .is_some_and(|end| end == change.offset)
                {
                    last.xor_bytes.append(&mut change.xor_bytes);
                    continue;
                }
            }
            merged.push(change);
        }
    }
    Ok(merged)
}

fn read_ups_create_chunk(
    source_path: &Path,
    source_size: u64,
    target_path: &Path,
    target_size: u64,
    start: u64,
    end: u64,
) -> Result<(Vec<u8>, Vec<u8>)> {
    let chunk_len = usize::try_from(end - start)
        .map_err(|_| RomWeaverError::Validation("UPS create chunk length exceeded usize".into()))?;
    let source_bytes = read_ups_file_chunk(source_path, source_size, start, chunk_len)?;
    let target_bytes = read_ups_file_chunk(target_path, target_size, start, chunk_len)?;
    Ok((source_bytes, target_bytes))
}

fn read_ups_file_chunk(
    path: &Path,
    file_size: u64,
    start: u64,
    chunk_len: usize,
) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; chunk_len];
    if start >= file_size {
        return Ok(bytes);
    }

    let readable = usize::try_from((file_size - start).min(chunk_len as u64)).map_err(|_| {
        RomWeaverError::Validation("UPS create readable length exceeded usize".into())
    })?;
    if readable > 0 {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut bytes[..readable])?;
    }
    Ok(bytes)
}

fn collect_ups_chunk_changes(
    source_path: &Path,
    source_size: u64,
    target_path: &Path,
    target_size: u64,
    start: u64,
    end: u64,
) -> Result<Vec<UpsChange>> {
    let mut source = File::open(source_path)?;
    let mut target = File::open(target_path)?;
    if start < source_size {
        source.seek(SeekFrom::Start(start))?;
    }
    if start < target_size {
        target.seek(SeekFrom::Start(start))?;
    }

    let mut source_buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    let mut changes = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_xor = Vec::<u8>::new();
    let mut absolute = start;

    while absolute < end {
        let chunk_len = usize::try_from((end - absolute).min(UPS_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("UPS chunk length exceeded usize".into()))?;

        let source_chunk_len = if absolute >= source_size {
            0
        } else {
            usize::try_from((source_size - absolute).min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS source chunk length exceeded usize".into())
            })?
        };
        if source_chunk_len > 0 {
            source.read_exact(&mut source_buffer[..source_chunk_len])?;
        }
        if source_chunk_len < chunk_len {
            source_buffer[source_chunk_len..chunk_len].fill(0);
        }

        let target_chunk_len = if absolute >= target_size {
            0
        } else {
            usize::try_from((target_size - absolute).min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS target chunk length exceeded usize".into())
            })?
        };
        if target_chunk_len > 0 {
            target.read_exact(&mut target_buffer[..target_chunk_len])?;
        }
        if target_chunk_len < chunk_len {
            target_buffer[target_chunk_len..chunk_len].fill(0);
        }

        for index in 0..chunk_len {
            let source_byte = source_buffer[index];
            let target_byte = target_buffer[index];
            if source_byte != target_byte {
                if pending_start.is_none() {
                    pending_start = Some(absolute);
                }
                pending_xor.push(source_byte ^ target_byte);
            } else if !pending_xor.is_empty() {
                let offset = pending_start.expect("pending start exists");
                changes.push(UpsChange {
                    offset,
                    xor_bytes: std::mem::take(&mut pending_xor),
                });
                pending_start = None;
            }
            absolute = checked_add(absolute, 1, "UPS chunk scan offset")?;
        }
    }

    if !pending_xor.is_empty() {
        let offset = pending_start.expect("pending start exists");
        changes.push(UpsChange {
            offset,
            xor_bytes: pending_xor,
        });
    }

    Ok(changes)
}

fn collect_ups_chunk_changes_from_bytes(
    start: u64,
    source_bytes: &[u8],
    target_bytes: &[u8],
) -> Result<Vec<UpsChange>> {
    let mut changes = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_xor = Vec::<u8>::new();
    let mut absolute = start;
    let scan_len = source_bytes.len().max(target_bytes.len());

    for index in 0..scan_len {
        let source_byte = source_bytes.get(index).copied().unwrap_or(0);
        let target_byte = target_bytes.get(index).copied().unwrap_or(0);
        if source_byte != target_byte {
            if pending_start.is_none() {
                pending_start = Some(absolute);
            }
            pending_xor.push(source_byte ^ target_byte);
        } else if !pending_xor.is_empty() {
            let offset = pending_start.expect("pending start exists");
            changes.push(UpsChange {
                offset,
                xor_bytes: std::mem::take(&mut pending_xor),
            });
            pending_start = None;
        }
        absolute = checked_add(absolute, 1, "UPS chunk scan offset")?;
    }

    if !pending_xor.is_empty() {
        let offset = pending_start.expect("pending start exists");
        changes.push(UpsChange {
            offset,
            xor_bytes: pending_xor,
        });
    }

    Ok(changes)
}

fn create_ups_patch_streaming(source_path: &Path, target_path: &Path) -> Result<CreatedUpsPatch> {
    let source_size = fs::metadata(source_path)?.len();
    let target_size = fs::metadata(target_path)?.len();
    let scan_size = max(source_size, target_size);

    let mut source = BufReader::new(File::open(source_path)?);
    let mut target = BufReader::new(File::open(target_path)?);
    let mut source_checksum = Hasher::new();
    let mut target_checksum = Hasher::new();
    let mut source_buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    let mut source_remaining = source_size;
    let mut target_remaining = target_size;
    let mut offset = 0u64;

    let mut changes = Vec::<UpsChange>::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_xor = Vec::<u8>::new();

    while offset < scan_size {
        let chunk_len = usize::try_from((scan_size - offset).min(UPS_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("UPS chunk length exceeded usize".into()))?;
        let source_chunk_len =
            usize::try_from(source_remaining.min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS source chunk length exceeded usize".into())
            })?;
        let target_chunk_len =
            usize::try_from(target_remaining.min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS target chunk length exceeded usize".into())
            })?;

        if source_chunk_len > 0 {
            source.read_exact(&mut source_buffer[..source_chunk_len])?;
            source_checksum.update(&source_buffer[..source_chunk_len]);
        }
        if target_chunk_len > 0 {
            target.read_exact(&mut target_buffer[..target_chunk_len])?;
            target_checksum.update(&target_buffer[..target_chunk_len]);
        }

        for index in 0..chunk_len {
            let source_byte = if index < source_chunk_len {
                source_buffer[index]
            } else {
                0
            };
            let target_byte = if index < target_chunk_len {
                target_buffer[index]
            } else {
                0
            };
            if source_byte != target_byte {
                if pending_start.is_none() {
                    pending_start = Some(offset);
                }
                pending_xor.push(source_byte ^ target_byte);
            } else if !pending_xor.is_empty() {
                let start = pending_start.expect("pending start exists");
                changes.push(UpsChange {
                    offset: start,
                    xor_bytes: std::mem::take(&mut pending_xor),
                });
                pending_start = None;
            }

            offset = checked_add(offset, 1, "UPS scan offset")?;
        }

        source_remaining = source_remaining.saturating_sub(source_chunk_len as u64);
        target_remaining = target_remaining.saturating_sub(target_chunk_len as u64);
    }

    // The max-size scan should consume both real files; these loops are defensive.
    while source_remaining > 0 {
        let chunk_len =
            usize::try_from(source_remaining.min(UPS_IO_BUFFER_SIZE as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS source chunk length exceeded usize".into())
            })?;
        source.read_exact(&mut source_buffer[..chunk_len])?;
        source_checksum.update(&source_buffer[..chunk_len]);
        source_remaining = source_remaining.saturating_sub(chunk_len as u64);
    }
    while target_remaining > 0 {
        let chunk_len =
            usize::try_from(target_remaining.min(UPS_IO_BUFFER_SIZE as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS target chunk length exceeded usize".into())
            })?;
        target.read_exact(&mut target_buffer[..chunk_len])?;
        target_checksum.update(&target_buffer[..chunk_len]);
        target_remaining = target_remaining.saturating_sub(chunk_len as u64);
    }

    if !pending_xor.is_empty() {
        let start = pending_start.expect("pending start exists");
        changes.push(UpsChange {
            offset: start,
            xor_bytes: pending_xor,
        });
    }

    let source_checksum = source_checksum.finalize();
    let target_checksum = target_checksum.finalize();
    encode_ups_patch(
        &changes,
        source_size,
        target_size,
        source_checksum,
        target_checksum,
    )
}

#[cfg(test)]
fn create_ups_patch_bytes(source: &[u8], target: &[u8]) -> Result<CreatedUpsPatch> {
    let source_size = u64::try_from(source.len())
        .map_err(|_| RomWeaverError::Validation("UPS source size exceeded u64".into()))?;
    let target_size = u64::try_from(target.len())
        .map_err(|_| RomWeaverError::Validation("UPS target size exceeded u64".into()))?;
    let source_checksum = crc32_bytes(source);
    let target_checksum = crc32_bytes(target);
    let changes = build_changes(source, target)?;
    encode_ups_patch(
        &changes,
        source_size,
        target_size,
        source_checksum,
        target_checksum,
    )
}

#[cfg(test)]
fn build_changes(source: &[u8], target: &[u8]) -> Result<Vec<UpsChange>> {
    let scan_size = source.len().max(target.len());
    let mut changes = Vec::new();

    let mut index = 0usize;
    while index < scan_size {
        let source_byte = source.get(index).copied().unwrap_or(0);
        let target_byte = target.get(index).copied().unwrap_or(0);

        if source_byte != target_byte {
            let offset = u64::try_from(index)
                .map_err(|_| RomWeaverError::Validation("UPS offset exceeded u64".into()))?;
            let mut xor_bytes = Vec::new();

            while index < scan_size {
                let source_byte = source.get(index).copied().unwrap_or(0);
                let target_byte = target.get(index).copied().unwrap_or(0);
                if source_byte == target_byte {
                    break;
                }

                xor_bytes.push(source_byte ^ target_byte);
                index = checked_add_usize(index, 1, "UPS change index")?;
            }

            changes.push(UpsChange { offset, xor_bytes });
        }

        index = checked_add_usize(index, 1, "UPS scan index")?;
    }

    Ok(changes)
}

fn encode_ups_patch(
    changes: &[UpsChange],
    source_size: u64,
    target_size: u64,
    source_checksum: u32,
    target_checksum: u32,
) -> Result<CreatedUpsPatch> {
    let mut bytes = UPS_MAGIC.to_vec();
    push_varint(&mut bytes, source_size);
    push_varint(&mut bytes, target_size);

    for (index, change) in changes.iter().enumerate() {
        let offset_to_encode = if index == 0 {
            change.offset
        } else {
            let previous = &changes[index - 1];
            let previous_len = u64::try_from(previous.xor_bytes.len()).map_err(|_| {
                RomWeaverError::Validation(
                    "UPS record length exceeded addressable memory while encoding".into(),
                )
            })?;
            let previous_end =
                checked_add(previous.offset, previous_len, "UPS previous record end")?;
            let previous_next = checked_add(previous_end, 1, "UPS previous record separator")?;
            checked_sub(change.offset, previous_next, "UPS relative record offset")?
        };

        push_varint(&mut bytes, offset_to_encode);
        bytes.extend_from_slice(&change.xor_bytes);
        bytes.push(0);
    }

    bytes.extend_from_slice(&source_checksum.to_le_bytes());
    bytes.extend_from_slice(&target_checksum.to_le_bytes());
    let patch_checksum = crc32_bytes(&bytes);
    bytes.extend_from_slice(&patch_checksum.to_le_bytes());

    Ok(CreatedUpsPatch {
        bytes,
        record_count: changes.len(),
    })
}

fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

fn checked_sub(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_sub(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} underflowed")))
}

fn checked_add_usize(lhs: usize, rhs: usize, label: &str) -> Result<usize> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

fn read_ups_footer(path: &Path, footer_offset: u64) -> Result<[u8; UPS_FOOTER_SIZE]> {
    crate::shared::checksum_io::read_footer(path, footer_offset)
}

#[cfg(test)]
struct UpsParser<'a> {
    bytes: &'a [u8],
    offset: usize,
    end: usize,
}

#[cfg(test)]
impl<'a> UpsParser<'a> {
    fn new(bytes: &'a [u8], end: usize) -> Self {
        Self {
            bytes,
            offset: 0,
            end,
        }
    }

    fn is_at_end(&self) -> bool {
        self.offset == self.end
    }

    fn read_exact(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| RomWeaverError::Validation("UPS parser offset overflowed".into()))?;
        if end > self.end {
            return Err(RomWeaverError::Validation(
                "UPS patch ended unexpectedly while reading record data".into(),
            ));
        }

        let start = self.offset;
        self.offset = end;
        Ok(&self.bytes[start..end])
    }

    fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_exact(1)?[0])
    }

    fn read_varint(&mut self) -> Result<u64> {
        crate::varint::read_varint(|| self.read_u8(), "UPS")
    }
}

struct UpsFileParser<R> {
    reader: R,
    offset: u64,
    end: u64,
}

impl<R: Read> UpsFileParser<R> {
    fn new(reader: R, end: u64) -> Self {
        Self {
            reader,
            offset: 0,
            end,
        }
    }

    fn is_at_end(&self) -> bool {
        self.offset == self.end
    }

    fn read_exact(&mut self, len: usize) -> Result<Vec<u8>> {
        let len_u64 = u64::try_from(len)
            .map_err(|_| RomWeaverError::Validation("UPS parser length overflowed u64".into()))?;
        let next = self
            .offset
            .checked_add(len_u64)
            .ok_or_else(|| RomWeaverError::Validation("UPS parser offset overflowed".into()))?;
        if next > self.end {
            return Err(RomWeaverError::Validation(
                "UPS patch ended unexpectedly while reading record data".into(),
            ));
        }

        let mut bytes = vec![0u8; len];
        self.reader.read_exact(&mut bytes)?;
        self.offset = next;
        Ok(bytes)
    }

    fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_exact(1)?[0])
    }

    fn read_varint(&mut self) -> Result<u64> {
        crate::varint::read_varint(|| self.read_u8(), "UPS")
    }
}

#[cfg(test)]
#[path = "../tests/unit/ups.rs"]
mod tests;
