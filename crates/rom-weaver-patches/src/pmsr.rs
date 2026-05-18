use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

const PMSR_MAGIC: &[u8; 4] = b"PMSR";
const PMSR_HEADER_SIZE: usize = 8;
const PMSR_IO_BUFFER_SIZE: usize = 64 * 1024;

pub struct PmsrPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl PmsrPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for PmsrPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_pmsr_file(patch_path)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s)",
                self.descriptor.name,
                patch.records.len()
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

        let patch = parse_pmsr_file(&request.patches[0])?;
        let source_len = fs::metadata(&request.input)?.len();
        let output_len = patch.min_target_size.max(source_len);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &request.output)?;
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        output.set_len(output_len)?;
        apply_pmsr_patch_in_place(&patch, output_len, &mut output)?;
        output.flush()?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} record(s)",
                self.descriptor.name,
                patch.records.len()
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
        let patch = create_pmsr_patch_streaming(&request.original, &request.modified)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, patch.bytes)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name, patch.record_count
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
struct ParsedPmsrPatch {
    // PMSR does not encode a target size directly. We use the largest record end as
    // the minimum required output length and preserve at least the input length.
    min_target_size: u64,
    records: Vec<PmsrRecord>,
}

#[derive(Clone, Debug)]
struct PmsrRecord {
    offset: u64,
    data: Vec<u8>,
}

#[derive(Debug)]
struct CreatedPmsrPatch {
    bytes: Vec<u8>,
    record_count: usize,
}

fn parse_pmsr_file(path: &Path) -> Result<ParsedPmsrPatch> {
    let bytes = fs::read(path)?;
    parse_pmsr_bytes(&bytes)
}

fn parse_pmsr_bytes(bytes: &[u8]) -> Result<ParsedPmsrPatch> {
    if bytes.len() < PMSR_HEADER_SIZE {
        return Err(RomWeaverError::Validation(
            "MOD patch is too small to contain a valid header".into(),
        ));
    }
    if &bytes[..PMSR_MAGIC.len()] != PMSR_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let mut cursor = PMSR_MAGIC.len();
    let record_count = read_u32_be(bytes, &mut cursor, "MOD record count")?;
    let record_capacity = usize::try_from(record_count).map_err(|_| {
        RomWeaverError::Validation("MOD record count exceeded platform addressable range".into())
    })?;
    let mut records = Vec::with_capacity(record_capacity);
    let mut min_target_size = 0u64;

    for _ in 0..record_count {
        let offset = u64::from(read_u32_be(bytes, &mut cursor, "MOD record offset")?);
        let data_len_u32 = read_u32_be(bytes, &mut cursor, "MOD record length")?;
        let data_len = usize::try_from(data_len_u32).map_err(|_| {
            RomWeaverError::Validation("MOD record length exceeded addressable memory".into())
        })?;
        let data = read_exact(bytes, &mut cursor, data_len, "MOD record data")?.to_vec();
        let end = checked_add(offset, u64::from(data_len_u32), "MOD record end")?;
        min_target_size = min_target_size.max(end);
        records.push(PmsrRecord { offset, data });
    }

    if cursor != bytes.len() {
        return Err(RomWeaverError::Validation(
            "MOD patch contained unexpected trailing data".into(),
        ));
    }

    Ok(ParsedPmsrPatch {
        min_target_size,
        records,
    })
}

#[allow(dead_code)]
fn create_pmsr_patch_bytes(original: &[u8], modified: &[u8]) -> Result<CreatedPmsrPatch> {
    if modified.len() < original.len() {
        return Err(RomWeaverError::Validation(format!(
            "MOD create does not support shrinking outputs (original: {}, modified: {})",
            original.len(),
            modified.len(),
        )));
    }

    let scan_len = modified.len();
    let mut index = 0usize;
    let mut records = Vec::new();

    while index < scan_len {
        let source = original.get(index).copied().unwrap_or(0);
        let target = modified[index];
        if source == target {
            index += 1;
            continue;
        }

        let start = index;
        let mut data = Vec::new();
        while index < scan_len {
            let source = original.get(index).copied().unwrap_or(0);
            let target = modified[index];
            if source == target {
                break;
            }
            data.push(target);
            index += 1;
        }

        let offset = u64::try_from(start)
            .map_err(|_| RomWeaverError::Validation("MOD record offset exceeded u64".into()))?;
        records.push(PmsrRecord { offset, data });
    }

    let modified_len_u64 = u64::try_from(modified.len())
        .map_err(|_| RomWeaverError::Validation("MOD target length exceeded u64".into()))?;
    let max_record_end = records.iter().try_fold(0u64, |current_max, record| {
        let data_len = u64::try_from(record.data.len())
            .map_err(|_| RomWeaverError::Validation("MOD record length exceeded u64".into()))?;
        let end = checked_add(record.offset, data_len, "MOD record end")?;
        Ok::<u64, RomWeaverError>(current_max.max(end))
    })?;

    // PMSR does not encode target length directly. A zero-length trailing record
    // preserves growth when the tail bytes are all zero.
    if modified_len_u64 > max_record_end {
        records.push(PmsrRecord {
            offset: modified_len_u64,
            data: Vec::new(),
        });
    }

    let record_count = records.len();
    let record_count_u32 = u32::try_from(record_count).map_err(|_| {
        RomWeaverError::Validation("MOD record count exceeded encodable range".into())
    })?;
    let payload_capacity = records.iter().try_fold(0usize, |accumulator, record| {
        let next = accumulator
            .checked_add(8)
            .and_then(|value| value.checked_add(record.data.len()))
            .ok_or_else(|| {
                RomWeaverError::Validation("MOD patch size exceeded addressable memory".into())
            })?;
        Ok::<usize, RomWeaverError>(next)
    })?;
    let mut bytes = Vec::with_capacity(PMSR_HEADER_SIZE.checked_add(payload_capacity).ok_or_else(
        || RomWeaverError::Validation("MOD patch size exceeded addressable memory".into()),
    )?);
    bytes.extend_from_slice(PMSR_MAGIC);
    bytes.extend_from_slice(&record_count_u32.to_be_bytes());

    for record in &records {
        let offset_u32 = u32::try_from(record.offset).map_err(|_| {
            RomWeaverError::Validation("MOD record offset exceeded 32-bit range".into())
        })?;
        let length_u32 = u32::try_from(record.data.len()).map_err(|_| {
            RomWeaverError::Validation("MOD record length exceeded 32-bit range".into())
        })?;
        bytes.extend_from_slice(&offset_u32.to_be_bytes());
        bytes.extend_from_slice(&length_u32.to_be_bytes());
        bytes.extend_from_slice(&record.data);
    }

    Ok(CreatedPmsrPatch {
        bytes,
        record_count,
    })
}

fn apply_pmsr_patch_in_place(
    patch: &ParsedPmsrPatch,
    output_len: u64,
    output: &mut File,
) -> Result<()> {
    for record in &patch.records {
        let end = checked_add(
            record.offset,
            u64::try_from(record.data.len())
                .map_err(|_| RomWeaverError::Validation("MOD record length exceeded u64".into()))?,
            "MOD record end",
        )?;
        if end > output_len {
            return Err(RomWeaverError::Validation(
                "MOD record exceeded declared output size".into(),
            ));
        }
        if record.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(record.offset))?;
        output.write_all(&record.data)?;
    }
    Ok(())
}

fn create_pmsr_patch_streaming(
    original_path: &Path,
    modified_path: &Path,
) -> Result<CreatedPmsrPatch> {
    let original_len = fs::metadata(original_path)?.len();
    let modified_len = fs::metadata(modified_path)?.len();
    if modified_len < original_len {
        return Err(RomWeaverError::Validation(format!(
            "MOD create does not support shrinking outputs (original: {}, modified: {})",
            original_len, modified_len,
        )));
    }

    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    let mut original_remaining = original_len;
    let mut modified_remaining = modified_len;
    let mut source_buffer = vec![0u8; PMSR_IO_BUFFER_SIZE];
    let mut target_buffer = vec![0u8; PMSR_IO_BUFFER_SIZE];
    let mut records = Vec::<PmsrRecord>::new();
    let mut offset = 0u64;

    let mut pending_start: Option<u64> = None;
    let mut pending_data = Vec::<u8>::new();

    while modified_remaining > 0 {
        let chunk_len = usize::try_from(modified_remaining.min(PMSR_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("MOD chunk length exceeded usize".into()))?;
        let source_chunk_len =
            usize::try_from(original_remaining.min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("MOD source chunk length exceeded usize".into())
            })?;

        if source_chunk_len > 0 {
            original.read_exact(&mut source_buffer[..source_chunk_len])?;
        }
        modified.read_exact(&mut target_buffer[..chunk_len])?;

        for index in 0..chunk_len {
            let source_byte = if index < source_chunk_len {
                source_buffer[index]
            } else {
                0
            };
            let target_byte = target_buffer[index];
            if source_byte == target_byte {
                if !pending_data.is_empty() {
                    let start = pending_start.expect("pending start exists");
                    records.push(PmsrRecord {
                        offset: start,
                        data: std::mem::take(&mut pending_data),
                    });
                    pending_start = None;
                }
            } else {
                if pending_start.is_none() {
                    pending_start = Some(offset);
                }
                pending_data.push(target_byte);
            }
            offset = checked_add(offset, 1, "MOD scan offset")?;
        }

        original_remaining = original_remaining.saturating_sub(source_chunk_len as u64);
        modified_remaining = modified_remaining
            .checked_sub(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("MOD remaining underflowed".into()))?;
    }

    if !pending_data.is_empty() {
        let start = pending_start.expect("pending start exists");
        records.push(PmsrRecord {
            offset: start,
            data: pending_data,
        });
    }

    let max_record_end = records.iter().try_fold(0u64, |current_max, record| {
        let data_len = u64::try_from(record.data.len())
            .map_err(|_| RomWeaverError::Validation("MOD record length exceeded u64".into()))?;
        let end = checked_add(record.offset, data_len, "MOD record end")?;
        Ok::<u64, RomWeaverError>(current_max.max(end))
    })?;
    if modified_len > max_record_end {
        records.push(PmsrRecord {
            offset: modified_len,
            data: Vec::new(),
        });
    }

    let record_count = records.len();
    let record_count_u32 = u32::try_from(record_count).map_err(|_| {
        RomWeaverError::Validation("MOD record count exceeded encodable range".into())
    })?;
    let payload_capacity = records.iter().try_fold(0usize, |accumulator, record| {
        let next = accumulator
            .checked_add(8)
            .and_then(|value| value.checked_add(record.data.len()))
            .ok_or_else(|| {
                RomWeaverError::Validation("MOD patch size exceeded addressable memory".into())
            })?;
        Ok::<usize, RomWeaverError>(next)
    })?;
    let mut bytes = Vec::with_capacity(PMSR_HEADER_SIZE.checked_add(payload_capacity).ok_or_else(
        || RomWeaverError::Validation("MOD patch size exceeded addressable memory".into()),
    )?);
    bytes.extend_from_slice(PMSR_MAGIC);
    bytes.extend_from_slice(&record_count_u32.to_be_bytes());
    for record in &records {
        let offset_u32 = u32::try_from(record.offset).map_err(|_| {
            RomWeaverError::Validation("MOD record offset exceeded 32-bit range".into())
        })?;
        let length_u32 = u32::try_from(record.data.len()).map_err(|_| {
            RomWeaverError::Validation("MOD record length exceeded 32-bit range".into())
        })?;
        bytes.extend_from_slice(&offset_u32.to_be_bytes());
        bytes.extend_from_slice(&length_u32.to_be_bytes());
        bytes.extend_from_slice(&record.data);
    }

    Ok(CreatedPmsrPatch {
        bytes,
        record_count,
    })
}

fn read_u32_be(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u32> {
    let slice = read_exact(bytes, cursor, 4, label)?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_exact<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    len: usize,
    label: &str,
) -> Result<&'a [u8]> {
    let end = cursor
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} offset overflowed")))?;
    let slice = bytes.get(*cursor..end).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "MOD patch ended unexpectedly while reading {label}"
        ))
    })?;
    *cursor = end;
    Ok(slice)
}

fn checked_add(offset: u64, len: u64, label: &str) -> Result<u64> {
    offset
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::{PmsrPatchHandler, create_pmsr_patch_bytes, parse_pmsr_bytes};
    use crate::{
        MOD,
        test_support::{TestDir, test_context_with_threads},
    };

    #[test]
    fn parse_rejects_invalid_header() {
        let mut bytes = vec![0u8; super::PMSR_HEADER_SIZE];
        bytes[..4].copy_from_slice(b"BAD!");
        let error = parse_pmsr_bytes(&bytes).expect_err("invalid header");
        assert!(error.to_string().contains("Patch header invalid"));
    }

    #[test]
    fn apply_supports_minimal_mod_patch() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("update.mod");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"ORIGINAL").expect("fixture");

        let mut patch = Vec::new();
        patch.extend_from_slice(b"PMSR");
        patch.extend_from_slice(&1u32.to_be_bytes());
        patch.extend_from_slice(&1u32.to_be_bytes());
        patch.extend_from_slice(&1u32.to_be_bytes());
        patch.push(b'X');
        fs::write(&patch_path, patch).expect("fixture");

        let handler = PmsrPatchHandler::new(&MOD);
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

        assert_eq!(fs::read(output_path).expect("output"), b"OXIGINAL");
    }

    #[test]
    fn create_and_apply_round_trip_with_growth() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.mod");
        let output_path = temp.child("output.bin");

        let source = b"\x01\x02".to_vec();
        let target = b"\x01\x02\x00\x00".to_vec();

        fs::write(&source_path, &source).expect("fixture");
        fs::write(&target_path, &target).expect("fixture");

        let handler = PmsrPatchHandler::new(&MOD);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "MOD".into(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("create");

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), target);
    }

    #[test]
    fn create_rejects_shrinking_outputs() {
        let source = b"\x01\x02\x03\x04";
        let target = b"\x01\x02\x03";
        let error = create_pmsr_patch_bytes(source, target).expect_err("shrinking output");
        assert!(
            error
                .to_string()
                .contains("MOD create does not support shrinking outputs")
        );
    }
}
