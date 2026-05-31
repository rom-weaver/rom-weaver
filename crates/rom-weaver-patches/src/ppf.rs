use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use tracing::info;

use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability,
};

const PPF_HEADER_MIN_SIZE: usize = 56;
const PPF2_HEADER_SIZE: usize = 1084;
const PPF3_HEADER_BASE_SIZE: usize = 60;
const PPF_VALIDATION_BLOCK_SIZE: usize = 1024;
const PPF2_BLOCKCHECK_OFFSET: u64 = 0x9320;
const PPF3_BIN_BLOCKCHECK_OFFSET: u64 = 0x9320;
const PPF3_GI_BLOCKCHECK_OFFSET: u64 = 0x80A0;
#[cfg(test)]
const FILE_ID_BEGIN_MARKER: &[u8] = b"@BEGIN_FILE_ID.DIZ";
#[cfg(test)]
const FILE_ID_END_MARKER: &[u8] = b"@END_FILE_ID.DIZ";
const FILE_ID_TRAILER_MAGIC: &[u8; 4] = b".DIZ";
const PPF2_FILE_ID_OVERHEAD: usize = 38;
const PPF3_FILE_ID_OVERHEAD: usize = 36;
const PPF3_FILE_ID_PADDED_OVERHEAD: usize = 38;
const PPF3_DEFAULT_DESCRIPTION: &str = "rom-weaver PPF3 patch";
const PPF3_ENCODING_METHOD: u8 = 0x02;
const CREATE_COMPARE_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

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
        let thread_capability = ppf_apply_thread_capability(parsed.records.len());
        let planned_execution = context.plan_threads(thread_capability.clone());
        let ppf_output_len = ppf_required_output_len(input_len, &parsed.records);
        let execution = if crate::can_apply_in_memory(input_len, ppf_output_len) {
            let mut output_bytes = fs::read(&request.input)?;
            output_bytes.resize(ppf_output_len as usize, 0);
            let use_undo = should_apply_undo_data_in_memory(&output_bytes, &parsed.records);
            apply_records_in_memory(&parsed.records, use_undo, &mut output_bytes)?;
            fs::write(&request.output, &output_bytes)?;
            let mut execution = planned_execution;
            execution.effective_threads = 1;
            execution.used_parallelism = false;
            execution
        } else {
            fs::copy(&request.input, &request.output)?;
            let mut output = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&request.output)?;
            let use_undo_data = should_apply_undo_data(&mut output, &parsed.records)?;
            let execution = if planned_execution.used_parallelism {
                let (execution, pool) = context.build_pool(thread_capability)?;
                let prepared =
                    prepare_ppf_writes_parallel(&parsed.records, use_undo_data, &pool, context)?;
                apply_prepared_ppf_writes(&mut output, &prepared)?;
                execution
            } else {
                apply_records(&mut output, &parsed.records, use_undo_data)?;
                planned_execution
            };
            output.flush()?;
            execution
        };

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
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        let (execution, pool) = context.build_pool(ppf_create_thread_capability(modified_len))?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        let created = create_ppf3_patch(
            &request.original,
            original_len,
            &request.modified,
            modified_len,
            &pool,
            execution.used_parallelism,
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
            threaded_diff: true,
            threaded_output: true,
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

struct PreparedPpfWrite {
    offset: u64,
    data: Vec<u8>,
}

fn ppf_create_thread_capability(modified_len: u64) -> ThreadCapability {
    let chunk_count = ppf_create_chunk_count(modified_len).max(1);
    ThreadCapability::parallel(Some(chunk_count))
}

fn ppf_apply_thread_capability(record_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(record_count.max(1)))
}

fn ppf_create_chunk_count(modified_len: u64) -> usize {
    if modified_len == 0 {
        return 1;
    }
    let chunk_bytes = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_count = modified_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).unwrap_or(usize::MAX)
}

fn create_ppf3_patch(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
    output: &mut impl Write,
) -> Result<CreatedPpfPatch> {
    if use_parallel_scan {
        if crate::patches_reads_source_on_main_thread() {
            let combined = original_len.saturating_add(modified_len);
            if combined > crate::IN_MEMORY_APPLY_LIMIT_BYTES {
                info!(
                    original_len,
                    modified_len,
                    "PPF create: combined size exceeds in-memory limit; falling back to serial path"
                );
                return create_ppf3_patch_streaming(
                    original_path,
                    original_len,
                    modified_path,
                    modified_len,
                    output,
                );
            }
        }
        create_ppf3_patch_parallel(
            original_path,
            original_len,
            modified_path,
            modified_len,
            pool,
            output,
        )
    } else {
        create_ppf3_patch_streaming(
            original_path,
            original_len,
            modified_path,
            modified_len,
            output,
        )
    }
}

fn parse_ppf_file(path: &Path) -> Result<ParsedPpfPatch> {
    let file_len = fs::metadata(path)?.len();
    if file_len < PPF_HEADER_MIN_SIZE as u64 {
        return Err(RomWeaverError::Validation(
            "PPF patch is too small to contain a valid header".into(),
        ));
    }

    let mut file = File::open(path)?;
    let mut header = vec![0u8; PPF_HEADER_MIN_SIZE];
    file.read_exact(&mut header)?;
    let version = detect_version(&header)?;

    match version {
        PpfVersion::V1 => {
            let records =
                parse_records_v1_v2_from_path(path, PPF_HEADER_MIN_SIZE as u64, file_len)?;
            Ok(ParsedPpfPatch {
                version: PpfVersion::V1,
                expected_input_len: None,
                blockcheck: None,
                records,
            })
        }
        PpfVersion::V2 => {
            if file_len < PPF2_HEADER_SIZE as u64 {
                return Err(RomWeaverError::Validation(
                    "PPF2 patch is too small to contain a validation header".into(),
                ));
            }
            file.seek(SeekFrom::Start(0))?;
            let mut v2_header = vec![0u8; PPF2_HEADER_SIZE];
            file.read_exact(&mut v2_header)?;
            let expected_input_len = u64::from(read_u32_le(&v2_header, 56)?);
            let file_id_len = detect_file_id_len_v2_from_path(path, file_len)?;
            let payload_end = file_len.checked_sub(file_id_len as u64).ok_or_else(|| {
                RomWeaverError::Validation("PPF2 file_id length exceeded file size".into())
            })?;
            if payload_end < PPF2_HEADER_SIZE as u64 {
                return Err(RomWeaverError::Validation(
                    "PPF2 payload ended before record data started".into(),
                ));
            }

            let records =
                parse_records_v1_v2_from_path(path, PPF2_HEADER_SIZE as u64, payload_end)?;
            Ok(ParsedPpfPatch {
                version: PpfVersion::V2,
                expected_input_len: Some(expected_input_len),
                blockcheck: Some(PpfBlockcheck {
                    input_offset: PPF2_BLOCKCHECK_OFFSET,
                    expected: v2_header[60..(60 + PPF_VALIDATION_BLOCK_SIZE)].to_vec(),
                }),
                records,
            })
        }
        PpfVersion::V3 => {
            if file_len < PPF3_HEADER_BASE_SIZE as u64 {
                return Err(RomWeaverError::Validation(
                    "PPF3 patch is too small to contain a valid header".into(),
                ));
            }
            file.seek(SeekFrom::Start(0))?;
            let mut v3_header = vec![0u8; PPF3_HEADER_BASE_SIZE];
            file.read_exact(&mut v3_header)?;

            let imagetype = v3_header[56];
            let blockcheck_enabled = v3_header[57] != 0;
            let undo_enabled = v3_header[58] != 0;

            let (payload_start, blockcheck) = if blockcheck_enabled {
                if file_len < PPF2_HEADER_SIZE as u64 {
                    return Err(RomWeaverError::Validation(
                        "PPF3 patch enabled blockcheck but omitted the validation block".into(),
                    ));
                }
                file.seek(SeekFrom::Start(60))?;
                let mut expected = vec![0u8; PPF_VALIDATION_BLOCK_SIZE];
                file.read_exact(&mut expected)?;
                let input_offset = if imagetype == 0 {
                    PPF3_BIN_BLOCKCHECK_OFFSET
                } else {
                    PPF3_GI_BLOCKCHECK_OFFSET
                };
                (
                    PPF2_HEADER_SIZE as u64,
                    Some(PpfBlockcheck {
                        input_offset,
                        expected,
                    }),
                )
            } else {
                (PPF3_HEADER_BASE_SIZE as u64, None)
            };

            let file_id_len = detect_file_id_len_v3_from_path(path, file_len)?;
            let payload_end = file_len.checked_sub(file_id_len as u64).ok_or_else(|| {
                RomWeaverError::Validation("PPF3 file_id length exceeded file size".into())
            })?;
            if payload_end < payload_start {
                return Err(RomWeaverError::Validation(
                    "PPF3 payload ended before record data started".into(),
                ));
            }
            let records =
                parse_records_v3_from_path(path, payload_start, payload_end, undo_enabled)?;

            Ok(ParsedPpfPatch {
                version: PpfVersion::V3,
                expected_input_len: None,
                blockcheck,
                records,
            })
        }
    }
}

#[cfg(test)]
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
                    let start = pending_start.ok_or_else(|| {
                        RomWeaverError::Validation(
                            "internal PPF state error: pending diff data missing start offset"
                                .into(),
                        )
                    })?;
                    write_ppf3_record(output, start, &pending_data)?;
                    pending_data.clear();
                    pending_start = None;
                    record_count = record_count.saturating_add(1);
                }
            } else if !pending_data.is_empty() {
                let start = pending_start.ok_or_else(|| {
                    RomWeaverError::Validation(
                        "internal PPF state error: pending diff data missing start offset".into(),
                    )
                })?;
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
        let start = pending_start.ok_or_else(|| {
            RomWeaverError::Validation(
                "internal PPF state error: trailing pending diff data missing start offset".into(),
            )
        })?;
        write_ppf3_record(output, start, &pending_data)?;
        record_count = record_count.saturating_add(1);
    }

    Ok(CreatedPpfPatch {
        record_count,
        blockcheck_enabled,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PpfDiffRun {
    offset: u64,
    len: u8,
}

fn create_ppf3_patch_parallel(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
    output: &mut impl Write,
) -> Result<CreatedPpfPatch> {
    if modified_len < original_len {
        return Err(RomWeaverError::Validation(format!(
            "PPF create does not support shrinking outputs (original: {}, modified: {})",
            original_len, modified_len
        )));
    }

    let blockcheck_enabled = write_ppf3_header(output, original_path, original_len)?;
    let runs = collect_ppf_diff_runs_parallel(
        original_path,
        original_len,
        modified_path,
        modified_len,
        pool,
    )?;
    let mut modified = BufReader::new(File::open(modified_path)?);

    for run in &runs {
        let data_len = usize::from(run.len);
        let mut data = vec![0u8; data_len];
        modified.seek(SeekFrom::Start(run.offset))?;
        modified.read_exact(&mut data)?;
        write_ppf3_record(output, run.offset, &data)?;
    }

    Ok(CreatedPpfPatch {
        record_count: runs.len(),
        blockcheck_enabled,
    })
}

fn collect_ppf_diff_runs_parallel(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
) -> Result<Vec<PpfDiffRun>> {
    let chunk_size = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_ranges = (0..modified_len)
        .step_by(CREATE_THREAD_SCAN_CHUNK_BYTES)
        .map(|start| {
            let end = start.saturating_add(chunk_size).min(modified_len);
            start..end
        })
        .collect::<Vec<_>>();

    let per_chunk_runs = if crate::patches_reads_source_on_main_thread() {
        let buffered = chunk_ranges
            .iter()
            .map(|range| {
                crate::read_original_modified_chunk(
                    original_path,
                    original_len,
                    modified_path,
                    range.start,
                    range.end,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        pool.install(|| {
            buffered
                .into_par_iter()
                .zip(chunk_ranges.into_par_iter())
                .map(|((original_bytes, modified_bytes), range)| {
                    collect_ppf_chunk_diff_runs_from_bytes(
                        range.start,
                        &original_bytes,
                        &modified_bytes,
                    )
                })
                .collect::<Vec<_>>()
        })
    } else {
        pool.install(|| {
            chunk_ranges
                .into_par_iter()
                .map(|range| {
                    collect_ppf_chunk_diff_runs(
                        original_path,
                        original_len,
                        modified_path,
                        range.start,
                        range.end,
                    )
                })
                .collect::<Vec<_>>()
        })
    };

    let mut merged: Vec<PpfDiffRun> = Vec::new();
    for runs in per_chunk_runs {
        let runs = runs?;
        for run in runs {
            if let Some(last) = merged.last_mut() {
                let contiguous = last
                    .offset
                    .checked_add(u64::from(last.len))
                    .is_some_and(|end| end == run.offset);
                if contiguous {
                    let combined_len = usize::from(last.len) + usize::from(run.len);
                    if combined_len <= usize::from(u8::MAX) {
                        last.len = combined_len as u8;
                        continue;
                    }
                }
            }
            merged.push(run);
        }
    }
    Ok(merged)
}

fn collect_ppf_chunk_diff_runs(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    start: u64,
    end: u64,
) -> Result<Vec<PpfDiffRun>> {
    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    if start < original_len {
        original.seek(SeekFrom::Start(start))?;
    }
    modified.seek(SeekFrom::Start(start))?;

    let mut original_buffer = vec![0u8; CREATE_COMPARE_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; CREATE_COMPARE_BUFFER_SIZE];
    let mut runs = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_len = 0usize;
    let mut absolute = start;

    while absolute < end {
        let chunk_len = usize::try_from((end - absolute).min(CREATE_COMPARE_BUFFER_SIZE as u64))
            .map_err(|_| {
                RomWeaverError::Validation("PPF create chunk exceeded addressable memory".into())
            })?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        let original_chunk_len = if absolute >= original_len {
            0
        } else {
            usize::try_from((original_len - absolute).min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("PPF create source chunk exceeded usize".into())
            })?
        };
        if original_chunk_len > 0 {
            original.read_exact(&mut original_buffer[..original_chunk_len])?;
        }

        for index in 0..chunk_len {
            let differs = if index < original_chunk_len {
                original_buffer[index] != modified_buffer[index]
            } else {
                true
            };
            if differs {
                if pending_start.is_none() {
                    pending_start = Some(absolute);
                }
                pending_len = pending_len.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("PPF diff run length overflowed".into())
                })?;
                if pending_len == usize::from(u8::MAX) {
                    let run_start = pending_start.ok_or_else(|| {
                        RomWeaverError::Validation(
                            "internal PPF state error: pending run missing start offset".into(),
                        )
                    })?;
                    runs.push(PpfDiffRun {
                        offset: run_start,
                        len: u8::MAX,
                    });
                    pending_start = None;
                    pending_len = 0;
                }
            } else if pending_len > 0 {
                let run_start = pending_start.ok_or_else(|| {
                    RomWeaverError::Validation(
                        "internal PPF state error: pending run missing start offset".into(),
                    )
                })?;
                runs.push(PpfDiffRun {
                    offset: run_start,
                    len: pending_len as u8,
                });
                pending_start = None;
                pending_len = 0;
            }
            absolute = absolute
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PPF create offset overflowed".into()))?;
        }
    }

    if pending_len > 0 {
        let run_start = pending_start.ok_or_else(|| {
            RomWeaverError::Validation(
                "internal PPF state error: trailing pending run missing start offset".into(),
            )
        })?;
        runs.push(PpfDiffRun {
            offset: run_start,
            len: pending_len as u8,
        });
    }
    Ok(runs)
}

fn collect_ppf_chunk_diff_runs_from_bytes(
    start: u64,
    original_bytes: &[u8],
    modified_bytes: &[u8],
) -> Result<Vec<PpfDiffRun>> {
    let mut runs = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_len = 0usize;
    let mut absolute = start;

    for index in 0..modified_bytes.len() {
        let differs = original_bytes
            .get(index)
            .is_none_or(|o| *o != modified_bytes[index]);
        if differs {
            if pending_start.is_none() {
                pending_start = Some(absolute);
            }
            pending_len = pending_len.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation("PPF diff run length overflowed".into())
            })?;
            if pending_len == usize::from(u8::MAX) {
                let run_start = pending_start.ok_or_else(|| {
                    RomWeaverError::Validation(
                        "internal PPF state error: pending run missing start offset".into(),
                    )
                })?;
                runs.push(PpfDiffRun {
                    offset: run_start,
                    len: u8::MAX,
                });
                pending_start = None;
                pending_len = 0;
            }
        } else if pending_len > 0 {
            let run_start = pending_start.ok_or_else(|| {
                RomWeaverError::Validation(
                    "internal PPF state error: pending run missing start offset".into(),
                )
            })?;
            runs.push(PpfDiffRun {
                offset: run_start,
                len: pending_len as u8,
            });
            pending_start = None;
            pending_len = 0;
        }
        absolute = absolute
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("PPF create offset overflowed".into()))?;
    }

    if pending_len > 0 {
        let run_start = pending_start.ok_or_else(|| {
            RomWeaverError::Validation(
                "internal PPF state error: trailing pending run missing start offset".into(),
            )
        })?;
        runs.push(PpfDiffRun {
            offset: run_start,
            len: pending_len as u8,
        });
    }
    Ok(runs)
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

#[cfg(test)]
fn parse_ppf_v1(bytes: &[u8]) -> Result<ParsedPpfPatch> {
    let records = parse_records_v1_v2(bytes, PPF_HEADER_MIN_SIZE, bytes.len())?;
    Ok(ParsedPpfPatch {
        version: PpfVersion::V1,
        expected_input_len: None,
        blockcheck: None,
        records,
    })
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

fn parse_records_v1_v2_from_path(path: &Path, start: u64, end: u64) -> Result<Vec<PpfRecord>> {
    let mut file = BufReader::new(File::open(path)?);
    file.seek(SeekFrom::Start(start))?;
    let mut cursor = start;
    let mut records = Vec::new();

    while cursor < end {
        let remaining = end.saturating_sub(cursor);
        if remaining < 5 {
            return Err(RomWeaverError::Validation(
                "PPF record header exceeded patch bounds".into(),
            ));
        }

        let mut header = [0u8; 5];
        file.read_exact(&mut header)?;
        cursor = cursor.saturating_add(5);
        let offset = u64::from(u32::from_le_bytes([
            header[0], header[1], header[2], header[3],
        ]));
        let len = usize::from(header[4]);
        let len_u64 = u64::try_from(len)
            .map_err(|_| RomWeaverError::Validation("PPF record length overflowed".into()))?;
        if cursor.saturating_add(len_u64) > end {
            return Err(RomWeaverError::Validation(
                "PPF record data exceeded patch bounds".into(),
            ));
        }

        let mut data = vec![0u8; len];
        file.read_exact(&mut data)?;
        cursor = cursor.saturating_add(len_u64);
        records.push(PpfRecord {
            offset,
            data,
            undo_data: None,
        });
    }

    Ok(records)
}

fn parse_records_v3_from_path(
    path: &Path,
    start: u64,
    end: u64,
    undo_enabled: bool,
) -> Result<Vec<PpfRecord>> {
    let mut file = BufReader::new(File::open(path)?);
    file.seek(SeekFrom::Start(start))?;
    let mut cursor = start;
    let mut records = Vec::new();

    while cursor < end {
        let remaining = end.saturating_sub(cursor);
        if remaining < 9 {
            return Err(RomWeaverError::Validation(
                "PPF3 record header exceeded patch bounds".into(),
            ));
        }

        let mut header = [0u8; 9];
        file.read_exact(&mut header)?;
        cursor = cursor.saturating_add(9);
        let offset = u64::from_le_bytes([
            header[0], header[1], header[2], header[3], header[4], header[5], header[6], header[7],
        ]);
        if offset > i64::MAX as u64 {
            return Err(RomWeaverError::Validation(
                "PPF3 record offset exceeded supported range".into(),
            ));
        }
        let len = usize::from(header[8]);
        let len_u64 = u64::try_from(len)
            .map_err(|_| RomWeaverError::Validation("PPF3 record length overflowed".into()))?;
        if cursor.saturating_add(len_u64) > end {
            return Err(RomWeaverError::Validation(
                "PPF3 record data exceeded patch bounds".into(),
            ));
        }

        let mut data = vec![0u8; len];
        file.read_exact(&mut data)?;
        cursor = cursor.saturating_add(len_u64);

        let undo_data = if undo_enabled {
            if cursor.saturating_add(len_u64) > end {
                return Err(RomWeaverError::Validation(
                    "PPF3 undo data exceeded patch bounds".into(),
                ));
            }
            let mut undo = vec![0u8; len];
            file.read_exact(&mut undo)?;
            cursor = cursor.saturating_add(len_u64);
            Some(undo)
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

fn detect_file_id_len_v2_from_path(path: &Path, file_len: u64) -> Result<usize> {
    detect_file_id_len_from_footer_magic_path(path, file_len, 4, PPF2_FILE_ID_OVERHEAD, "PPF2")
}

fn detect_file_id_len_v3_from_path(path: &Path, file_len: u64) -> Result<usize> {
    let unpadded = detect_file_id_len_from_footer_magic_path(
        path,
        file_len,
        2,
        PPF3_FILE_ID_OVERHEAD,
        "PPF3",
    )?;
    if unpadded != 0 {
        return Ok(unpadded);
    }
    detect_file_id_len_from_footer_magic_path(
        path,
        file_len,
        4,
        PPF3_FILE_ID_PADDED_OVERHEAD,
        "PPF3",
    )
}

fn detect_file_id_len_from_footer_magic_path(
    path: &Path,
    file_len: u64,
    length_size: usize,
    overhead: usize,
    label: &str,
) -> Result<usize> {
    let minimum = length_size
        .checked_add(FILE_ID_TRAILER_MAGIC.len())
        .ok_or_else(|| RomWeaverError::Validation("file_id footer size overflowed".into()))?;
    if file_len < minimum as u64 {
        return Ok(0);
    }

    let magic_offset = file_len
        .checked_sub(minimum as u64)
        .ok_or_else(|| RomWeaverError::Validation("file_id footer offset overflowed".into()))?;
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(magic_offset))?;
    let mut footer = vec![0u8; minimum];
    file.read_exact(&mut footer)?;
    if &footer[..FILE_ID_TRAILER_MAGIC.len()] != FILE_ID_TRAILER_MAGIC {
        return Ok(0);
    }

    let id_len = match length_size {
        2 => usize::from(u16::from_le_bytes([
            footer[minimum - 2],
            footer[minimum - 1],
        ])),
        4 => usize::try_from(u32::from_le_bytes([
            footer[minimum - 4],
            footer[minimum - 3],
            footer[minimum - 2],
            footer[minimum - 1],
        ]))
        .map_err(|_| {
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
    if u64::try_from(total)
        .ok()
        .is_none_or(|total_u64| total_u64 > file_len)
    {
        return Err(RomWeaverError::Validation(format!(
            "{label} file_id length exceeded patch size"
        )));
    }

    Ok(total)
}

#[cfg(test)]
fn detect_file_id_len_v2(bytes: &[u8], payload_start: usize) -> Result<usize> {
    detect_file_id_len(bytes, payload_start, FileIdTrailerKind::V2)
}

#[cfg(test)]
fn detect_file_id_len_v3(bytes: &[u8], payload_start: usize) -> Result<usize> {
    detect_file_id_len(bytes, payload_start, FileIdTrailerKind::V3)
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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
#[cfg(test)]
enum FileIdTrailerKind {
    V2,
    V3,
}

#[cfg(test)]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
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

    if actual.as_slice() != blockcheck.expected.as_slice() {
        return Err(RomWeaverError::Validation(
            "PPF binblock/patchvalidation failed".into(),
        ));
    }

    Ok(())
}

fn ppf_required_output_len(input_len: u64, records: &[PpfRecord]) -> u64 {
    records.iter().fold(input_len, |max_len, record| {
        let end = record.offset.saturating_add(record.data.len() as u64);
        max_len.max(end)
    })
}

fn should_apply_undo_data_in_memory(bytes: &[u8], records: &[PpfRecord]) -> bool {
    let Some(first) = records.first() else {
        return false;
    };
    if first.undo_data.is_none() {
        return false;
    }
    let start = first.offset as usize;
    let end = start + first.data.len();
    bytes.get(start..end) == Some(first.data.as_slice())
}

fn apply_records_in_memory(
    records: &[PpfRecord],
    use_undo_data: bool,
    output: &mut Vec<u8>,
) -> Result<()> {
    for record in records {
        let payload = if use_undo_data {
            record.undo_data.as_deref().unwrap_or(record.data.as_ref())
        } else {
            record.data.as_ref()
        };
        let start = record.offset as usize;
        let end = start + payload.len();
        if end > output.len() {
            return Err(RomWeaverError::Validation(
                "PPF record exceeded output size".into(),
            ));
        }
        output[start..end].copy_from_slice(payload);
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

    Ok(current_bytes.as_slice() == first_record.data.as_slice())
}

fn apply_records(file: &mut File, records: &[PpfRecord], use_undo_data: bool) -> Result<()> {
    for record in records {
        file.seek(SeekFrom::Start(record.offset))?;
        let payload = if use_undo_data {
            record.undo_data.as_deref().unwrap_or(record.data.as_ref())
        } else {
            record.data.as_ref()
        };
        file.write_all(payload)?;
    }
    Ok(())
}

fn prepare_ppf_writes_parallel(
    records: &[PpfRecord],
    use_undo_data: bool,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedPpfWrite>> {
    pool.install(|| {
        records
            .par_iter()
            .map(|record| {
                context.cancel().check()?;
                let payload = if use_undo_data {
                    record.undo_data.as_deref().unwrap_or(record.data.as_ref())
                } else {
                    record.data.as_ref()
                };
                Ok(PreparedPpfWrite {
                    offset: record.offset,
                    data: payload.to_vec(),
                })
            })
            .collect::<Result<Vec<_>>>()
    })
}

fn apply_prepared_ppf_writes(file: &mut File, writes: &[PreparedPpfWrite]) -> Result<()> {
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        file.seek(SeekFrom::Start(write.offset))?;
        file.write_all(&write.data)?;
    }
    Ok(())
}

#[cfg(test)]
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

#[cfg(test)]
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
#[path = "../tests/unit/ppf.rs"]
mod tests;
