use std::{
    cmp::{max, min},
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use rayon::prelude::*;
use rom_weaver_core::{
    ChunkPlanner, FileChunk, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability,
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

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_ips_file(patch_path, self.flavor)?;
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
        let patch = parse_ips_file(patch_path, self.flavor)?;
        let input_len = fs::metadata(&request.input)?.len();
        let output_size = patch.resolved_output_size(input_len)?;
        let max_parallel_chunks = max_parallel_chunks(output_size)?;
        let thread_capability = ThreadCapability::parallel(Some(max_parallel_chunks));
        let planned_execution = context.plan_threads(thread_capability.clone());
        let tasks = build_chunk_tasks(&patch, output_size, context)?;

        let (execution, render_result) = if planned_execution.used_parallelism {
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

        if let Err(error) = render_result {
            cleanup_chunk_files(&tasks);
            return Err(error);
        }

        let assemble_result = assemble_output(&request.output, &tasks, context);
        cleanup_chunk_files(&tasks);
        assemble_result?;

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
                &patch.warnings,
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
        let thread_capability = ips_create_thread_capability(modified_len)?;
        let planned_execution = context.plan_threads(thread_capability.clone());

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        let (execution, create_result) = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let create_result = create_ips_patch_parallel(
                &request.original,
                original_len,
                &request.modified,
                modified_len,
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

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name, create_result.record_count
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
struct ParsedIpsPatch {
    truncate_size: Option<u64>,
    metadata: Option<JsonMap<String, JsonValue>>,
    warnings: Vec<String>,
    max_written_end: u64,
    records: Vec<IpsRecord>,
}

impl ParsedIpsPatch {
    fn resolved_output_size(&self, input_len: u64) -> Result<u64> {
        let output_size = self
            .truncate_size
            .unwrap_or_else(|| input_len.max(self.max_written_end));
        if self.max_written_end > output_size {
            return Err(RomWeaverError::Validation(format!(
                "IPS record exceeded declared output size {output_size}"
            )));
        }
        Ok(output_size)
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

fn parse_ips_file(path: &Path, flavor: IpsFlavor) -> Result<ParsedIpsPatch> {
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
                        warnings.push(format!(
                            "ignored {trailing_len} trailing byte(s) after EOF in IPS patch"
                        ));
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

            if let Some(size) = truncate_size
                && max_written_end > size
            {
                return Err(RomWeaverError::Validation(format!(
                    "IPS record exceeded declared output size {size}"
                )));
            }

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
                warnings.push(format!(
                    "ignored zero-length IPS RLE record at offset {offset}"
                ));
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
                        warnings.push(format!(
                            "ignored {trailing_len} trailing byte(s) after EOF in IPS patch"
                        ));
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

            if let Some(size) = truncate_size {
                if max_written_end > size {
                    return Err(RomWeaverError::Validation(format!(
                        "IPS record exceeded declared output size {size}"
                    )));
                }
            }

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
                warnings.push(format!(
                    "ignored zero-length IPS RLE record at offset {offset}"
                ));
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
            if original_byte == modified_byte {
                flush_pending_diff(&mut pending, output, &mut created, flavor)?;
            } else {
                if pending
                    .as_ref()
                    .is_some_and(|diff| diff.bytes.len() == MAX_IPS_RECORD_LEN)
                {
                    flush_pending_diff(&mut pending, output, &mut created, flavor)?;
                }

                let diff = pending.get_or_insert_with(|| PendingDiff {
                    start_offset: offset,
                    bytes: Vec::with_capacity(MAX_IPS_RECORD_LEN),
                });
                diff.bytes.push(modified_byte);
            }
            offset += 1;
        }
    }

    flush_pending_diff(&mut pending, output, &mut created, flavor)?;
    output.write_all(flavor.footer())?;

    match flavor {
        IpsFlavor::Ips => {
            if truncate_size_required(original_len, modified_len, created.max_written_end) {
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
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    pool: &SharedThreadPool,
    output: &mut impl Write,
    context: &OperationContext,
    flavor: IpsFlavor,
) -> Result<IpsCreateResult> {
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

    let mut created = IpsCreateResult::default();
    output.write_all(flavor.header())?;
    for run in &runs {
        write_diff_run_records(output, run, &mut created, flavor)?;
    }
    output.write_all(flavor.footer())?;

    match flavor {
        IpsFlavor::Ips => {
            if truncate_size_required(original_len, modified_len, created.max_written_end) {
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
            if source == target {
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

fn merge_ips_diff_runs(chunk_runs: Vec<Vec<IpsDiffRun>>) -> Result<Vec<IpsDiffRun>> {
    let mut merged = Vec::<IpsDiffRun>::new();
    for runs in chunk_runs {
        for run in runs {
            if let Some(last) = merged.last_mut() {
                if last.end()? == run.offset {
                    last.bytes.extend_from_slice(&run.bytes);
                    continue;
                }
            }
            merged.push(run);
        }
    }
    Ok(merged)
}

fn write_diff_run_records(
    output: &mut impl Write,
    run: &IpsDiffRun,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    let mut cursor = 0usize;
    while cursor < run.bytes.len() {
        let next = (cursor + MAX_IPS_RECORD_LEN).min(run.bytes.len());
        let segment = &run.bytes[cursor..next];
        let segment_offset = checked_add(run.offset, cursor as u64, "IPS diff segment offset")?;
        if segment.len() >= MIN_RLE_RECORD_LEN && segment.iter().all(|byte| *byte == segment[0]) {
            write_rle_record(
                output,
                segment_offset,
                segment.len(),
                segment[0],
                created,
                flavor,
            )?;
        } else {
            write_literal_record(output, segment_offset, segment, created, flavor)?;
        }
        cursor = next;
    }
    Ok(())
}

fn flush_pending_diff(
    pending: &mut Option<PendingDiff>,
    output: &mut impl Write,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    let Some(diff) = pending.take() else {
        return Ok(());
    };
    write_pending_diff(output, &diff, created, flavor)
}

fn write_pending_diff(
    output: &mut impl Write,
    diff: &PendingDiff,
    created: &mut IpsCreateResult,
    flavor: IpsFlavor,
) -> Result<()> {
    if diff.bytes.is_empty() {
        return Ok(());
    }

    if diff.bytes.len() >= MIN_RLE_RECORD_LEN
        && diff.bytes.iter().all(|byte| *byte == diff.bytes[0])
    {
        write_rle_record(
            output,
            diff.start_offset,
            diff.bytes.len(),
            diff.bytes[0],
            created,
            flavor,
        )
    } else {
        write_literal_record(output, diff.start_offset, &diff.bytes, created, flavor)
    }
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

fn truncate_size_required(original_len: u64, modified_len: u64, max_written_end: u64) -> bool {
    modified_len < original_len || (modified_len > original_len && max_written_end < modified_len)
}

fn write_offset(output: &mut impl Write, value: u64, flavor: IpsFlavor) -> Result<()> {
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
        let start_chunk = usize::try_from(record.offset / OUTPUT_CHUNK_SIZE).map_err(|_| {
            RomWeaverError::Validation("IPS record offset exceeded chunk index range".into())
        })?;
        let end_chunk = usize::try_from((record.end()? - 1) / OUTPUT_CHUNK_SIZE).map_err(|_| {
            RomWeaverError::Validation("IPS record end exceeded chunk index range".into())
        })?;

        for chunk_index in start_chunk..=end_chunk {
            record_indexes[chunk_index].push(record_index);
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
) -> Result<()> {
    context.cancel().check()?;

    let chunk_len = usize::try_from(task.chunk.len).map_err(|_| {
        RomWeaverError::Validation("IPS chunk length exceeded addressable memory".into())
    })?;
    let mut buffer = vec![0u8; chunk_len];
    read_input_chunk(input_path, input_len, &task.chunk, &mut buffer)?;

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
                buffer[dst_start..dst_end].copy_from_slice(&data[src_start..src_end]);
            }
            IpsRecordData::Rle { byte } => {
                buffer[dst_start..dst_end].fill(*byte);
            }
        }
    }

    if let Some(parent) = task.temp_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut writer = BufWriter::new(File::create(&task.temp_path)?);
    writer.write_all(&buffer)?;
    writer.flush()?;
    Ok(())
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
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut output = BufWriter::new(File::create(output_path)?);
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
