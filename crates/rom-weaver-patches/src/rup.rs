use std::{
    cmp::min,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use md5::{Digest, Md5};
use rayon::prelude::*;
#[cfg(test)]
use rom_weaver_checksum::md5_bytes;
use rom_weaver_checksum::md5_file;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability,
};

const RUP_MAGIC: &[u8; 6] = b"NINJA2";
const RUP_HEADER_SIZE: usize = 0x800;
const RUP_COMMAND_END: u8 = 0x00;
const RUP_COMMAND_OPEN_NEW_FILE: u8 = 0x01;
const RUP_COMMAND_XOR_RECORD: u8 = 0x02;
const RUP_IO_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

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
        for (index, file) in patch.files.iter().enumerate() {
            label.push_str(&format!(
                "; variant {} source md5 {}; target md5 {}",
                index + 1,
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
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch = parse_rup_file(patch_path)?;
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
        let input_len = fs::metadata(&request.input)?.len();
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        output.set_len(output_size)?;
        let thread_capability = rup_apply_thread_capability(file.records.len());
        let planned_execution = context.plan_threads(thread_capability.clone());
        let execution = if planned_execution.used_parallelism {
            let tasks = build_rup_prepared_tasks(file.records.len(), context);
            let (execution, pool) = context.build_pool(thread_capability)?;
            let prepare_result = pool.install(|| {
                tasks
                    .par_iter()
                    .map(|task| {
                        prepare_rup_write_task(
                            task,
                            file,
                            &request.input,
                            input_len,
                            output_len,
                            context,
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            });
            if let Err(error) = prepare_result {
                cleanup_rup_prepared_tasks(&tasks);
                return Err(error);
            }
            let apply_result = apply_rup_prepared_tasks(file, &tasks, &mut output, context);
            cleanup_rup_prepared_tasks(&tasks);
            apply_result?;
            execution
        } else {
            let mut input = File::open(&request.input)?;
            apply_xor_records_in_place(file, output_len, input_len, &mut input, &mut output)?;
            planned_execution
        };
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
        let source_size = fs::metadata(&request.original)?.len();
        let target_size = fs::metadata(&request.modified)?.len();
        let shared_len = min(source_size, target_size);
        let (execution, pool) = context.build_pool(rup_create_thread_capability(shared_len))?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let created = create_rup_patch(
            &request.original,
            &request.modified,
            &pool,
            execution.used_parallelism,
        )?;
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
            threaded_diff: true,
            threaded_output: true,
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

#[derive(Debug)]
struct RupPreparedTask {
    index: usize,
    temp_path: PathBuf,
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
    let file_len = fs::metadata(path)?.len();
    if file_len < RUP_HEADER_SIZE as u64 {
        return Err(RomWeaverError::Validation(
            "RUP patch is too small to contain a valid header".into(),
        ));
    }

    let mut parser = RupFileParser::new(BufReader::new(File::open(path)?), file_len);
    if parser.read_exact(RUP_MAGIC.len())?.as_slice() != RUP_MAGIC {
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

    if parser.offset != RUP_HEADER_SIZE as u64 {
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
                    overflow_data = parser.read_exact(overflow_len)?;
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
                let xor = parser.read_exact(xor_len)?;
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

fn rup_create_thread_capability(shared_len: u64) -> ThreadCapability {
    let chunk_count = rup_create_chunk_count(shared_len).max(1);
    ThreadCapability::parallel(Some(chunk_count))
}

fn rup_apply_thread_capability(record_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(record_count.max(1)))
}

fn rup_create_chunk_count(shared_len: u64) -> usize {
    if shared_len == 0 {
        return 1;
    }
    let chunk_bytes = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_count = shared_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).unwrap_or(usize::MAX)
}

fn build_rup_prepared_tasks(
    record_count: usize,
    context: &OperationContext,
) -> Vec<RupPreparedTask> {
    (0..record_count)
        .map(|index| RupPreparedTask {
            index,
            temp_path: context
                .temp_paths()
                .next_path(&format!("rup-apply-record-{index}"), Some("bin")),
        })
        .collect()
}

fn prepare_rup_write_task(
    task: &RupPreparedTask,
    file: &RupFile,
    input_path: &Path,
    input_len: u64,
    output_len: usize,
    context: &OperationContext,
) -> Result<()> {
    context.cancel().check()?;
    let record = file.records.get(task.index).ok_or_else(|| {
        RomWeaverError::Validation("RUP apply record index was out of bounds".into())
    })?;

    let start = usize_from_u64(record.offset, "RUP record offset")?;
    let end = start
        .checked_add(record.xor.len())
        .ok_or_else(|| RomWeaverError::Validation("RUP record length overflowed".into()))?;
    if end > output_len {
        return Err(RomWeaverError::Validation(
            "RUP record exceeded declared output size".into(),
        ));
    }

    if let Some(parent) = task.temp_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut input = File::open(input_path)?;
    let mut writer = io::BufWriter::new(File::create(&task.temp_path)?);
    let mut buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    let mut remaining = record.xor.len();
    let mut xor_cursor = 0usize;
    let mut write_offset = record.offset;
    while remaining > 0 {
        context.cancel().check()?;
        let chunk_len = remaining.min(buffer.len());

        let readable_u64 = if write_offset >= input_len {
            0
        } else {
            (input_len - write_offset).min(chunk_len as u64)
        };
        let readable = usize::try_from(readable_u64).map_err(|_| {
            RomWeaverError::Validation("RUP readable chunk length exceeded usize".into())
        })?;

        if readable > 0 {
            input.seek(SeekFrom::Start(write_offset))?;
            input.read_exact(&mut buffer[..readable])?;
        }
        if readable < chunk_len {
            buffer[readable..chunk_len].fill(0);
        }

        for (index, byte) in buffer[..chunk_len].iter_mut().enumerate() {
            *byte ^= record.xor[xor_cursor + index];
        }
        writer.write_all(&buffer[..chunk_len])?;

        write_offset = write_offset
            .checked_add(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("RUP output offset overflowed".into()))?;
        xor_cursor = xor_cursor
            .checked_add(chunk_len)
            .ok_or_else(|| RomWeaverError::Validation("RUP xor cursor overflowed".into()))?;
        remaining -= chunk_len;
    }
    writer.flush()?;
    Ok(())
}

fn apply_rup_prepared_tasks(
    file: &RupFile,
    tasks: &[RupPreparedTask],
    output: &mut File,
    context: &OperationContext,
) -> Result<()> {
    for task in tasks {
        context.cancel().check()?;
        let record = file.records.get(task.index).ok_or_else(|| {
            RomWeaverError::Validation("RUP apply record index was out of bounds".into())
        })?;
        output.seek(SeekFrom::Start(record.offset))?;
        let mut reader = BufReader::new(File::open(&task.temp_path)?);
        io::copy(&mut reader, output)?;
    }
    Ok(())
}

fn cleanup_rup_prepared_tasks(tasks: &[RupPreparedTask]) {
    for task in tasks {
        let _ = fs::remove_file(&task.temp_path);
    }
}

fn apply_xor_records_in_place(
    file: &RupFile,
    output_len: usize,
    input_len: u64,
    input: &mut File,
    output: &mut File,
) -> Result<()> {
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

            let readable_u64 = if write_offset >= input_len {
                0
            } else {
                (input_len - write_offset).min(chunk_len as u64)
            };
            let readable = usize::try_from(readable_u64).map_err(|_| {
                RomWeaverError::Validation("RUP readable chunk length exceeded usize".into())
            })?;

            if readable > 0 {
                input.seek(SeekFrom::Start(write_offset))?;
                input.read_exact(&mut buffer[..readable])?;
            }
            if readable < chunk_len {
                buffer[readable..chunk_len].fill(0);
            }

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

#[cfg(test)]
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

fn create_rup_patch(
    original_path: &Path,
    modified_path: &Path,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
) -> Result<CreatedRupPatch> {
    if use_parallel_scan {
        create_rup_patch_parallel(original_path, modified_path, pool)
    } else {
        create_rup_patch_streaming(original_path, modified_path)
    }
}

fn create_rup_patch_parallel(
    original_path: &Path,
    modified_path: &Path,
    pool: &SharedThreadPool,
) -> Result<CreatedRupPatch> {
    let source_file_size = fs::metadata(original_path)?.len();
    let target_file_size = fs::metadata(modified_path)?.len();
    let shared_len = min(source_file_size, target_file_size);
    let records = collect_rup_records_parallel(
        original_path,
        source_file_size,
        modified_path,
        target_file_size,
        shared_len,
        pool,
    )?;

    let source_md5 = md5_file(original_path)?;
    let target_md5 = md5_file(modified_path)?;

    let (overflow_mode, overflow_data) = if source_file_size < target_file_size {
        (
            Some(RupOverflowMode::Append),
            read_xor_suffix(modified_path, source_file_size)?,
        )
    } else if source_file_size > target_file_size {
        (
            Some(RupOverflowMode::Minify),
            read_xor_suffix(original_path, target_file_size)?,
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

fn collect_rup_records_parallel(
    source_path: &Path,
    source_size: u64,
    target_path: &Path,
    target_size: u64,
    shared_len: u64,
    pool: &SharedThreadPool,
) -> Result<Vec<RupRecord>> {
    if shared_len == 0 {
        return Ok(Vec::new());
    }

    let chunk_size = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_ranges = (0..shared_len)
        .step_by(CREATE_THREAD_SCAN_CHUNK_BYTES)
        .map(|start| {
            let end = start.saturating_add(chunk_size).min(shared_len);
            start..end
        })
        .collect::<Vec<_>>();

    let per_chunk = pool.install(|| {
        chunk_ranges
            .into_par_iter()
            .map(|range| {
                collect_rup_chunk_records(
                    source_path,
                    source_size,
                    target_path,
                    target_size,
                    range.start,
                    range.end,
                )
            })
            .collect::<Vec<_>>()
    });

    let mut merged: Vec<RupRecord> = Vec::new();
    for runs in per_chunk {
        let runs = runs?;
        for mut run in runs {
            if let Some(last) = merged.last_mut() {
                let last_len = u64::try_from(last.xor.len()).expect("len fits u64");
                if last
                    .offset
                    .checked_add(last_len)
                    .is_some_and(|end| end == run.offset)
                {
                    last.xor.append(&mut run.xor);
                    continue;
                }
            }
            merged.push(run);
        }
    }
    Ok(merged)
}

fn collect_rup_chunk_records(
    source_path: &Path,
    source_size: u64,
    target_path: &Path,
    _target_size: u64,
    start: u64,
    end: u64,
) -> Result<Vec<RupRecord>> {
    let mut source = File::open(source_path)?;
    let mut target = File::open(target_path)?;
    if start < source_size {
        source.seek(SeekFrom::Start(start))?;
    }
    target.seek(SeekFrom::Start(start))?;

    let mut source_buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    let mut records = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_xor = Vec::<u8>::new();
    let mut absolute = start;

    while absolute < end {
        let chunk_len = usize::try_from((end - absolute).min(RUP_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("RUP chunk length exceeded usize".into()))?;
        let source_chunk_len = usize::try_from((source_size - absolute).min(chunk_len as u64))
            .map_err(|_| {
                RomWeaverError::Validation("RUP source chunk length exceeded usize".into())
            })?;
        source.read_exact(&mut source_buffer[..source_chunk_len])?;
        target.read_exact(&mut target_buffer[..chunk_len])?;
        if source_chunk_len < chunk_len {
            source_buffer[source_chunk_len..chunk_len].fill(0);
        }

        for index in 0..chunk_len {
            let source_byte = source_buffer[index];
            let target_byte = target_buffer[index];
            if source_byte != target_byte {
                if pending_start.is_none() {
                    pending_start = Some(absolute);
                }
                pending_xor.push(source_byte ^ target_byte);
            } else if !pending_xor.is_empty() {
                let offset = pending_start.expect("pending start exists");
                records.push(RupRecord {
                    offset,
                    xor: std::mem::take(&mut pending_xor),
                });
                pending_start = None;
            }
            absolute = absolute
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("RUP scan offset overflowed".into()))?;
        }
    }

    if !pending_xor.is_empty() {
        let offset = pending_start.expect("pending start exists");
        records.push(RupRecord {
            offset,
            xor: pending_xor,
        });
    }
    Ok(records)
}

fn read_xor_suffix(path: &Path, offset: u64) -> Result<Vec<u8>> {
    let mut file = BufReader::new(File::open(path)?);
    file.seek(SeekFrom::Start(offset))?;
    let mut buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    let mut output = Vec::new();
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.extend(buffer[..read].iter().copied().map(|byte| byte ^ 0xff));
    }
    Ok(output)
}

#[cfg(test)]
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

#[cfg(test)]
fn checked_add_usize(lhs: usize, rhs: usize, label: &str) -> Result<usize> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
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

struct RupFileParser<R> {
    reader: R,
    file_len: u64,
    offset: u64,
}

impl<R: Read> RupFileParser<R> {
    fn new(reader: R, file_len: u64) -> Self {
        Self {
            reader,
            file_len,
            offset: 0,
        }
    }

    fn is_at_end(&self) -> bool {
        self.offset == self.file_len
    }

    fn read_exact(&mut self, len: usize) -> Result<Vec<u8>> {
        let len_u64 = u64::try_from(len)
            .map_err(|_| RomWeaverError::Validation("RUP parser length overflowed".into()))?;
        let next = self
            .offset
            .checked_add(len_u64)
            .ok_or_else(|| RomWeaverError::Validation("RUP parser offset overflowed".into()))?;
        if next > self.file_len {
            return Err(RomWeaverError::Validation(
                "RUP patch ended unexpectedly while reading data".into(),
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
        value.copy_from_slice(&raw);
        Ok(value)
    }
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
#[path = "../tests/unit/rup.rs"]
mod tests;
