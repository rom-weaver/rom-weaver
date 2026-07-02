use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use tracing::{debug, trace};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, PatchValidateRequest, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool,
};

use crate::checksum_validation_suffix;
use crate::shared::runs::{AdjacentRun, merge_adjacent_runs};
use crate::shared::threading::{
    PreparedWrite, apply_prepared_writes, parallel_chunked_capability,
    parallel_per_record_capability, pool_map, run_with_optional_pool, scan_create_chunks,
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
        if parsed.has_undo_data() {
            label.push_str("; includes undo data");
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
            "ppf patch apply start"
        );
        let parsed = parse_ppf_file(patch_path)?;
        let validate_checksums = context.strict_patch_checksums();
        let input_len = fs::metadata(&request.input)?.len();
        trace!(
            format = self.descriptor.name,
            version = parsed.version.label(),
            records = parsed.records.len(),
            input_len,
            has_undo = parsed.has_undo_data(),
            "ppf parsed"
        );

        if let Some(expected_len) = parsed.expected_input_len
            && input_len != expected_len
        {
            return Err(RomWeaverError::Validation(format!(
                "PPF2 input size invalid; expected {expected_len}, got {input_len}"
            )));
        }

        let undo_aware = context.ppf_undo_aware() && parsed.has_undo_data();
        let mut undo_note = String::new();
        if validate_checksums {
            if let Some(blockcheck) = &parsed.blockcheck {
                if undo_aware {
                    if validate_blockcheck_undo_aware(&request.input, blockcheck, &parsed.records)?
                    {
                        undo_note =
                            "; undo-aware re-apply (reconstructed already-applied validation region)"
                                .to_string();
                    }
                } else {
                    validate_blockcheck(&request.input, blockcheck)?;
                }
            } else if undo_aware && detect_already_patched(&request.input, &parsed.records)? {
                undo_note = "; undo-aware re-apply (input already patched)".to_string();
            }
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let thread_capability = parallel_per_record_capability(parsed.records.len());
        let ppf_output_len = ppf_required_output_len(input_len, &parsed.records);
        let in_memory = crate::can_apply_in_memory(input_len, ppf_output_len);
        trace!(
            format = self.descriptor.name,
            in_memory, ppf_output_len, "ppf apply path chosen"
        );
        let execution = if in_memory {
            let mut execution = context.plan_threads(thread_capability.clone());
            let mut output_bytes = fs::read(&request.input)?;
            output_bytes.resize(ppf_output_len as usize, 0);
            apply_records_in_memory(&parsed.records, &mut output_bytes)?;
            fs::write(&request.output, &output_bytes)?;
            execution.force_serial();
            execution
        } else {
            fs::copy(&request.input, &request.output)?;
            let mut output = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&request.output)?;
            let (execution, prepared) = run_with_optional_pool(
                context,
                thread_capability,
                true,
                |pool| prepare_ppf_writes_parallel(&parsed.records, pool, context).map(Some),
                || {
                    apply_records(&mut output, &parsed.records)?;
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
                "applied {} patch ({}) with {} record(s){}{}",
                self.descriptor.name,
                parsed.version.label(),
                parsed.records.len(),
                undo_note,
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
        let parsed = parse_ppf_file(patch_path)?;
        let validate_checksums = context.strict_patch_checksums();
        let input_len = fs::metadata(&request.input)?.len();

        if let Some(expected_len) = parsed.expected_input_len
            && input_len != expected_len
        {
            return Err(RomWeaverError::Validation(format!(
                "PPF2 input size invalid; expected {expected_len}, got {input_len}"
            )));
        }

        if validate_checksums && let Some(blockcheck) = &parsed.blockcheck {
            validate_blockcheck(&request.input, blockcheck)?;
        }

        let checksum_suffix = checksum_validation_suffix(validate_checksums);
        Ok(crate::patch_success_report(
            self.descriptor,
            "validate",
            format!(
                "validated {} patch ({}) with {} record(s){}",
                self.descriptor.name,
                parsed.version.label(),
                parsed.records.len(),
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
            original_len, modified_len, "ppf patch create start (PPF3)"
        );
        let (execution, pool) = context.build_pool(parallel_chunked_capability(
            modified_len,
            CREATE_THREAD_SCAN_CHUNK_BYTES as u64,
        ))?;
        trace!(
            format = self.descriptor.name,
            parallel = execution.used_parallelism,
            threads = execution.effective_threads,
            "ppf create thread plan"
        );

        let mut output = crate::create_buffered_output(&request.output)?;
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

        Ok(crate::patch_success_report(
            self.descriptor,
            "create",
            format!(
                "created {} patch (PPF3) with {} record(s), {blockcheck_label}",
                self.descriptor.name, created.record_count
            ),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
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

impl ParsedPpfPatch {
    fn has_undo_data(&self) -> bool {
        self.records.iter().any(|record| record.undo_data.is_some())
    }
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
    len: u64,
}

impl PpfDiffRun {
    fn end(&self) -> Result<u64> {
        self.offset
            .checked_add(self.len)
            .ok_or_else(|| RomWeaverError::Validation("PPF diff run offset overflowed".into()))
    }
}

impl AdjacentRun for PpfDiffRun {
    fn start(&self) -> u64 {
        self.offset
    }

    fn end(&self) -> Result<u64> {
        PpfDiffRun::end(self)
    }

    fn append(&mut self, next: Self) {
        self.len = self.len.saturating_add(next.len);
    }
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
    let mut data = vec![0u8; usize::from(u8::MAX)];
    let mut record_count = 0usize;

    // Each run is a fully-merged contiguous diff region; split it into maximal
    // 255-byte records aligned from the run start so the bytes are identical to
    // the serial path regardless of how the chunk boundaries fell.
    for run in &runs {
        modified.seek(SeekFrom::Start(run.offset))?;
        let mut record_offset = run.offset;
        let mut remaining = run.len;
        while remaining > 0 {
            let take = remaining.min(u64::from(u8::MAX)) as usize;
            modified.read_exact(&mut data[..take])?;
            write_ppf3_record(output, record_offset, &data[..take])?;
            record_offset = record_offset
                .checked_add(take as u64)
                .ok_or_else(|| RomWeaverError::Validation("PPF create offset overflowed".into()))?;
            remaining -= take as u64;
            record_count = record_count.saturating_add(1);
        }
    }

    Ok(CreatedPpfPatch {
        record_count,
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
    // Empty modified inputs scan zero chunks (matching the old `step_by`
    // ranges), not the one floor chunk `chunk_count_for_len` would plan.
    let chunk_count = usize::try_from(modified_len.div_ceil(chunk_size)).unwrap_or(usize::MAX);
    // Each chunk scan is wrapped in `Ok(...)` so the shared fail-fast collect
    // never engages: PPF keeps collecting every chunk and surfaces scan
    // errors in chunk order from the merge loop below, exactly as before.
    let per_chunk_runs = scan_create_chunks(chunk_count, pool, |chunk_index| {
        let start = chunk_index as u64 * chunk_size;
        let end = start.saturating_add(chunk_size).min(modified_len);
        Ok(collect_ppf_chunk_diff_runs(
            original_path,
            original_len,
            modified_path,
            start,
            end,
        ))
    })?;

    // Fully fuse contiguous runs across chunk boundaries (no 255 cap) so the
    // merged runs are independent of how many chunks the scan used; the writer
    // then re-splits them into maximal 255-byte records (matching serial).
    let mut chunk_runs = Vec::with_capacity(per_chunk_runs.len());
    for runs in per_chunk_runs {
        // Surface scan errors in chunk order, exactly as the previous loop did.
        chunk_runs.push(runs?);
    }
    merge_adjacent_runs(chunk_runs)
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
    let mut pending_len = 0u64;
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
            } else if pending_len > 0 {
                let run_start = pending_start.ok_or_else(|| {
                    RomWeaverError::Validation(
                        "internal PPF state error: pending run missing start offset".into(),
                    )
                })?;
                runs.push(PpfDiffRun {
                    offset: run_start,
                    len: pending_len,
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
            len: pending_len,
        });
    }
    Ok(runs)
}

#[cfg(test)]
fn collect_ppf_chunk_diff_runs_from_bytes(
    start: u64,
    original_bytes: &[u8],
    modified_bytes: &[u8],
    original_len: u64,
) -> Result<Vec<PpfDiffRun>> {
    let mut runs = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_len = 0u64;
    let mut absolute = start;

    for (index, &target) in modified_bytes.iter().enumerate() {
        // Any position past the original's length is new content and always differs. The
        // `original_bytes` buffer is zero-filled past the original, so without this guard a
        // modified 0x00 byte beyond EOF would compare equal to the padding and be dropped --
        // diverging from the worker-read path, which treats every beyond-EOF byte as changed.
        let differs =
            absolute >= original_len || original_bytes.get(index).is_none_or(|o| *o != target);
        if differs {
            if pending_start.is_none() {
                pending_start = Some(absolute);
            }
            pending_len = pending_len.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation("PPF diff run length overflowed".into())
            })?;
        } else if pending_len > 0 {
            let run_start = pending_start.ok_or_else(|| {
                RomWeaverError::Validation(
                    "internal PPF state error: pending run missing start offset".into(),
                )
            })?;
            runs.push(PpfDiffRun {
                offset: run_start,
                len: pending_len,
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
            len: pending_len,
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
    let magic = bytes.get(0..3).ok_or_else(|| {
        crate::coded_validation("PPF_HEADER_TRUNCATED", "PPF patch header is truncated")
    })?;

    if magic != b"PPF" {
        return Err(crate::coded_validation(
            "PPF_HEADER_INVALID",
            "Patch header invalid",
        ));
    }

    let version_digits = bytes.get(3..5).ok_or_else(|| {
        crate::coded_validation(
            "PPF_VERSION_DIGITS_TRUNCATED",
            "PPF patch version digits are truncated",
        )
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

/// Validate a PPF3 blockcheck region while tolerating an already-patched input.
///
/// When this patch has been applied before, the bytes inside the validation region may
/// already hold this patch's data, which would make the plain blockcheck fail. Using the
/// per-record undo (original) bytes, we reconstruct the original validation region for any
/// slice that currently matches the patched data, then compare against the expected block.
///
/// Returns `Ok(true)` when at least one slice was reverted (i.e. the input looked already
/// patched), `Ok(false)` when the region already matched the expected original bytes.
fn validate_blockcheck_undo_aware(
    input_path: &Path,
    blockcheck: &PpfBlockcheck,
    records: &[PpfRecord],
) -> Result<bool> {
    let mut input = File::open(input_path)?;
    input.seek(SeekFrom::Start(blockcheck.input_offset))?;

    let mut region = vec![0; blockcheck.expected.len()];
    input.read_exact(&mut region).map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            RomWeaverError::Validation(format!(
                "PPF validation block read exceeded input length at offset {}",
                blockcheck.input_offset
            ))
        } else {
            error.into()
        }
    })?;

    let region_start = blockcheck.input_offset;
    let region_end = region_start.saturating_add(region.len() as u64);
    let mut reverted = false;

    for record in records {
        let Some(undo) = record.undo_data.as_ref() else {
            continue;
        };
        let record_start = record.offset;
        let record_end = record_start.saturating_add(record.data.len() as u64);
        if record_end <= region_start || record_start >= region_end {
            continue;
        }

        let overlap_start = record_start.max(region_start);
        let overlap_end = record_end.min(region_end);
        let region_lo = (overlap_start - region_start) as usize;
        let region_hi = (overlap_end - region_start) as usize;
        let record_lo = (overlap_start - record_start) as usize;
        let record_hi = (overlap_end - record_start) as usize;

        let patched = &record.data[record_lo..record_hi];
        let original = &undo[record_lo..record_hi];
        // Only revert slices that currently hold this patch's data; leave clean or
        // unknown bytes untouched so a genuinely wrong base ROM still fails validation.
        if &region[region_lo..region_hi] == patched && patched != original {
            region[region_lo..region_hi].copy_from_slice(original);
            reverted = true;
        }
    }

    if region.as_slice() != blockcheck.expected.as_slice() {
        return Err(RomWeaverError::Validation(
            "PPF binblock/patchvalidation failed".into(),
        ));
    }

    Ok(reverted)
}

/// Cheap probe used only to annotate the apply report when the patch has no blockcheck:
/// reads the first undo-capable record's region and reports whether it already holds the
/// patched bytes (i.e. the input appears to have been patched before).
fn detect_already_patched(input_path: &Path, records: &[PpfRecord]) -> Result<bool> {
    let Some(record) = records
        .iter()
        .find(|record| record.undo_data.is_some() && !record.data.is_empty())
    else {
        return Ok(false);
    };
    let undo = record.undo_data.as_ref().expect("record has undo data");
    if undo == &record.data {
        return Ok(false);
    }

    let mut input = File::open(input_path)?;
    input.seek(SeekFrom::Start(record.offset))?;
    let mut actual = vec![0; record.data.len()];
    match input.read_exact(&mut actual) {
        Ok(()) => Ok(actual == record.data),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn ppf_required_output_len(input_len: u64, records: &[PpfRecord]) -> u64 {
    records.iter().fold(input_len, |max_len, record| {
        let end = record.offset.saturating_add(record.data.len() as u64);
        max_len.max(end)
    })
}

fn apply_records_in_memory(records: &[PpfRecord], output: &mut [u8]) -> Result<()> {
    for record in records {
        let payload = record.data.as_slice();
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

fn apply_records(file: &mut File, records: &[PpfRecord]) -> Result<()> {
    for record in records {
        file.seek(SeekFrom::Start(record.offset))?;
        file.write_all(&record.data)?;
    }
    Ok(())
}

fn prepare_ppf_writes_parallel(
    records: &[PpfRecord],
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedWrite>> {
    pool_map(pool, records, |record| {
        context.cancel().check()?;
        Ok(PreparedWrite {
            offset: record.offset,
            data: record.data.clone(),
        })
    })
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
