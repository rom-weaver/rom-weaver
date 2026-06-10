use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use tracing::info;

use rayon::prelude::*;
use rom_weaver_core::{
    BlockCacheReader, DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES,
    FormatDescriptor, OperationContext, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchCreateRequest, PatchHandler, Result, RomWeaverError, SharedThreadPool,
};

use crate::shared::threading::{
    chunk_count_for_len, parallel_chunked_capability, parallel_per_record_capability,
};

const PAT_LINE_MAX_BYTES: usize = 4 * 1024;
const PAT_SCAN_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

pub struct PatPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl PatPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn parse_report(&self, patch_path: &Path) -> Result<OperationReport> {
        crate::patch_parse_report_with(self.descriptor, || {
            let parsed = parse_pat_file(patch_path)?;
            Ok(build_pat_parse_label(self.descriptor.name, &parsed))
        })
    }

    fn apply_report(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let parsed = parse_pat_file(patch_path)?;
        let grouped_records = group_pat_records_by_offset(&parsed.records);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let output_len = fs::metadata(&request.input)?.len();
        validate_pat_record_offsets(&grouped_records, output_len)?;
        let thread_capability = parallel_per_record_capability(grouped_records.len());
        let planned_execution = context.plan_threads(thread_capability.clone());

        let (execution, writes) = if crate::can_apply_in_memory(output_len, output_len) {
            let output_len_usize = usize::try_from(output_len).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "input `{}` is too large to process in memory",
                    request.input.display()
                ))
            })?;
            let mut output_bytes = vec![0u8; output_len_usize];
            let mut input = File::open(&request.input)?;
            input.read_exact(&mut output_bytes)?;
            let current_bytes: Vec<u8> = grouped_records
                .iter()
                .map(|g| output_bytes[g.offset as usize])
                .collect();
            let writes = grouped_records
                .iter()
                .enumerate()
                .map(|(index, group)| {
                    prepare_pat_offset_write(group, current_bytes[index], context)
                })
                .collect::<Result<Vec<_>>>()?;
            for write in &writes {
                output_bytes[write.offset as usize] = write.byte;
            }
            fs::write(&request.output, &output_bytes)?;
            let mut execution = planned_execution;
            execution.effective_threads = 1;
            execution.used_parallelism = false;
            (execution, writes)
        } else {
            fs::copy(&request.input, &request.output)?;
            let input_bytes =
                read_pat_group_input_bytes(&grouped_records, &request.input, context)?;
            let (execution, mut writes) = if planned_execution.used_parallelism {
                let (execution, pool) = context.build_pool(thread_capability)?;
                let writes = pool.install(|| {
                    grouped_records
                        .par_iter()
                        .enumerate()
                        .map(|(index, group)| {
                            prepare_pat_offset_write(group, input_bytes[index], context)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;
                (execution, writes)
            } else {
                let writes = grouped_records
                    .iter()
                    .enumerate()
                    .map(|(index, group)| {
                        prepare_pat_offset_write(group, input_bytes[index], context)
                    })
                    .collect::<Result<Vec<_>>>()?;
                (planned_execution, writes)
            };
            writes.sort_by_key(|write| write.offset);
            let mut output = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&request.output)?;
            for write in &writes {
                output.seek(SeekFrom::Start(write.offset))?;
                output.write_all(&[write.byte])?;
            }
            output.flush()?;
            (execution, writes)
        };

        let mut forward_applied = 0usize;
        let mut reverse_applied = 0usize;
        let mut skipped = 0usize;
        for write in &writes {
            forward_applied = forward_applied
                .checked_add(write.forward_applied)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
            reverse_applied = reverse_applied
                .checked_add(write.reverse_applied)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
            skipped = skipped
                .checked_add(write.skipped)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        }

        let ignored_suffix = if parsed.ignored_lines > 0 {
            format!("; ignored {} non-record line(s)", parsed.ignored_lines)
        } else {
            String::new()
        };
        let skipped_suffix = if skipped > 0 {
            format!("; skipped {skipped} record(s) due to unexpected input byte")
        } else {
            String::new()
        };

        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch with {} record(s): {} forward / {} reverse{ignored_suffix}{skipped_suffix}",
                self.descriptor.name,
                parsed.records.len(),
                forward_applied,
                reverse_applied
            ),
            Some(execution),
        ))
    }
}

impl PatchHandler for PatPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        self.parse_report(patch_path)
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.apply_report(request, context)
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        if original_len != modified_len {
            return Err(RomWeaverError::Validation(format!(
                "PAT create requires equal input lengths (original: {original_len}, modified: {modified_len})"
            )));
        }

        let (execution, pool) = context.build_pool(parallel_chunked_capability(
            original_len,
            CREATE_THREAD_SCAN_CHUNK_BYTES as u64,
        ))?;
        let created = create_pat_patch(
            &request.original,
            &request.modified,
            &pool,
            execution.used_parallelism,
        )?;

        let mut output = crate::create_buffered_output(&request.output)?;
        for record in &created.records {
            writeln!(
                output,
                "{:08X} {:02X} {:02X}",
                record.offset, record.source_byte, record.modified_byte
            )?;
        }
        output.flush()?;

        Ok(crate::patch_success_report(
            self.descriptor,
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name,
                created.records.len()
            ),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
    }
}

#[derive(Clone, Copy, Debug)]
struct PatRecord {
    offset: u64,
    source_byte: u8,
    modified_byte: u8,
}

#[derive(Debug)]
pub(crate) struct ParsedPatPatch {
    records: Vec<PatRecord>,
    ignored_lines: usize,
}

#[derive(Debug)]
struct CreatedPatPatch {
    records: Vec<PatRecord>,
}

#[derive(Debug)]
struct PatOffsetGroup {
    offset: u64,
    records: Vec<PatRecord>,
}

#[derive(Clone, Copy, Debug)]
struct PreparedPatWrite {
    offset: u64,
    byte: u8,
    forward_applied: usize,
    reverse_applied: usize,
    skipped: usize,
}

pub(crate) fn has_pat_record_signature(path: &Path) -> bool {
    parse_pat_file(path)
        .map(|parsed| !parsed.records.is_empty())
        .unwrap_or(false)
}

fn group_pat_records_by_offset(records: &[PatRecord]) -> Vec<PatOffsetGroup> {
    let mut grouped = BTreeMap::<u64, Vec<PatRecord>>::new();
    for record in records {
        grouped.entry(record.offset).or_default().push(*record);
    }
    grouped
        .into_iter()
        .map(|(offset, records)| PatOffsetGroup { offset, records })
        .collect()
}

fn validate_pat_record_offsets(groups: &[PatOffsetGroup], output_len: u64) -> Result<()> {
    for group in groups {
        if group.offset >= output_len {
            return Err(RomWeaverError::Validation(format!(
                "PAT record offset 0x{:08X} exceeded input length {}",
                group.offset, output_len
            )));
        }
    }
    Ok(())
}

fn prepare_pat_offset_write(
    group: &PatOffsetGroup,
    mut current: u8,
    context: &OperationContext,
) -> Result<PreparedPatWrite> {
    context.cancel().check()?;

    let mut forward_applied = 0usize;
    let mut reverse_applied = 0usize;
    let mut skipped = 0usize;

    for record in &group.records {
        if current == record.source_byte {
            current = record.modified_byte;
            forward_applied = forward_applied
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        } else if current == record.modified_byte {
            current = record.source_byte;
            reverse_applied = reverse_applied
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        } else {
            skipped = skipped
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        }
    }

    Ok(PreparedPatWrite {
        offset: group.offset,
        byte: current,
        forward_applied,
        reverse_applied,
        skipped,
    })
}

fn read_pat_group_input_bytes(
    groups: &[PatOffsetGroup],
    input_path: &Path,
    context: &OperationContext,
) -> Result<Vec<u8>> {
    let mut reader = BlockCacheReader::open(
        input_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    let mut bytes = Vec::with_capacity(groups.len());
    let mut byte = [0u8; 1];
    for group in groups {
        context.cancel().check()?;
        reader.read_exact_at(group.offset, &mut byte)?;
        bytes.push(byte[0]);
    }
    Ok(bytes)
}

fn parse_pat_file(path: &Path) -> Result<ParsedPatPatch> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    parse_pat_reader(reader)
}

fn build_pat_parse_label(format_name: &str, parsed: &ParsedPatPatch) -> String {
    if parsed.ignored_lines == 0 {
        return format!(
            "parsed {format_name} patch with {} record(s)",
            parsed.records.len()
        );
    }

    format!(
        "parsed {format_name} patch with {} record(s); ignored {} non-record line(s)",
        parsed.records.len(),
        parsed.ignored_lines
    )
}

fn parse_pat_reader<R: BufRead>(mut reader: R) -> Result<ParsedPatPatch> {
    let mut records = Vec::new();
    let mut ignored_lines = 0usize;

    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        if line.len() > PAT_LINE_MAX_BYTES {
            return Err(RomWeaverError::Validation(format!(
                "PAT line exceeded maximum supported length of {PAT_LINE_MAX_BYTES} byte(s)"
            )));
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            ignored_lines = ignored_lines
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT line count overflowed".into()))?;
            continue;
        }

        if let Some(record) = parse_pat_record(trimmed) {
            records.push(record);
        } else {
            ignored_lines = ignored_lines
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT line count overflowed".into()))?;
        }
    }

    Ok(ParsedPatPatch {
        records,
        ignored_lines,
    })
}

fn parse_pat_record(line: &str) -> Option<PatRecord> {
    let line = line.strip_prefix('\u{feff}').unwrap_or(line);
    let mut fields = line.split_whitespace();

    let offset_field = fields.next()?;
    let source_field = fields.next()?;
    let modified_field = fields.next()?;
    if fields.next().is_some() {
        return None;
    }
    if source_field.len() != 2 || modified_field.len() != 2 {
        return None;
    }

    let offset_hex = offset_field.get(..8)?;
    let offset = u64::from(u32::from_str_radix(offset_hex, 16).ok()?);
    let source_byte = u8::from_str_radix(source_field, 16).ok()?;
    let modified_byte = u8::from_str_radix(modified_field, 16).ok()?;

    Some(PatRecord {
        offset,
        source_byte,
        modified_byte,
    })
}

fn create_pat_patch_streaming(
    original_path: &Path,
    modified_path: &Path,
) -> Result<CreatedPatPatch> {
    let original_len = fs::metadata(original_path)?.len();
    let modified_len = fs::metadata(modified_path)?.len();
    if original_len != modified_len {
        return Err(RomWeaverError::Validation(format!(
            "PAT create requires equal input lengths (original: {original_len}, modified: {modified_len})"
        )));
    }

    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    let mut original_buffer = vec![0u8; PAT_SCAN_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; PAT_SCAN_BUFFER_SIZE];

    let mut records = Vec::new();
    let mut offset = 0u64;

    loop {
        let read = original.read(&mut original_buffer)?;
        let modified_read = modified.read(&mut modified_buffer)?;

        if read != modified_read {
            return Err(RomWeaverError::Validation(
                "PAT create detected mismatched read lengths while scanning inputs".into(),
            ));
        }
        if read == 0 {
            break;
        }

        for index in 0..read {
            let source_byte = original_buffer[index];
            let modified_byte = modified_buffer[index];
            if source_byte != modified_byte {
                if offset > u64::from(u32::MAX) {
                    return Err(RomWeaverError::Validation(
                        "PAT create supports offsets up to 0xFFFFFFFF".into(),
                    ));
                }

                records.push(PatRecord {
                    offset,
                    source_byte,
                    modified_byte,
                });
            }

            offset = offset
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT create offset overflowed".into()))?;
        }
    }

    Ok(CreatedPatPatch { records })
}

fn pat_create_chunk_count(input_len: u64) -> usize {
    chunk_count_for_len(input_len, CREATE_THREAD_SCAN_CHUNK_BYTES as u64)
}

fn create_pat_patch(
    original_path: &Path,
    modified_path: &Path,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
) -> Result<CreatedPatPatch> {
    if use_parallel_scan {
        create_pat_patch_parallel(original_path, modified_path, pool)
    } else {
        create_pat_patch_streaming(original_path, modified_path)
    }
}

fn create_pat_patch_parallel(
    original_path: &Path,
    modified_path: &Path,
    pool: &SharedThreadPool,
) -> Result<CreatedPatPatch> {
    let original_len = fs::metadata(original_path)?.len();
    let modified_len = fs::metadata(modified_path)?.len();
    if original_len != modified_len {
        return Err(RomWeaverError::Validation(format!(
            "PAT create requires equal input lengths (original: {original_len}, modified: {modified_len})"
        )));
    }
    if original_len > u64::from(u32::MAX).saturating_add(1) {
        return Err(RomWeaverError::Validation(
            "PAT create supports offsets up to 0xFFFFFFFF".into(),
        ));
    }

    if original_len == 0 {
        return Ok(CreatedPatPatch {
            records: Vec::new(),
        });
    }

    if crate::patches_reads_source_on_main_thread() {
        let combined = original_len.saturating_add(modified_len);
        if combined > crate::IN_MEMORY_APPLY_LIMIT_BYTES {
            info!(
                original_len,
                modified_len,
                "PAT create: combined size exceeds in-memory limit; falling back to serial path"
            );
            return create_pat_patch_streaming(original_path, modified_path);
        }
    }

    let chunk_count = pat_create_chunk_count(original_len);
    let per_chunk_records = if crate::patches_reads_source_on_main_thread() {
        let chunk_size = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
        let chunk_starts: Vec<u64> = (0..chunk_count as u64)
            .map(|i| i * chunk_size)
            .filter(|&s| s < original_len)
            .collect();
        let buffered = chunk_starts
            .iter()
            .map(|&start| {
                let end = start.saturating_add(chunk_size).min(original_len);
                crate::read_original_modified_chunk(
                    original_path,
                    original_len,
                    modified_path,
                    start,
                    end,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        pool.install(|| {
            buffered
                .into_par_iter()
                .zip(chunk_starts.into_par_iter())
                .map(|((original_bytes, modified_bytes), start)| {
                    collect_pat_chunk_records_from_bytes(start, &original_bytes, &modified_bytes)
                })
                .collect::<Result<Vec<_>>>()
        })?
    } else {
        pool.install(|| {
            (0..chunk_count)
                .into_par_iter()
                .map(|chunk_index| {
                    collect_pat_chunk_records_for_chunk(
                        chunk_index,
                        original_path,
                        modified_path,
                        original_len,
                    )
                })
                .collect::<Result<Vec<_>>>()
        })?
    };

    let mut records = Vec::new();
    for mut chunk_records in per_chunk_records {
        records.append(&mut chunk_records);
    }

    Ok(CreatedPatPatch { records })
}

fn collect_pat_chunk_records_for_chunk(
    chunk_index: usize,
    original_path: &Path,
    modified_path: &Path,
    input_len: u64,
) -> Result<Vec<PatRecord>> {
    let start = u64::try_from(chunk_index)
        .ok()
        .and_then(|index| index.checked_mul(CREATE_THREAD_SCAN_CHUNK_BYTES as u64))
        .ok_or_else(|| RomWeaverError::Validation("PAT create chunk offset overflowed".into()))?;
    if start >= input_len {
        return Ok(Vec::new());
    }
    let end = start
        .saturating_add(CREATE_THREAD_SCAN_CHUNK_BYTES as u64)
        .min(input_len);

    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    original.seek(SeekFrom::Start(start))?;
    modified.seek(SeekFrom::Start(start))?;

    let mut original_buffer = vec![0u8; PAT_SCAN_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; PAT_SCAN_BUFFER_SIZE];
    let mut records = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let chunk_len =
            usize::try_from((end - cursor).min(PAT_SCAN_BUFFER_SIZE as u64)).map_err(|_| {
                RomWeaverError::Validation("PAT compare chunk exceeded addressable memory".into())
            })?;
        original.read_exact(&mut original_buffer[..chunk_len])?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        for index in 0..chunk_len {
            let source_byte = original_buffer[index];
            let modified_byte = modified_buffer[index];
            if source_byte != modified_byte {
                let offset = cursor.checked_add(index as u64).ok_or_else(|| {
                    RomWeaverError::Validation("PAT create offset overflowed".into())
                })?;
                records.push(PatRecord {
                    offset,
                    source_byte,
                    modified_byte,
                });
            }
        }
        cursor = cursor.saturating_add(chunk_len as u64);
    }

    Ok(records)
}

fn collect_pat_chunk_records_from_bytes(
    start: u64,
    original_bytes: &[u8],
    modified_bytes: &[u8],
) -> Result<Vec<PatRecord>> {
    let mut records = Vec::new();
    for (index, (&source_byte, &modified_byte)) in
        original_bytes.iter().zip(modified_bytes.iter()).enumerate()
    {
        if source_byte != modified_byte {
            let offset = start
                .checked_add(index as u64)
                .ok_or_else(|| RomWeaverError::Validation("PAT create offset overflowed".into()))?;
            records.push(PatRecord {
                offset,
                source_byte,
                modified_byte,
            });
        }
    }
    Ok(records)
}

#[cfg(test)]
#[path = "../tests/unit/pat.rs"]
mod tests;
