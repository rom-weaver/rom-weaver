use std::{fs, path::Path};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

const DPS_TEXT_FIELD_BYTES: usize = 64;
const DPS_HEADER_BYTES: usize = (DPS_TEXT_FIELD_BYTES * 3) + 1 + 1 + 4;
const DPS_PATCH_VERSION: u8 = 1;

const DPS_RECORD_COPY_FROM_SOURCE: u8 = 0;
const DPS_RECORD_EMBEDDED_DATA: u8 = 1;

const DEFAULT_PATCH_AUTHOR: &str = "rom-weaver";
const DEFAULT_PATCH_VERSION_TEXT: &str = "1";

pub struct DpsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl DpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for DpsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let parsed = parse_dps_file(patch_path)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch `{}` by `{}` (v{}) with {} record(s): {} copy / {} data; source {} byte(s), output {} byte(s), flag {}",
                self.descriptor.name,
                parsed.patch_name,
                parsed.patch_author,
                parsed.patch_version_text,
                parsed.records.len(),
                parsed.copy_record_count,
                parsed.data_record_count,
                parsed.source_size,
                parsed.output_size,
                parsed.patch_flag
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

        let parsed = parse_dps_file(&request.patches[0])?;
        let source = fs::read(&request.input)?;
        let source_len_u32 = u32::try_from(source.len()).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} source input exceeded maximum supported size of {} byte(s)",
                self.descriptor.name,
                u32::MAX
            ))
        })?;
        if source_len_u32 != parsed.source_size {
            return Err(RomWeaverError::Validation(format!(
                "{} source size mismatch: expected {} byte(s), actual {} byte(s)",
                self.descriptor.name, parsed.source_size, source_len_u32
            )));
        }

        let output_len = usize::try_from(parsed.output_size).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} output size exceeded addressable memory",
                self.descriptor.name
            ))
        })?;
        let mut output = vec![0u8; output_len];

        for record in &parsed.records {
            match record {
                DpsRecord::CopyFromSource {
                    output_offset,
                    source_offset,
                    length,
                } => {
                    let (source_start, source_end) =
                        checked_range(*source_offset, *length, source.len(), "DPS source copy")?;
                    let (output_start, output_end) =
                        checked_range(*output_offset, *length, output.len(), "DPS output write")?;
                    output[output_start..output_end]
                        .copy_from_slice(&source[source_start..source_end]);
                }
                DpsRecord::EmbeddedData {
                    output_offset,
                    data,
                } => {
                    let data_len = u32::try_from(data.len()).map_err(|_| {
                        RomWeaverError::Validation(
                            "DPS embedded record length exceeded 32-bit range".into(),
                        )
                    })?;
                    let (output_start, output_end) =
                        checked_range(*output_offset, data_len, output.len(), "DPS output write")?;
                    output[output_start..output_end].copy_from_slice(data);
                }
            }
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &output)?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} record(s): {} copy / {} data",
                self.descriptor.name,
                parsed.records.len(),
                parsed.copy_record_count,
                parsed.data_record_count
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
        let source = fs::read(&request.original)?;
        let target = fs::read(&request.modified)?;
        let source_size = u32::try_from(source.len()).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} create does not support sources larger than {} byte(s)",
                self.descriptor.name,
                u32::MAX
            ))
        })?;

        let records = create_dps_records(&source, &target)?;
        let patch_name = request
            .output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("rom-weaver.dps");
        let patch_bytes = encode_dps_patch(
            &records,
            DpsHeaderMetadata {
                patch_name,
                patch_author: DEFAULT_PATCH_AUTHOR,
                patch_version_text: DEFAULT_PATCH_VERSION_TEXT,
                patch_flag: 0,
            },
            source_size,
        )?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &patch_bytes)?;

        let copy_record_count = records
            .iter()
            .filter(|record| matches!(record, DpsRecord::CopyFromSource { .. }))
            .count();
        let data_record_count = records.len().saturating_sub(copy_record_count);

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s): {} copy / {} data",
                self.descriptor.name,
                records.len(),
                copy_record_count,
                data_record_count
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

#[derive(Clone, Debug)]
struct ParsedDpsPatch {
    patch_name: String,
    patch_author: String,
    patch_version_text: String,
    patch_flag: u8,
    source_size: u32,
    output_size: u64,
    copy_record_count: usize,
    data_record_count: usize,
    records: Vec<DpsRecord>,
}

#[derive(Clone, Debug)]
enum DpsRecord {
    CopyFromSource {
        output_offset: u32,
        source_offset: u32,
        length: u32,
    },
    EmbeddedData {
        output_offset: u32,
        data: Vec<u8>,
    },
}

impl DpsRecord {
    fn output_end(&self) -> Result<u64> {
        match self {
            DpsRecord::CopyFromSource {
                output_offset,
                length,
                ..
            } => u64::from(*output_offset)
                .checked_add(u64::from(*length))
                .ok_or_else(|| RomWeaverError::Validation("DPS output range overflowed".into())),
            DpsRecord::EmbeddedData {
                output_offset,
                data,
            } => u64::from(*output_offset)
                .checked_add(u64::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation(
                        "DPS embedded record length exceeded 64-bit range".into(),
                    )
                })?)
                .ok_or_else(|| RomWeaverError::Validation("DPS output range overflowed".into())),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct DpsHeaderMetadata<'a> {
    patch_name: &'a str,
    patch_author: &'a str,
    patch_version_text: &'a str,
    patch_flag: u8,
}

fn parse_dps_file(path: &Path) -> Result<ParsedDpsPatch> {
    let bytes = fs::read(path)?;
    parse_dps_bytes(&bytes)
}

fn parse_dps_bytes(bytes: &[u8]) -> Result<ParsedDpsPatch> {
    if bytes.len() < DPS_HEADER_BYTES {
        return Err(RomWeaverError::Validation(format!(
            "DPS patch is too small to contain a valid header (expected at least {DPS_HEADER_BYTES} byte(s), found {})",
            bytes.len()
        )));
    }

    let patch_name = parse_text_field(&bytes[0..DPS_TEXT_FIELD_BYTES]);
    let patch_author = parse_text_field(&bytes[DPS_TEXT_FIELD_BYTES..DPS_TEXT_FIELD_BYTES * 2]);
    let patch_version_text =
        parse_text_field(&bytes[DPS_TEXT_FIELD_BYTES * 2..DPS_TEXT_FIELD_BYTES * 3]);
    let patch_flag = bytes[DPS_TEXT_FIELD_BYTES * 3];

    let version = bytes[(DPS_TEXT_FIELD_BYTES * 3) + 1];
    if version != DPS_PATCH_VERSION {
        return Err(RomWeaverError::Validation(format!(
            "DPS patch version {version} is not supported (expected {DPS_PATCH_VERSION})"
        )));
    }

    let source_size_offset = (DPS_TEXT_FIELD_BYTES * 3) + 2;
    let source_size = u32::from_le_bytes([
        bytes[source_size_offset],
        bytes[source_size_offset + 1],
        bytes[source_size_offset + 2],
        bytes[source_size_offset + 3],
    ]);

    let mut cursor = DPS_HEADER_BYTES;
    let mut records = Vec::new();
    let mut output_size = 0u64;
    let mut copy_record_count = 0usize;
    let mut data_record_count = 0usize;
    while cursor < bytes.len() {
        let mode = read_u8(bytes, &mut cursor, "DPS record mode")?;
        let output_offset = read_u32_le(bytes, &mut cursor, "DPS output offset")?;

        let record = match mode {
            DPS_RECORD_COPY_FROM_SOURCE => {
                let source_offset = read_u32_le(bytes, &mut cursor, "DPS source offset")?;
                let length = read_u32_le(bytes, &mut cursor, "DPS source length")?;
                copy_record_count = copy_record_count.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("DPS record count overflowed".into())
                })?;
                DpsRecord::CopyFromSource {
                    output_offset,
                    source_offset,
                    length,
                }
            }
            DPS_RECORD_EMBEDDED_DATA => {
                let length = read_u32_le(bytes, &mut cursor, "DPS embedded data length")?;
                let length_usize = usize::try_from(length).map_err(|_| {
                    RomWeaverError::Validation(
                        "DPS embedded data length exceeded addressable memory".into(),
                    )
                })?;
                let data = read_exact(
                    bytes,
                    &mut cursor,
                    length_usize,
                    "DPS embedded record payload",
                )?
                .to_vec();
                data_record_count = data_record_count.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("DPS record count overflowed".into())
                })?;
                DpsRecord::EmbeddedData {
                    output_offset,
                    data,
                }
            }
            _ => {
                return Err(RomWeaverError::Validation(format!(
                    "DPS record mode {mode} is not supported"
                )));
            }
        };

        output_size = output_size.max(record.output_end()?);
        records.push(record);
    }

    Ok(ParsedDpsPatch {
        patch_name,
        patch_author,
        patch_version_text,
        patch_flag,
        source_size,
        output_size,
        copy_record_count,
        data_record_count,
        records,
    })
}

fn create_dps_records(source: &[u8], target: &[u8]) -> Result<Vec<DpsRecord>> {
    if target.len() > u32::MAX as usize {
        return Err(RomWeaverError::Validation(format!(
            "DPS create does not support targets larger than {} byte(s)",
            u32::MAX
        )));
    }

    let mut records = Vec::new();
    let mut index = 0usize;
    while index < target.len() {
        if source.get(index).copied() == Some(target[index]) {
            let start = index;
            while index < target.len() && source.get(index).copied() == Some(target[index]) {
                index += 1;
            }

            let output_offset = usize_to_u32(start, "DPS copy output offset")?;
            let source_offset = usize_to_u32(start, "DPS copy source offset")?;
            let length = usize_to_u32(index - start, "DPS copy length")?;
            records.push(DpsRecord::CopyFromSource {
                output_offset,
                source_offset,
                length,
            });
            continue;
        }

        let start = index;
        let mut data = Vec::new();
        while index < target.len() && source.get(index).copied() != Some(target[index]) {
            data.push(target[index]);
            index += 1;
        }

        let output_offset = usize_to_u32(start, "DPS data output offset")?;
        records.push(DpsRecord::EmbeddedData {
            output_offset,
            data,
        });
    }

    Ok(records)
}

fn encode_dps_patch(
    records: &[DpsRecord],
    metadata: DpsHeaderMetadata<'_>,
    source_size: u32,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    append_text_field(&mut bytes, metadata.patch_name);
    append_text_field(&mut bytes, metadata.patch_author);
    append_text_field(&mut bytes, metadata.patch_version_text);
    bytes.push(metadata.patch_flag);
    bytes.push(DPS_PATCH_VERSION);
    bytes.extend_from_slice(&source_size.to_le_bytes());

    for record in records {
        match record {
            DpsRecord::CopyFromSource {
                output_offset,
                source_offset,
                length,
            } => {
                bytes.push(DPS_RECORD_COPY_FROM_SOURCE);
                bytes.extend_from_slice(&output_offset.to_le_bytes());
                bytes.extend_from_slice(&source_offset.to_le_bytes());
                bytes.extend_from_slice(&length.to_le_bytes());
            }
            DpsRecord::EmbeddedData {
                output_offset,
                data,
            } => {
                let data_len = u32::try_from(data.len()).map_err(|_| {
                    RomWeaverError::Validation(
                        "DPS embedded record length exceeded 32-bit range".into(),
                    )
                })?;
                bytes.push(DPS_RECORD_EMBEDDED_DATA);
                bytes.extend_from_slice(&output_offset.to_le_bytes());
                bytes.extend_from_slice(&data_len.to_le_bytes());
                bytes.extend_from_slice(data);
            }
        }
    }

    Ok(bytes)
}

fn append_text_field(bytes: &mut Vec<u8>, text: &str) {
    let mut field = [0u8; DPS_TEXT_FIELD_BYTES];
    let source = text.as_bytes();
    let copy_len = source.len().min(DPS_TEXT_FIELD_BYTES);
    field[..copy_len].copy_from_slice(&source[..copy_len]);
    bytes.extend_from_slice(&field);
}

fn parse_text_field(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

fn read_u8(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u8> {
    Ok(read_exact(bytes, cursor, 1, label)?[0])
}

fn read_u32_le(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u32> {
    let raw = read_exact(bytes, cursor, 4, label)?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
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
            "DPS patch ended unexpectedly while reading {label}"
        ))
    })?;
    *cursor = end;
    Ok(slice)
}

fn checked_range(start: u32, len: u32, limit: usize, label: &str) -> Result<(usize, usize)> {
    let start = usize::try_from(start)
        .map_err(|_| RomWeaverError::Validation(format!("{label} offset exceeded usize range")))?;
    let len = usize::try_from(len)
        .map_err(|_| RomWeaverError::Validation(format!("{label} length exceeded usize range")))?;
    let end = start
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} range overflowed")))?;
    if end > limit {
        return Err(RomWeaverError::Validation(format!(
            "{label} exceeded available length ({end} > {limit})"
        )));
    }
    Ok((start, end))
}

fn usize_to_u32(value: usize, label: &str) -> Result<u32> {
    u32::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("{label} exceeded 32-bit range")))
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::PathBuf,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, NoopProgressSink, OperationContext, PatchApplyRequest,
        PatchCreateRequest, PatchHandler, ThreadBudget,
    };

    use super::{
        DPS_PATCH_VERSION, DpsHeaderMetadata, DpsPatchHandler, DpsRecord, encode_dps_patch,
        parse_dps_bytes,
    };
    use crate::DPS;

    static NEXT_TEST_DIR_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos();
            let sequence = NEXT_TEST_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "rom-weaver-dps-tests-{}-{timestamp}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir_all(&path).expect("temp dir");
            Self { path }
        }

        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parse_rejects_unsupported_patch_version() {
        let records = vec![DpsRecord::EmbeddedData {
            output_offset: 0,
            data: b"A".to_vec(),
        }];
        let mut bytes = encode_dps_patch(
            &records,
            DpsHeaderMetadata {
                patch_name: "unsupported-version.dps",
                patch_author: "test",
                patch_version_text: "0",
                patch_flag: 0,
            },
            0,
        )
        .expect("patch");
        bytes[193] = DPS_PATCH_VERSION + 1;

        let error = parse_dps_bytes(&bytes).expect_err("unsupported version");
        assert!(error.to_string().contains("is not supported"));
    }

    #[test]
    fn apply_supports_copy_and_embedded_data_records() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("update.dps");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        let records = vec![
            DpsRecord::CopyFromSource {
                output_offset: 0,
                source_offset: 0,
                length: 2,
            },
            DpsRecord::EmbeddedData {
                output_offset: 2,
                data: b"XY".to_vec(),
            },
            DpsRecord::CopyFromSource {
                output_offset: 4,
                source_offset: 4,
                length: 4,
            },
        ];
        let patch = encode_dps_patch(
            &records,
            DpsHeaderMetadata {
                patch_name: "copy-and-data.dps",
                patch_author: "test",
                patch_version_text: "1",
                patch_flag: 0,
            },
            8,
        )
        .expect("patch bytes");
        fs::write(&patch_path, patch).expect("fixture");

        let handler = DpsPatchHandler::new(&DPS);
        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), b"abXYefgh");
    }

    #[test]
    fn create_and_apply_round_trip_supports_shrinking_outputs() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.dps");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        fs::write(&target_path, b"abXY").expect("fixture");

        let handler = DpsPatchHandler::new(&DPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "dps".into(),
                },
                &test_context_with_threads(&temp, 2),
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

        assert_eq!(
            fs::read(output_path).expect("output"),
            fs::read(target_path).expect("target")
        );
    }

    fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            temp.child("temp"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }
}
