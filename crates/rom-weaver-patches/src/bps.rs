use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
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
    OperationContext, OperationFamily, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence, Result,
    RomWeaverError, SharedBlockCacheReader, SharedThreadPool, ThreadCapability,
};
use serde_json::json;

const BPS_MAGIC: &[u8; 4] = b"BPS1";
const BPS_FOOTER_SIZE: usize = 12;
const COPY_BUFFER_SIZE: usize = 32 * 1024;
const CREATE_STREAM_BUFFER_SIZE: usize = 32 * 1024;
const RESYNC_LOOKAHEAD: usize = 4 * 1024;
const RESYNC_MATCH_LIMIT: usize = 64;
const MIN_RESYNC_MATCH: usize = 16;
const TARGET_READ_FLUSH_SIZE: usize = 16 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

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
        let thread_capability = bps_apply_thread_capability(patch.actions.len());
        let planned_execution = context.plan_threads(thread_capability.clone());
        let has_target_copy = patch_contains_target_copy(&patch.actions);
        let execution = if planned_execution.used_parallelism && !has_target_copy {
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
            apply_patch_actions(&patch, &mut source, &mut output)?;
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
        let (execution, pool) = context.build_pool(bps_create_thread_capability(modified_len))?;
        let source_checksum = crc32_path_cached(&request.original, context)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        let created = create_bps_patch_streaming(
            &request.original,
            original_len,
            source_checksum,
            &request.modified,
            modified_len,
            &pool,
            execution.used_parallelism,
            &mut output,
            context,
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
            threaded_diff: true,
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
enum ResyncKind {
    Insert,
    Delete,
}

#[derive(Clone, Copy, Debug)]
struct ResyncCandidate {
    kind: ResyncKind,
    skip: usize,
    match_len: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BpsDiffKind {
    Shared,
    Different,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BpsDiffRun {
    kind: BpsDiffKind,
    offset: u64,
    len: u64,
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

fn apply_patch_actions(patch: &ParsedBpsPatch, source: &mut File, output: &mut File) -> Result<()> {
    let mut output_offset = 0u64;
    let mut source_relative_offset = 0i128;
    let mut target_relative_offset = 0i128;

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
                copy_source_range(source, output, output_offset, &mut output_offset, *length)?;
            }
            BpsAction::TargetRead { data } => {
                append_bytes(output, &mut output_offset, data)?;
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
                copy_source_range(source, output, start, &mut output_offset, *length)?;
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
                copy_target_range(output, &mut output_offset, start, *length)?;
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

fn create_bps_patch_streaming(
    original_path: &Path,
    original_len: u64,
    source_checksum: u32,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
    output: &mut impl Write,
    context: &OperationContext,
) -> Result<CreatedBpsPatch> {
    if use_parallel_scan {
        return create_bps_patch_parallel(
            original_path,
            original_len,
            source_checksum,
            modified_path,
            modified_len,
            pool,
            output,
            context,
        );
    }

    let mut original = BufferedByteStream::new(BufReader::new(File::open(original_path)?));
    let mut modified = BufferedByteStream::new(BufReader::new(File::open(modified_path)?));
    let mut target_checksum = Hasher::new();
    let mut target_read = Vec::with_capacity(TARGET_READ_FLUSH_SIZE);
    let mut created = CreatedBpsPatch::default();
    let mut writer = BpsCreateWriter::new(output);
    let mut source_relative_offset = 0i128;

    writer.write_bytes(BPS_MAGIC)?;
    writer.write_varint(original_len)?;
    writer.write_varint(modified_len)?;
    writer.write_varint(0)?;

    while modified.has_byte()? {
        context.cancel().check()?;

        if original.position() == modified.position()
            && current_bytes_equal(&mut original, &mut modified)?
        {
            flush_target_read(&mut writer, &mut target_read, &mut created)?;
            let length = consume_shared_run(&mut original, &mut modified, &mut target_checksum)?;
            if length > 0 {
                writer.write_source_read(length)?;
                created.action_count += 1;
            }
            continue;
        }

        if current_bytes_equal(&mut original, &mut modified)? {
            flush_target_read(&mut writer, &mut target_read, &mut created)?;
            let start = original.position();
            let length = consume_shared_run(&mut original, &mut modified, &mut target_checksum)?;
            if length > 0 {
                writer.write_source_copy(length, start, &mut source_relative_offset)?;
                created.action_count += 1;
            }
            continue;
        }

        if !original.has_byte()? {
            drain_remaining_target(
                &mut modified,
                &mut target_read,
                &mut target_checksum,
                &mut writer,
                &mut created,
            )?;
            break;
        }

        match find_resync(&mut original, &mut modified)? {
            Some(ResyncCandidate {
                kind: ResyncKind::Delete,
                skip,
                ..
            }) => {
                original.advance(skip)?;
            }
            Some(ResyncCandidate {
                kind: ResyncKind::Insert,
                skip,
                ..
            }) => {
                append_target_read_bytes(
                    &mut modified,
                    skip,
                    &mut target_read,
                    &mut target_checksum,
                    &mut writer,
                    &mut created,
                )?;
            }
            None => {
                append_replacement_run_bytes(
                    &mut original,
                    &mut modified,
                    &mut target_read,
                    &mut target_checksum,
                    &mut writer,
                    &mut created,
                )?;
            }
        }
    }

    flush_target_read(&mut writer, &mut target_read, &mut created)?;
    writer.finish(source_checksum, target_checksum.finalize())?;
    Ok(created)
}

fn bps_apply_thread_capability(_action_count: usize) -> ThreadCapability {
    ThreadCapability::single_threaded()
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
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(write.output_offset))?;
        output.write_all(&write.data)?;
    }
    Ok(())
}

fn bps_create_thread_capability(modified_len: u64) -> ThreadCapability {
    let chunks = bps_create_chunk_count(modified_len).max(1);
    ThreadCapability::parallel(Some(chunks))
}

fn bps_create_chunk_count(modified_len: u64) -> usize {
    if modified_len == 0 {
        return 1;
    }
    let chunk_bytes = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunks = modified_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunks).unwrap_or(usize::MAX)
}

fn create_bps_patch_parallel(
    original_path: &Path,
    original_len: u64,
    source_checksum: u32,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
    output: &mut impl Write,
    context: &OperationContext,
) -> Result<CreatedBpsPatch> {
    if fs::metadata(modified_path)?.len() != modified_len {
        return Err(RomWeaverError::Validation(
            "BPS create modified size changed during processing".into(),
        ));
    }

    let mut writer = BpsCreateWriter::new(output);
    writer.write_bytes(BPS_MAGIC)?;
    writer.write_varint(original_len)?;
    writer.write_varint(modified_len)?;
    writer.write_varint(0)?;

    let runs = collect_bps_diff_runs_parallel(
        original_path,
        original_len,
        modified_path,
        modified_len,
        pool,
        context,
    )?;
    let target_checksum = crc32_path_cached(modified_path, context)?;
    let mut modified = BufReader::new(File::open(modified_path)?);
    let mut target_read_buffer = vec![0u8; TARGET_READ_FLUSH_SIZE];
    let mut created = CreatedBpsPatch::default();
    for run in runs {
        context.cancel().check()?;
        match run.kind {
            BpsDiffKind::Shared => {
                writer.write_source_read(run.len)?;
                created.action_count = created.action_count.saturating_add(1);
            }
            BpsDiffKind::Different => {
                let mut remaining = run.len;
                let mut read_offset = run.offset;
                while remaining > 0 {
                    let chunk_len = usize::try_from(remaining.min(TARGET_READ_FLUSH_SIZE as u64))
                        .map_err(|_| {
                        RomWeaverError::Validation(
                            "BPS diff run chunk exceeded addressable memory".into(),
                        )
                    })?;
                    modified.seek(SeekFrom::Start(read_offset))?;
                    modified.read_exact(&mut target_read_buffer[..chunk_len])?;
                    writer.write_target_read(&target_read_buffer[..chunk_len])?;
                    created.action_count = created.action_count.saturating_add(1);
                    read_offset = checked_add(
                        read_offset,
                        u64::try_from(chunk_len).expect("chunk len fits u64"),
                        "BPS target-read offset",
                    )?;
                    remaining = remaining.saturating_sub(chunk_len as u64);
                }
            }
        }
    }

    writer.finish(source_checksum, target_checksum)?;
    Ok(created)
}

fn collect_bps_diff_runs_parallel(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<BpsDiffRun>> {
    if modified_len == 0 {
        return Ok(Vec::new());
    }
    let chunk_size = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let ranges = (0..modified_len)
        .step_by(CREATE_THREAD_SCAN_CHUNK_BYTES)
        .map(|start| {
            let end = start.saturating_add(chunk_size).min(modified_len);
            start..end
        })
        .collect::<Vec<_>>();

    let per_chunk = pool.install(|| {
        ranges
            .into_par_iter()
            .map(|range| {
                context.cancel().check()?;
                collect_bps_diff_runs_for_range(
                    original_path,
                    original_len,
                    modified_path,
                    range.start,
                    range.end,
                )
            })
            .collect::<Vec<Result<Vec<BpsDiffRun>>>>()
    });

    let mut merged: Vec<BpsDiffRun> = Vec::new();
    for runs in per_chunk {
        let runs = runs?;
        for run in runs {
            if let Some(last) = merged.last_mut() {
                let contiguous = last
                    .offset
                    .checked_add(last.len)
                    .is_some_and(|end| end == run.offset);
                if contiguous && last.kind == run.kind {
                    last.len = last.len.saturating_add(run.len);
                    continue;
                }
            }
            merged.push(run);
        }
    }
    Ok(merged)
}

fn collect_bps_diff_runs_for_range(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    start: u64,
    end: u64,
) -> Result<Vec<BpsDiffRun>> {
    let mut original = File::open(original_path)?;
    let mut modified = File::open(modified_path)?;
    if start < original_len {
        original.seek(SeekFrom::Start(start))?;
    }
    modified.seek(SeekFrom::Start(start))?;
    let mut original_buffer = vec![0u8; CREATE_STREAM_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; CREATE_STREAM_BUFFER_SIZE];
    let mut runs = Vec::new();
    let mut current_kind: Option<BpsDiffKind> = None;
    let mut run_start = start;
    let mut run_len = 0u64;
    let mut absolute = start;

    while absolute < end {
        let chunk_len = usize::try_from((end - absolute).min(CREATE_STREAM_BUFFER_SIZE as u64))
            .map_err(|_| {
                RomWeaverError::Validation("BPS compare chunk exceeded addressable memory".into())
            })?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        let original_chunk_len = if absolute >= original_len {
            0
        } else {
            usize::try_from((original_len - absolute).min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("BPS source chunk exceeded addressable memory".into())
            })?
        };
        if original_chunk_len > 0 {
            original.read_exact(&mut original_buffer[..original_chunk_len])?;
        }
        if original_chunk_len < chunk_len {
            original_buffer[original_chunk_len..chunk_len].fill(0);
        }

        for index in 0..chunk_len {
            let kind = if original_buffer[index] == modified_buffer[index] {
                BpsDiffKind::Shared
            } else {
                BpsDiffKind::Different
            };

            if current_kind == Some(kind) {
                run_len = run_len.saturating_add(1);
                absolute = checked_add(absolute, 1, "BPS chunk scan offset")?;
                continue;
            }

            if let Some(previous) = current_kind {
                runs.push(BpsDiffRun {
                    kind: previous,
                    offset: run_start,
                    len: run_len,
                });
            }
            current_kind = Some(kind);
            run_start = absolute;
            run_len = 1;
            absolute = checked_add(absolute, 1, "BPS chunk scan offset")?;
        }
    }

    if let Some(kind) = current_kind {
        runs.push(BpsDiffRun {
            kind,
            offset: run_start,
            len: run_len,
        });
    }
    Ok(runs)
}

fn current_bytes_equal(
    original: &mut BufferedByteStream<impl Read>,
    modified: &mut BufferedByteStream<impl Read>,
) -> Result<bool> {
    match (original.peek(0)?, modified.peek(0)?) {
        (Some(left), Some(right)) => Ok(left == right),
        _ => Ok(false),
    }
}

fn consume_shared_run(
    original: &mut BufferedByteStream<impl Read>,
    modified: &mut BufferedByteStream<impl Read>,
    target_checksum: &mut Hasher,
) -> Result<u64> {
    let mut consumed = 0u64;

    loop {
        original.fill_at_least(1)?;
        modified.fill_at_least(1)?;

        let original_slice = original.available_slice();
        let modified_slice = modified.available_slice();
        if original_slice.is_empty() || modified_slice.is_empty() {
            break;
        }

        let limit = original_slice.len().min(modified_slice.len());
        let mut prefix = 0usize;
        while prefix < limit && original_slice[prefix] == modified_slice[prefix] {
            prefix += 1;
        }

        if prefix == 0 {
            break;
        }

        target_checksum.update(&modified_slice[..prefix]);
        original.advance(prefix)?;
        modified.advance(prefix)?;
        consumed = consumed
            .checked_add(prefix as u64)
            .ok_or_else(|| RomWeaverError::Validation("BPS create run overflowed".into()))?;

        if prefix < limit {
            break;
        }
    }

    Ok(consumed)
}

fn find_resync(
    original: &mut BufferedByteStream<impl Read>,
    modified: &mut BufferedByteStream<impl Read>,
) -> Result<Option<ResyncCandidate>> {
    let mut best = None;

    for skip in 1..=RESYNC_LOOKAHEAD {
        if let Some(match_len) = resync_match_len(original, skip, modified, 0)? {
            best = choose_resync(
                best,
                ResyncCandidate {
                    kind: ResyncKind::Delete,
                    skip,
                    match_len,
                },
            );
        }

        if let Some(match_len) = resync_match_len(original, 0, modified, skip)? {
            best = choose_resync(
                best,
                ResyncCandidate {
                    kind: ResyncKind::Insert,
                    skip,
                    match_len,
                },
            );
        }
    }

    Ok(best)
}

fn choose_resync(
    current: Option<ResyncCandidate>,
    candidate: ResyncCandidate,
) -> Option<ResyncCandidate> {
    match current {
        None => Some(candidate),
        Some(existing)
            if candidate.skip < existing.skip
                || (candidate.skip == existing.skip
                    && candidate.match_len > existing.match_len)
                || (candidate.skip == existing.skip
                    && candidate.match_len == existing.match_len
                    && candidate.kind == ResyncKind::Delete
                    && existing.kind == ResyncKind::Insert) =>
        {
            Some(candidate)
        }
        Some(existing) => Some(existing),
    }
}

fn resync_match_len(
    original: &mut BufferedByteStream<impl Read>,
    original_skip: usize,
    modified: &mut BufferedByteStream<impl Read>,
    modified_skip: usize,
) -> Result<Option<usize>> {
    let matched = common_prefix_len(
        original,
        original_skip,
        modified,
        modified_skip,
        RESYNC_MATCH_LIMIT,
    )?;
    if matched >= MIN_RESYNC_MATCH {
        return Ok(Some(matched));
    }
    if matched == 0 {
        return Ok(None);
    }

    let next_original = original.peek(original_skip + matched)?;
    let next_modified = modified.peek(modified_skip + matched)?;
    if next_original.is_none() || next_modified.is_none() {
        Ok(Some(matched))
    } else {
        Ok(None)
    }
}

fn common_prefix_len(
    original: &mut BufferedByteStream<impl Read>,
    original_skip: usize,
    modified: &mut BufferedByteStream<impl Read>,
    modified_skip: usize,
    limit: usize,
) -> Result<usize> {
    let mut matched = 0usize;
    while matched < limit {
        match (
            original.peek(original_skip + matched)?,
            modified.peek(modified_skip + matched)?,
        ) {
            (Some(left), Some(right)) if left == right => matched += 1,
            _ => break,
        }
    }
    Ok(matched)
}

fn append_replacement_run_bytes(
    original: &mut BufferedByteStream<impl Read>,
    modified: &mut BufferedByteStream<impl Read>,
    target_read: &mut Vec<u8>,
    target_checksum: &mut Hasher,
    writer: &mut BpsCreateWriter<'_, impl Write>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    loop {
        original.fill_at_least(1)?;
        modified.fill_at_least(1)?;
        let original_slice = original.available_slice();
        let modified_slice = modified.available_slice();
        if modified_slice.is_empty() {
            return Ok(());
        }
        if original_slice.is_empty() {
            drain_remaining_target(modified, target_read, target_checksum, writer, created)?;
            return Ok(());
        }

        let limit = original_slice.len().min(modified_slice.len());
        let mut diff_len = 0usize;
        while diff_len < limit && original_slice[diff_len] != modified_slice[diff_len] {
            diff_len += 1;
        }
        if diff_len == 0 {
            return Ok(());
        }

        append_target_read_slice(
            &modified_slice[..diff_len],
            target_read,
            target_checksum,
            writer,
            created,
        )?;
        original.advance(diff_len)?;
        modified.advance(diff_len)?;

        if diff_len < limit {
            return Ok(());
        }
    }
}

fn append_target_read_slice(
    data: &[u8],
    target_read: &mut Vec<u8>,
    target_checksum: &mut Hasher,
    writer: &mut BpsCreateWriter<'_, impl Write>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    let mut consumed = 0usize;
    while consumed < data.len() {
        let free = TARGET_READ_FLUSH_SIZE.saturating_sub(target_read.len());
        let chunk = (data.len() - consumed).min(free.max(1));
        let end = consumed + chunk;
        target_checksum.update(&data[consumed..end]);
        target_read.extend_from_slice(&data[consumed..end]);
        consumed = end;

        if target_read.len() >= TARGET_READ_FLUSH_SIZE {
            flush_target_read(writer, target_read, created)?;
        }
    }
    Ok(())
}

fn append_target_read_bytes(
    modified: &mut BufferedByteStream<impl Read>,
    len: usize,
    target_read: &mut Vec<u8>,
    target_checksum: &mut Hasher,
    writer: &mut BpsCreateWriter<'_, impl Write>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    let mut remaining = len;
    while remaining > 0 {
        modified.fill_at_least(1)?;
        let available = modified.available_slice();
        if available.is_empty() {
            return Err(RomWeaverError::Validation(
                "Modified file ended unexpectedly while building BPS patch".into(),
            ));
        }

        let free = TARGET_READ_FLUSH_SIZE.saturating_sub(target_read.len());
        let chunk = remaining.min(available.len()).min(free.max(1));
        target_checksum.update(&available[..chunk]);
        target_read.extend_from_slice(&available[..chunk]);
        modified.advance(chunk)?;
        remaining -= chunk;

        if target_read.len() >= TARGET_READ_FLUSH_SIZE {
            flush_target_read(writer, target_read, created)?;
        }
    }
    Ok(())
}

fn drain_remaining_target(
    modified: &mut BufferedByteStream<impl Read>,
    target_read: &mut Vec<u8>,
    target_checksum: &mut Hasher,
    writer: &mut BpsCreateWriter<'_, impl Write>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    while modified.has_byte()? {
        let available = modified.available_slice();
        if available.is_empty() {
            break;
        }

        let free = TARGET_READ_FLUSH_SIZE.saturating_sub(target_read.len());
        let chunk = available.len().min(free.max(1));
        target_checksum.update(&available[..chunk]);
        target_read.extend_from_slice(&available[..chunk]);
        modified.advance(chunk)?;

        if target_read.len() >= TARGET_READ_FLUSH_SIZE {
            flush_target_read(writer, target_read, created)?;
        }
    }
    Ok(())
}

fn flush_target_read(
    writer: &mut BpsCreateWriter<'_, impl Write>,
    target_read: &mut Vec<u8>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    if target_read.is_empty() {
        return Ok(());
    }

    writer.write_target_read(target_read)?;
    created.action_count += 1;
    target_read.clear();
    Ok(())
}

fn copy_source_range(
    source: &mut File,
    output: &mut File,
    source_offset: u64,
    output_offset: &mut u64,
    length: u64,
) -> Result<()> {
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    let mut remaining = length;
    source.seek(SeekFrom::Start(source_offset))?;
    output.seek(SeekFrom::Start(*output_offset))?;

    while remaining > 0 {
        let chunk = remaining.min(buffer.len() as u64) as usize;
        source.read_exact(&mut buffer[..chunk])?;
        output.write_all(&buffer[..chunk])?;
        remaining -= chunk as u64;
        *output_offset += chunk as u64;
    }

    Ok(())
}

fn append_bytes(output: &mut File, output_offset: &mut u64, data: &[u8]) -> Result<()> {
    output.seek(SeekFrom::Start(*output_offset))?;
    output.write_all(data)?;
    *output_offset = output_offset
        .checked_add(data.len() as u64)
        .ok_or_else(|| RomWeaverError::Validation("BPS output offset overflowed".into()))?;
    Ok(())
}

fn copy_target_range(
    output: &mut File,
    output_offset: &mut u64,
    start: u64,
    length: u64,
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

struct BufferedByteStream<R> {
    reader: R,
    buffer: Vec<u8>,
    start: usize,
    end: usize,
    eof: bool,
    position: u64,
}

impl<R: Read> BufferedByteStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: vec![0u8; CREATE_STREAM_BUFFER_SIZE],
            start: 0,
            end: 0,
            eof: false,
            position: 0,
        }
    }

    fn position(&self) -> u64 {
        self.position
    }

    fn available_len(&self) -> usize {
        self.end - self.start
    }

    fn available_slice(&self) -> &[u8] {
        &self.buffer[self.start..self.end]
    }

    fn has_byte(&mut self) -> io::Result<bool> {
        self.fill_at_least(1)?;
        Ok(self.available_len() > 0)
    }

    fn peek(&mut self, offset: usize) -> io::Result<Option<u8>> {
        self.fill_at_least(offset.saturating_add(1))?;
        if offset < self.available_len() {
            Ok(Some(self.buffer[self.start + offset]))
        } else {
            Ok(None)
        }
    }

    fn advance(&mut self, count: usize) -> io::Result<()> {
        let mut remaining = count;
        while remaining > 0 {
            self.fill_at_least(1)?;
            let available = self.available_len();
            if available == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stream ended unexpectedly while advancing",
                ));
            }

            let chunk = remaining.min(available);
            self.start += chunk;
            self.position += chunk as u64;
            remaining -= chunk;

            if self.start == self.end {
                self.start = 0;
                self.end = 0;
            }
        }

        Ok(())
    }

    fn fill_at_least(&mut self, min_bytes: usize) -> io::Result<()> {
        if min_bytes > self.buffer.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "requested BPS lookahead exceeded the streaming buffer",
            ));
        }

        while self.available_len() < min_bytes && !self.eof {
            if self.start > 0 {
                let len = self.available_len();
                self.buffer.copy_within(self.start..self.end, 0);
                self.start = 0;
                self.end = len;
            }

            let bytes_read = self.reader.read(&mut self.buffer[self.end..])?;
            if bytes_read == 0 {
                self.eof = true;
                break;
            }
            self.end += bytes_read;
        }

        Ok(())
    }
}

fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
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
