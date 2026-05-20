use std::{
    cmp::{max, min},
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use memmap2::{Mmap, MmapOptions};
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

enum ReadOnlyFile {
    Mapped(Mmap),
    Owned(Vec<u8>),
}

impl AsRef<[u8]> for ReadOnlyFile {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Mapped(map) => map.as_ref(),
            Self::Owned(bytes) => bytes.as_slice(),
        }
    }
}

fn parse_ips_file(path: &Path, flavor: IpsFlavor) -> Result<ParsedIpsPatch> {
    let bytes = map_file_read_only(path)?;
    parse_ips_bytes(bytes.as_ref(), flavor)
}

fn map_file_read_only(path: &Path) -> Result<ReadOnlyFile> {
    let file = File::open(path)?;
    // SAFETY: The mapping is read-only and the file handle lives for map creation.
    match unsafe { MmapOptions::new().map(&file) } {
        Ok(map) => Ok(ReadOnlyFile::Mapped(map)),
        Err(error) if should_fallback_from_mmap(&error) => Ok(ReadOnlyFile::Owned(fs::read(path)?)),
        Err(error) => Err(error.into()),
    }
}

fn should_fallback_from_mmap(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported
}

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
    let original = map_file_read_only(original_path)?;
    let modified = map_file_read_only(modified_path)?;
    let original_bytes = original.as_ref();
    let modified_bytes = modified.as_ref();

    let chunk_count = ips_create_chunk_count(modified_len)?;
    let chunk_runs = pool.install(|| {
        (0..chunk_count)
            .into_par_iter()
            .map(|chunk_index| {
                context.cancel().check()?;
                collect_ips_diff_runs_for_chunk(chunk_index, original_bytes, modified_bytes)
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
    original: &[u8],
    modified: &[u8],
) -> Result<Vec<IpsDiffRun>> {
    let start = chunk_index
        .checked_mul(CREATE_SCAN_CHUNK_BYTES)
        .ok_or_else(|| RomWeaverError::Validation("IPS create chunk offset overflowed".into()))?;
    if start >= modified.len() {
        return Ok(Vec::new());
    }
    let end = start
        .saturating_add(CREATE_SCAN_CHUNK_BYTES)
        .min(modified.len());
    let mut cursor = start;
    let mut runs = Vec::new();

    while cursor < end {
        let source = original.get(cursor).copied().unwrap_or(0);
        let target = modified[cursor];
        if source == target {
            cursor += 1;
            continue;
        }

        let run_start = cursor;
        let mut run_bytes = Vec::new();
        while cursor < end {
            let source = original.get(cursor).copied().unwrap_or(0);
            let target = modified[cursor];
            if source == target {
                break;
            }
            run_bytes.push(target);
            cursor += 1;
        }

        runs.push(IpsDiffRun {
            offset: run_start as u64,
            bytes: run_bytes,
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

struct IpsParser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

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

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{Seek, SeekFrom, Write},
        path::PathBuf,
    };

    use rom_weaver_core::{OperationContext, PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::{
        CREATE_SCAN_CHUNK_BYTES, DEFAULT_EBP_METADATA_JSON, IPS_EOF, IPS_MAGIC, IPS32_EOF,
        IPS32_MAGIC, IpsFlavor, IpsPatchHandler, IpsRecordData, JsonValue, MAX_IPS_RECORD_LEN,
        OUTPUT_CHUNK_SIZE, parse_ips_bytes,
    };
    use crate::{
        EBP, IPS, IPS32,
        test_support::{TestDir, test_context_with_threads_named},
    };

    #[derive(Debug)]
    enum TestIpsRecord {
        Literal { offset: u32, data: Vec<u8> },
        Rle { offset: u32, len: u16, value: u8 },
    }

    #[test]
    fn parse_rejects_records_beyond_declared_output_size() {
        let patch = build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 4,
                data: b"toolong".to_vec(),
            }],
            Some(6),
        );

        let error = parse_ips_bytes(&patch, IpsFlavor::Ips).expect_err("invalid patch");
        assert!(
            error
                .to_string()
                .contains("IPS record exceeded declared output size")
        );
    }

    #[test]
    fn parse_accepts_zero_length_rle_records_with_warning() {
        let patch = build_ips_patch(
            vec![
                TestIpsRecord::Rle {
                    offset: 0,
                    len: 0,
                    value: 0xFF,
                },
                TestIpsRecord::Literal {
                    offset: 1,
                    data: b"A".to_vec(),
                },
            ],
            None,
        );

        let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips).expect("parse");
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].offset, 1);
        assert_eq!(parsed.records[0].len, 1);
        assert_eq!(parsed.warnings.len(), 1);
        assert!(
            parsed.warnings[0].contains("ignored zero-length IPS RLE record at offset 0"),
            "warning mismatch: {}",
            parsed.warnings[0]
        );
    }

    #[test]
    fn parse_accepts_trailing_bytes_after_eof_with_warning() {
        let mut patch = build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"A".to_vec(),
            }],
            None,
        );
        patch.extend_from_slice(&[0xDE, 0xAD]);

        let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips).expect("parse");
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.truncate_size, None);
        assert_eq!(parsed.warnings.len(), 1);
        assert!(
            parsed.warnings[0].contains("ignored 2 trailing byte(s) after EOF in IPS patch"),
            "warning mismatch: {}",
            parsed.warnings[0]
        );
    }

    #[test]
    fn parse_report_includes_warning_for_zero_length_rle_record() {
        let temp = TestDir::new();
        let patch_path = temp.child("zero-rle.ips");
        fs::write(
            &patch_path,
            build_ips_patch(
                vec![TestIpsRecord::Rle {
                    offset: 0,
                    len: 0,
                    value: 0xFF,
                }],
                None,
            ),
        )
        .expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        let report = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect("parse report");

        assert!(
            report
                .label
                .contains("warning=ignored zero-length IPS RLE record at offset 0"),
            "label mismatch: {}",
            report.label
        );
    }

    #[test]
    fn apply_report_includes_warning_for_trailing_bytes_after_eof() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("trailing-data.ips");
        let output_path = temp.child("output.bin");
        fs::write(&input_path, b"ab").expect("fixture");

        let mut patch = build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 1,
                data: b"Z".to_vec(),
            }],
            None,
        );
        patch.extend_from_slice(&[0x00]);
        fs::write(&patch_path, patch).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply report");

        assert_eq!(fs::read(&output_path).expect("output"), b"aZ");
        assert!(
            report
                .label
                .contains("warning=ignored 1 trailing byte(s) after EOF in IPS patch"),
            "label mismatch: {}",
            report.label
        );
    }

    #[test]
    fn apply_round_trips_overlaps_and_truncation() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips");
        let output_path = temp.child("output.bin");
        fs::write(&input_path, b"abcdefgh").expect("fixture");
        fs::write(
            &patch_path,
            build_ips_patch(
                vec![
                    TestIpsRecord::Literal {
                        offset: 1,
                        data: b"12".to_vec(),
                    },
                    TestIpsRecord::Literal {
                        offset: 2,
                        data: b"XYZ".to_vec(),
                    },
                    TestIpsRecord::Rle {
                        offset: 6,
                        len: 3,
                        value: b'!',
                    },
                ],
                Some(9),
            ),
        )
        .expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_output);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("report");

        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert_eq!(fs::read(&output_path).expect("output"), b"a1XYZf!!!");
    }

    #[test]
    fn apply_uses_parallel_threads_for_large_output() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips");
        let output_path = temp.child("output.bin");
        fs::write(&input_path, []).expect("fixture");

        let total_len = (OUTPUT_CHUNK_SIZE + 321) as u32;
        fs::write(&patch_path, large_rle_patch(total_len, b'Z')).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_output);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("report");

        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 2);
        assert!(execution.used_parallelism);

        let output = fs::read(&output_path).expect("output");
        assert_eq!(output.len(), total_len as usize);
        assert!(output.iter().all(|byte| *byte == b'Z'));
    }

    #[test]
    fn create_round_trips_and_encodes_truncation_when_shrinking() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips");
        let output_path = temp.child("output.bin");
        fs::write(&original_path, b"abcdefgh").expect("fixture");

        let modified = b"a1XYZf!";
        let modified_path = temp.child("modified.bin");
        fs::write(&modified_path, modified).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "IPS".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("report");

        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        let patch =
            parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
        assert_eq!(patch.truncate_size, Some(modified.len() as u64));
        assert!(!patch.records.is_empty());

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(&output_path).expect("output"), modified);
    }

    #[test]
    fn create_can_grow_with_zero_tail_using_only_truncate_size() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips");
        let output_path = temp.child("output.bin");
        let modified_path = temp.child("modified.bin");
        fs::write(&original_path, []).expect("fixture");
        fs::write(&modified_path, [0u8; 32]).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "IPS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let patch =
            parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
        assert_eq!(patch.truncate_size, Some(32));
        assert!(patch.records.is_empty());

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(fs::read(&output_path).expect("output"), vec![0u8; 32]);
    }

    #[test]
    fn create_uses_rle_records_for_repeated_runs() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips");
        let modified_path = temp.child("modified.bin");
        fs::write(&original_path, []).expect("fixture");
        fs::write(&modified_path, vec![b'Z'; 32]).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "IPS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let patch =
            parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
        assert_eq!(patch.truncate_size, None);
        assert_eq!(patch.records.len(), 1);
        assert_eq!(patch.records[0].offset, 0);
        assert_eq!(patch.records[0].len, 32);
        match &patch.records[0].data {
            IpsRecordData::Rle { byte } => assert_eq!(*byte, b'Z'),
            other => panic!("expected RLE record, got {other:?}"),
        }
    }

    #[test]
    fn create_uses_parallel_threads_for_large_input() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.ips");
        let output_path = temp.child("output.bin");

        let len = CREATE_SCAN_CHUNK_BYTES + 128;
        let original = vec![0u8; len];
        let mut modified = original.clone();
        modified[CREATE_SCAN_CHUNK_BYTES - 8..CREATE_SCAN_CHUNK_BYTES + 24].fill(b'X');
        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "IPS".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");
        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 2);
        assert!(execution.used_parallelism);

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");
        assert_eq!(fs::read(&output_path).expect("output"), modified);
    }

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let modified_path = temp.child("modified.bin");
        let patch_single = temp.child("single.ips");
        let patch_parallel = temp.child("parallel.ips");

        let len = CREATE_SCAN_CHUNK_BYTES + 128;
        let original = vec![0u8; len];
        let mut modified = original.clone();
        modified[CREATE_SCAN_CHUNK_BYTES - 8..CREATE_SCAN_CHUNK_BYTES + 24].fill(b'X');
        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);

        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_single.clone(),
                    format: "IPS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_parallel.clone(),
                    format: "IPS".into(),
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
            fs::read(&patch_single).expect("single patch"),
            fs::read(&patch_parallel).expect("parallel patch")
        );
    }

    #[test]
    fn create_splits_large_literal_runs_at_ips_record_limit() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips");
        let modified_path = temp.child("modified.bin");
        fs::write(&original_path, []).expect("fixture");

        let modified_len = MAX_IPS_RECORD_LEN + 17;
        let modified = (0..modified_len)
            .map(|index| u8::try_from((index % 255) + 1).expect("byte"))
            .collect::<Vec<_>>();
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "IPS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let patch =
            parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
        assert_eq!(patch.truncate_size, None);
        assert_eq!(patch.records.len(), 2);
        assert_eq!(patch.records[0].offset, 0);
        assert_eq!(patch.records[0].len, MAX_IPS_RECORD_LEN as u64);
        assert_eq!(patch.records[1].offset, MAX_IPS_RECORD_LEN as u64);
        assert_eq!(patch.records[1].len, 17);
        assert!(matches!(patch.records[0].data, IpsRecordData::Literal(_)));
        assert!(matches!(patch.records[1].data, IpsRecordData::Literal(_)));
    }

    #[test]
    fn create_unchanged_files_produce_empty_patch() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips");
        let modified_path = temp.child("modified.bin");
        let bytes = b"unchanged-input".repeat(1024);
        fs::write(&original_path, &bytes).expect("fixture");
        fs::write(&modified_path, &bytes).expect("fixture");

        let handler = IpsPatchHandler::new(&IPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path,
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "IPS".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let patch = fs::read(&patch_path).expect("patch");
        assert_eq!(patch, b"PATCHEOF");
    }

    #[test]
    fn parse_accepts_ips32_records_past_24bit_limit() {
        let patch = build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"A".to_vec(),
        }]);
        let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips32).expect("parse");
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].offset, 0x0100_0000);
        assert_eq!(parsed.truncate_size, None);
    }

    #[test]
    fn apply_round_trips_for_ips32_patch() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ips32");
        let output_path = temp.child("output.bin");
        write_sparse_bytes(&input_path, 0x0100_0002, 0x0100_0000, b"ab");
        fs::write(
            &patch_path,
            build_ips32_patch(vec![TestIpsRecord::Literal {
                offset: 0x0100_0001,
                data: b"Z".to_vec(),
            }]),
        )
        .expect("fixture");

        let handler = IpsPatchHandler::new_ips32(&IPS32);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        let output = fs::read(&output_path).expect("output");
        assert_eq!(output.len(), 0x0100_0002);
        assert_eq!(output[0x0100_0000], b'a');
        assert_eq!(output[0x0100_0001], b'Z');
    }

    #[test]
    fn create_round_trips_for_ips32_patch() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.ips32");
        let output_path = temp.child("output.bin");
        write_sparse_bytes(&original_path, 0x0100_0002, 0x0100_0000, b"ab");
        write_sparse_bytes(&modified_path, 0x0100_0002, 0x0100_0000, b"aZ");

        let handler = IpsPatchHandler::new_ips32(&IPS32);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "IPS32".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let patch = fs::read(&patch_path).expect("patch");
        assert!(patch.starts_with(IPS32_MAGIC));
        assert!(patch.ends_with(IPS32_EOF));
        let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips32).expect("parse");
        assert_eq!(parsed.truncate_size, None);
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].offset, 0x0100_0001);

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");
        assert_eq!(fs::read(&output_path).expect("output")[0x0100_0000], b'a');
        assert_eq!(fs::read(&output_path).expect("output")[0x0100_0001], b'Z');
    }

    #[test]
    fn parse_accepts_ebp_metadata_after_eof() {
        let patch = build_ebp_patch(
            vec![TestIpsRecord::Literal {
                offset: 1,
                data: b"XYZ".to_vec(),
            }],
            r#"{"patcher":"EBPatcher","Title":"Test","Author":"Me","Description":"Demo"}"#,
        );
        let parsed = parse_ips_bytes(&patch, IpsFlavor::Ebp).expect("parse");
        assert_eq!(parsed.truncate_size, None);
        assert_eq!(parsed.records.len(), 1);
        let metadata = parsed.metadata.expect("metadata");
        assert_eq!(
            metadata.get("patcher").and_then(JsonValue::as_str),
            Some("EBPatcher")
        );
        assert_eq!(
            metadata.get("Title").and_then(JsonValue::as_str),
            Some("Test")
        );
    }

    #[test]
    fn parse_rejects_invalid_ebp_metadata_json() {
        let patch = build_ebp_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"A".to_vec(),
            }],
            "{invalid-json}",
        );
        let error = parse_ips_bytes(&patch, IpsFlavor::Ebp).expect_err("invalid metadata");
        assert!(error.to_string().contains("EBP metadata is not valid JSON"));
    }

    #[test]
    fn apply_round_trips_for_ebp_patch() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.ebp");
        let output_path = temp.child("output.bin");
        fs::write(&input_path, b"abcdefgh").expect("fixture");
        fs::write(
            &patch_path,
            build_ebp_patch(
                vec![
                    TestIpsRecord::Literal {
                        offset: 2,
                        data: b"XYZ".to_vec(),
                    },
                    TestIpsRecord::Rle {
                        offset: 7,
                        len: 2,
                        value: b'!',
                    },
                ],
                r#"{"patcher":"EBPatcher","Title":"Patch"}"#,
            ),
        )
        .expect("fixture");

        let handler = IpsPatchHandler::new_ebp(&EBP);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(&output_path).expect("output"), b"abXYZfg!!");
    }

    #[test]
    fn create_round_trips_and_writes_default_ebp_metadata() {
        let temp = TestDir::new();
        let original_path = temp.child("input.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.ebp");
        let output_path = temp.child("output.bin");
        fs::write(&original_path, b"abcdefgh").expect("fixture");
        fs::write(&modified_path, b"a1XYZf!!").expect("fixture");

        let handler = IpsPatchHandler::new_ebp(&EBP);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "EBP".into(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("create");

        let patch = fs::read(&patch_path).expect("patch");
        assert!(patch.ends_with(DEFAULT_EBP_METADATA_JSON.as_bytes()));
        let parsed = parse_ips_bytes(&patch, IpsFlavor::Ebp).expect("parse");
        assert_eq!(parsed.truncate_size, None);
        assert!(parsed.metadata.is_some());

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");
        assert_eq!(fs::read(&output_path).expect("output"), b"a1XYZf!!");
    }

    fn build_ips_patch(records: Vec<TestIpsRecord>, truncate_size: Option<u32>) -> Vec<u8> {
        let mut bytes = IPS_MAGIC.to_vec();
        for record in records {
            match record {
                TestIpsRecord::Literal { offset, data } => {
                    write_u24(&mut bytes, offset);
                    let len = u16::try_from(data.len()).expect("literal len");
                    bytes.extend_from_slice(&len.to_be_bytes());
                    bytes.extend_from_slice(&data);
                }
                TestIpsRecord::Rle { offset, len, value } => {
                    write_u24(&mut bytes, offset);
                    bytes.extend_from_slice(&0u16.to_be_bytes());
                    bytes.extend_from_slice(&len.to_be_bytes());
                    bytes.push(value);
                }
            }
        }
        bytes.extend_from_slice(IPS_EOF);
        if let Some(size) = truncate_size {
            write_u24(&mut bytes, size);
        }
        bytes
    }

    fn build_ebp_patch(records: Vec<TestIpsRecord>, metadata_json: &str) -> Vec<u8> {
        let mut bytes = build_ips_patch(records, None);
        bytes.extend_from_slice(metadata_json.as_bytes());
        bytes
    }

    fn build_ips32_patch(records: Vec<TestIpsRecord>) -> Vec<u8> {
        let mut bytes = IPS32_MAGIC.to_vec();
        for record in records {
            match record {
                TestIpsRecord::Literal { offset, data } => {
                    write_u32(&mut bytes, offset);
                    let len = u16::try_from(data.len()).expect("literal len");
                    bytes.extend_from_slice(&len.to_be_bytes());
                    bytes.extend_from_slice(&data);
                }
                TestIpsRecord::Rle { offset, len, value } => {
                    write_u32(&mut bytes, offset);
                    bytes.extend_from_slice(&0u16.to_be_bytes());
                    bytes.extend_from_slice(&len.to_be_bytes());
                    bytes.push(value);
                }
            }
        }
        bytes.extend_from_slice(IPS32_EOF);
        bytes
    }

    fn large_rle_patch(total_len: u32, value: u8) -> Vec<u8> {
        let mut records = Vec::new();
        let mut offset = 0u32;
        while offset < total_len {
            let remaining = total_len - offset;
            let len = remaining.min(u16::MAX as u32) as u16;
            records.push(TestIpsRecord::Rle { offset, len, value });
            offset += u32::from(len);
        }
        build_ips_patch(records, Some(total_len))
    }

    fn write_u24(bytes: &mut Vec<u8>, value: u32) {
        assert!(value <= 0x00FF_FFFF);
        bytes.push((value >> 16) as u8);
        bytes.push((value >> 8) as u8);
        bytes.push(value as u8);
    }

    fn write_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn write_sparse_bytes(path: &PathBuf, len: u64, offset: u64, bytes: &[u8]) {
        let mut file = fs::File::create(path).expect("create sparse file");
        file.set_len(len).expect("set len");
        file.seek(SeekFrom::Start(offset)).expect("seek");
        file.write_all(bytes).expect("write bytes");
        file.flush().expect("flush");
    }

    fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
        test_context_with_threads_named(temp, threads, "temp-root")
    }
}
