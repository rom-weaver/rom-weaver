use std::{
    fs::{self, File},
    io::{BufReader, Seek, SeekFrom, Write},
    path::Path,
};

use tracing::{debug, trace};

use rom_weaver_core::{
    FormatDescriptor, IoOp, IoResultExt, N64ByteOrder, OperationContext, OperationFamily,
    OperationReport, PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence, Result, RomWeaverError, SharedThreadPool,
    ThreadCapability, read_up_to,
};

#[cfg(test)]
use crate::shared::checked::read_u32_le;
use crate::shared::endpoints::{PatchEndpointSide, PatchEndpointVariant, attach_patch_endpoints};
use crate::shared::labeled_parser::LabeledFileParser;
use crate::shared::runs::{AdjacentRun, merge_adjacent_runs};
use crate::shared::threading::{
    PreparedWrite, apply_batched_writes, chunk_count_for_len_checked,
    parallel_per_record_capability, run_with_optional_pool, scan_create_chunks,
};

const APS_N64_MAGIC: &[u8; 5] = b"APS10";
const APS_SIMPLE_MODE: u8 = 0x00;
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
/// Bytes of a ROM that hold every field the type 1 header copies: cart ID, both country offsets
/// (0x3E, or 0x3F for byte-swapped ROMs) and the CRC at 0x10.
const APS_N64_ROM_HEADER_BYTES: usize = 0x40;
/// Original-format byte of a patch made from a byte-swapped (Doctor V64) ROM; every other ROM is 1.
const APS_N64_FORMAT_BYTE_SWAPPED: u8 = 0;
const APS_N64_FORMAT_OTHER: u8 = 1;
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
                "; n64 source cart id {}; n64 source country {}; n64 source crc {}",
                format_bytes_hex(&n64_header.cart_id),
                format_bytes_hex(&[n64_header.country]),
                format_bytes_hex(&n64_header.crc)
            )
        } else {
            String::new()
        };

        let mut report = OperationReport::succeeded(
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
        );
        // The N64 header carries cart-id/CRC bytes, not a whole-file checksum;
        // only the exact output size qualifies as an endpoint.
        attach_patch_endpoints(
            &mut report,
            self.descriptor.name,
            vec![PatchEndpointVariant::new(
                PatchEndpointSide::default(),
                PatchEndpointSide::sized(patch.output_size),
            )],
        );
        Ok(report)
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
        let validate_checksums = context.validate_source_checks();
        check_n64_source(&patch, &request.input, validate_checksums)?;

        let input_size = fs::metadata(&request.input)?.len();
        crate::ensure_plausible_output_size(
            self.descriptor.name,
            patch.output_size,
            input_size,
            patch_path,
        )?;
        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent).io_op(IoOp::CreateDir, parent)?;
        }
        let thread_capability = parallel_per_record_capability(patch.records.len());
        let in_memory = crate::can_apply_sparse_in_memory(
            context,
            input_size,
            patch.output_size,
            patch.records.len(),
            crate::SPARSE_STREAMING,
        );
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
            fs::write(&request.output, &output_bytes).io_op(IoOp::Create, &request.output)?;
            execution.force_serial();
            execution
        } else {
            let mut output = crate::copy_input_to_output(&request.input, &request.output)?;
            output.set_len(patch.output_size)?;
            let (execution, prepared) = run_with_optional_pool(
                context,
                thread_capability,
                true,
                |pool| Ok(Some(pool.clone())),
                || {
                    apply_aps_records(&mut output, patch.output_size, &patch.records)?;
                    Ok(None)
                },
            )?;
            if let Some(pool) = prepared {
                apply_aps_writes_parallel(
                    &patch.records,
                    patch.output_size,
                    &pool,
                    context,
                    &mut output,
                )?;
            }
            output.flush()?;
            execution
        };

        Ok(crate::shared::labels::patch_apply_report(
            self.descriptor,
            patch.records.len(),
            validate_checksums,
            execution,
        ))
    }

    fn validate(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch = parse_aps_file(patch_path)?;
        let validate_checksums = context.validate_source_checks();
        check_n64_source(&patch, &request.input, validate_checksums)?;
        crate::ensure_plausible_output_size(
            self.descriptor.name,
            patch.output_size,
            fs::metadata(&request.input)?.len(),
            patch_path,
        )?;
        for record in &patch.records {
            context.cancel().check()?;
            let _ = prepare_aps_write(record, patch.output_size)?;
        }

        Ok(crate::shared::labels::patch_validate_report(
            self.descriptor,
            patch.records.len(),
            validate_checksums,
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
            fs::create_dir_all(parent).io_op(IoOp::CreateDir, parent)?;
        }
        fs::write(&request.output, created.bytes).io_op(IoOp::Create, &request.output)?;

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

/// The type 1 header fields, in the z64 (Motorola) order the patch stores them.
#[derive(Debug)]
struct ApsN64Header {
    original_format: u8,
    cart_id: [u8; 2],
    country: u8,
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

    let mut parser =
        LabeledFileParser::new(BufReader::new(File::open(path)?), file_len, "APS", "u64");
    let prefix = parser.read_exact(APS_N64_PREFIX_SIZE, "APS header")?;
    let header_type = parse_aps_prefix(&prefix)?;

    let n64_header = if header_type == APS_N64_MODE {
        let extra = parser.read_exact(APS_N64_EXTRA_HEADER_SIZE, "APS N64 header")?;
        Some(parse_n64_extra_header(&extra)?)
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

/// Whether `path` parses completely as an N64 APS patch.
pub(crate) fn is_aps_n64_patch(path: &Path) -> bool {
    parse_aps_file(path).is_ok()
}

#[cfg(test)]
fn parse_aps_bytes(bytes: &[u8]) -> Result<ParsedApsPatch> {
    if bytes.len() < APS_N64_BASE_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "APS patch is too small to contain a valid header".into(),
        ));
    }
    let header_type = parse_aps_prefix(&bytes[..APS_N64_PREFIX_SIZE])?;

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

        let header = parse_n64_extra_header(&bytes[cursor..header_end])?;
        cursor = header_end;

        Some(header)
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

/// Checks the source ROM against a type 1 patch like `n64aps`. The original-format check ignores
/// `validate_checksums` because record offsets only hold in the byte order the patch was made from.
fn check_n64_source(
    patch: &ParsedApsPatch,
    input_path: &Path,
    validate_checksums: bool,
) -> Result<()> {
    let Some(expected) = &patch.n64_header else {
        return Ok(());
    };
    if patch.header_type != APS_N64_MODE {
        return Ok(());
    }
    let rom_head = read_up_to(File::open(input_path)?, APS_N64_ROM_HEADER_BYTES)?;
    let actual = n64_header_from_rom(&rom_head);
    trace!(
        patch_format = expected.original_format,
        rom_format = actual.original_format,
        validate_checksums,
        "aps n64 source header compared"
    );
    if actual.original_format != expected.original_format {
        return Err(RomWeaverError::coded(
            rom_weaver_core::ERROR_CODE_PATCH_CHECKSUM_MISMATCH,
            format!(
                "Source ROM checksum mismatch: the patch was made from a {} ROM but the source is {}; the original-format check cannot be disabled; {}",
                n64_format_name(expected.original_format),
                n64_format_name(actual.original_format),
                original_format_remedy(expected.original_format),
            ),
        ));
    }
    if !validate_checksums {
        return Ok(());
    }
    if rom_head.len() < APS_N64_ROM_HEADER_BYTES {
        return Err(RomWeaverError::coded(
            rom_weaver_core::ERROR_CODE_PATCH_CHECKSUM_MISMATCH,
            "Source ROM checksum mismatch: the source is too short to hold an N64 header",
        ));
    }
    if actual.cart_id != expected.cart_id {
        return Err(n64_field_mismatch(
            "cart ID",
            &expected.cart_id,
            &actual.cart_id,
        ));
    }
    if actual.country != expected.country {
        return Err(n64_field_mismatch(
            "country",
            &[expected.country],
            &[actual.country],
        ));
    }
    if actual.crc != expected.crc {
        return Err(n64_field_mismatch("CRC", &expected.crc, &actual.crc));
    }
    Ok(())
}

fn n64_field_mismatch(field: &str, expected: &[u8], actual: &[u8]) -> RomWeaverError {
    RomWeaverError::coded(
        rom_weaver_core::ERROR_CODE_PATCH_CHECKSUM_MISMATCH,
        format!(
            "Source ROM checksum mismatch: {field} is {} in the patch but {} in the source",
            format_bytes_hex(expected),
            format_bytes_hex(actual)
        ),
    )
}

fn n64_format_name(original_format: u8) -> &'static str {
    match original_format {
        APS_N64_FORMAT_BYTE_SWAPPED => "byte-swapped (v64)",
        APS_N64_FORMAT_OTHER => "non-v64",
        _ => "unknown-format",
    }
}

/// What to do when the source's byte order differs from a patch's original-format byte. Source
/// headers only ever read as v64 or non-v64, so a patch with any other byte matches no source.
fn original_format_remedy(original_format: u8) -> &'static str {
    match original_format {
        APS_N64_FORMAT_BYTE_SWAPPED => "rerun with --n64-byte-order byte-swapped",
        APS_N64_FORMAT_OTHER => "rerun with --n64-byte-order big-endian",
        _ => "the patch records an unknown original format that no source can match",
    }
}

/// Reads the type 1 header fields from the first bytes of a ROM the way `n64caps` and `n64aps`
/// do: a byte-swapped (v64) ROM has its 16-bit words swapped back, and its country sits at 0x3F
/// instead of 0x3E. Bytes missing from a short `rom_head` read as zero.
fn n64_header_from_rom(rom_head: &[u8]) -> ApsN64Header {
    let mut head = [0u8; APS_N64_ROM_HEADER_BYTES];
    let copy_len = rom_head.len().min(head.len());
    head[..copy_len].copy_from_slice(&rom_head[..copy_len]);
    let byte_swapped = N64ByteOrder::detect(&head) == Some(N64ByteOrder::ByteSwapped);
    let cart_offset = APS_N64_CART_ID_OFFSET as usize;
    let crc_offset = APS_N64_CRC_OFFSET as usize;

    let mut cart_id = [head[cart_offset], head[cart_offset + 1]];
    let mut crc = [0u8; 8];
    crc.copy_from_slice(&head[crc_offset..crc_offset + 8]);
    if byte_swapped {
        cart_id.swap(0, 1);
        for pair in crc.chunks_exact_mut(2) {
            pair.swap(0, 1);
        }
    }
    ApsN64Header {
        original_format: if byte_swapped {
            APS_N64_FORMAT_BYTE_SWAPPED
        } else {
            APS_N64_FORMAT_OTHER
        },
        cart_id,
        country: head[cart_offset + if byte_swapped { 3 } else { 2 }],
        crc,
    }
}

/// Validates the 57-byte standard header and returns the patch type. Like `n64aps`, only patch
/// type 0 or 1 with encoding method 0 is understood.
fn parse_aps_prefix(prefix: &[u8]) -> Result<u8> {
    if !prefix.starts_with(APS_N64_MAGIC) {
        return Err(crate::coded_validation(
            "APS_N64_HEADER_INVALID",
            "Patch header invalid",
        ));
    }
    let header_type = prefix[APS_N64_MAGIC.len()];
    if header_type != APS_SIMPLE_MODE && header_type != APS_N64_MODE {
        return Err(RomWeaverError::Validation(format!(
            "APS patch type {header_type} is not supported; expected 0 (simple) or 1 (N64)"
        )));
    }
    let encoding_method = prefix[APS_N64_MAGIC.len() + 1];
    if encoding_method != APS_DEFAULT_ENCODING_METHOD {
        return Err(RomWeaverError::Validation(format!(
            "APS encoding method {encoding_method} is not supported; expected 0"
        )));
    }
    Ok(header_type)
}

/// Splits the 17 bytes after the standard header: original format, cart ID, country, CRC, pad.
fn parse_n64_extra_header(extra: &[u8]) -> Result<ApsN64Header> {
    let truncated = || RomWeaverError::Validation("APS N64 header was truncated".into());
    Ok(ApsN64Header {
        original_format: *extra.first().ok_or_else(truncated)?,
        cart_id: extra
            .get(1..3)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(truncated)?,
        country: *extra.get(3).ok_or_else(truncated)?,
        crc: extra
            .get(4..12)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(truncated)?,
    })
}

fn apply_aps_records_in_memory(
    output_size: u64,
    records: &[ApsRecord],
    output: &mut [u8],
) -> Result<()> {
    for record in records {
        match record {
            ApsRecord::Simple { offset, data } => {
                // `offset` is u64: compute `end` in u64 with a checked add so a
                // wrapping `usize` add on wasm32 cannot produce `end < start` and
                // bypass the bounds check before slicing `output`.
                let data_len = u64::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation("APS record length exceeded u64".into())
                })?;
                let end = offset.checked_add(data_len).ok_or_else(|| {
                    RomWeaverError::Validation("APS record end overflowed".into())
                })?;
                if end > output_size {
                    return Err(RomWeaverError::Validation(
                        "APS record exceeded output size".into(),
                    ));
                }
                if !data.is_empty() {
                    let start = usize::try_from(*offset).map_err(|_| {
                        RomWeaverError::Validation(
                            "APS record offset exceeded addressable memory".into(),
                        )
                    })?;
                    let end = usize::try_from(end).map_err(|_| {
                        RomWeaverError::Validation(
                            "APS record end exceeded addressable memory".into(),
                        )
                    })?;
                    output[start..end].copy_from_slice(data);
                }
            }
            ApsRecord::Rle {
                offset,
                byte,
                length,
            } => {
                let end = offset.checked_add(u64::from(*length)).ok_or_else(|| {
                    RomWeaverError::Validation("APS RLE record end overflowed".into())
                })?;
                if end > output_size {
                    return Err(RomWeaverError::Validation(
                        "APS RLE record exceeded output size".into(),
                    ));
                }
                if *length > 0 {
                    let start = usize::try_from(*offset).map_err(|_| {
                        RomWeaverError::Validation(
                            "APS RLE record offset exceeded addressable memory".into(),
                        )
                    })?;
                    let end = usize::try_from(end).map_err(|_| {
                        RomWeaverError::Validation(
                            "APS RLE record end exceeded addressable memory".into(),
                        )
                    })?;
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

fn apply_aps_writes_parallel(
    records: &[ApsRecord],
    output_size: u64,
    pool: &SharedThreadPool,
    context: &OperationContext,
    output: &mut File,
) -> Result<()> {
    apply_batched_writes(
        output,
        records,
        Some(pool),
        |record| match record {
            ApsRecord::Simple { data, .. } => data.len(),
            ApsRecord::Rle { length, .. } => usize::from(*length),
        },
        |record, _range| {
            context.cancel().check()?;
            prepare_aps_write(record, output_size)
        },
    )
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
fn create_aps_patch_bytes(original: &[u8], modified: &[u8]) -> Result<CreatedApsPatch> {
    let n64_header = detect_n64_header(original);
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
    let n64_header = detect_n64_header_from_path(original_path)?;
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
    n64_header: Option<ApsN64Header>,
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
        APS_SIMPLE_MODE
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
        bytes.push(n64_header.country);
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

/// The type 1 header for an original whose content is a z64 or v64 ROM; `None` for anything else
/// (little-endian `.n64` dumps and non-ROM data), which get a type 0 patch.
fn detect_n64_header(original_head: &[u8]) -> Option<ApsN64Header> {
    let order = N64ByteOrder::detect(original_head)?;
    if order == N64ByteOrder::LittleEndian || original_head.len() < APS_N64_ROM_HEADER_BYTES {
        return None;
    }
    Some(n64_header_from_rom(original_head))
}

fn detect_n64_header_from_path(original_path: &Path) -> Result<Option<ApsN64Header>> {
    let original_head = read_up_to(File::open(original_path)?, APS_N64_ROM_HEADER_BYTES)?;
    Ok(detect_n64_header(&original_head))
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
    let n64_header = detect_n64_header_from_path(original_path)?;
    let modified_len_usize = usize::try_from(modified_len).map_err(|_| {
        RomWeaverError::Validation("APS output size exceeded addressable memory".into())
    })?;
    let chunk_count = aps_create_chunk_count(modified_len_usize)?;

    trace!(
        chunk_count,
        modified_len,
        pool_threads = pool.size(),
        "aps create parallel scan"
    );
    let chunk_runs = scan_create_chunks(chunk_count, pool, |chunk_index| {
        context.cancel().check()?;
        collect_diff_runs_for_chunk(
            chunk_index,
            original_path,
            original_len,
            modified_path,
            modified_len,
        )
    })?;
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

#[cfg(test)]
#[path = "../tests/unit/aps_n64.rs"]
mod tests;
