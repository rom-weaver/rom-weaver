use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

const PAT_LINE_MAX_BYTES: usize = 4 * 1024;
const PAT_SCAN_BUFFER_SIZE: usize = 64 * 1024;

pub struct PatPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl PatPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for PatPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let parsed = parse_pat_file(patch_path)?;
        let ignored_suffix = if parsed.ignored_lines > 0 {
            format!("; ignored {} non-record line(s)", parsed.ignored_lines)
        } else {
            String::new()
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s){ignored_suffix}",
                self.descriptor.name,
                parsed.records.len()
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
        let parsed = parse_pat_file(patch_path)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &request.output)?;

        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&request.output)?;
        let output_len = fs::metadata(&request.output)?.len();

        let mut forward_applied = 0usize;
        let mut reverse_applied = 0usize;
        let mut skipped = 0usize;
        for record in &parsed.records {
            if record.offset >= output_len {
                return Err(RomWeaverError::Validation(format!(
                    "PAT record offset 0x{:08X} exceeded input length {}",
                    record.offset, output_len
                )));
            }

            output.seek(SeekFrom::Start(record.offset))?;
            let mut current = [0u8; 1];
            output.read_exact(&mut current)?;
            output.seek(SeekFrom::Start(record.offset))?;

            if current[0] == record.source_byte {
                output.write_all(&[record.modified_byte])?;
                forward_applied = forward_applied.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("PAT apply count overflowed".into())
                })?;
            } else if current[0] == record.modified_byte {
                output.write_all(&[record.source_byte])?;
                reverse_applied = reverse_applied.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("PAT apply count overflowed".into())
                })?;
            } else {
                skipped = skipped.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("PAT apply count overflowed".into())
                })?;
            }
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

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} record(s): {} forward / {} reverse{ignored_suffix}{skipped_suffix}",
                self.descriptor.name,
                parsed.records.len(),
                forward_applied,
                reverse_applied
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
        let created = create_pat_patch_streaming(&request.original, &request.modified)?;

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

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name,
                created.records.len()
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::default_patch_capabilities()
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

pub(crate) fn has_pat_record_signature(path: &Path) -> bool {
    parse_pat_file(path)
        .map(|parsed| !parsed.records.is_empty())
        .unwrap_or(false)
}

fn parse_pat_file(path: &Path) -> Result<ParsedPatPatch> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    parse_pat_reader(reader)
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
}
