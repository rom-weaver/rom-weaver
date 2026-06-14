use std::{
    cmp::min,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use tracing::{debug, info, trace};

use md5::{Digest, Md5};
use rayon::prelude::*;
#[cfg(test)]
use rom_weaver_checksum::md5_bytes;
use rom_weaver_checksum::md5_file;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, UnsupportedOp,
};

use crate::checksum_validation_suffix;
use crate::shared::threading::{
    chunk_count_for_len, parallel_chunked_capability, parallel_per_record_capability,
    run_with_optional_pool, scan_create_chunks,
};

const RUP_MAGIC: &[u8; 6] = b"NINJA2";
const RUP_HEADER_SIZE: usize = 0x800;
const RUP_COMMAND_END: u8 = 0x00;
const RUP_COMMAND_OPEN_NEW_FILE: u8 = 0x01;
const RUP_COMMAND_XOR_RECORD: u8 = 0x02;
const RUP_IO_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const COPIER_HEADER_SIZE: u64 = 0x200;
const NES_INES_HEADER_SIZE: u64 = 0x10;
const LYNX_HEADER_SIZE: u64 = 0x40;
const GAME_BOY_BANK_SIZE: u64 = 0x4000;
const PCE_BANK_SIZE: u64 = 0x1000;
const SMD_BLOCK_SIZE: usize = 16 * 1024;
const SNES_BANK_SIZE: u64 = 32 * 1024;

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
        debug!(
            format = self.descriptor.name,
            patch = %patch_path.display(),
            "rup patch apply start"
        );
        let patch = parse_rup_file(patch_path)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let selected =
            select_matching_file_for_input(&patch, &request.input, validate_checksums, context)?;
        let file = selected.file;
        let undo = selected.undo;
        let normalized_input = selected.normalized_input;
        trace!(
            format = self.descriptor.name,
            variants = patch.files.len(),
            records = file.records.len(),
            undo,
            source_size = file.source_file_size,
            target_size = file.target_file_size,
            read_on_main = crate::patches_reads_source_on_main_thread(),
            "rup parsed; selected variant"
        );

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
        let normalized_output_path = if normalized_input.reconstruction.is_identity() {
            request.output.clone()
        } else {
            let path = context
                .temp_paths()
                .next_path("rup-normalized-output", Some("bin"));
            ensure_parent_dir(&path)?;
            path
        };
        fs::copy(&normalized_input.path, &normalized_output_path)?;
        let input_len = fs::metadata(&normalized_input.path)?.len();
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&normalized_output_path)?;
        output.set_len(output_size)?;
        let thread_capability = parallel_per_record_capability(file.records.len());
        let (execution, prepared) = run_with_optional_pool(
            context,
            thread_capability,
            !crate::patches_reads_source_on_main_thread(),
            |pool| {
                let tasks = build_rup_prepared_tasks(file.records.len());
                pool.install(|| {
                    tasks
                        .par_iter()
                        .map(|task| {
                            prepare_rup_write_task(
                                task,
                                file,
                                &normalized_input.path,
                                input_len,
                                output_len,
                                context,
                            )
                        })
                        .collect::<Result<Vec<_>>>()
                })
                .map(Some)
            },
            || {
                let mut input = File::open(&normalized_input.path)?;
                apply_xor_records_in_place(file, output_len, input_len, &mut input, &mut output)?;
                Ok(None)
            },
        )?;
        if let Some(prepared) = prepared {
            apply_rup_prepared_records(file, &prepared, &mut output, context)?;
        }
        apply_overflow_in_place(file, undo, output_len, &mut output)?;
        output.flush()?;

        if validate_checksums {
            let expected_md5 = if undo {
                file.source_md5
            } else {
                file.target_md5
            };
            output.seek(SeekFrom::Start(0))?;
            let actual_md5 = md5_open_file(&mut output)?;
            if actual_md5 != expected_md5 {
                return Err(RomWeaverError::Validation(format!(
                    "RUP target checksum mismatch; expected {}, got {}",
                    format_md5_hex(expected_md5),
                    format_md5_hex(actual_md5)
                )));
            }
        }
        drop(output);
        finalize_rup_output(
            &normalized_input.reconstruction,
            &request.input,
            &normalized_output_path,
            &request.output,
        )?;

        let checksum_suffix = checksum_validation_suffix(validate_checksums);
        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch ({}) with {} record(s){}",
                self.descriptor.name,
                if undo { "undo" } else { "forward" },
                file.records.len(),
                checksum_suffix
            ),
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
        debug!(
            format = self.descriptor.name,
            source_size, target_size, "rup patch create start"
        );
        let shared_len = min(source_size, target_size);
        let (execution, pool) = context.build_pool(parallel_chunked_capability(
            shared_len,
            CREATE_THREAD_SCAN_CHUNK_BYTES as u64,
        ))?;
        trace!(
            format = self.descriptor.name,
            parallel = execution.used_parallelism,
            threads = execution.effective_threads,
            shared_len,
            "rup create thread plan"
        );

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
struct RupSelectedFile<'a> {
    file: &'a RupFile,
    undo: bool,
    normalized_input: RupNormalizedInput,
}

#[derive(Debug)]
struct RupNormalizedInput {
    path: PathBuf,
    reconstruction: RupOutputReconstruction,
}

#[derive(Debug)]
enum RupOutputReconstruction {
    Identity,
    PrefixHeader(Vec<u8>),
    Unif,
}

impl RupOutputReconstruction {
    fn is_identity(&self) -> bool {
        matches!(self, Self::Identity)
    }
}

#[derive(Debug)]
struct RupPreparedTask {
    index: usize,
}

#[derive(Debug)]
struct RupPreparedRecord {
    index: usize,
    bytes: Vec<u8>,
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
        return Err(crate::coded_validation(
            "RUP_HEADER_INVALID",
            "Patch header invalid",
        ));
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
        return Err(crate::coded_validation(
            "RUP_HEADER_INVALID",
            "Patch header invalid",
        ));
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

fn select_matching_file_for_input<'a>(
    patch: &'a ParsedRupPatch,
    input_path: &Path,
    validate_checksums: bool,
    context: &OperationContext,
) -> Result<RupSelectedFile<'a>> {
    if patch.files.iter().any(|file| !file.file_name.is_empty()) {
        return Err(RomWeaverError::Unsupported(
            UnsupportedOp::RupNamedFileEntries,
        ));
    }

    let mut matches = Vec::new();
    for file in &patch.files {
        let normalized_input = match normalize_rup_input(input_path, file, context) {
            Ok(normalized_input) => normalized_input,
            Err(RomWeaverError::Validation(_) | RomWeaverError::ValidationCode(_)) => {
                continue;
            }
            Err(error) => return Err(error),
        };
        let input_md5 = md5_file(&normalized_input.path)?;
        if file.source_md5 == input_md5 || file.target_md5 == input_md5 {
            matches.push(RupSelectedFile {
                file,
                undo: file.target_md5 == input_md5,
                normalized_input,
            });
        }
    }

    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 if !validate_checksums => match patch.files.as_slice() {
            [single] => Ok(RupSelectedFile {
                file: single,
                undo: false,
                normalized_input: normalize_rup_input(input_path, single, context)?,
            }),
            _ => Err(RomWeaverError::Validation(
                "RUP checksum validation is disabled, but patch has multiple file variants so input direction is ambiguous".into(),
            )),
        },
        0 => {
            // Only needed for this diagnostic — computed lazily so the common
            // (matching) path does not pay a redundant full-file MD5 pass.
            let raw_input_md5 = md5_file(input_path)?;
            Err(RomWeaverError::Validation(format!(
                "RUP input validation failed; no file entry matched input MD5 {}",
                format_md5_hex(raw_input_md5)
            )))
        }
        _ => Err(RomWeaverError::Validation(
            "RUP input validation matched multiple file variants; patch-apply requires an unambiguous single-file variant".into(),
        )),
    }
}

fn normalize_rup_input(
    input_path: &Path,
    file: &RupFile,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    match file.rom_type {
        1 => normalize_nes_input(input_path, context),
        3 => normalize_snes_input(input_path, context),
        4 => normalize_n64_input(input_path, context),
        5 => normalize_game_boy_input(input_path, context),
        6 => normalize_sms_input(input_path, context),
        7 => normalize_genesis_input(input_path, context),
        8 => normalize_pce_input(input_path, context),
        9 => normalize_lynx_input(input_path, context),
        _ => Ok(identity_normalized_input(input_path)),
    }
}

fn identity_normalized_input(input_path: &Path) -> RupNormalizedInput {
    RupNormalizedInput {
        path: input_path.to_path_buf(),
        reconstruction: RupOutputReconstruction::Identity,
    }
}

fn normalize_nes_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    let prefix = read_prefix(input_path, 10)?;
    if prefix.len() >= 4 && &prefix[..4] == b"NES\x1A" {
        return strip_header_to_normalized_input(
            input_path,
            NES_INES_HEADER_SIZE,
            true,
            context,
            "rup-nes-payload",
        );
    }
    if prefix.len() >= 10 && prefix[8] == 0xaa && prefix[9] == 0xbb {
        return strip_header_to_normalized_input(
            input_path,
            COPIER_HEADER_SIZE,
            true,
            context,
            "rup-nes-ffe-payload",
        );
    }
    if prefix.len() >= 4 && &prefix[..4] == b"UNIF" {
        let path = extract_unif_payload_to_temp(input_path, context)?;
        return Ok(RupNormalizedInput {
            path,
            reconstruction: RupOutputReconstruction::Unif,
        });
    }
    Ok(identity_normalized_input(input_path))
}

fn normalize_snes_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    let file_len = fs::metadata(input_path)?.len();
    let strip_header = file_len % SNES_BANK_SIZE != 0;
    let header = if strip_header
        && read_bytes_at(input_path, 0x1e8, 4)?
            .as_deref()
            .is_some_and(|bytes| bytes == b"NSRT")
    {
        Some(read_exact_at(input_path, 0, COPIER_HEADER_SIZE)?)
    } else {
        None
    };

    let (payload_path, reconstruction) = if strip_header {
        if file_len < COPIER_HEADER_SIZE {
            return Err(RomWeaverError::Validation(
                "RUP SNES header normalization requires at least 0x200 bytes".into(),
            ));
        }
        (
            copy_range_to_temp(
                input_path,
                COPIER_HEADER_SIZE,
                file_len - COPIER_HEADER_SIZE,
                context,
                "rup-snes-payload",
            )?,
            header
                .map(RupOutputReconstruction::PrefixHeader)
                .unwrap_or(RupOutputReconstruction::Identity),
        )
    } else {
        (input_path.to_path_buf(), RupOutputReconstruction::Identity)
    };

    if snes_payload_needs_deinterleave(&payload_path)? {
        let path = write_snes_deinterleaved_to_temp(&payload_path, context)?;
        return Ok(RupNormalizedInput {
            path,
            reconstruction,
        });
    }

    Ok(RupNormalizedInput {
        path: payload_path,
        reconstruction,
    })
}

fn normalize_n64_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    if read_bytes_at(input_path, 0, 4)?
        .as_deref()
        .is_some_and(|bytes| bytes == [0x37, 0x80, 0x40, 0x12])
    {
        let path = write_n64_byte_swapped_to_temp(input_path, context)?;
        return Ok(RupNormalizedInput {
            path,
            reconstruction: RupOutputReconstruction::Identity,
        });
    }
    Ok(identity_normalized_input(input_path))
}

fn normalize_game_boy_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    let file_len = fs::metadata(input_path)?.len();
    if file_len % GAME_BOY_BANK_SIZE == 0 {
        return Ok(identity_normalized_input(input_path));
    }
    strip_header_to_normalized_input(
        input_path,
        COPIER_HEADER_SIZE,
        false,
        context,
        "rup-game-boy-payload",
    )
}

fn normalize_sms_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    normalize_smd_input(input_path, 0x7ff4, context, "rup-sms-payload")
}

fn normalize_genesis_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    normalize_smd_input(input_path, 0x100, context, "rup-genesis-payload")
}

fn normalize_pce_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    let file_len = fs::metadata(input_path)?.len();
    if file_len % PCE_BANK_SIZE == 0 {
        return Ok(identity_normalized_input(input_path));
    }
    strip_header_to_normalized_input(
        input_path,
        COPIER_HEADER_SIZE,
        false,
        context,
        "rup-pce-payload",
    )
}

fn normalize_lynx_input(
    input_path: &Path,
    context: &OperationContext,
) -> Result<RupNormalizedInput> {
    if read_bytes_at(input_path, 0, 4)?
        .as_deref()
        .is_some_and(|bytes| bytes == b"LYNX")
    {
        return strip_header_to_normalized_input(
            input_path,
            LYNX_HEADER_SIZE,
            true,
            context,
            "rup-lynx-payload",
        );
    }
    Ok(identity_normalized_input(input_path))
}

fn normalize_smd_input(
    input_path: &Path,
    native_magic_offset: u64,
    context: &OperationContext,
    purpose: &str,
) -> Result<RupNormalizedInput> {
    if read_bytes_at(input_path, native_magic_offset, 4)?
        .as_deref()
        .is_some_and(|bytes| bytes == b"SEGA")
    {
        return Ok(identity_normalized_input(input_path));
    }
    if read_bytes_at(input_path, 0x8, 2)?
        .as_deref()
        .is_some_and(|bytes| bytes == [0xaa, 0xbb])
    {
        let file_len = fs::metadata(input_path)?.len();
        if file_len < COPIER_HEADER_SIZE {
            return Err(RomWeaverError::Validation(
                "RUP SMD normalization requires at least 0x200 bytes".into(),
            ));
        }
        let path = write_smd_deinterleaved_to_temp(
            input_path,
            COPIER_HEADER_SIZE,
            file_len - COPIER_HEADER_SIZE,
            context,
            purpose,
        )?;
        return Ok(RupNormalizedInput {
            path,
            reconstruction: RupOutputReconstruction::Identity,
        });
    }
    Ok(identity_normalized_input(input_path))
}

fn strip_header_to_normalized_input(
    input_path: &Path,
    header_len: u64,
    preserve_header: bool,
    context: &OperationContext,
    purpose: &str,
) -> Result<RupNormalizedInput> {
    let file_len = fs::metadata(input_path)?.len();
    if file_len < header_len {
        return Err(RomWeaverError::Validation(format!(
            "RUP header normalization requires at least 0x{header_len:X} bytes"
        )));
    }
    let header = if preserve_header {
        Some(read_exact_at(input_path, 0, header_len)?)
    } else {
        None
    };
    let path = copy_range_to_temp(
        input_path,
        header_len,
        file_len - header_len,
        context,
        purpose,
    )?;
    Ok(RupNormalizedInput {
        path,
        reconstruction: header
            .map(RupOutputReconstruction::PrefixHeader)
            .unwrap_or(RupOutputReconstruction::Identity),
    })
}

fn finalize_rup_output(
    reconstruction: &RupOutputReconstruction,
    input_path: &Path,
    normalized_output_path: &Path,
    output_path: &Path,
) -> Result<()> {
    match reconstruction {
        RupOutputReconstruction::Identity => Ok(()),
        RupOutputReconstruction::PrefixHeader(header) => {
            ensure_parent_dir(output_path)?;
            let mut output = File::create(output_path)?;
            output.write_all(header)?;
            let mut normalized = File::open(normalized_output_path)?;
            io::copy(&mut normalized, &mut output)?;
            output.flush()?;
            Ok(())
        }
        RupOutputReconstruction::Unif => {
            ensure_parent_dir(output_path)?;
            fs::copy(input_path, output_path)?;
            let mut normalized = File::open(normalized_output_path)?;
            let mut output = OpenOptions::new()
                .read(true)
                .write(true)
                .open(output_path)?;
            rebuild_unif_payload(&mut output, &mut normalized)
        }
    }
}

fn extract_unif_payload_to_temp(input_path: &Path, context: &OperationContext) -> Result<PathBuf> {
    let output_path = temp_path(context, "rup-unif-payload", Some("bin"))?;
    let mut input = File::open(input_path)?;
    let mut output = File::create(&output_path)?;
    copy_unif_payload_chunks(&mut input, &mut output)?;
    output.flush()?;
    Ok(output_path)
}

fn copy_unif_payload_chunks(input: &mut File, output: &mut File) -> Result<()> {
    let file_len = input.metadata()?.len();
    if file_len < 0x20 {
        return Err(RomWeaverError::Validation(
            "RUP UNIF normalization requires at least 0x20 bytes".into(),
        ));
    }

    let mut cursor = 0x20u64;
    input.seek(SeekFrom::Start(cursor))?;
    while cursor < file_len {
        let Some((chunk_id, chunk_len, data_offset)) =
            read_unif_chunk_header(input, cursor, file_len)?
        else {
            break;
        };
        if is_unif_payload_chunk(&chunk_id) {
            input.seek(SeekFrom::Start(data_offset))?;
            let mut limited = Read::by_ref(input).take(chunk_len);
            io::copy(&mut limited, output)?;
        }
        cursor = data_offset
            .checked_add(chunk_len)
            .ok_or_else(|| RomWeaverError::Validation("RUP UNIF chunk offset overflowed".into()))?;
        input.seek(SeekFrom::Start(cursor))?;
    }
    Ok(())
}

fn rebuild_unif_payload(output: &mut File, normalized: &mut File) -> Result<()> {
    let file_len = output.metadata()?.len();
    if file_len < 0x20 {
        return Err(RomWeaverError::Validation(
            "RUP UNIF reconstruction requires at least 0x20 bytes".into(),
        ));
    }

    let mut cursor = 0x20u64;
    output.seek(SeekFrom::Start(cursor))?;
    while cursor < file_len {
        let Some((chunk_id, chunk_len, data_offset)) =
            read_unif_chunk_header(output, cursor, file_len)?
        else {
            break;
        };
        if is_unif_payload_chunk(&chunk_id) {
            output.seek(SeekFrom::Start(data_offset))?;
            copy_exact_bytes(normalized, output, chunk_len, "RUP UNIF payload")?;
        }
        cursor = data_offset
            .checked_add(chunk_len)
            .ok_or_else(|| RomWeaverError::Validation("RUP UNIF chunk offset overflowed".into()))?;
        output.seek(SeekFrom::Start(cursor))?;
    }

    let mut trailing = [0u8; 1];
    if normalized.read(&mut trailing)? != 0 {
        return Err(RomWeaverError::Validation(
            "RUP UNIF normalized output exceeded template PRG/CHR capacity".into(),
        ));
    }
    output.flush()?;
    Ok(())
}

fn read_unif_chunk_header(
    file: &mut File,
    cursor: u64,
    file_len: u64,
) -> Result<Option<([u8; 4], u64, u64)>> {
    if file_len - cursor < 8 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(cursor))?;
    let mut chunk_id = [0u8; 4];
    file.read_exact(&mut chunk_id)?;
    let mut len_bytes = [0u8; 4];
    file.read_exact(&mut len_bytes)?;
    let chunk_len = u64::from(u32::from_le_bytes(len_bytes));
    let data_offset = cursor
        .checked_add(8)
        .ok_or_else(|| RomWeaverError::Validation("RUP UNIF chunk offset overflowed".into()))?;
    if data_offset
        .checked_add(chunk_len)
        .is_none_or(|end| end > file_len)
    {
        return Err(RomWeaverError::Validation(
            "RUP UNIF chunk length exceeded file size".into(),
        ));
    }
    Ok(Some((chunk_id, chunk_len, data_offset)))
}

fn is_unif_payload_chunk(chunk_id: &[u8; 4]) -> bool {
    matches!(&chunk_id[..3], b"PRG" | b"CHR")
        && (chunk_id[3].is_ascii_digit() || (b'A'..=b'F').contains(&chunk_id[3]))
}

fn snes_payload_needs_deinterleave(input_path: &Path) -> Result<bool> {
    let mut payload = Vec::new();
    File::open(input_path)?.read_to_end(&mut payload)?;
    if payload.len() <= 0x7fde {
        return Ok(false);
    }

    let lo_inverse = read_u16_le_from_slice(&payload, 0x7fdc);
    let lo_checksum = read_u16_le_from_slice(&payload, 0x7fde);
    let lo_state = payload.get(0x7fd5).copied().unwrap_or_default() % 0x10;
    if lo_inverse
        .zip(lo_checksum)
        .is_some_and(|(inverse, checksum)| inverse.wrapping_add(checksum) == 0xffff)
    {
        return Ok(lo_state % 2 != 0);
    }

    let hi_inverse = read_u16_le_from_slice(&payload, 0xffdc);
    let hi_checksum = read_u16_le_from_slice(&payload, 0xffde);
    let hi_state = payload.get(0xffd5).copied().unwrap_or_default() % 0x10;
    if hi_inverse
        .zip(hi_checksum)
        .is_some_and(|(inverse, checksum)| inverse.wrapping_add(checksum) == 0xffff)
        && hi_state % 2 != 0
    {
        return Ok(false);
    }
    if payload.get(0xffd5).is_some() && hi_state % 2 != 0 {
        return Ok(false);
    }
    Ok(false)
}

fn write_snes_deinterleaved_to_temp(
    input_path: &Path,
    context: &OperationContext,
) -> Result<PathBuf> {
    let mut payload = Vec::new();
    File::open(input_path)?.read_to_end(&mut payload)?;
    let deinterleaved = deinterleave_snes_payload(&payload);
    let output_path = temp_path(context, "rup-snes-deinterleaved", Some("bin"))?;
    fs::write(&output_path, deinterleaved)?;
    Ok(output_path)
}

fn deinterleave_snes_payload(payload: &[u8]) -> Vec<u8> {
    let bank_size = SNES_BANK_SIZE as usize;
    let bank_count = payload.len() / bank_size;
    if bank_count < 2 || !bank_count.is_multiple_of(2) {
        return payload.to_vec();
    }

    let data_len = bank_count * bank_size;
    let mut output = vec![0u8; payload.len()];
    for index in 0..(bank_count / 2) {
        let high_source = (index + (bank_count / 2)) * bank_size;
        let low_source = index * bank_size;
        let even_dest = (index * 2) * bank_size;
        let odd_dest = ((index * 2) + 1) * bank_size;
        output[even_dest..even_dest + bank_size]
            .copy_from_slice(&payload[high_source..high_source + bank_size]);
        output[odd_dest..odd_dest + bank_size]
            .copy_from_slice(&payload[low_source..low_source + bank_size]);
    }
    output[data_len..].copy_from_slice(&payload[data_len..]);
    output
}

fn write_n64_byte_swapped_to_temp(
    input_path: &Path,
    context: &OperationContext,
) -> Result<PathBuf> {
    let output_path = temp_path(context, "rup-n64-native", Some("bin"))?;
    let mut input = BufReader::new(File::open(input_path)?);
    let mut output = File::create(&output_path)?;
    let mut buffer = vec![0u8; RUP_IO_BUFFER_SIZE];
    let mut pending = None;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            if let Some(previous) = pending.take() {
                output.write_all(&[*byte, previous])?;
            } else {
                pending = Some(*byte);
            }
        }
    }
    if pending.is_some() {
        return Err(RomWeaverError::Validation(
            "RUP N64 byte-swap input had odd byte length".into(),
        ));
    }
    output.flush()?;
    Ok(output_path)
}

fn write_smd_deinterleaved_to_temp(
    input_path: &Path,
    payload_offset: u64,
    payload_len: u64,
    context: &OperationContext,
    purpose: &str,
) -> Result<PathBuf> {
    let output_path = temp_path(context, purpose, Some("bin"))?;
    let mut input = BufReader::new(File::open(input_path)?);
    let mut output = File::create(&output_path)?;
    input.seek(SeekFrom::Start(payload_offset))?;
    let mut block = vec![0u8; SMD_BLOCK_SIZE];
    let mut remaining = payload_len;
    while remaining >= SMD_BLOCK_SIZE as u64 {
        input.read_exact(&mut block)?;
        let deinterleaved = deinterleave_smd_block(&block);
        output.write_all(&deinterleaved)?;
        remaining -= SMD_BLOCK_SIZE as u64;
    }
    if remaining > 0 {
        let tail_len = usize_from_u64(remaining, "RUP SMD tail length")?;
        let mut tail = vec![0u8; tail_len];
        input.read_exact(&mut tail)?;
        output.write_all(&tail)?;
    }
    output.flush()?;
    Ok(output_path)
}

fn deinterleave_smd_block(block: &[u8]) -> Vec<u8> {
    let mut output = vec![0u8; block.len()];
    let half = block.len() / 2;
    for index in 0..half {
        output[index * 2] = block[index];
        output[(index * 2) + 1] = block[half + index];
    }
    output
}

fn copy_range_to_temp(
    input_path: &Path,
    offset: u64,
    len: u64,
    context: &OperationContext,
    purpose: &str,
) -> Result<PathBuf> {
    let output_path = temp_path(context, purpose, Some("bin"))?;
    let mut input = File::open(input_path)?;
    input.seek(SeekFrom::Start(offset))?;
    let mut output = File::create(&output_path)?;
    let mut limited = input.take(len);
    io::copy(&mut limited, &mut output)?;
    output.flush()?;
    Ok(output_path)
}

fn copy_exact_bytes(input: &mut File, output: &mut File, len: u64, label: &str) -> Result<()> {
    let mut limited = input.take(len);
    let copied = io::copy(&mut limited, output)?;
    if copied != len {
        return Err(RomWeaverError::Validation(format!(
            "{label} ended unexpectedly while copying bytes"
        )));
    }
    Ok(())
}

fn temp_path(
    context: &OperationContext,
    purpose: &str,
    extension: Option<&str>,
) -> Result<PathBuf> {
    let path = context.temp_paths().next_path(purpose, extension);
    ensure_parent_dir(&path)?;
    Ok(path)
}

fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn read_prefix(path: &Path, len: usize) -> Result<Vec<u8>> {
    let mut input = File::open(path)?;
    let mut output = vec![0u8; len];
    let read = input.read(&mut output)?;
    output.truncate(read);
    Ok(output)
}

fn read_bytes_at(path: &Path, offset: u64, len: usize) -> Result<Option<Vec<u8>>> {
    let file_len = fs::metadata(path)?.len();
    let len_u64 = u64::try_from(len)
        .map_err(|_| RomWeaverError::Validation("RUP read length exceeded u64".into()))?;
    if offset.checked_add(len_u64).is_none_or(|end| end > file_len) {
        return Ok(None);
    }
    Ok(Some(read_exact_at(path, offset, len_u64)?))
}

fn read_exact_at(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>> {
    let mut input = File::open(path)?;
    input.seek(SeekFrom::Start(offset))?;
    let len = usize_from_u64(len, "RUP read length")?;
    let mut output = vec![0u8; len];
    input.read_exact(&mut output)?;
    Ok(output)
}

fn read_u16_le_from_slice(bytes: &[u8], offset: usize) -> Option<u16> {
    let raw = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([raw[0], raw[1]]))
}

fn build_rup_prepared_tasks(record_count: usize) -> Vec<RupPreparedTask> {
    (0..record_count)
        .map(|index| RupPreparedTask { index })
        .collect()
}

fn prepare_rup_write_task(
    task: &RupPreparedTask,
    file: &RupFile,
    input_path: &Path,
    input_len: u64,
    output_len: usize,
    context: &OperationContext,
) -> Result<RupPreparedRecord> {
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

    let mut input = File::open(input_path)?;
    let mut bytes = Vec::new();
    let mut writer = io::BufWriter::new(&mut bytes);
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
    drop(writer);
    Ok(RupPreparedRecord {
        index: task.index,
        bytes,
    })
}

fn apply_rup_prepared_records(
    file: &RupFile,
    records: &[RupPreparedRecord],
    output: &mut File,
    context: &OperationContext,
) -> Result<()> {
    for prepared in records {
        context.cancel().check()?;
        let record = file.records.get(prepared.index).ok_or_else(|| {
            RomWeaverError::Validation("RUP apply record index was out of bounds".into())
        })?;
        output.seek(SeekFrom::Start(record.offset))?;
        output.write_all(&prepared.bytes)?;
    }
    Ok(())
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

    if crate::create_exceeds_main_thread_cap(source_size.saturating_add(target_size)) {
        info!(
            source_size,
            target_size,
            "RUP create: combined size exceeds in-memory limit; falling back to serial path"
        );
        return create_rup_patch_streaming(source_path, target_path)
            .map(|p| {
                // Extract records from the created patch by re-parsing
                parse_rup_bytes(&p.bytes)
                    .map(|parsed| parsed.files.into_iter().flat_map(|f| f.records).collect())
            })
            .and_then(|r| r);
    }

    let chunk_size = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    // Each chunk scan is wrapped in `Ok(...)` so the shared fail-fast collect
    // never engages: RUP keeps collecting every chunk and surfaces scan
    // errors in chunk order from the merge loop below, exactly as before.
    let per_chunk = scan_create_chunks(
        crate::PatchCreateSources {
            original_path: source_path,
            original_len: source_size,
            modified_path: target_path,
            modified_len: target_size,
        },
        shared_len,
        chunk_size,
        chunk_count_for_len(shared_len, chunk_size),
        pool,
        |start, source_bytes, target_bytes| {
            Ok(collect_rup_chunk_records_from_bytes(
                start,
                source_bytes,
                target_bytes,
            ))
        },
        |chunk_index| {
            let start = chunk_index as u64 * chunk_size;
            let end = start.saturating_add(chunk_size).min(shared_len);
            Ok(collect_rup_chunk_records(
                source_path,
                source_size,
                target_path,
                target_size,
                start,
                end,
            ))
        },
    )?;

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

fn collect_rup_chunk_records_from_bytes(
    start: u64,
    source_bytes: &[u8],
    target_bytes: &[u8],
) -> Result<Vec<RupRecord>> {
    let mut records = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_xor = Vec::<u8>::new();
    let mut absolute = start;

    for (index, &target_byte) in target_bytes.iter().enumerate() {
        let source_byte = source_bytes.get(index).copied().unwrap_or(0);
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

fn md5_open_file(file: &mut File) -> Result<[u8; 16]> {
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

/// Decode a RUP (NINJA2) length-prefixed VLV: a 1-byte length (0..=8) followed by
/// that many little-endian value bytes. Shared by the streaming and slice parsers.
fn read_rup_vlv(mut read_u8: impl FnMut() -> Result<u8>) -> Result<u64> {
    let encoded_len = usize::from(read_u8()?);
    if encoded_len > 8 {
        return Err(RomWeaverError::Validation(
            "RUP VLV length exceeded 64-bit range".into(),
        ));
    }

    let mut value = 0u64;
    for index in 0..encoded_len {
        let byte = u64::from(read_u8()?);
        let shift = (index * 8) as u32;
        value |= byte << shift;
    }

    Ok(value)
}

/// Decode a NUL-terminated fixed-length RUP string field (bytes from the first
/// NUL onward are dropped; each remaining byte maps to a `char`).
fn rup_fixed_string(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let trimmed_len = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    bytes[..trimmed_len]
        .iter()
        .map(|byte| char::from(*byte))
        .collect()
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
        read_rup_vlv(|| self.read_u8())
    }

    fn read_fixed_string(&mut self, len: usize) -> Result<String> {
        Ok(rup_fixed_string(self.read_exact(len)?))
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
        read_rup_vlv(|| self.read_u8())
    }

    fn read_fixed_string(&mut self, len: usize) -> Result<String> {
        Ok(rup_fixed_string(self.read_exact(len)?))
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
