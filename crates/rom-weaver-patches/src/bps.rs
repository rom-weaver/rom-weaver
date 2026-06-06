use std::{
    cmp::Ordering,
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use crc32fast::Hasher;
use rayon::prelude::*;
use rom_weaver_checksum::checksum_file_values;
#[cfg(test)]
use rom_weaver_checksum::crc32_bytes;
use rom_weaver_core::{
    DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, OperationStatus, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    ProgressEvent, Result, RomWeaverError, SharedBlockCacheReader, SharedThreadPool,
    ThreadCapability,
};
use serde_json::json;
use suffix_array::SuffixArray;

const BPS_MAGIC: &[u8; 4] = b"BPS1";
const BPS_FOOTER_SIZE: usize = 12;
const COPY_BUFFER_SIZE: usize = 32 * 1024;
const BPS_NO_OFFSET: u32 = u32::MAX;
const BPS_MIN_COPY_LENGTH: usize = 4;
const BPS_CREATE_INDEX_TAIL_BYTES: usize = 256;
const BPS_CREATE_MEMORY_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;

pub struct BpsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl BpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for BpsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_bps_file(patch_path)?;
        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s); source crc32 {:08x}; target crc32 {:08x}; patch crc32 {:08x}",
                self.descriptor.name,
                patch.actions.len(),
                patch.source_checksum,
                patch.target_checksum,
                patch.patch_checksum
            ),
            Some(100.0),
            None,
        );
        report.details = Some(json!({
            "patch": {
                "format": self.descriptor.name,
                "source_size": patch.source_size,
                "target_size": patch.target_size,
                "source_crc32": patch.source_checksum,
                "target_crc32": patch.target_checksum,
                "patch_crc32": patch.patch_checksum,
                "record_count": patch.actions.len(),
            }
        }));
        Ok(report)
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let patch = parse_bps_file_with_checksum_validation(patch_path, validate_checksums)?;
        let mut source = File::open(&request.input)?;
        validate_input_file(
            &request.input,
            &mut source,
            patch.source_size,
            patch.source_checksum,
            validate_checksums,
            context,
        )?;

        let mut output = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&request.output)?;
        output.set_len(patch.target_size)?;
        let thread_capability = bps_apply_thread_capability(&patch.actions);
        let planned_execution = context.plan_threads(thread_capability.clone());
        let has_target_copy = patch_contains_target_copy(&patch.actions);
        let wants_parallel = planned_execution.used_parallelism && !has_target_copy;
        let execution = if crate::can_apply_in_memory(patch.source_size, patch.target_size) {
            let target_size = patch.target_size as usize;
            let mut source_bytes = Vec::with_capacity(patch.source_size as usize);
            source.read_to_end(&mut source_bytes)?;
            let mut output_bytes = vec![0u8; target_size];
            apply_patch_actions_in_memory(
                &patch,
                &source_bytes,
                &mut output_bytes,
                context,
                self.descriptor.name,
            )?;
            output.seek(SeekFrom::Start(0))?;
            output.write_all(&output_bytes)?;
            let mut execution = planned_execution;
            execution.effective_threads = 1;
            execution.used_parallelism = false;
            execution
        } else if wants_parallel {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let prepared = prepare_bps_writes_parallel(
                &patch,
                &request.input,
                patch.source_size,
                &pool,
                context,
            )?;
            apply_prepared_bps_writes(&mut output, &prepared)?;
            execution
        } else {
            let mut execution = planned_execution;
            if execution.used_parallelism && has_target_copy {
                execution.apply_pool_fallback(
                    "BPS apply encountered TargetCopy actions that require sequential output"
                        .to_string(),
                );
            }
            let mut buffered_source = BufReader::new(source);
            apply_patch_actions(
                &patch,
                &mut buffered_source,
                &mut output,
                context,
                self.descriptor.name,
            )?;
            execution
        };
        validate_output_file(
            &request.output,
            &mut output,
            patch.target_size,
            patch.target_checksum,
            validate_checksums,
            context,
        )?;

        let checksum_suffix = if validate_checksums {
            String::new()
        } else {
            "; checksum validation skipped".to_string()
        };
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} record(s){}",
                self.descriptor.name,
                patch.actions.len(),
                checksum_suffix
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        let execution = context.plan_threads(ThreadCapability::single_threaded());

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        let created = create_bps_patch_in_memory(
            crate::PatchCreateSources {
                original_path: &request.original,
                original_len,
                modified_path: &request.modified,
                modified_len,
            },
            &mut output,
            context,
            self.descriptor.name,
        )?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name, created.action_count
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: true,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: true,
        }
    }
}

#[derive(Debug)]
struct ParsedBpsPatch {
    source_size: u64,
    target_size: u64,
    source_checksum: u32,
    target_checksum: u32,
    patch_checksum: u32,
    actions: Vec<BpsAction>,
}

#[derive(Debug)]
enum BpsAction {
    SourceRead { length: u64 },
    TargetRead { data: Vec<u8> },
    SourceCopy { length: u64, relative_offset: i128 },
    TargetCopy { length: u64, relative_offset: i128 },
}

#[derive(Debug, Default)]
struct CreatedBpsPatch {
    action_count: usize,
}

enum BpsWritePlanKind {
    SourceRange { source_offset: u64, len: u64 },
    Literal(Vec<u8>),
}

struct BpsWritePlan {
    output_offset: u64,
    kind: BpsWritePlanKind,
}

struct PreparedBpsWrite {
    output_offset: u64,
    data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BpsCreateMode {
    SourceRead,
    TargetRead,
    SourceCopy,
    TargetCopy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BpsSuffixIndexMode {
    FastReverse,
    LowMemory,
}

fn parse_bps_file(path: &Path) -> Result<ParsedBpsPatch> {
    parse_bps_file_with_checksum_validation(path, true)
}

fn parse_bps_file_with_checksum_validation(
    path: &Path,
    validate_patch_checksum: bool,
) -> Result<ParsedBpsPatch> {
    let file_len = fs::metadata(path)?.len();
    let minimum_len = (BPS_MAGIC.len() + BPS_FOOTER_SIZE) as u64;
    if file_len < minimum_len {
        return Err(RomWeaverError::Validation(
            "BPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let footer_offset = file_len
        .checked_sub(BPS_FOOTER_SIZE as u64)
        .expect("validated footer size");
    let mut parser = BpsFileParser::new(BufReader::new(File::open(path)?), footer_offset);

    if parser.read_exact(BPS_MAGIC.len())?.as_slice() != BPS_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let source_size = parser.read_varint()?;
    let target_size = parser.read_varint()?;
    let metadata_size = usize::try_from(parser.read_varint()?).map_err(|_| {
        RomWeaverError::Validation("BPS metadata size exceeded addressable memory".into())
    })?;
    let _metadata = parser.read_exact(metadata_size)?;

    let mut actions = Vec::new();
    let mut output_size = 0u64;
    while !parser.is_at_end() {
        let raw = parser.read_varint()?;
        let command = raw & 0x03;
        let length = (raw >> 2)
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("BPS action length overflowed".into()))?;
        output_size = output_size
            .checked_add(length)
            .ok_or_else(|| RomWeaverError::Validation("BPS target size overflowed".into()))?;

        let action = match command {
            0 => BpsAction::SourceRead { length },
            1 => {
                let data = parser.read_exact(usize::try_from(length).map_err(|_| {
                    RomWeaverError::Validation(
                        "BPS target-read length exceeded addressable memory".into(),
                    )
                })?)?;
                BpsAction::TargetRead { data }
            }
            2 => BpsAction::SourceCopy {
                length,
                relative_offset: decode_signed_offset(parser.read_varint()?),
            },
            3 => BpsAction::TargetCopy {
                length,
                relative_offset: decode_signed_offset(parser.read_varint()?),
            },
            _ => unreachable!(),
        };
        actions.push(action);
    }

    if output_size != target_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {target_size}, Actual: {output_size}"
        )));
    }

    let footer = read_bps_footer(path, footer_offset)?;
    let source_checksum = read_u32_le(&footer[0..4]);
    let target_checksum = read_u32_le(&footer[4..8]);
    let patch_checksum = read_u32_le(&footer[8..12]);
    if validate_patch_checksum {
        let actual_patch_checksum = crc32_prefix(path, file_len - 4)?;
        if actual_patch_checksum != patch_checksum {
            return Err(RomWeaverError::Validation(format!(
                "Patch checksum invalid; expected: {patch_checksum:x}, Actual: {actual_patch_checksum:x}"
            )));
        }
    }

    Ok(ParsedBpsPatch {
        source_size,
        target_size,
        source_checksum,
        target_checksum,
        patch_checksum,
        actions,
    })
}

#[cfg(test)]
fn parse_bps_bytes(bytes: &[u8]) -> Result<ParsedBpsPatch> {
    parse_bps_bytes_with_checksum_validation(bytes, true)
}

#[cfg(test)]
fn parse_bps_bytes_with_checksum_validation(
    bytes: &[u8],
    validate_patch_checksum: bool,
) -> Result<ParsedBpsPatch> {
    if bytes.len() < BPS_MAGIC.len() + BPS_FOOTER_SIZE {
        return Err(RomWeaverError::Validation(
            "BPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let footer_offset = bytes
        .len()
        .checked_sub(BPS_FOOTER_SIZE)
        .expect("validated footer size");
    let mut parser = BpsParser::new(bytes, footer_offset);

    if parser.read_exact(BPS_MAGIC.len())? != BPS_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let source_size = parser.read_varint()?;
    let target_size = parser.read_varint()?;
    let metadata_size = usize::try_from(parser.read_varint()?).map_err(|_| {
        RomWeaverError::Validation("BPS metadata size exceeded addressable memory".into())
    })?;
    let _metadata = parser.read_exact(metadata_size)?;

    let mut actions = Vec::new();
    let mut output_size = 0u64;
    while !parser.is_at_end() {
        let raw = parser.read_varint()?;
        let command = raw & 0x03;
        let length = (raw >> 2)
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("BPS action length overflowed".into()))?;
        output_size = output_size
            .checked_add(length)
            .ok_or_else(|| RomWeaverError::Validation("BPS target size overflowed".into()))?;

        let action = match command {
            0 => BpsAction::SourceRead { length },
            1 => {
                let data = parser
                    .read_exact(usize::try_from(length).map_err(|_| {
                        RomWeaverError::Validation(
                            "BPS target-read length exceeded addressable memory".into(),
                        )
                    })?)?
                    .to_vec();
                BpsAction::TargetRead { data }
            }
            2 => BpsAction::SourceCopy {
                length,
                relative_offset: decode_signed_offset(parser.read_varint()?),
            },
            3 => BpsAction::TargetCopy {
                length,
                relative_offset: decode_signed_offset(parser.read_varint()?),
            },
            _ => unreachable!(),
        };
        actions.push(action);
    }

    if output_size != target_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {target_size}, Actual: {output_size}"
        )));
    }

    let footer = &bytes[footer_offset..];
    let source_checksum = read_u32_le(&footer[0..4]);
    let target_checksum = read_u32_le(&footer[4..8]);
    let patch_checksum = read_u32_le(&footer[8..12]);
    if validate_patch_checksum {
        let actual_patch_checksum = crc32_bytes(&bytes[..bytes.len() - 4]);
        if actual_patch_checksum != patch_checksum {
            return Err(RomWeaverError::Validation(format!(
                "Patch checksum invalid; expected: {patch_checksum:x}, Actual: {actual_patch_checksum:x}"
            )));
        }
    }

    Ok(ParsedBpsPatch {
        source_size,
        target_size,
        source_checksum,
        target_checksum,
        patch_checksum,
        actions,
    })
}

/// Throttled progress reporter for sequential BPS apply.
///
/// Emits at most one `Running` progress event per whole-percent bucket of the
/// target output produced so far, mirroring the byte-progress pattern used by
/// the container and CHD handlers so the UI can render a moving apply bar.
struct BpsApplyProgress<'a> {
    context: &'a OperationContext,
    format_name: &'a str,
    target_size: u64,
    last_bucket: u8,
}

impl<'a> BpsApplyProgress<'a> {
    fn new(context: &'a OperationContext, format_name: &'a str, target_size: u64) -> Self {
        Self {
            context,
            format_name,
            target_size,
            last_bucket: 0,
        }
    }

    fn report(&mut self, output_offset: u64) {
        if self.target_size == 0 {
            return;
        }
        let completed = output_offset.min(self.target_size);
        let bucket = completed
            .saturating_mul(100)
            .checked_div(self.target_size)
            .unwrap_or(100)
            .min(100) as u8;
        if bucket <= self.last_bucket {
            return;
        }
        self.last_bucket = bucket;
        self.context.emit(ProgressEvent {
            command: "patch-apply".to_string(),
            family: OperationFamily::Patch,
            format: Some(self.format_name.to_string()),
            stage: "apply".to_string(),
            label: format!("applying patch using {}", self.format_name),
            details: None,
            percent: Some(bucket as f32),
            requested_threads: None,
            effective_threads: None,
            thread_mode: None,
            used_parallelism: None,
            thread_fallback: None,
            thread_fallback_reason: None,
            elapsed_ms: None,
            status: OperationStatus::Running,
        });
    }
}

fn apply_patch_actions(
    patch: &ParsedBpsPatch,
    source: &mut (impl Read + Seek),
    output: &mut File,
    context: &OperationContext,
    format_name: &str,
) -> Result<()> {
    let mut output_offset = 0u64;
    let mut source_relative_offset = 0i128;
    let mut target_relative_offset = 0i128;
    let mut progress = BpsApplyProgress::new(context, format_name, patch.target_size);
    let mut source_pos = 0u64;
    let mut output_pos = 0u64;
    let mut copy_buffer = [0u8; COPY_BUFFER_SIZE];

    for action in &patch.actions {
        context.cancel().check()?;
        match action {
            BpsAction::SourceRead { length } => {
                let end = output_offset.checked_add(*length).ok_or_else(|| {
                    RomWeaverError::Validation("BPS source-read offset overflowed".into())
                })?;
                if end > patch.source_size {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceRead exceeded input size at output offset {output_offset}"
                    )));
                }
                if source_pos != output_offset {
                    source.seek(SeekFrom::Start(output_offset))?;
                    source_pos = output_offset;
                }
                if output_pos != output_offset {
                    output.seek(SeekFrom::Start(output_offset))?;
                    output_pos = output_offset;
                }
                let mut remaining = *length;
                while remaining > 0 {
                    let chunk = remaining.min(copy_buffer.len() as u64) as usize;
                    source.read_exact(&mut copy_buffer[..chunk])?;
                    output.write_all(&copy_buffer[..chunk])?;
                    remaining -= chunk as u64;
                    output_offset += chunk as u64;
                    source_pos += chunk as u64;
                    output_pos += chunk as u64;
                    progress.report(output_offset);
                }
            }
            BpsAction::TargetRead { data } => {
                if output_pos != output_offset {
                    output.seek(SeekFrom::Start(output_offset))?;
                }
                output.write_all(data)?;
                let len = data.len() as u64;
                output_offset = output_offset.checked_add(len).ok_or_else(|| {
                    RomWeaverError::Validation("BPS output offset overflowed".into())
                })?;
                output_pos = output_offset;
                progress.report(output_offset);
            }
            BpsAction::SourceCopy {
                length,
                relative_offset,
            } => {
                let start = adjust_relative_offset(
                    source_relative_offset,
                    *relative_offset,
                    patch.source_size,
                    "source",
                )?;
                let end = start.checked_add(*length).ok_or_else(|| {
                    RomWeaverError::Validation("BPS source-copy length overflowed".into())
                })?;
                if end > patch.source_size {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceCopy exceeded input size at source offset {start}"
                    )));
                }
                if source_pos != start {
                    source.seek(SeekFrom::Start(start))?;
                    source_pos = start;
                }
                if output_pos != output_offset {
                    output.seek(SeekFrom::Start(output_offset))?;
                    output_pos = output_offset;
                }
                let mut remaining = *length;
                while remaining > 0 {
                    let chunk = remaining.min(copy_buffer.len() as u64) as usize;
                    source.read_exact(&mut copy_buffer[..chunk])?;
                    output.write_all(&copy_buffer[..chunk])?;
                    remaining -= chunk as u64;
                    output_offset += chunk as u64;
                    source_pos += chunk as u64;
                    output_pos += chunk as u64;
                    progress.report(output_offset);
                }
                source_relative_offset = i128::from(end);
            }
            BpsAction::TargetCopy {
                length,
                relative_offset,
            } => {
                let start = adjust_relative_offset(
                    target_relative_offset,
                    *relative_offset,
                    output_offset,
                    "target",
                )?;
                if start >= output_offset {
                    return Err(RomWeaverError::Validation(format!(
                        "TargetCopy started beyond produced output at offset {start}"
                    )));
                }
                copy_target_range(output, &mut output_offset, start, *length, &mut progress)?;
                output_pos = output_offset;
                target_relative_offset =
                    i128::from(start.checked_add(*length).ok_or_else(|| {
                        RomWeaverError::Validation("BPS target-copy length overflowed".into())
                    })?);
            }
        }

        if output_offset > patch.target_size {
            return Err(RomWeaverError::Validation(format!(
                "Output size invalid; Expected: {}, Actual: {output_offset}",
                patch.target_size
            )));
        }
    }

    if output_offset != patch.target_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {}, Actual: {output_offset}",
            patch.target_size
        )));
    }

    Ok(())
}

fn apply_patch_actions_in_memory(
    patch: &ParsedBpsPatch,
    source: &[u8],
    output: &mut [u8],
    context: &OperationContext,
    format_name: &str,
) -> Result<()> {
    let target_size = output.len();
    let mut output_offset = 0usize;
    let mut source_relative_offset = 0i128;
    let mut target_relative_offset = 0i128;
    let mut progress = BpsApplyProgress::new(context, format_name, patch.target_size);

    for action in &patch.actions {
        context.cancel().check()?;
        match action {
            BpsAction::SourceRead { length } => {
                let len = *length as usize;
                let end = output_offset + len;
                if end > source.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceRead exceeded input size at output offset {output_offset}"
                    )));
                }
                output[output_offset..end].copy_from_slice(&source[output_offset..end]);
                output_offset = end;
                progress.report(output_offset as u64);
            }
            BpsAction::TargetRead { data } => {
                let end = output_offset + data.len();
                output[output_offset..end].copy_from_slice(data);
                output_offset = end;
                progress.report(output_offset as u64);
            }
            BpsAction::SourceCopy {
                length,
                relative_offset,
            } => {
                let source_start = adjust_relative_offset(
                    source_relative_offset,
                    *relative_offset,
                    patch.source_size,
                    "source",
                )?;
                let len = *length as usize;
                let src_start = source_start as usize;
                let src_end = src_start + len;
                if src_end > source.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceCopy exceeded input size at source offset {src_start}"
                    )));
                }
                let dst_end = output_offset + len;
                output[output_offset..dst_end].copy_from_slice(&source[src_start..src_end]);
                source_relative_offset = i128::from(source_start + *length);
                output_offset = dst_end;
                progress.report(output_offset as u64);
            }
            BpsAction::TargetCopy {
                length,
                relative_offset,
            } => {
                let start = adjust_relative_offset(
                    target_relative_offset,
                    *relative_offset,
                    output_offset as u64,
                    "target",
                )?;
                let start_usize = start as usize;
                if start_usize >= output_offset {
                    return Err(RomWeaverError::Validation(format!(
                        "TargetCopy started beyond produced output at offset {start_usize}"
                    )));
                }
                let len = *length as usize;
                let mut remaining = len;
                let mut read_offset = start_usize;
                // Bounded by available bytes so src and dst never truly overlap: safe to use
                // copy_within which handles the run-length-encoding case correctly.
                while remaining > 0 {
                    let available = output_offset - read_offset;
                    let chunk = remaining.min(available).min(COPY_BUFFER_SIZE);
                    output.copy_within(read_offset..read_offset + chunk, output_offset);
                    remaining -= chunk;
                    read_offset += chunk;
                    output_offset += chunk;
                }
                target_relative_offset =
                    i128::from(start.checked_add(*length).ok_or_else(|| {
                        RomWeaverError::Validation("BPS target-copy length overflowed".into())
                    })?);
                progress.report(output_offset as u64);
            }
        }

        if output_offset > target_size {
            return Err(RomWeaverError::Validation(format!(
                "Output size invalid; Expected: {target_size}, Actual: {output_offset}"
            )));
        }
    }

    if output_offset != target_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {target_size}, Actual: {output_offset}"
        )));
    }

    Ok(())
}

fn create_bps_patch_in_memory(
    sources: crate::PatchCreateSources,
    output: &mut impl Write,
    context: &OperationContext,
    format_name: &str,
) -> Result<CreatedBpsPatch> {
    let crate::PatchCreateSources {
        original_path,
        original_len,
        modified_path,
        modified_len,
    } = sources;

    if !crate::can_apply_in_memory(original_len, modified_len) {
        return Err(RomWeaverError::Validation(format!(
            "BPS create requires copy-aware in-memory encoding; source and target must each be at most {} bytes",
            crate::IN_MEMORY_APPLY_LIMIT_BYTES
        )));
    }
    let suffix_index_mode = bps_create_suffix_index_mode(original_len, modified_len)?;

    let mut progress = BpsCreateProgress::new(context, format_name, modified_len);
    progress.report(0.0, "reading BPS create inputs");
    let create_data =
        read_bps_create_data(original_path, original_len, modified_path, modified_len)?;
    let target = create_data.target();
    let source = create_data.source();
    let source_checksum = crc32_slice(source);
    let target_checksum = crc32_slice(target);
    progress.report(3.0, "indexing BPS copy candidates");
    let mut combined_matcher =
        BpsCombinedSuffixMatcher::new(&create_data, suffix_index_mode, context, &mut progress)?;

    let mut created = CreatedBpsPatch::default();
    let mut writer = BpsCreateWriter::new(output);
    let mut target_read = BpsTargetReadBuffer::default();
    let mut source_relative_offset = 0i128;
    let mut target_relative_offset = 0i128;
    let mut output_offset = 0usize;
    writer.write_bytes(BPS_MAGIC)?;
    writer.write_varint(original_len)?;
    writer.write_varint(modified_len)?;
    writer.write_varint(0)?;

    while output_offset < target.len() {
        context.cancel().check()?;
        combined_matcher.ensure_indexed(output_offset, context, &mut progress)?;

        let mut best_mode = BpsCreateMode::TargetRead;
        let mut best_len = 0usize;
        let mut best_offset = 0usize;

        let source_read_len = common_prefix_len(source, output_offset, target, output_offset);
        if source_read_len > best_len {
            best_mode = BpsCreateMode::SourceRead;
            best_len = source_read_len;
            best_offset = output_offset;
        }

        let candidate = combined_matcher.find(output_offset)?;
        if candidate.len > best_len {
            best_mode = candidate.mode;
            best_len = candidate.len;
            best_offset = candidate.offset;
        }

        let rle_len = repeated_byte_run_len(target, output_offset);
        if rle_len > BPS_MIN_COPY_LENGTH && rle_len - 1 > best_len {
            target_read.add(output_offset, 1)?;
            target_read.flush(&mut writer, target, &mut created)?;
            writer.write_target_copy(
                (rle_len - 1) as u64,
                output_offset as u64,
                &mut target_relative_offset,
            )?;
            created.action_count = created.action_count.saturating_add(1);
            output_offset = output_offset
                .checked_add(rle_len)
                .ok_or_else(|| RomWeaverError::Validation("BPS output offset overflowed".into()))?;
            continue;
        }

        if best_len == 0
            || !bps_create_match_is_worth(
                best_mode,
                best_len,
                best_offset,
                output_offset,
                source_relative_offset,
                target_relative_offset,
                target_read.len,
            )?
        {
            best_mode = BpsCreateMode::TargetRead;
            best_len = 1;
        }

        if best_mode != BpsCreateMode::TargetRead {
            target_read.flush(&mut writer, target, &mut created)?;
        }

        match best_mode {
            BpsCreateMode::SourceRead => {
                writer.write_source_read(best_len as u64)?;
                created.action_count = created.action_count.saturating_add(1);
            }
            BpsCreateMode::TargetRead => {
                target_read.add(output_offset, best_len)?;
            }
            BpsCreateMode::SourceCopy => {
                writer.write_source_copy(
                    best_len as u64,
                    best_offset as u64,
                    &mut source_relative_offset,
                )?;
                created.action_count = created.action_count.saturating_add(1);
            }
            BpsCreateMode::TargetCopy => {
                writer.write_target_copy(
                    best_len as u64,
                    best_offset as u64,
                    &mut target_relative_offset,
                )?;
                created.action_count = created.action_count.saturating_add(1);
            }
        }

        output_offset = output_offset
            .checked_add(best_len)
            .ok_or_else(|| RomWeaverError::Validation("BPS output offset overflowed".into()))?;
        progress.report_output(output_offset as u64);
    }

    target_read.flush(&mut writer, target, &mut created)?;
    writer.finish(source_checksum, target_checksum)?;
    Ok(created)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BpsCreateMatch {
    mode: BpsCreateMode,
    offset: usize,
    len: usize,
}

impl Default for BpsCreateMatch {
    fn default() -> Self {
        Self {
            mode: BpsCreateMode::TargetRead,
            offset: 0,
            len: 0,
        }
    }
}

struct BpsCreateProgress<'a> {
    context: &'a OperationContext,
    format_name: &'a str,
    target_size: u64,
    last_bucket: i16,
}

impl<'a> BpsCreateProgress<'a> {
    fn new(context: &'a OperationContext, format_name: &'a str, target_size: u64) -> Self {
        Self {
            context,
            format_name,
            target_size,
            last_bucket: -1,
        }
    }

    fn report_output(&mut self, output_offset: u64) {
        let percent = if self.target_size == 0 {
            100.0
        } else {
            40.0 + ((output_offset.min(self.target_size) as f32 / self.target_size as f32) * 60.0)
        };
        self.report(percent, "creating BPS patch");
    }

    fn report_indexed(&mut self, sorted_target_len: usize) {
        let percent = if self.target_size == 0 {
            40.0
        } else {
            5.0 + ((sorted_target_len as f32 / self.target_size as f32) * 35.0)
        };
        self.report(percent, "indexing BPS copy candidates");
    }

    fn report(&mut self, percent: f32, label: &str) {
        let percent = percent.clamp(0.0, 99.0);
        let bucket = percent.floor() as i16;
        if bucket <= self.last_bucket {
            return;
        }
        self.last_bucket = bucket;
        self.context.emit(ProgressEvent {
            command: "patch-create".to_string(),
            family: OperationFamily::Patch,
            format: Some(self.format_name.to_string()),
            stage: "create".to_string(),
            label: label.to_string(),
            details: None,
            percent: Some(percent),
            requested_threads: None,
            effective_threads: None,
            thread_mode: None,
            used_parallelism: None,
            thread_fallback: None,
            thread_fallback_reason: None,
            elapsed_ms: None,
            status: OperationStatus::Running,
        });
    }
}

struct BpsCreateData {
    bytes: Vec<u8>,
    target_len: usize,
    source_len: usize,
}

impl BpsCreateData {
    fn target(&self) -> &[u8] {
        &self.bytes[..self.target_len]
    }

    fn source(&self) -> &[u8] {
        &self.bytes[self.target_len..]
    }
}

enum BpsJoinedSuffixBytes<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
}

impl<'a> BpsJoinedSuffixBytes<'a> {
    fn empty() -> Self {
        Self::Borrowed(&[])
    }

    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Owned(bytes) => bytes,
        }
    }
}

struct BpsCombinedSuffixMatcher<'a> {
    data: &'a BpsCreateData,
    index_mode: BpsSuffixIndexMode,
    sorted_target_len: usize,
    joined: BpsJoinedSuffixBytes<'a>,
    sorted: Vec<u32>,
    reverse: Vec<u32>,
}

impl<'a> BpsCombinedSuffixMatcher<'a> {
    fn new(
        data: &'a BpsCreateData,
        index_mode: BpsSuffixIndexMode,
        context: &OperationContext,
        progress: &mut BpsCreateProgress<'_>,
    ) -> Result<Self> {
        let mut matcher = Self {
            data,
            index_mode,
            sorted_target_len: 0,
            joined: BpsJoinedSuffixBytes::empty(),
            sorted: Vec::new(),
            reverse: Vec::new(),
        };
        let initial_len = initial_bps_sorted_target_len(data.source_len, data.target_len);
        matcher.reindex(initial_len, context, progress)?;
        Ok(matcher)
    }

    fn ensure_indexed(
        &mut self,
        output_offset: usize,
        context: &OperationContext,
        progress: &mut BpsCreateProgress<'_>,
    ) -> Result<()> {
        if output_offset.saturating_add(BPS_CREATE_INDEX_TAIL_BYTES) < self.sorted_target_len
            || self.sorted_target_len >= self.data.target_len
        {
            return Ok(());
        }
        let next_len =
            next_bps_sorted_target_len(output_offset, self.sorted_target_len, self.data.target_len);
        if next_len > self.sorted_target_len {
            self.reindex(next_len, context, progress)?;
        }
        Ok(())
    }

    fn reindex(
        &mut self,
        sorted_target_len: usize,
        context: &OperationContext,
        progress: &mut BpsCreateProgress<'_>,
    ) -> Result<()> {
        context.cancel().check()?;
        self.sorted.clear();
        self.reverse.clear();
        self.joined = BpsJoinedSuffixBytes::empty();

        let sorted_target_len = sorted_target_len.min(self.data.target_len);
        let joined_len = sorted_target_len
            .checked_add(self.data.source_len)
            .ok_or_else(|| RomWeaverError::Validation("BPS suffix input size overflowed".into()))?;
        if joined_len >= u32::MAX as usize {
            return Err(RomWeaverError::Validation(
                "BPS suffix input exceeded 32-bit suffix-array range".into(),
            ));
        }

        self.sorted_target_len = sorted_target_len;
        self.joined = if sorted_target_len == self.data.target_len {
            BpsJoinedSuffixBytes::Borrowed(&self.data.bytes)
        } else {
            let mut joined = Vec::new();
            try_reserve_exact(&mut joined, joined_len, "BPS suffix input")?;
            joined.extend_from_slice(&self.data.target()[..sorted_target_len]);
            joined.extend_from_slice(self.data.source());
            BpsJoinedSuffixBytes::Owned(joined)
        };

        progress.report_indexed(sorted_target_len);
        context.cancel().check()?;
        let suffix_array = SuffixArray::new(self.joined.as_slice());
        let (_, sorted) = suffix_array.into_parts();
        self.sorted = sorted;
        context.cancel().check()?;

        if self.index_mode == BpsSuffixIndexMode::FastReverse {
            let mut reverse = Vec::new();
            try_reserve_exact(&mut reverse, self.sorted.len(), "BPS suffix reverse index")?;
            reverse.resize(self.sorted.len(), 0u32);
            for (rank, &position) in self.sorted.iter().enumerate() {
                if rank % COPY_BUFFER_SIZE == 0 {
                    context.cancel().check()?;
                }
                reverse[position as usize] = u32::try_from(rank).map_err(|_| {
                    RomWeaverError::Validation("BPS suffix-array rank exceeded u32".into())
                })?;
            }
            self.reverse = reverse;
        }
        progress.report_indexed(sorted_target_len);
        Ok(())
    }

    fn find(&self, output_offset: usize) -> Result<BpsCreateMatch> {
        let rank = self.rank_for_output_offset(output_offset)?;
        let previous = self.nearest_legal(rank, -1, output_offset);
        let next = self.nearest_legal(rank, 1, output_offset);
        let mut best = BpsCreateMatch::default();

        for position in [previous, next].into_iter().flatten() {
            let candidate = self.match_at(position, output_offset);
            if candidate.len > best.len {
                best = candidate;
            }
        }

        Ok(best)
    }

    fn rank_for_output_offset(&self, output_offset: usize) -> Result<usize> {
        match self.index_mode {
            BpsSuffixIndexMode::FastReverse => Ok(self.reverse[output_offset] as usize),
            BpsSuffixIndexMode::LowMemory => self.find_suffix_rank(output_offset),
        }
    }

    fn find_suffix_rank(&self, output_offset: usize) -> Result<usize> {
        let bytes = self.joined.as_slice();
        let mut low = 0usize;
        let mut high = self.sorted.len();

        while low < high {
            let mid = low + (high - low) / 2;
            let position = self.sorted[mid] as usize;
            match compare_bps_suffixes(bytes, position, output_offset) {
                Ordering::Less => low = mid + 1,
                Ordering::Greater => high = mid,
                Ordering::Equal => return Ok(mid),
            }
        }

        Err(RomWeaverError::Validation(
            "BPS lower-memory suffix lookup lost the current target suffix".into(),
        ))
    }

    fn nearest_legal(&self, rank: usize, direction: isize, output_offset: usize) -> Option<usize> {
        let mut cursor = rank as isize + direction;
        while cursor >= 0 && (cursor as usize) < self.sorted.len() {
            let position = self.sorted[cursor as usize] as usize;
            if self.is_legal_match_position(position, output_offset) {
                return Some(position);
            }
            cursor += direction;
        }
        None
    }

    fn is_legal_match_position(&self, position: usize, output_offset: usize) -> bool {
        position < output_offset
            || (position >= self.sorted_target_len
                && position < self.sorted_target_len.saturating_add(self.data.source_len))
    }

    fn match_at(&self, position: usize, output_offset: usize) -> BpsCreateMatch {
        let target_remaining = self.sorted_target_len - output_offset;
        let (mut mode, offset, candidate_remaining) = if position < self.sorted_target_len {
            (
                BpsCreateMode::TargetCopy,
                position,
                self.sorted_target_len - position,
            )
        } else {
            let source_offset = position - self.sorted_target_len;
            let mode = if source_offset == output_offset {
                BpsCreateMode::SourceRead
            } else {
                BpsCreateMode::SourceCopy
            };
            (mode, source_offset, self.data.source_len - source_offset)
        };
        let len = common_prefix_len_limited(
            self.joined.as_slice(),
            output_offset,
            position,
            target_remaining.min(candidate_remaining),
        );
        if len == 0 {
            mode = BpsCreateMode::TargetRead;
        }
        BpsCreateMatch { mode, offset, len }
    }
}

#[derive(Default)]
struct BpsTargetReadBuffer {
    start: usize,
    len: usize,
}

impl BpsTargetReadBuffer {
    fn add(&mut self, offset: usize, len: usize) -> Result<()> {
        if self.len == 0 {
            self.start = offset;
        }
        self.len = self.len.checked_add(len).ok_or_else(|| {
            RomWeaverError::Validation("BPS target-read length overflowed".into())
        })?;
        Ok(())
    }

    fn flush(
        &mut self,
        writer: &mut BpsCreateWriter<'_, impl Write>,
        target: &[u8],
        created: &mut CreatedBpsPatch,
    ) -> Result<()> {
        if self.len == 0 {
            return Ok(());
        }
        let end = self
            .start
            .checked_add(self.len)
            .ok_or_else(|| RomWeaverError::Validation("BPS target-read range overflowed".into()))?;
        writer.write_target_read(&target[self.start..end])?;
        created.action_count = created.action_count.saturating_add(1);
        self.len = 0;
        Ok(())
    }
}

fn bps_create_match_is_worth(
    mode: BpsCreateMode,
    len: usize,
    offset: usize,
    output_offset: usize,
    source_relative_offset: i128,
    target_relative_offset: i128,
    pending_target_read_len: usize,
) -> Result<bool> {
    if mode == BpsCreateMode::TargetRead || len == 0 {
        return Ok(false);
    }

    match mode {
        BpsCreateMode::SourceRead if offset == output_offset => {
            let threshold = 1usize
                .checked_add(1)
                .and_then(|value| value.checked_add(usize::from(pending_target_read_len > 0)))
                .and_then(|value| value.checked_add(usize::from(len == 1)))
                .ok_or_else(|| {
                    RomWeaverError::Validation("BPS match threshold overflowed".into())
                })?;
            Ok(len >= threshold)
        }
        BpsCreateMode::SourceRead => Ok(false),
        BpsCreateMode::SourceCopy => {
            let delta = i128::try_from(offset)
                .map_err(|_| RomWeaverError::Validation("BPS source offset exceeded i128".into()))?
                .checked_sub(source_relative_offset)
                .ok_or_else(|| RomWeaverError::Validation("BPS source offset overflowed".into()))?;
            bps_create_copy_match_is_worth(len, delta, pending_target_read_len > 0)
        }
        BpsCreateMode::TargetCopy => {
            let delta = i128::try_from(offset)
                .map_err(|_| RomWeaverError::Validation("BPS target offset exceeded i128".into()))?
                .checked_sub(target_relative_offset)
                .ok_or_else(|| RomWeaverError::Validation("BPS target offset overflowed".into()))?;
            bps_create_copy_match_is_worth(len, delta, pending_target_read_len > 0)
        }
        BpsCreateMode::TargetRead => Ok(false),
    }
}

fn bps_create_copy_match_is_worth(
    len: usize,
    delta: i128,
    has_pending_target_read: bool,
) -> Result<bool> {
    let cost = 1usize
        .checked_add(bps_varint_len(encode_signed_offset(delta)?))
        .ok_or_else(|| RomWeaverError::Validation("BPS match cost overflowed".into()))?;
    let threshold = 1usize
        .checked_add(cost)
        .and_then(|value| value.checked_add(usize::from(has_pending_target_read)))
        .and_then(|value| value.checked_add(usize::from(len == 1)))
        .ok_or_else(|| RomWeaverError::Validation("BPS match threshold overflowed".into()))?;
    Ok(len >= threshold)
}

fn bps_varint_len(mut data: u64) -> usize {
    let mut len = 1usize;
    while data >= 128 {
        data >>= 7;
        data -= 1;
        len += 1;
    }
    len
}

fn bps_create_suffix_index_mode(source_len: u64, target_len: u64) -> Result<BpsSuffixIndexMode> {
    let fast_estimated = bps_create_estimated_suffix_memory_bytes(source_len, target_len)?;
    if fast_estimated <= u128::from(BPS_CREATE_MEMORY_LIMIT_BYTES) {
        return Ok(BpsSuffixIndexMode::FastReverse);
    }

    let low_memory_estimated =
        bps_create_estimated_low_memory_suffix_bytes(source_len, target_len)?;
    if low_memory_estimated <= u128::from(BPS_CREATE_MEMORY_LIMIT_BYTES) {
        return Ok(BpsSuffixIndexMode::LowMemory);
    }

    Err(RomWeaverError::Validation(format!(
        "BPS create requires an estimated {fast_estimated} bytes of fast suffix-index memory or {low_memory_estimated} bytes of lower-memory suffix-index memory; limit is {} bytes",
        BPS_CREATE_MEMORY_LIMIT_BYTES
    )))
}

fn bps_create_estimated_suffix_memory_bytes(source_len: u64, target_len: u64) -> Result<u128> {
    bps_create_estimated_suffix_memory_bytes_for_index(source_len, target_len, 8)
}

fn bps_create_estimated_low_memory_suffix_bytes(source_len: u64, target_len: u64) -> Result<u128> {
    bps_create_estimated_suffix_memory_bytes_for_index(source_len, target_len, 4)
}

fn bps_create_estimated_suffix_memory_bytes_for_index(
    source_len: u64,
    target_len: u64,
    index_bytes_per_slot: u128,
) -> Result<u128> {
    let total = u128::from(source_len)
        .checked_add(u128::from(target_len))
        .ok_or_else(|| RomWeaverError::Validation("BPS create input size overflowed".into()))?;
    let suffix_slots = total
        .checked_add(1)
        .ok_or_else(|| RomWeaverError::Validation("BPS suffix slot count overflowed".into()))?;
    let suffix_indexes = suffix_slots
        .checked_mul(index_bytes_per_slot)
        .ok_or_else(|| {
            RomWeaverError::Validation("BPS suffix memory estimate overflowed".into())
        })?;
    total
        .checked_add(suffix_indexes)
        .ok_or_else(|| RomWeaverError::Validation("BPS create memory estimate overflowed".into()))
}

fn read_bps_create_data(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
) -> Result<BpsCreateData> {
    let source_len = bps_create_usize_len(original_len, "source")?;
    let target_len = bps_create_usize_len(modified_len, "target")?;
    let total_len = source_len.checked_add(target_len).ok_or_else(|| {
        RomWeaverError::Validation("BPS create combined input size overflowed".into())
    })?;
    if total_len as u64 >= u64::from(BPS_NO_OFFSET) {
        return Err(RomWeaverError::Validation(
            "BPS create files are too large for copy-aware indexing".into(),
        ));
    }

    let mut bytes = Vec::new();
    try_reserve_exact(&mut bytes, total_len, "BPS create input")?;

    File::open(modified_path)?.read_to_end(&mut bytes)?;
    if bytes.len() != target_len {
        return Err(RomWeaverError::Validation(
            "BPS create target size changed during processing".into(),
        ));
    }
    File::open(original_path)?.read_to_end(&mut bytes)?;
    if bytes.len() != total_len {
        return Err(RomWeaverError::Validation(
            "BPS create source size changed during processing".into(),
        ));
    }

    Ok(BpsCreateData {
        bytes,
        target_len,
        source_len,
    })
}

fn bps_create_usize_len(expected_len: u64, label: &str) -> Result<usize> {
    let len = usize::try_from(expected_len).map_err(|_| {
        RomWeaverError::Validation(format!(
            "BPS create {label} file exceeded addressable memory"
        ))
    })?;
    if len as u64 >= u64::from(BPS_NO_OFFSET) {
        return Err(RomWeaverError::Validation(format!(
            "BPS create {label} file is too large for copy-aware indexing"
        )));
    }
    Ok(len)
}

fn try_reserve_exact<T>(vec: &mut Vec<T>, additional: usize, label: &str) -> Result<()> {
    vec.try_reserve_exact(additional)
        .map_err(|error| RomWeaverError::Validation(format!("{label} allocation failed: {error}")))
}

fn initial_bps_sorted_target_len(source_len: usize, target_len: usize) -> usize {
    let mut sorted_len = target_len;
    while sorted_len / 4 > source_len && sorted_len > 1024 {
        sorted_len >>= 2;
    }
    sorted_len
}

fn next_bps_sorted_target_len(output_offset: usize, sorted_len: usize, target_len: usize) -> usize {
    let mut next_len = sorted_len;
    while output_offset.saturating_add(BPS_CREATE_INDEX_TAIL_BYTES) >= next_len
        && next_len < target_len
    {
        next_len = next_len
            .checked_mul(4)
            .and_then(|value| value.checked_add(3))
            .unwrap_or(target_len)
            .min(target_len);
    }
    next_len
}

fn common_prefix_len(left: &[u8], left_offset: usize, right: &[u8], right_offset: usize) -> usize {
    if left_offset >= left.len() || right_offset >= right.len() {
        return 0;
    }
    let left = &left[left_offset..];
    let right = &right[right_offset..];
    let limit = left.len().min(right.len());
    let mut offset = 0usize;
    while offset + 8 <= limit {
        let diff = read_u64_le_unaligned(left, offset) ^ read_u64_le_unaligned(right, offset);
        if diff != 0 {
            return offset + (diff.trailing_zeros() as usize / 8);
        }
        offset += 8;
    }
    while offset < limit && left[offset] == right[offset] {
        offset += 1;
    }
    offset
}

fn common_prefix_len_limited(
    bytes: &[u8],
    left_offset: usize,
    right_offset: usize,
    limit: usize,
) -> usize {
    if left_offset >= bytes.len() || right_offset >= bytes.len() || limit == 0 {
        return 0;
    }
    let limit = limit
        .min(bytes.len() - left_offset)
        .min(bytes.len() - right_offset);
    let mut offset = 0usize;
    while offset + 8 <= limit {
        let diff = read_u64_le_unaligned(bytes, left_offset + offset)
            ^ read_u64_le_unaligned(bytes, right_offset + offset);
        if diff != 0 {
            return offset + (diff.trailing_zeros() as usize / 8);
        }
        offset += 8;
    }
    while offset < limit && bytes[left_offset + offset] == bytes[right_offset + offset] {
        offset += 1;
    }
    offset
}

fn compare_bps_suffixes(bytes: &[u8], left_offset: usize, right_offset: usize) -> Ordering {
    if left_offset == right_offset {
        return Ordering::Equal;
    }

    let left_len = bytes.len() - left_offset;
    let right_len = bytes.len() - right_offset;
    let limit = left_len.min(right_len);
    let common = common_prefix_len_limited(bytes, left_offset, right_offset, limit);
    if common == limit {
        return left_len.cmp(&right_len);
    }

    bytes[left_offset + common].cmp(&bytes[right_offset + common])
}

fn read_u64_le_unaligned(bytes: &[u8], offset: usize) -> u64 {
    debug_assert!(offset + 8 <= bytes.len());
    // The caller checks that eight bytes are available. Unaligned reads avoid copying
    // every candidate window while still preserving byte-order independent comparison.
    let value = unsafe { std::ptr::read_unaligned(bytes.as_ptr().add(offset).cast::<u64>()) };
    u64::from_le(value)
}

fn repeated_byte_run_len(bytes: &[u8], offset: usize) -> usize {
    let Some(&first) = bytes.get(offset) else {
        return 0;
    };
    let mut len = 1usize;
    while offset + len < bytes.len() && bytes[offset + len] == first {
        len += 1;
    }
    len
}

fn crc32_slice(bytes: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(bytes);
    hasher.finalize()
}

fn bps_apply_thread_capability(actions: &[BpsAction]) -> ThreadCapability {
    if patch_contains_target_copy(actions) {
        ThreadCapability::single_threaded()
    } else {
        ThreadCapability::parallel(None)
    }
}

fn patch_contains_target_copy(actions: &[BpsAction]) -> bool {
    actions
        .iter()
        .any(|action| matches!(action, BpsAction::TargetCopy { .. }))
}

fn collect_parallel_bps_write_plans(patch: &ParsedBpsPatch) -> Result<Vec<BpsWritePlan>> {
    let mut plans = Vec::with_capacity(patch.actions.len());
    let mut output_offset = 0u64;
    let mut source_relative_offset = 0i128;

    for action in &patch.actions {
        match action {
            BpsAction::SourceRead { length } => {
                let end = output_offset.checked_add(*length).ok_or_else(|| {
                    RomWeaverError::Validation("BPS source-read offset overflowed".into())
                })?;
                if end > patch.source_size {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceRead exceeded input size at output offset {output_offset}"
                    )));
                }
                plans.push(BpsWritePlan {
                    output_offset,
                    kind: BpsWritePlanKind::SourceRange {
                        source_offset: output_offset,
                        len: *length,
                    },
                });
                output_offset = end;
            }
            BpsAction::TargetRead { data } => {
                let data_len = u64::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation(
                        "BPS target-read data length exceeded addressable memory".into(),
                    )
                })?;
                let start = output_offset;
                output_offset = output_offset.checked_add(data_len).ok_or_else(|| {
                    RomWeaverError::Validation("BPS target-read output overflowed".into())
                })?;
                plans.push(BpsWritePlan {
                    output_offset: start,
                    kind: BpsWritePlanKind::Literal(data.clone()),
                });
            }
            BpsAction::SourceCopy {
                length,
                relative_offset,
            } => {
                let source_start = adjust_relative_offset(
                    source_relative_offset,
                    *relative_offset,
                    patch.source_size,
                    "source",
                )?;
                let source_end = source_start.checked_add(*length).ok_or_else(|| {
                    RomWeaverError::Validation("BPS source-copy length overflowed".into())
                })?;
                if source_end > patch.source_size {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceCopy exceeded input size at source offset {source_start}"
                    )));
                }
                plans.push(BpsWritePlan {
                    output_offset,
                    kind: BpsWritePlanKind::SourceRange {
                        source_offset: source_start,
                        len: *length,
                    },
                });
                source_relative_offset = i128::from(source_end);
                output_offset = output_offset.checked_add(*length).ok_or_else(|| {
                    RomWeaverError::Validation("BPS output offset overflowed".into())
                })?;
            }
            BpsAction::TargetCopy { .. } => {
                return Err(RomWeaverError::Validation(
                    "BPS TargetCopy actions require sequential apply".into(),
                ));
            }
        }

        if output_offset > patch.target_size {
            return Err(RomWeaverError::Validation(format!(
                "Output size invalid; Expected: {}, Actual: {output_offset}",
                patch.target_size
            )));
        }
    }

    if output_offset != patch.target_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {}, Actual: {output_offset}",
            patch.target_size
        )));
    }

    Ok(plans)
}

fn prepare_bps_writes_parallel(
    patch: &ParsedBpsPatch,
    source_path: &Path,
    source_len: u64,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedBpsWrite>> {
    let plans = collect_parallel_bps_write_plans(patch)?;
    let shared_source = Arc::new(SharedBlockCacheReader::open(
        source_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?);
    pool.install(|| {
        plans
            .par_iter()
            .map(|plan| {
                context.cancel().check()?;
                let data = match &plan.kind {
                    BpsWritePlanKind::Literal(data) => data.clone(),
                    BpsWritePlanKind::SourceRange { source_offset, len } => {
                        let range_len = usize::try_from(*len).map_err(|_| {
                            RomWeaverError::Validation(
                                "BPS source length exceeded addressable memory".into(),
                            )
                        })?;
                        let mut bytes = vec![0u8; range_len];
                        if *source_offset < source_len {
                            let readable = usize::try_from((source_len - *source_offset).min(*len))
                                .map_err(|_| {
                                    RomWeaverError::Validation(
                                        "BPS source readable length exceeded addressable memory"
                                            .into(),
                                    )
                                })?;
                            if readable > 0 {
                                read_parallel_bps_source_range(
                                    &shared_source,
                                    *source_offset,
                                    &mut bytes[..readable],
                                )?;
                            }
                        }
                        bytes
                    }
                };
                Ok(PreparedBpsWrite {
                    output_offset: plan.output_offset,
                    data,
                })
            })
            .collect::<Result<Vec<_>>>()
    })
}

fn read_parallel_bps_source_range(
    shared_source: &Arc<SharedBlockCacheReader>,
    source_offset: u64,
    output: &mut [u8],
) -> Result<()> {
    shared_source.read_exact_at(source_offset, output)
}

fn apply_prepared_bps_writes(output: &mut File, writes: &[PreparedBpsWrite]) -> Result<()> {
    // Writes are in ascending, contiguous output_offset order (no gaps) so seeks are only
    // needed when a write's offset diverges from the current file position (defensive).
    let mut writer = BufWriter::with_capacity(COPY_BUFFER_SIZE, output);
    let mut current_pos = 0u64;
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        if write.output_offset != current_pos {
            writer.seek(SeekFrom::Start(write.output_offset))?;
            current_pos = write.output_offset;
        }
        writer.write_all(&write.data)?;
        current_pos += write.data.len() as u64;
    }
    writer.flush()?;
    Ok(())
}

fn copy_target_range(
    output: &mut File,
    output_offset: &mut u64,
    start: u64,
    length: u64,
    progress: &mut BpsApplyProgress<'_>,
) -> Result<()> {
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    let mut remaining = length;
    let mut read_offset = start;

    while remaining > 0 {
        if read_offset >= *output_offset {
            return Err(RomWeaverError::Validation(format!(
                "TargetCopy referenced unavailable output at offset {read_offset}"
            )));
        }

        let available = *output_offset - read_offset;
        let chunk = remaining.min(available).min(buffer.len() as u64) as usize;
        output.seek(SeekFrom::Start(read_offset))?;
        output.read_exact(&mut buffer[..chunk])?;
        output.seek(SeekFrom::Start(*output_offset))?;
        output.write_all(&buffer[..chunk])?;

        remaining -= chunk as u64;
        read_offset += chunk as u64;
        *output_offset += chunk as u64;
        progress.report(*output_offset);
    }

    Ok(())
}

fn validate_input_file(
    source_path: &Path,
    source: &mut File,
    expected_size: u64,
    expected_checksum: u32,
    validate_checksum: bool,
    context: &OperationContext,
) -> Result<()> {
    let actual_size = source.seek(SeekFrom::End(0))?;
    if actual_size != expected_size {
        return Err(RomWeaverError::Validation(format!(
            "Input size invalid; Expected: {expected_size}, Actual: {actual_size}"
        )));
    }

    if !validate_checksum {
        source.seek(SeekFrom::Start(0))?;
        return Ok(());
    }

    let actual_checksum = crc32_path_cached(source_path, context)?;
    if actual_checksum != expected_checksum {
        return Err(RomWeaverError::Validation(format!(
            "Input checksum invalid; expected: {expected_checksum:x}, Actual: {actual_checksum:x}"
        )));
    }

    source.seek(SeekFrom::Start(0))?;
    Ok(())
}

fn validate_output_file(
    output_path: &Path,
    output: &mut File,
    expected_size: u64,
    expected_checksum: u32,
    validate_checksum: bool,
    context: &OperationContext,
) -> Result<()> {
    output.seek(SeekFrom::End(0))?;
    let actual_size = output.stream_position()?;
    if actual_size != expected_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {expected_size}, Actual: {actual_size}"
        )));
    }

    if !validate_checksum {
        return Ok(());
    }

    let actual_checksum = crc32_path_cached(output_path, context)?;
    if actual_checksum != expected_checksum {
        return Err(RomWeaverError::Validation(format!(
            "Output checksum invalid; expected: {expected_checksum:x}, Actual: {actual_checksum:x}"
        )));
    }

    Ok(())
}

fn adjust_relative_offset(current: i128, delta: i128, limit: u64, label: &str) -> Result<u64> {
    let next = current.checked_add(delta).ok_or_else(|| {
        RomWeaverError::Validation(format!("BPS {label} relative offset overflowed"))
    })?;
    if next < 0 {
        return Err(RomWeaverError::Validation(format!(
            "BPS {label} relative offset moved before the start of the file"
        )));
    }

    let next = u64::try_from(next).map_err(|_| {
        RomWeaverError::Validation(format!("BPS {label} relative offset exceeded u64"))
    })?;
    if next >= limit {
        return Err(RomWeaverError::Validation(format!(
            "BPS {label} relative offset exceeded available data"
        )));
    }

    Ok(next)
}

fn encode_signed_offset(delta: i128) -> Result<u64> {
    let magnitude = if delta < 0 {
        delta.checked_neg().ok_or_else(|| {
            RomWeaverError::Validation("BPS relative offset magnitude overflowed".into())
        })?
    } else {
        delta
    };

    let magnitude = u64::try_from(magnitude)
        .map_err(|_| RomWeaverError::Validation("BPS relative offset exceeded u64".into()))?;
    let shifted = magnitude.checked_shl(1).ok_or_else(|| {
        RomWeaverError::Validation("BPS relative offset exceeded encodable range".into())
    })?;
    Ok(shifted | u64::from(delta < 0))
}

fn decode_signed_offset(raw: u64) -> i128 {
    let magnitude = i128::from(raw >> 1);
    if raw & 1 != 0 { -magnitude } else { magnitude }
}

fn read_u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("u32 slice"))
}

fn crc32_path_cached(path: &Path, context: &OperationContext) -> Result<u32> {
    let results = checksum_file_values(path, &["crc32"], context)?;
    let Some(value) = results.get("crc32") else {
        return Err(RomWeaverError::Validation(
            "native checksum engine did not return crc32 result".into(),
        ));
    };
    u32::from_str_radix(value, 16).map_err(|error| {
        RomWeaverError::Validation(format!(
            "native checksum engine returned invalid crc32: {error}"
        ))
    })
}

fn read_bps_footer(path: &Path, footer_offset: u64) -> Result<[u8; BPS_FOOTER_SIZE]> {
    let mut footer = [0u8; BPS_FOOTER_SIZE];
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(footer_offset))?;
    file.read_exact(&mut footer)?;
    Ok(footer)
}

fn crc32_prefix(path: &Path, len: u64) -> Result<u32> {
    let mut file = BufReader::new(File::open(path)?);
    let mut hasher = Hasher::new();
    let mut remaining = len;
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    while remaining > 0 {
        let chunk_len = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| RomWeaverError::Validation("BPS checksum chunk exceeded usize".into()))?;
        file.read_exact(&mut buffer[..chunk_len])?;
        hasher.update(&buffer[..chunk_len]);
        remaining -= chunk_len as u64;
    }
    Ok(hasher.finalize())
}

#[cfg(test)]
fn push_varint(bytes: &mut Vec<u8>, mut data: u64) {
    loop {
        let value = (data & 0x7f) as u8;
        data >>= 7;
        if data == 0 {
            bytes.push(0x80 | value);
            break;
        }
        bytes.push(value);
        data -= 1;
    }
}

struct BpsCreateWriter<'a, W> {
    output: &'a mut W,
    patch_hasher: Hasher,
}

impl<'a, W: Write> BpsCreateWriter<'a, W> {
    fn new(output: &'a mut W) -> Self {
        Self {
            output,
            patch_hasher: Hasher::new(),
        }
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        self.output.write_all(bytes)?;
        self.patch_hasher.update(bytes);
        Ok(())
    }

    fn write_varint(&mut self, mut data: u64) -> Result<()> {
        let mut bytes = [0u8; 10];
        let mut len = 0usize;

        loop {
            let value = (data & 0x7f) as u8;
            data >>= 7;
            if data == 0 {
                bytes[len] = 0x80 | value;
                len += 1;
                break;
            }
            bytes[len] = value;
            len += 1;
            data -= 1;
        }

        self.write_bytes(&bytes[..len])
    }

    fn write_source_read(&mut self, length: u64) -> Result<()> {
        self.write_varint(encode_action_header(length, 0)?)
    }

    fn write_target_read(&mut self, data: &[u8]) -> Result<()> {
        let len = u64::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation("BPS target-read data exceeded u64 length".into())
        })?;
        self.write_varint(encode_action_header(len, 1)?)?;
        self.write_bytes(data)
    }

    fn write_source_copy(
        &mut self,
        length: u64,
        start: u64,
        source_relative_offset: &mut i128,
    ) -> Result<()> {
        self.write_varint(encode_action_header(length, 2)?)?;
        let delta = i128::from(start)
            .checked_sub(*source_relative_offset)
            .ok_or_else(|| RomWeaverError::Validation("BPS source delta overflowed".into()))?;
        self.write_varint(encode_signed_offset(delta)?)?;
        let end = start
            .checked_add(length)
            .ok_or_else(|| RomWeaverError::Validation("BPS source-copy end overflowed".into()))?;
        *source_relative_offset = i128::from(end);
        Ok(())
    }

    fn write_target_copy(
        &mut self,
        length: u64,
        start: u64,
        target_relative_offset: &mut i128,
    ) -> Result<()> {
        self.write_varint(encode_action_header(length, 3)?)?;
        let delta = i128::from(start)
            .checked_sub(*target_relative_offset)
            .ok_or_else(|| RomWeaverError::Validation("BPS target delta overflowed".into()))?;
        self.write_varint(encode_signed_offset(delta)?)?;
        let end = start
            .checked_add(length)
            .ok_or_else(|| RomWeaverError::Validation("BPS target-copy end overflowed".into()))?;
        *target_relative_offset = i128::from(end);
        Ok(())
    }

    fn finish(&mut self, source_checksum: u32, target_checksum: u32) -> Result<()> {
        self.write_bytes(&source_checksum.to_le_bytes())?;
        self.write_bytes(&target_checksum.to_le_bytes())?;
        let patch_checksum = std::mem::replace(&mut self.patch_hasher, Hasher::new()).finalize();
        self.output.write_all(&patch_checksum.to_le_bytes())?;
        Ok(())
    }
}

fn encode_action_header(length: u64, command: u64) -> Result<u64> {
    if length == 0 {
        return Err(RomWeaverError::Validation(
            "BPS cannot encode a zero-length action".into(),
        ));
    }

    let value = length
        .checked_sub(1)
        .ok_or_else(|| RomWeaverError::Validation("BPS action length underflowed".into()))?;
    let shifted = value.checked_shl(2).ok_or_else(|| {
        RomWeaverError::Validation("BPS action header exceeded encodable range".into())
    })?;
    shifted
        .checked_add(command)
        .ok_or_else(|| RomWeaverError::Validation("BPS action header overflowed".into()))
}

#[cfg(test)]
struct BpsParser<'a> {
    bytes: &'a [u8],
    offset: usize,
    end: usize,
}

#[cfg(test)]
impl<'a> BpsParser<'a> {
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
            .ok_or_else(|| RomWeaverError::Validation("BPS parser offset overflowed".into()))?;
        if end > self.end {
            return Err(RomWeaverError::Validation(
                "BPS patch ended unexpectedly while reading command data".into(),
            ));
        }

        let start = self.offset;
        self.offset = end;
        Ok(&self.bytes[start..end])
    }

    fn read_varint(&mut self) -> Result<u64> {
        let mut data = 0u64;
        let mut shift = 1u64;
        loop {
            let byte = u64::from(self.read_exact(1)?[0]);
            data = data.checked_add((byte & 0x7f) * shift).ok_or_else(|| {
                RomWeaverError::Validation("BPS varint overflowed available range".into())
            })?;
            if byte & 0x80 != 0 {
                return Ok(data);
            }
            shift = shift
                .checked_shl(7)
                .ok_or_else(|| RomWeaverError::Validation("BPS varint shift overflowed".into()))?;
            data = data.checked_add(shift).ok_or_else(|| {
                RomWeaverError::Validation("BPS varint overflowed available range".into())
            })?;
        }
    }
}

struct BpsFileParser<R> {
    reader: R,
    offset: u64,
    end: u64,
}

impl<R: Read> BpsFileParser<R> {
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
            .map_err(|_| RomWeaverError::Validation("BPS parser length overflowed u64".into()))?;
        let next = self
            .offset
            .checked_add(len_u64)
            .ok_or_else(|| RomWeaverError::Validation("BPS parser offset overflowed".into()))?;
        if next > self.end {
            return Err(RomWeaverError::Validation(
                "BPS patch ended unexpectedly while reading record data".into(),
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
        let mut data = 0u64;
        let mut shift = 1u64;
        loop {
            let byte = u64::from(self.read_u8()?);
            data = data.checked_add((byte & 0x7f) * shift).ok_or_else(|| {
                RomWeaverError::Validation("BPS varint overflowed available range".into())
            })?;
            if byte & 0x80 != 0 {
                return Ok(data);
            }

            shift = shift
                .checked_shl(7)
                .ok_or_else(|| RomWeaverError::Validation("BPS varint shift overflowed".into()))?;
            data = data.checked_add(shift).ok_or_else(|| {
                RomWeaverError::Validation("BPS varint overflowed available range".into())
            })?;
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/bps.rs"]
mod tests;
