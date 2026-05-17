use std::{
    cmp::min,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use md5::{Digest, Md5};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};

const RUP_MAGIC: &[u8; 6] = b"NINJA2";
const RUP_HEADER_SIZE: usize = 0x800;
const RUP_COMMAND_END: u8 = 0x00;
const RUP_COMMAND_OPEN_NEW_FILE: u8 = 0x01;
const RUP_COMMAND_XOR_RECORD: u8 = 0x02;
const RUP_IO_BUFFER_SIZE: usize = 64 * 1024;

const AUTHOR_LEN: usize = 84;
const VERSION_LEN: usize = 11;
const TITLE_LEN: usize = 256;
const GENRE_LEN: usize = 48;
const LANGUAGE_LEN: usize = 48;
const DATE_LEN: usize = 8;
const WEB_LEN: usize = 512;
const DESCRIPTION_LEN: usize = 1074;

pub struct RupPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl RupPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for RupPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_rup_file(patch_path)?;
        let record_count = patch
            .files
            .iter()
            .map(|file| file.records.len())
            .sum::<usize>();
        let mut label = format!(
            "parsed {} patch with {} file variant(s) and {} record(s)",
            self.descriptor.name,
            patch.files.len(),
            record_count
        );
        if patch.files.len() == 1 {
            let file = &patch.files[0];
            label.push_str(&format!(
                "; source md5 {}; target md5 {}",
                format_md5_hex(file.source_md5),
                format_md5_hex(file.target_md5)
            ));
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
        if request.patches.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} apply expects exactly one patch file",
                self.descriptor.name
            )));
        }

        let patch = parse_rup_file(&request.patches[0])?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let input_md5 = md5_file(&request.input)?;

        let (file, undo) = if let Some(selected) = select_matching_file(&patch, input_md5) {
            selected
        } else if !validate_checksums {
            match patch.files.as_slice() {
                [single] => (single, false),
                _ => {
                    return Err(RomWeaverError::Validation(
                        "RUP checksum validation is disabled, but patch has multiple file variants so input direction is ambiguous".into(),
                    ));
                }
            }
        } else {
            return Err(RomWeaverError::Validation(format!(
                "RUP input validation failed; no file entry matched input MD5 {}",
                format_md5_hex(input_md5)
            )));
        };

        let output_size = if undo {
            file.source_file_size
        } else {
            file.target_file_size
        };
        let output_len = usize::try_from(output_size).map_err(|_| {
            RomWeaverError::Validation("RUP output size exceeded addressable memory".into())
        })?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &request.output)?;
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        output.set_len(output_size)?;
        apply_xor_records_in_place(file, output_len, &mut output)?;
        apply_overflow_in_place(file, undo, output_len, &mut output)?;
        output.flush()?;

        if validate_checksums {
            let expected_md5 = if undo {
                file.source_md5
            } else {
                file.target_md5
            };
            let actual_md5 = md5_file(&request.output)?;
            if actual_md5 != expected_md5 {
                return Err(RomWeaverError::Validation(format!(
                    "RUP target checksum mismatch; expected {}, got {}",
                    format_md5_hex(expected_md5),
                    format_md5_hex(actual_md5)
                )));
            }
        }

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
                if undo { "undo" } else { "forward" },
                file.records.len(),
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

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let created = create_rup_patch_streaming(&request.original, &request.modified)?;
        fs::write(&request.output, &created.bytes)?;

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
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Debug)]
struct ParsedRupPatch {
    files: Vec<RupFile>,
}

#[derive(Debug, Default)]
struct RupMetadata {
    text_encoding: u8,
    author: String,
    version: String,
    title: String,
    genre: String,
    language: String,
    date: String,
    web: String,
    description: String,
}

#[derive(Debug)]
struct RupFile {
    file_name: String,
    rom_type: u8,
    source_file_size: u64,
    target_file_size: u64,
    source_md5: [u8; 16],
    target_md5: [u8; 16],
    overflow_mode: Option<RupOverflowMode>,
    overflow_data: Vec<u8>,
    records: Vec<RupRecord>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RupOverflowMode {
    Append,
    Minify,
}

#[derive(Debug)]
struct RupRecord {
    offset: u64,
    xor: Vec<u8>,
}

#[derive(Debug)]
struct CreatedRupPatch {
    bytes: Vec<u8>,
    record_count: usize,
}

fn parse_rup_file(path: &Path) -> Result<ParsedRupPatch> {
    let bytes = fs::read(path)?;
    parse_rup_bytes(&bytes)
}

fn parse_rup_bytes(bytes: &[u8]) -> Result<ParsedRupPatch> {
    if bytes.len() < RUP_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "RUP patch is too small to contain a valid header".into(),
        ));
    }

    let mut parser = RupParser::new(bytes);
    if parser.read_exact(RUP_MAGIC.len())? != RUP_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let _metadata = RupMetadata {
        text_encoding: parser.read_u8()?,
        author: parser.read_fixed_string(AUTHOR_LEN)?,
        version: parser.read_fixed_string(VERSION_LEN)?,
        title: parser.read_fixed_string(TITLE_LEN)?,
        genre: parser.read_fixed_string(GENRE_LEN)?,
        language: parser.read_fixed_string(LANGUAGE_LEN)?,
        date: parser.read_fixed_string(DATE_LEN)?,
        web: parser.read_fixed_string(WEB_LEN)?,
        description: parser
            .read_fixed_string(DESCRIPTION_LEN)?
            .replace(r"\n", "\n"),
    };

    if parser.offset != RUP_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "RUP header size validation failed".into(),
        ));
    }

    let mut files = Vec::new();
    let mut next_file: Option<RupFile> = None;
    let mut found_end = false;

    while !parser.is_at_end() {
        let command = parser.read_u8()?;
        match command {
            RUP_COMMAND_OPEN_NEW_FILE => {
                if let Some(file) = next_file.take() {
                    files.push(file);
                }

                let file_name_len = usize_from_u64(parser.read_vlv()?, "RUP file name length")?;
                let file_name = parser.read_fixed_string(file_name_len)?;
                let rom_type = parser.read_u8()?;
                let source_file_size = parser.read_vlv()?;
                let target_file_size = parser.read_vlv()?;
                let source_md5 = parser.read_u128_md5()?;
                let target_md5 = parser.read_u128_md5()?;

                let mut overflow_mode = None;
                let mut overflow_data = Vec::new();
                if source_file_size != target_file_size {
                    let mode_byte = parser.read_u8()?;
                    overflow_mode = Some(match mode_byte {
                        b'A' => RupOverflowMode::Append,
                        b'M' => RupOverflowMode::Minify,
                        _ => {
                            return Err(RomWeaverError::Validation(
                                "RUP patch contains an invalid overflow mode".into(),
                            ));
                        }
                    });
                    let overflow_len = usize_from_u64(parser.read_vlv()?, "RUP overflow length")?;
                    overflow_data = parser.read_exact(overflow_len)?.to_vec();
                }

                next_file = Some(RupFile {
                    file_name,
                    rom_type,
                    source_file_size,
                    target_file_size,
                    source_md5,
                    target_md5,
                    overflow_mode,
                    overflow_data,
                    records: Vec::new(),
                });
            }
            RUP_COMMAND_XOR_RECORD => {
                let Some(file) = next_file.as_mut() else {
                    return Err(RomWeaverError::Validation(
                        "RUP patch contains an XOR record before any file header".into(),
                    ));
                };

                let offset = parser.read_vlv()?;
                let xor_len = usize_from_u64(parser.read_vlv()?, "RUP XOR record length")?;
                let xor = parser.read_exact(xor_len)?.to_vec();
                file.records.push(RupRecord { offset, xor });
            }
            RUP_COMMAND_END => {
                if let Some(file) = next_file.take() {
                    files.push(file);
                }
                found_end = true;
                break;
            }
            _ => {
                return Err(RomWeaverError::Validation(
                    "RUP patch contains an invalid command".into(),
                ));
            }
        }
    }

    if !found_end {
        return Err(RomWeaverError::Validation(
            "RUP patch is missing the end command".into(),
        ));
    }

    Ok(ParsedRupPatch { files })
}

fn select_matching_file(patch: &ParsedRupPatch, input_md5: [u8; 16]) -> Option<(&RupFile, bool)> {
    for file in &patch.files {
        if file.source_md5 == input_md5 || file.target_md5 == input_md5 {
            return Some((file, file.target_md5 == input_md5));
        }
    }
    None
}

fn apply_xor_records_in_place(file: &RupFile, output_len: usize, output: &mut File) -> Result<()> {
    let mut buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    for record in &file.records {
        let start = usize_from_u64(record.offset, "RUP record offset")?;
        let end = start
            .checked_add(record.xor.len())
            .ok_or_else(|| RomWeaverError::Validation("RUP record length overflowed".into()))?;

        if end > output_len {
            return Err(RomWeaverError::Validation(
                "RUP record exceeded declared output size".into(),
            ));
        }

        let mut remaining = record.xor.len();
        let mut xor_cursor = 0usize;
        let mut write_offset = record.offset;
        while remaining > 0 {
            let chunk_len = remaining.min(buffer.len());
            output.seek(SeekFrom::Start(write_offset))?;
            output.read_exact(&mut buffer[..chunk_len])?;
            for (index, byte) in buffer[..chunk_len].iter_mut().enumerate() {
                *byte ^= record.xor[xor_cursor + index];
            }
            output.seek(SeekFrom::Start(write_offset))?;
            output.write_all(&buffer[..chunk_len])?;

            write_offset = write_offset
                .checked_add(chunk_len as u64)
                .ok_or_else(|| RomWeaverError::Validation("RUP output offset overflowed".into()))?;
            xor_cursor = xor_cursor
                .checked_add(chunk_len)
                .ok_or_else(|| RomWeaverError::Validation("RUP xor cursor overflowed".into()))?;
            remaining -= chunk_len;
        }
    }
    Ok(())
}

fn apply_overflow_in_place(
    file: &RupFile,
    undo: bool,
    output_len: usize,
    output: &mut File,
) -> Result<()> {
    let Some(mode) = file.overflow_mode else {
        return Ok(());
    };

    let should_apply = match mode {
        RupOverflowMode::Append => !undo,
        RupOverflowMode::Minify => undo,
    };

    if !should_apply {
        return Ok(());
    }

    let start_offset = match mode {
        RupOverflowMode::Append => file.source_file_size,
        RupOverflowMode::Minify => file.target_file_size,
    };
    let start = usize_from_u64(start_offset, "RUP overflow start offset")?;
    let end = start
        .checked_add(file.overflow_data.len())
        .ok_or_else(|| RomWeaverError::Validation("RUP overflow length overflowed".into()))?;

    if end > output_len {
        return Err(RomWeaverError::Validation(
            "RUP overflow data exceeded declared output size".into(),
        ));
    }

    output.seek(SeekFrom::Start(start_offset))?;
    let mut decoded = vec![0u8; RUP_IO_BUFFER_SIZE];
    let mut cursor = 0usize;
    while cursor < file.overflow_data.len() {
        let chunk_len = (file.overflow_data.len() - cursor).min(decoded.len());
        for (index, byte) in decoded[..chunk_len].iter_mut().enumerate() {
            *byte = file.overflow_data[cursor + index] ^ 0xff;
        }
        output.write_all(&decoded[..chunk_len])?;
        cursor += chunk_len;
    }

    Ok(())
}

#[allow(dead_code)]
fn create_rup_patch_bytes(original: &[u8], modified: &[u8]) -> Result<CreatedRupPatch> {
    let source_file_size = u64::try_from(original.len())
        .map_err(|_| RomWeaverError::Validation("RUP source size exceeded u64".into()))?;
    let target_file_size = u64::try_from(modified.len())
        .map_err(|_| RomWeaverError::Validation("RUP target size exceeded u64".into()))?;

    let source_md5 = md5_bytes(original);
    let target_md5 = md5_bytes(modified);

    let shared_len = min(original.len(), modified.len());
    let records = build_xor_records(&original[..shared_len], &modified[..shared_len])?;

    let (overflow_mode, overflow_data) = if original.len() < modified.len() {
        (
            Some(RupOverflowMode::Append),
            modified[original.len()..]
                .iter()
                .copied()
                .map(|byte| byte ^ 0xff)
                .collect::<Vec<_>>(),
        )
    } else if original.len() > modified.len() {
        (
            Some(RupOverflowMode::Minify),
            original[modified.len()..]
                .iter()
                .copied()
                .map(|byte| byte ^ 0xff)
                .collect::<Vec<_>>(),
        )
    } else {
        (None, Vec::new())
    };

    let metadata = RupMetadata {
        date: current_utc_yyyymmdd(),
        ..RupMetadata::default()
    };

    let file = RupFile {
        file_name: String::new(),
        rom_type: 0,
        source_file_size,
        target_file_size,
        source_md5,
        target_md5,
        overflow_mode,
        overflow_data,
        records,
    };

    let bytes = encode_rup_patch(&metadata, &[file])?;
    let record_count = bytes_record_count(&bytes)?;

    Ok(CreatedRupPatch {
        bytes,
        record_count,
    })
}

fn create_rup_patch_streaming(
    original_path: &Path,
    modified_path: &Path,
) -> Result<CreatedRupPatch> {
    let source_file_size = fs::metadata(original_path)?.len();
    let target_file_size = fs::metadata(modified_path)?.len();
    let shared_len = min(source_file_size, target_file_size);

    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    let mut source_md5 = Md5::new();
    let mut target_md5 = Md5::new();
    let mut source_buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; RUP_IO_BUFFER_SIZE];

    let mut records = Vec::<RupRecord>::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_xor = Vec::<u8>::new();
    let mut offset = 0u64;
    while offset < shared_len {
        let chunk_len = usize::try_from((shared_len - offset).min(RUP_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("RUP chunk length exceeded usize".into()))?;
        original.read_exact(&mut source_buffer[..chunk_len])?;
        modified.read_exact(&mut target_buffer[..chunk_len])?;
        source_md5.update(&source_buffer[..chunk_len]);
        target_md5.update(&target_buffer[..chunk_len]);

        for index in 0..chunk_len {
            let source_byte = source_buffer[index];
            let target_byte = target_buffer[index];
            if source_byte != target_byte {
                if pending_start.is_none() {
                    pending_start = Some(offset);
                }
                pending_xor.push(source_byte ^ target_byte);
            } else if !pending_xor.is_empty() {
                let start = pending_start.expect("pending start exists");
                records.push(RupRecord {
                    offset: start,
                    xor: std::mem::take(&mut pending_xor),
                });
                pending_start = None;
            }
            offset = offset
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("RUP scan offset overflowed".into()))?;
        }
    }

    if !pending_xor.is_empty() {
        let start = pending_start.expect("pending start exists");
        records.push(RupRecord {
            offset: start,
            xor: pending_xor,
        });
    }

    let mut overflow_data = Vec::new();
    let overflow_mode = if source_file_size < target_file_size {
        loop {
            let read = modified.read(&mut target_buffer)?;
            if read == 0 {
                break;
            }
            target_md5.update(&target_buffer[..read]);
            overflow_data.extend(
                target_buffer[..read]
                    .iter()
                    .copied()
                    .map(|byte| byte ^ 0xff),
            );
        }
        Some(RupOverflowMode::Append)
    } else if source_file_size > target_file_size {
        loop {
            let read = original.read(&mut source_buffer)?;
            if read == 0 {
                break;
            }
            source_md5.update(&source_buffer[..read]);
            overflow_data.extend(
                source_buffer[..read]
                    .iter()
                    .copied()
                    .map(|byte| byte ^ 0xff),
            );
        }
        Some(RupOverflowMode::Minify)
    } else {
        None
    };

    let metadata = RupMetadata {
        date: current_utc_yyyymmdd(),
        ..RupMetadata::default()
    };
    let file = RupFile {
        file_name: String::new(),
        rom_type: 0,
        source_file_size,
        target_file_size,
        source_md5: source_md5.finalize().into(),
        target_md5: target_md5.finalize().into(),
        overflow_mode,
        overflow_data,
        records,
    };

    let bytes = encode_rup_patch(&metadata, &[file])?;
    let record_count = bytes_record_count(&bytes)?;
    Ok(CreatedRupPatch {
        bytes,
        record_count,
    })
}

#[allow(dead_code)]
fn build_xor_records(source: &[u8], target: &[u8]) -> Result<Vec<RupRecord>> {
    let mut records = Vec::new();

    let mut index = 0usize;
    while index < target.len() {
        let source_byte = source[index];
        let target_byte = target[index];

        if source_byte != target_byte {
            let offset = u64::try_from(index)
                .map_err(|_| RomWeaverError::Validation("RUP offset exceeded u64".into()))?;
            let mut xor = Vec::new();

            while index < target.len() {
                let source_byte = source[index];
                let target_byte = target[index];
                if source_byte == target_byte {
                    break;
                }

                xor.push(source_byte ^ target_byte);
                index = checked_add_usize(index, 1, "RUP record scan index")?;
            }

            records.push(RupRecord { offset, xor });
        }

        if index == target.len() {
            break;
        }
        index = checked_add_usize(index, 1, "RUP scan index")?;
    }

    Ok(records)
}

fn encode_rup_patch(metadata: &RupMetadata, files: &[RupFile]) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();

    bytes.extend_from_slice(RUP_MAGIC);
    bytes.push(metadata.text_encoding);
    write_fixed_string(&mut bytes, &metadata.author, AUTHOR_LEN);
    write_fixed_string(&mut bytes, &metadata.version, VERSION_LEN);
    write_fixed_string(&mut bytes, &metadata.title, TITLE_LEN);
    write_fixed_string(&mut bytes, &metadata.genre, GENRE_LEN);
    write_fixed_string(&mut bytes, &metadata.language, LANGUAGE_LEN);
    write_fixed_string(&mut bytes, &metadata.date, DATE_LEN);
    write_fixed_string(&mut bytes, &metadata.web, WEB_LEN);
    write_fixed_string(
        &mut bytes,
        &metadata.description.replace('\n', r"\n"),
        DESCRIPTION_LEN,
    );

    if bytes.len() != RUP_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "RUP header encoding produced an unexpected size".into(),
        ));
    }

    for file in files {
        bytes.push(RUP_COMMAND_OPEN_NEW_FILE);
        push_vlv(
            &mut bytes,
            u64::try_from(file.file_name.len()).map_err(|_| {
                RomWeaverError::Validation("RUP file name length exceeded u64".into())
            })?,
        )?;
        bytes.extend_from_slice(file.file_name.as_bytes());
        bytes.push(file.rom_type);
        push_vlv(&mut bytes, file.source_file_size)?;
        push_vlv(&mut bytes, file.target_file_size)?;
        bytes.extend_from_slice(&file.source_md5);
        bytes.extend_from_slice(&file.target_md5);

        if file.source_file_size != file.target_file_size {
            let mode = match file.overflow_mode {
                Some(RupOverflowMode::Append) => b'A',
                Some(RupOverflowMode::Minify) => b'M',
                None => {
                    return Err(RomWeaverError::Validation(
                        "RUP overflow mode was missing for a size-changing patch".into(),
                    ));
                }
            };
            bytes.push(mode);
            push_vlv(
                &mut bytes,
                u64::try_from(file.overflow_data.len()).map_err(|_| {
                    RomWeaverError::Validation("RUP overflow data length exceeded u64".into())
                })?,
            )?;
            bytes.extend_from_slice(&file.overflow_data);
        }

        for record in &file.records {
            bytes.push(RUP_COMMAND_XOR_RECORD);
            push_vlv(&mut bytes, record.offset)?;
            push_vlv(
                &mut bytes,
                u64::try_from(record.xor.len()).map_err(|_| {
                    RomWeaverError::Validation("RUP record length exceeded u64".into())
                })?,
            )?;
            bytes.extend_from_slice(&record.xor);
        }
    }

    bytes.push(RUP_COMMAND_END);
    Ok(bytes)
}

fn bytes_record_count(bytes: &[u8]) -> Result<usize> {
    let patch = parse_rup_bytes(bytes)?;
    Ok(patch.files.iter().map(|file| file.records.len()).sum())
}

fn write_fixed_string(buffer: &mut Vec<u8>, value: &str, len: usize) {
    let bytes = value.as_bytes();
    let copy_len = min(bytes.len(), len);
    buffer.extend_from_slice(&bytes[..copy_len]);
    buffer.resize(buffer.len() + (len - copy_len), 0);
}

fn push_vlv(bytes: &mut Vec<u8>, value: u64) -> Result<()> {
    if value == 0 {
        bytes.push(0);
        return Ok(());
    }

    let encoded_len = ((64 - value.leading_zeros()) as usize).div_ceil(8);
    let len_u8 = u8::try_from(encoded_len)
        .map_err(|_| RomWeaverError::Validation("RUP VLV length exceeded u8".into()))?;
    bytes.push(len_u8);

    for index in 0..encoded_len {
        let shift = index * 8;
        bytes.push(((value >> shift) & 0xff) as u8);
    }

    Ok(())
}

fn usize_from_u64(value: u64, label: &str) -> Result<usize> {
    usize::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("{label} exceeded usize")))
}

#[allow(dead_code)]
fn checked_add_usize(lhs: usize, rhs: usize, label: &str) -> Result<usize> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

#[allow(dead_code)]
fn md5_bytes(bytes: &[u8]) -> [u8; 16] {
    let mut digest = [0u8; 16];
    digest.copy_from_slice(Md5::digest(bytes).as_slice());
    digest
}

fn md5_file(path: &Path) -> Result<[u8; 16]> {
    let mut file = BufReader::new(File::open(path)?);
    let mut hasher = Md5::new();
    let mut buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn format_md5_hex(value: [u8; 16]) -> String {
    let mut output = String::with_capacity(32);
    for byte in value {
        output.push(nibble_to_hex(byte >> 4));
        output.push(nibble_to_hex(byte & 0x0f));
    }
    output
}

fn nibble_to_hex(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'a' + (value - 10)) as char,
        _ => '0',
    }
}

fn current_utc_yyyymmdd() -> String {
    let now = std::time::SystemTime::now();
    let duration = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0));
    let days = (duration.as_secs() / 86_400) as i64;

    let (year, month, day) = civil_from_days(days);
    format!("{year:04}{month:02}{day:02}")
}

fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = (yoe + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (mp + if mp < 10 { 3 } else { -9 }) as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

struct RupParser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> RupParser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn is_at_end(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn read_exact(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| RomWeaverError::Validation("RUP parser offset overflowed".into()))?;
        if end > self.bytes.len() {
            return Err(RomWeaverError::Validation(
                "RUP patch ended unexpectedly while reading data".into(),
            ));
        }

        let start = self.offset;
        self.offset = end;
        Ok(&self.bytes[start..end])
    }

    fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_exact(1)?[0])
    }

    fn read_vlv(&mut self) -> Result<u64> {
        let encoded_len = usize::from(self.read_u8()?);
        if encoded_len > 8 {
            return Err(RomWeaverError::Validation(
                "RUP VLV length exceeded 64-bit range".into(),
            ));
        }

        let mut value = 0u64;
        for index in 0..encoded_len {
            let byte = u64::from(self.read_u8()?);
            let shift = (index * 8) as u32;
            value |= byte << shift;
        }

        Ok(value)
    }

    fn read_fixed_string(&mut self, len: usize) -> Result<String> {
        let bytes = self.read_exact(len)?;
        let trimmed_len = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        Ok(bytes[..trimmed_len]
            .iter()
            .map(|byte| char::from(*byte))
            .collect())
    }

    fn read_u128_md5(&mut self) -> Result<[u8; 16]> {
        let raw = self.read_exact(16)?;
        let mut value = [0u8; 16];
        value.copy_from_slice(raw);
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::PathBuf,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, NoopProgressSink, OperationContext, PatchApplyRequest,
        PatchCreateRequest, PatchHandler, ThreadBudget,
    };

    use super::{
        RUP_COMMAND_OPEN_NEW_FILE, RupPatchHandler, create_rup_patch_bytes, parse_rup_bytes,
    };
    use crate::RUP;

    static NEXT_TEST_DIR_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos();
            let sequence = NEXT_TEST_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "rom-weaver-rup-tests-{}-{timestamp}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir_all(&path).expect("temp dir");
            Self { path }
        }

        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parse_rejects_invalid_magic() {
        let mut bytes = create_rup_patch_bytes(b"source", b"target")
            .expect("patch")
            .bytes;
        bytes[0] ^= 0x01;

        let error = parse_rup_bytes(&bytes).expect_err("invalid magic should fail");
        assert!(error.to_string().contains("Patch header invalid"));
    }

    #[test]
    fn parse_rejects_invalid_overflow_mode() {
        let mut bytes = create_rup_patch_bytes(b"short", b"this-is-longer")
            .expect("patch")
            .bytes;

        let command_offset = bytes
            .iter()
            .position(|byte| *byte == RUP_COMMAND_OPEN_NEW_FILE)
            .expect("open command");

        let mut cursor = command_offset + 1;

        let name_len = usize::from(bytes[cursor]);
        cursor += 1 + name_len;
        cursor += 1;

        let source_size_len = usize::from(bytes[cursor]);
        cursor += 1 + source_size_len;

        let target_size_len = usize::from(bytes[cursor]);
        cursor += 1 + target_size_len;

        cursor += 32;
        bytes[cursor] = b'Z';

        let error = parse_rup_bytes(&bytes).expect_err("invalid overflow mode should fail");
        assert!(error.to_string().contains("invalid overflow mode"));
    }

    #[test]
    fn create_and_apply_round_trip_with_append_overflow() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.rup");
        let output_path = temp.child("output.bin");
        let reverse_path = temp.child("reverse.bin");

        let source = b"abcabcabcabc";
        let target = b"abcabcZZabcabcTAIL";
        fs::write(&source_path, source).expect("source");
        fs::write(&target_path, target).expect("target");

        let handler = RupPatchHandler::new(&RUP);
        let create_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "RUP".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");

        let execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(&output_path).expect("output"), target);

        handler
            .apply(
                &PatchApplyRequest {
                    input: output_path,
                    patches: vec![patch_path],
                    output: reverse_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("undo");

        assert_eq!(fs::read(reverse_path).expect("reverse"), source);
    }

    #[test]
    fn create_and_apply_round_trip_with_minify_overflow() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.rup");
        let output_path = temp.child("output.bin");

        let source = b"long-source-with-tail";
        let target = b"long-source";
        fs::write(&source_path, source).expect("source");
        fs::write(&target_path, target).expect("target");

        let handler = RupPatchHandler::new(&RUP);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "RUP".into(),
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
                &test_context_with_threads(&temp, 2),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), target);
    }

    #[test]
    fn apply_rejects_input_that_matches_neither_source_nor_target() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.rup");
        let wrong_path = temp.child("wrong.bin");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"source bytes").expect("source");
        fs::write(&target_path, b"target bytes").expect("target");
        fs::write(&wrong_path, b"not matching md5").expect("wrong");

        let handler = RupPatchHandler::new(&RUP);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path,
                    modified: target_path,
                    output: patch_path.clone(),
                    format: "RUP".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: wrong_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("expected mismatch");

        assert!(error.to_string().contains("RUP input validation failed"));
    }

    fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            temp.child("temp"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }
}
