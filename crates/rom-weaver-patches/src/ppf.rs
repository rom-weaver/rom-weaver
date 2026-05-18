use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};

const PPF_HEADER_MIN_SIZE: usize = 56;
const PPF2_HEADER_SIZE: usize = 1084;
const PPF3_HEADER_BASE_SIZE: usize = 60;
const PPF_VALIDATION_BLOCK_SIZE: usize = 1024;
const PPF2_BLOCKCHECK_OFFSET: u64 = 0x9320;
const PPF3_BIN_BLOCKCHECK_OFFSET: u64 = 0x9320;
const PPF3_GI_BLOCKCHECK_OFFSET: u64 = 0x80A0;
const FILE_ID_BEGIN_MARKER: &[u8] = b"@BEGIN_FILE_ID.DIZ";
const FILE_ID_END_MARKER: &[u8] = b"@END_FILE_ID.DIZ";
const FILE_ID_TRAILER_MAGIC: &[u8; 4] = b".DIZ";
const PPF2_FILE_ID_OVERHEAD: usize = 38;
const PPF3_FILE_ID_OVERHEAD: usize = 36;
const PPF3_FILE_ID_PADDED_OVERHEAD: usize = 38;
const PPF3_DEFAULT_DESCRIPTION: &str = "rom-weaver PPF3 patch";
const PPF3_ENCODING_METHOD: u8 = 0x02;
const CREATE_COMPARE_BUFFER_SIZE: usize = 64 * 1024;

pub struct PpfPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl PpfPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for PpfPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let parsed = parse_ppf_file(patch_path)?;
        let mut label = format!(
            "parsed {} patch ({}) with {} record(s)",
            self.descriptor.name,
            parsed.version.label(),
            parsed.records.len()
        );
        if parsed.blockcheck.is_some() {
            label.push_str("; includes blockcheck validation bytes");
        }
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            label,
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
        let parsed = parse_ppf_file(patch_path)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let input_len = fs::metadata(&request.input)?.len();

        if let Some(expected_len) = parsed.expected_input_len {
            if input_len != expected_len {
                return Err(RomWeaverError::Validation(format!(
                    "PPF2 input size invalid; expected {expected_len}, got {input_len}"
                )));
            }
        }

        if validate_checksums {
            if let Some(blockcheck) = &parsed.blockcheck {
                validate_blockcheck(&request.input, blockcheck)?;
            }
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &request.output)?;

        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        let use_undo_data = should_apply_undo_data(&mut output, &parsed.records)?;
        apply_records(&mut output, &parsed.records, use_undo_data)?;
        output.flush()?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
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
                "applied {} patch ({}) with {} record(s){}",
                self.descriptor.name,
                parsed.version.label(),
                parsed.records.len(),
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        let created = create_ppf3_patch_streaming(
            &request.original,
            original_len,
            &request.modified,
            modified_len,
            &mut output,
        )?;
        output.flush()?;

        let blockcheck_label = if created.blockcheck_enabled {
            "with validation block"
        } else {
            "without validation block"
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch (PPF3) with {} record(s), {blockcheck_label}",
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
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PpfVersion {
    V1,
    V2,
    V3,
}

impl PpfVersion {
    fn label(self) -> &'static str {
        match self {
            Self::V1 => "PPF1",
            Self::V2 => "PPF2",
            Self::V3 => "PPF3",
        }
    }
}

#[derive(Debug)]
struct ParsedPpfPatch {
    version: PpfVersion,
    expected_input_len: Option<u64>,
    blockcheck: Option<PpfBlockcheck>,
    records: Vec<PpfRecord>,
}

#[derive(Debug)]
struct PpfBlockcheck {
    input_offset: u64,
    expected: Vec<u8>,
}

#[derive(Debug)]
struct PpfRecord {
    offset: u64,
    data: Vec<u8>,
    undo_data: Option<Vec<u8>>,
}

#[derive(Debug)]
struct CreatedPpfPatch {
    record_count: usize,
    blockcheck_enabled: bool,
}

fn parse_ppf_file(path: &Path) -> Result<ParsedPpfPatch> {
    let bytes = fs::read(path)?;
    parse_ppf_bytes(&bytes)
}

fn parse_ppf_bytes(bytes: &[u8]) -> Result<ParsedPpfPatch> {
    if bytes.len() < PPF_HEADER_MIN_SIZE {
        return Err(RomWeaverError::Validation(
            "PPF patch is too small to contain a valid header".into(),
        ));
    }

    let version = detect_version(bytes)?;
    match version {
        PpfVersion::V1 => parse_ppf_v1(bytes),
        PpfVersion::V2 => parse_ppf_v2(bytes),
        PpfVersion::V3 => parse_ppf_v3(bytes),
    }
}

fn create_ppf3_patch_streaming(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    output: &mut impl Write,
) -> Result<CreatedPpfPatch> {
    if modified_len < original_len {
        return Err(RomWeaverError::Validation(format!(
            "PPF create does not support shrinking outputs (original: {}, modified: {})",
            original_len, modified_len
        )));
    }

    let blockcheck_enabled = write_ppf3_header(output, original_path, original_len)?;
    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);

    let mut original_buffer = vec![0; CREATE_COMPARE_BUFFER_SIZE];
    let mut modified_buffer = vec![0; CREATE_COMPARE_BUFFER_SIZE];

    let mut remaining_modified = modified_len;
    let mut remaining_original = original_len;
    let mut offset = 0u64;
    let mut record_count = 0usize;
    let mut pending_start: Option<u64> = None;
    let mut pending_data = Vec::with_capacity(u8::MAX as usize);

    while remaining_modified > 0 {
        let chunk_len = usize::try_from(remaining_modified.min(CREATE_COMPARE_BUFFER_SIZE as u64))
            .map_err(|_| {
                RomWeaverError::Validation(
                    "PPF create chunk length exceeded platform limits".into(),
                )
            })?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        let original_chunk_len = usize::try_from(remaining_original.min(chunk_len as u64))
            .map_err(|_| {
                RomWeaverError::Validation(
                    "PPF create original chunk length exceeded platform limits".into(),
                )
            })?;
        if original_chunk_len > 0 {
            original.read_exact(&mut original_buffer[..original_chunk_len])?;
        }

        for index in 0..chunk_len {
            let modified_byte = modified_buffer[index];
            let differs = if index < original_chunk_len {
                original_buffer[index] != modified_byte
            } else {
                true
            };

            if differs {
                if pending_start.is_none() {
                    pending_start = Some(offset);
                }
                pending_data.push(modified_byte);
                if pending_data.len() == u8::MAX as usize {
                    let start = pending_start.expect("pending start set when pending data exists");
                    write_ppf3_record(output, start, &pending_data)?;
                    pending_data.clear();
                    pending_start = None;
                    record_count = record_count.saturating_add(1);
                }
            } else if !pending_data.is_empty() {
                let start = pending_start.expect("pending start set when pending data exists");
                write_ppf3_record(output, start, &pending_data)?;
                pending_data.clear();
                pending_start = None;
                record_count = record_count.saturating_add(1);
            }

            offset = offset
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PPF create offset overflowed".into()))?;
        }

        remaining_modified = remaining_modified
            .checked_sub(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("PPF create remaining underflowed".into()))?;
        remaining_original = remaining_original.saturating_sub(original_chunk_len as u64);
    }

    if !pending_data.is_empty() {
        let start = pending_start.expect("pending start set when pending data exists");
        write_ppf3_record(output, start, &pending_data)?;
        record_count = record_count.saturating_add(1);
    }

    Ok(CreatedPpfPatch {
        record_count,
        blockcheck_enabled,
    })
}

fn write_ppf3_header(
    output: &mut impl Write,
    original_path: &Path,
    original_len: u64,
) -> Result<bool> {
    let blockcheck_end = PPF3_BIN_BLOCKCHECK_OFFSET
        .checked_add(PPF_VALIDATION_BLOCK_SIZE as u64)
        .ok_or_else(|| RomWeaverError::Validation("PPF3 blockcheck range overflowed".into()))?;
    let blockcheck_enabled = original_len >= blockcheck_end;

    output.write_all(b"PPF30")?;
    output.write_all(&[PPF3_ENCODING_METHOD])?;

    let mut description = [0u8; 50];
    let description_bytes = PPF3_DEFAULT_DESCRIPTION.as_bytes();
    let description_len = description_bytes.len().min(description.len());
    description[..description_len].copy_from_slice(&description_bytes[..description_len]);
    output.write_all(&description)?;

    output.write_all(&[0])?;
    output.write_all(&[u8::from(blockcheck_enabled)])?;
    output.write_all(&[0])?;
    output.write_all(&[0])?;

    if blockcheck_enabled {
        let mut original = File::open(original_path)?;
        original.seek(SeekFrom::Start(PPF3_BIN_BLOCKCHECK_OFFSET))?;
        let mut block = [0u8; PPF_VALIDATION_BLOCK_SIZE];
        original.read_exact(&mut block)?;
        output.write_all(&block)?;
    }

    Ok(blockcheck_enabled)
}

fn write_ppf3_record(output: &mut impl Write, offset: u64, data: &[u8]) -> Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    if data.len() > u8::MAX as usize {
        return Err(RomWeaverError::Validation(
            "PPF3 record length exceeded 255 bytes".into(),
        ));
    }

    output.write_all(&offset.to_le_bytes())?;
    output.write_all(&[data.len() as u8])?;
    output.write_all(data)?;
    Ok(())
}

fn detect_version(bytes: &[u8]) -> Result<PpfVersion> {
    let magic = bytes
        .get(0..3)
        .ok_or_else(|| RomWeaverError::Validation("PPF patch header is truncated".into()))?;

    if magic != b"PPF" {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let version_digits = bytes.get(3..5).ok_or_else(|| {
        RomWeaverError::Validation("PPF patch version digits are truncated".into())
    })?;
    let version_from_digits = match version_digits {
        b"10" => PpfVersion::V1,
        b"20" => PpfVersion::V2,
        b"30" => PpfVersion::V3,
        _ => {
            return Err(RomWeaverError::Validation(
                "PPF patch version digits are invalid".into(),
            ));
        }
    };

    let version_from_method = match bytes.get(5).copied() {
        Some(0) => PpfVersion::V1,
        Some(1) => PpfVersion::V2,
        Some(2) => PpfVersion::V3,
        Some(_) => {
            return Err(RomWeaverError::Validation(
                "PPF patch encoding method is invalid".into(),
            ));
        }
        None => {
            return Err(RomWeaverError::Validation(
                "PPF patch encoding method is truncated".into(),
            ));
        }
    };

    if version_from_digits != version_from_method {
        return Err(RomWeaverError::Validation(
            "PPF patch version tuple is inconsistent".into(),
        ));
    }

    Ok(version_from_digits)
}

fn parse_ppf_v1(bytes: &[u8]) -> Result<ParsedPpfPatch> {
    let records = parse_records_v1_v2(bytes, PPF_HEADER_MIN_SIZE, bytes.len())?;
    Ok(ParsedPpfPatch {
        version: PpfVersion::V1,
        expected_input_len: None,
        blockcheck: None,
        records,
    })
}

fn parse_ppf_v2(bytes: &[u8]) -> Result<ParsedPpfPatch> {
    if bytes.len() < PPF2_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "PPF2 patch is too small to contain a validation header".into(),
        ));
    }

    let expected_input_len = u64::from(read_u32_le(bytes, 56)?);
    let file_id_len = detect_file_id_len_v2(bytes, PPF2_HEADER_SIZE)?;
    let payload_end = bytes.len().checked_sub(file_id_len).ok_or_else(|| {
        RomWeaverError::Validation("PPF2 file_id length exceeded file size".into())
    })?;
    if payload_end < PPF2_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "PPF2 payload ended before record data started".into(),
        ));
    }

    let records = parse_records_v1_v2(bytes, PPF2_HEADER_SIZE, payload_end)?;
    let expected = bytes[60..(60 + PPF_VALIDATION_BLOCK_SIZE)].to_vec();

    Ok(ParsedPpfPatch {
        version: PpfVersion::V2,
        expected_input_len: Some(expected_input_len),
        blockcheck: Some(PpfBlockcheck {
            input_offset: PPF2_BLOCKCHECK_OFFSET,
            expected,
        }),
        records,
    })
}

fn parse_ppf_v3(bytes: &[u8]) -> Result<ParsedPpfPatch> {
    if bytes.len() < PPF3_HEADER_BASE_SIZE {
        return Err(RomWeaverError::Validation(
            "PPF3 patch is too small to contain a valid header".into(),
        ));
    }

    let imagetype = bytes[56];
    let blockcheck_enabled = bytes[57] != 0;
    let undo_enabled = bytes[58] != 0;

    let (payload_start, blockcheck) = if blockcheck_enabled {
        if bytes.len() < PPF2_HEADER_SIZE {
            return Err(RomWeaverError::Validation(
                "PPF3 patch enabled blockcheck but omitted the validation block".into(),
            ));
        }
        let input_offset = if imagetype == 0 {
            PPF3_BIN_BLOCKCHECK_OFFSET
        } else {
            PPF3_GI_BLOCKCHECK_OFFSET
        };
        (
            PPF2_HEADER_SIZE,
            Some(PpfBlockcheck {
                input_offset,
                expected: bytes[60..(60 + PPF_VALIDATION_BLOCK_SIZE)].to_vec(),
            }),
        )
    } else {
        (PPF3_HEADER_BASE_SIZE, None)
    };

    let file_id_len = detect_file_id_len_v3(bytes, payload_start)?;
    let payload_end = bytes.len().checked_sub(file_id_len).ok_or_else(|| {
        RomWeaverError::Validation("PPF3 file_id length exceeded file size".into())
    })?;
    if payload_end < payload_start {
        return Err(RomWeaverError::Validation(
            "PPF3 payload ended before record data started".into(),
        ));
    }

    let records = parse_records_v3(bytes, payload_start, payload_end, undo_enabled)?;

    Ok(ParsedPpfPatch {
        version: PpfVersion::V3,
        expected_input_len: None,
        blockcheck,
        records,
    })
}

fn parse_records_v1_v2(bytes: &[u8], mut cursor: usize, end: usize) -> Result<Vec<PpfRecord>> {
    let mut records = Vec::new();
    while cursor < end {
        let header_end = cursor
            .checked_add(5)
            .ok_or_else(|| RomWeaverError::Validation("PPF record header overflowed".into()))?;
        if header_end > end {
            return Err(RomWeaverError::Validation(
                "PPF record header exceeded patch bounds".into(),
            ));
        }

        let offset = u64::from(read_u32_le(bytes, cursor)?);
        let len = usize::from(bytes[cursor + 4]);
        cursor = header_end;

        let data_end = cursor
            .checked_add(len)
            .ok_or_else(|| RomWeaverError::Validation("PPF record length overflowed".into()))?;
        if data_end > end {
            return Err(RomWeaverError::Validation(
                "PPF record data exceeded patch bounds".into(),
            ));
        }

        records.push(PpfRecord {
            offset,
            data: bytes[cursor..data_end].to_vec(),
            undo_data: None,
        });
        cursor = data_end;
    }

    Ok(records)
}

fn parse_records_v3(
    bytes: &[u8],
    mut cursor: usize,
    end: usize,
    undo_enabled: bool,
) -> Result<Vec<PpfRecord>> {
    let mut records = Vec::new();
    while cursor < end {
        let header_end = cursor
            .checked_add(9)
            .ok_or_else(|| RomWeaverError::Validation("PPF3 record header overflowed".into()))?;
        if header_end > end {
            return Err(RomWeaverError::Validation(
                "PPF3 record header exceeded patch bounds".into(),
            ));
        }

        let offset = read_u64_le(bytes, cursor)?;
        if offset > i64::MAX as u64 {
            return Err(RomWeaverError::Validation(
                "PPF3 record offset exceeded supported range".into(),
            ));
        }
        let len = usize::from(bytes[cursor + 8]);
        cursor = header_end;

        let data_end = cursor
            .checked_add(len)
            .ok_or_else(|| RomWeaverError::Validation("PPF3 record length overflowed".into()))?;
        if data_end > end {
            return Err(RomWeaverError::Validation(
                "PPF3 record data exceeded patch bounds".into(),
            ));
        }

        let data = bytes[cursor..data_end].to_vec();
        cursor = data_end;

        let undo_data = if undo_enabled {
            let undo_end = cursor
                .checked_add(len)
                .ok_or_else(|| RomWeaverError::Validation("PPF3 undo length overflowed".into()))?;
            if undo_end > end {
                return Err(RomWeaverError::Validation(
                    "PPF3 undo data exceeded patch bounds".into(),
                ));
            }
            let undo_data = bytes[cursor..undo_end].to_vec();
            cursor = undo_end;
            Some(undo_data)
        } else {
            None
        };

        records.push(PpfRecord {
            offset,
            data,
            undo_data,
        });
    }

    Ok(records)
}

fn detect_file_id_len_v2(bytes: &[u8], payload_start: usize) -> Result<usize> {
    detect_file_id_len(bytes, payload_start, FileIdTrailerKind::V2)
}

fn detect_file_id_len_v3(bytes: &[u8], payload_start: usize) -> Result<usize> {
    detect_file_id_len(bytes, payload_start, FileIdTrailerKind::V3)
}

fn detect_file_id_len(
    bytes: &[u8],
    payload_start: usize,
    kind: FileIdTrailerKind,
) -> Result<usize> {
    if let Some(file_id_len) = detect_file_id_len_from_markers(bytes, payload_start, kind)? {
        return Ok(file_id_len);
    }

    match kind {
        FileIdTrailerKind::V2 => {
            detect_file_id_len_from_footer_magic(bytes, 4, PPF2_FILE_ID_OVERHEAD, "PPF2")
        }
        FileIdTrailerKind::V3 => {
            let unpadded =
                detect_file_id_len_from_footer_magic(bytes, 2, PPF3_FILE_ID_OVERHEAD, "PPF3")?;
            if unpadded != 0 {
                return Ok(unpadded);
            }
            detect_file_id_len_from_footer_magic(bytes, 4, PPF3_FILE_ID_PADDED_OVERHEAD, "PPF3")
        }
    }
}

fn detect_file_id_len_from_markers(
    bytes: &[u8],
    payload_start: usize,
    kind: FileIdTrailerKind,
) -> Result<Option<usize>> {
    let Some(begin_offset) = rfind_subslice(bytes, FILE_ID_BEGIN_MARKER) else {
        return Ok(None);
    };
    if begin_offset < payload_start {
        return Ok(None);
    }

    let diz_start = begin_offset
        .checked_add(FILE_ID_BEGIN_MARKER.len())
        .ok_or_else(|| RomWeaverError::Validation("PPF file_id begin offset overflowed".into()))?;
    let Some(relative_end_offset) = find_subslice(&bytes[diz_start..], FILE_ID_END_MARKER) else {
        return Ok(None);
    };
    let end_offset = diz_start
        .checked_add(relative_end_offset)
        .ok_or_else(|| RomWeaverError::Validation("PPF file_id end offset overflowed".into()))?;
    let trailer_start = end_offset
        .checked_add(FILE_ID_END_MARKER.len())
        .ok_or_else(|| {
            RomWeaverError::Validation("PPF file_id trailer offset overflowed".into())
        })?;
    if trailer_start > bytes.len() {
        return Ok(None);
    }

    let diz_len = end_offset
        .checked_sub(diz_start)
        .ok_or_else(|| RomWeaverError::Validation("PPF file_id payload underflowed".into()))?;
    let trailer = &bytes[trailer_start..];

    let trailer_matches = match trailer.len() {
        2 => usize::from(read_u16_le(trailer, 0)?) == diz_len,
        4 => {
            let u32_len = usize::try_from(read_u32_le(trailer, 0)?).map_err(|_| {
                RomWeaverError::Validation("PPF file_id length exceeded platform limits".into())
            })?;
            let u16_len = usize::from(read_u16_le(trailer, 0)?);
            if kind == FileIdTrailerKind::V2 {
                u32_len == diz_len
            } else {
                u32_len == diz_len || (u16_len == diz_len && trailer[2] == 0 && trailer[3] == 0)
            }
        }
        _ => false,
    };

    if !trailer_matches {
        return Ok(None);
    }

    Ok(Some(bytes.len() - begin_offset))
}

fn detect_file_id_len_from_footer_magic(
    bytes: &[u8],
    length_size: usize,
    overhead: usize,
    label: &str,
) -> Result<usize> {
    let minimum = length_size
        .checked_add(FILE_ID_TRAILER_MAGIC.len())
        .ok_or_else(|| RomWeaverError::Validation("file_id footer size overflowed".into()))?;
    if bytes.len() < minimum {
        return Ok(0);
    }

    let magic_offset = bytes
        .len()
        .checked_sub(minimum)
        .ok_or_else(|| RomWeaverError::Validation("file_id footer offset overflowed".into()))?;
    if &bytes[magic_offset..magic_offset + FILE_ID_TRAILER_MAGIC.len()] != FILE_ID_TRAILER_MAGIC {
        return Ok(0);
    }

    let id_len = match length_size {
        2 => usize::from(read_u16_le(bytes, bytes.len() - 2)?),
        4 => usize::try_from(read_u32_le(bytes, bytes.len() - 4)?).map_err(|_| {
            RomWeaverError::Validation(format!("{label} file_id length exceeded platform limits"))
        })?,
        _ => {
            return Err(RomWeaverError::Validation(
                "unsupported file_id length field width".into(),
            ));
        }
    };

    let total = id_len
        .checked_add(overhead)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} file_id size overflowed")))?;
    if total > bytes.len() {
        return Err(RomWeaverError::Validation(format!(
            "{label} file_id length exceeded patch size"
        )));
    }

    Ok(total)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileIdTrailerKind {
    V2,
    V3,
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn rfind_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(haystack.len());
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn validate_blockcheck(input_path: &Path, blockcheck: &PpfBlockcheck) -> Result<()> {
    let mut input = File::open(input_path)?;
    input.seek(SeekFrom::Start(blockcheck.input_offset))?;

    let mut actual = vec![0; blockcheck.expected.len()];
    input.read_exact(&mut actual).map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            RomWeaverError::Validation(format!(
                "PPF validation block read exceeded input length at offset {}",
                blockcheck.input_offset
            ))
        } else {
            error.into()
        }
    })?;

    if actual != blockcheck.expected {
        return Err(RomWeaverError::Validation(
            "PPF binblock/patchvalidation failed".into(),
        ));
    }

    Ok(())
}

fn should_apply_undo_data(file: &mut File, records: &[PpfRecord]) -> Result<bool> {
    let Some(first_record) = records.first() else {
        return Ok(false);
    };
    if first_record.undo_data.is_none() {
        return Ok(false);
    }

    file.seek(SeekFrom::Start(first_record.offset))?;
    let mut current_bytes = vec![0u8; first_record.data.len()];
    if let Err(error) = file.read_exact(&mut current_bytes) {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            return Ok(false);
        }
        return Err(error.into());
    }

    Ok(current_bytes == first_record.data)
}

fn apply_records(file: &mut File, records: &[PpfRecord], use_undo_data: bool) -> Result<()> {
    for record in records {
        file.seek(SeekFrom::Start(record.offset))?;
        let payload = if use_undo_data {
            record.undo_data.as_deref().unwrap_or(&record.data)
        } else {
            &record.data
        };
        file.write_all(payload)?;
    }
    Ok(())
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| RomWeaverError::Validation("u16 read overflowed".into()))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| RomWeaverError::Validation("u16 read exceeded patch bounds".into()))?;
    let mut buf = [0u8; 2];
    buf.copy_from_slice(slice);
    Ok(u16::from_le_bytes(buf))
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

fn read_u64_le(bytes: &[u8], offset: usize) -> Result<u64> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| RomWeaverError::Validation("u64 read overflowed".into()))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| RomWeaverError::Validation("u64 read exceeded patch bounds".into()))?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(slice);
    Ok(u64::from_le_bytes(buf))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::{
        FILE_ID_BEGIN_MARKER, FILE_ID_END_MARKER, PPF_VALIDATION_BLOCK_SIZE,
        PPF2_BLOCKCHECK_OFFSET, PpfPatchHandler, PpfVersion, parse_ppf_bytes,
    };
    use crate::{
        PPF,
        test_support::{TestDir, test_context_with_threads},
    };

    #[derive(Clone)]
    struct V1V2Record {
        offset: u32,
        data: Vec<u8>,
    }

    #[derive(Clone)]
    struct V3Record {
        offset: u64,
        data: Vec<u8>,
        undo: Vec<u8>,
    }

    #[test]
    fn parse_and_apply_round_trip_for_ppf1() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ppf");
        let output_path = temp.child("output.bin");

        fs::write(&input_path, b"abcdefgh").expect("fixture");
        fs::write(
            &patch_path,
            build_ppf1_patch(
                "PPF1 test",
                vec![
                    V1V2Record {
                        offset: 2,
                        data: b"XYZ".to_vec(),
                    },
                    V1V2Record {
                        offset: 7,
                        data: b"!!!!".to_vec(),
                    },
                ],
            ),
        )
        .expect("fixture");

        let parsed = parse_ppf_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert_eq!(parsed.records.len(), 2);

        let handler = PpfPatchHandler::new(&PPF);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("apply");

        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        assert_eq!(fs::read(output_path).expect("output"), b"abXYZfg!!!!");
    }

    #[test]
    fn apply_round_trip_for_ppf2_with_validation() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ppf");
        let output_path = temp.child("output.bin");

        let mut input =
            vec![0u8; (PPF2_BLOCKCHECK_OFFSET as usize) + PPF_VALIDATION_BLOCK_SIZE + 32];
        for (index, byte) in input.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        fs::write(&input_path, &input).expect("fixture");

        let block = input[PPF2_BLOCKCHECK_OFFSET as usize
            ..PPF2_BLOCKCHECK_OFFSET as usize + PPF_VALIDATION_BLOCK_SIZE]
            .to_vec();

        fs::write(
            &patch_path,
            build_ppf2_patch(
                "PPF2 test",
                input.len() as u32,
                &block,
                vec![V1V2Record {
                    offset: 4,
                    data: b"ZZ".to_vec(),
                }],
            ),
        )
        .expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("apply");

        let mut expected = input;
        expected[4] = b'Z';
        expected[5] = b'Z';
        assert_eq!(fs::read(output_path).expect("output"), expected);
    }

    #[test]
    fn apply_rejects_ppf2_when_input_size_mismatches() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ppf");
        let output_path = temp.child("output.bin");

        let mut input =
            vec![0u8; (PPF2_BLOCKCHECK_OFFSET as usize) + PPF_VALIDATION_BLOCK_SIZE + 1];
        for (index, byte) in input.iter_mut().enumerate() {
            *byte = (index % 199) as u8;
        }
        fs::write(&input_path, &input).expect("fixture");
        let block = input[PPF2_BLOCKCHECK_OFFSET as usize
            ..PPF2_BLOCKCHECK_OFFSET as usize + PPF_VALIDATION_BLOCK_SIZE]
            .to_vec();

        fs::write(
            &patch_path,
            build_ppf2_patch(
                "PPF2 bad size",
                (input.len() as u32).saturating_add(1),
                &block,
                vec![V1V2Record {
                    offset: 0,
                    data: vec![0xFF],
                }],
            ),
        )
        .expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("apply should fail");

        assert!(error.to_string().contains("PPF2 input size invalid"));
    }

    #[test]
    fn apply_round_trip_for_ppf3_with_undo_and_blockcheck() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ppf");
        let output_path = temp.child("output.bin");

        let block_offset = 0x80A0usize;
        let mut input = vec![0u8; block_offset + PPF_VALIDATION_BLOCK_SIZE + 64];
        for (index, byte) in input.iter_mut().enumerate() {
            *byte = (index % 241) as u8;
        }
        fs::write(&input_path, &input).expect("fixture");

        let block = input[block_offset..block_offset + PPF_VALIDATION_BLOCK_SIZE].to_vec();

        fs::write(
            &patch_path,
            build_ppf3_patch(
                "PPF3 test",
                1,
                true,
                true,
                Some(&block),
                vec![V3Record {
                    offset: 3,
                    data: b"PATCH".to_vec(),
                    undo: b"-----".to_vec(),
                }],
            ),
        )
        .expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 3),
            )
            .expect("apply");

        let mut expected = input;
        expected[3..8].copy_from_slice(b"PATCH");
        assert_eq!(fs::read(output_path).expect("output"), expected);
    }

    #[test]
    fn apply_uses_undo_data_when_reapplying_ppf3_undo_patch() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ppf");
        let once_path = temp.child("once.bin");
        let twice_path = temp.child("twice.bin");

        let original = b"abcdefghij".to_vec();
        fs::write(&input_path, &original).expect("fixture");
        fs::write(
            &patch_path,
            build_ppf3_patch(
                "PPF3 undo test",
                0,
                false,
                true,
                None,
                vec![V3Record {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                    undo: b"cde".to_vec(),
                }],
            ),
        )
        .expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: once_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("first apply");
        assert_eq!(fs::read(&once_path).expect("first output"), b"abXYZfghij");

        handler
            .apply(
                &PatchApplyRequest {
                    input: once_path,
                    patches: vec![patch_path],
                    output: twice_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("second apply");
        assert_eq!(fs::read(twice_path).expect("second output"), original);
    }

    #[test]
    fn parse_rejects_truncated_ppf3_record() {
        let mut patch = build_ppf3_patch(
            "bad",
            0,
            false,
            false,
            None,
            vec![V3Record {
                offset: 0,
                data: vec![1, 2, 3],
                undo: Vec::new(),
            }],
        );
        patch.pop();

        let error = parse_ppf_bytes(&patch).expect_err("truncated record should fail");
        assert!(
            error
                .to_string()
                .contains("PPF3 record data exceeded patch bounds")
        );
    }

    #[test]
    fn parse_accepts_ppf3_with_rompatcher_style_file_id_diz_trailer() {
        let mut patch = build_ppf3_patch(
            "with file id",
            0,
            false,
            false,
            None,
            vec![V3Record {
                offset: 1,
                data: b"AB".to_vec(),
                undo: Vec::new(),
            }],
        );
        append_rompatcher_file_id_diz_trailer(&mut patch, "hello from file id");

        let parsed = parse_ppf_bytes(&patch).expect("parse should succeed");
        assert_eq!(parsed.version, PpfVersion::V3);
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].offset, 1);
        assert_eq!(parsed.records[0].data, b"AB");
    }

    #[test]
    fn parse_rejects_inconsistent_version_tuple() {
        let mut patch = build_ppf1_patch("bad version", Vec::new());
        patch[5] = 2;

        let error = parse_ppf_bytes(&patch).expect_err("inconsistent tuple should fail");
        assert!(error.to_string().contains("version tuple is inconsistent"));
    }

    #[test]
    fn create_and_apply_round_trip_for_ppf3() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.ppf");
        let output_path = temp.child("output.bin");

        let original = b"hello old world".to_vec();
        let mut modified = b"hello new world".to_vec();
        modified.extend_from_slice(&[0, 0, 0]);
        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        let create_report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "PPF".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");
        let execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        let parsed = parse_ppf_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert_eq!(parsed.version, PpfVersion::V3);
        assert!(!parsed.records.is_empty());

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), modified);
    }

    #[test]
    fn create_enables_blockcheck_when_source_is_large_enough() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.ppf");

        let min_len = (PPF2_BLOCKCHECK_OFFSET as usize) + PPF_VALIDATION_BLOCK_SIZE + 8;
        let mut original = vec![0u8; min_len];
        for (index, byte) in original.iter_mut().enumerate() {
            *byte = (index % 239) as u8;
        }
        let mut modified = original.clone();
        modified[4] = modified[4].wrapping_add(1);

        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "PPF".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let parsed = parse_ppf_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert_eq!(parsed.version, PpfVersion::V3);
        assert!(parsed.blockcheck.is_some());
    }

    #[test]
    fn create_splits_runs_larger_than_u8_max() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.ppf");

        let original = vec![0u8; 1024];
        let modified = vec![0xAB; 1024];
        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "PPF".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let parsed = parse_ppf_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert_eq!(parsed.version, PpfVersion::V3);
        assert_eq!(parsed.records.len(), 5);
        assert_eq!(parsed.records[0].offset, 0);
        assert_eq!(parsed.records[0].data.len(), 255);
        assert_eq!(parsed.records[4].offset, 1020);
        assert_eq!(parsed.records[4].data.len(), 4);
    }

    #[test]
    fn create_rejects_shrinking_outputs() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.ppf");
        fs::write(&original_path, b"abcdef").expect("fixture");
        fs::write(&modified_path, b"abc").expect("fixture");

        let handler = PpfPatchHandler::new(&PPF);
        let error = handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_path,
                    format: "PPF".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("create should fail");

        assert!(
            error
                .to_string()
                .contains("does not support shrinking outputs")
        );
    }

    fn build_ppf1_patch(description: &str, records: Vec<V1V2Record>) -> Vec<u8> {
        let mut bytes = build_header(PpfHeaderVersion::V1, description, 0);
        push_v1_v2_records(&mut bytes, records);
        bytes
    }

    fn build_ppf2_patch(
        description: &str,
        expected_len: u32,
        block: &[u8],
        records: Vec<V1V2Record>,
    ) -> Vec<u8> {
        assert_eq!(block.len(), PPF_VALIDATION_BLOCK_SIZE);
        let mut bytes = build_header(PpfHeaderVersion::V2, description, 1);
        bytes.extend_from_slice(&expected_len.to_le_bytes());
        bytes.extend_from_slice(block);
        push_v1_v2_records(&mut bytes, records);
        bytes
    }

    fn build_ppf3_patch(
        description: &str,
        imagetype: u8,
        blockcheck: bool,
        undo: bool,
        block: Option<&[u8]>,
        records: Vec<V3Record>,
    ) -> Vec<u8> {
        let mut bytes = build_header(PpfHeaderVersion::V3, description, 2);
        bytes.push(imagetype);
        bytes.push(u8::from(blockcheck));
        bytes.push(u8::from(undo));
        bytes.push(0);

        if blockcheck {
            let block = block.expect("blockcheck bytes");
            assert_eq!(block.len(), PPF_VALIDATION_BLOCK_SIZE);
            bytes.extend_from_slice(block);
        }

        for record in records {
            bytes.extend_from_slice(&record.offset.to_le_bytes());
            bytes.push(record.data.len() as u8);
            bytes.extend_from_slice(&record.data);
            if undo {
                assert_eq!(record.undo.len(), record.data.len());
                bytes.extend_from_slice(&record.undo);
            }
        }

        bytes
    }

    fn push_v1_v2_records(bytes: &mut Vec<u8>, records: Vec<V1V2Record>) {
        for record in records {
            bytes.extend_from_slice(&record.offset.to_le_bytes());
            bytes.push(record.data.len() as u8);
            bytes.extend_from_slice(&record.data);
        }
    }

    #[derive(Clone, Copy)]
    enum PpfHeaderVersion {
        V1,
        V2,
        V3,
    }

    fn build_header(version: PpfHeaderVersion, description: &str, method: u8) -> Vec<u8> {
        let version_digit = match version {
            PpfHeaderVersion::V1 => b'1',
            PpfHeaderVersion::V2 => b'2',
            PpfHeaderVersion::V3 => b'3',
        };

        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"PPF");
        bytes.push(version_digit);
        bytes.push(b'0');
        bytes.push(method);
        let mut desc = [0u8; 50];
        let src = description.as_bytes();
        let copy_len = src.len().min(desc.len());
        desc[..copy_len].copy_from_slice(&src[..copy_len]);
        bytes.extend_from_slice(&desc);
        bytes
    }

    fn append_rompatcher_file_id_diz_trailer(bytes: &mut Vec<u8>, diz: &str) {
        bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
        bytes.extend_from_slice(diz.as_bytes());
        bytes.extend_from_slice(FILE_ID_END_MARKER);

        let diz_len = u16::try_from(diz.len()).expect("diz length must fit u16");
        bytes.extend_from_slice(&diz_len.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
}
