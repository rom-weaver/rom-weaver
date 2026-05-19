use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use memmap2::{Mmap, MmapOptions};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};

const DPS_TEXT_FIELD_BYTES: usize = 64;
const DPS_HEADER_BYTES: usize = (DPS_TEXT_FIELD_BYTES * 3) + 1 + 1 + 4;
const DPS_PATCH_VERSION: u8 = 1;

const DPS_RECORD_COPY_FROM_SOURCE: u8 = 0;
const DPS_RECORD_EMBEDDED_DATA: u8 = 1;
const DPS_IO_BUFFER_SIZE: usize = 64 * 1024;

const DEFAULT_PATCH_AUTHOR: &str = "rom-weaver";
const DEFAULT_PATCH_VERSION_TEXT: &str = "1";

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
        let parsed = parse_dps_file(patch_path, DpsParseMode::Strict)?;

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
        let parsed = parse_dps_file(patch_path, parse_mode)?;
        let source_len_u64 = fs::metadata(&request.input)?.len();
        let source_len_u32 = u32::try_from(source_len_u64).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} source input exceeded maximum supported size of {} byte(s)",
                self.descriptor.name,
                u32::MAX
            ))
        })?;
        if validate_source_size && source_len_u32 != parsed.source_size {
            return Err(RomWeaverError::Validation(format!(
                "{} source size mismatch: expected {} byte(s), actual {} byte(s)",
                self.descriptor.name, parsed.source_size, source_len_u32
            )));
        }

        let output_len = usize::try_from(parsed.output_size).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} output size exceeded addressable memory",
                self.descriptor.name
            ))
        })?;
        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut source = File::open(&request.input)?;
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&request.output)?;
        output.set_len(parsed.output_size)?;

        for record in &parsed.records {
            match record {
                DpsRecord::CopyFromSource {
                    output_offset,
                    source_offset,
                    length,
                } => {
                    let (source_start, source_end) = checked_range(
                        *source_offset,
                        *length,
                        source_len_u64 as usize,
                        "DPS source copy",
                    )?;
                    let (output_start, output_end) =
                        checked_range(*output_offset, *length, output_len, "DPS output write")?;
                    debug_assert_eq!(source_end - source_start, output_end - output_start);
                    copy_range_between_files(
                        &mut source,
                        &mut output,
                        source_start as u64,
                        output_start as u64,
                        output_end - output_start,
                    )?;
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
                    let (output_start, output_end) =
                        checked_range(*output_offset, data_len, output_len, "DPS output write")?;
                    output.seek(SeekFrom::Start(output_start as u64))?;
                    output.write_all(&data[..output_end - output_start])?;
                }
            }
        }
        output.flush()?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let source_size = u32::try_from(fs::metadata(&request.original)?.len()).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} create does not support sources larger than {} byte(s)",
                self.descriptor.name,
                u32::MAX
            ))
        })?;

        let records = create_dps_records_streaming(&request.original, &request.modified)?;
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
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Clone, Debug)]
struct ParsedDpsPatch {
    patch_name: String,
    patch_author: String,
    patch_version_text: String,
    patch_flag: u8,
    source_size: u32,
    output_size: u64,
    copy_record_count: usize,
    data_record_count: usize,
    records: Vec<DpsRecord>,
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

impl DpsRecord {
    fn output_end(&self) -> Result<u64> {
        match self {
            DpsRecord::CopyFromSource {
                output_offset,
                length,
                ..
            } => u64::from(*output_offset)
                .checked_add(u64::from(*length))
                .ok_or_else(|| RomWeaverError::Validation("DPS output range overflowed".into())),
            DpsRecord::EmbeddedData {
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

fn parse_dps_file(path: &Path, mode: DpsParseMode) -> Result<ParsedDpsPatch> {
    let bytes = map_file_read_only(path)?;
    parse_dps_bytes(&bytes, mode)
}

fn map_file_read_only(path: &Path) -> Result<Mmap> {
    let file = File::open(path)?;
    // SAFETY: This mapping is read-only and the file handle lives through map creation.
    let map = unsafe { MmapOptions::new().map(&file)? };
    Ok(map)
}

fn parse_dps_bytes(bytes: &[u8], mode: DpsParseMode) -> Result<ParsedDpsPatch> {
    if bytes.len() < DPS_HEADER_BYTES {
        return Err(RomWeaverError::Validation(format!(
            "DPS patch is too small to contain a valid header (expected at least {DPS_HEADER_BYTES} byte(s), found {})",
            bytes.len()
        )));
    }

    let patch_name = parse_text_field(&bytes[0..DPS_TEXT_FIELD_BYTES]);
    let patch_author = parse_text_field(&bytes[DPS_TEXT_FIELD_BYTES..DPS_TEXT_FIELD_BYTES * 2]);
    let patch_version_text =
        parse_text_field(&bytes[DPS_TEXT_FIELD_BYTES * 2..DPS_TEXT_FIELD_BYTES * 3]);
    let patch_flag = bytes[DPS_TEXT_FIELD_BYTES * 3];

    let version = bytes[(DPS_TEXT_FIELD_BYTES * 3) + 1];
    if version != DPS_PATCH_VERSION {
        return Err(RomWeaverError::Validation(format!(
            "DPS patch version {version} is not supported (expected {DPS_PATCH_VERSION})"
        )));
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
                DpsRecord::CopyFromSource {
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
                    Ok(value) => value.to_vec(),
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
                DpsRecord::EmbeddedData {
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
                return Err(RomWeaverError::Validation(format!(
                    "DPS record mode {mode_byte} is not supported"
                )));
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
        return Err(RomWeaverError::Validation(format!(
            "DPS create does not support targets larger than {} byte(s)",
            u32::MAX
        )));
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
                    let start = pending_data_start.expect("pending data has start");
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
                    let start = pending_copy_start.expect("pending copy has start");
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
        let start = pending_copy_start.expect("pending copy has start");
        records.push(DpsRecord::CopyFromSource {
            output_offset: start,
            source_offset: start,
            length: pending_copy_len,
        });
    } else if !pending_data.is_empty() {
        let start = pending_data_start.expect("pending data has start");
        records.push(DpsRecord::EmbeddedData {
            output_offset: start,
            data: pending_data,
        });
    }

    Ok(records)
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

fn read_u8(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u8> {
    Ok(read_exact(bytes, cursor, 1, label)?[0])
}

fn read_u32_le(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u32> {
    let raw = read_exact(bytes, cursor, 4, label)?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

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
            "DPS patch ended unexpectedly while reading {label}"
        ))
    })?;
    *cursor = end;
    Ok(slice)
}

fn checked_range(start: u32, len: u32, limit: usize, label: &str) -> Result<(usize, usize)> {
    let start = usize::try_from(start)
        .map_err(|_| RomWeaverError::Validation(format!("{label} offset exceeded usize range")))?;
    let len = usize::try_from(len)
        .map_err(|_| RomWeaverError::Validation(format!("{label} length exceeded usize range")))?;
    let end = start
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} range overflowed")))?;
    if end > limit {
        return Err(RomWeaverError::Validation(format!(
            "{label} exceeded available length ({end} > {limit})"
        )));
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
        DPS_PATCH_VERSION, DPS_RECORD_EMBEDDED_DATA, DpsHeaderMetadata, DpsParseMode,
        DpsPatchHandler, DpsRecord, encode_dps_patch, parse_dps_bytes,
    };
    use crate::{
        DPS,
        test_support::{TestDir, test_context_with_threads},
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
        assert!(
            ignored_report
                .label
                .contains("warning=ignored malformed DPS record")
        );
        assert_eq!(fs::read(output_path).expect("output"), b"abcdXY");
    }
}
