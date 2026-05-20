use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use memmap2::{Mmap, MmapOptions};
use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability,
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
        fs::copy(&request.input, &request.output)?;
        let thread_capability = aps_apply_thread_capability(patch.records.len());
        let planned_execution = context.plan_threads(thread_capability.clone());
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        output.set_len(patch.output_size)?;
        let execution = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let prepared =
                prepare_aps_writes_parallel(&patch.records, patch.output_size, &pool, context)?;
            apply_prepared_aps_writes(&mut output, &prepared)?;
            execution
        } else {
            apply_aps_records(&mut output, patch.output_size, &patch.records)?;
            planned_execution
        };
        output.flush()?;

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
                patch.records.len(),
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
        let original = map_file_read_only(&request.original)?;
        let modified = map_file_read_only(&request.modified)?;
        let thread_capability = aps_create_thread_capability(modified.len())?;
        let planned_execution = context.plan_threads(thread_capability.clone());
        let (execution, created) = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let created = create_aps_patch_parallel(
                &request.original,
                original.as_ref(),
                modified.as_ref(),
                &pool,
                context,
            )?;
            (execution, created)
        } else {
            let created =
                create_aps_patch_bytes(&request.original, original.as_ref(), modified.as_ref())?;
            (planned_execution, created)
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, created.bytes)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name, created.record_count
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

struct PreparedApsWrite {
    offset: u64,
    data: Vec<u8>,
}

fn aps_apply_thread_capability(record_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(record_count.max(1)))
}

fn aps_create_thread_capability(modified_len: usize) -> Result<ThreadCapability> {
    let chunk_count = aps_create_chunk_count(modified_len)?;
    Ok(ThreadCapability::parallel(Some(chunk_count.max(1))))
}

fn aps_create_chunk_count(modified_len: usize) -> Result<usize> {
    let chunk_count = if modified_len == 0 {
        1
    } else {
        modified_len.div_ceil(APS_CREATE_CHUNK_BYTES)
    };
    if chunk_count == 0 {
        return Err(RomWeaverError::Validation(
            "APS create chunk count resolved to zero".into(),
        ));
    }
    Ok(chunk_count)
}

fn parse_aps_file(path: &Path) -> Result<ParsedApsPatch> {
    let bytes = map_file_read_only(path)?;
    parse_aps_bytes(&bytes)
}

fn map_file_read_only(path: &Path) -> Result<Mmap> {
    let file = File::open(path)?;
    // SAFETY: The mapping is read-only and the file handle lives for map creation.
    let map = unsafe { MmapOptions::new().map(&file)? };
    Ok(map)
}

fn parse_aps_bytes(bytes: &[u8]) -> Result<ParsedApsPatch> {
    if bytes.len() < APS_N64_BASE_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "APS patch is too small to contain a valid header".into(),
        ));
    }
    if !bytes.starts_with(APS_N64_MAGIC) {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
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
) -> Result<Vec<PreparedApsWrite>> {
    pool.install(|| {
        records
            .par_iter()
            .map(|record| {
                context.cancel().check()?;
                prepare_aps_write(record, output_size)
            })
            .collect::<Result<Vec<_>>>()
    })
}

fn prepare_aps_write(record: &ApsRecord, output_size: u64) -> Result<PreparedApsWrite> {
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
            Ok(PreparedApsWrite {
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
            Ok(PreparedApsWrite {
                offset: *offset,
                data: vec![*byte; usize::from(*length)],
            })
        }
    }
}

fn apply_prepared_aps_writes(file: &mut File, writes: &[PreparedApsWrite]) -> Result<()> {
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        file.seek(SeekFrom::Start(write.offset))?;
        file.write_all(&write.data)?;
    }
    Ok(())
}

fn create_aps_patch_bytes(
    original_path: &Path,
    original: &[u8],
    modified: &[u8],
) -> Result<CreatedApsPatch> {
    let n64_header = detect_n64_header(original_path, original);
    let output_size = u32::try_from(modified.len()).map_err(|_| {
        RomWeaverError::Validation("APS output size exceeded 32-bit header range".into())
    })?;
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
            records.push(ApsRecord::Rle {
                offset,
                byte: repeated_byte,
                length: u8::try_from(different_data.len()).expect("record len bounded to 255"),
            });
        } else {
            records.push(ApsRecord::Simple {
                offset,
                data: different_data,
            });
        }
    }

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

fn create_aps_patch_parallel(
    original_path: &Path,
    original: &[u8],
    modified: &[u8],
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<CreatedApsPatch> {
    let n64_header = detect_n64_header(original_path, original);
    let output_size = u32::try_from(modified.len()).map_err(|_| {
        RomWeaverError::Validation("APS output size exceeded 32-bit header range".into())
    })?;
    let chunk_count = aps_create_chunk_count(modified.len())?;

    let chunk_runs = pool.install(|| {
        (0..chunk_count)
            .into_par_iter()
            .map(|chunk_index| {
                context.cancel().check()?;
                collect_diff_runs_for_chunk(chunk_index, original, modified)
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let runs = merge_diff_runs(chunk_runs)?;
    let records = encode_runs_as_aps_records(runs)?;

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

fn collect_diff_runs_for_chunk(
    chunk_index: usize,
    original: &[u8],
    modified: &[u8],
) -> Result<Vec<ApsDiffRun>> {
    let start = chunk_index
        .checked_mul(APS_CREATE_CHUNK_BYTES)
        .ok_or_else(|| RomWeaverError::Validation("APS chunk offset overflowed".into()))?;
    let end = start
        .saturating_add(APS_CREATE_CHUNK_BYTES)
        .min(modified.len());
    let mut cursor = start;
    let mut runs = Vec::new();

    while cursor < end {
        let source = original.get(cursor).copied().unwrap_or(0);
        let target = modified[cursor];
        if source == target {
            cursor += 1;
            continue;
        }

        let run_start = cursor;
        let mut run_bytes = Vec::new();
        while cursor < end {
            let source = original.get(cursor).copied().unwrap_or(0);
            let target = modified[cursor];
            if source == target {
                break;
            }
            run_bytes.push(target);
            cursor += 1;
        }

        runs.push(ApsDiffRun {
            offset: run_start as u64,
            bytes: run_bytes,
        });
    }

    Ok(runs)
}

fn merge_diff_runs(chunk_runs: Vec<Vec<ApsDiffRun>>) -> Result<Vec<ApsDiffRun>> {
    let mut merged = Vec::<ApsDiffRun>::new();
    for runs in chunk_runs {
        for run in runs {
            if let Some(last) = merged.last_mut() {
                if last.end()? == run.offset {
                    last.bytes.extend_from_slice(&run.bytes);
                    continue;
                }
            }
            merged.push(run);
        }
    }
    Ok(merged)
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
                records.push(ApsRecord::Rle {
                    offset,
                    byte: slice[0],
                    length: u8::try_from(slice.len()).expect("slice len is bounded to 255"),
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
        .trim_end_matches(|c| c == '\0' || c == ' ')
        .to_string()
}

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
mod tests {
    use std::fs;

    use rom_weaver_core::{
        PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    };

    use super::{
        APS_N64_CART_ID_OFFSET, APS_N64_CRC_OFFSET, APS_N64_MODE, ApsN64PatchHandler,
        create_aps_patch_bytes, parse_aps_bytes,
    };
    use crate::{
        APS,
        test_support::{TestDir, test_context_with_threads},
    };

    #[derive(Clone)]
    enum TestRecord {
        Simple { offset: u32, data: Vec<u8> },
        Rle { offset: u32, byte: u8, length: u8 },
    }

    #[derive(Clone)]
    struct TestN64Header {
        original_format: u8,
        cart_id: [u8; 3],
        crc: [u8; 8],
        pad: [u8; 5],
    }

    #[test]
    fn parse_rejects_invalid_header() {
        let mut bytes = vec![0u8; 61];
        bytes[..5].copy_from_slice(b"BAD10");
        let error = parse_aps_bytes(&bytes).expect_err("invalid header");
        assert!(error.to_string().contains("Patch header invalid"));
    }

    #[test]
    fn parse_reports_concrete_n64_validation_values() {
        let temp = TestDir::new();
        let patch_path = temp.child("inspect.aps");
        let patch = build_aps_patch(
            APS_N64_MODE,
            Some(TestN64Header {
                original_format: 1,
                cart_id: *b"ABC",
                crc: [1, 2, 3, 4, 5, 6, 7, 8],
                pad: [0; 5],
            }),
            0x100,
            vec![],
        );
        fs::write(&patch_path, patch).expect("fixture");

        let handler = ApsN64PatchHandler::new(&APS);
        let report = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect("parse report");

        assert!(report.label.contains("n64 source cart id ABC"));
        assert!(report.label.contains("n64 source crc 0102030405060708"));
    }

    #[test]
    fn apply_supports_simple_and_rle_records() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.aps");
        let output_path = temp.child("output.bin");

        fs::write(&input_path, b"abcdefghij").expect("fixture");
        let patch = build_aps_patch(
            0,
            None,
            10,
            vec![
                TestRecord::Simple {
                    offset: 1,
                    data: b"XY".to_vec(),
                },
                TestRecord::Rle {
                    offset: 4,
                    byte: b'Z',
                    length: 3,
                },
            ],
        );
        fs::write(&patch_path, patch).expect("fixture");

        let handler = ApsN64PatchHandler::new(&APS);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");
        assert!(
            report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );

        assert_eq!(fs::read(output_path).expect("output"), b"aXYdZZZhij");
    }

    #[test]
    fn apply_strict_rejects_mismatched_n64_source() {
        let temp = TestDir::new();
        let input_path = temp.child("input.z64");
        let patch_path = temp.child("update.aps");
        let output_path = temp.child("output.bin");

        let mut input = vec![0u8; 0x100];
        input[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
        input[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
            .copy_from_slice(b"BAD");
        input[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
            .copy_from_slice(&[0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
        fs::write(&input_path, input).expect("fixture");

        let patch = build_aps_patch(
            APS_N64_MODE,
            Some(TestN64Header {
                original_format: 1,
                cart_id: *b"ABC",
                crc: [1, 2, 3, 4, 5, 6, 7, 8],
                pad: [0; 5],
            }),
            0x100,
            vec![],
        );
        fs::write(&patch_path, patch).expect("fixture");

        let handler = ApsN64PatchHandler::new(&APS);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1)
                    .with_patch_checksum_validation(PatchChecksumValidation::Strict),
            )
            .expect_err("strict validation should fail");
        assert!(error.to_string().contains("Source ROM checksum mismatch"));
    }

    #[test]
    fn create_and_apply_round_trip_for_n64_source() {
        let temp = TestDir::new();
        let original_path = temp.child("original.z64");
        let modified_path = temp.child("modified.z64");
        let patch_path = temp.child("update.aps");
        let output_path = temp.child("output.z64");

        let mut original = vec![0u8; 0x200];
        for (index, byte) in original.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        original[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
        original[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
            .copy_from_slice(b"XYZ");
        original[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
            .copy_from_slice(&[0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0x16, 0x27]);
        let mut modified = original.clone();
        modified[0x20..0x28].fill(0xAA);
        modified[0x60] = 0x11;
        modified[0x61] = 0x22;
        modified[0x62] = 0x33;

        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = ApsN64PatchHandler::new(&APS);
        let create_report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "APS".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");
        assert_eq!(
            create_report
                .thread_execution
                .expect("thread execution")
                .requested_threads,
            8
        );

        let parsed = parse_aps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert_eq!(parsed.header_type, APS_N64_MODE);
        assert!(parsed.n64_header.is_some());
        assert!(!parsed.records.is_empty());

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 2)
                    .with_patch_checksum_validation(PatchChecksumValidation::Strict),
            )
            .expect("apply");
        assert!(
            report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );

        assert_eq!(fs::read(output_path).expect("output"), modified);
    }

    #[test]
    fn apply_with_overlapping_records_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("overlap.aps");
        let output_single = temp.child("output-single.bin");
        let output_parallel = temp.child("output-parallel.bin");

        fs::write(&input_path, b"0123456789").expect("fixture");
        let patch = build_aps_patch(
            0,
            None,
            10,
            vec![
                TestRecord::Simple {
                    offset: 2,
                    data: b"ABCD".to_vec(),
                },
                TestRecord::Simple {
                    offset: 4,
                    data: b"xy".to_vec(),
                },
                TestRecord::Rle {
                    offset: 7,
                    byte: b'Q',
                    length: 2,
                },
            ],
        );
        fs::write(&patch_path, patch).expect("fixture");

        let handler = ApsN64PatchHandler::new(&APS);
        let single_report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_single.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single-thread apply");
        let parallel_report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_parallel.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel apply");

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
        assert_eq!(fs::read(&output_single).expect("single"), b"01ABxy6QQ9");
        assert_eq!(fs::read(&output_parallel).expect("parallel"), b"01ABxy6QQ9");
        assert_eq!(
            fs::read(output_single).expect("single"),
            fs::read(output_parallel).expect("parallel")
        );
    }

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let original_path = temp.child("original.z64");
        let modified_path = temp.child("modified.z64");
        let patch_single = temp.child("single.aps");
        let patch_parallel = temp.child("parallel.aps");

        let size = (super::APS_CREATE_CHUNK_BYTES * 2) + 4096;
        let mut original = vec![0u8; size];
        for (index, byte) in original.iter_mut().enumerate() {
            *byte = ((index * 11 + (index >> 3)) & 0xFF) as u8;
        }
        original[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
        original[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
            .copy_from_slice(b"XYZ");
        original[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
            .copy_from_slice(&[0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0x16, 0x27]);
        let mut modified = original.clone();
        modified[0x2000..0x2100].fill(0x44);
        modified[super::APS_CREATE_CHUNK_BYTES - 8..super::APS_CREATE_CHUNK_BYTES + 8].fill(0xAA);
        modified[(super::APS_CREATE_CHUNK_BYTES * 2) + 64] ^= 0x5A;

        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = ApsN64PatchHandler::new(&APS);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_single.clone(),
                    format: "APS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_parallel.clone(),
                    format: "APS".into(),
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
            fs::read(patch_single).expect("single patch"),
            fs::read(patch_parallel).expect("parallel patch")
        );
    }

    #[test]
    fn create_matches_rompatcher_js_n64_fixture() {
        // Fixture generated from:
        // https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.aps_n64.js
        // using BinFile.js + APS.buildFromRoms(...).export(...).
        let original_path = std::path::Path::new("original.z64");
        let mut original = vec![0u8; 0x200];
        for (index, byte) in original.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        original[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
        original[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
            .copy_from_slice(b"XYZ");
        original[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
            .copy_from_slice(&[0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0x16, 0x27]);

        let mut modified = original.clone();
        modified[0x20..0x28].fill(0xAA);
        modified[0x60] = 0x11;
        modified[0x61] = 0x22;
        modified[0x62] = 0x33;

        let created =
            create_aps_patch_bytes(original_path, &original, &modified).expect("create fixture");
        let expected = hex_to_bytes(
            "415053313001006e6f206465736372697074696f6e0000000000000000000000000000000000000000000000000000000000000000000000000158595aa0b1c2d3e4f516270000000000000200002000000000aa086000000003112233",
        );

        assert_eq!(created.bytes, expected);
        assert_eq!(created.record_count, 2);
    }

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0, "hex fixture must have even length");
        let mut bytes = Vec::with_capacity(hex.len() / 2);
        for index in (0..hex.len()).step_by(2) {
            let byte = u8::from_str_radix(&hex[index..index + 2], 16).expect("valid hex fixture");
            bytes.push(byte);
        }
        bytes
    }

    fn build_aps_patch(
        header_type: u8,
        n64_header: Option<TestN64Header>,
        output_size: u32,
        records: Vec<TestRecord>,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"APS10");
        bytes.push(header_type);
        bytes.push(0);
        let mut description = [0u8; 50];
        let label = b"test patcher";
        description[..label.len()].copy_from_slice(label);
        bytes.extend_from_slice(&description);

        if let Some(n64_header) = n64_header {
            bytes.push(n64_header.original_format);
            bytes.extend_from_slice(&n64_header.cart_id);
            bytes.extend_from_slice(&n64_header.crc);
            bytes.extend_from_slice(&n64_header.pad);
        }

        bytes.extend_from_slice(&output_size.to_le_bytes());
        for record in records {
            match record {
                TestRecord::Simple { offset, data } => {
                    bytes.extend_from_slice(&offset.to_le_bytes());
                    bytes.push(data.len() as u8);
                    bytes.extend_from_slice(&data);
                }
                TestRecord::Rle {
                    offset,
                    byte,
                    length,
                } => {
                    bytes.extend_from_slice(&offset.to_le_bytes());
                    bytes.push(0);
                    bytes.push(byte);
                    bytes.push(length);
                }
            }
        }
        bytes
    }
}
