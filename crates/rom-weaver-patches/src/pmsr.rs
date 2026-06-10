/* jscpd:ignore-start */
use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use tracing::info;

use crc32fast::Hasher;
use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence, Result, RomWeaverError, SharedThreadPool,
    ThreadCapability,
};

use crate::checksum_validation_suffix;
use crate::shared::threading::{
    chunk_count_for_len_checked, parallel_per_record_capability, run_with_optional_pool,
    scan_create_chunks,
};

const PMSR_MAGIC: &[u8; 4] = b"PMSR";
const PMSR_HEADER_SIZE: usize = 8;
const PMSR_IO_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const PAPER_MARIO_USA10_CRC32: u32 = 0xA7F5CD7E;
const PAPER_MARIO_USA10_FILE_SIZE: u64 = 41_943_040;

pub struct PmsrPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl PmsrPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for PmsrPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_pmsr_file(patch_path)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s); expected source CRC32 0x{PAPER_MARIO_USA10_CRC32:08X}",
                self.descriptor.name,
                patch.records.len()
            ),
            Some(100.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch = parse_pmsr_file(patch_path)?;
        let validate_source =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;

        if validate_source {
            validate_paper_mario_source(&request.input)?;
        }

        let source_len = fs::metadata(&request.input)?.len();
        let output_len = patch.min_target_size.max(source_len);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let thread_capability = parallel_per_record_capability(patch.records.len());
        let records_non_overlapping = pmsr_records_are_non_overlapping(&patch, output_len)?;
        let execution = if crate::can_apply_in_memory(source_len, output_len) {
            let mut execution = context.plan_threads(thread_capability.clone());
            let mut output_bytes = fs::read(&request.input)?;
            output_bytes.resize(output_len as usize, 0);
            apply_pmsr_records_in_memory(output_len, &patch.records, &mut output_bytes)?;
            fs::write(&request.output, &output_bytes)?;
            execution.effective_threads = 1;
            execution.used_parallelism = false;
            execution
        } else {
            fs::copy(&request.input, &request.output)?;
            let output = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&request.output)?;
            output.set_len(output_len)?;
            drop(output);

            let (mut execution, ()) = run_with_optional_pool(
                context,
                thread_capability,
                records_non_overlapping && !crate::patches_reads_source_on_main_thread(),
                |pool| {
                    // `pool.size()` always matches the negotiated
                    // `effective_threads` for pools built by `build_pool`.
                    apply_pmsr_patch_parallel_in_place(
                        &patch,
                        &request.output,
                        output_len,
                        pool.size(),
                        pool,
                        context,
                    )
                },
                || {
                    let mut output = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&request.output)?;
                    apply_pmsr_patch_in_place(&patch, output_len, &mut output)?;
                    output.flush()?;
                    Ok(())
                },
            )?;
            if execution.used_parallelism && !records_non_overlapping {
                execution.apply_pool_fallback(
                    "MOD apply records overlap; preserving patch order with single-thread writes",
                );
            }
            execution
        };
        let checksum_suffix = checksum_validation_suffix(validate_source);
        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch with {} record(s){}",
                self.descriptor.name,
                patch.records.len(),
                checksum_suffix
            ),
            Some(execution),
        ))
    }

    fn validate(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch = parse_pmsr_file(patch_path)?;
        let validate_source =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;

        if validate_source {
            validate_paper_mario_source(&request.input)?;
        }
        let source_len = fs::metadata(&request.input)?.len();
        let output_len = patch.min_target_size.max(source_len);
        let _ = pmsr_records_are_non_overlapping(&patch, output_len)?;

        let checksum_suffix = checksum_validation_suffix(validate_source);
        Ok(crate::patch_success_report(
            self.descriptor,
            "validate",
            format!(
                "validated {} patch source with {} record(s){}",
                self.descriptor.name,
                patch.records.len(),
                checksum_suffix
            ),
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        if modified_len < original_len {
            return Err(RomWeaverError::Validation(format!(
                "MOD create does not support shrinking outputs (original: {}, modified: {})",
                original_len, modified_len,
            )));
        }

        let thread_capability = pmsr_create_thread_capability(modified_len)?;
        let (execution, patch) = run_with_optional_pool(
            context,
            thread_capability,
            true,
            |pool| create_pmsr_patch_parallel(&request.original, &request.modified, pool, context),
            || create_pmsr_patch_streaming(&request.original, &request.modified),
        )?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, patch.bytes)?;

        Ok(crate::patch_success_report(
            self.descriptor,
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name, patch.record_count
            ),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
    }
}

#[derive(Debug)]
struct ParsedPmsrPatch {
    // PMSR does not encode a target size directly. We use the largest record end as
    // the minimum required output length and preserve at least the input length.
    min_target_size: u64,
    records: Vec<PmsrRecord>,
}

#[derive(Clone, Debug)]
struct PmsrRecord {
    offset: u64,
    data: Vec<u8>,
}

impl PmsrRecord {
    fn end(&self) -> Result<u64> {
        checked_add(
            self.offset,
            u64::try_from(self.data.len())
                .map_err(|_| RomWeaverError::Validation("MOD record length exceeded u64".into()))?,
            "MOD record end",
        )
    }
}

#[derive(Debug)]
struct CreatedPmsrPatch {
    bytes: Vec<u8>,
    record_count: usize,
}

fn parse_pmsr_file(path: &Path) -> Result<ParsedPmsrPatch> {
    let file_len = fs::metadata(path)?.len();
    if file_len < PMSR_HEADER_SIZE as u64 {
        return Err(RomWeaverError::Validation(
            "MOD patch is too small to contain a valid header".into(),
        ));
    }

    let mut parser = PmsrFileParser::new(BufReader::new(File::open(path)?), file_len);
    if parser
        .read_exact(PMSR_MAGIC.len(), "MOD header")?
        .as_slice()
        != PMSR_MAGIC
    {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let record_count = parser.read_u32_be("MOD record count")?;
    let record_capacity = usize::try_from(record_count).map_err(|_| {
        RomWeaverError::Validation("MOD record count exceeded platform addressable range".into())
    })?;
    let mut records = Vec::with_capacity(record_capacity);
    let mut min_target_size = 0u64;

    for _ in 0..record_count {
        let offset = u64::from(parser.read_u32_be("MOD record offset")?);
        let data_len_u32 = parser.read_u32_be("MOD record length")?;
        let data_len = usize::try_from(data_len_u32).map_err(|_| {
            RomWeaverError::Validation("MOD record length exceeded addressable memory".into())
        })?;
        let data = parser.read_exact(data_len, "MOD record data")?;
        let end = checked_add(offset, u64::from(data_len_u32), "MOD record end")?;
        min_target_size = min_target_size.max(end);
        records.push(PmsrRecord { offset, data });
    }

    if parser.remaining() != 0 {
        return Err(RomWeaverError::Validation(
            "MOD patch contained unexpected trailing data".into(),
        ));
    }

    Ok(ParsedPmsrPatch {
        min_target_size,
        records,
    })
}

#[cfg(test)]
fn parse_pmsr_bytes(bytes: &[u8]) -> Result<ParsedPmsrPatch> {
    if bytes.len() < PMSR_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "MOD patch is too small to contain a valid header".into(),
        ));
    }
    if &bytes[..PMSR_MAGIC.len()] != PMSR_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let mut cursor = PMSR_MAGIC.len();
    let record_count = read_u32_be(bytes, &mut cursor, "MOD record count")?;
    let record_capacity = usize::try_from(record_count).map_err(|_| {
        RomWeaverError::Validation("MOD record count exceeded platform addressable range".into())
    })?;
    let mut records = Vec::with_capacity(record_capacity);
    let mut min_target_size = 0u64;

    for _ in 0..record_count {
        let offset = u64::from(read_u32_be(bytes, &mut cursor, "MOD record offset")?);
        let data_len_u32 = read_u32_be(bytes, &mut cursor, "MOD record length")?;
        let data_len = usize::try_from(data_len_u32).map_err(|_| {
            RomWeaverError::Validation("MOD record length exceeded addressable memory".into())
        })?;
        let data = read_exact(bytes, &mut cursor, data_len, "MOD record data")?.to_vec();
        let end = checked_add(offset, u64::from(data_len_u32), "MOD record end")?;
        min_target_size = min_target_size.max(end);
        records.push(PmsrRecord { offset, data });
    }

    if cursor != bytes.len() {
        return Err(RomWeaverError::Validation(
            "MOD patch contained unexpected trailing data".into(),
        ));
    }

    Ok(ParsedPmsrPatch {
        min_target_size,
        records,
    })
}

#[cfg(test)]
fn create_pmsr_patch_bytes(original: &[u8], modified: &[u8]) -> Result<CreatedPmsrPatch> {
    if modified.len() < original.len() {
        return Err(RomWeaverError::Validation(format!(
            "MOD create does not support shrinking outputs (original: {}, modified: {})",
            original.len(),
            modified.len(),
        )));
    }

    let scan_len = modified.len();
    let mut index = 0usize;
    let mut records = Vec::new();

    while index < scan_len {
        let source = original.get(index).copied().unwrap_or(0);
        let target = modified[index];
        if source == target {
            index += 1;
            continue;
        }

        let start = index;
        let mut data = Vec::new();
        while index < scan_len {
            let source = original.get(index).copied().unwrap_or(0);
            let target = modified[index];
            if source == target {
                break;
            }
            data.push(target);
            index += 1;
        }

        let offset = u64::try_from(start)
            .map_err(|_| RomWeaverError::Validation("MOD record offset exceeded u64".into()))?;
        records.push(PmsrRecord { offset, data });
    }

    let modified_len_u64 = u64::try_from(modified.len())
        .map_err(|_| RomWeaverError::Validation("MOD target length exceeded u64".into()))?;
    finalize_created_pmsr_patch(records, modified_len_u64)
}

fn apply_pmsr_records_in_memory(
    output_len: u64,
    records: &[PmsrRecord],
    output: &mut [u8],
) -> Result<()> {
    for record in records {
        let end = checked_add(
            record.offset,
            u64::try_from(record.data.len())
                .map_err(|_| RomWeaverError::Validation("MOD record length exceeded u64".into()))?,
            "MOD record end",
        )?;
        if end > output_len {
            return Err(RomWeaverError::Validation(
                "MOD record exceeded declared output size".into(),
            ));
        }
        if !record.data.is_empty() {
            let start = record.offset as usize;
            output[start..end as usize].copy_from_slice(&record.data);
        }
    }
    Ok(())
}

fn apply_pmsr_patch_in_place(
    patch: &ParsedPmsrPatch,
    output_len: u64,
    output: &mut File,
) -> Result<()> {
    for record in &patch.records {
        let end = checked_add(
            record.offset,
            u64::try_from(record.data.len())
                .map_err(|_| RomWeaverError::Validation("MOD record length exceeded u64".into()))?,
            "MOD record end",
        )?;
        if end > output_len {
            return Err(RomWeaverError::Validation(
                "MOD record exceeded declared output size".into(),
            ));
        }
        if record.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(record.offset))?;
        output.write_all(&record.data)?;
    }
    Ok(())
}

fn pmsr_records_are_non_overlapping(patch: &ParsedPmsrPatch, output_len: u64) -> Result<bool> {
    let mut ranges = Vec::with_capacity(patch.records.len());
    for record in &patch.records {
        let end = record.end()?;
        if end > output_len {
            return Err(RomWeaverError::Validation(
                "MOD record exceeded declared output size".into(),
            ));
        }
        if !record.data.is_empty() {
            ranges.push((record.offset, end));
        }
    }
    ranges.sort_unstable_by_key(|(start, _)| *start);
    let mut previous_end = 0u64;
    let mut seen_any = false;
    for (start, end) in ranges {
        if seen_any && start < previous_end {
            return Ok(false);
        }
        previous_end = end;
        seen_any = true;
    }
    Ok(true)
}

fn apply_pmsr_patch_parallel_in_place(
    patch: &ParsedPmsrPatch,
    output_path: &Path,
    output_len: u64,
    effective_threads: usize,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<()> {
    if patch.records.is_empty() {
        return Ok(());
    }
    let chunk_size = patch
        .records
        .len()
        .div_ceil(effective_threads.max(1))
        .max(1);
    pool.install(|| {
        patch
            .records
            .par_chunks(chunk_size)
            .map(|records| apply_pmsr_record_chunk(records, output_path, output_len, context))
            .collect::<Result<Vec<_>>>()
    })?;
    Ok(())
}

fn apply_pmsr_record_chunk(
    records: &[PmsrRecord],
    output_path: &Path,
    output_len: u64,
    context: &OperationContext,
) -> Result<()> {
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(output_path)?;
    for record in records {
        context.cancel().check()?;
        let end = record.end()?;
        if end > output_len {
            return Err(RomWeaverError::Validation(
                "MOD record exceeded declared output size".into(),
            ));
        }
        if record.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(record.offset))?;
        output.write_all(&record.data)?;
    }
    output.flush()?;
    Ok(())
}

fn validate_paper_mario_source(input_path: &Path) -> Result<()> {
    let source_len = fs::metadata(input_path)?.len();
    if source_len != PAPER_MARIO_USA10_FILE_SIZE {
        return Err(RomWeaverError::Validation(
            "Source ROM checksum mismatch".into(),
        ));
    }

    let mut source = File::open(input_path)?;
    let mut hasher = Hasher::new();
    let mut buffer = vec![0u8; PMSR_IO_BUFFER_SIZE];
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hasher.finalize() != PAPER_MARIO_USA10_CRC32 {
        return Err(RomWeaverError::Validation(
            "Source ROM checksum mismatch".into(),
        ));
    }
    Ok(())
}

fn pmsr_create_chunk_count(modified_len: u64) -> Result<usize> {
    chunk_count_for_len_checked(
        modified_len,
        CREATE_SCAN_CHUNK_BYTES as u64,
        "MOD create required too many chunks to index",
    )
}

fn pmsr_create_thread_capability(modified_len: u64) -> Result<ThreadCapability> {
    let chunk_count = pmsr_create_chunk_count(modified_len)?;
    Ok(ThreadCapability::parallel(Some(chunk_count.max(1))))
}

fn create_pmsr_patch_streaming(
    original_path: &Path,
    modified_path: &Path,
) -> Result<CreatedPmsrPatch> {
    let original_len = fs::metadata(original_path)?.len();
    let modified_len = fs::metadata(modified_path)?.len();
    if modified_len < original_len {
        return Err(RomWeaverError::Validation(format!(
            "MOD create does not support shrinking outputs (original: {}, modified: {})",
            original_len, modified_len,
        )));
    }

    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    let mut original_remaining = original_len;
    let mut modified_remaining = modified_len;
    let mut source_buffer = vec![0u8; PMSR_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; PMSR_IO_BUFFER_SIZE];
    let mut records = Vec::<PmsrRecord>::new();
    let mut offset = 0u64;

    let mut pending_start: Option<u64> = None;
    let mut pending_data = Vec::<u8>::new();

    while modified_remaining > 0 {
        let chunk_len = usize::try_from(modified_remaining.min(PMSR_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("MOD chunk length exceeded usize".into()))?;
        let source_chunk_len =
            usize::try_from(original_remaining.min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("MOD source chunk length exceeded usize".into())
            })?;

        if source_chunk_len > 0 {
            original.read_exact(&mut source_buffer[..source_chunk_len])?;
        }
        modified.read_exact(&mut target_buffer[..chunk_len])?;

        for index in 0..chunk_len {
            let source_byte = if index < source_chunk_len {
                source_buffer[index]
            } else {
                0
            };
            let target_byte = target_buffer[index];
            if source_byte == target_byte {
                if !pending_data.is_empty() {
                    let start = pending_start.expect("pending start exists");
                    records.push(PmsrRecord {
                        offset: start,
                        data: std::mem::take(&mut pending_data),
                    });
                    pending_start = None;
                }
            } else {
                if pending_start.is_none() {
                    pending_start = Some(offset);
                }
                pending_data.push(target_byte);
            }
            offset = checked_add(offset, 1, "MOD scan offset")?;
        }

        original_remaining = original_remaining.saturating_sub(source_chunk_len as u64);
        modified_remaining = modified_remaining
            .checked_sub(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("MOD remaining underflowed".into()))?;
    }

    if !pending_data.is_empty() {
        let start = pending_start.expect("pending start exists");
        records.push(PmsrRecord {
            offset: start,
            data: pending_data,
        });
    }

    finalize_created_pmsr_patch(records, modified_len)
}

fn create_pmsr_patch_parallel(
    original_path: &Path,
    modified_path: &Path,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<CreatedPmsrPatch> {
    let original_len = fs::metadata(original_path)?.len();
    let modified_len = fs::metadata(modified_path)?.len();
    if modified_len < original_len {
        return Err(RomWeaverError::Validation(format!(
            "MOD create does not support shrinking outputs (original: {}, modified: {})",
            original_len, modified_len,
        )));
    }

    if crate::patches_reads_source_on_main_thread() {
        let combined = original_len.saturating_add(modified_len);
        if combined > crate::IN_MEMORY_APPLY_LIMIT_BYTES {
            info!(
                original_len,
                modified_len,
                "PMSR create: combined size exceeds in-memory limit; falling back to serial path"
            );
            return create_pmsr_patch_streaming(original_path, modified_path);
        }
    }

    let chunk_count = pmsr_create_chunk_count(modified_len)?;
    let chunk_records = scan_create_chunks(
        crate::PatchCreateSources {
            original_path,
            original_len,
            modified_path,
            modified_len,
        },
        modified_len,
        CREATE_SCAN_CHUNK_BYTES as u64,
        chunk_count,
        pool,
        |start, original_bytes, modified_bytes| {
            context.cancel().check()?;
            collect_pmsr_records_from_bytes(start, original_bytes, modified_bytes)
        },
        |chunk_index| {
            context.cancel().check()?;
            collect_pmsr_records_for_chunk(
                chunk_index,
                original_path,
                original_len,
                modified_path,
                modified_len,
            )
        },
    )?;
    let records = merge_pmsr_records(chunk_records)?;
    finalize_created_pmsr_patch(records, modified_len)
}

fn collect_pmsr_records_for_chunk(
    chunk_index: usize,
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
) -> Result<Vec<PmsrRecord>> {
    let start = u64::try_from(chunk_index)
        .ok()
        .and_then(|index| index.checked_mul(CREATE_SCAN_CHUNK_BYTES as u64))
        .ok_or_else(|| RomWeaverError::Validation("MOD create chunk offset overflowed".into()))?;
    if start >= modified_len {
        return Ok(Vec::new());
    }
    let end = start
        .saturating_add(CREATE_SCAN_CHUNK_BYTES as u64)
        .min(modified_len);
    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    if start < original_len {
        original.seek(SeekFrom::Start(start))?;
    }
    modified.seek(SeekFrom::Start(start))?;
    let mut original_buffer = vec![0u8; PMSR_IO_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; PMSR_IO_BUFFER_SIZE];
    let mut records = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_data = Vec::new();
    let mut cursor = start;

    while cursor < end {
        let chunk_len =
            usize::try_from((end - cursor).min(PMSR_IO_BUFFER_SIZE as u64)).map_err(|_| {
                RomWeaverError::Validation("MOD compare chunk exceeded addressable memory".into())
            })?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;
        let original_chunk_len = if cursor >= original_len {
            0
        } else {
            usize::try_from((original_len - cursor).min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("MOD source chunk exceeded addressable memory".into())
            })?
        };
        if original_chunk_len > 0 {
            original.read_exact(&mut original_buffer[..original_chunk_len])?;
        }

        for index in 0..chunk_len {
            let source = if index < original_chunk_len {
                original_buffer[index]
            } else {
                0
            };
            let target = modified_buffer[index];
            if source == target {
                if !pending_data.is_empty() {
                    records.push(PmsrRecord {
                        offset: pending_start.expect("pending start exists"),
                        data: std::mem::take(&mut pending_data),
                    });
                    pending_start = None;
                }
            } else {
                if pending_start.is_none() {
                    pending_start = Some(cursor);
                }
                pending_data.push(target);
            }
            cursor = checked_add(cursor, 1, "MOD scan offset")?;
        }
    }

    if !pending_data.is_empty() {
        records.push(PmsrRecord {
            offset: pending_start.expect("pending start exists"),
            data: pending_data,
        });
    }

    Ok(records)
}

fn collect_pmsr_records_from_bytes(
    start: u64,
    original_bytes: &[u8],
    modified_bytes: &[u8],
) -> Result<Vec<PmsrRecord>> {
    let mut records = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_data = Vec::new();
    let mut cursor = start;

    for (index, &target) in modified_bytes.iter().enumerate() {
        let source = original_bytes.get(index).copied().unwrap_or(0);
        if source == target {
            if !pending_data.is_empty() {
                records.push(PmsrRecord {
                    offset: pending_start.expect("pending start exists"),
                    data: std::mem::take(&mut pending_data),
                });
                pending_start = None;
            }
        } else {
            if pending_start.is_none() {
                pending_start = Some(cursor);
            }
            pending_data.push(target);
        }
        cursor = checked_add(cursor, 1, "MOD scan offset")?;
    }

    if !pending_data.is_empty() {
        records.push(PmsrRecord {
            offset: pending_start.expect("pending start exists"),
            data: pending_data,
        });
    }

    Ok(records)
}

fn merge_pmsr_records(chunk_records: Vec<Vec<PmsrRecord>>) -> Result<Vec<PmsrRecord>> {
    let mut merged = Vec::<PmsrRecord>::new();
    for records in chunk_records {
        for record in records {
            if let Some(last) = merged.last_mut()
                && last.end()? == record.offset
            {
                last.data.extend_from_slice(&record.data);
                continue;
            }
            merged.push(record);
        }
    }
    Ok(merged)
}

fn finalize_created_pmsr_patch(
    mut records: Vec<PmsrRecord>,
    target_len: u64,
) -> Result<CreatedPmsrPatch> {
    let max_record_end = records.iter().try_fold(0u64, |current_max, record| {
        let data_len = u64::try_from(record.data.len())
            .map_err(|_| RomWeaverError::Validation("MOD record length exceeded u64".into()))?;
        let end = checked_add(record.offset, data_len, "MOD record end")?;
        Ok::<u64, RomWeaverError>(current_max.max(end))
    })?;

    // PMSR does not encode target length directly. A zero-length trailing record
    // preserves growth when the tail bytes are all zero.
    if target_len > max_record_end {
        records.push(PmsrRecord {
            offset: target_len,
            data: Vec::new(),
        });
    }

    let bytes = encode_pmsr_records(&records)?;
    Ok(CreatedPmsrPatch {
        bytes,
        record_count: records.len(),
    })
}

fn encode_pmsr_records(records: &[PmsrRecord]) -> Result<Vec<u8>> {
    let record_count_u32 = u32::try_from(records.len()).map_err(|_| {
        RomWeaverError::Validation("MOD record count exceeded encodable range".into())
    })?;
    let payload_capacity = records.iter().try_fold(0usize, |accumulator, record| {
        let next = accumulator
            .checked_add(8)
            .and_then(|value| value.checked_add(record.data.len()))
            .ok_or_else(|| {
                RomWeaverError::Validation("MOD patch size exceeded addressable memory".into())
            })?;
        Ok::<usize, RomWeaverError>(next)
    })?;
    let mut bytes = Vec::with_capacity(PMSR_HEADER_SIZE.checked_add(payload_capacity).ok_or_else(
        || RomWeaverError::Validation("MOD patch size exceeded addressable memory".into()),
    )?);
    bytes.extend_from_slice(PMSR_MAGIC);
    bytes.extend_from_slice(&record_count_u32.to_be_bytes());
    for record in records {
        let offset_u32 = u32::try_from(record.offset).map_err(|_| {
            RomWeaverError::Validation("MOD record offset exceeded 32-bit range".into())
        })?;
        let length_u32 = u32::try_from(record.data.len()).map_err(|_| {
            RomWeaverError::Validation("MOD record length exceeded 32-bit range".into())
        })?;
        bytes.extend_from_slice(&offset_u32.to_be_bytes());
        bytes.extend_from_slice(&length_u32.to_be_bytes());
        bytes.extend_from_slice(&record.data);
    }
    Ok(bytes)
}

#[cfg(test)]
fn read_u32_be(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u32> {
    let slice = read_exact(bytes, cursor, 4, label)?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

#[cfg(test)]
fn read_exact<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    len: usize,
    label: &str,
) -> Result<&'a [u8]> {
    let end = cursor
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} offset overflowed")))?;
    let slice = bytes.get(*cursor..end).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "MOD patch ended unexpectedly while reading {label}"
        ))
    })?;
    *cursor = end;
    Ok(slice)
}

fn checked_add(offset: u64, len: u64, label: &str) -> Result<u64> {
    offset
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

struct PmsrFileParser<R> {
    reader: R,
    file_len: u64,
    offset: u64,
}

impl<R: Read> PmsrFileParser<R> {
    fn new(reader: R, file_len: u64) -> Self {
        Self {
            reader,
            file_len,
            offset: 0,
        }
    }

    fn remaining(&self) -> u64 {
        self.file_len.saturating_sub(self.offset)
    }

    fn read_exact(&mut self, len: usize, label: &str) -> Result<Vec<u8>> {
        let len_u64 = u64::try_from(len)
            .map_err(|_| RomWeaverError::Validation(format!("{label} length overflowed u64")))?;
        if len_u64 > self.remaining() {
            return Err(RomWeaverError::Validation(format!(
                "MOD patch ended unexpectedly while reading {label}"
            )));
        }

        let mut bytes = vec![0u8; len];
        self.reader.read_exact(&mut bytes)?;
        self.offset = self
            .offset
            .checked_add(len_u64)
            .ok_or_else(|| RomWeaverError::Validation(format!("{label} offset overflowed")))?;
        Ok(bytes)
    }

    fn read_u32_be(&mut self, label: &str) -> Result<u32> {
        let bytes = self.read_exact(4, label)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

#[cfg(test)]
#[path = "../tests/unit/pmsr.rs"]
mod tests;
/* jscpd:ignore-end */
