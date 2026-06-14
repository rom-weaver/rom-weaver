use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use rayon::prelude::*;
use rom_weaver_checksum::crc16_ccitt_bytes as crc16_bytes;
use rom_weaver_core::{
    DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchChecksumValidation, PatchCreateRequest, PatchHandler, PatchValidateRequest,
    ProbeConfidence, Result, RomWeaverError, SharedBlockCacheReader, SharedThreadPool,
    ThreadCapability,
};
use tracing::{debug, trace};

use crate::checksum_validation_suffix;
use crate::shared::threading::{
    PreparedWrite, apply_prepared_writes, chunk_count_for_len_checked,
    parallel_per_record_capability, pool_map, run_with_optional_pool,
};

const APS_GBA_MAGIC: &[u8; 4] = b"APS1";
const APS_GBA_HEADER_SIZE: usize = 12;
const APS_GBA_BLOCK_SIZE: usize = 0x01_0000;
const APS_GBA_RECORD_SIZE: usize = 4 + 2 + 2 + APS_GBA_BLOCK_SIZE;
const APS_GBA_IO_BUFFER_SIZE: usize = 64 * 1024;

pub struct ApsGbaPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl ApsGbaPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for ApsGbaPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_apsgba_file(patch_path)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s); source size {}; target size {}; per-block source/target crc16 present",
                self.descriptor.name,
                patch.records.len(),
                patch.source_size,
                patch.target_size
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
            "apsgba patch apply start"
        );
        let patch = parse_apsgba_file(patch_path)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let expected_input_size = u64::from(patch.source_size);
        let actual_input_size = fs::metadata(&request.input)?.len();
        if actual_input_size != expected_input_size {
            return Err(RomWeaverError::Validation(format!(
                "APSGBA input size invalid; expected {expected_input_size}, got {}",
                actual_input_size
            )));
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let target_size_u64 = u64::from(patch.target_size);
        let thread_capability = parallel_per_record_capability(patch.records.len());
        let in_memory =
            crate::can_apply_in_memory_on_apply(context, actual_input_size, target_size_u64);
        trace!(
            format = self.descriptor.name,
            records = patch.records.len(),
            source_size = patch.source_size,
            target_size = patch.target_size,
            in_memory,
            read_on_main = crate::patches_reads_source_on_main_thread(),
            "apsgba parsed; apply path chosen"
        );
        let execution = if in_memory {
            let mut execution = context.plan_threads(thread_capability.clone());
            let source_bytes = fs::read(&request.input)?;
            let mut output_bytes = vec![0u8; patch.target_size as usize];
            let copy_len = source_bytes.len().min(output_bytes.len());
            output_bytes[..copy_len].copy_from_slice(&source_bytes[..copy_len]);
            apply_apsgba_patch_in_memory(
                &patch,
                &source_bytes,
                &mut output_bytes,
                validate_checksums,
            )?;
            fs::write(&request.output, &output_bytes)?;
            execution.effective_threads = 1;
            execution.used_parallelism = false;
            execution
        } else {
            fs::copy(&request.input, &request.output)?;
            let mut output = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&request.output)?;
            output.set_len(target_size_u64)?;
            let (execution, prepared) = run_with_optional_pool(
                context,
                thread_capability,
                // Parallel prepare reads the source from worker threads, which cannot
                // open OPFS files in wasm (os error 44); use the serial main-thread
                // path there. Native keeps parallel.
                !crate::patches_reads_source_on_main_thread(),
                |pool| {
                    prepare_apsgba_writes_parallel(
                        &patch,
                        &request.input,
                        actual_input_size,
                        validate_checksums,
                        pool,
                        context,
                    )
                    .map(Some)
                },
                || {
                    let mut source = File::open(&request.input)?;
                    apply_apsgba_patch_in_place(
                        &patch,
                        &mut source,
                        &mut output,
                        validate_checksums,
                    )?;
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
        let patch = parse_apsgba_file(patch_path)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let expected_input_size = u64::from(patch.source_size);
        let actual_input_size = fs::metadata(&request.input)?.len();
        if actual_input_size != expected_input_size {
            return Err(RomWeaverError::Validation(format!(
                "APSGBA input size invalid; expected {expected_input_size}, got {}",
                actual_input_size
            )));
        }

        let output_len = usize::try_from(patch.target_size).expect("u32 fits usize");
        let source = Arc::new(SharedBlockCacheReader::open(
            &request.input,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )?);
        for record in &patch.records {
            context.cancel().check()?;
            let _ = prepare_apsgba_write(
                record,
                &source,
                actual_input_size,
                output_len,
                validate_checksums,
            )?;
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
        let source_size_u64 = fs::metadata(&request.original)?.len();
        let target_size_u64 = fs::metadata(&request.modified)?.len();
        debug!(
            format = self.descriptor.name,
            source_size = source_size_u64,
            target_size = target_size_u64,
            read_on_main = crate::patches_reads_source_on_main_thread(),
            "apsgba patch create start"
        );
        let thread_capability =
            apsgba_create_thread_capability(source_size_u64.max(target_size_u64))?;
        let (execution, created) = run_with_optional_pool(
            context,
            thread_capability,
            // Parallel create reads the source from worker threads, which cannot open
            // OPFS files in wasm (os error 44); use the serial main-thread streaming
            // create there. Native keeps parallel.
            !crate::patches_reads_source_on_main_thread(),
            |pool| {
                create_apsgba_patch_parallel(
                    &request.original,
                    source_size_u64,
                    &request.modified,
                    target_size_u64,
                    pool,
                    context,
                )
            },
            || create_apsgba_patch_streaming(&request.original, &request.modified),
        )?;
        trace!(
            format = self.descriptor.name,
            records = created.record_count,
            parallel = execution.used_parallelism,
            threads = execution.effective_threads,
            "apsgba create complete"
        );

        let mut output = crate::create_buffered_output(&request.output)?;
        for chunk in created.bytes.chunks(APS_GBA_IO_BUFFER_SIZE) {
            output.write_all(chunk)?;
        }
        output.flush()?;

        Ok(crate::patch_success_report(
            self.descriptor,
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name, created.record_count
            ),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
    }
}

#[derive(Debug)]
struct ParsedApsGbaPatch {
    source_size: u32,
    target_size: u32,
    records: Vec<ApsGbaRecord>,
}

#[derive(Debug)]
struct ApsGbaRecord {
    offset: u32,
    source_crc16: u16,
    target_crc16: u16,
    xor_bytes: Vec<u8>,
}

#[derive(Debug)]
struct CreatedApsGbaPatch {
    bytes: Vec<u8>,
    record_count: usize,
}

fn apsgba_create_thread_capability(max_len: u64) -> Result<ThreadCapability> {
    let block_count = apsgba_create_block_count(max_len)?;
    Ok(ThreadCapability::parallel(Some(block_count.max(1))))
}

fn apsgba_create_block_count(max_len: u64) -> Result<usize> {
    chunk_count_for_len_checked(
        max_len,
        APS_GBA_BLOCK_SIZE as u64,
        "APSGBA create required more blocks than this platform can index",
    )
}

fn parse_apsgba_file(path: &Path) -> Result<ParsedApsGbaPatch> {
    let file_len = fs::metadata(path)?.len();
    if file_len < APS_GBA_HEADER_SIZE as u64 {
        return Err(RomWeaverError::Validation(
            "APSGBA patch is too small to contain a valid header".into(),
        ));
    }
    if file_len < (APS_GBA_HEADER_SIZE + APS_GBA_RECORD_SIZE) as u64 {
        return Err(RomWeaverError::Validation(
            "APSGBA patch is too small to contain at least one record".into(),
        ));
    }

    let payload_len = file_len
        .checked_sub(APS_GBA_HEADER_SIZE as u64)
        .ok_or_else(|| {
            RomWeaverError::Validation("APSGBA patch header length underflowed".into())
        })?;
    if payload_len % APS_GBA_RECORD_SIZE as u64 != 0 {
        return Err(RomWeaverError::Validation(
            "APSGBA patch has an invalid record payload length".into(),
        ));
    }

    let mut parser = ApsGbaFileParser::new(BufReader::new(File::open(path)?), file_len);
    let header = parser.read_exact(APS_GBA_HEADER_SIZE, "APSGBA header")?;
    if &header[..APS_GBA_MAGIC.len()] != APS_GBA_MAGIC {
        return Err(crate::coded_validation(
            "APS_GBA_HEADER_INVALID",
            "Patch header invalid",
        ));
    }

    let source_size = read_u32_le(&header, 4)?;
    let target_size = read_u32_le(&header, 8)?;
    let payload_len_usize = usize::try_from(payload_len).map_err(|_| {
        RomWeaverError::Validation("APSGBA payload exceeded addressable memory".into())
    })?;
    let record_count = payload_len_usize / APS_GBA_RECORD_SIZE;
    let mut records = Vec::with_capacity(record_count);

    for _ in 0..record_count {
        let offset = parser.read_u32_le("APSGBA record offset")?;
        let source_crc16 = parser.read_u16_le("APSGBA source crc16")?;
        let target_crc16 = parser.read_u16_le("APSGBA target crc16")?;
        let xor_bytes = parser.read_exact(APS_GBA_BLOCK_SIZE, "APSGBA xor payload")?;
        records.push(ApsGbaRecord {
            offset,
            source_crc16,
            target_crc16,
            xor_bytes,
        });
    }

    if parser.remaining() != 0 {
        return Err(RomWeaverError::Validation(
            "APSGBA patch contained unexpected trailing data".into(),
        ));
    }

    Ok(ParsedApsGbaPatch {
        source_size,
        target_size,
        records,
    })
}

#[cfg(test)]
fn parse_apsgba_bytes(bytes: &[u8]) -> Result<ParsedApsGbaPatch> {
    if bytes.len() < APS_GBA_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "APSGBA patch is too small to contain a valid header".into(),
        ));
    }
    if &bytes[..APS_GBA_MAGIC.len()] != APS_GBA_MAGIC {
        return Err(crate::coded_validation(
            "APS_GBA_HEADER_INVALID",
            "Patch header invalid",
        ));
    }
    if bytes.len() < APS_GBA_HEADER_SIZE + APS_GBA_RECORD_SIZE {
        return Err(RomWeaverError::Validation(
            "APSGBA patch is too small to contain at least one record".into(),
        ));
    }

    let payload_len = bytes
        .len()
        .checked_sub(APS_GBA_HEADER_SIZE)
        .ok_or_else(|| {
            RomWeaverError::Validation("APSGBA patch header length underflowed".into())
        })?;
    if payload_len % APS_GBA_RECORD_SIZE != 0 {
        return Err(RomWeaverError::Validation(
            "APSGBA patch has an invalid record payload length".into(),
        ));
    }

    let source_size = read_u32_le(bytes, 4)?;
    let target_size = read_u32_le(bytes, 8)?;
    let record_count = payload_len / APS_GBA_RECORD_SIZE;
    let mut records = Vec::with_capacity(record_count);

    let mut cursor = APS_GBA_HEADER_SIZE;
    for _ in 0..record_count {
        let offset = read_u32_le(bytes, cursor)?;
        cursor += 4;
        let source_crc16 = read_u16_le(bytes, cursor)?;
        cursor += 2;
        let target_crc16 = read_u16_le(bytes, cursor)?;
        cursor += 2;
        let next_cursor = cursor
            .checked_add(APS_GBA_BLOCK_SIZE)
            .ok_or_else(|| RomWeaverError::Validation("APSGBA record cursor overflowed".into()))?;
        let xor_bytes = bytes[cursor..next_cursor].to_vec();
        cursor = next_cursor;

        records.push(ApsGbaRecord {
            offset,
            source_crc16,
            target_crc16,
            xor_bytes,
        });
    }

    Ok(ParsedApsGbaPatch {
        source_size,
        target_size,
        records,
    })
}

#[cfg(test)]
fn create_apsgba_patch_bytes(source: &[u8], target: &[u8]) -> Result<CreatedApsGbaPatch> {
    let source_size = u32::try_from(source.len()).map_err(|_| {
        RomWeaverError::Validation("APSGBA source size exceeded 32-bit header range".into())
    })?;
    let target_size = u32::try_from(target.len()).map_err(|_| {
        RomWeaverError::Validation("APSGBA target size exceeded 32-bit header range".into())
    })?;

    let mut records = Vec::new();
    let max_len = source.len().max(target.len());
    let block_count = max_len.div_ceil(APS_GBA_BLOCK_SIZE);

    for block_index in 0..block_count {
        let offset = block_index * APS_GBA_BLOCK_SIZE;
        let source_crc16 = crc16_range(source, offset, APS_GBA_BLOCK_SIZE);
        let target_crc16 = crc16_range(target, offset, APS_GBA_BLOCK_SIZE);

        let mut xor_bytes = vec![0u8; APS_GBA_BLOCK_SIZE];
        let mut changed = false;
        for (index, byte) in xor_bytes.iter_mut().enumerate() {
            let source_byte = source.get(offset + index).copied().unwrap_or(0);
            let target_byte = target.get(offset + index).copied().unwrap_or(0);
            *byte = source_byte ^ target_byte;
            changed |= *byte != 0;
        }

        if changed {
            let record_offset = u32::try_from(offset).map_err(|_| {
                RomWeaverError::Validation("APSGBA block offset exceeded 32-bit range".into())
            })?;
            records.push(ApsGbaRecord {
                offset: record_offset,
                source_crc16,
                target_crc16,
                xor_bytes,
            });
        }
    }

    Ok(finalize_created_apsgba_patch(
        source_size,
        target_size,
        records,
    ))
}

fn apply_apsgba_patch_in_memory(
    patch: &ParsedApsGbaPatch,
    source: &[u8],
    output: &mut [u8],
    validate_checksums: bool,
) -> Result<()> {
    let output_len = output.len();
    for record in &patch.records {
        let offset = record.offset as usize;
        let source_len = source.len().saturating_sub(offset).min(APS_GBA_BLOCK_SIZE);
        let write_len = output_len.saturating_sub(offset).min(APS_GBA_BLOCK_SIZE);

        if validate_checksums {
            let actual = crc16_bytes(&source[offset..offset + source_len]);
            if actual != record.source_crc16 {
                return Err(RomWeaverError::Validation(format!(
                    "Source checksum invalid at offset {offset}; expected: {:04x}, Actual: {:04x}",
                    record.source_crc16, actual
                )));
            }
        }

        for index in 0..write_len {
            let source_byte = if index < source_len {
                source[offset + index]
            } else {
                0
            };
            output[offset + index] = source_byte ^ record.xor_bytes[index];
        }

        if validate_checksums {
            let actual = crc16_bytes(&output[offset..offset + write_len]);
            if actual != record.target_crc16 {
                return Err(RomWeaverError::Validation(format!(
                    "Target checksum invalid at offset {offset}; expected: {:04x}, Actual: {:04x}",
                    record.target_crc16, actual
                )));
            }
        }
    }
    Ok(())
}

fn apply_apsgba_patch_in_place(
    patch: &ParsedApsGbaPatch,
    source: &mut File,
    output: &mut File,
    validate_checksums: bool,
) -> Result<()> {
    let output_len = usize::try_from(patch.target_size).expect("u32 fits usize");
    let mut source_block = vec![0u8; APS_GBA_BLOCK_SIZE];
    let mut patched_block = vec![0u8; APS_GBA_BLOCK_SIZE];

    for record in &patch.records {
        let offset = usize::try_from(record.offset).expect("u32 fits usize");
        let source_len = read_at_most(source, u64::from(record.offset), &mut source_block)?;

        if validate_checksums {
            let actual_source_crc16 = crc16_bytes(&source_block[..source_len]);
            if actual_source_crc16 != record.source_crc16 {
                return Err(RomWeaverError::Validation(format!(
                    "Source checksum invalid at offset {offset}; expected: {:04x}, Actual: {:04x}",
                    record.source_crc16, actual_source_crc16
                )));
            }
        }

        let write_len = output_len.saturating_sub(offset).min(APS_GBA_BLOCK_SIZE);
        for index in 0..write_len {
            let source_byte = if index < source_len {
                source_block[index]
            } else {
                0
            };
            patched_block[index] = source_byte ^ record.xor_bytes[index];
        }

        if write_len > 0 {
            output.seek(SeekFrom::Start(u64::from(record.offset)))?;
            output.write_all(&patched_block[..write_len])?;
        }

        if validate_checksums {
            let actual_target_crc16 = crc16_bytes(&patched_block[..write_len]);
            if actual_target_crc16 != record.target_crc16 {
                return Err(RomWeaverError::Validation(format!(
                    "Target checksum invalid at offset {offset}; expected: {:04x}, Actual: {:04x}",
                    record.target_crc16, actual_target_crc16
                )));
            }
        }
    }

    Ok(())
}

fn prepare_apsgba_writes_parallel(
    patch: &ParsedApsGbaPatch,
    source_path: &Path,
    source_len: u64,
    validate_checksums: bool,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedWrite>> {
    let output_len = usize::try_from(patch.target_size).expect("u32 fits usize");
    let source = Arc::new(SharedBlockCacheReader::open(
        source_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?);
    pool_map(pool, &patch.records, |record| {
        context.cancel().check()?;
        prepare_apsgba_write(record, &source, source_len, output_len, validate_checksums)
    })
}

fn prepare_apsgba_write(
    record: &ApsGbaRecord,
    source: &Arc<SharedBlockCacheReader>,
    source_len: u64,
    output_len: usize,
    validate_checksums: bool,
) -> Result<PreparedWrite> {
    let offset = usize::try_from(record.offset).expect("u32 fits usize");
    let source_offset = u64::from(record.offset);
    let source_read_len = if source_offset >= source_len {
        0usize
    } else {
        usize::try_from((source_len - source_offset).min(APS_GBA_BLOCK_SIZE as u64)).map_err(
            |_| RomWeaverError::Validation("APSGBA source block length exceeded usize".into()),
        )?
    };
    let mut source_block = vec![0u8; source_read_len];
    if source_read_len > 0 {
        source.read_exact_at(source_offset, &mut source_block)?;
    }

    if validate_checksums {
        let actual_source_crc16 = crc16_bytes(&source_block);
        if actual_source_crc16 != record.source_crc16 {
            return Err(RomWeaverError::Validation(format!(
                "Source checksum invalid at offset {offset}; expected: {:04x}, Actual: {:04x}",
                record.source_crc16, actual_source_crc16
            )));
        }
    }

    let write_len = output_len.saturating_sub(offset).min(APS_GBA_BLOCK_SIZE);
    let mut patched = vec![0u8; write_len];
    for (index, byte) in patched.iter_mut().enumerate() {
        let source_byte = source_block.get(index).copied().unwrap_or(0);
        *byte = source_byte ^ record.xor_bytes[index];
    }

    if validate_checksums {
        let actual_target_crc16 = crc16_bytes(&patched);
        if actual_target_crc16 != record.target_crc16 {
            return Err(RomWeaverError::Validation(format!(
                "Target checksum invalid at offset {offset}; expected: {:04x}, Actual: {:04x}",
                record.target_crc16, actual_target_crc16
            )));
        }
    }

    Ok(PreparedWrite {
        offset: u64::from(record.offset),
        data: patched,
    })
}

fn create_apsgba_patch_streaming(
    source_path: &Path,
    target_path: &Path,
) -> Result<CreatedApsGbaPatch> {
    let source_size_u64 = fs::metadata(source_path)?.len();
    let target_size_u64 = fs::metadata(target_path)?.len();
    let source_size = u32::try_from(source_size_u64).map_err(|_| {
        RomWeaverError::Validation("APSGBA source size exceeded 32-bit header range".into())
    })?;
    let target_size = u32::try_from(target_size_u64).map_err(|_| {
        RomWeaverError::Validation("APSGBA target size exceeded 32-bit header range".into())
    })?;

    let mut source = BufReader::new(File::open(source_path)?);
    let mut target = BufReader::new(File::open(target_path)?);
    let mut source_remaining = source_size_u64;
    let mut target_remaining = target_size_u64;
    let max_len = source_size_u64.max(target_size_u64);
    let block_count = max_len.div_ceil(APS_GBA_BLOCK_SIZE as u64);

    let mut source_buffer = vec![0u8; APS_GBA_BLOCK_SIZE];
    let mut target_buffer = vec![0u8; APS_GBA_BLOCK_SIZE];
    let mut xor_bytes = vec![0u8; APS_GBA_BLOCK_SIZE];
    let mut records = Vec::new();

    for block_index in 0..block_count {
        let source_chunk_len = usize::try_from(source_remaining.min(APS_GBA_IO_BUFFER_SIZE as u64))
            .map_err(|_| {
                RomWeaverError::Validation("APSGBA source chunk length exceeded usize".into())
            })?;
        let target_chunk_len = usize::try_from(target_remaining.min(APS_GBA_IO_BUFFER_SIZE as u64))
            .map_err(|_| {
                RomWeaverError::Validation("APSGBA target chunk length exceeded usize".into())
            })?;

        if source_chunk_len > 0 {
            source.read_exact(&mut source_buffer[..source_chunk_len])?;
        }
        if target_chunk_len > 0 {
            target.read_exact(&mut target_buffer[..target_chunk_len])?;
        }

        let source_crc16 = crc16_bytes(&source_buffer[..source_chunk_len]);
        let target_crc16 = crc16_bytes(&target_buffer[..target_chunk_len]);
        let mut changed = false;
        for (index, xor_byte) in xor_bytes.iter_mut().enumerate() {
            let source_byte = if index < source_chunk_len {
                source_buffer[index]
            } else {
                0
            };
            let target_byte = if index < target_chunk_len {
                target_buffer[index]
            } else {
                0
            };
            *xor_byte = source_byte ^ target_byte;
            changed |= *xor_byte != 0;
        }

        if changed {
            let record_offset =
                u32::try_from(block_index * APS_GBA_BLOCK_SIZE as u64).map_err(|_| {
                    RomWeaverError::Validation("APSGBA block offset exceeded 32-bit range".into())
                })?;
            records.push(ApsGbaRecord {
                offset: record_offset,
                source_crc16,
                target_crc16,
                xor_bytes: xor_bytes.clone(),
            });
        }

        source_remaining = source_remaining.saturating_sub(source_chunk_len as u64);
        target_remaining = target_remaining.saturating_sub(target_chunk_len as u64);
    }

    Ok(finalize_created_apsgba_patch(
        source_size,
        target_size,
        records,
    ))
}

fn create_apsgba_patch_parallel(
    source_path: &Path,
    source_size_u64: u64,
    target_path: &Path,
    target_size_u64: u64,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<CreatedApsGbaPatch> {
    let source_size = u32::try_from(source_size_u64).map_err(|_| {
        RomWeaverError::Validation("APSGBA source size exceeded 32-bit header range".into())
    })?;
    let target_size = u32::try_from(target_size_u64).map_err(|_| {
        RomWeaverError::Validation("APSGBA target size exceeded 32-bit header range".into())
    })?;
    let block_count = apsgba_create_block_count(source_size_u64.max(target_size_u64))?;
    let source = Arc::new(SharedBlockCacheReader::open(
        source_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?);
    let target = Arc::new(SharedBlockCacheReader::open(
        target_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?);

    let records = pool.install(|| {
        (0..block_count)
            .into_par_iter()
            .map(|block_index| {
                context.cancel().check()?;
                create_apsgba_record_for_block(
                    block_index,
                    source_size_u64,
                    target_size_u64,
                    &source,
                    &target,
                )
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let records = records.into_iter().flatten().collect::<Vec<_>>();
    Ok(finalize_created_apsgba_patch(
        source_size,
        target_size,
        records,
    ))
}

fn create_apsgba_record_for_block(
    block_index: usize,
    source_len: u64,
    target_len: u64,
    source_reader: &Arc<SharedBlockCacheReader>,
    target_reader: &Arc<SharedBlockCacheReader>,
) -> Result<Option<ApsGbaRecord>> {
    let offset = block_index
        .checked_mul(APS_GBA_BLOCK_SIZE)
        .ok_or_else(|| RomWeaverError::Validation("APSGBA block offset overflowed".into()))?;
    let offset_u64 = u64::try_from(offset)
        .map_err(|_| RomWeaverError::Validation("APSGBA block offset exceeded u64".into()))?;
    let source_block = read_apsgba_block(source_reader, source_len, offset_u64)?;
    let target_block = read_apsgba_block(target_reader, target_len, offset_u64)?;

    let source_crc16 = crc16_bytes(&source_block);
    let target_crc16 = crc16_bytes(&target_block);

    let mut xor_bytes = vec![0u8; APS_GBA_BLOCK_SIZE];
    let mut changed = false;
    for (index, xor_byte) in xor_bytes.iter_mut().enumerate() {
        let source_byte = source_block.get(index).copied().unwrap_or(0);
        let target_byte = target_block.get(index).copied().unwrap_or(0);
        *xor_byte = source_byte ^ target_byte;
        changed |= *xor_byte != 0;
    }
    if !changed {
        return Ok(None);
    }

    let record_offset = u32::try_from(offset).map_err(|_| {
        RomWeaverError::Validation("APSGBA block offset exceeded 32-bit range".into())
    })?;
    Ok(Some(ApsGbaRecord {
        offset: record_offset,
        source_crc16,
        target_crc16,
        xor_bytes,
    }))
}

fn read_apsgba_block(
    reader: &Arc<SharedBlockCacheReader>,
    file_len: u64,
    offset: u64,
) -> Result<Vec<u8>> {
    if offset >= file_len {
        return Ok(Vec::new());
    }
    let read_len = usize::try_from((file_len - offset).min(APS_GBA_BLOCK_SIZE as u64))
        .map_err(|_| RomWeaverError::Validation("APSGBA block length exceeded usize".into()))?;
    let mut block = vec![0u8; read_len];
    if read_len > 0 {
        reader.read_exact_at(offset, &mut block)?;
    }
    Ok(block)
}

fn finalize_created_apsgba_patch(
    source_size: u32,
    target_size: u32,
    mut records: Vec<ApsGbaRecord>,
) -> CreatedApsGbaPatch {
    if records.is_empty() {
        records.push(empty_apsgba_record());
    }

    let mut bytes = Vec::with_capacity(APS_GBA_HEADER_SIZE + records.len() * APS_GBA_RECORD_SIZE);
    bytes.extend_from_slice(APS_GBA_MAGIC);
    bytes.extend_from_slice(&source_size.to_le_bytes());
    bytes.extend_from_slice(&target_size.to_le_bytes());

    for record in &records {
        bytes.extend_from_slice(&record.offset.to_le_bytes());
        bytes.extend_from_slice(&record.source_crc16.to_le_bytes());
        bytes.extend_from_slice(&record.target_crc16.to_le_bytes());
        bytes.extend_from_slice(&record.xor_bytes);
    }

    CreatedApsGbaPatch {
        bytes,
        record_count: records.len(),
    }
}

fn empty_apsgba_record() -> ApsGbaRecord {
    ApsGbaRecord {
        offset: 0,
        source_crc16: crc16_bytes(&[]),
        target_crc16: crc16_bytes(&[]),
        xor_bytes: vec![0u8; APS_GBA_BLOCK_SIZE],
    }
}

fn read_at_most(file: &mut File, offset: u64, buffer: &mut [u8]) -> Result<usize> {
    file.seek(SeekFrom::Start(offset))?;
    let mut total = 0usize;
    while total < buffer.len() {
        let read = file.read(&mut buffer[total..])?;
        if read == 0 {
            break;
        }
        total += read;
    }
    Ok(total)
}

#[cfg(test)]
fn crc16_range(bytes: &[u8], offset: usize, len: usize) -> u16 {
    if offset >= bytes.len() || len == 0 {
        return crc16_bytes(&[]);
    }
    let end = offset.saturating_add(len).min(bytes.len());
    crc16_bytes(&bytes[offset..end])
}

#[cfg(test)]
fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| RomWeaverError::Validation("APSGBA u16 offset overflowed".into()))?;
    let window = bytes.get(offset..end).ok_or_else(|| {
        RomWeaverError::Validation("APSGBA patch ended unexpectedly while reading u16".into())
    })?;
    Ok(u16::from_le_bytes([window[0], window[1]]))
}

struct ApsGbaFileParser<R> {
    reader: R,
    file_len: u64,
    offset: u64,
}

impl<R: Read> ApsGbaFileParser<R> {
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
        let len_u64 = u64::try_from(len).map_err(|_| {
            RomWeaverError::Validation(format!("{label} length overflowed addressable range"))
        })?;
        if len_u64 > self.remaining() {
            return Err(RomWeaverError::Validation(format!(
                "APSGBA patch ended unexpectedly while reading {label}"
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

    fn read_u16_le(&mut self, label: &str) -> Result<u16> {
        let bytes = self.read_exact(2, label)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn read_u32_le(&mut self, label: &str) -> Result<u32> {
        let bytes = self.read_exact(4, label)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| RomWeaverError::Validation("APSGBA u32 offset overflowed".into()))?;
    let window = bytes.get(offset..end).ok_or_else(|| {
        RomWeaverError::Validation("APSGBA patch ended unexpectedly while reading u32".into())
    })?;
    Ok(u32::from_le_bytes([
        window[0], window[1], window[2], window[3],
    ]))
}

#[cfg(test)]
#[path = "../tests/unit/apsgba.rs"]
mod tests;
