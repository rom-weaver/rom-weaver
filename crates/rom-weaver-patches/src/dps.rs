use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use memmap2::{Mmap, MmapOptions};
use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability, ValidationCodeError,
};

const DPS_TEXT_FIELD_BYTES: usize = 64;
const DPS_HEADER_BYTES: usize = (DPS_TEXT_FIELD_BYTES * 3) + 1 + 1 + 4;
const DPS_PATCH_VERSION: u8 = 1;

const DPS_RECORD_COPY_FROM_SOURCE: u8 = 0;
const DPS_RECORD_EMBEDDED_DATA: u8 = 1;
const DPS_IO_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

const DEFAULT_PATCH_AUTHOR: &str = "rom-weaver";
const DEFAULT_PATCH_VERSION_TEXT: &str = "1";

fn dps_validation_code(code: &'static str) -> ValidationCodeError {
    ValidationCodeError::new(code)
}

pub struct DpsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl DpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for DpsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = map_file_read_only(patch_path)?;
        let parsed = parse_dps_bytes(patch.as_ref(), DpsParseMode::Strict)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch `{}` by `{}` (v{}) with {} record(s): {} copy / {} data; source {} byte(s), output {} byte(s), flag {}",
                self.descriptor.name,
                parsed.patch_name,
                parsed.patch_author,
                parsed.patch_version_text,
                parsed.records.len(),
                parsed.copy_record_count,
                parsed.data_record_count,
                parsed.source_size,
                parsed.output_size,
                parsed.patch_flag
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
        let validate_source_size =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let parse_mode = if validate_source_size {
            DpsParseMode::Strict
        } else {
            DpsParseMode::WarnAndStopOnMalformedRecord
        };
        let patch = map_file_read_only(patch_path)?;
        let parsed = parse_dps_bytes(patch.as_ref(), parse_mode)?;
        let source_len_u64 = fs::metadata(&request.input)?.len();
        let source_len = usize::try_from(source_len_u64).map_err(|_| {
            RomWeaverError::ValidationCode(
                dps_validation_code("DPS_SOURCE_INPUT_EXCEEDED_ADDRESSABLE_MEMORY")
                    .with_message("DPS source input exceeded addressable memory")
                    .with_field("format", self.descriptor.name)
                    .with_field("source_len", source_len_u64),
            )
        })?;
        let source_len_u32 = u32::try_from(source_len_u64).map_err(|_| {
            RomWeaverError::ValidationCode(
                dps_validation_code("DPS_SOURCE_INPUT_EXCEEDED_U32_MAX")
                    .with_message("DPS source input exceeded maximum supported size")
                    .with_field("format", self.descriptor.name)
                    .with_field("source_len", source_len_u64)
                    .with_field("max_supported", u32::MAX),
            )
        })?;
        if validate_source_size && source_len_u32 != parsed.source_size {
            return Err(RomWeaverError::ValidationCode(
                dps_validation_code("DPS_SOURCE_SIZE_MISMATCH")
                    .with_message("DPS source size mismatch")
                    .with_field("format", self.descriptor.name)
                    .with_field("expected", parsed.source_size)
                    .with_field("actual", source_len_u32),
            ));
        }

        let output_len = usize::try_from(parsed.output_size).map_err(|_| {
            RomWeaverError::ValidationCode(
                dps_validation_code("DPS_OUTPUT_SIZE_EXCEEDED_ADDRESSABLE_MEMORY")
                    .with_message("DPS output size exceeded addressable memory")
                    .with_field("format", self.descriptor.name)
                    .with_field("output_size", parsed.output_size),
            )
        })?;
        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&request.output)?;
        output.set_len(parsed.output_size)?;
        let thread_capability = dps_apply_thread_capability(parsed.records.len());
        let planned_execution = context.plan_threads(thread_capability.clone());
        let execution = if planned_execution.used_parallelism {
            let source = map_file_read_only(&request.input)?;
            let (execution, pool) = context.build_pool(thread_capability)?;
            let prepared = prepare_dps_writes_parallel(
                &parsed.records,
                source.as_ref(),
                source_len,
                output_len,
                &pool,
                context,
            )?;
            apply_prepared_dps_writes(&mut output, &prepared)?;
            execution
        } else {
            let mut source = File::open(&request.input)?;
            apply_dps_records_in_place(
                &parsed.records,
                source_len,
                output_len,
                &mut source,
                &mut output,
            )?;
            planned_execution
        };
        output.flush()?;

        let checksum_suffix = if validate_source_size {
            String::new()
        } else {
            "; checksum validation skipped".to_string()
        };
        let malformed_warning_suffix = parsed
            .malformed_record_warning
            .as_deref()
            .map(|warning| format!("; warning={warning}"))
            .unwrap_or_default();
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} record(s): {} copy / {} data{}{}",
                self.descriptor.name,
                parsed.records.len(),
                parsed.copy_record_count,
                parsed.data_record_count,
                checksum_suffix,
                malformed_warning_suffix
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
        let source_len = fs::metadata(&request.original)?.len();
        let source_size = u32::try_from(source_len).map_err(|_| {
            RomWeaverError::ValidationCode(
                dps_validation_code("DPS_CREATE_SOURCE_EXCEEDED_U32_MAX")
                    .with_message("DPS create does not support oversized sources")
                    .with_field("format", self.descriptor.name)
                    .with_field("source_len", source_len)
                    .with_field("max_supported", u32::MAX),
            )
        })?;
        let target_len = fs::metadata(&request.modified)?.len();
        let (execution, pool) = context.build_pool(dps_create_thread_capability(target_len))?;

        let records = create_dps_records(
            &request.original,
            &request.modified,
            &pool,
            execution.used_parallelism,
        )?;
        let patch_name = request
            .output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("rom-weaver.dps");
        let patch_bytes = encode_dps_patch(
            &records,
            DpsHeaderMetadata {
                patch_name,
                patch_author: DEFAULT_PATCH_AUTHOR,
                patch_version_text: DEFAULT_PATCH_VERSION_TEXT,
                patch_flag: 0,
            },
            source_size,
        )?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &patch_bytes)?;

        let copy_record_count = records
            .iter()
            .filter(|record| matches!(record, DpsRecord::CopyFromSource { .. }))
            .count();
        let data_record_count = records.len().saturating_sub(copy_record_count);

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s): {} copy / {} data",
                self.descriptor.name,
                records.len(),
                copy_record_count,
                data_record_count
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

fn dps_apply_thread_capability(record_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(record_count.max(1)))
}

fn dps_create_thread_capability(target_len: u64) -> ThreadCapability {
    let chunk_count = dps_create_chunk_count(target_len).max(1);
    ThreadCapability::parallel(Some(chunk_count))
}

fn dps_create_chunk_count(target_len: u64) -> usize {
    if target_len == 0 {
        return 1;
    }
    let chunk_bytes = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_count = target_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).unwrap_or(usize::MAX)
}

#[derive(Clone, Debug)]
struct ParsedDpsPatch<'a> {
    patch_name: String,
    patch_author: String,
    patch_version_text: String,
    patch_flag: u8,
    source_size: u32,
    output_size: u64,
    copy_record_count: usize,
    data_record_count: usize,
    records: Vec<ParsedDpsRecord<'a>>,
    malformed_record_warning: Option<String>,
}

#[derive(Clone, Debug)]
enum DpsRecord {
    CopyFromSource {
        output_offset: u32,
        source_offset: u32,
        length: u32,
    },
    EmbeddedData {
        output_offset: u32,
        data: Vec<u8>,
    },
}

#[derive(Clone, Debug)]
enum ParsedDpsRecord<'a> {
    CopyFromSource {
        output_offset: u32,
        source_offset: u32,
        length: u32,
    },
    EmbeddedData {
        output_offset: u32,
        data: &'a [u8],
    },
}

impl ParsedDpsRecord<'_> {
    fn output_end(&self) -> Result<u64> {
        match self {
            ParsedDpsRecord::CopyFromSource {
                output_offset,
                length,
                ..
            } => u64::from(*output_offset)
                .checked_add(u64::from(*length))
                .ok_or_else(|| RomWeaverError::Validation("DPS output range overflowed".into())),
            ParsedDpsRecord::EmbeddedData {
                output_offset,
                data,
            } => u64::from(*output_offset)
                .checked_add(u64::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation(
                        "DPS embedded record length exceeded 64-bit range".into(),
                    )
                })?)
                .ok_or_else(|| RomWeaverError::Validation("DPS output range overflowed".into())),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct DpsHeaderMetadata<'a> {
    patch_name: &'a str,
    patch_author: &'a str,
    patch_version_text: &'a str,
    patch_flag: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DpsParseMode {
    Strict,
    WarnAndStopOnMalformedRecord,
}

fn map_file_read_only(path: &Path) -> Result<Mmap> {
    let file = File::open(path)?;
    // SAFETY: This mapping is read-only and the file handle lives through map creation.
    let map = unsafe { MmapOptions::new().map(&file)? };
    Ok(map)
}

fn parse_dps_bytes<'a>(bytes: &'a [u8], mode: DpsParseMode) -> Result<ParsedDpsPatch<'a>> {
    if bytes.len() < DPS_HEADER_BYTES {
        return Err(RomWeaverError::ValidationCode(
            dps_validation_code("DPS_PATCH_HEADER_TOO_SMALL")
                .with_field("expected_min_bytes", DPS_HEADER_BYTES)
                .with_field("found_bytes", bytes.len()),
        ));
    }

    let patch_name = parse_text_field(&bytes[0..DPS_TEXT_FIELD_BYTES]);
    let patch_author = parse_text_field(&bytes[DPS_TEXT_FIELD_BYTES..DPS_TEXT_FIELD_BYTES * 2]);
    let patch_version_text =
        parse_text_field(&bytes[DPS_TEXT_FIELD_BYTES * 2..DPS_TEXT_FIELD_BYTES * 3]);
    let patch_flag = bytes[DPS_TEXT_FIELD_BYTES * 3];

    let version = bytes[(DPS_TEXT_FIELD_BYTES * 3) + 1];
    if version != DPS_PATCH_VERSION {
        return Err(RomWeaverError::ValidationCode(
            dps_validation_code("DPS_PATCH_VERSION_UNSUPPORTED")
                .with_message("DPS patch version is not supported")
                .with_field("found_version", version)
                .with_field("expected_version", DPS_PATCH_VERSION),
        ));
    }

    let source_size_offset = (DPS_TEXT_FIELD_BYTES * 3) + 2;
    let source_size = u32::from_le_bytes([
        bytes[source_size_offset],
        bytes[source_size_offset + 1],
        bytes[source_size_offset + 2],
        bytes[source_size_offset + 3],
    ]);

    let mut cursor = DPS_HEADER_BYTES;
    let mut records = Vec::new();
    let mut output_size = 0u64;
    let mut copy_record_count = 0usize;
    let mut data_record_count = 0usize;
    let mut malformed_record_warning = None;
    while cursor < bytes.len() {
        let record_start = cursor;
        let mode_byte = match read_u8(bytes, &mut cursor, "DPS record mode") {
            Ok(value) => value,
            Err(error) if mode == DpsParseMode::WarnAndStopOnMalformedRecord => {
                malformed_record_warning = Some(format!(
                    "ignored malformed DPS record at byte offset {record_start}: {error}"
                ));
                break;
            }
            Err(error) => return Err(error),
        };
        let output_offset = match read_u32_le(bytes, &mut cursor, "DPS output offset") {
            Ok(value) => value,
            Err(error) if mode == DpsParseMode::WarnAndStopOnMalformedRecord => {
                malformed_record_warning = Some(format!(
                    "ignored malformed DPS record at byte offset {record_start}: {error}"
                ));
                break;
            }
            Err(error) => return Err(error),
        };

        let record = match mode_byte {
            DPS_RECORD_COPY_FROM_SOURCE => {
                let source_offset = match read_u32_le(bytes, &mut cursor, "DPS source offset") {
                    Ok(value) => value,
                    Err(error) if mode == DpsParseMode::WarnAndStopOnMalformedRecord => {
                        malformed_record_warning = Some(format!(
                            "ignored malformed DPS record at byte offset {record_start}: {error}"
                        ));
                        break;
                    }
                    Err(error) => return Err(error),
                };
                let length = match read_u32_le(bytes, &mut cursor, "DPS source length") {
                    Ok(value) => value,
                    Err(error) if mode == DpsParseMode::WarnAndStopOnMalformedRecord => {
                        malformed_record_warning = Some(format!(
                            "ignored malformed DPS record at byte offset {record_start}: {error}"
                        ));
                        break;
                    }
                    Err(error) => return Err(error),
                };
                copy_record_count = copy_record_count.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("DPS record count overflowed".into())
                })?;
                ParsedDpsRecord::CopyFromSource {
                    output_offset,
                    source_offset,
                    length,
                }
            }
            DPS_RECORD_EMBEDDED_DATA => {
                let length = match read_u32_le(bytes, &mut cursor, "DPS embedded data length") {
                    Ok(value) => value,
                    Err(error) if mode == DpsParseMode::WarnAndStopOnMalformedRecord => {
                        malformed_record_warning = Some(format!(
                            "ignored malformed DPS record at byte offset {record_start}: {error}"
                        ));
                        break;
                    }
                    Err(error) => return Err(error),
                };
                let length_usize = usize::try_from(length).map_err(|_| {
                    RomWeaverError::Validation(
                        "DPS embedded data length exceeded addressable memory".into(),
                    )
                })?;
                let data = match read_exact(
                    bytes,
                    &mut cursor,
                    length_usize,
                    "DPS embedded record payload",
                ) {
                    Ok(value) => value,
                    Err(error) if mode == DpsParseMode::WarnAndStopOnMalformedRecord => {
                        malformed_record_warning = Some(format!(
                            "ignored malformed DPS record at byte offset {record_start}: {error}"
                        ));
                        break;
                    }
                    Err(error) => return Err(error),
                };
                data_record_count = data_record_count.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("DPS record count overflowed".into())
                })?;
                ParsedDpsRecord::EmbeddedData {
                    output_offset,
                    data,
                }
            }
            _ => {
                if mode == DpsParseMode::WarnAndStopOnMalformedRecord {
                    malformed_record_warning = Some(format!(
                        "ignored malformed DPS record at byte offset {record_start}: DPS record mode {mode_byte} is not supported"
                    ));
                    break;
                }
                return Err(RomWeaverError::ValidationCode(
                    dps_validation_code("DPS_RECORD_MODE_UNSUPPORTED")
                        .with_message("DPS record mode is not supported")
                        .with_field("record_offset", record_start)
                        .with_field("mode", mode_byte),
                ));
            }
        };

        output_size = output_size.max(record.output_end()?);
        records.push(record);
    }

    Ok(ParsedDpsPatch {
        patch_name,
        patch_author,
        patch_version_text,
        patch_flag,
        source_size,
        output_size,
        copy_record_count,
        data_record_count,
        records,
        malformed_record_warning,
    })
}

fn create_dps_records_streaming(source_path: &Path, target_path: &Path) -> Result<Vec<DpsRecord>> {
    let source_len = fs::metadata(source_path)?.len();
    let target_len = fs::metadata(target_path)?.len();
    if target_len > u32::MAX as u64 {
        return Err(RomWeaverError::ValidationCode(
            dps_validation_code("DPS_CREATE_TARGET_EXCEEDED_U32_MAX")
                .with_message("DPS create does not support oversized targets")
                .with_field("target_len", target_len)
                .with_field("max_supported", u32::MAX),
        ));
    }

    let mut source = BufReader::new(File::open(source_path)?);
    let mut target = BufReader::new(File::open(target_path)?);
    let mut source_remaining = source_len;
    let mut target_remaining = target_len;
    let mut source_buffer = vec![0u8; DPS_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; DPS_IO_BUFFER_SIZE];
    let mut records = Vec::<DpsRecord>::new();
    let mut offset = 0u64;

    let mut pending_copy_start: Option<u32> = None;
    let mut pending_copy_len = 0u32;
    let mut pending_data_start: Option<u32> = None;
    let mut pending_data = Vec::<u8>::new();

    while target_remaining > 0 {
        let chunk_len =
            usize::try_from(target_remaining.min(DPS_IO_BUFFER_SIZE as u64)).map_err(|_| {
                RomWeaverError::Validation("DPS target chunk length exceeded usize".into())
            })?;
        let source_chunk_len =
            usize::try_from(source_remaining.min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("DPS source chunk length exceeded usize".into())
            })?;

        if source_chunk_len > 0 {
            source.read_exact(&mut source_buffer[..source_chunk_len])?;
        }
        target.read_exact(&mut target_buffer[..chunk_len])?;

        for index in 0..chunk_len {
            let current_offset = u32::try_from(offset).map_err(|_| {
                RomWeaverError::Validation("DPS output offset exceeded 32-bit range".into())
            })?;
            let equal = index < source_chunk_len && source_buffer[index] == target_buffer[index];
            if equal {
                if !pending_data.is_empty() {
                    let start = pending_data_start.ok_or_else(|| {
                        RomWeaverError::Validation(
                            "internal DPS state error: pending data missing start offset".into(),
                        )
                    })?;
                    records.push(DpsRecord::EmbeddedData {
                        output_offset: start,
                        data: std::mem::take(&mut pending_data),
                    });
                    pending_data_start = None;
                }
                if pending_copy_start.is_none() {
                    pending_copy_start = Some(current_offset);
                }
                pending_copy_len = pending_copy_len.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("DPS copy record length overflowed".into())
                })?;
            } else {
                if pending_copy_len > 0 {
                    let start = pending_copy_start.ok_or_else(|| {
                        RomWeaverError::Validation(
                            "internal DPS state error: pending copy missing start offset".into(),
                        )
                    })?;
                    records.push(DpsRecord::CopyFromSource {
                        output_offset: start,
                        source_offset: start,
                        length: pending_copy_len,
                    });
                    pending_copy_start = None;
                    pending_copy_len = 0;
                }
                if pending_data_start.is_none() {
                    pending_data_start = Some(current_offset);
                }
                pending_data.push(target_buffer[index]);
            }
            offset = offset
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("DPS output offset overflowed".into()))?;
        }

        source_remaining = source_remaining.saturating_sub(source_chunk_len as u64);
        target_remaining = target_remaining
            .checked_sub(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("DPS target remaining underflowed".into()))?;
    }

    if pending_copy_len > 0 {
        let start = pending_copy_start.ok_or_else(|| {
            RomWeaverError::Validation(
                "internal DPS state error: trailing pending copy missing start offset".into(),
            )
        })?;
        records.push(DpsRecord::CopyFromSource {
            output_offset: start,
            source_offset: start,
            length: pending_copy_len,
        });
    } else if !pending_data.is_empty() {
        let start = pending_data_start.ok_or_else(|| {
            RomWeaverError::Validation(
                "internal DPS state error: trailing pending data missing start offset".into(),
            )
        })?;
        records.push(DpsRecord::EmbeddedData {
            output_offset: start,
            data: pending_data,
        });
    }

    Ok(records)
}

fn create_dps_records(
    source_path: &Path,
    target_path: &Path,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
) -> Result<Vec<DpsRecord>> {
    if use_parallel_scan {
        create_dps_records_parallel(source_path, target_path, pool)
    } else {
        create_dps_records_streaming(source_path, target_path)
    }
}

fn create_dps_records_parallel(
    source_path: &Path,
    target_path: &Path,
    pool: &SharedThreadPool,
) -> Result<Vec<DpsRecord>> {
    let source = map_file_read_only(source_path)?;
    let target = map_file_read_only(target_path)?;

    if target.len() > u32::MAX as usize {
        return Err(RomWeaverError::ValidationCode(
            dps_validation_code("DPS_CREATE_TARGET_EXCEEDED_U32_MAX")
                .with_message("DPS create does not support oversized targets")
                .with_field("target_len", target.len())
                .with_field("max_supported", u32::MAX),
        ));
    }

    collect_dps_records_parallel(source.as_ref(), target.as_ref(), pool)
}

fn collect_dps_records_parallel(
    source: &[u8],
    target: &[u8],
    pool: &SharedThreadPool,
) -> Result<Vec<DpsRecord>> {
    if target.is_empty() {
        return Ok(Vec::new());
    }

    let chunk_ranges = (0..target.len())
        .step_by(CREATE_THREAD_SCAN_CHUNK_BYTES)
        .map(|start| {
            let end = start
                .saturating_add(CREATE_THREAD_SCAN_CHUNK_BYTES)
                .min(target.len());
            start..end
        })
        .collect::<Vec<_>>();

    let per_chunk = pool.install(|| {
        chunk_ranges
            .into_par_iter()
            .map(|range| collect_dps_chunk_records(source, target, range.start, range.end))
            .collect::<Vec<_>>()
    });

    let mut merged = Vec::<DpsRecord>::new();
    for records in per_chunk {
        let records = records?;
        for record in records {
            merge_dps_record(&mut merged, record)?;
        }
    }
    Ok(merged)
}

fn collect_dps_chunk_records(
    source: &[u8],
    target: &[u8],
    start: usize,
    end: usize,
) -> Result<Vec<DpsRecord>> {
    let mut records = Vec::<DpsRecord>::new();
    let mut pending_copy_start: Option<u32> = None;
    let mut pending_copy_len = 0u32;
    let mut pending_data_start: Option<u32> = None;
    let mut pending_data = Vec::<u8>::new();

    for index in start..end {
        let equal = index < source.len() && source[index] == target[index];
        let current_offset = u32::try_from(index).map_err(|_| {
            RomWeaverError::Validation("DPS create offset exceeded 32-bit range".into())
        })?;
        if equal {
            if !pending_data.is_empty() {
                let start = pending_data_start.ok_or_else(|| {
                    RomWeaverError::Validation(
                        "internal DPS state error: pending data missing start offset".into(),
                    )
                })?;
                records.push(DpsRecord::EmbeddedData {
                    output_offset: start,
                    data: std::mem::take(&mut pending_data),
                });
                pending_data_start = None;
            }
            if pending_copy_start.is_none() {
                pending_copy_start = Some(current_offset);
            }
            pending_copy_len = pending_copy_len.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation("DPS copy record length overflowed".into())
            })?;
        } else {
            if pending_copy_len > 0 {
                let start = pending_copy_start.ok_or_else(|| {
                    RomWeaverError::Validation(
                        "internal DPS state error: pending copy missing start offset".into(),
                    )
                })?;
                records.push(DpsRecord::CopyFromSource {
                    output_offset: start,
                    source_offset: start,
                    length: pending_copy_len,
                });
                pending_copy_start = None;
                pending_copy_len = 0;
            }
            if pending_data_start.is_none() {
                pending_data_start = Some(current_offset);
            }
            pending_data.push(target[index]);
        }
    }

    if pending_copy_len > 0 {
        let start = pending_copy_start.ok_or_else(|| {
            RomWeaverError::Validation(
                "internal DPS state error: trailing pending copy missing start offset".into(),
            )
        })?;
        records.push(DpsRecord::CopyFromSource {
            output_offset: start,
            source_offset: start,
            length: pending_copy_len,
        });
    }
    if !pending_data.is_empty() {
        let start = pending_data_start.ok_or_else(|| {
            RomWeaverError::Validation(
                "internal DPS state error: trailing pending data missing start offset".into(),
            )
        })?;
        records.push(DpsRecord::EmbeddedData {
            output_offset: start,
            data: pending_data,
        });
    }
    Ok(records)
}

fn merge_dps_record(merged: &mut Vec<DpsRecord>, mut next: DpsRecord) -> Result<()> {
    if let Some(last) = merged.last_mut() {
        match (last, &mut next) {
            (
                DpsRecord::CopyFromSource {
                    output_offset: last_output,
                    source_offset: last_source,
                    length: last_len,
                },
                DpsRecord::CopyFromSource {
                    output_offset: next_output,
                    source_offset: next_source,
                    length: next_len,
                },
            ) => {
                let last_end = u64::from(*last_output) + u64::from(*last_len);
                let source_end = u64::from(*last_source) + u64::from(*last_len);
                if last_end == u64::from(*next_output) && source_end == u64::from(*next_source) {
                    *last_len = last_len.checked_add(*next_len).ok_or_else(|| {
                        RomWeaverError::Validation("DPS copy record length overflowed".into())
                    })?;
                    return Ok(());
                }
            }
            (
                DpsRecord::EmbeddedData {
                    output_offset: last_output,
                    data: last_data,
                },
                DpsRecord::EmbeddedData {
                    output_offset: next_output,
                    data: next_data,
                },
            ) => {
                let last_len = u64::try_from(last_data.len()).map_err(|_| {
                    RomWeaverError::Validation("DPS record length overflowed".into())
                })?;
                let last_end = u64::from(*last_output) + last_len;
                if last_end == u64::from(*next_output) {
                    last_data.append(next_data);
                    return Ok(());
                }
            }
            _ => {}
        }
    }
    merged.push(next);
    Ok(())
}

fn copy_range_between_files(
    source: &mut File,
    output: &mut File,
    source_offset: u64,
    output_offset: u64,
    len: usize,
) -> Result<()> {
    if len == 0 {
        return Ok(());
    }

    let mut remaining = len;
    let mut source_cursor = source_offset;
    let mut output_cursor = output_offset;
    let mut buffer = vec![0u8; DPS_IO_BUFFER_SIZE];
    while remaining > 0 {
        let chunk_len = remaining.min(buffer.len());
        source.seek(SeekFrom::Start(source_cursor))?;
        source.read_exact(&mut buffer[..chunk_len])?;
        output.seek(SeekFrom::Start(output_cursor))?;
        output.write_all(&buffer[..chunk_len])?;

        source_cursor = source_cursor
            .checked_add(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("DPS source cursor overflowed".into()))?;
        output_cursor = output_cursor
            .checked_add(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("DPS output cursor overflowed".into()))?;
        remaining -= chunk_len;
    }

    Ok(())
}

struct PreparedDpsWrite {
    output_offset: u64,
    data: Vec<u8>,
}

fn apply_dps_records_in_place(
    records: &[ParsedDpsRecord<'_>],
    source_len: usize,
    output_len: usize,
    source: &mut File,
    output: &mut File,
) -> Result<()> {
    for record in records {
        match record {
            ParsedDpsRecord::CopyFromSource {
                output_offset,
                source_offset,
                length,
            } => {
                let (source_start, source_end) =
                    checked_range(*source_offset, *length, source_len, "DPS source copy")?;
                let (output_start, output_end) =
                    checked_range(*output_offset, *length, output_len, "DPS output write")?;
                debug_assert_eq!(source_end - source_start, output_end - output_start);
                copy_range_between_files(
                    source,
                    output,
                    source_start as u64,
                    output_start as u64,
                    output_end - output_start,
                )?;
            }
            ParsedDpsRecord::EmbeddedData {
                output_offset,
                data,
            } => {
                let data_len = u32::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation(
                        "DPS embedded record length exceeded 32-bit range".into(),
                    )
                })?;
                let (output_start, output_end) =
                    checked_range(*output_offset, data_len, output_len, "DPS output write")?;
                output.seek(SeekFrom::Start(output_start as u64))?;
                output.write_all(&data[..output_end - output_start])?;
            }
        }
    }
    Ok(())
}

fn prepare_dps_writes_parallel(
    records: &[ParsedDpsRecord<'_>],
    source: &[u8],
    source_len: usize,
    output_len: usize,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedDpsWrite>> {
    pool.install(|| {
        records
            .par_iter()
            .map(|record| {
                context.cancel().check()?;
                prepare_dps_write(record, source, source_len, output_len)
            })
            .collect::<Result<Vec<_>>>()
    })
}

fn prepare_dps_write(
    record: &ParsedDpsRecord<'_>,
    source: &[u8],
    source_len: usize,
    output_len: usize,
) -> Result<PreparedDpsWrite> {
    match record {
        ParsedDpsRecord::CopyFromSource {
            output_offset,
            source_offset,
            length,
        } => {
            let (source_start, source_end) =
                checked_range(*source_offset, *length, source_len, "DPS source copy")?;
            let (output_start, output_end) =
                checked_range(*output_offset, *length, output_len, "DPS output write")?;
            debug_assert_eq!(source_end - source_start, output_end - output_start);
            Ok(PreparedDpsWrite {
                output_offset: output_start as u64,
                data: source[source_start..source_end].to_vec(),
            })
        }
        ParsedDpsRecord::EmbeddedData {
            output_offset,
            data,
        } => {
            let data_len = u32::try_from(data.len()).map_err(|_| {
                RomWeaverError::Validation(
                    "DPS embedded record length exceeded 32-bit range".into(),
                )
            })?;
            let (output_start, output_end) =
                checked_range(*output_offset, data_len, output_len, "DPS output write")?;
            Ok(PreparedDpsWrite {
                output_offset: output_start as u64,
                data: data[..output_end - output_start].to_vec(),
            })
        }
    }
}

fn apply_prepared_dps_writes(output: &mut File, writes: &[PreparedDpsWrite]) -> Result<()> {
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(write.output_offset))?;
        output.write_all(&write.data)?;
    }
    Ok(())
}

fn encode_dps_patch(
    records: &[DpsRecord],
    metadata: DpsHeaderMetadata<'_>,
    source_size: u32,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    append_text_field(&mut bytes, metadata.patch_name);
    append_text_field(&mut bytes, metadata.patch_author);
    append_text_field(&mut bytes, metadata.patch_version_text);
    bytes.push(metadata.patch_flag);
    bytes.push(DPS_PATCH_VERSION);
    bytes.extend_from_slice(&source_size.to_le_bytes());

    for record in records {
        match record {
            DpsRecord::CopyFromSource {
                output_offset,
                source_offset,
                length,
            } => {
                bytes.push(DPS_RECORD_COPY_FROM_SOURCE);
                bytes.extend_from_slice(&output_offset.to_le_bytes());
                bytes.extend_from_slice(&source_offset.to_le_bytes());
                bytes.extend_from_slice(&length.to_le_bytes());
            }
            DpsRecord::EmbeddedData {
                output_offset,
                data,
            } => {
                let data_len = u32::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation(
                        "DPS embedded record length exceeded 32-bit range".into(),
                    )
                })?;
                bytes.push(DPS_RECORD_EMBEDDED_DATA);
                bytes.extend_from_slice(&output_offset.to_le_bytes());
                bytes.extend_from_slice(&data_len.to_le_bytes());
                bytes.extend_from_slice(data);
            }
        }
    }

    Ok(bytes)
}

fn append_text_field(bytes: &mut Vec<u8>, text: &str) {
    let mut field = [0u8; DPS_TEXT_FIELD_BYTES];
    let source = text.as_bytes();
    let copy_len = source.len().min(DPS_TEXT_FIELD_BYTES);
    field[..copy_len].copy_from_slice(&source[..copy_len]);
    bytes.extend_from_slice(&field);
}

fn parse_text_field(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

fn read_u8(bytes: &[u8], cursor: &mut usize, label: &'static str) -> Result<u8> {
    Ok(read_exact(bytes, cursor, 1, label)?[0])
}

fn read_u32_le(bytes: &[u8], cursor: &mut usize, label: &'static str) -> Result<u32> {
    let raw = read_exact(bytes, cursor, 4, label)?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

fn read_exact<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    len: usize,
    label: &'static str,
) -> Result<&'a [u8]> {
    let end = cursor.checked_add(len).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            dps_validation_code("DPS_READ_OFFSET_OVERFLOW")
                .with_field("label", label)
                .with_field("offset", *cursor)
                .with_field("len", len),
        )
    })?;
    let slice = bytes.get(*cursor..end).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            dps_validation_code("DPS_READ_UNEXPECTED_EOF")
                .with_message("DPS patch ended unexpectedly while reading field")
                .with_field("label", label)
                .with_field("offset", *cursor)
                .with_field("len", len)
                .with_field("buffer_len", bytes.len()),
        )
    })?;
    *cursor = end;
    Ok(slice)
}

fn checked_range(
    start: u32,
    len: u32,
    limit: usize,
    label: &'static str,
) -> Result<(usize, usize)> {
    let start = usize::try_from(start).map_err(|_| {
        RomWeaverError::ValidationCode(
            dps_validation_code("DPS_RANGE_OFFSET_OUT_OF_USIZE")
                .with_field("label", label)
                .with_field("offset", start),
        )
    })?;
    let len = usize::try_from(len).map_err(|_| {
        RomWeaverError::ValidationCode(
            dps_validation_code("DPS_RANGE_LENGTH_OUT_OF_USIZE")
                .with_field("label", label)
                .with_field("len", len),
        )
    })?;
    let end = start.checked_add(len).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            dps_validation_code("DPS_RANGE_OVERFLOW")
                .with_field("label", label)
                .with_field("start", start)
                .with_field("len", len),
        )
    })?;
    if end > limit {
        return Err(RomWeaverError::ValidationCode(
            dps_validation_code("DPS_RANGE_EXCEEDED_LIMIT")
                .with_field("label", label)
                .with_field("end", end)
                .with_field("limit", limit),
        ));
    }
    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rom_weaver_core::{
        PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    };

    use super::{
        encode_dps_patch, parse_dps_bytes, DpsHeaderMetadata, DpsParseMode, DpsPatchHandler,
        DpsRecord, ParsedDpsRecord, DPS_PATCH_VERSION, DPS_RECORD_EMBEDDED_DATA,
    };
    use crate::{
        test_support::{test_context_with_threads, TestDir},
        DPS,
    };

    #[test]
    fn parse_rejects_unsupported_patch_version() {
        let records = vec![DpsRecord::EmbeddedData {
            output_offset: 0,
            data: b"A".to_vec(),
        }];
        let mut bytes = encode_dps_patch(
            &records,
            DpsHeaderMetadata {
                patch_name: "unsupported-version.dps",
                patch_author: "test",
                patch_version_text: "0",
                patch_flag: 0,
            },
            0,
        )
        .expect("patch");
        bytes[193] = DPS_PATCH_VERSION + 1;

        let error = parse_dps_bytes(&bytes, DpsParseMode::Strict).expect_err("unsupported version");
        assert!(error.to_string().contains("is not supported"));
    }

    #[test]
    fn apply_supports_copy_and_embedded_data_records() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("update.dps");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        let records = vec![
            DpsRecord::CopyFromSource {
                output_offset: 0,
                source_offset: 0,
                length: 2,
            },
            DpsRecord::EmbeddedData {
                output_offset: 2,
                data: b"XY".to_vec(),
            },
            DpsRecord::CopyFromSource {
                output_offset: 4,
                source_offset: 4,
                length: 4,
            },
        ];
        let patch = encode_dps_patch(
            &records,
            DpsHeaderMetadata {
                patch_name: "copy-and-data.dps",
                patch_author: "test",
                patch_version_text: "1",
                patch_flag: 0,
            },
            8,
        )
        .expect("patch bytes");
        fs::write(&patch_path, patch).expect("fixture");

        let handler = DpsPatchHandler::new(&DPS);
        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), b"abXYefgh");
    }

    #[test]
    fn create_and_apply_round_trip_supports_shrinking_outputs() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.dps");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        fs::write(&target_path, b"abXY").expect("fixture");

        let handler = DpsPatchHandler::new(&DPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create");

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(
            fs::read(output_path).expect("output"),
            fs::read(target_path).expect("target")
        );
    }

    #[test]
    fn apply_ignores_source_size_validation_when_requested() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let mismatched_source_path = temp.child("source-mismatch.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.dps");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        fs::write(&mismatched_source_path, b"abcdefghZZ").expect("fixture");
        fs::write(&target_path, b"abXYefgh").expect("fixture");

        let handler = DpsPatchHandler::new(&DPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let strict_error = handler
            .apply(
                &PatchApplyRequest {
                    input: mismatched_source_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("strict mismatch");
        assert!(strict_error.to_string().contains("source size mismatch"));

        let ignored_report = handler
            .apply(
                &PatchApplyRequest {
                    input: mismatched_source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1)
                    .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("ignore mismatch");
        assert!(ignored_report.label.contains("checksum validation skipped"));
        assert_eq!(fs::read(output_path).expect("output"), b"abXYefgh");
    }

    #[test]
    fn apply_warns_and_stops_on_malformed_records_when_ignore_requested() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("update.dps");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        let mut patch = encode_dps_patch(
            &[
                DpsRecord::CopyFromSource {
                    output_offset: 0,
                    source_offset: 0,
                    length: 4,
                },
                DpsRecord::EmbeddedData {
                    output_offset: 4,
                    data: b"XY".to_vec(),
                },
            ],
            DpsHeaderMetadata {
                patch_name: "malformed-tail.dps",
                patch_author: "test",
                patch_version_text: "1",
                patch_flag: 0,
            },
            8,
        )
        .expect("patch");
        patch.push(DPS_RECORD_EMBEDDED_DATA);
        patch.extend_from_slice(&6u32.to_le_bytes());
        patch.extend_from_slice(&3u32.to_le_bytes());
        patch.extend_from_slice(b"Z");
        fs::write(&patch_path, patch).expect("fixture");

        let handler = DpsPatchHandler::new(&DPS);
        let strict_error = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("strict malformed");
        assert!(strict_error.to_string().contains("ended unexpectedly"));

        let ignored_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1)
                    .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("ignore malformed");
        assert!(ignored_report
            .label
            .contains("warning=ignored malformed DPS record"));
        assert_eq!(fs::read(output_path).expect("output"), b"abcdXY");
    }

    #[test]
    fn create_merges_embedded_data_that_crosses_thread_chunk_boundary() {
        let temp = TestDir::new();
        let source_path = temp.child("source-boundary.bin");
        let target_path = temp.child("target-boundary.bin");
        let single_patch = temp.child("single/boundary.dps");
        let parallel_patch = temp.child("parallel/boundary.dps");

        let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 64;
        let source = vec![0x22u8; len];
        let mut target = source.clone();
        let run_start = super::CREATE_THREAD_SCAN_CHUNK_BYTES - 11;
        let run_len = 29usize;
        for (index, byte) in target[run_start..run_start + run_len]
            .iter_mut()
            .enumerate()
        {
            *byte = 0x80u8.wrapping_add(index as u8);
        }

        fs::write(&source_path, &source).expect("source");
        fs::write(&target_path, &target).expect("target");

        let handler = DpsPatchHandler::new(&DPS);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: single_patch.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path,
                    modified: target_path,
                    output: parallel_patch.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel create");

        assert!(
            !single_report
                .thread_execution
                .expect("single execution")
                .used_parallelism
        );
        assert!(
            parallel_report
                .thread_execution
                .expect("parallel execution")
                .used_parallelism
        );
        assert_eq!(
            fs::read(&single_patch).expect("single patch"),
            fs::read(&parallel_patch).expect("parallel patch")
        );

        let patch_bytes = fs::read(parallel_patch).expect("patch bytes");
        let parsed = parse_dps_bytes(&patch_bytes, DpsParseMode::Strict).expect("parse");
        assert_eq!(parsed.data_record_count, 1);

        let embedded = parsed
            .records
            .iter()
            .find_map(|record| match record {
                ParsedDpsRecord::EmbeddedData {
                    output_offset,
                    data,
                } => Some((*output_offset, data)),
                _ => None,
            })
            .expect("embedded record");

        assert_eq!(embedded.0, run_start as u32);
        assert_eq!(embedded.1.len(), run_len);
        assert_eq!(*embedded.1, &target[run_start..run_start + run_len]);
    }

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let source_path = temp.child("source-large.bin");
        let target_path = temp.child("target-large.bin");
        let single_patch = temp.child("single/update.dps");
        let parallel_patch = temp.child("parallel/update.dps");

        let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 96 * 1024;
        let mut source = vec![0u8; len];
        for (index, byte) in source.iter_mut().enumerate() {
            *byte = ((index * 7 + (index >> 2)) & 0xff) as u8;
        }
        let mut target = source.clone();
        for index in (0..target.len()).step_by(4097) {
            target[index] ^= 0x33;
        }

        fs::write(&source_path, &source).expect("source");
        fs::write(&target_path, &target).expect("target");

        let handler = DpsPatchHandler::new(&DPS);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: single_patch.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path,
                    modified: target_path,
                    output: parallel_patch.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel create");

        assert!(
            !single_report
                .thread_execution
                .expect("single execution")
                .used_parallelism
        );
        assert!(
            parallel_report
                .thread_execution
                .expect("parallel execution")
                .used_parallelism
        );
        assert_eq!(
            fs::read(single_patch).expect("single patch"),
            fs::read(parallel_patch).expect("parallel patch")
        );
    }

    #[test]
    fn apply_runtime_threads_match_capabilities_for_multi_record_patch() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.dps");
        let output_path = temp.child("output.bin");

        let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 96 * 1024;
        let mut source = vec![0u8; len];
        for (index, byte) in source.iter_mut().enumerate() {
            *byte = ((index * 13 + (index >> 2)) & 0xff) as u8;
        }
        let mut target = source.clone();
        for index in (0..target.len()).step_by(3071) {
            target[index] ^= 0x33;
        }

        fs::write(&source_path, &source).expect("source fixture");
        fs::write(&target_path, &target).expect("target fixture");

        let handler = DpsPatchHandler::new(&DPS);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_output);

        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");

        let apply_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("apply");

        let execution = apply_report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("output"), target);
    }
}
