use std::{
    cmp::{max, min},
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use rayon::prelude::*;
use rom_weaver_core::{
    ChunkPlanner, FileChunk, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    PatchApplyRequest, PatchCapabilities, PatchChecksumValidation, PatchCreateRequest,
    PatchHandler, ProbeConfidence, Result, RomWeaverError, SharedThreadPool, ThreadCapability,
    format_human_bytes,
};
use serde_json::{Map as JsonMap, Value as JsonValue};

const IPS_MAGIC: &[u8; 5] = b"PATCH";
const IPS_EOF: &[u8; 3] = b"EOF";
const IPS32_MAGIC: &[u8; 5] = b"IPS32";
const IPS32_EOF: &[u8; 4] = b"EEOF";
const COMPARE_BUFFER_SIZE: usize = 64 * 1024;
const OUTPUT_CHUNK_SIZE: u64 = 2 * 1024 * 1024;
const CREATE_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_IPS_RECORD_LEN: usize = u16::MAX as usize;
const MAX_IPS_OFFSET: u64 = 0x00FF_FFFF;
const MAX_IPS32_OFFSET: u64 = 0xFFFF_FFFF;
const MIN_RLE_RECORD_LEN: usize = 4;
const IPS_RESERVED_EOF_OFFSET: u64 = 0x45_4F_46;
const IPS32_RESERVED_EOF_OFFSET: u64 = 0x45_45_4F_46;
const UNCHANGED_GAP_COALESCE_LIMIT: usize = 5;
const RLE_SPLIT_EDGE_THRESHOLD: usize = 8;
const RLE_SPLIT_MIDDLE_THRESHOLD: usize = 13;
const DEFAULT_EBP_METADATA_JSON: &str = r#"{"patcher":"EBPatcher","Author":"Unknown","Description":"No description","Title":"Untitled"}"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IpsFlavor {
    Ips,
    Ips32,
    Ebp,
}

impl IpsFlavor {
    const fn header(self) -> &'static [u8] {
        match self {
            Self::Ips | Self::Ebp => IPS_MAGIC,
            Self::Ips32 => IPS32_MAGIC,
        }
    }

    const fn footer(self) -> &'static [u8] {
        match self {
            Self::Ips | Self::Ebp => IPS_EOF,
            Self::Ips32 => IPS32_EOF,
        }
    }

    const fn offset_len(self) -> usize {
        match self {
            Self::Ips | Self::Ebp => 3,
            Self::Ips32 => 4,
        }
    }

    const fn reserved_eof_offset(self) -> u64 {
        match self {
            Self::Ips | Self::Ebp => IPS_RESERVED_EOF_OFFSET,
            Self::Ips32 => IPS32_RESERVED_EOF_OFFSET,
        }
    }
}

pub struct IpsPatchHandler {
    descriptor: &'static FormatDescriptor,
    flavor: IpsFlavor,
}

impl IpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self {
            descriptor,
            flavor: IpsFlavor::Ips,
        }
    }

    pub const fn new_ebp(descriptor: &'static FormatDescriptor) -> Self {
        Self {
            descriptor,
            flavor: IpsFlavor::Ebp,
        }
    }

    pub const fn new_ips32(descriptor: &'static FormatDescriptor) -> Self {
        Self {
            descriptor,
            flavor: IpsFlavor::Ips32,
        }
    }
}

impl PatchHandler for IpsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_ips_file(patch_path, self.flavor, context.patch_checksum_validation())?;
        let label = parse_label(self.descriptor.name, &patch);

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
        let patch = parse_ips_file(patch_path, self.flavor, context.patch_checksum_validation())?;
        let input_len = fs::metadata(&request.input)?.len();
        let output_size = patch.resolved_output_size(input_len);
        let max_parallel_chunks = max_parallel_chunks(output_size)?;
        let thread_capability = ThreadCapability::parallel(Some(max_parallel_chunks));
        let planned_execution = context.plan_threads(thread_capability.clone());
        let tasks = build_chunk_tasks(&patch, output_size, context)?;

        let (execution, render_result) = if planned_execution.used_parallelism
            && !crate::patches_reads_source_on_main_thread()
        {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let render_result = pool.install(|| {
                tasks
                    .par_iter()
                    .map(|task| render_chunk_task(task, &request.input, input_len, &patch, context))
                    .collect::<Result<Vec<_>>>()
            });
            (execution, render_result)
        } else {
            let render_result = tasks
                .iter()
                .map(|task| render_chunk_task(task, &request.input, input_len, &patch, context))
                .collect::<Result<Vec<_>>>();
            (planned_execution, render_result)
        };

        let rendered_chunks_changed = match render_result {
            Ok(changed) => changed.into_iter().any(|changed| changed),
            Err(error) => {
                cleanup_chunk_files(&tasks);
                return Err(error);
            }
        };

        let assemble_result = assemble_output(&request.output, &tasks, context);
        cleanup_chunk_files(&tasks);
        assemble_result?;
        let did_change = output_size != input_len || rendered_chunks_changed;
        let warnings =
            ips_apply_warning_labels(self.descriptor.name, &patch, input_len, did_change);

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            append_warning_labels(
                format!(
                    "applied {} patch with {} record(s)",
                    self.descriptor.name,
                    patch.records.len()
                ),
                &warnings,
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
        validate_ips_create_flips_limits(
            original_len,
            modified_len,
            self.flavor,
            context.patch_checksum_validation(),
        )?;
        let thread_capability = ips_create_thread_capability(modified_len)?;
        let planned_execution = context.plan_threads(thread_capability.clone());

        let mut output = crate::create_buffered_output(&request.output)?;
        let (execution, create_result) = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let create_result = create_ips_patch_parallel(
                crate::PatchCreateSources {
                    original_path: &request.original,
                    original_len,
                    modified_path: &request.modified,
                    modified_len,
                },
                &pool,
                &mut output,
                context,
                self.flavor,
            )?;
            (execution, create_result)
        } else {
            let create_result = create_ips_patch_streaming(
                &request.original,
                original_len,
                &request.modified,
                modified_len,
                &mut output,
                context,
                self.flavor,
            )?;
            (planned_execution, create_result)
        };
        output.flush()?;
        let warnings = ips_create_warning_labels(
            self.descriptor.name,
            original_len,
            modified_len,
            &create_result,
        );

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            append_warning_labels(
                format!(
                    "created {} patch with {} record(s)",
                    self.descriptor.name, create_result.record_count
                ),
                &warnings,
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
    }
}

#[derive(Debug)]
struct ParsedIpsPatch {
    truncate_size: Option<u64>,
    metadata: Option<JsonMap<String, JsonValue>>,
    warnings: Vec<String>,
    max_written_end: u64,
    records: Vec<IpsRecord>,
}

impl ParsedIpsPatch {
    fn resolved_output_size(&self, input_len: u64) -> u64 {
        let output_size = input_len.max(self.max_written_end);
        self.truncate_size
            .map_or(output_size, |truncate_size| output_size.min(truncate_size))
    }
}

#[derive(Debug)]
struct IpsRecord {
    offset: u64,
    len: u64,
    data: IpsRecordData,
}

impl IpsRecord {
    fn end(&self) -> Result<u64> {
        checked_add(self.offset, self.len, "IPS record end")
    }
}

#[derive(Debug)]
enum IpsRecordData {
    Literal(Vec<u8>),
    Rle { byte: u8 },
}

#[derive(Debug)]
struct ChunkTask {
    chunk: FileChunk,
    temp_path: PathBuf,
    record_indexes: Vec<usize>,
}

#[derive(Debug, Default)]
struct IpsCreateResult {
    record_count: usize,
    max_written_end: u64,
}

#[derive(Debug)]
struct PendingDiff {
    start_offset: u64,
    bytes: Vec<u8>,
    trailing_unchanged: usize,
}

#[derive(Debug)]
struct IpsDiffRun {
    offset: u64,
    bytes: Vec<u8>,
}

impl IpsDiffRun {
    fn end(&self) -> Result<u64> {
        self.offset
            .checked_add(self.bytes.len() as u64)
            .ok_or_else(|| RomWeaverError::Validation("IPS diff run offset overflowed".into()))
    }
}

fn parse_ips_file(
    path: &Path,
    flavor: IpsFlavor,
    validation: PatchChecksumValidation,
) -> Result<ParsedIpsPatch> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let min_len = (flavor.header().len() + flavor.footer().len()) as u64;
    if file_len < min_len {
        return Err(RomWeaverError::Validation(
            "IPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let mut parser = IpsFileParser::new(BufReader::new(file), file_len);
    if parser.read_exact(flavor.header().len())?.as_slice() != flavor.header() {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let mut records = Vec::new();
    let mut warnings = Vec::new();
    let mut max_written_end = 0u64;

    loop {
        let marker = parser.read_exact(flavor.footer().len())?;
        if marker.as_slice() == flavor.footer() {
            let trailing_len = parser.remaining()?;
            let (truncate_size, metadata) = match flavor {
                IpsFlavor::Ips => match trailing_len {
                    0 => (None, None),
                    3 => (Some(u64::from(parser.read_u24()?)), None),
                    _ => {
                        handle_unexpected_ips_trailing_bytes(
                            trailing_len,
                            validation,
                            &mut warnings,
                        )?;
                        (None, None)
                    }
                },
                IpsFlavor::Ips32 => match trailing_len {
                    0 => (None, None),
                    _ => {
                        return Err(RomWeaverError::Validation(
                            "IPS32 patch contained unexpected trailing data after EEOF".into(),
                        ));
                    }
                },
                IpsFlavor::Ebp => match trailing_len {
                    0 => (None, None),
                    _ => {
                        let trailing_len = usize::try_from(trailing_len).map_err(|_| {
                            RomWeaverError::Validation(
                                "EBP metadata exceeded addressable memory".into(),
                            )
                        })?;
                        let metadata =
                            parse_ebp_metadata(parser.read_exact(trailing_len)?.as_slice())?;
                        (None, Some(metadata))
                    }
                },
            };

            warn_if_records_exceed_truncate_size(truncate_size, max_written_end, &mut warnings);

            return Ok(ParsedIpsPatch {
                truncate_size,
                metadata,
                warnings,
                max_written_end,
                records,
            });
        }

        let offset = match flavor.offset_len() {
            3 => u64::from(read_u24(&marker)),
            4 => u64::from(read_u32(&marker)),
            _ => unreachable!("unsupported offset length"),
        };
        let size = parser.read_u16()?;
        let (len, data) = if size == 0 {
            let rle_len = u64::from(parser.read_u16()?);
            let byte = parser.read_exact(1)?[0];
            if rle_len == 0 {
                handle_zero_length_rle_record(offset, validation, &mut warnings)?;
                continue;
            }
            (rle_len, IpsRecordData::Rle { byte })
        } else {
            let data = parser.read_exact(usize::from(size))?;
            (u64::from(size), IpsRecordData::Literal(data))
        };

        let end = checked_add(offset, len, "IPS record end")?;
        max_written_end = max(max_written_end, end);
        records.push(IpsRecord { offset, len, data });
    }
}

#[cfg(test)]
fn parse_ips_bytes(bytes: &[u8], flavor: IpsFlavor) -> Result<ParsedIpsPatch> {
    parse_ips_bytes_with_validation(bytes, flavor, PatchChecksumValidation::Strict)
}

#[cfg(test)]
fn parse_ips_bytes_with_validation(
    bytes: &[u8],
    flavor: IpsFlavor,
    validation: PatchChecksumValidation,
) -> Result<ParsedIpsPatch> {
    if bytes.len() < flavor.header().len() + flavor.footer().len() {
        return Err(RomWeaverError::Validation(
            "IPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let mut parser = IpsParser::new(bytes);
    if parser.read_exact(flavor.header().len())? != flavor.header() {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let mut records = Vec::new();
    let mut warnings = Vec::new();
    let mut max_written_end = 0u64;

    loop {
        let marker = parser.read_exact(flavor.footer().len())?;
        if marker == flavor.footer() {
            let (truncate_size, metadata) = match flavor {
                IpsFlavor::Ips => match parser.remaining() {
                    0 => (None, None),
                    3 => (Some(u64::from(parser.read_u24()?)), None),
                    trailing_len => {
                        handle_unexpected_ips_trailing_bytes(
                            trailing_len as u64,
                            validation,
                            &mut warnings,
                        )?;
                        (None, None)
                    }
                },
                IpsFlavor::Ips32 => match parser.remaining() {
                    0 => (None, None),
                    _ => {
                        return Err(RomWeaverError::Validation(
                            "IPS32 patch contained unexpected trailing data after EEOF".into(),
                        ));
                    }
                },
                IpsFlavor::Ebp => match parser.remaining() {
                    0 => (None, None),
                    _ => {
                        let metadata = parse_ebp_metadata(parser.read_exact(parser.remaining())?)?;
                        (None, Some(metadata))
                    }
                },
            };

            warn_if_records_exceed_truncate_size(truncate_size, max_written_end, &mut warnings);

            return Ok(ParsedIpsPatch {
                truncate_size,
                metadata,
                warnings,
                max_written_end,
                records,
            });
        }

        let offset = match flavor.offset_len() {
            3 => u64::from(read_u24(marker)),
            4 => u64::from(read_u32(marker)),
            _ => unreachable!("unsupported offset length"),
        };
        let size = parser.read_u16()?;
        let (len, data) = if size == 0 {
            let rle_len = u64::from(parser.read_u16()?);
            let byte = parser.read_exact(1)?[0];
            if rle_len == 0 {
                handle_zero_length_rle_record(offset, validation, &mut warnings)?;
                continue;
            }
            (rle_len, IpsRecordData::Rle { byte })
        } else {
            let data = parser.read_exact(usize::from(size))?.to_vec();
            (u64::from(size), IpsRecordData::Literal(data))
        };

        let end = checked_add(offset, len, "IPS record end")?;
        max_written_end = max(max_written_end, end);
        records.push(IpsRecord { offset, len, data });
    }
}

fn parse_label(format_name: &str, patch: &ParsedIpsPatch) -> String {
    let mut label = format!(
        "parsed {format_name} patch with {} record(s)",
        patch.records.len()
    );
    if let Some(size) = patch.truncate_size {
        label.push_str(&format!(" and output size {size}"));
    }
    if patch.metadata.is_some() {
        label.push_str(" and metadata");
    }
    append_warning_labels(label, &patch.warnings)
}

fn handle_unexpected_ips_trailing_bytes(
    trailing_len: u64,
    validation: PatchChecksumValidation,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let message = format!("{trailing_len} trailing byte(s) after EOF in IPS patch");
    if validation == PatchChecksumValidation::Strict {
        return Err(RomWeaverError::Validation(format!(
            "IPS patch contained unexpected {message}"
        )));
    }

    warnings.push(format!("ignored {message}"));
    Ok(())
}

fn handle_zero_length_rle_record(
    offset: u64,
    validation: PatchChecksumValidation,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let message = format!("zero-length IPS RLE record at offset {offset}");
    if validation == PatchChecksumValidation::Strict {
        return Err(RomWeaverError::Validation(format!(
            "IPS patch contained invalid {message}"
        )));
    }

    warnings.push(format!("ignored {message}"));
    Ok(())
}

fn warn_if_records_exceed_truncate_size(
    truncate_size: Option<u64>,
    max_written_end: u64,
    warnings: &mut Vec<String>,
) {
    if let Some(size) = truncate_size
        && max_written_end > size
    {
        warnings.push(format!(
            "IPS patch appears scrambled or malformed; records extend past truncate size {size}"
        ));
    }
}

fn ips_apply_warning_labels(
    format_name: &str,
    patch: &ParsedIpsPatch,
    input_len: u64,
    did_change: bool,
) -> Vec<String> {
    let mut warnings = patch.warnings.clone();
    if !did_change {
        warnings.push(format!(
            "{format_name} patch did not change output; input may already be patched"
        ));
    } else if patch
        .truncate_size
        .is_some_and(|truncate_size| input_len <= truncate_size)
    {
        warnings.push(format!(
            "{format_name} patch truncate footer was not needed; patch may not be intended for this input"
        ));
    }
    warnings
}

fn ips_create_warning_labels(
    format_name: &str,
    original_len: u64,
    modified_len: u64,
    create_result: &IpsCreateResult,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if create_result.record_count == 0 && original_len == modified_len {
        warnings.push(format!(
            "{format_name} patch will not change output; inputs are identical"
        ));
    }
    if original_len > modified_len {
        warnings.push(format!(
            "{format_name} create input is larger than modified output; double check file order"
        ));
    }
    warnings
}

fn validate_ips_create_flips_limits(
    original_len: u64,
    modified_len: u64,
    flavor: IpsFlavor,
    validation: PatchChecksumValidation,
) -> Result<()> {
    if flavor != IpsFlavor::Ips || validation != PatchChecksumValidation::Strict {
        return Ok(());
    }

    let max_ips_len = MAX_IPS_OFFSET + 1;
    if modified_len > max_ips_len {
        let limit = format_human_bytes(max_ips_len);
        return Err(RomWeaverError::Validation(format!(
            "IPS create target size {modified_len} exceeds the Flips-compatible {limit} limit; use IPS32 or --ignore-checksum-validation to try a non-Flips-compatible IPS patch"
        )));
    }

    if modified_len == max_ips_len && original_len > modified_len {
        let limit = format_human_bytes(max_ips_len);
        return Err(RomWeaverError::Validation(format!(
            "IPS create cannot encode a truncate footer for exact {limit} output; use IPS32 or --ignore-checksum-validation to try a non-Flips-compatible IPS patch"
        )));
    }

    Ok(())
}

fn append_warning_labels(mut label: String, warnings: &[String]) -> String {
    for warning in warnings {
        label.push_str("; warning=");
        label.push_str(warning);
    }
    label
}

fn parse_ebp_metadata(bytes: &[u8]) -> Result<JsonMap<String, JsonValue>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| RomWeaverError::Validation("EBP metadata is not valid UTF-8 JSON".into()))?;
    let value: JsonValue = serde_json::from_str(text)
        .map_err(|_| RomWeaverError::Validation("EBP metadata is not valid JSON".into()))?;
    let object = value
        .as_object()
        .ok_or_else(|| RomWeaverError::Validation("EBP metadata must be a JSON object".into()))?;
    for (key, value) in object {
        if !value.is_string() {
            return Err(RomWeaverError::Validation(format!(
                "EBP metadata value for `{key}` must be a string"
            )));
        }
    }
    Ok(object.clone())
}

fn max_parallel_chunks(output_size: u64) -> Result<usize> {
    let chunk_count = if output_size == 0 {
        1
    } else {
        output_size.div_ceil(OUTPUT_CHUNK_SIZE)
    };
    usize::try_from(chunk_count).map_err(|_| {
        RomWeaverError::Validation(
            "IPS output required more chunks than this platform can index".into(),
        )
    })
}

fn ips_create_chunk_count(modified_len: u64) -> Result<usize> {
    if modified_len == 0 {
        return Ok(1);
    }
    let chunk_bytes = CREATE_SCAN_CHUNK_BYTES as u64;
    let chunk_count = modified_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).map_err(|_| {
        RomWeaverError::Validation(
            "IPS create required more chunks than this platform can index".into(),
        )
    })
}

fn ips_create_thread_capability(modified_len: u64) -> Result<ThreadCapability> {
    let chunk_count = ips_create_chunk_count(modified_len)?;
    Ok(ThreadCapability::parallel(Some(chunk_count.max(1))))
}

fn create_ips_patch_streaming(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    output: &mut impl Write,
    context: &OperationContext,
    flavor: IpsFlavor,
) -> Result<IpsCreateResult> {
    let mut original = BufReader::new(File::open(original_path)?);
    let mut modified = BufReader::new(File::open(modified_path)?);
    let mut original_buffer = vec![0u8; COMPARE_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; COMPARE_BUFFER_SIZE];
    let mut pending = None;
    let mut created = IpsCreateResult::default();
    let mut offset = 0u64;
    let mut previous_modified_byte = None;

    output.write_all(flavor.header())?;

    while offset < modified_len {
        context.cancel().check()?;

        let chunk_len = usize::try_from((modified_len - offset).min(COMPARE_BUFFER_SIZE as u64))
            .map_err(|_| {
                RomWeaverError::Validation("IPS compare chunk exceeded addressable memory".into())
            })?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        let original_bytes = if offset >= original_len {
            0
        } else {
            usize::try_from((original_len - offset).min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("IPS original chunk exceeded addressable memory".into())
            })?
        };
        if original_bytes > 0 {
            original.read_exact(&mut original_buffer[..original_bytes])?;
        }
        if original_bytes < chunk_len {
            original_buffer[original_bytes..chunk_len].fill(0);
        }

        for index in 0..chunk_len {
            let original_byte = original_buffer[index];
            let modified_byte = modified_buffer[index];
            if offset < original_len && original_byte == modified_byte {
                push_unchanged_byte(&mut pending, modified_byte, output, &mut created, flavor)?;
            } else {
                push_changed_byte(
                    &mut pending,
                    offset,
                    modified_byte,
                    previous_modified_byte,
                    output,
                    &mut created,
                    flavor,
                )?;
            }
            previous_modified_byte = Some(modified_byte);
            offset += 1;
        }
    }

    flush_pending_diff(&mut pending, output, &mut created, flavor)?;
    output.write_all(flavor.footer())?;

    match flavor {
        IpsFlavor::Ips => {
            if truncate_size_required(original_len, modified_len) {
                write_u24(output, modified_len, "IPS truncate size")?;
            }
        }
        IpsFlavor::Ips32 => {}
        IpsFlavor::Ebp => {
            output.write_all(DEFAULT_EBP_METADATA_JSON.as_bytes())?;
        }
    }

    Ok(created)
}

fn create_ips_patch_parallel(
    sources: crate::PatchCreateSources,
    pool: &SharedThreadPool,
    output: &mut impl Write,
    context: &OperationContext,
    flavor: IpsFlavor,
) -> Result<IpsCreateResult> {
    let crate::PatchCreateSources {
        original_path,
        original_len,
        modified_path,
        modified_len,
    } = sources;
    let combined_bytes = original_len.saturating_add(modified_len);
    if crate::create_exceeds_main_thread_cap(combined_bytes) {
        tracing::info!(
            combined_bytes,
            cap = crate::IN_MEMORY_APPLY_LIMIT_BYTES,
            "IPS parallel create: combined size exceeds cap, falling back to streaming"
        );
        return create_ips_patch_streaming(
            original_path,
            original_len,
            modified_path,
            modified_len,
            output,
            context,
            flavor,
        );
    }
    if crate::patches_reads_source_on_main_thread() {
        let chunk_count = ips_create_chunk_count(modified_len)?;
        let chunk_pairs = (0..chunk_count)
            .map(|chunk_index| {
                let start = (chunk_index as u64) * (CREATE_SCAN_CHUNK_BYTES as u64);
                let end = start
                    .saturating_add(CREATE_SCAN_CHUNK_BYTES as u64)
                    .min(modified_len);
                crate::read_original_modified_chunk(
                    original_path,
                    original_len,
                    modified_path,
                    start,
                    end,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let chunk_runs = pool.install(|| {
            chunk_pairs
                .into_par_iter()
                .enumerate()
                .map(|(chunk_index, (original_bytes, modified_bytes))| {
                    let start = (chunk_index as u64) * (CREATE_SCAN_CHUNK_BYTES as u64);
                    collect_ips_diff_runs_from_bytes(
                        start,
                        &original_bytes,
                        &modified_bytes,
                        original_len,
                    )
                })
                .collect::<Result<Vec<_>>>()
        })?;
        let runs = merge_ips_diff_runs(chunk_runs)?;
        let runs = coalesce_ips_diff_runs(runs, modified_path, flavor)?;
        return write_ips_runs_to_output(runs, original_len, modified_len, output, flavor);
    }

    let chunk_count = ips_create_chunk_count(modified_len)?;
    let chunk_runs = pool.install(|| {
        (0..chunk_count)
            .into_par_iter()
            .map(|chunk_index| {
                context.cancel().check()?;
                collect_ips_diff_runs_for_chunk(
                    chunk_index,
                    original_path,
                    original_len,
                    modified_path,
                    modified_len,
                )
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let runs = merge_ips_diff_runs(chunk_runs)?;
    let runs = coalesce_ips_diff_runs(runs, modified_path, flavor)?;
    write_ips_runs_to_output(runs, original_len, modified_len, output, flavor)
}

fn write_ips_runs_to_output(
    runs: Vec<IpsDiffRun>,
    original_len: u64,
    modified_len: u64,
    output: &mut impl Write,
    flavor: IpsFlavor,
) -> Result<IpsCreateResult> {
    let mut created = IpsCreateResult::default();
    output.write_all(flavor.header())?;
    for run in &runs {
        write_diff_run_records(output, run, &mut created, flavor)?;
    }
    output.write_all(flavor.footer())?;

    match flavor {
        IpsFlavor::Ips => {
            if truncate_size_required(original_len, modified_len) {
                write_u24(output, modified_len, "IPS truncate size")?;
            }
        }
        IpsFlavor::Ips32 => {}
        IpsFlavor::Ebp => {
            output.write_all(DEFAULT_EBP_METADATA_JSON.as_bytes())?;
        }
    }

    Ok(created)
}

fn collect_ips_diff_runs_for_chunk(
    chunk_index: usize,
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
) -> Result<Vec<IpsDiffRun>> {
    let start = u64::try_from(chunk_index)
        .ok()
        .and_then(|index| index.checked_mul(CREATE_SCAN_CHUNK_BYTES as u64))
        .ok_or_else(|| RomWeaverError::Validation("IPS create chunk offset overflowed".into()))?;
    if start >= modified_len {
        return Ok(Vec::new());
    }
    let end = start
        .saturating_add(CREATE_SCAN_CHUNK_BYTES as u64)
        .min(modified_len);
    let mut original = File::open(original_path)?;
    let mut modified = File::open(modified_path)?;
    if start < original_len {
        original.seek(SeekFrom::Start(start))?;
    }
    modified.seek(SeekFrom::Start(start))?;

    let mut original_buffer = vec![0u8; COMPARE_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; COMPARE_BUFFER_SIZE];
    let mut runs = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_bytes = Vec::<u8>::new();
    let mut cursor = start;

    while cursor < end {
        let chunk_len =
            usize::try_from((end - cursor).min(COMPARE_BUFFER_SIZE as u64)).map_err(|_| {
                RomWeaverError::Validation("IPS compare chunk exceeded addressable memory".into())
            })?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        let original_chunk_len = if cursor >= original_len {
            0
        } else {
            usize::try_from((original_len - cursor).min(chunk_len as u64)).map_err(|_| {
                RomWeaverError::Validation("IPS original chunk exceeded addressable memory".into())
            })?
        };
        if original_chunk_len > 0 {
            original.read_exact(&mut original_buffer[..original_chunk_len])?;
        }
        if original_chunk_len < chunk_len {
            original_buffer[original_chunk_len..chunk_len].fill(0);
        }

        for index in 0..chunk_len {
            let source = original_buffer[index];
            let target = modified_buffer[index];
            if cursor < original_len && source == target {
                if !pending_bytes.is_empty() {
                    runs.push(IpsDiffRun {
                        offset: pending_start.expect("pending start exists"),
                        bytes: std::mem::take(&mut pending_bytes),
                    });
                    pending_start = None;
                }
            } else {
                if pending_start.is_none() {
                    pending_start = Some(cursor);
                }
                pending_bytes.push(target);
            }
            cursor = checked_add(cursor, 1, "IPS create scan offset")?;
        }
    }

    if !pending_bytes.is_empty() {
        runs.push(IpsDiffRun {
            offset: pending_start.expect("pending start exists"),
            bytes: pending_bytes,
        });
    }

    Ok(runs)
}

fn collect_ips_diff_runs_from_bytes(
    start: u64,
    original_bytes: &[u8],
    modified_bytes: &[u8],
    original_len: u64,
) -> Result<Vec<IpsDiffRun>> {
    let mut runs = Vec::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_bytes = Vec::<u8>::new();

    for index in 0..modified_bytes.len() {
        let cursor = checked_add(start, index as u64, "IPS create scan offset")?;
        let source = original_bytes[index];
        let target = modified_bytes[index];
        if cursor < original_len && source == target {
            if !pending_bytes.is_empty() {
                runs.push(IpsDiffRun {
                    offset: pending_start.expect("pending start exists"),
                    bytes: std::mem::take(&mut pending_bytes),
                });
                pending_start = None;
            }
        } else {
            if pending_start.is_none() {
                pending_start = Some(cursor);
            }
            pending_bytes.push(target);
        }
    }

    if !pending_bytes.is_empty() {
        runs.push(IpsDiffRun {
            offset: pending_start.expect("pending start exists"),
            bytes: pending_bytes,
        });
    }

    Ok(runs)
}

fn merge_ips_diff_runs(chunk_runs: Vec<Vec<IpsDiffRun>>) -> Result<Vec<IpsDiffRun>> {
    let mut merged = Vec::<IpsDiffRun>::new();
    for runs in chunk_runs {
        for run in runs {
            if let Some(last) = merged.last_mut()
                && last.end()? == run.offset
            {
                last.bytes.extend_from_slice(&run.bytes);
                continue;
            }
            merged.push(run);
        }
    }
    Ok(merged)
}

fn coalesce_ips_diff_runs(
    runs: Vec<IpsDiffRun>,
    modified_path: &Path,
    flavor: IpsFlavor,
) -> Result<Vec<IpsDiffRun>> {
    let mut modified = File::open(modified_path)?;
    let mut coalesced = Vec::<IpsDiffRun>::new();
    let mut current: Option<IpsDiffRun> = None;

    for run in runs {
        let run = protect_reserved_run_start(run, &mut modified, flavor)?;
        let Some(active) = current.as_mut() else {
            current = Some(run);
            continue;
        };

        let active_end = active.end()?;
        if run.offset < active_end {
            return Err(RomWeaverError::Validation(
                "IPS create produced overlapping diff runs".into(),
            ));
        }

        let gap_len = usize::try_from(run.offset - active_end).map_err(|_| {
            RomWeaverError::Validation("IPS diff run gap exceeded addressable memory".into())
        })?;
        let merged_len = active
            .bytes
            .len()
            .checked_add(gap_len)
            .and_then(|len| len.checked_add(run.bytes.len()))
            .ok_or_else(|| {
                RomWeaverError::Validation("IPS coalesced diff run length overflowed".into())
            })?;

        if gap_len <= UNCHANGED_GAP_COALESCE_LIMIT && merged_len <= MAX_IPS_RECORD_LEN {
            if gap_len > 0 {
                let mut gap = vec![0u8; gap_len];
                modified.seek(SeekFrom::Start(active_end))?;
                modified.read_exact(&mut gap)?;
                active.bytes.extend_from_slice(&gap);
            }
            active.bytes.extend_from_slice(&run.bytes);
        } else {
            coalesced.push(current.take().expect("active run exists"));
            current = Some(run);
        }
    }

    if let Some(run) = current {
        coalesced.push(run);
    }
    Ok(coalesced)
}

fn protect_reserved_run_start(
    mut run: IpsDiffRun,
    modified: &mut File,
    flavor: IpsFlavor,
) -> Result<IpsDiffRun> {
    let reserved = flavor.reserved_eof_offset();
    if run.offset != reserved {
        return Ok(run);
    }

    let previous_offset = reserved
        .checked_sub(1)
        .ok_or_else(|| RomWeaverError::Validation("IPS reserved EOF offset underflowed".into()))?;
    modified.seek(SeekFrom::Start(previous_offset))?;
    let mut previous_byte = [0u8; 1];
    modified.read_exact(&mut previous_byte)?;
    run.offset = previous_offset;
    run.bytes.insert(0, previous_byte[0]);
    Ok(run)
}

fn write_diff_run_records(
    output: &mut impl Write,
    run: &IpsDiffRun,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    let mut cursor = 0usize;
    while cursor < run.bytes.len() {
        let segment_offset = checked_add(run.offset, cursor as u64, "IPS diff segment offset")?;
        let remaining_len = run.bytes.len() - cursor;
        let desired_len = remaining_len.min(MAX_IPS_RECORD_LEN);
        let window_len = adjust_record_len_for_reserved_offset(
            segment_offset,
            desired_len,
            remaining_len,
            remaining_len > desired_len,
            flavor,
        )?;
        write_optimized_record_window(
            output,
            segment_offset,
            &run.bytes[cursor..cursor + window_len],
            created,
            flavor,
        )?;
        cursor += window_len;
    }
    Ok(())
}

fn write_optimized_record_window(
    output: &mut impl Write,
    offset: u64,
    bytes: &[u8],
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let record_offset = checked_add(offset, cursor as u64, "IPS optimized record offset")?;
        let remaining = &bytes[cursor..];
        let repeat_len = repeated_prefix_len(remaining);

        if repeat_len >= MIN_RLE_RECORD_LEN
            && (repeat_len == remaining.len() || repeat_len > RLE_SPLIT_EDGE_THRESHOLD)
        {
            let len = adjust_record_len_for_reserved_offset(
                record_offset,
                repeat_len,
                repeat_len,
                repeat_len < remaining.len(),
                flavor,
            )?;
            write_rle_record(output, record_offset, len, remaining[0], created, flavor)?;
            cursor += len;
            continue;
        }

        let literal_len = find_next_rle_split(remaining)
            .map(|(index, _len)| index)
            .unwrap_or(remaining.len());
        let literal_len = if literal_len == 0 {
            remaining.len().min(RLE_SPLIT_EDGE_THRESHOLD)
        } else {
            literal_len
        };
        let len = adjust_record_len_for_reserved_offset(
            record_offset,
            literal_len,
            remaining.len(),
            literal_len < remaining.len(),
            flavor,
        )?;
        write_literal_record(output, record_offset, &remaining[..len], created, flavor)?;
        cursor += len;
    }
    Ok(())
}

fn find_next_rle_split(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0usize;
    while index < bytes.len() {
        let len = repeated_prefix_len(&bytes[index..]);
        if len >= MIN_RLE_RECORD_LEN {
            let at_start = index == 0;
            let at_end = index + len == bytes.len();
            let worthwhile = if at_start || at_end {
                len > RLE_SPLIT_EDGE_THRESHOLD || len == bytes.len()
            } else {
                len > RLE_SPLIT_MIDDLE_THRESHOLD
            };
            if worthwhile {
                return Some((index, len));
            }
        }
        index += len.max(1);
    }
    None
}

fn repeated_prefix_len(bytes: &[u8]) -> usize {
    let Some((&first, rest)) = bytes.split_first() else {
        return 0;
    };
    1 + rest.iter().take_while(|byte| **byte == first).count()
}

fn adjust_record_len_for_reserved_offset(
    offset: u64,
    desired_len: usize,
    available_len: usize,
    more_after: bool,
    flavor: IpsFlavor,
) -> Result<usize> {
    if desired_len == 0 {
        return Ok(0);
    }
    if offset == flavor.reserved_eof_offset() {
        return Err(RomWeaverError::Validation(format!(
            "{} record offset matched its EOF marker",
            flavor_name(flavor)
        )));
    }

    let end = checked_add(offset, desired_len as u64, "IPS record end")?;
    if more_after && end == flavor.reserved_eof_offset() {
        if desired_len > 1 {
            return Ok(desired_len - 1);
        }
        if available_len > desired_len && desired_len < MAX_IPS_RECORD_LEN {
            return Ok(desired_len + 1);
        }
        return Err(RomWeaverError::Validation(format!(
            "{} record split would create an EOF-marker offset",
            flavor_name(flavor)
        )));
    }

    Ok(desired_len)
}

const fn flavor_name(flavor: IpsFlavor) -> &'static str {
    match flavor {
        IpsFlavor::Ips => "IPS",
        IpsFlavor::Ips32 => "IPS32",
        IpsFlavor::Ebp => "EBP",
    }
}

fn push_changed_byte(
    pending: &mut Option<PendingDiff>,
    offset: u64,
    modified_byte: u8,
    previous_modified_byte: Option<u8>,
    output: &mut impl Write,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    if pending
        .as_ref()
        .is_some_and(|diff| diff.bytes.len() == MAX_IPS_RECORD_LEN)
    {
        flush_pending_diff(pending, output, created, flavor)?;
    }

    if pending.is_none() {
        *pending = Some(start_pending_diff(offset, previous_modified_byte, flavor)?);
    }

    let diff = pending.as_mut().expect("pending diff exists");
    diff.bytes.push(modified_byte);
    diff.trailing_unchanged = 0;
    Ok(())
}

fn push_unchanged_byte(
    pending: &mut Option<PendingDiff>,
    modified_byte: u8,
    output: &mut impl Write,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    let Some(diff) = pending.as_mut() else {
        return Ok(());
    };

    if diff.bytes.len() == MAX_IPS_RECORD_LEN {
        flush_pending_diff(pending, output, created, flavor)?;
        return Ok(());
    }

    diff.bytes.push(modified_byte);
    diff.trailing_unchanged += 1;
    if diff.trailing_unchanged > UNCHANGED_GAP_COALESCE_LIMIT {
        flush_pending_diff(pending, output, created, flavor)?;
    }
    Ok(())
}

fn start_pending_diff(
    offset: u64,
    previous_modified_byte: Option<u8>,
    flavor: IpsFlavor,
) -> Result<PendingDiff> {
    if offset == flavor.reserved_eof_offset() {
        let previous_offset = offset.checked_sub(1).ok_or_else(|| {
            RomWeaverError::Validation("IPS reserved EOF offset underflowed".into())
        })?;
        let previous_byte = previous_modified_byte.ok_or_else(|| {
            RomWeaverError::Validation(
                "IPS reserved EOF offset did not have a preceding target byte".into(),
            )
        })?;
        return Ok(PendingDiff {
            start_offset: previous_offset,
            bytes: vec![previous_byte],
            trailing_unchanged: 0,
        });
    }

    Ok(PendingDiff {
        start_offset: offset,
        bytes: Vec::with_capacity(MAX_IPS_RECORD_LEN),
        trailing_unchanged: 0,
    })
}

fn flush_pending_diff(
    pending: &mut Option<PendingDiff>,
    output: &mut impl Write,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    let Some(mut diff) = pending.take() else {
        return Ok(());
    };
    trim_pending_trailing_unchanged(&mut diff);
    write_pending_diff(output, diff, created, flavor)
}

fn trim_pending_trailing_unchanged(diff: &mut PendingDiff) {
    if diff.trailing_unchanged == 0 {
        return;
    }

    let trimmed_len = diff.bytes.len().saturating_sub(diff.trailing_unchanged);
    diff.bytes.truncate(trimmed_len);
    diff.trailing_unchanged = 0;
}

fn write_pending_diff(
    output: &mut impl Write,
    diff: PendingDiff,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    if diff.bytes.is_empty() {
        return Ok(());
    }

    write_diff_run_records(
        output,
        &IpsDiffRun {
            offset: diff.start_offset,
            bytes: diff.bytes,
        },
        created,
        flavor,
    )
}

fn write_literal_record(
    output: &mut impl Write,
    offset: u64,
    data: &[u8],
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    if data.is_empty() {
        return Ok(());
    }

    if data.len() > MAX_IPS_RECORD_LEN {
        return Err(RomWeaverError::Validation(
            "IPS literal record exceeded maximum encodable length".into(),
        ));
    }

    write_offset(output, offset, flavor)?;
    let data_len = u16::try_from(data.len()).map_err(|_| {
        RomWeaverError::Validation("IPS literal record length exceeded encodable range".into())
    })?;
    output.write_all(&data_len.to_be_bytes())?;
    output.write_all(data)?;

    created.record_count += 1;
    created.max_written_end = max(
        created.max_written_end,
        checked_add(offset, data.len() as u64, "IPS literal record end")?,
    );
    Ok(())
}

fn write_rle_record(
    output: &mut impl Write,
    offset: u64,
    len: usize,
    byte: u8,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    if len == 0 {
        return Ok(());
    }
    if len > MAX_IPS_RECORD_LEN {
        return Err(RomWeaverError::Validation(
            "IPS RLE record exceeded maximum encodable length".into(),
        ));
    }

    write_offset(output, offset, flavor)?;
    output.write_all(&0u16.to_be_bytes())?;
    let rle_len = u16::try_from(len).map_err(|_| {
        RomWeaverError::Validation("IPS RLE record length exceeded encodable range".into())
    })?;
    output.write_all(&rle_len.to_be_bytes())?;
    output.write_all(&[byte])?;

    created.record_count += 1;
    created.max_written_end = max(
        created.max_written_end,
        checked_add(offset, len as u64, "IPS RLE record end")?,
    );
    Ok(())
}

fn truncate_size_required(original_len: u64, modified_len: u64) -> bool {
    modified_len < original_len
}

fn write_offset(output: &mut impl Write, value: u64, flavor: IpsFlavor) -> Result<()> {
    if value == flavor.reserved_eof_offset() {
        return Err(RomWeaverError::Validation(format!(
            "{} record offset matched its EOF marker",
            flavor_name(flavor)
        )));
    }

    match flavor {
        IpsFlavor::Ips | IpsFlavor::Ebp => write_u24(output, value, "IPS record offset"),
        IpsFlavor::Ips32 => write_u32(output, value, "IPS32 record offset"),
    }
}

fn write_u24(output: &mut impl Write, value: u64, label: &str) -> Result<()> {
    if value > MAX_IPS_OFFSET {
        return Err(RomWeaverError::Validation(format!(
            "{label} exceeded the IPS 24-bit limit"
        )));
    }

    let value = u32::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("{label} exceeded u32")))?;
    output.write_all(&[
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    ])?;
    Ok(())
}

fn write_u32(output: &mut impl Write, value: u64, label: &str) -> Result<()> {
    if value > MAX_IPS32_OFFSET {
        return Err(RomWeaverError::Validation(format!(
            "{label} exceeded the IPS32 32-bit limit"
        )));
    }
    let value = u32::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("{label} exceeded u32")))?;
    output.write_all(&value.to_be_bytes())?;
    Ok(())
}

fn build_chunk_tasks(
    patch: &ParsedIpsPatch,
    output_size: u64,
    context: &OperationContext,
) -> Result<Vec<ChunkTask>> {
    let planner = ChunkPlanner::new(OUTPUT_CHUNK_SIZE)?;
    let chunks = planner.plan(output_size);
    let mut record_indexes = vec![Vec::new(); chunks.len()];

    for (record_index, record) in patch.records.iter().enumerate() {
        let record_end = record.end()?;
        let clipped_end = min(record_end, output_size);
        if record.offset >= clipped_end {
            continue;
        }

        let start_chunk = usize::try_from(record.offset / OUTPUT_CHUNK_SIZE).map_err(|_| {
            RomWeaverError::Validation("IPS record offset exceeded chunk index range".into())
        })?;
        let end_chunk = usize::try_from((clipped_end - 1) / OUTPUT_CHUNK_SIZE).map_err(|_| {
            RomWeaverError::Validation("IPS record end exceeded chunk index range".into())
        })?;

        for record_index_list in &mut record_indexes[start_chunk..=end_chunk] {
            record_index_list.push(record_index);
        }
    }

    Ok(chunks
        .into_iter()
        .zip(record_indexes)
        .map(|(chunk, record_indexes)| ChunkTask {
            temp_path: context
                .temp_paths()
                .next_path(&format!("ips-chunk-{}", chunk.index), Some("bin")),
            chunk,
            record_indexes,
        })
        .collect())
}

fn render_chunk_task(
    task: &ChunkTask,
    input_path: &Path,
    input_len: u64,
    patch: &ParsedIpsPatch,
    context: &OperationContext,
) -> Result<bool> {
    context.cancel().check()?;

    let chunk_len = usize::try_from(task.chunk.len).map_err(|_| {
        RomWeaverError::Validation("IPS chunk length exceeded addressable memory".into())
    })?;
    let mut buffer = vec![0u8; chunk_len];
    read_input_chunk(input_path, input_len, &task.chunk, &mut buffer)?;
    let mut changed = false;

    let chunk_start = task.chunk.offset;
    let chunk_end = checked_add(task.chunk.offset, task.chunk.len, "IPS chunk end")?;

    for &record_index in &task.record_indexes {
        context.cancel().check()?;
        let record = &patch.records[record_index];
        let record_end = record.end()?;
        let overlap_start = max(chunk_start, record.offset);
        let overlap_end = min(chunk_end, record_end);
        if overlap_start >= overlap_end {
            continue;
        }

        let dst_start = usize::try_from(overlap_start - chunk_start).map_err(|_| {
            RomWeaverError::Validation(
                "IPS chunk destination offset exceeded addressable memory".into(),
            )
        })?;
        let overlap_len = usize::try_from(overlap_end - overlap_start).map_err(|_| {
            RomWeaverError::Validation("IPS overlap length exceeded addressable memory".into())
        })?;
        let dst_end = dst_start + overlap_len;

        match &record.data {
            IpsRecordData::Literal(data) => {
                let src_start = usize::try_from(overlap_start - record.offset).map_err(|_| {
                    RomWeaverError::Validation(
                        "IPS literal overlap offset exceeded addressable memory".into(),
                    )
                })?;
                let src_end = src_start + overlap_len;
                let source = &data[src_start..src_end];
                let target = &mut buffer[dst_start..dst_end];
                if &*target != source {
                    changed = true;
                }
                target.copy_from_slice(source);
            }
            IpsRecordData::Rle { byte } => {
                let target = &mut buffer[dst_start..dst_end];
                if target.iter().any(|value| value != byte) {
                    changed = true;
                }
                target.fill(*byte);
            }
        }
    }

    let mut writer = crate::create_buffered_output(&task.temp_path)?;
    writer.write_all(&buffer)?;
    writer.flush()?;
    Ok(changed)
}

fn read_input_chunk(
    input_path: &Path,
    input_len: u64,
    chunk: &FileChunk,
    buffer: &mut [u8],
) -> Result<()> {
    if buffer.is_empty() || chunk.offset >= input_len {
        return Ok(());
    }

    let bytes_to_read =
        usize::try_from((input_len - chunk.offset).min(chunk.len)).map_err(|_| {
            RomWeaverError::Validation("IPS input chunk exceeded addressable memory".into())
        })?;
    if bytes_to_read == 0 {
        return Ok(());
    }

    let mut input = File::open(input_path)?;
    input.seek(SeekFrom::Start(chunk.offset))?;
    input.read_exact(&mut buffer[..bytes_to_read])?;
    Ok(())
}

fn assemble_output(
    output_path: &Path,
    tasks: &[ChunkTask],
    context: &OperationContext,
) -> Result<()> {
    let mut output = crate::create_buffered_output(output_path)?;
    for task in tasks {
        context.cancel().check()?;
        let mut reader = BufReader::new(File::open(&task.temp_path)?);
        std::io::copy(&mut reader, &mut output)?;
    }
    output.flush()?;
    Ok(())
}

fn cleanup_chunk_files(tasks: &[ChunkTask]) {
    for task in tasks {
        let _ = fs::remove_file(&task.temp_path);
    }
}

fn checked_add(left: u64, right: u64, label: &str) -> Result<u64> {
    left.checked_add(right)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed available range")))
}

fn read_u24(bytes: &[u8]) -> u32 {
    (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2])
}

fn read_u32(bytes: &[u8]) -> u32 {
    (u32::from(bytes[0]) << 24)
        | (u32::from(bytes[1]) << 16)
        | (u32::from(bytes[2]) << 8)
        | u32::from(bytes[3])
}

#[cfg(test)]
struct IpsParser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

#[cfg(test)]
impl<'a> IpsParser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn read_exact(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| RomWeaverError::Validation("IPS parser offset overflowed".into()))?;
        if end > self.bytes.len() {
            return Err(RomWeaverError::Validation(
                "IPS patch ended unexpectedly while reading record data".into(),
            ));
        }

        let start = self.offset;
        self.offset = end;
        Ok(&self.bytes[start..end])
    }

    fn read_u16(&mut self) -> Result<u16> {
        let bytes = self.read_exact(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn read_u24(&mut self) -> Result<u32> {
        let bytes = self.read_exact(3)?;
        Ok(read_u24(bytes))
    }
}

struct IpsFileParser<R> {
    reader: R,
    file_len: u64,
    offset: u64,
}

impl<R: Read> IpsFileParser<R> {
    fn new(reader: R, file_len: u64) -> Self {
        Self {
            reader,
            file_len,
            offset: 0,
        }
    }

    fn remaining(&self) -> Result<u64> {
        self.file_len.checked_sub(self.offset).ok_or_else(|| {
            RomWeaverError::Validation("IPS parser offset exceeded file size".into())
        })
    }

    fn read_exact(&mut self, len: usize) -> Result<Vec<u8>> {
        let len_u64 = u64::try_from(len)
            .map_err(|_| RomWeaverError::Validation("IPS read length overflowed u64".into()))?;
        let remaining = self.remaining()?;
        if len_u64 > remaining {
            return Err(RomWeaverError::Validation(
                "IPS patch ended unexpectedly while reading record data".into(),
            ));
        }

        let mut bytes = vec![0u8; len];
        self.reader.read_exact(&mut bytes)?;
        self.offset = self
            .offset
            .checked_add(len_u64)
            .ok_or_else(|| RomWeaverError::Validation("IPS parser offset overflowed".into()))?;
        Ok(bytes)
    }

    fn read_u16(&mut self) -> Result<u16> {
        let bytes = self.read_exact(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn read_u24(&mut self) -> Result<u32> {
        let bytes = self.read_exact(3)?;
        Ok(read_u24(&bytes))
    }
}

#[cfg(test)]
#[path = "../tests/unit/ips.rs"]
mod tests;
