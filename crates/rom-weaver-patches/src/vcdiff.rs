use std::{
    ffi::CStr,
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    os::raw::{c_int, c_void},
    path::{Path, PathBuf},
};

use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};

use crate::xdelta_ffi;

const VCDIFF_MAGIC_BYTES: [u8; 3] = [0xD6, 0xC3, 0xC4];
const VCDIFF_VERSION_STANDARD: u8 = 0x00;

const HDR_SECONDARY: u8 = 0x01;
const HDR_CODE_TABLE: u8 = 0x02;
const HDR_APP_HEADER: u8 = 0x04;
const HDR_KNOWN_MASK: u8 = HDR_SECONDARY | HDR_CODE_TABLE | HDR_APP_HEADER;

const WIN_SOURCE: u8 = 0x01;
const WIN_TARGET: u8 = 0x02;
const WIN_CHECKSUM: u8 = 0x04;
const WIN_KNOWN_MASK: u8 = WIN_SOURCE | WIN_TARGET | WIN_CHECKSUM;

const DELTA_DATA_COMP: u8 = 0x01;
const DELTA_INST_COMP: u8 = 0x02;
const DELTA_ADDR_COMP: u8 = 0x04;
const DELTA_KNOWN_MASK: u8 = DELTA_DATA_COMP | DELTA_INST_COMP | DELTA_ADDR_COMP;

#[cfg(test)]
const XD3_ENOSPC: c_int = 28;

pub struct VcdiffPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl VcdiffPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for VcdiffPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let mut reader = BufReader::new(File::open(patch_path)?);
        let patch = parse_patch(&mut reader)?;
        let checksum_windows = patch
            .windows
            .iter()
            .filter(|window| window.checksum.is_some())
            .count();
        let mut label = if patch.secondary_compressor_id.is_some() {
            format!(
                "parsed {} patch with {} window(s) and secondary compression",
                self.descriptor.name,
                patch.windows.len()
            )
        } else {
            format!(
                "parsed {} patch with {} window(s)",
                self.descriptor.name,
                patch.windows.len()
            )
        };
        if checksum_windows > 0 {
            label.push_str(&format!(
                "; {} window checksum(s) declared",
                checksum_windows
            ));
        }
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
        let patch_path =
            crate::require_single_patch_file(&request.patches, self.descriptor.name)?.clone();
        let mut patch_reader = BufReader::new(File::open(&patch_path)?);
        let patch = parse_patch(&mut patch_reader)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let input_len = std::fs::metadata(&request.input)?.len();

        if patch
            .windows
            .iter()
            .any(|window| matches!(window.source_kind, Some(WindowSourceKind::Target)))
        {
            apply_windows_with_target_sources(
                &patch,
                &patch_path,
                &request.input,
                &request.output,
                input_len,
                validate_checksums,
            )?;

            let execution = context.plan_threads(ThreadCapability::single_threaded());
            let checksum_suffix = if validate_checksums {
                String::new()
            } else {
                "; checksum validation skipped".to_string()
            };
            return Ok(OperationReport::succeeded(
                OperationFamily::Patch,
                Some(self.descriptor.name.to_string()),
                "apply",
                format!(
                    "applied {} patch with {} window(s){}",
                    self.descriptor.name,
                    patch.windows.len(),
                    checksum_suffix
                ),
                Some(100.0),
                Some(execution),
            ));
        }

        let requested_threads = patch.windows.len().max(1);
        let thread_capability = ThreadCapability::parallel(Some(requested_threads));
        let planned_execution = context.plan_threads(thread_capability.clone());
        let tasks = patch
            .windows
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, window)| WindowTask {
                index,
                temp_path: context
                    .temp_paths()
                    .next_path(&format!("vcdiff-window-{index}"), Some("bin")),
                window,
            })
            .collect::<Vec<_>>();
        let patch_header = patch.header_bytes;
        let input_path = request.input.clone();
        let validate_checksums_for_tasks = validate_checksums;

        let (execution, mut decoded) = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let decoded = pool.install(|| {
                tasks
                    .into_par_iter()
                    .map(|task| {
                        decode_window_task(
                            &task,
                            &patch_path,
                            &input_path,
                            input_len,
                            &patch_header,
                            validate_checksums_for_tasks,
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            (execution, decoded)
        } else {
            let decoded = tasks
                .into_iter()
                .map(|task| {
                    decode_window_task(
                        &task,
                        &patch_path,
                        &input_path,
                        input_len,
                        &patch_header,
                        validate_checksums_for_tasks,
                    )
                })
                .collect::<Result<Vec<_>>>()?;
            (planned_execution, decoded)
        };

        decoded.sort_by_key(|window| (window.output_offset, window.index));

        let mut output = File::create(&request.output)?;
        let mut expected_offset = 0u64;
        for window in decoded {
            if window.output_offset != expected_offset {
                return Err(RomWeaverError::Validation(format!(
                    "window output offset mismatch: expected {expected_offset}, got {}",
                    window.output_offset
                )));
            }

            let mut temp = BufReader::new(File::open(&window.temp_path)?);
            std::io::copy(&mut temp, &mut output)?;
            expected_offset = checked_add(expected_offset, window.len, "assembled output size")?;
            let _ = fs::remove_file(&window.temp_path);
        }

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
                "applied {} patch with {} window(s){}",
                self.descriptor.name,
                patch.windows.len(),
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
        let output_extension = request.output.extension().and_then(|value| value.to_str());
        let baseline_path = context
            .temp_paths()
            .next_path("vcdiff-create-baseline", output_extension);
        let secondary_path = context
            .temp_paths()
            .next_path("vcdiff-create-secondary", output_extension);
        let thread_capability = ThreadCapability::parallel(Some(2));

        let create_result = (|| -> Result<(ParsedPatch, rom_weaver_core::ThreadExecution)> {
            let base_flags = create_base_flags(self.descriptor);
            let planned_execution = context.plan_threads(thread_capability.clone());
            let (execution, baseline, secondary) = if planned_execution.used_parallelism {
                let (execution, pool) = context.build_pool(thread_capability.clone())?;
                let baseline_original = request.original.clone();
                let baseline_modified = request.modified.clone();
                let baseline_output = baseline_path.clone();
                let secondary_original = request.original.clone();
                let secondary_modified = request.modified.clone();
                let secondary_output = secondary_path.clone();
                let (baseline_result, secondary_result) = pool.install(|| {
                    rayon::join(
                        || {
                            encode_patch_with_xdelta_streaming(
                                &baseline_original,
                                &baseline_modified,
                                &baseline_output,
                                base_flags,
                            )
                        },
                        || {
                            encode_patch_with_xdelta_streaming(
                                &secondary_original,
                                &secondary_modified,
                                &secondary_output,
                                base_flags | xdelta_ffi::XD3_SEC_DJW,
                            )
                        },
                    )
                });
                (execution, baseline_result?, secondary_result?)
            } else {
                let baseline = encode_patch_with_xdelta_streaming(
                    &request.original,
                    &request.modified,
                    &baseline_path,
                    base_flags,
                )?;
                let secondary = encode_patch_with_xdelta_streaming(
                    &request.original,
                    &request.modified,
                    &secondary_path,
                    base_flags | xdelta_ffi::XD3_SEC_DJW,
                )?;
                (planned_execution, baseline, secondary)
            };
            let selected = if secondary.size < baseline.size {
                secondary
            } else {
                baseline
            };

            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&selected.path, &request.output)?;

            let mut reader = BufReader::new(File::open(&request.output)?);
            Ok((parse_patch(&mut reader)?, execution))
        })();

        let _ = fs::remove_file(&baseline_path);
        let _ = fs::remove_file(&secondary_path);

        let (parsed, execution) = create_result?;

        let label = if parsed.secondary_compressor_id.is_some() {
            format!(
                "created {} patch with {} window(s) and secondary compression",
                self.descriptor.name,
                parsed.windows.len()
            )
        } else {
            format!(
                "created {} patch with {} window(s)",
                self.descriptor.name,
                parsed.windows.len()
            )
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            label,
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
struct ParsedPatch {
    header_bytes: Vec<u8>,
    secondary_compressor_id: Option<u8>,
    windows: Vec<WindowIndex>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowSourceKind {
    Source,
    Target,
}

#[derive(Clone, Debug)]
struct WindowIndex {
    win_indicator: u8,
    source_kind: Option<WindowSourceKind>,
    source_segment_size: u64,
    source_segment_position: u64,
    delta_encoding_len: u64,
    target_window_size: u64,
    delta_indicator: u8,
    checksum: Option<u32>,
    data_start: u64,
    data_len: u64,
    inst_start: u64,
    inst_len: u64,
    addr_start: u64,
    addr_len: u64,
    output_offset: u64,
}

impl WindowIndex {}

fn read_source_segment<R: Read + Seek>(
    reader: &mut R,
    segment_position: u64,
    segment_size: u64,
    available_len: u64,
    kind_label: &str,
) -> Result<Vec<u8>> {
    let end = checked_add(segment_position, segment_size, "source segment range")?;
    if end > available_len {
        return Err(RomWeaverError::Validation(format!(
            "{kind_label} segment [{segment_position}..{end}) exceeds available length {available_len}"
        )));
    }

    let size = usize::try_from(segment_size).map_err(|_| {
        RomWeaverError::Validation(
            "source segment is too large to fit in memory on this platform".into(),
        )
    })?;
    let mut segment = vec![0; size];
    reader.seek(SeekFrom::Start(segment_position))?;
    reader.read_exact(&mut segment)?;
    Ok(segment)
}

#[derive(Clone, Debug)]
struct WindowTask {
    index: usize,
    window: WindowIndex,
    temp_path: PathBuf,
}

#[derive(Debug)]
struct DecodedWindow {
    index: usize,
    output_offset: u64,
    len: u64,
    temp_path: PathBuf,
}

#[derive(Debug)]
struct CreatedPatchCandidate {
    path: PathBuf,
    size: u64,
}

#[derive(Debug)]
struct SourceBlockReader {
    file: File,
    buffer: Vec<u8>,
    last_error: Option<String>,
}

impl SourceBlockReader {
    fn new(path: &Path, block_size: usize) -> Result<Self> {
        Ok(Self {
            file: File::open(path)?,
            buffer: vec![0; block_size.max(1)],
            last_error: None,
        })
    }
}

fn parse_patch<R: Read + Seek>(reader: &mut R) -> Result<ParsedPatch> {
    reader.seek(SeekFrom::Start(0))?;

    let mut magic = [0; 4];
    reader.read_exact(&mut magic)?;
    if magic[..3] != VCDIFF_MAGIC_BYTES {
        return Err(RomWeaverError::Validation(
            "invalid VCDIFF header magic".into(),
        ));
    }
    if magic[3] != VCDIFF_VERSION_STANDARD {
        return Err(RomWeaverError::Validation(format!(
            "unsupported VCDIFF header version byte 0x{:02X}",
            magic[3]
        )));
    }

    let hdr_indicator = read_u8(reader)?;
    if hdr_indicator & !HDR_KNOWN_MASK != 0 {
        return Err(RomWeaverError::Validation(format!(
            "unsupported VCDIFF header flags 0x{hdr_indicator:02X}"
        )));
    }

    let secondary_compressor_id = if hdr_indicator & HDR_SECONDARY != 0 {
        Some(read_u8(reader)?)
    } else {
        None
    };

    if hdr_indicator & HDR_CODE_TABLE != 0 {
        let _near = read_u8(reader)?;
        let _same = read_u8(reader)?;
        let (code_table_len, _) = read_varint(reader)?;
        skip_bytes(reader, code_table_len)?;
    }

    if hdr_indicator & HDR_APP_HEADER != 0 {
        let (app_header_len, _) = read_varint(reader)?;
        skip_bytes(reader, app_header_len)?;
    }

    let header_end = reader.stream_position()?;
    let header_bytes = read_section(reader, 0, header_end)?;
    reader.seek(SeekFrom::Start(header_end))?;

    let mut windows = Vec::new();
    let mut output_offset = 0u64;
    while let Some(window) = read_window_index(reader, output_offset)? {
        output_offset = checked_add(
            output_offset,
            window.target_window_size,
            "patch output size",
        )?;
        windows.push(window);
    }

    Ok(ParsedPatch {
        header_bytes,
        secondary_compressor_id,
        windows,
    })
}

fn read_window_index<R: Read + Seek>(
    reader: &mut R,
    output_offset: u64,
) -> Result<Option<WindowIndex>> {
    let Some(win_indicator) = read_optional_u8(reader)? else {
        return Ok(None);
    };

    if win_indicator & !WIN_KNOWN_MASK != 0 {
        return Err(RomWeaverError::Validation(format!(
            "unsupported window flags 0x{win_indicator:02X}"
        )));
    }

    let uses_source = win_indicator & WIN_SOURCE != 0;
    let uses_target = win_indicator & WIN_TARGET != 0;
    if uses_source && uses_target {
        return Err(RomWeaverError::Validation(
            "window cannot reference both VCD_SOURCE and VCD_TARGET".into(),
        ));
    }

    let source_kind = if uses_source {
        Some(WindowSourceKind::Source)
    } else if uses_target {
        Some(WindowSourceKind::Target)
    } else {
        None
    };

    let (source_segment_size, source_segment_position) = if source_kind.is_some() {
        let (size, _) = read_varint(reader)?;
        let (position, _) = read_varint(reader)?;
        (size, position)
    } else {
        (0, 0)
    };

    let (delta_encoding_len, _) = read_varint(reader)?;
    let delta_encoding_start = reader.stream_position()?;

    let (target_window_size, _) = read_varint(reader)?;
    let delta_indicator = read_u8(reader)?;
    if delta_indicator & !DELTA_KNOWN_MASK != 0 {
        return Err(RomWeaverError::Validation(format!(
            "unsupported delta section flags 0x{delta_indicator:02X}"
        )));
    }

    let (data_len, _) = read_varint(reader)?;
    let (inst_len, _) = read_varint(reader)?;
    let (addr_len, _) = read_varint(reader)?;

    let checksum = if win_indicator & WIN_CHECKSUM != 0 {
        Some(read_be_u32(reader)?)
    } else {
        None
    };

    let data_start = reader.stream_position()?;
    let inst_start = checked_add(data_start, data_len, "instruction section start")?;
    let addr_start = checked_add(inst_start, inst_len, "address section start")?;
    let window_end = checked_add(addr_start, addr_len, "window end")?;

    let header_and_sections = checked_add(
        data_start - delta_encoding_start,
        checked_add(
            data_len,
            checked_add(inst_len, addr_len, "window section size")?,
            "window section size",
        )?,
        "delta encoding size",
    )?;
    if header_and_sections != delta_encoding_len {
        return Err(RomWeaverError::Validation(format!(
            "delta encoding length mismatch: header declared {delta_encoding_len} bytes but window needs {header_and_sections}"
        )));
    }

    reader.seek(SeekFrom::Start(window_end))?;

    Ok(Some(WindowIndex {
        win_indicator,
        source_kind,
        source_segment_size,
        source_segment_position,
        delta_encoding_len,
        target_window_size,
        delta_indicator,
        checksum,
        data_start,
        data_len,
        inst_start,
        inst_len,
        addr_start,
        addr_len,
        output_offset,
    }))
}

fn decode_window_task(
    task: &WindowTask,
    patch_path: &Path,
    input_path: &Path,
    input_len: u64,
    patch_header: &[u8],
    validate_checksums: bool,
) -> Result<DecodedWindow> {
    let mut input_reader = BufReader::new(File::open(input_path)?);
    let source = match task.window.source_kind {
        None => Vec::new(),
        Some(WindowSourceKind::Target) => {
            return Err(RomWeaverError::Validation(
                "parallel decoding cannot be used for VCD_TARGET windows".into(),
            ));
        }
        Some(WindowSourceKind::Source) => read_source_segment(
            &mut input_reader,
            task.window.source_segment_position,
            task.window.source_segment_size,
            input_len,
            "source",
        )?,
    };
    let mut patch_reader = BufReader::new(File::open(patch_path)?);
    let target = decode_window_with_xdelta(
        &mut patch_reader,
        patch_header,
        &task.window,
        &source,
        validate_checksums,
    )?;

    if let Some(parent) = task.temp_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&task.temp_path, &target)?;

    Ok(DecodedWindow {
        index: task.index,
        output_offset: task.window.output_offset,
        len: target.len() as u64,
        temp_path: task.temp_path.clone(),
    })
}

fn apply_windows_with_target_sources(
    patch: &ParsedPatch,
    patch_path: &Path,
    input_path: &Path,
    output_path: &Path,
    input_len: u64,
    validate_checksums: bool,
) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut input_reader = BufReader::new(File::open(input_path)?);
    let mut output = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(output_path)?;
    let mut assembled_output_size = 0u64;

    for window in &patch.windows {
        if window.output_offset != assembled_output_size {
            return Err(RomWeaverError::Validation(format!(
                "window output offset mismatch: expected {assembled_output_size}, got {}",
                window.output_offset
            )));
        }

        let source = match window.source_kind {
            None => Vec::new(),
            Some(WindowSourceKind::Source) => read_source_segment(
                &mut input_reader,
                window.source_segment_position,
                window.source_segment_size,
                input_len,
                "source",
            )?,
            Some(WindowSourceKind::Target) => read_source_segment(
                &mut output,
                window.source_segment_position,
                window.source_segment_size,
                assembled_output_size,
                "target",
            )?,
        };

        let mut patch_reader = BufReader::new(File::open(patch_path)?);
        let target = decode_window_with_xdelta(
            &mut patch_reader,
            &patch.header_bytes,
            window,
            &source,
            validate_checksums,
        )?;
        output.seek(SeekFrom::Start(assembled_output_size))?;
        output.write_all(&target)?;
        assembled_output_size = checked_add(
            assembled_output_size,
            target.len() as u64,
            "assembled output size",
        )?;
    }

    Ok(())
}

fn create_base_flags(descriptor: &FormatDescriptor) -> c_int {
    if descriptor.name.eq_ignore_ascii_case("xdelta") {
        xdelta_ffi::XD3_ADLER32
    } else {
        0
    }
}

unsafe extern "C" fn read_source_block_callback(
    _stream: *mut xdelta_ffi::Xd3Stream,
    source: *mut xdelta_ffi::Xd3Source,
    block_number: xdelta_ffi::XoffT,
) -> c_int {
    let source = unsafe { &mut *source };
    let state = unsafe { &mut *(source.ioh as *mut SourceBlockReader) };
    match load_source_block(state, source, block_number) {
        Ok(()) => 0,
        Err(message) => {
            state.last_error = Some(message);
            xdelta_ffi::XD3_INTERNAL
        }
    }
}

fn load_source_block(
    state: &mut SourceBlockReader,
    source: &mut xdelta_ffi::Xd3Source,
    block_number: xdelta_ffi::XoffT,
) -> std::result::Result<(), String> {
    let block_size = state.buffer.len() as u64;
    let offset = (block_number as u64)
        .checked_mul(block_size)
        .ok_or_else(|| "xdelta source block offset overflowed u64".to_string())?;
    state
        .file
        .seek(SeekFrom::Start(offset))
        .map_err(|error| format!("failed to seek source block {block_number}: {error}"))?;
    let bytes_read = state
        .file
        .read(&mut state.buffer)
        .map_err(|error| format!("failed to read source block {block_number}: {error}"))?;

    source.curblkno = block_number;
    source.onblk = u32::try_from(bytes_read)
        .map_err(|_| "xdelta source block read is too large".to_string())?;
    source.curblk = state.buffer.as_ptr();

    if bytes_read < state.buffer.len() {
        source.max_blkno = block_number;
        source.onlastblk = source.onblk;
        source.eof_known = 1;
    }

    Ok(())
}

fn encode_patch_with_xdelta_streaming(
    source_path: &Path,
    target_path: &Path,
    output_path: &Path,
    flags: c_int,
) -> Result<CreatedPatchCandidate> {
    let source_len = fs::metadata(source_path)?.len();
    let target_len = fs::metadata(target_path)?.len();
    let window_size = preferred_xdelta_window(target_len, xdelta_ffi::XD3_DEFAULT_WINSIZE);
    let source_block_size = preferred_xdelta_window(source_len, xdelta_ffi::XD3_DEFAULT_WINSIZE);

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let output_file = File::create(output_path)?;
    let mut output = BufWriter::new(output_file);
    let mut stream = xdelta_ffi::Xd3Stream::zeroed();
    let mut config = xdelta_ffi::Xd3Config::with_flags(flags);
    config.winsize = xdelta_usize(window_size, "xdelta encoder window size")?;
    config.getblk = Some(read_source_block_callback);

    let mut source = xdelta_ffi::Xd3Source::zeroed();
    let mut source_state = if source_len > 0 {
        Some(SourceBlockReader::new(source_path, source_block_size)?)
    } else {
        None
    };

    let mut result = (|| -> Result<()> {
        let rc = unsafe { xdelta_ffi::xd3_config_stream(&mut stream, &mut config) };
        if rc != 0 {
            return Err(xdelta_stream_error(
                "configure",
                &stream,
                source_state.as_mut(),
                rc,
            ));
        }

        if let Some(state) = source_state.as_mut() {
            source.blksize = xdelta_usize(state.buffer.len(), "xdelta source block size")?;
            source.ioh = state as *mut SourceBlockReader as *mut c_void;
            source.max_winsize =
                xdelta_xoff(state.buffer.len() as u64, "xdelta source window size")?;
            let rc = unsafe {
                xdelta_ffi::xd3_set_source_and_size(
                    &mut stream,
                    &mut source,
                    xdelta_xoff(source_len, "xdelta source file size")?,
                )
            };
            if rc != 0 {
                return Err(xdelta_stream_error(
                    "configure source",
                    &stream,
                    source_state.as_mut(),
                    rc,
                ));
            }
        }

        let mut target = BufReader::new(File::open(target_path)?);
        let mut input_buffer = vec![0; window_size.max(1)];

        loop {
            let bytes_read = target.read(&mut input_buffer)?;
            let is_last_chunk = bytes_read < input_buffer.len();
            if is_last_chunk {
                stream.set_flags(stream.flags | xdelta_ffi::XD3_FLUSH);
            }
            stream.avail_input(
                input_buffer.as_ptr(),
                xdelta_usize(bytes_read, "xdelta input chunk size")?,
            );

            drive_xdelta_encoder(&mut stream, &mut output, source_state.as_mut())?;

            if is_last_chunk {
                break;
            }
        }

        output.flush()?;
        Ok(())
    })();

    if result.is_ok() {
        let rc = unsafe { xdelta_ffi::xd3_close_stream(&mut stream) };
        if rc != 0 {
            result = Err(xdelta_stream_error(
                "finalize",
                &stream,
                source_state.as_mut(),
                rc,
            ));
        }
    } else {
        unsafe {
            xdelta_ffi::xd3_abort_stream(&mut stream);
        }
    }

    unsafe {
        xdelta_ffi::xd3_free_stream(&mut stream);
    }

    result?;

    Ok(CreatedPatchCandidate {
        path: output_path.to_path_buf(),
        size: fs::metadata(output_path)?.len(),
    })
}

fn drive_xdelta_encoder<W: Write>(
    stream: &mut xdelta_ffi::Xd3Stream,
    output: &mut W,
    mut source_state: Option<&mut SourceBlockReader>,
) -> Result<()> {
    loop {
        let rc = unsafe { xdelta_ffi::xd3_encode_input(stream) };
        match rc {
            xdelta_ffi::XD3_OUTPUT => {
                let chunk = unsafe { stream.output_slice() };
                output.write_all(chunk)?;
                stream.consume_output();
            }
            xdelta_ffi::XD3_INPUT => return Ok(()),
            xdelta_ffi::XD3_WINSTART | xdelta_ffi::XD3_WINFINISH | xdelta_ffi::XD3_GOTHEADER => {}
            xdelta_ffi::XD3_GETSRCBLK => {
                return Err(RomWeaverError::Validation(
                    "xdelta encoder requested a source block without a callback".into(),
                ));
            }
            _ => {
                return Err(xdelta_stream_error(
                    "encode",
                    stream,
                    source_state.as_deref_mut(),
                    rc,
                ));
            }
        }
    }
}

fn xdelta_stream_error(
    operation: &str,
    stream: &xdelta_ffi::Xd3Stream,
    source_state: Option<&mut SourceBlockReader>,
    rc: c_int,
) -> RomWeaverError {
    if let Some(state) = source_state {
        if let Some(message) = state.last_error.take() {
            return RomWeaverError::Validation(format!(
                "xdelta encoder failed to {operation} patch: {message}"
            ));
        }
    }

    let detail = unsafe {
        if !stream.msg.is_null() {
            Some(CStr::from_ptr(stream.msg).to_string_lossy().into_owned())
        } else {
            let message = xdelta_ffi::xd3_strerror(rc);
            if message.is_null() {
                None
            } else {
                Some(CStr::from_ptr(message).to_string_lossy().into_owned())
            }
        }
    };

    if let Some(detail) = detail.filter(|message| !message.is_empty()) {
        RomWeaverError::Validation(format!(
            "xdelta encoder failed to {operation} patch: {detail} (code {rc})"
        ))
    } else {
        RomWeaverError::Validation(format!(
            "xdelta encoder failed to {operation} patch (code {rc})"
        ))
    }
}

fn preferred_xdelta_window(file_len: u64, max_window: usize) -> usize {
    let bounded = file_len.clamp(xdelta_ffi::XD3_ALLOCSIZE as u64, max_window as u64) as usize;
    if bounded.is_power_of_two() {
        bounded
    } else {
        bounded.next_power_of_two().min(max_window)
    }
}

fn xdelta_usize(value: usize, label: &str) -> Result<xdelta_ffi::UsizeT> {
    u32::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("{label} exceeded xdelta limits")))
}

fn xdelta_xoff(value: u64, label: &str) -> Result<xdelta_ffi::XoffT> {
    xdelta_ffi::XoffT::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("{label} exceeded xdelta limits")))
}

#[cfg(test)]
fn encode_patch_with_xdelta_memory(source: &[u8], target: &[u8], flags: c_int) -> Result<Vec<u8>> {
    let target_len = u32::try_from(target.len()).map_err(|_| {
        RomWeaverError::Validation("xdelta encoder target input is too large".into())
    })?;
    let source_len = u32::try_from(source.len()).map_err(|_| {
        RomWeaverError::Validation("xdelta encoder source input is too large".into())
    })?;

    let max_capacity = u32::MAX as usize;
    let mut capacity = initial_encode_capacity(source.len(), target.len())?
        .min(max_capacity)
        .max(1);

    loop {
        let avail_output = u32::try_from(capacity).map_err(|_| {
            RomWeaverError::Validation("xdelta encoder output buffer is too large".into())
        })?;
        let mut output = vec![0; capacity];
        let mut output_size = avail_output;

        let rc = unsafe {
            xdelta_ffi::xd3_encode_memory(
                target.as_ptr(),
                target_len,
                source.as_ptr(),
                source_len,
                output.as_mut_ptr(),
                &mut output_size,
                avail_output,
                flags,
            )
        };
        match rc {
            0 => {
                output.truncate(output_size as usize);
                return Ok(output);
            }
            XD3_ENOSPC if capacity < max_capacity => {
                let next_capacity = capacity.saturating_mul(2).min(max_capacity);
                if next_capacity == capacity {
                    return Err(RomWeaverError::Validation(
                        "xdelta encoder ran out of output buffer space".into(),
                    ));
                }
                capacity = next_capacity;
            }
            XD3_ENOSPC => {
                return Err(RomWeaverError::Validation(
                    "xdelta encoder ran out of output buffer space".into(),
                ));
            }
            _ => {
                return Err(RomWeaverError::Validation(format!(
                    "xdelta encoder failed to create patch (code {rc})"
                )));
            }
        }
    }
}

#[cfg(test)]
fn initial_encode_capacity(source_len: usize, target_len: usize) -> Result<usize> {
    let doubled_target = target_len
        .checked_mul(2)
        .ok_or_else(|| RomWeaverError::Validation("xdelta encoder capacity overflowed".into()))?;
    let combined = source_len
        .checked_add(target_len)
        .ok_or_else(|| RomWeaverError::Validation("xdelta encoder capacity overflowed".into()))?;
    doubled_target
        .max(combined)
        .checked_add(4096)
        .ok_or_else(|| RomWeaverError::Validation("xdelta encoder capacity overflowed".into()))
}

fn decode_window_with_xdelta<R: Read + Seek>(
    patch_reader: &mut R,
    patch_header: &[u8],
    window: &WindowIndex,
    source_segment: &[u8],
    validate_checksums: bool,
) -> Result<Vec<u8>> {
    let patch_bytes = build_single_window_patch(patch_reader, patch_header, window)?;
    let decoded = decode_window_with_xdelta_memory(&patch_bytes, source_segment, window)?;

    if decoded.len() as u64 != window.target_window_size {
        return Err(RomWeaverError::Validation(format!(
            "xdelta decoder produced {} byte(s) but expected {}",
            decoded.len(),
            window.target_window_size
        )));
    }

    if validate_checksums {
        if let Some(expected) = window.checksum {
            let actual = adler32(&decoded);
            if actual != expected {
                return Err(RomWeaverError::Validation(format!(
                    "target window checksum mismatch: expected 0x{expected:08X}, got 0x{actual:08X}"
                )));
            }
        }
    }

    Ok(decoded)
}

fn decode_window_with_xdelta_memory(
    patch_bytes: &[u8],
    source_segment: &[u8],
    window: &WindowIndex,
) -> Result<Vec<u8>> {
    let patch_len = u32::try_from(patch_bytes.len()).map_err(|_| {
        RomWeaverError::Validation("xdelta decoder patch window is too large".into())
    })?;
    let source_len = u32::try_from(source_segment.len()).map_err(|_| {
        RomWeaverError::Validation("xdelta decoder source window is too large".into())
    })?;
    let expected_len = u32::try_from(window.target_window_size).map_err(|_| {
        RomWeaverError::Validation("xdelta decoder output window is too large".into())
    })?;
    let output_capacity = usize::try_from(expected_len).map_err(|_| {
        RomWeaverError::Validation("xdelta decoder output window is too large".into())
    })?;
    let mut output = vec![0; output_capacity.max(1)];
    let mut output_len = expected_len;

    let rc = unsafe {
        xdelta_ffi::xd3_decode_memory(
            patch_bytes.as_ptr(),
            patch_len,
            source_segment.as_ptr(),
            source_len,
            output.as_mut_ptr(),
            &mut output_len,
            expected_len.max(1),
            xdelta_ffi::XD3_ADLER32_NOVER,
        )
    };
    if rc != 0 {
        return Err(RomWeaverError::Validation(format!(
            "xdelta decoder failed to decode window at output offset {} (code {rc})",
            window.output_offset
        )));
    }

    output.truncate(output_len as usize);
    Ok(output)
}

fn build_single_window_patch<R: Read + Seek>(
    patch_reader: &mut R,
    patch_header: &[u8],
    window: &WindowIndex,
) -> Result<Vec<u8>> {
    let data = read_section(patch_reader, window.data_start, window.data_len)?;
    let inst = read_section(patch_reader, window.inst_start, window.inst_len)?;
    let addr = read_section(patch_reader, window.addr_start, window.addr_len)?;

    let mut patch = patch_header.to_vec();
    let mut win_indicator = window.win_indicator;
    if matches!(window.source_kind, Some(WindowSourceKind::Target)) {
        // We decode each window in isolation. For VCD_TARGET windows we provide the referenced
        // target bytes as an explicit source segment and rewrite the window to VCD_SOURCE.
        win_indicator = (win_indicator & !WIN_TARGET) | WIN_SOURCE;
    }
    patch.push(win_indicator);
    if window.source_kind.is_some() {
        encode_varint(&mut patch, window.source_segment_size);
        encode_varint(&mut patch, 0);
    }
    encode_varint(&mut patch, window.delta_encoding_len);
    encode_varint(&mut patch, window.target_window_size);
    patch.push(window.delta_indicator);
    encode_varint(&mut patch, window.data_len);
    encode_varint(&mut patch, window.inst_len);
    encode_varint(&mut patch, window.addr_len);
    if let Some(checksum) = window.checksum {
        patch.extend_from_slice(&checksum.to_be_bytes());
    }
    patch.extend_from_slice(&data);
    patch.extend_from_slice(&inst);
    patch.extend_from_slice(&addr);
    Ok(patch)
}

fn read_section<R: Read + Seek>(reader: &mut R, start: u64, len: u64) -> Result<Vec<u8>> {
    let size = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation("section is too large to fit in memory on this platform".into())
    })?;
    let mut buffer = vec![0; size];
    reader.seek(SeekFrom::Start(start))?;
    reader.read_exact(&mut buffer)?;
    Ok(buffer)
}

fn skip_bytes<R: Read>(reader: &mut R, len: u64) -> Result<()> {
    let size = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation("section is too large to fit in memory on this platform".into())
    })?;
    let mut buffer = vec![0; size];
    reader.read_exact(&mut buffer)?;
    Ok(())
}

fn read_optional_u8<R: Read>(reader: &mut R) -> Result<Option<u8>> {
    let mut buffer = [0; 1];
    match reader.read_exact(&mut buffer) {
        Ok(()) => Ok(Some(buffer[0])),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_u8<R: Read>(reader: &mut R) -> Result<u8> {
    let mut buffer = [0; 1];
    reader.read_exact(&mut buffer)?;
    Ok(buffer[0])
}

fn read_be_u32<R: Read>(reader: &mut R) -> Result<u32> {
    let mut buffer = [0; 4];
    reader.read_exact(&mut buffer)?;
    Ok(u32::from_be_bytes(buffer))
}

fn read_varint<R: Read>(reader: &mut R) -> Result<(u64, usize)> {
    let mut value = 0u64;
    let mut count = 0usize;
    loop {
        let byte = read_u8(reader)?;
        count += 1;
        value = value
            .checked_mul(128)
            .and_then(|current| current.checked_add(u64::from(byte & 0x7F)))
            .ok_or_else(|| RomWeaverError::Validation("base-128 integer overflowed u64".into()))?;
        if byte & 0x80 == 0 {
            break;
        }
        if count >= 10 {
            return Err(RomWeaverError::Validation(
                "base-128 integer exceeds the supported length".into(),
            ));
        }
    }
    Ok((value, count))
}

fn encode_varint(bytes: &mut Vec<u8>, mut value: u64) {
    if value == 0 {
        bytes.push(0);
        return;
    }

    let mut stack = Vec::new();
    while value > 0 {
        stack.push((value % 128) as u8);
        value /= 128;
    }

    for (index, digit) in stack.iter().rev().enumerate() {
        let is_last = index + 1 == stack.len();
        bytes.push(if is_last { *digit } else { *digit | 0x80 });
    }
}

fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed u64")))
}

fn adler32(bytes: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in bytes {
        a = (a + u32::from(byte)) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        os::raw::c_int,
        path::PathBuf,
        process,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{CancellationToken, NoopProgressSink, ThreadBudget};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);
    const XD3_ADLER32: c_int = xdelta_ffi::XD3_ADLER32;
    const XD3_SEC_DJW: c_int = xdelta_ffi::XD3_SEC_DJW;
    const XD3_SEC_FGK: c_int = xdelta_ffi::XD3_SEC_FGK;
    const XD3_NOCOMPRESS: c_int = xdelta_ffi::XD3_NOCOMPRESS;

    #[derive(Clone)]
    struct TestWindow {
        win_indicator: u8,
        source_segment_size: Option<u64>,
        source_segment_position: Option<u64>,
        target_window_size: u64,
        checksum: Option<u32>,
        data: Vec<u8>,
        inst: Vec<u8>,
        addr: Vec<u8>,
    }

    #[derive(Default)]
    struct TestPatch {
        version: u8,
        header_flags: u8,
        secondary_id: Option<u8>,
        code_table_near: Option<u8>,
        code_table_same: Option<u8>,
        code_table_data: Vec<u8>,
        app_header: Vec<u8>,
        windows: Vec<TestWindow>,
    }

    #[test]
    fn parse_and_apply_basic_source_patch() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: expected.len() as u64,
                checksum: None,
                data: b"new".to_vec(),
                inst: vec![22, 4, 22],
                addr: encode_all_varints(&[0, 9]),
            }],
            ..Default::default()
        });

        let mut reader = Cursor::new(&patch_bytes);
        let parsed = parse_patch(&mut reader).expect("parse patch");
        assert_eq!(parsed.windows.len(), 1);

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_diff);
        assert!(capabilities.threaded_output);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_supports_overlapping_target_copy() {
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: 0,
                source_segment_size: None,
                source_segment_position: None,
                target_window_size: 9,
                checksum: None,
                data: b"abc".to_vec(),
                inst: vec![4, 22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, b"unused").expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");

        assert_eq!(fs::read(output_path).expect("read output"), b"abcabcabc");
    }

    #[test]
    fn parse_supports_xdelta_app_header_and_checksum() {
        let input = b"abcabcabcabc";
        let expected = b"abcabcZZabcabc";
        let checksum = adler32(expected);
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_APP_HEADER,
            app_header: b"xdelta-test".to_vec(),
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: expected.len() as u64,
                checksum: Some(checksum),
                data: b"ZZ".to_vec(),
                inst: vec![22, 3, 22],
                addr: encode_all_varints(&[0, 6]),
            }],
            ..Default::default()
        });

        let mut reader = Cursor::new(&patch_bytes);
        let parsed = parse_patch(&mut reader).expect("parse patch");
        assert_eq!(parsed.windows.len(), 1);
        assert_eq!(parsed.windows[0].checksum, Some(checksum));

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .parse(&patch_path, &test_context())
            .expect("inspect patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_supports_vcd_target_windows_with_thread_fallback() {
        let input = b"unused";
        let expected = b"abcdef";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![
                TestWindow {
                    win_indicator: 0,
                    source_segment_size: None,
                    source_segment_position: None,
                    target_window_size: 3,
                    checksum: None,
                    data: b"abc".to_vec(),
                    inst: vec![4],
                    addr: Vec::new(),
                },
                TestWindow {
                    win_indicator: WIN_TARGET,
                    source_segment_size: Some(3),
                    source_segment_position: Some(0),
                    target_window_size: 3,
                    checksum: None,
                    data: b"def".to_vec(),
                    inst: vec![4],
                    addr: Vec::new(),
                },
            ],
            ..Default::default()
        });

        let parsed = parse_patch(&mut Cursor::new(&patch_bytes)).expect("parse target windows");
        assert_eq!(parsed.windows.len(), 2);
        assert!(matches!(
            parsed.windows[1].source_kind,
            Some(WindowSourceKind::Target)
        ));

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply target-window patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(!execution.used_parallelism);
        assert_eq!(execution.effective_threads, 1);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn parse_supports_secondary_fixture() {
        let patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");

        let parsed = parse_patch(&mut Cursor::new(patch)).expect("parse secondary patch");
        assert!(parsed.secondary_compressor_id.is_some());
        assert_eq!(parsed.windows.len(), 1);
        assert!(
            parsed
                .windows
                .iter()
                .any(|window| window.delta_indicator != 0)
        );
    }

    #[test]
    fn parse_accepts_custom_code_table_headers() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_CODE_TABLE,
            code_table_near: Some(4),
            code_table_same: Some(3),
            code_table_data: vec![0x00],
            ..Default::default()
        });

        let parsed = parse_patch(&mut Cursor::new(patch_bytes)).expect("parse custom code table");
        assert!(parsed.windows.is_empty());
    }

    #[test]
    fn apply_fails_on_checksum_mismatch() {
        let input = b"abcabcabcabc";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 6,
                checksum: Some(0xDEADBEEF),
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("checksum mismatch");
        assert!(format!("{error}").contains("checksum mismatch"));
    }

    #[test]
    fn apply_can_ignore_checksum_mismatch() {
        let input = b"abcabcabcabc";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 6,
                checksum: Some(0xDEADBEEF),
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context().with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("checksum validation ignored");

        assert!(report.label.contains("checksum validation skipped"));
        assert_eq!(fs::read(output_path).expect("read output"), b"abcabc");
    }

    #[test]
    fn apply_rejects_multiple_patch_files() {
        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: PathBuf::from("input.bin"),
                    patches: vec![PathBuf::from("a.vcdiff"), PathBuf::from("b.vcdiff")],
                    output: PathBuf::from("output.bin"),
                },
                &test_context(),
            )
            .expect_err("multiple patches");
        assert!(format!("{error}").contains("exactly one patch"));
    }

    #[test]
    fn multi_window_patch_round_trips() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 6,
                    checksum: None,
                    data: Vec::new(),
                    inst: vec![22],
                    addr: encode_all_varints(&[0]),
                },
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 9,
                    checksum: None,
                    data: b"new".to_vec(),
                    inst: vec![4, 22],
                    addr: encode_all_varints(&[9]),
                },
            ],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_output);
        let inspect = handler
            .parse(&patch_path, &test_context())
            .expect("inspect patch");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(inspect.label.contains("2 window"));

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(4),
            )
            .expect("apply patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn multi_window_xdelta_patch_round_trips_with_parallel_decoder() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            app_header: b"xdelta-cli".to_vec(),
            windows: vec![
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 6,
                    checksum: None,
                    data: Vec::new(),
                    inst: vec![22],
                    addr: encode_all_varints(&[0]),
                },
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 9,
                    checksum: None,
                    data: b"new".to_vec(),
                    inst: vec![4, 22],
                    addr: encode_all_varints(&[9]),
                },
            ],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_diff);
        assert!(capabilities.threaded_output);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(4),
            )
            .expect("apply xdelta patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_vcdiff_patch_round_trips() {
        let input = b"hello old world";
        let expected = b"hello new world";

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&modified_path, expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "VCDIFF".into(),
                },
                &test_context(),
            )
            .expect("create vcdiff patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, None);

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply created vcdiff patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_xdelta_patch_prefers_secondary_when_it_is_smaller() {
        let (input, expected) = generated_secondary_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context_with_threads(8),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );
        assert!(report.label.contains("secondary compression"));

        let plain = encode_patch_with_xdelta_memory(&input, &expected, XD3_ADLER32)
            .expect("encode baseline xdelta patch");
        let secondary =
            encode_patch_with_xdelta_memory(&input, &expected, XD3_ADLER32 | XD3_SEC_DJW)
                .expect("encode secondary xdelta patch");
        assert!(
            secondary.len() < plain.len(),
            "fixture should benefit from secondary compression"
        );

        let patch = fs::read(&patch_path).expect("read patch");
        assert_eq!(patch.len(), secondary.len());
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, Some(1));

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply created xdelta patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_vcdiff_patch_from_empty_source_round_trips() {
        let input = Vec::new();
        let expected = b"streamed-from-empty-source".repeat(1024);

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "VCDIFF".into(),
                },
                &test_context(),
            )
            .expect("create vcdiff patch from empty source");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, None);
        assert!(!parsed.windows.is_empty());
        assert!(
            parsed
                .windows
                .iter()
                .all(|window| window.source_kind.is_none())
        );

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply created vcdiff patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_xdelta_large_streaming_patch_round_trips_with_parallel_apply() {
        let (input, expected) = generated_large_streaming_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context(),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert!(
            parsed.windows.len() >= 2,
            "expected streaming create to produce multiple windows for >8 MiB input"
        );

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply created xdelta patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn secondary_fixture_applies_with_parallel_fallback() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-djw.xdelta"), &patch_path).expect("copy patch fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let inspect = handler
            .parse(&patch_path, &test_context())
            .expect("inspect secondary patch");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply secondary patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(!execution.used_parallelism);
        assert_eq!(execution.effective_threads, 1);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn generated_fgk_secondary_patch_round_trips() {
        let (input, expected) = generated_secondary_source_and_target();
        let patch_bytes = encode_secondary_patch(
            &input,
            &expected,
            XD3_SEC_FGK | XD3_ADLER32 | XD3_NOCOMPRESS,
        );

        let parsed = parse_patch(&mut Cursor::new(&patch_bytes)).expect("parse fgk patch");
        assert_eq!(parsed.secondary_compressor_id, Some(16));
        assert!(
            parsed
                .windows
                .iter()
                .any(|window| window.delta_indicator != 0)
        );

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply fgk patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_fails_for_unknown_secondary_compressor_id() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = 0x7F;

        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse unknown secondary patch");
        assert_eq!(parsed.secondary_compressor_id, Some(0x7F));

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("unknown secondary compressor should fail");
        assert!(format!("{error}").contains("xdelta decoder failed"));
    }

    #[test]
    fn apply_fails_for_corrupted_secondary_stream() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse secondary patch");
        let data_offset = parsed.windows[0].data_start as usize;
        patch[data_offset + 8] ^= 0x20;

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("corrupted secondary stream should fail");
        let message = format!("{error}");
        assert!(message.contains("xdelta decoder failed") || message.contains("checksum mismatch"));
    }

    fn create_temp_dir() -> PathBuf {
        let unique = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-vcdiff-tests-{}-{timestamp}-{unique}",
            process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn test_context() -> OperationContext {
        test_context_with_threads(1)
    }

    fn test_context_with_threads(threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            create_temp_dir().join("context"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/vcdiff")
            .join(name)
    }

    fn generated_secondary_source_and_target() -> (Vec<u8>, Vec<u8>) {
        let source: Vec<u8> = (0..65_536)
            .map(|index| ((index * 31) & 0xFF) as u8)
            .collect();
        let mut target = Vec::new();
        let chunk = b"PATCH-DATA-BLOCK-ALPHA-BETA-GAMMA-";
        while target.len() < 70_000 {
            target.extend_from_slice(chunk);
            target.extend_from_slice(format!("{:04}", target.len() % 10_000).as_bytes());
        }
        target.truncate(70_000);
        (source, target)
    }

    fn generated_large_streaming_source_and_target() -> (Vec<u8>, Vec<u8>) {
        let source_len = (9 * 1024 * 1024) + 32_768;
        let mut source: Vec<u8> = (0..source_len)
            .map(|index| ((index * 31 + (index / 97)) & 0xFF) as u8)
            .collect();
        let mut target = source.clone();

        for (offset, replacement) in [
            (64_000usize, b"FIRST-WINDOW-PATCH-BLOCK".as_slice()),
            (4_200_000usize, b"MIDDLE-WINDOW-MUTATION".as_slice()),
            (8_600_000usize, b"SECOND-WINDOW-PATCH-BLOCK".as_slice()),
            (source_len - 8_192, b"TAIL-BLOCK-FOR-STREAMING".as_slice()),
        ] {
            target[offset..offset + replacement.len()].copy_from_slice(replacement);
        }

        source[128_000..128_000 + b"SOURCE-ONLY-DATA".len()].copy_from_slice(b"SOURCE-ONLY-DATA");

        (source, target)
    }

    fn encode_secondary_patch(source: &[u8], target: &[u8], flags: c_int) -> Vec<u8> {
        let input_len = u32::try_from(target.len()).expect("target too large for xdelta encode");
        let source_len = u32::try_from(source.len()).expect("source too large for xdelta encode");
        let capacity = (target.len() + source.len())
            .checked_mul(8)
            .and_then(|value| value.checked_add(4096))
            .expect("encode capacity overflow");
        let mut output = vec![0; capacity];
        let mut output_size = u32::try_from(output.len()).expect("encode buffer too large");

        let rc = unsafe {
            xdelta_ffi::xd3_encode_memory(
                target.as_ptr(),
                input_len,
                source.as_ptr(),
                source_len,
                output.as_mut_ptr(),
                &mut output_size,
                output_size,
                flags,
            )
        };
        assert_eq!(rc, 0, "xdelta encoder failed with code {rc}");
        output.truncate(output_size as usize);
        output
    }

    fn build_patch(patch: TestPatch) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&VCDIFF_MAGIC_BYTES);
        bytes.push(patch.version);
        bytes.push(patch.header_flags);

        if patch.header_flags & HDR_SECONDARY != 0 {
            bytes.push(patch.secondary_id.expect("secondary id"));
        }
        if patch.header_flags & HDR_CODE_TABLE != 0 {
            bytes.push(patch.code_table_near.expect("near size"));
            bytes.push(patch.code_table_same.expect("same size"));
            encode_varint(&mut bytes, patch.code_table_data.len() as u64);
            bytes.extend_from_slice(&patch.code_table_data);
        }
        if patch.header_flags & HDR_APP_HEADER != 0 {
            encode_varint(&mut bytes, patch.app_header.len() as u64);
            bytes.extend_from_slice(&patch.app_header);
        }

        for window in patch.windows {
            bytes.push(window.win_indicator);
            if let (Some(size), Some(position)) =
                (window.source_segment_size, window.source_segment_position)
            {
                encode_varint(&mut bytes, size);
                encode_varint(&mut bytes, position);
            }

            let mut delta = Vec::new();
            encode_varint(&mut delta, window.target_window_size);
            delta.push(0);
            encode_varint(&mut delta, window.data.len() as u64);
            encode_varint(&mut delta, window.inst.len() as u64);
            encode_varint(&mut delta, window.addr.len() as u64);
            if let Some(checksum) = window.checksum {
                delta.extend_from_slice(&checksum.to_be_bytes());
            }
            delta.extend_from_slice(&window.data);
            delta.extend_from_slice(&window.inst);
            delta.extend_from_slice(&window.addr);

            encode_varint(&mut bytes, delta.len() as u64);
            bytes.extend_from_slice(&delta);
        }

        bytes
    }

    fn encode_all_varints(values: &[u64]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for &value in values {
            encode_varint(&mut bytes, value);
        }
        bytes
    }

    fn encode_varint(bytes: &mut Vec<u8>, mut value: u64) {
        if value == 0 {
            bytes.push(0);
            return;
        }

        let mut stack = Vec::new();
        while value > 0 {
            stack.push((value % 128) as u8);
            value /= 128;
        }

        for (index, digit) in stack.iter().rev().enumerate() {
            let is_last = index + 1 == stack.len();
            bytes.push(if is_last { *digit } else { *digit | 0x80 });
        }
    }
}
