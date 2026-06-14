use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use tracing::{debug, info, trace};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence, Result, RomWeaverError, SharedThreadPool,
    ThreadCapability,
};

use crate::checksum_validation_suffix;
use crate::shared::runs::{AdjacentRun, merge_adjacent_runs};
use crate::shared::threading::{
    PreparedWrite, apply_prepared_writes, chunk_count_for_len_checked,
    parallel_per_record_capability, pool_map, run_with_optional_pool, scan_create_chunks,
};

const APS_N64_MAGIC: &[u8; 5] = b"APS10";
const APS_N64_MODE: u8 = 0x01;
const APS_RECORD_RLE: u8 = 0x00;
const APS_DESCRIPTION_SIZE: usize = 50;
const APS_N64_EXTRA_HEADER_SIZE: usize = 17;
const APS_RECORD_MAX_DATA_LEN: usize = u8::MAX as usize;
const APS_N64_PREFIX_SIZE: usize = APS_N64_MAGIC.len() + 1 + 1 + APS_DESCRIPTION_SIZE;
const APS_N64_BASE_HEADER_SIZE: usize = APS_N64_PREFIX_SIZE + 4;
const APS_DEFAULT_DESCRIPTION: &str = "no description";
const APS_DEFAULT_ENCODING_METHOD: u8 = 0;
const APS_N64_CART_ID_OFFSET: u64 = 0x3C;
const APS_N64_CRC_OFFSET: u64 = 0x10;
const APS_CREATE_CHUNK_BYTES: usize = 1024 * 1024;

pub struct ApsN64PatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl ApsN64PatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for ApsN64PatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_aps_file(patch_path)?;
        let validation_label = if let Some(n64_header) = &patch.n64_header {
            format!(
                "; n64 source cart id {}; n64 source crc {}",
                format_cart_id(n64_header.cart_id),
                format_bytes_hex(&n64_header.crc)
            )
        } else {
            String::new()
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s){}",
                self.descriptor.name,
                patch.records.len(),
                validation_label
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
        debug!(
            format = self.descriptor.name,
            patch = %patch_path.display(),
            "aps patch apply start"
        );
        let patch = parse_aps_file(patch_path)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;

        if validate_checksums
            && patch.header_type == APS_N64_MODE
            && let Some(n64_header) = &patch.n64_header
        {
            validate_n64_source(&request.input, n64_header)?;
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let input_size = fs::metadata(&request.input)?.len();
        let thread_capability = parallel_per_record_capability(patch.records.len());
        let in_memory = crate::can_apply_in_memory_on_apply(context, input_size, patch.output_size);
        trace!(
            format = self.descriptor.name,
            records = patch.records.len(),
            input_size,
            output_size = patch.output_size,
            in_memory,
            "aps parsed; apply path chosen"
        );
        let execution = if in_memory {
            let mut execution = context.plan_threads(thread_capability.clone());
            let mut output_bytes = fs::read(&request.input)?;
            output_bytes.resize(patch.output_size as usize, 0);
            apply_aps_records_in_memory(patch.output_size, &patch.records, &mut output_bytes)?;
            fs::write(&request.output, &output_bytes)?;
            execution.force_serial();
            execution
        } else {
            fs::copy(&request.input, &request.output)?;
            let mut output = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&request.output)?;
            output.set_len(patch.output_size)?;
            let (execution, prepared) = run_with_optional_pool(
                context,
                thread_capability,
                true,
                |pool| {
                    prepare_aps_writes_parallel(&patch.records, patch.output_size, pool, context)
                        .map(Some)
                },
                || {
                    apply_aps_records(&mut output, patch.output_size, &patch.records)?;
                    Ok(None)
                },
            )?;
            if let Some(prepared) = prepared {
                apply_prepared_writes(&mut output, &prepared)?;
            }
            output.flush()?;
            execution
        };

        let checksum_suffix = checksum_validation_suffix(validate_checksums);
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
        let patch = parse_aps_file(patch_path)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;

        if validate_checksums
            && patch.header_type == APS_N64_MODE
            && let Some(n64_header) = &patch.n64_header
        {
            validate_n64_source(&request.input, n64_header)?;
        }
        for record in &patch.records {
            context.cancel().check()?;
            let _ = prepare_aps_write(record, patch.output_size)?;
        }

        let checksum_suffix = checksum_validation_suffix(validate_checksums);
        Ok(crate::patch_success_report(
            self.descriptor,
            "validate",
            format!(
                "validated {} patch source with {} record(s){}",
                self.descriptor.name,
                patch.records.len(),
                checksum_suffix
            ),
            context.single_thread_execution(),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        debug!(
            format = self.descriptor.name,
            original_len, modified_len, "aps patch create start"
        );
        let modified_len_usize = usize::try_from(modified_len).unwrap_or(usize::MAX);
        let thread_capability = aps_create_thread_capability(modified_len_usize)?;
        let (execution, created) = run_with_optional_pool(
            context,
            thread_capability,
            true,
            |pool| {
                create_aps_patch_parallel(
                    &request.original,
                    original_len,
                    &request.modified,
                    modified_len,
                    pool,
                    context,
                )
            },
            || {
                create_aps_patch_from_files(
                    &request.original,
                    original_len,
                    &request.modified,
                    modified_len,
                    context,
                )
            },
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

fn format_cart_id(cart_id: [u8; 3]) -> String {
    String::from_utf8_lossy(&cart_id).into_owned()
}

fn format_bytes_hex(bytes: &[u8]) -> String {
    let mut rendered = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        rendered.push(hex_char(byte >> 4));
        rendered.push(hex_char(byte & 0x0F));
    }
    rendered
}

fn hex_char(nibble: u8) -> char {
    match nibble {
        0..=9 => char::from(b'0' + nibble),
        _ => char::from(b'a' + (nibble - 10)),
    }
}

#[derive(Debug)]
struct ParsedApsPatch {
    header_type: u8,
    n64_header: Option<ApsN64Header>,
    output_size: u64,
    records: Vec<ApsRecord>,
}

#[derive(Debug)]
struct ApsN64Header {
    cart_id: [u8; 3],
    crc: [u8; 8],
}

#[derive(Clone, Debug)]
enum ApsRecord {
    Simple { offset: u64, data: Vec<u8> },
    Rle { offset: u64, byte: u8, length: u8 },
}

#[derive(Debug)]
struct CreatedApsPatch {
    bytes: Vec<u8>,
    record_count: usize,
}

fn aps_create_thread_capability(modified_len: usize) -> Result<ThreadCapability> {
    let chunk_count = aps_create_chunk_count(modified_len)?;
    Ok(ThreadCapability::parallel(Some(chunk_count.max(1))))
}

fn aps_create_chunk_count(modified_len: usize) -> Result<usize> {
    chunk_count_for_len_checked(
        modified_len as u64,
        APS_CREATE_CHUNK_BYTES as u64,
        "APS create chunk count resolved to zero",
    )
}

fn parse_aps_file(path: &Path) -> Result<ParsedApsPatch> {
    let file_len = fs::metadata(path)?.len();
    if file_len < APS_N64_BASE_HEADER_SIZE as u64 {
        return Err(RomWeaverError::Validation(
            "APS patch is too small to contain a valid header".into(),
        ));
    }

    let mut parser = ApsFileParser::new(BufReader::new(File::open(path)?), file_len);
    let prefix = parser.read_exact(APS_N64_PREFIX_SIZE, "APS header")?;
    if !prefix.starts_with(APS_N64_MAGIC) {
        return Err(crate::coded_validation(
            "APS_N64_HEADER_INVALID",
            "Patch header invalid",
        ));
    }

    let header_type = prefix[APS_N64_MAGIC.len()];
    let _encoding_method = prefix[APS_N64_MAGIC.len() + 1];
    let _description = decode_description(
        &prefix[APS_N64_MAGIC.len() + 2..APS_N64_MAGIC.len() + 2 + APS_DESCRIPTION_SIZE],
    );

    let n64_header = if header_type == APS_N64_MODE {
        let extra = parser.read_exact(APS_N64_EXTRA_HEADER_SIZE, "APS N64 header")?;
        let cart_id: [u8; 3] = extra[1..4]
            .try_into()
            .map_err(|_| RomWeaverError::Validation("APS cart id bytes were truncated".into()))?;
        let crc: [u8; 8] = extra[4..12]
            .try_into()
            .map_err(|_| RomWeaverError::Validation("APS CRC bytes were truncated".into()))?;
        Some(ApsN64Header { cart_id, crc })
    } else {
        None
    };

    let output_size = u64::from(parser.read_u32_le("APS output size")?);
    let mut records = Vec::new();
    while parser.remaining() > 0 {
        if parser.remaining() < 5 {
            return Err(RomWeaverError::Validation(
                "APS record header exceeded patch bounds".into(),
            ));
        }
        let offset = u64::from(parser.read_u32_le("APS record offset")?);
        let length = parser.read_u8("APS record length")?;

        if length == APS_RECORD_RLE {
            if parser.remaining() < 2 {
                return Err(RomWeaverError::Validation(
                    "APS RLE record exceeded patch bounds".into(),
                ));
            }
            let byte = parser.read_u8("APS RLE value")?;
            let run_length = parser.read_u8("APS RLE length")?;
            records.push(ApsRecord::Rle {
                offset,
                byte,
                length: run_length,
            });
            continue;
        }

        let data = parser.read_exact(usize::from(length), "APS record data")?;
        records.push(ApsRecord::Simple { offset, data });
    }

    Ok(ParsedApsPatch {
        header_type,
        n64_header,
        output_size,
        records,
    })
}

#[cfg(test)]
fn parse_aps_bytes(bytes: &[u8]) -> Result<ParsedApsPatch> {
    if bytes.len() < APS_N64_BASE_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "APS patch is too small to contain a valid header".into(),
        ));
    }
    if !bytes.starts_with(APS_N64_MAGIC) {
        return Err(crate::coded_validation(
            "APS_N64_HEADER_INVALID",
            "Patch header invalid",
        ));
    }

    let header_type = bytes[APS_N64_MAGIC.len()];
    let _encoding_method = bytes[APS_N64_MAGIC.len() + 1];
    let _description = decode_description(
        &bytes[APS_N64_MAGIC.len() + 2..APS_N64_MAGIC.len() + 2 + APS_DESCRIPTION_SIZE],
    );

    let mut cursor = APS_N64_PREFIX_SIZE;
    let n64_header = if header_type == APS_N64_MODE {
        let header_end = cursor
            .checked_add(APS_N64_EXTRA_HEADER_SIZE)
            .ok_or_else(|| RomWeaverError::Validation("APS header overflowed".into()))?;
        if header_end > bytes.len() {
            return Err(RomWeaverError::Validation(
                "APS N64 header was truncated".into(),
            ));
        }

        cursor += 1; // originalN64Format (unused for apply semantics)
        let cart_id: [u8; 3] = bytes[cursor..cursor + 3]
            .try_into()
            .map_err(|_| RomWeaverError::Validation("APS cart id bytes were truncated".into()))?;
        cursor += 3;
        let crc: [u8; 8] = bytes[cursor..cursor + 8]
            .try_into()
            .map_err(|_| RomWeaverError::Validation("APS CRC bytes were truncated".into()))?;
        cursor += 8;
        cursor += 5; // pad bytes

        Some(ApsN64Header { cart_id, crc })
    } else {
        None
    };

    let output_size = u64::from(read_u32_le(bytes, cursor)?);
    cursor += 4;

    let mut records = Vec::new();
    while cursor < bytes.len() {
        let record_header_end = cursor
            .checked_add(5)
            .ok_or_else(|| RomWeaverError::Validation("APS record header overflowed".into()))?;
        if record_header_end > bytes.len() {
            return Err(RomWeaverError::Validation(
                "APS record header exceeded patch bounds".into(),
            ));
        }

        let offset = u64::from(read_u32_le(bytes, cursor)?);
        let length = bytes[cursor + 4];
        cursor = record_header_end;

        if length == APS_RECORD_RLE {
            let rle_end = cursor
                .checked_add(2)
                .ok_or_else(|| RomWeaverError::Validation("APS RLE record overflowed".into()))?;
            if rle_end > bytes.len() {
                return Err(RomWeaverError::Validation(
                    "APS RLE record exceeded patch bounds".into(),
                ));
            }
            let byte = bytes[cursor];
            let run_length = bytes[cursor + 1];
            cursor = rle_end;
            records.push(ApsRecord::Rle {
                offset,
                byte,
                length: run_length,
            });
            continue;
        }

        let data_len = usize::from(length);
        let data_end = cursor
            .checked_add(data_len)
            .ok_or_else(|| RomWeaverError::Validation("APS record length overflowed".into()))?;
        if data_end > bytes.len() {
            return Err(RomWeaverError::Validation(
                "APS record data exceeded patch bounds".into(),
            ));
        }

        records.push(ApsRecord::Simple {
            offset,
            data: bytes[cursor..data_end].to_vec(),
        });
        cursor = data_end;
    }

    Ok(ParsedApsPatch {
        header_type,
        n64_header,
        output_size,
        records,
    })
}

fn validate_n64_source(input_path: &Path, expected: &ApsN64Header) -> Result<()> {
    let mut input = File::open(input_path)?;
    let input_len = input.metadata()?.len();
    if input_len < APS_N64_CART_ID_OFFSET + 3 || input_len < APS_N64_CRC_OFFSET + 8 {
        return Err(RomWeaverError::Validation(
            "Source ROM checksum mismatch".into(),
        ));
    }

    input.seek(SeekFrom::Start(APS_N64_CART_ID_OFFSET))?;
    let mut cart_id = [0u8; 3];
    input.read_exact(&mut cart_id)?;

    input.seek(SeekFrom::Start(APS_N64_CRC_OFFSET))?;
    let mut crc = [0u8; 8];
    input.read_exact(&mut crc)?;

    if cart_id != expected.cart_id || crc != expected.crc {
        return Err(RomWeaverError::Validation(
            "Source ROM checksum mismatch".into(),
        ));
    }
    Ok(())
}

fn apply_aps_records_in_memory(
    output_size: u64,
    records: &[ApsRecord],
    output: &mut [u8],
) -> Result<()> {
    for record in records {
        match record {
            ApsRecord::Simple { offset, data } => {
                let start = *offset as usize;
                let end = start + data.len();
                if end > output_size as usize {
                    return Err(RomWeaverError::Validation(
                        "APS record exceeded output size".into(),
                    ));
                }
                if !data.is_empty() {
                    output[start..end].copy_from_slice(data);
                }
            }
            ApsRecord::Rle {
                offset,
                byte,
                length,
            } => {
                let start = *offset as usize;
                let end = start + usize::from(*length);
                if end > output_size as usize {
                    return Err(RomWeaverError::Validation(
                        "APS RLE record exceeded output size".into(),
                    ));
                }
                if *length > 0 {
                    output[start..end].fill(*byte);
                }
            }
        }
    }
    Ok(())
}

fn apply_aps_records(file: &mut File, output_size: u64, records: &[ApsRecord]) -> Result<()> {
    for record in records {
        match record {
            ApsRecord::Simple { offset, data } => {
                let end = offset
                    .checked_add(u64::try_from(data.len()).map_err(|_| {
                        RomWeaverError::Validation("APS record length exceeded u64".into())
                    })?)
                    .ok_or_else(|| {
                        RomWeaverError::Validation("APS record end overflowed".into())
                    })?;
                if end > output_size {
                    return Err(RomWeaverError::Validation(
                        "APS record exceeded output size".into(),
                    ));
                }
                if data.is_empty() {
                    continue;
                }
                file.seek(SeekFrom::Start(*offset))?;
                file.write_all(data)?;
            }
            ApsRecord::Rle {
                offset,
                byte,
                length,
            } => {
                let run_len = u64::from(*length);
                let end = offset
                    .checked_add(run_len)
                    .ok_or_else(|| RomWeaverError::Validation("APS RLE end overflowed".into()))?;
                if end > output_size {
                    return Err(RomWeaverError::Validation(
                        "APS RLE record exceeded output size".into(),
                    ));
                }
                if *length == 0 {
                    continue;
                }
                file.seek(SeekFrom::Start(*offset))?;
                let fill = vec![*byte; usize::from(*length)];
                file.write_all(&fill)?;
            }
        }
    }
    Ok(())
}

fn prepare_aps_writes_parallel(
    records: &[ApsRecord],
    output_size: u64,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedWrite>> {
    pool_map(pool, records, |record| {
        context.cancel().check()?;
        prepare_aps_write(record, output_size)
    })
}

fn prepare_aps_write(record: &ApsRecord, output_size: u64) -> Result<PreparedWrite> {
    match record {
        ApsRecord::Simple { offset, data } => {
            let end = offset
                .checked_add(u64::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation("APS record length exceeded u64".into())
                })?)
                .ok_or_else(|| RomWeaverError::Validation("APS record end overflowed".into()))?;
            if end > output_size {
                return Err(RomWeaverError::Validation(
                    "APS record exceeded output size".into(),
                ));
            }
            Ok(PreparedWrite {
                offset: *offset,
                data: data.clone(),
            })
        }
        ApsRecord::Rle {
            offset,
            byte,
            length,
        } => {
            let run_len = u64::from(*length);
            let end = offset
                .checked_add(run_len)
                .ok_or_else(|| RomWeaverError::Validation("APS RLE end overflowed".into()))?;
            if end > output_size {
                return Err(RomWeaverError::Validation(
                    "APS RLE record exceeded output size".into(),
                ));
            }
            Ok(PreparedWrite {
                offset: *offset,
                data: vec![*byte; usize::from(*length)],
            })
        }
    }
}

#[cfg(test)]
fn create_aps_patch_bytes(
    original_path: &Path,
    original: &[u8],
    modified: &[u8],
) -> Result<CreatedApsPatch> {
    let n64_header = detect_n64_header(original_path, original);
    let mut records = Vec::<ApsRecord>::new();

    let mut index = 0usize;
    while index < modified.len() {
        let source = original.get(index).copied().unwrap_or(0);
        let target = modified[index];
        if source == target {
            index += 1;
            continue;
        }

        let start = index;
        let mut different_data = Vec::new();
        let mut rle_candidate = true;
        let repeated_byte = target;
        while index < modified.len() && different_data.len() < APS_RECORD_MAX_DATA_LEN {
            let source = original.get(index).copied().unwrap_or(0);
            let target = modified[index];
            if source == target {
                break;
            }
            different_data.push(target);
            rle_candidate &= target == repeated_byte;
            index += 1;
        }

        let offset = u64::try_from(start)
            .map_err(|_| RomWeaverError::Validation("APS record offset exceeded u64".into()))?;
        if rle_candidate && different_data.len() > 2 {
            let length = u8::try_from(different_data.len()).map_err(|_| {
                RomWeaverError::Validation("APS record length exceeded 255 bytes".into())
            })?;
            records.push(ApsRecord::Rle {
                offset,
                byte: repeated_byte,
                length,
            });
        } else {
            records.push(ApsRecord::Simple {
                offset,
                data: different_data,
            });
        }
    }

    create_aps_patch_with_records(n64_header, modified.len() as u64, records)
}

fn create_aps_patch_from_files(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    context: &OperationContext,
) -> Result<CreatedApsPatch> {
    let n64_header = detect_n64_header_from_path(original_path, original_len)?;
    let modified_len_usize = usize::try_from(modified_len).map_err(|_| {
        RomWeaverError::Validation("APS output size exceeded addressable memory".into())
    })?;
    let chunk_count = aps_create_chunk_count(modified_len_usize)?;
    let mut chunk_runs = Vec::with_capacity(chunk_count);
    for chunk_index in 0..chunk_count {
        context.cancel().check()?;
        chunk_runs.push(collect_diff_runs_for_chunk(
            chunk_index,
            original_path,
            original_len,
            modified_path,
            modified_len,
        )?);
    }
    let runs = merge_adjacent_runs(chunk_runs)?;
    let records = encode_runs_as_aps_records(runs)?;
    create_aps_patch_with_records(n64_header, modified_len, records)
}

fn create_aps_patch_with_records(
    n64_header: Option<DetectedN64Header>,
    output_len: u64,
    records: Vec<ApsRecord>,
) -> Result<CreatedApsPatch> {
    let output_size = u32::try_from(output_len).map_err(|_| {
        RomWeaverError::Validation("APS output size exceeded 32-bit header range".into())
    })?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(APS_N64_MAGIC);
    bytes.push(if n64_header.is_some() {
        APS_N64_MODE
    } else {
        0
    });
    bytes.push(APS_DEFAULT_ENCODING_METHOD);

    let mut description = [0u8; APS_DESCRIPTION_SIZE];
    let description_bytes = APS_DEFAULT_DESCRIPTION.as_bytes();
    let description_len = description_bytes.len().min(description.len());
    description[..description_len].copy_from_slice(&description_bytes[..description_len]);
    bytes.extend_from_slice(&description);

    if let Some(n64_header) = n64_header {
        bytes.push(n64_header.original_format);
        bytes.extend_from_slice(&n64_header.cart_id);
        bytes.extend_from_slice(&n64_header.crc);
        bytes.extend_from_slice(&[0u8; 5]);
    }

    bytes.extend_from_slice(&output_size.to_le_bytes());
    for record in &records {
        match record {
            ApsRecord::Simple { offset, data } => {
                let offset_u32 = u32::try_from(*offset).map_err(|_| {
                    RomWeaverError::Validation("APS record offset exceeded 32-bit range".into())
                })?;
                if data.len() > APS_RECORD_MAX_DATA_LEN {
                    return Err(RomWeaverError::Validation(
                        "APS record length exceeded 255 bytes".into(),
                    ));
                }
                bytes.extend_from_slice(&offset_u32.to_le_bytes());
                bytes.push(data.len() as u8);
                bytes.extend_from_slice(data);
            }
            ApsRecord::Rle {
                offset,
                byte,
                length,
            } => {
                let offset_u32 = u32::try_from(*offset).map_err(|_| {
                    RomWeaverError::Validation("APS record offset exceeded 32-bit range".into())
                })?;
                bytes.extend_from_slice(&offset_u32.to_le_bytes());
                bytes.push(APS_RECORD_RLE);
                bytes.push(*byte);
                bytes.push(*length);
            }
        }
    }

    Ok(CreatedApsPatch {
        bytes,
        record_count: records.len(),
    })
}

#[cfg(test)]
fn detect_n64_header(original_path: &Path, original: &[u8]) -> Option<DetectedN64Header> {
    if original.len() < (APS_N64_CART_ID_OFFSET as usize + 3) || original.len() < 0x18 {
        return None;
    }
    if !original.starts_with(&[0x80, 0x37, 0x12, 0x40]) {
        return None;
    }

    let mut cart_id = [0u8; 3];
    cart_id.copy_from_slice(
        &original[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3],
    );
    let mut crc = [0u8; 8];
    crc.copy_from_slice(&original[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]);

    let original_format = original_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".v64"));
    Some(DetectedN64Header {
        original_format: if original_format { 0 } else { 1 },
        cart_id,
        crc,
    })
}

fn detect_n64_header_from_path(
    original_path: &Path,
    original_len: u64,
) -> Result<Option<DetectedN64Header>> {
    if original_len < APS_N64_CART_ID_OFFSET + 3 || original_len < 0x18 {
        return Ok(None);
    }
    let mut original = File::open(original_path)?;
    let mut magic = [0u8; 4];
    original.read_exact(&mut magic)?;
    if magic != [0x80, 0x37, 0x12, 0x40] {
        return Ok(None);
    }
    original.seek(SeekFrom::Start(APS_N64_CART_ID_OFFSET))?;
    let mut cart_id = [0u8; 3];
    original.read_exact(&mut cart_id)?;

    original.seek(SeekFrom::Start(APS_N64_CRC_OFFSET))?;
    let mut crc = [0u8; 8];
    original.read_exact(&mut crc)?;

    let original_format = original_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".v64"));
    Ok(Some(DetectedN64Header {
        original_format: if original_format { 0 } else { 1 },
        cart_id,
        crc,
    }))
}

struct DetectedN64Header {
    original_format: u8,
    cart_id: [u8; 3],
    crc: [u8; 8],
}

#[derive(Debug)]
struct ApsDiffRun {
    offset: u64,
    bytes: Vec<u8>,
}

impl ApsDiffRun {
    fn end(&self) -> Result<u64> {
        self.offset
            .checked_add(self.bytes.len() as u64)
            .ok_or_else(|| RomWeaverError::Validation("APS diff run offset overflowed".into()))
    }
}

impl AdjacentRun for ApsDiffRun {
    fn start(&self) -> u64 {
        self.offset
    }

    fn end(&self) -> Result<u64> {
        ApsDiffRun::end(self)
    }

    fn append(&mut self, next: Self) {
        self.bytes.extend_from_slice(&next.bytes);
    }
}

fn create_aps_patch_parallel(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<CreatedApsPatch> {
    let n64_header = detect_n64_header_from_path(original_path, original_len)?;
    let modified_len_usize = usize::try_from(modified_len).map_err(|_| {
        RomWeaverError::Validation("APS output size exceeded addressable memory".into())
    })?;
    let chunk_count = aps_create_chunk_count(modified_len_usize)?;

    if crate::create_exceeds_main_thread_cap(original_len.saturating_add(modified_len)) {
        info!(
            original_len,
            modified_len,
            "APS create: combined size exceeds in-memory limit; falling back to serial path"
        );
        return create_aps_patch_from_files(
            original_path,
            original_len,
            modified_path,
            modified_len,
            context,
        );
    }

    trace!(
        chunk_count,
        modified_len,
        pool_threads = pool.size(),
        "aps create parallel scan"
    );
    let chunk_runs = scan_create_chunks(
        crate::PatchCreateSources {
            original_path,
            original_len,
            modified_path,
            modified_len,
        },
        modified_len,
        APS_CREATE_CHUNK_BYTES as u64,
        chunk_count,
        pool,
        |start, original_bytes, modified_bytes| {
            context.cancel().check()?;
            collect_diff_runs_from_bytes(start, original_bytes, modified_bytes)
        },
        |chunk_index| {
            context.cancel().check()?;
            collect_diff_runs_for_chunk(
                chunk_index,
                original_path,
                original_len,
                modified_path,
                modified_len,
            )
        },
    )?;
    let runs = merge_adjacent_runs(chunk_runs)?;
    let records = encode_runs_as_aps_records(runs)?;
    create_aps_patch_with_records(n64_header, modified_len, records)
}

fn collect_diff_runs_for_chunk(
    chunk_index: usize,
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
) -> Result<Vec<ApsDiffRun>> {
    let start = u64::try_from(chunk_index)
        .ok()
        .and_then(|index| index.checked_mul(APS_CREATE_CHUNK_BYTES as u64))
        .ok_or_else(|| RomWeaverError::Validation("APS chunk offset overflowed".into()))?;
    if start >= modified_len {
        return Ok(Vec::new());
    }
    let end = start
        .saturating_add(APS_CREATE_CHUNK_BYTES as u64)
        .min(modified_len);
    let (original_bytes, modified_bytes) = crate::read_original_modified_chunk(
        original_path,
        original_len,
        modified_path,
        start,
        end,
    )?;
    collect_diff_runs_from_bytes(start, &original_bytes, &modified_bytes)
}

fn collect_diff_runs_from_bytes(
    start: u64,
    original_bytes: &[u8],
    modified_bytes: &[u8],
) -> Result<Vec<ApsDiffRun>> {
    let mut runs = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_bytes = Vec::<u8>::new();

    for (index, &target) in modified_bytes.iter().enumerate() {
        let source = original_bytes.get(index).copied().unwrap_or(0);
        if source == target {
            if !pending_bytes.is_empty() {
                runs.push(ApsDiffRun {
                    offset: pending_start.expect("pending start exists"),
                    bytes: std::mem::take(&mut pending_bytes),
                });
                pending_start = None;
            }
        } else {
            if pending_start.is_none() {
                pending_start = Some(start + index as u64);
            }
            pending_bytes.push(target);
        }
    }

    if !pending_bytes.is_empty() {
        runs.push(ApsDiffRun {
            offset: pending_start.expect("pending start exists"),
            bytes: pending_bytes,
        });
    }

    Ok(runs)
}

fn encode_runs_as_aps_records(runs: Vec<ApsDiffRun>) -> Result<Vec<ApsRecord>> {
    let mut records = Vec::<ApsRecord>::new();
    for run in runs {
        let mut cursor = 0usize;
        while cursor < run.bytes.len() {
            let next = (cursor + APS_RECORD_MAX_DATA_LEN).min(run.bytes.len());
            let slice = &run.bytes[cursor..next];
            let offset = run
                .offset
                .checked_add(cursor as u64)
                .ok_or_else(|| RomWeaverError::Validation("APS record offset overflowed".into()))?;
            if slice.len() > 2 && slice.iter().all(|byte| *byte == slice[0]) {
                let length = u8::try_from(slice.len()).map_err(|_| {
                    RomWeaverError::Validation("APS record length exceeded 255 bytes".into())
                })?;
                records.push(ApsRecord::Rle {
                    offset,
                    byte: slice[0],
                    length,
                });
            } else {
                records.push(ApsRecord::Simple {
                    offset,
                    data: slice.to_vec(),
                });
            }
            cursor = next;
        }
    }
    Ok(records)
}

fn decode_description(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\0', ' '])
        .to_string()
}

struct ApsFileParser<R> {
    reader: R,
    file_len: u64,
    offset: u64,
}

impl<R: Read> ApsFileParser<R> {
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
                "APS patch ended unexpectedly while reading {label}"
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

    fn read_u8(&mut self, label: &str) -> Result<u8> {
        Ok(self.read_exact(1, label)?[0])
    }

    fn read_u32_le(&mut self, label: &str) -> Result<u32> {
        let bytes = self.read_exact(4, label)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

#[cfg(test)]
fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| RomWeaverError::Validation("u32 read overflowed".into()))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| RomWeaverError::Validation("u32 read exceeded patch bounds".into()))?;
    let mut buf = [0u8; 4];
    buf.copy_from_slice(slice);
    Ok(u32::from_le_bytes(buf))
}

#[cfg(test)]
#[path = "../tests/unit/aps_n64.rs"]
mod tests;
