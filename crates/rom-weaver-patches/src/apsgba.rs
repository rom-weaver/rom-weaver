use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use rayon::prelude::*;
use rom_weaver_checksum::crc16_ccitt_bytes as crc16_bytes;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability,
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
        fs::copy(&request.input, &request.output)?;
        let thread_capability = apsgba_apply_thread_capability(patch.records.len());
        let planned_execution = context.plan_threads(thread_capability.clone());
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        output.set_len(u64::from(patch.target_size))?;
        let execution = if planned_execution.used_parallelism {
            let source = crate::map_file_read_only(&request.input)?;
            let (execution, pool) = context.build_pool(thread_capability)?;
            let prepared = prepare_apsgba_writes_parallel(
                &patch,
                source.as_ref(),
                validate_checksums,
                &pool,
                context,
            )?;
            apply_prepared_apsgba_writes(&mut output, &prepared)?;
            execution
        } else {
            let mut source = File::open(&request.input)?;
            apply_apsgba_patch_in_place(&patch, &mut source, &mut output, validate_checksums)?;
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
        let source_size_u64 = fs::metadata(&request.original)?.len();
        let target_size_u64 = fs::metadata(&request.modified)?.len();
        let thread_capability =
            apsgba_create_thread_capability(source_size_u64.max(target_size_u64))?;
        let planned_execution = context.plan_threads(thread_capability.clone());
        let (execution, created) = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let created = create_apsgba_patch_parallel(
                &request.original,
                source_size_u64,
                &request.modified,
                target_size_u64,
                &pool,
                context,
            )?;
            (execution, created)
        } else {
            let created = create_apsgba_patch_streaming(&request.original, &request.modified)?;
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

struct PreparedApsGbaWrite {
    offset: u64,
    data: Vec<u8>,
}

fn apsgba_apply_thread_capability(record_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(record_count.max(1)))
}

fn apsgba_create_thread_capability(max_len: u64) -> Result<ThreadCapability> {
    let block_count = apsgba_create_block_count(max_len)?;
    Ok(ThreadCapability::parallel(Some(block_count.max(1))))
}

fn apsgba_create_block_count(max_len: u64) -> Result<usize> {
    let block_count = if max_len == 0 {
        1
    } else {
        max_len.div_ceil(APS_GBA_BLOCK_SIZE as u64)
    };
    usize::try_from(block_count).map_err(|_| {
        RomWeaverError::Validation(
            "APSGBA create required more blocks than this platform can index".into(),
        )
    })
}

fn parse_apsgba_file(path: &Path) -> Result<ParsedApsGbaPatch> {
    let bytes = crate::map_file_read_only(path)?;
    parse_apsgba_bytes(&bytes)
}

fn parse_apsgba_bytes(bytes: &[u8]) -> Result<ParsedApsGbaPatch> {
    if bytes.len() < APS_GBA_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "APSGBA patch is too small to contain a valid header".into(),
        ));
    }
    if &bytes[..APS_GBA_MAGIC.len()] != APS_GBA_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
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
    source: &[u8],
    validate_checksums: bool,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedApsGbaWrite>> {
    let output_len = usize::try_from(patch.target_size).expect("u32 fits usize");
    pool.install(|| {
        patch
            .records
            .par_iter()
            .map(|record| {
                context.cancel().check()?;
                prepare_apsgba_write(record, source, output_len, validate_checksums)
            })
            .collect::<Result<Vec<_>>>()
    })
}

fn prepare_apsgba_write(
    record: &ApsGbaRecord,
    source: &[u8],
    output_len: usize,
    validate_checksums: bool,
) -> Result<PreparedApsGbaWrite> {
    let offset = usize::try_from(record.offset).expect("u32 fits usize");
    let source_end = offset.saturating_add(APS_GBA_BLOCK_SIZE).min(source.len());
    let source_block = if offset >= source.len() {
        &[][..]
    } else {
        &source[offset..source_end]
    };

    if validate_checksums {
        let actual_source_crc16 = crc16_bytes(source_block);
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

    Ok(PreparedApsGbaWrite {
        offset: u64::from(record.offset),
        data: patched,
    })
}

fn apply_prepared_apsgba_writes(output: &mut File, writes: &[PreparedApsGbaWrite]) -> Result<()> {
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(write.offset))?;
        output.write_all(&write.data)?;
    }
    Ok(())
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
    let source = crate::map_file_read_only(source_path)?;
    let target = crate::map_file_read_only(target_path)?;
    let block_count = apsgba_create_block_count(source_size_u64.max(target_size_u64))?;

    let records = pool.install(|| {
        (0..block_count)
            .into_par_iter()
            .map(|block_index| {
                context.cancel().check()?;
                create_apsgba_record_for_block(block_index, source.as_ref(), target.as_ref())
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
    source: &[u8],
    target: &[u8],
) -> Result<Option<ApsGbaRecord>> {
    let offset = block_index
        .checked_mul(APS_GBA_BLOCK_SIZE)
        .ok_or_else(|| RomWeaverError::Validation("APSGBA block offset overflowed".into()))?;
    let source_end = offset.saturating_add(APS_GBA_BLOCK_SIZE).min(source.len());
    let target_end = offset.saturating_add(APS_GBA_BLOCK_SIZE).min(target.len());
    let source_block = if offset >= source.len() {
        &[][..]
    } else {
        &source[offset..source_end]
    };
    let target_block = if offset >= target.len() {
        &[][..]
    } else {
        &target[offset..target_end]
    };

    let source_crc16 = crc16_bytes(source_block);
    let target_crc16 = crc16_bytes(target_block);

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

fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| RomWeaverError::Validation("APSGBA u16 offset overflowed".into()))?;
    let window = bytes.get(offset..end).ok_or_else(|| {
        RomWeaverError::Validation("APSGBA patch ended unexpectedly while reading u16".into())
    })?;
    Ok(u16::from_le_bytes([window[0], window[1]]))
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
