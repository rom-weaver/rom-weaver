use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchCreateRequest, PatchHandler, Result, RomWeaverError, SharedThreadPool, ThreadCapability,
};

const PAT_LINE_MAX_BYTES: usize = 4 * 1024;
const PAT_SCAN_BUFFER_SIZE: usize = 64 * 1024;
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

pub struct PatPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl PatPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn parse_report(&self, patch_path: &Path) -> Result<OperationReport> {
        crate::patch_parse_report_with(self.descriptor, || {
            let parsed = parse_pat_file(patch_path)?;
            Ok(build_pat_parse_label(self.descriptor.name, &parsed))
        })
    }

    fn apply_report(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let parsed = parse_pat_file(patch_path)?;
        let grouped_records = group_pat_records_by_offset(&parsed.records);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &request.output)?;
        let output_len = fs::metadata(&request.output)?.len();
        validate_pat_record_offsets(&grouped_records, output_len)?;
        let input = crate::map_file_read_only(&request.input)?;
        let thread_capability = pat_apply_thread_capability(grouped_records.len());
        let planned_execution = context.plan_threads(thread_capability.clone());

        let (execution, mut writes) = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let writes = pool.install(|| {
                grouped_records
                    .par_iter()
                    .map(|group| prepare_pat_offset_write(group, input.as_ref(), context))
                    .collect::<Result<Vec<_>>>()
            })?;
            (execution, writes)
        } else {
            let writes = grouped_records
                .iter()
                .map(|group| prepare_pat_offset_write(group, input.as_ref(), context))
                .collect::<Result<Vec<_>>>()?;
            (planned_execution, writes)
        };

        writes.sort_by_key(|write| write.offset);
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;

        let mut forward_applied = 0usize;
        let mut reverse_applied = 0usize;
        let mut skipped = 0usize;
        for write in &writes {
            output.seek(SeekFrom::Start(write.offset))?;
            output.write_all(&[write.byte])?;
            forward_applied = forward_applied
                .checked_add(write.forward_applied)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
            reverse_applied = reverse_applied
                .checked_add(write.reverse_applied)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
            skipped = skipped
                .checked_add(write.skipped)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        }
        output.flush()?;

        let ignored_suffix = if parsed.ignored_lines > 0 {
            format!("; ignored {} non-record line(s)", parsed.ignored_lines)
        } else {
            String::new()
        };
        let skipped_suffix = if skipped > 0 {
            format!("; skipped {skipped} record(s) due to unexpected input byte")
        } else {
            String::new()
        };

        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch with {} record(s): {} forward / {} reverse{ignored_suffix}{skipped_suffix}",
                self.descriptor.name,
                parsed.records.len(),
                forward_applied,
                reverse_applied
            ),
            Some(execution),
        ))
    }
}

impl PatchHandler for PatPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        self.parse_report(patch_path)
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.apply_report(request, context)
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        if original_len != modified_len {
            return Err(RomWeaverError::Validation(format!(
                "PAT create requires equal input lengths (original: {original_len}, modified: {modified_len})"
            )));
        }

        let (execution, pool) = context.build_pool(pat_create_thread_capability(original_len))?;
        let created = create_pat_patch(
            &request.original,
            &request.modified,
            &pool,
            execution.used_parallelism,
        )?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&request.output)?);
        for record in &created.records {
            writeln!(
                output,
                "{:08X} {:02X} {:02X}",
                record.offset, record.source_byte, record.modified_byte
            )?;
        }
        output.flush()?;

        Ok(crate::patch_success_report(
            self.descriptor,
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name,
                created.records.len()
            ),
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

#[derive(Clone, Copy, Debug)]
struct PatRecord {
    offset: u64,
    source_byte: u8,
    modified_byte: u8,
}

#[derive(Debug)]
pub(crate) struct ParsedPatPatch {
    records: Vec<PatRecord>,
    ignored_lines: usize,
}

#[derive(Debug)]
struct CreatedPatPatch {
    records: Vec<PatRecord>,
}

#[derive(Debug)]
struct PatOffsetGroup {
    offset: u64,
    records: Vec<PatRecord>,
}

#[derive(Clone, Copy, Debug)]
struct PreparedPatWrite {
    offset: u64,
    byte: u8,
    forward_applied: usize,
    reverse_applied: usize,
    skipped: usize,
}

pub(crate) fn has_pat_record_signature(path: &Path) -> bool {
    parse_pat_file(path)
        .map(|parsed| !parsed.records.is_empty())
        .unwrap_or(false)
}

fn group_pat_records_by_offset(records: &[PatRecord]) -> Vec<PatOffsetGroup> {
    let mut grouped = BTreeMap::<u64, Vec<PatRecord>>::new();
    for record in records {
        grouped.entry(record.offset).or_default().push(*record);
    }
    grouped
        .into_iter()
        .map(|(offset, records)| PatOffsetGroup { offset, records })
        .collect()
}

fn validate_pat_record_offsets(groups: &[PatOffsetGroup], output_len: u64) -> Result<()> {
    for group in groups {
        if group.offset >= output_len {
            return Err(RomWeaverError::Validation(format!(
                "PAT record offset 0x{:08X} exceeded input length {}",
                group.offset, output_len
            )));
        }
    }
    Ok(())
}

fn pat_apply_thread_capability(group_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(group_count.max(1)))
}

fn prepare_pat_offset_write(
    group: &PatOffsetGroup,
    input: &[u8],
    context: &OperationContext,
) -> Result<PreparedPatWrite> {
    context.cancel().check()?;
    let index = usize::try_from(group.offset)
        .map_err(|_| RomWeaverError::Validation("PAT offset exceeded addressable memory".into()))?;
    let mut current = *input.get(index).ok_or_else(|| {
        RomWeaverError::Validation("PAT record offset exceeded addressable memory".into())
    })?;

    let mut forward_applied = 0usize;
    let mut reverse_applied = 0usize;
    let mut skipped = 0usize;

    for record in &group.records {
        if current == record.source_byte {
            current = record.modified_byte;
            forward_applied = forward_applied
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        } else if current == record.modified_byte {
            current = record.source_byte;
            reverse_applied = reverse_applied
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        } else {
            skipped = skipped
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT apply count overflowed".into()))?;
        }
    }

    Ok(PreparedPatWrite {
        offset: group.offset,
        byte: current,
        forward_applied,
        reverse_applied,
        skipped,
    })
}

fn parse_pat_file(path: &Path) -> Result<ParsedPatPatch> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    parse_pat_reader(reader)
}

fn build_pat_parse_label(format_name: &str, parsed: &ParsedPatPatch) -> String {
    if parsed.ignored_lines == 0 {
        return format!(
            "parsed {format_name} patch with {} record(s)",
            parsed.records.len()
        );
    }

    format!(
        "parsed {format_name} patch with {} record(s); ignored {} non-record line(s)",
        parsed.records.len(),
        parsed.ignored_lines
    )
}

fn parse_pat_reader<R: BufRead>(mut reader: R) -> Result<ParsedPatPatch> {
    let mut records = Vec::new();
    let mut ignored_lines = 0usize;

    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        if line.len() > PAT_LINE_MAX_BYTES {
            return Err(RomWeaverError::Validation(format!(
                "PAT line exceeded maximum supported length of {PAT_LINE_MAX_BYTES} byte(s)"
            )));
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            ignored_lines = ignored_lines
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT line count overflowed".into()))?;
            continue;
        }

        if let Some(record) = parse_pat_record(trimmed) {
            records.push(record);
        } else {
            ignored_lines = ignored_lines
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT line count overflowed".into()))?;
        }
    }

    Ok(ParsedPatPatch {
        records,
        ignored_lines,
    })
}

fn parse_pat_record(line: &str) -> Option<PatRecord> {
    let line = line.strip_prefix('\u{feff}').unwrap_or(line);
    let mut fields = line.split_whitespace();

    let offset_field = fields.next()?;
    let source_field = fields.next()?;
    let modified_field = fields.next()?;
    if fields.next().is_some() {
        return None;
    }
    if source_field.len() != 2 || modified_field.len() != 2 {
        return None;
    }

    let offset_hex = offset_field.get(..8)?;
    let offset = u64::from(u32::from_str_radix(offset_hex, 16).ok()?);
    let source_byte = u8::from_str_radix(source_field, 16).ok()?;
    let modified_byte = u8::from_str_radix(modified_field, 16).ok()?;

    Some(PatRecord {
        offset,
        source_byte,
        modified_byte,
    })
}

fn create_pat_patch_streaming(
    original_path: &Path,
    modified_path: &Path,
) -> Result<CreatedPatPatch> {
    let original_len = fs::metadata(original_path)?.len();
    let modified_len = fs::metadata(modified_path)?.len();
    if original_len != modified_len {
        return Err(RomWeaverError::Validation(format!(
            "PAT create requires equal input lengths (original: {original_len}, modified: {modified_len})"
        )));
    }

    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    let mut original_buffer = vec![0u8; PAT_SCAN_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; PAT_SCAN_BUFFER_SIZE];

    let mut records = Vec::new();
    let mut offset = 0u64;

    loop {
        let read = original.read(&mut original_buffer)?;
        let modified_read = modified.read(&mut modified_buffer)?;

        if read != modified_read {
            return Err(RomWeaverError::Validation(
                "PAT create detected mismatched read lengths while scanning inputs".into(),
            ));
        }
        if read == 0 {
            break;
        }

        for index in 0..read {
            let source_byte = original_buffer[index];
            let modified_byte = modified_buffer[index];
            if source_byte != modified_byte {
                if offset > u64::from(u32::MAX) {
                    return Err(RomWeaverError::Validation(
                        "PAT create supports offsets up to 0xFFFFFFFF".into(),
                    ));
                }

                records.push(PatRecord {
                    offset,
                    source_byte,
                    modified_byte,
                });
            }

            offset = offset
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("PAT create offset overflowed".into()))?;
        }
    }

    Ok(CreatedPatPatch { records })
}

fn pat_create_thread_capability(input_len: u64) -> ThreadCapability {
    let chunk_count = pat_create_chunk_count(input_len).max(1);
    ThreadCapability::parallel(Some(chunk_count))
}

fn pat_create_chunk_count(input_len: u64) -> usize {
    if input_len == 0 {
        return 1;
    }
    let chunk_bytes = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_count = input_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).unwrap_or(usize::MAX)
}

fn create_pat_patch(
    original_path: &Path,
    modified_path: &Path,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
) -> Result<CreatedPatPatch> {
    if use_parallel_scan {
        create_pat_patch_parallel(original_path, modified_path, pool)
    } else {
        create_pat_patch_streaming(original_path, modified_path)
    }
}

fn create_pat_patch_parallel(
    original_path: &Path,
    modified_path: &Path,
    pool: &SharedThreadPool,
) -> Result<CreatedPatPatch> {
    let original = crate::map_file_read_only(original_path)?;
    let modified = crate::map_file_read_only(modified_path)?;
    if original.len() != modified.len() {
        return Err(RomWeaverError::Validation(format!(
            "PAT create requires equal input lengths (original: {}, modified: {})",
            original.len(),
            modified.len()
        )));
    }
    if original.len() > (u32::MAX as usize).saturating_add(1) {
        return Err(RomWeaverError::Validation(
            "PAT create supports offsets up to 0xFFFFFFFF".into(),
        ));
    }

    if original.is_empty() {
        return Ok(CreatedPatPatch {
            records: Vec::new(),
        });
    }

    let chunk_ranges = (0..original.len())
        .step_by(CREATE_THREAD_SCAN_CHUNK_BYTES)
        .map(|start| {
            let end = start
                .saturating_add(CREATE_THREAD_SCAN_CHUNK_BYTES)
                .min(original.len());
            start..end
        })
        .collect::<Vec<_>>();

    let per_chunk_records = pool.install(|| {
        chunk_ranges
            .into_par_iter()
            .map(|range| {
                collect_pat_chunk_records(
                    original.as_ref(),
                    modified.as_ref(),
                    range.start,
                    range.end,
                )
            })
            .collect::<Vec<_>>()
    });

    let mut records = Vec::new();
    for mut chunk_records in per_chunk_records {
        records.append(&mut chunk_records);
    }

    Ok(CreatedPatPatch { records })
}

fn collect_pat_chunk_records(
    original: &[u8],
    modified: &[u8],
    start: usize,
    end: usize,
) -> Vec<PatRecord> {
    let mut records = Vec::new();
    for index in start..end {
        let source_byte = original[index];
        let modified_byte = modified[index];
        if source_byte != modified_byte {
            records.push(PatRecord {
                offset: index as u64,
                source_byte,
                modified_byte,
            });
        }
    }
    records
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::{PatPatchHandler, has_pat_record_signature, parse_pat_record};
    use crate::{
        PAT,
        test_support::{TestDir, test_context_with_threads},
    };

    #[test]
    fn parse_accepts_fireflower_and_fc_styles() {
        assert!(parse_pat_record("00000010 FF 00").is_some());
        assert!(parse_pat_record("00000010: FF 00").is_some());
        assert!(parse_pat_record("00000010 0g 00").is_none());
    }

    #[test]
    fn apply_supports_forward_and_reverse_byte_toggles() {
        let temp = TestDir::new();
        let source = temp.child("source.bin");
        let patch = temp.child("toggle.pat");
        let forward = temp.child("forward.bin");
        let reverse = temp.child("reverse.bin");

        fs::write(&source, b"abc").expect("fixture");
        fs::write(&patch, b"00000000 61 41\n00000001 62 42\n").expect("fixture");

        let handler = PatPatchHandler::new(&PAT);
        handler
            .apply(
                &PatchApplyRequest {
                    input: source.clone(),
                    patches: vec![patch.clone()],
                    output: forward.clone(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("forward apply");

        assert_eq!(fs::read(&forward).expect("forward"), b"ABc");

        handler
            .apply(
                &PatchApplyRequest {
                    input: forward,
                    patches: vec![patch],
                    output: reverse.clone(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("reverse apply");

        assert_eq!(fs::read(reverse).expect("reverse"), b"abc");
    }

    #[test]
    fn apply_skips_unexpected_bytes_without_failing() {
        let temp = TestDir::new();
        let source = temp.child("source.bin");
        let patch = temp.child("skip.pat");
        let output = temp.child("output.bin");

        fs::write(&source, b"abc").expect("fixture");
        fs::write(&patch, b"00000001 00 ff\n").expect("fixture");

        let handler = PatPatchHandler::new(&PAT);
        handler
            .apply(
                &PatchApplyRequest {
                    input: source.clone(),
                    patches: vec![patch],
                    output: output.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(fs::read(output).expect("output"), b"abc");
    }

    #[test]
    fn apply_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let source = temp.child("source.bin");
        let patch = temp.child("update.pat");
        let output_single = temp.child("output-single.bin");
        let output_parallel = temp.child("output-parallel.bin");

        let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 8192;
        let mut source_bytes = vec![0u8; len];
        for (index, byte) in source_bytes.iter_mut().enumerate() {
            *byte = ((index * 17 + (index >> 4)) & 0xff) as u8;
        }
        fs::write(&source, &source_bytes).expect("fixture");

        let mut patch_lines = String::new();
        for offset in (0..len).step_by(4096) {
            let source_byte = source_bytes[offset];
            let modified_byte = source_byte ^ 0x5a;
            patch_lines.push_str(&format!(
                "{offset:08X} {source_byte:02X} {modified_byte:02X}\n"
            ));
        }
        // Add duplicate-offset records to verify offset-local order remains deterministic.
        let first_source = source_bytes[0];
        let first_modified = first_source ^ 0x5a;
        patch_lines.push_str(&format!(
            "00000000 {first_modified:02X} {first_source:02X}\n"
        ));
        patch_lines.push_str(&format!(
            "00000000 {first_source:02X} {first_modified:02X}\n"
        ));
        fs::write(&patch, patch_lines).expect("patch");

        let handler = PatPatchHandler::new(&PAT);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_output);

        let single_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source.clone(),
                    patches: vec![patch.clone()],
                    output: output_single.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single apply");
        let parallel_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source,
                    patches: vec![patch],
                    output: output_parallel.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel apply");

        let single_execution = single_report.thread_execution.expect("single execution");
        let parallel_execution = parallel_report
            .thread_execution
            .expect("parallel execution");
        assert!(capabilities.threaded_output);
        assert!(!single_execution.used_parallelism);
        assert!(parallel_execution.used_parallelism);

        assert_eq!(
            fs::read(output_single).expect("single"),
            fs::read(output_parallel).expect("parallel")
        );
    }

    #[test]
    fn create_rejects_mismatched_lengths() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.pat");

        fs::write(&original, b"abc").expect("fixture");
        fs::write(&modified, b"abcd").expect("fixture");

        let handler = PatPatchHandler::new(&PAT);
        let error = handler
            .create(
                &PatchCreateRequest {
                    original,
                    modified,
                    output: patch,
                    format: "pat".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("mismatched lengths should fail");
        assert!(error.to_string().contains("requires equal input lengths"));
    }

    #[test]
    fn create_and_apply_round_trip() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.pat");
        let output = temp.child("output.bin");

        fs::write(&original, b"hello old world").expect("fixture");
        fs::write(&modified, b"HELlo old worlD").expect("fixture");

        let handler = PatPatchHandler::new(&PAT);
        handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified: modified.clone(),
                    output: patch.clone(),
                    format: "pat".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let patch_text = fs::read_to_string(&patch).expect("patch");
        assert!(patch_text.contains("00000000 68 48"));
        assert!(has_pat_record_signature(&patch));

        handler
            .apply(
                &PatchApplyRequest {
                    input: original,
                    patches: vec![patch],
                    output: output.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(
            fs::read(output).expect("output"),
            fs::read(modified).expect("modified")
        );
    }

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let original = temp.child("old-large.bin");
        let modified = temp.child("new-large.bin");
        let patch_single = temp.child("single.pat");
        let patch_parallel = temp.child("parallel.pat");

        let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 32 * 1024;
        let mut source = vec![0u8; len];
        for (index, byte) in source.iter_mut().enumerate() {
            *byte = ((index * 31 + (index >> 6)) & 0xff) as u8;
        }
        let mut target = source.clone();
        for index in (0..target.len()).step_by(3001) {
            target[index] ^= 0x7f;
        }

        fs::write(&original, &source).expect("source");
        fs::write(&modified, &target).expect("target");

        let handler = PatPatchHandler::new(&PAT);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified: modified.clone(),
                    output: patch_single.clone(),
                    format: "pat".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original,
                    modified,
                    output: patch_parallel.clone(),
                    format: "pat".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel create");

        assert!(
            !single_report
                .thread_execution
                .expect("single execution")
                .used_parallelism
        );
        assert!(
            parallel_report
                .thread_execution
                .expect("parallel execution")
                .used_parallelism
        );
        assert_eq!(
            fs::read(patch_single).expect("single patch"),
            fs::read(patch_parallel).expect("parallel patch")
        );
    }
}
