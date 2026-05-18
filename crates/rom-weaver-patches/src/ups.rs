use std::{
    cmp::max,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use crc32fast::Hasher;
use rom_weaver_checksum::checksum_file_values;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};

const UPS_MAGIC: &[u8; 4] = b"UPS1";
const UPS_FOOTER_SIZE: usize = 12;
const UPS_IO_BUFFER_SIZE: usize = 64 * 1024;

pub struct UpsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl UpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for UpsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_ups_file(patch_path)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s); source crc32 {:08x}; target crc32 {:08x}",
                self.descriptor.name,
                patch.changes.len(),
                patch.source_checksum,
                patch.target_checksum
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
        if request.patches.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} apply expects exactly one patch file",
                self.descriptor.name
            )));
        }

        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let patch =
            parse_ups_file_with_checksum_validation(&request.patches[0], validate_checksums)?;
        let input_len = fs::metadata(&request.input)?.len();
        let input_checksum = crc32_path_cached(&request.input, context)?;
        let (output_size, output_checksum) =
            resolve_apply_target(&patch, input_len, input_checksum, validate_checksums)?;
        let working_size = max(patch.source_size, patch.target_size);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &request.output)?;
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        output.set_len(working_size)?;
        apply_changes_in_place(&patch, working_size, &mut output)?;
        output.set_len(output_size)?;
        output.flush()?;

        if validate_checksums {
            let actual_output_checksum = crc32_path_cached(&request.output, context)?;
            if actual_output_checksum != output_checksum {
                return Err(RomWeaverError::Validation(format!(
                    "Output checksum invalid; expected: {output_checksum:08x}, Actual: {actual_output_checksum:08x}"
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
                "applied {} patch with {} record(s){}",
                self.descriptor.name,
                patch.changes.len(),
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

        let created = create_ups_patch_streaming(&request.original, &request.modified)?;
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
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Debug)]
struct ParsedUpsPatch {
    source_size: u64,
    target_size: u64,
    source_checksum: u32,
    target_checksum: u32,
    changes: Vec<UpsChange>,
}

#[derive(Debug)]
struct UpsChange {
    offset: u64,
    xor_bytes: Vec<u8>,
}

#[derive(Debug)]
struct CreatedUpsPatch {
    bytes: Vec<u8>,
    record_count: usize,
}

fn parse_ups_file(path: &Path) -> Result<ParsedUpsPatch> {
    parse_ups_file_with_checksum_validation(path, true)
}

fn parse_ups_file_with_checksum_validation(
    path: &Path,
    validate_patch_checksum: bool,
) -> Result<ParsedUpsPatch> {
    let bytes = fs::read(path)?;
    parse_ups_bytes_with_checksum_validation(&bytes, validate_patch_checksum)
}

#[cfg(test)]
fn parse_ups_bytes(bytes: &[u8]) -> Result<ParsedUpsPatch> {
    parse_ups_bytes_with_checksum_validation(bytes, true)
}

fn parse_ups_bytes_with_checksum_validation(
    bytes: &[u8],
    validate_patch_checksum: bool,
) -> Result<ParsedUpsPatch> {
    if bytes.len() < UPS_MAGIC.len() + UPS_FOOTER_SIZE {
        return Err(RomWeaverError::Validation(
            "UPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let footer_offset = bytes
        .len()
        .checked_sub(UPS_FOOTER_SIZE)
        .expect("validated footer size");
    let mut parser = UpsParser::new(bytes, footer_offset);

    if parser.read_exact(UPS_MAGIC.len())? != UPS_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let source_size = parser.read_varint()?;
    let target_size = parser.read_varint()?;

    let mut next_offset = 0u64;
    let mut changes = Vec::new();
    while !parser.is_at_end() {
        let delta = parser.read_varint()?;
        next_offset = checked_add(next_offset, delta, "UPS record offset")?;

        let mut xor_bytes = Vec::new();
        loop {
            let byte = parser.read_u8()?;
            if byte == 0 {
                break;
            }
            xor_bytes.push(byte);
        }

        let change_len = u64::try_from(xor_bytes.len()).map_err(|_| {
            RomWeaverError::Validation("UPS record length exceeded addressable memory".into())
        })?;
        changes.push(UpsChange {
            offset: next_offset,
            xor_bytes,
        });
        next_offset = checked_add(next_offset, change_len, "UPS record end")?;
        next_offset = checked_add(next_offset, 1, "UPS record separator")?;
    }

    let footer = &bytes[footer_offset..];
    let source_checksum = read_u32_le(&footer[0..4]);
    let target_checksum = read_u32_le(&footer[4..8]);
    let patch_checksum = read_u32_le(&footer[8..12]);
    if validate_patch_checksum {
        let actual_patch_checksum = crc32_bytes(&bytes[..bytes.len() - 4]);
        if actual_patch_checksum != patch_checksum {
            return Err(RomWeaverError::Validation(format!(
                "Patch checksum invalid; expected: {patch_checksum:08x}, Actual: {actual_patch_checksum:08x}"
            )));
        }
    }

    Ok(ParsedUpsPatch {
        source_size,
        target_size,
        source_checksum,
        target_checksum,
        changes,
    })
}

fn resolve_apply_target(
    patch: &ParsedUpsPatch,
    input_len: u64,
    input_checksum: u32,
    validate_checksums: bool,
) -> Result<(u64, u32)> {
    let matches_source = input_len == patch.source_size && input_checksum == patch.source_checksum;
    let matches_target = input_len == patch.target_size && input_checksum == patch.target_checksum;

    if matches_source {
        return Ok((patch.target_size, patch.target_checksum));
    }
    if matches_target {
        return Ok((patch.source_size, patch.source_checksum));
    }

    if !validate_checksums {
        if input_len == patch.source_size {
            return Ok((patch.target_size, patch.target_checksum));
        }
        if input_len == patch.target_size {
            return Ok((patch.source_size, patch.source_checksum));
        }
        if patch.source_size == patch.target_size {
            return Ok((patch.target_size, patch.target_checksum));
        }
    }

    Err(RomWeaverError::Validation(format!(
        "UPS input validation failed; expected source size/checksum {} / {:08x} or target size/checksum {} / {:08x}, got {} / {:08x}",
        patch.source_size,
        patch.source_checksum,
        patch.target_size,
        patch.target_checksum,
        input_len,
        input_checksum
    )))
}

fn apply_changes_in_place(
    patch: &ParsedUpsPatch,
    output_len: u64,
    output: &mut File,
) -> Result<()> {
    let mut buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    for change in &patch.changes {
        let change_len = u64::try_from(change.xor_bytes.len()).map_err(|_| {
            RomWeaverError::Validation("UPS record length exceeded addressable memory".into())
        })?;
        let change_end = checked_add(change.offset, change_len, "UPS change end")?;
        if change_end > output_len {
            return Err(RomWeaverError::Validation(
                "UPS change exceeds declared patch file bounds".into(),
            ));
        }

        let mut remaining = change.xor_bytes.len();
        let mut xor_cursor = 0usize;
        let mut write_offset = change.offset;
        while remaining > 0 {
            let chunk_len = remaining.min(buffer.len());
            output.seek(SeekFrom::Start(write_offset))?;
            output.read_exact(&mut buffer[..chunk_len])?;
            for (index, byte) in buffer[..chunk_len].iter_mut().enumerate() {
                *byte ^= change.xor_bytes[xor_cursor + index];
            }
            output.seek(SeekFrom::Start(write_offset))?;
            output.write_all(&buffer[..chunk_len])?;

            write_offset = checked_add(
                write_offset,
                u64::try_from(chunk_len).expect("chunk len fits u64"),
                "UPS output offset",
            )?;
            xor_cursor = checked_add_usize(xor_cursor, chunk_len, "UPS xor cursor")?;
            remaining -= chunk_len;
        }
    }

    Ok(())
}

fn create_ups_patch_streaming(source_path: &Path, target_path: &Path) -> Result<CreatedUpsPatch> {
    let source_size = fs::metadata(source_path)?.len();
    let target_size = fs::metadata(target_path)?.len();
    let max_size = max(source_size, target_size);

    let mut source = BufReader::new(File::open(source_path)?);
    let mut target = BufReader::new(File::open(target_path)?);
    let mut source_checksum = Hasher::new();
    let mut target_checksum = Hasher::new();
    let mut source_buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; UPS_IO_BUFFER_SIZE];
    let mut source_remaining = source_size;
    let mut target_remaining = target_size;
    let mut offset = 0u64;

    let mut changes = Vec::<UpsChange>::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_xor = Vec::<u8>::new();

    while offset < max_size {
        let chunk_len = usize::try_from((max_size - offset).min(UPS_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("UPS chunk length exceeded usize".into()))?;
        let source_chunk_len =
            usize::try_from(source_remaining.min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS source chunk length exceeded usize".into())
            })?;
        let target_chunk_len =
            usize::try_from(target_remaining.min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("UPS target chunk length exceeded usize".into())
            })?;

        if source_chunk_len > 0 {
            source.read_exact(&mut source_buffer[..source_chunk_len])?;
            source_checksum.update(&source_buffer[..source_chunk_len]);
        }
        if target_chunk_len > 0 {
            target.read_exact(&mut target_buffer[..target_chunk_len])?;
            target_checksum.update(&target_buffer[..target_chunk_len]);
        }

        for index in 0..chunk_len {
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
            if source_byte != target_byte {
                if pending_start.is_none() {
                    pending_start = Some(offset);
                }
                pending_xor.push(source_byte ^ target_byte);
            } else if !pending_xor.is_empty() {
                let start = pending_start.expect("pending start exists");
                changes.push(UpsChange {
                    offset: start,
                    xor_bytes: std::mem::take(&mut pending_xor),
                });
                pending_start = None;
            }

            offset = checked_add(offset, 1, "UPS scan offset")?;
        }

        source_remaining = source_remaining.saturating_sub(source_chunk_len as u64);
        target_remaining = target_remaining.saturating_sub(target_chunk_len as u64);
    }

    if !pending_xor.is_empty() {
        let start = pending_start.expect("pending start exists");
        changes.push(UpsChange {
            offset: start,
            xor_bytes: pending_xor,
        });
    }

    let source_checksum = source_checksum.finalize();
    let target_checksum = target_checksum.finalize();

    let mut bytes = UPS_MAGIC.to_vec();
    push_varint(&mut bytes, source_size);
    push_varint(&mut bytes, target_size);

    for (index, change) in changes.iter().enumerate() {
        let offset_to_encode = if index == 0 {
            change.offset
        } else {
            let previous = &changes[index - 1];
            let previous_len = u64::try_from(previous.xor_bytes.len()).map_err(|_| {
                RomWeaverError::Validation(
                    "UPS record length exceeded addressable memory while encoding".into(),
                )
            })?;
            let previous_end =
                checked_add(previous.offset, previous_len, "UPS previous record end")?;
            let previous_next = checked_add(previous_end, 1, "UPS previous record separator")?;
            checked_sub(change.offset, previous_next, "UPS relative record offset")?
        };

        push_varint(&mut bytes, offset_to_encode);
        bytes.extend_from_slice(&change.xor_bytes);
        bytes.push(0);
    }

    bytes.extend_from_slice(&source_checksum.to_le_bytes());
    bytes.extend_from_slice(&target_checksum.to_le_bytes());
    let patch_checksum = crc32_bytes(&bytes);
    bytes.extend_from_slice(&patch_checksum.to_le_bytes());

    Ok(CreatedUpsPatch {
        bytes,
        record_count: changes.len(),
    })
}

#[allow(dead_code)]
fn create_ups_patch_bytes(source: &[u8], target: &[u8]) -> Result<CreatedUpsPatch> {
    let source_size = u64::try_from(source.len())
        .map_err(|_| RomWeaverError::Validation("UPS source size exceeded u64".into()))?;
    let target_size = u64::try_from(target.len())
        .map_err(|_| RomWeaverError::Validation("UPS target size exceeded u64".into()))?;
    let source_checksum = crc32_bytes(source);
    let target_checksum = crc32_bytes(target);
    let changes = build_changes(source, target)?;

    let mut bytes = UPS_MAGIC.to_vec();
    push_varint(&mut bytes, source_size);
    push_varint(&mut bytes, target_size);

    for (index, change) in changes.iter().enumerate() {
        let offset_to_encode = if index == 0 {
            change.offset
        } else {
            let previous = &changes[index - 1];
            let previous_len = u64::try_from(previous.xor_bytes.len()).map_err(|_| {
                RomWeaverError::Validation(
                    "UPS record length exceeded addressable memory while encoding".into(),
                )
            })?;
            let previous_end =
                checked_add(previous.offset, previous_len, "UPS previous record end")?;
            let previous_next = checked_add(previous_end, 1, "UPS previous record separator")?;
            checked_sub(change.offset, previous_next, "UPS relative record offset")?
        };

        push_varint(&mut bytes, offset_to_encode);
        bytes.extend_from_slice(&change.xor_bytes);
        bytes.push(0);
    }

    bytes.extend_from_slice(&source_checksum.to_le_bytes());
    bytes.extend_from_slice(&target_checksum.to_le_bytes());
    let patch_checksum = crc32_bytes(&bytes);
    bytes.extend_from_slice(&patch_checksum.to_le_bytes());

    Ok(CreatedUpsPatch {
        bytes,
        record_count: changes.len(),
    })
}

#[allow(dead_code)]
fn build_changes(source: &[u8], target: &[u8]) -> Result<Vec<UpsChange>> {
    let max_size = max(source.len(), target.len());
    let mut changes = Vec::new();

    let mut index = 0usize;
    while index < max_size {
        let source_byte = source.get(index).copied().unwrap_or(0);
        let target_byte = target.get(index).copied().unwrap_or(0);

        if source_byte != target_byte {
            let offset = u64::try_from(index)
                .map_err(|_| RomWeaverError::Validation("UPS offset exceeded u64".into()))?;
            let mut xor_bytes = Vec::new();

            while index < max_size {
                let source_byte = source.get(index).copied().unwrap_or(0);
                let target_byte = target.get(index).copied().unwrap_or(0);
                if source_byte == target_byte {
                    break;
                }

                xor_bytes.push(source_byte ^ target_byte);
                index = checked_add_usize(index, 1, "UPS change index")?;
            }

            changes.push(UpsChange { offset, xor_bytes });
        }

        if index == max_size {
            break;
        }

        index = checked_add_usize(index, 1, "UPS scan index")?;
    }

    Ok(changes)
}

fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

fn checked_sub(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_sub(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} underflowed")))
}

fn checked_add_usize(lhs: usize, rhs: usize, label: &str) -> Result<usize> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

fn read_u32_le(bytes: &[u8]) -> u32 {
    let mut value = [0u8; 4];
    value.copy_from_slice(bytes);
    u32::from_le_bytes(value)
}

fn push_varint(bytes: &mut Vec<u8>, mut data: u64) {
    loop {
        let value = (data & 0x7f) as u8;
        data >>= 7;
        if data == 0 {
            bytes.push(0x80 | value);
            break;
        }
        bytes.push(value);
        data -= 1;
    }
}

fn crc32_bytes(bytes: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(bytes);
    hasher.finalize()
}

fn crc32_path_cached(path: &Path, context: &OperationContext) -> Result<u32> {
    let results = checksum_file_values(path, &["crc32"], context)?;
    let Some(value) = results.get("crc32") else {
        return Err(RomWeaverError::Validation(
            "native checksum engine did not return crc32 result".into(),
        ));
    };
    u32::from_str_radix(value, 16).map_err(|error| {
        RomWeaverError::Validation(format!(
            "native checksum engine returned invalid crc32: {error}"
        ))
    })
}

struct UpsParser<'a> {
    bytes: &'a [u8],
    offset: usize,
    end: usize,
}

impl<'a> UpsParser<'a> {
    fn new(bytes: &'a [u8], end: usize) -> Self {
        Self {
            bytes,
            offset: 0,
            end,
        }
    }

    fn is_at_end(&self) -> bool {
        self.offset == self.end
    }

    fn read_exact(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| RomWeaverError::Validation("UPS parser offset overflowed".into()))?;
        if end > self.end {
            return Err(RomWeaverError::Validation(
                "UPS patch ended unexpectedly while reading record data".into(),
            ));
        }

        let start = self.offset;
        self.offset = end;
        Ok(&self.bytes[start..end])
    }

    fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_exact(1)?[0])
    }

    fn read_varint(&mut self) -> Result<u64> {
        let mut data = 0u64;
        let mut shift = 1u64;
        loop {
            let byte = u64::from(self.read_u8()?);
            data = data.checked_add((byte & 0x7f) * shift).ok_or_else(|| {
                RomWeaverError::Validation("UPS varint overflowed available range".into())
            })?;
            if byte & 0x80 != 0 {
                return Ok(data);
            }

            shift = shift
                .checked_shl(7)
                .ok_or_else(|| RomWeaverError::Validation("UPS varint shift overflowed".into()))?;
            data = data.checked_add(shift).ok_or_else(|| {
                RomWeaverError::Validation("UPS varint overflowed available range".into())
            })?;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rom_weaver_core::{
        PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    };

    use super::{UpsPatchHandler, create_ups_patch_bytes, parse_ups_bytes};
    use crate::{
        UPS,
        test_support::{TestDir, test_context_with_threads},
    };

    #[test]
    fn parse_rejects_invalid_patch_checksum() {
        let mut patch = create_ups_patch_bytes(b"source", b"target")
            .expect("patch")
            .bytes;
        patch[5] ^= 0x01;

        let error = parse_ups_bytes(&patch).expect_err("checksum mismatch should fail");
        assert!(error.to_string().contains("Patch checksum invalid"));
    }

    #[test]
    fn create_and_apply_round_trip_in_both_directions() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.ups");
        let output_path = temp.child("output.bin");
        let reverse_output = temp.child("reverse.bin");

        let source = b"abcabcabcabc";
        let target = b"abcabcZZabcabc";
        fs::write(&source_path, source).expect("fixture");
        fs::write(&target_path, target).expect("fixture");

        let handler = UpsPatchHandler::new(&UPS);
        let create_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "UPS".into(),
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
                    input: source_path.clone(),
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
                    output: reverse_output.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("reverse apply");

        assert_eq!(fs::read(reverse_output).expect("reverse output"), source);
    }

    #[test]
    fn apply_rejects_inputs_that_match_neither_side() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.ups");
        let bad_input_path = temp.child("wrong.bin");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"expected source").expect("fixture");
        fs::write(&target_path, b"expected target").expect("fixture");
        fs::write(&bad_input_path, b"something else").expect("fixture");

        let handler = UpsPatchHandler::new(&UPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path,
                    modified: target_path,
                    output: patch_path.clone(),
                    format: "UPS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: bad_input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("apply should fail");

        assert!(error.to_string().contains("UPS input validation failed"));
    }

    #[test]
    fn apply_can_ignore_patch_checksum_mismatch() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.ups");
        let output_path = temp.child("output.bin");
        fs::write(&source_path, b"hello old world").expect("fixture");
        fs::write(&target_path, b"hello new world").expect("fixture");

        let handler = UpsPatchHandler::new(&UPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "UPS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let mut patch_bytes = fs::read(&patch_path).expect("patch bytes");
        let footer_index = patch_bytes.len().checked_sub(1).expect("patch footer");
        patch_bytes[footer_index] ^= 0x01;
        fs::write(&patch_path, patch_bytes).expect("patch bytes");

        let strict_error = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("strict patch checksum validation should fail");
        assert!(strict_error.to_string().contains("Patch checksum invalid"));

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1)
                    .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("ignore checksum validation should apply patch");

        assert_eq!(
            fs::read(output_path).expect("output"),
            fs::read(target_path).expect("target")
        );
    }
}
