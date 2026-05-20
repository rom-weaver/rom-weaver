use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use lzma_rust2::{XzOptions, XzReader, XzWriter};
use oxidelta::{
    compress::{
        encoder::{CompressOptions, DeltaEncoder},
        secondary::SecondaryCompression,
    },
    vcdiff::{
        decoder::{self as oxidelta_decoder, DecodeError as OxideltaDecodeError},
        header::{VCD_ADLER32, VCD_SOURCE, VCD_TARGET, WindowHeader as OxideltaWindowHeader},
    },
};
use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};

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
const NATIVE_CHUNK_SIZE: usize = 64 * 1024;
const XDELTA_SECONDARY_MIN_INPUT: usize = 10;
const XDELTA_SECONDARY_MIN_SAVINGS: usize = 2;
const XDELTA_DJW_SECONDARY_ID: u8 = 1;
const XDELTA_LZMA_SECONDARY_ID: u8 = 2;
const XDELTA_FGK_SECONDARY_ID: u8 = 16;
const XDELTA_SECONDARY_CANDIDATES: [u8; 3] = [
    XDELTA_DJW_SECONDARY_ID,
    XDELTA_LZMA_SECONDARY_ID,
    XDELTA_FGK_SECONDARY_ID,
];
const DJW_MAX_CODELEN: usize = 20;
const DJW_TOTAL_CODES: usize = DJW_MAX_CODELEN + 2;
const DJW_BASIC_CODES: usize = 5;
const DJW_RUN_CODES: usize = 2;
const DJW_EXTRA_12OFFSET: usize = DJW_BASIC_CODES + DJW_RUN_CODES;
const DJW_EXTRA_CODE_BITS: usize = 4;
const DJW_MAX_GROUPS: usize = 8;
const DJW_GROUP_BITS: usize = 3;
const DJW_SECTORSZ_MULT: usize = 5;
const DJW_SECTORSZ_BITS: usize = 5;
const DJW_SECTORSZ_MAX: usize = (1 << DJW_SECTORSZ_BITS) * DJW_SECTORSZ_MULT;
const DJW_MAX_CLCLEN: usize = 15;
const DJW_CLCLEN_BITS: usize = 4;
const DJW_MAX_GBCLEN: usize = 7;
const DJW_GBCLEN_BITS: usize = 3;
const DJW_RUN_1: usize = 1;
const DJW_ALPHABET_SIZE: usize = 256;

const DJW_ENCODE_12EXTRA: [u8; 15] = [9, 10, 3, 11, 2, 12, 13, 1, 14, 15, 16, 17, 18, 19, 20];
const DJW_ENCODE_12BASIC: [u8; 5] = [4, 5, 6, 7, 8];

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
        if patch.app_header.is_some() {
            label.push_str("; application header declared");
        }
        if let Some(code_table) = &patch.custom_code_table {
            label.push_str(&format!(
                "; custom code table declared (near={}, same={}, bytes={})",
                code_table.near_size, code_table.same_size, code_table.data_len
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
        if patch.custom_code_table.is_some() {
            return Err(RomWeaverError::Validation(
                "native VCDIFF backend does not support custom code tables".into(),
            ));
        }
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
        let input_path = request.input.clone();
        let validate_checksums_for_tasks = validate_checksums;
        let secondary_compressor_id = patch.secondary_compressor_id;

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
                            secondary_compressor_id,
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
                        secondary_compressor_id,
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
        let compare_secondary = is_xdelta_descriptor(self.descriptor);
        let include_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let xdelta_app_header = if compare_secondary {
            Some(build_default_xdelta_app_header(
                &request.original,
                &request.modified,
            ))
        } else {
            None
        };
        let output_extension = request.output.extension().and_then(|value| value.to_str());
        let baseline_raw_path = context
            .temp_paths()
            .next_path("vcdiff-create-baseline-raw", output_extension);
        let baseline_path = context
            .temp_paths()
            .next_path("vcdiff-create-baseline", output_extension);
        let thread_capability = ThreadCapability::single_threaded();

        let create_result = (|| -> Result<(ParsedPatch, rom_weaver_core::ThreadExecution)> {
            let planned_execution = context.plan_threads(thread_capability.clone());
            let baseline_raw = encode_patch_with_native_streaming(
                &request.original,
                &request.modified,
                &baseline_raw_path,
                create_native_compress_options(self.descriptor, include_checksums),
            )?;
            let baseline_secondary_source_path = baseline_raw.path.clone();
            let baseline = if xdelta_app_header.is_some() {
                recode_patch_with_xdelta_options(
                    &baseline_raw.path,
                    &baseline_path,
                    None,
                    xdelta_app_header.as_deref(),
                )?
            } else {
                baseline_raw
            };
            let selected = if compare_secondary {
                let mut best = baseline;
                for secondary_id in XDELTA_SECONDARY_CANDIDATES {
                    let candidate_path = context.temp_paths().next_path(
                        &format!("vcdiff-create-secondary-{secondary_id}"),
                        output_extension,
                    );
                    let candidate = recode_patch_with_xdelta_options(
                        &baseline_secondary_source_path,
                        &candidate_path,
                        Some(secondary_id),
                        xdelta_app_header.as_deref(),
                    );
                    if let Ok(candidate) = candidate {
                        if candidate.size < best.size {
                            best = candidate;
                        }
                    }
                }
                best
            } else {
                baseline
            };
            let execution = planned_execution;

            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&selected.path, &request.output)?;

            let mut reader = BufReader::new(File::open(&request.output)?);
            Ok((parse_patch(&mut reader)?, execution))
        })();

        let _ = fs::remove_file(&baseline_raw_path);
        let _ = fs::remove_file(&baseline_path);

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
    secondary_compressor_id: Option<u8>,
    custom_code_table: Option<CustomCodeTableInfo>,
    app_header: Option<Vec<u8>>,
    windows: Vec<WindowIndex>,
}

#[derive(Debug)]
struct CustomCodeTableInfo {
    near_size: u8,
    same_size: u8,
    data_len: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowSourceKind {
    Source,
    Target,
}

#[derive(Clone, Copy)]
enum DjwSectionKind {
    Data,
    Inst,
    Addr,
}

#[derive(Clone, Debug)]
struct WindowIndex {
    source_kind: Option<WindowSourceKind>,
    source_segment_size: u64,
    source_segment_position: u64,
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
    ensure_supported_secondary_compressor(secondary_compressor_id)?;

    let custom_code_table = if hdr_indicator & HDR_CODE_TABLE != 0 {
        let (code_table_len, _) = read_varint(reader)?;
        if code_table_len <= 2 {
            return Err(RomWeaverError::Validation(
                "invalid custom code table size".into(),
            ));
        }
        let near_size = read_u8(reader)?;
        let same_size = read_u8(reader)?;
        let code_table_data_len = code_table_len - 2;
        skip_bytes(reader, code_table_data_len)?;
        Some(CustomCodeTableInfo {
            near_size,
            same_size,
            data_len: code_table_data_len,
        })
    } else {
        None
    };

    let app_header = if hdr_indicator & HDR_APP_HEADER != 0 {
        let (app_header_len, _) = read_varint(reader)?;
        let len = usize::try_from(app_header_len).map_err(|_| {
            RomWeaverError::Validation("application header is too large to fit in memory".into())
        })?;
        let mut bytes = vec![0; len];
        reader.read_exact(&mut bytes)?;
        Some(bytes)
    } else {
        None
    };

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
    if secondary_compressor_id.is_none() && windows.iter().any(|window| window.delta_indicator != 0)
    {
        return Err(RomWeaverError::Validation(
            "patch declares compressed sections without a VCD_SECONDARY header".into(),
        ));
    }

    Ok(ParsedPatch {
        secondary_compressor_id,
        custom_code_table,
        app_header,
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
        source_kind,
        source_segment_size,
        source_segment_position,
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
    secondary_compressor_id: Option<u8>,
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
    let target = decode_window_with_native_engine(
        &mut patch_reader,
        &task.window,
        secondary_compressor_id,
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
        let target = decode_window_with_native_engine(
            &mut patch_reader,
            window,
            patch.secondary_compressor_id,
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

fn is_xdelta_descriptor(descriptor: &FormatDescriptor) -> bool {
    descriptor.name.eq_ignore_ascii_case("xdelta")
}

fn create_native_compress_options(
    descriptor: &FormatDescriptor,
    include_checksums: bool,
) -> CompressOptions {
    CompressOptions {
        checksum: is_xdelta_descriptor(descriptor) && include_checksums,
        secondary: SecondaryCompression::None,
        ..CompressOptions::default()
    }
}

fn encode_patch_with_native_streaming(
    source_path: &Path,
    target_path: &Path,
    output_path: &Path,
    options: CompressOptions,
) -> Result<CreatedPatchCandidate> {
    let source = fs::read(source_path)?;

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let output_file = File::create(output_path)?;
    let writer = BufWriter::with_capacity(NATIVE_CHUNK_SIZE, output_file);
    let mut encoder = DeltaEncoder::new(writer, &source, options);

    let mut target = BufReader::with_capacity(NATIVE_CHUNK_SIZE, File::open(target_path)?);
    let mut input_buffer = vec![0; NATIVE_CHUNK_SIZE];

    loop {
        let bytes_read = target.read(&mut input_buffer)?;
        if bytes_read == 0 {
            break;
        }

        encoder
            .write_target(&input_buffer[..bytes_read])
            .map_err(native_encode_error)?;
    }

    let (writer, _) = encoder.finish().map_err(native_encode_error)?;
    let output = writer.into_inner().map_err(|error| {
        RomWeaverError::Validation(format!(
            "native VCDIFF encoder failed to flush output: {}",
            error.into_error()
        ))
    })?;

    Ok(CreatedPatchCandidate {
        path: output_path.to_path_buf(),
        size: output.metadata()?.len(),
    })
}

fn native_encode_error(error: oxidelta::compress::encoder::EncodeError) -> RomWeaverError {
    RomWeaverError::Validation(format!("native VCDIFF encoder failed: {error}"))
}

fn recode_patch_with_xdelta_options(
    baseline_patch_path: &Path,
    output_path: &Path,
    secondary_compressor_id: Option<u8>,
    app_header: Option<&[u8]>,
) -> Result<CreatedPatchCandidate> {
    let baseline_bytes = fs::read(baseline_patch_path)?;
    let mut reader = Cursor::new(&baseline_bytes);
    let parsed = parse_patch(&mut reader)?;
    if parsed.custom_code_table.is_some() {
        return Err(RomWeaverError::Validation(
            "native VCDIFF secondary recoder does not support custom code tables".into(),
        ));
    }
    if secondary_compressor_id.is_some() && parsed.secondary_compressor_id.is_some() {
        return Err(RomWeaverError::Validation(
            "native VCDIFF secondary recoder expected an uncompressed baseline patch".into(),
        ));
    }

    let mut recoded = Vec::new();
    recoded.extend_from_slice(&VCDIFF_MAGIC_BYTES);
    recoded.push(VCDIFF_VERSION_STANDARD);
    let mut header_flags = 0u8;
    if secondary_compressor_id.is_some() {
        header_flags |= HDR_SECONDARY;
    }
    if app_header.is_some() {
        header_flags |= HDR_APP_HEADER;
    }
    recoded.push(header_flags);
    if let Some(id) = secondary_compressor_id {
        recoded.push(id);
    }
    if let Some(header) = app_header {
        encode_varint_raw(&mut recoded, header.len() as u64);
        recoded.extend_from_slice(header);
    }

    let mut patch_reader = Cursor::new(&baseline_bytes);
    for window in &parsed.windows {
        let data = read_section(&mut patch_reader, window.data_start, window.data_len)?;
        let inst = read_section(&mut patch_reader, window.inst_start, window.inst_len)?;
        let addr = read_section(&mut patch_reader, window.addr_start, window.addr_len)?;

        let (data_out, data_comp) = recode_window_section(
            &data,
            window.delta_indicator & DELTA_DATA_COMP != 0,
            secondary_compressor_id,
            DjwSectionKind::Data,
        )?;
        let (inst_out, inst_comp) = recode_window_section(
            &inst,
            window.delta_indicator & DELTA_INST_COMP != 0,
            secondary_compressor_id,
            DjwSectionKind::Inst,
        )?;
        let (addr_out, addr_comp) = recode_window_section(
            &addr,
            window.delta_indicator & DELTA_ADDR_COMP != 0,
            secondary_compressor_id,
            DjwSectionKind::Addr,
        )?;

        let delta_indicator = recode_delta_indicator(
            window.delta_indicator,
            data_comp,
            inst_comp,
            addr_comp,
            secondary_compressor_id,
        );

        let mut delta = Vec::new();
        encode_varint_raw(&mut delta, window.target_window_size);
        delta.push(delta_indicator);
        encode_varint_raw(&mut delta, data_out.len() as u64);
        encode_varint_raw(&mut delta, inst_out.len() as u64);
        encode_varint_raw(&mut delta, addr_out.len() as u64);
        if let Some(checksum) = window.checksum {
            delta.extend_from_slice(&checksum.to_be_bytes());
        }
        delta.extend_from_slice(&data_out);
        delta.extend_from_slice(&inst_out);
        delta.extend_from_slice(&addr_out);

        recoded.push(window_win_indicator(window));
        if window.source_kind.is_some() {
            encode_varint_raw(&mut recoded, window.source_segment_size);
            encode_varint_raw(&mut recoded, window.source_segment_position);
        }
        encode_varint_raw(&mut recoded, delta.len() as u64);
        recoded.extend_from_slice(&delta);
    }

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, &recoded)?;
    Ok(CreatedPatchCandidate {
        path: output_path.to_path_buf(),
        size: recoded.len() as u64,
    })
}

fn recode_window_section(
    section: &[u8],
    original_compressed: bool,
    secondary_compressor_id: Option<u8>,
    section_kind: DjwSectionKind,
) -> Result<(Vec<u8>, bool)> {
    match secondary_compressor_id {
        Some(XDELTA_LZMA_SECONDARY_ID) => maybe_compress_xdelta_lzma_section(section),
        Some(XDELTA_DJW_SECONDARY_ID) => maybe_compress_xdelta_djw_section(section, section_kind),
        Some(XDELTA_FGK_SECONDARY_ID) => maybe_compress_xdelta_fgk_section(section),
        Some(_) => {
            ensure_supported_secondary_compressor(secondary_compressor_id)?;
            Ok((section.to_vec(), original_compressed))
        }
        None => Ok((section.to_vec(), original_compressed)),
    }
}

fn recode_delta_indicator(
    original_indicator: u8,
    data_comp: bool,
    inst_comp: bool,
    addr_comp: bool,
    secondary_compressor_id: Option<u8>,
) -> u8 {
    if secondary_compressor_id.is_none() {
        return original_indicator;
    }
    let mut indicator = 0u8;
    if data_comp {
        indicator |= DELTA_DATA_COMP;
    }
    if inst_comp {
        indicator |= DELTA_INST_COMP;
    }
    if addr_comp {
        indicator |= DELTA_ADDR_COMP;
    }
    indicator
}

fn build_default_xdelta_app_header(source_path: &Path, target_path: &Path) -> Vec<u8> {
    let source = xdelta_app_header_name_component(source_path);
    let target = xdelta_app_header_name_component(target_path);
    format!("{target}//{source}/").into_bytes()
}

fn xdelta_app_header_name_component(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("-")
        .to_string()
}

fn maybe_compress_xdelta_lzma_section(section: &[u8]) -> Result<(Vec<u8>, bool)> {
    if section.len() < XDELTA_SECONDARY_MIN_INPUT {
        return Ok((section.to_vec(), false));
    }

    let compressed = xdelta_lzma2_compress(section)?;
    let mut candidate = Vec::new();
    encode_varint_raw(&mut candidate, section.len() as u64);
    candidate.extend_from_slice(&compressed);

    if xdelta_secondary_candidate_is_efficient(section.len(), candidate.len()) {
        Ok((candidate, true))
    } else {
        Ok((section.to_vec(), false))
    }
}

fn maybe_compress_xdelta_djw_section(
    section: &[u8],
    section_kind: DjwSectionKind,
) -> Result<(Vec<u8>, bool)> {
    if section.len() < XDELTA_SECONDARY_MIN_INPUT {
        return Ok((section.to_vec(), false));
    }

    let compressed = xdelta_djw_compress(section, section_kind)?;
    let mut candidate = Vec::new();
    encode_varint_raw(&mut candidate, section.len() as u64);
    candidate.extend_from_slice(&compressed);

    if xdelta_secondary_candidate_is_efficient(section.len(), candidate.len()) {
        Ok((candidate, true))
    } else {
        Ok((section.to_vec(), false))
    }
}

fn maybe_compress_xdelta_fgk_section(section: &[u8]) -> Result<(Vec<u8>, bool)> {
    if section.len() < XDELTA_SECONDARY_MIN_INPUT {
        return Ok((section.to_vec(), false));
    }

    let compressed = xdelta_fgk_compress(section)?;
    let mut candidate = Vec::new();
    encode_varint_raw(&mut candidate, section.len() as u64);
    candidate.extend_from_slice(&compressed);

    if xdelta_secondary_candidate_is_efficient(section.len(), candidate.len()) {
        Ok((candidate, true))
    } else {
        Ok((section.to_vec(), false))
    }
}

fn xdelta_secondary_candidate_is_efficient(original_size: usize, candidate_size: usize) -> bool {
    candidate_size < original_size.saturating_sub(XDELTA_SECONDARY_MIN_SAVINGS)
}

fn xdelta_djw_compress(section: &[u8], section_kind: DjwSectionKind) -> Result<Vec<u8>> {
    if section.is_empty() {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary encoder requires non-empty input".into(),
        ));
    }

    let (groups, sector_size) = djw_select_groups_and_sector_size(section.len(), section_kind)?;
    if groups > 1 {
        if let Ok(compressed) = xdelta_djw_compress_multi_group(section, groups, sector_size) {
            if let Ok(decoded) = decode_djw_secondary(&compressed, section.len()) {
                if decoded == section {
                    return Ok(compressed);
                }
            }
        }
    }

    let frequencies = djw_count_byte_frequencies(section);
    let (code_lengths, _) = djw_build_prefix_lengths(&frequencies, DJW_MAX_CODELEN)?;
    let codes = djw_build_codes_from_lengths(&code_lengths, DJW_MAX_CODELEN)?;

    let mut writer = DjwBitWriter::new();
    writer.write_bits(DJW_GROUP_BITS, 0)?;

    let mut prefix = DjwPrefix::new(code_lengths.to_vec());
    djw_encode_prefix(&mut writer, &mut prefix)?;

    for &symbol in section {
        let index = usize::from(symbol);
        let bits = usize::from(code_lengths[index]);
        if bits == 0 {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw secondary encoder produced zero-length code for symbol {index}"
            )));
        }
        writer.write_bits(bits, codes[index])?;
    }

    Ok(writer.finish())
}

fn djw_select_groups_and_sector_size(
    input_size: usize,
    section_kind: DjwSectionKind,
) -> Result<(usize, usize)> {
    let (groups, sector_size) = match section_kind {
        DjwSectionKind::Data => {
            if input_size < 1_000 {
                (1, 0)
            } else if input_size < 4_000 {
                (2, 10)
            } else if input_size < 7_000 {
                (3, 10)
            } else if input_size < 10_000 {
                (4, 10)
            } else if input_size < 25_000 {
                (5, 10)
            } else if input_size < 50_000 {
                (7, 20)
            } else if input_size < 100_000 {
                (8, 30)
            } else {
                (8, 70)
            }
        }
        DjwSectionKind::Inst => {
            if input_size < 7_000 {
                (1, 0)
            } else if input_size < 10_000 {
                (2, 50)
            } else if input_size < 25_000 {
                (3, 50)
            } else if input_size < 50_000 {
                (6, 40)
            } else {
                (8, 40)
            }
        }
        DjwSectionKind::Addr => {
            if input_size < 9_000 {
                (1, 0)
            } else if input_size < 25_000 {
                (2, 130)
            } else if input_size < 50_000 {
                (3, 130)
            } else if input_size < 100_000 {
                (5, 130)
            } else {
                (7, 130)
            }
        }
    };
    if groups > DJW_MAX_GROUPS {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder selected too many groups".into(),
        ));
    }
    if groups == 1 {
        return Ok((1, 0));
    }
    if sector_size < DJW_SECTORSZ_MULT
        || sector_size > DJW_SECTORSZ_MAX
        || sector_size % DJW_SECTORSZ_MULT != 0
    {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder selected an invalid sector size".into(),
        ));
    }
    Ok((groups, sector_size))
}

fn xdelta_djw_compress_multi_group(
    section: &[u8],
    groups: usize,
    sector_size: usize,
) -> Result<Vec<u8>> {
    if groups <= 1 || groups > DJW_MAX_GROUPS {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder received an invalid group count".into(),
        ));
    }
    if sector_size < DJW_SECTORSZ_MULT
        || sector_size > DJW_SECTORSZ_MAX
        || sector_size % DJW_SECTORSZ_MULT != 0
    {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder received an invalid sector size".into(),
        ));
    }

    let sectors = 1 + (section.len() - 1) / sector_size;
    let real_freq = djw_count_byte_frequencies(section);
    let mut selected_groups = vec![0u8; sectors];
    let mut group_freq = djw_seed_group_frequencies(groups);
    djw_smooth_group_frequencies(&mut group_freq, &real_freq);

    for _ in 0..3 {
        let (group_lengths, _) = djw_build_group_code_tables(&group_freq, &real_freq)?;
        djw_choose_best_sector_groups(section, sector_size, &group_lengths, &mut selected_groups)?;
        djw_rebuild_group_frequencies(section, sector_size, &selected_groups, &mut group_freq)?;
        djw_smooth_group_frequencies(&mut group_freq, &real_freq);
    }

    let (group_lengths, group_codes) = djw_build_group_code_tables(&group_freq, &real_freq)?;
    let mut writer = DjwBitWriter::new();
    writer.write_bits(DJW_GROUP_BITS, groups - 1)?;
    writer.write_bits(DJW_SECTORSZ_BITS, (sector_size / DJW_SECTORSZ_MULT) - 1)?;

    let mut group_symbols = Vec::with_capacity(groups * DJW_ALPHABET_SIZE);
    for lengths in &group_lengths {
        group_symbols.extend_from_slice(lengths);
    }
    let mut group_prefix = DjwPrefix::new(group_symbols);
    djw_encode_prefix(&mut writer, &mut group_prefix)?;

    let mut selector_prefix = DjwPrefix::new(selected_groups.clone());
    let mut selector_mtf = (0..groups)
        .map(|index| {
            u8::try_from(index).map_err(|_| {
                RomWeaverError::Validation("xdelta djw selector index exceeded u8".into())
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut selector_freq = vec![0u32; groups + 1];
    djw_compute_mtf_1_2(
        &mut selector_prefix,
        &mut selector_mtf,
        &mut selector_freq,
        groups,
    )?;
    let (selector_lengths, _) = djw_build_prefix_lengths(&selector_freq, DJW_MAX_GBCLEN)?;
    let selector_codes = djw_build_codes_from_lengths(&selector_lengths, DJW_MAX_GBCLEN)?;
    for &length in selector_lengths.iter().take(groups + 1) {
        writer.write_bits(DJW_GBCLEN_BITS, usize::from(length))?;
    }
    for &symbol in selector_prefix.mtfsym.iter().take(selector_prefix.mcount) {
        let index = usize::from(symbol);
        let bits = usize::from(selector_lengths[index]);
        let code = selector_codes[index];
        writer.write_bits(bits, code)?;
    }

    let mut offset = 0usize;
    for &group in &selected_groups {
        let group_index = usize::from(group);
        if group_index >= groups {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw selector chose invalid group index {group_index}"
            )));
        }
        let end = (offset + sector_size).min(section.len());
        let lengths = &group_lengths[group_index];
        let codes = &group_codes[group_index];
        for &symbol in &section[offset..end] {
            let index = usize::from(symbol);
            let bits = usize::from(lengths[index]);
            if bits == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "xdelta djw secondary encoder produced zero-length code for symbol {index}"
                )));
            }
            writer.write_bits(bits, codes[index])?;
        }
        offset = end;
    }
    if offset != section.len() {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary encoder failed to encode all input bytes".into(),
        ));
    }

    Ok(writer.finish())
}

fn djw_seed_group_frequencies(groups: usize) -> Vec<[u32; DJW_ALPHABET_SIZE]> {
    let mut frequencies = vec![[0u32; DJW_ALPHABET_SIZE]; groups];
    for symbol in 0..DJW_ALPHABET_SIZE {
        let mut group = (symbol * groups) / DJW_ALPHABET_SIZE;
        if group >= groups {
            group = groups - 1;
        }
        frequencies[group][symbol] = 8;
    }
    frequencies
}

fn djw_smooth_group_frequencies(
    group_frequencies: &mut [[u32; DJW_ALPHABET_SIZE]],
    real_frequencies: &[u32; DJW_ALPHABET_SIZE],
) {
    for group in group_frequencies.iter_mut() {
        for symbol in 0..DJW_ALPHABET_SIZE {
            if real_frequencies[symbol] != 0 && group[symbol] == 0 {
                group[symbol] = 1;
            }
        }
    }
}

fn djw_build_group_code_tables(
    group_frequencies: &[[u32; DJW_ALPHABET_SIZE]],
    real_frequencies: &[u32; DJW_ALPHABET_SIZE],
) -> Result<(Vec<Vec<u8>>, Vec<Vec<usize>>)> {
    let mut lengths = Vec::with_capacity(group_frequencies.len());
    let mut codes = Vec::with_capacity(group_frequencies.len());
    for group in group_frequencies {
        let mut adjusted = *group;
        for symbol in 0..DJW_ALPHABET_SIZE {
            if adjusted[symbol] == 0 && real_frequencies[symbol] != 0 {
                adjusted[symbol] = 1;
            }
        }
        let (group_lengths, _) = djw_build_prefix_lengths(&adjusted, DJW_MAX_CODELEN)?;
        let group_codes = djw_build_codes_from_lengths(&group_lengths, DJW_MAX_CODELEN)?;
        lengths.push(group_lengths);
        codes.push(group_codes);
    }
    Ok((lengths, codes))
}

fn djw_choose_best_sector_groups(
    section: &[u8],
    sector_size: usize,
    group_lengths: &[Vec<u8>],
    selected_groups: &mut [u8],
) -> Result<()> {
    let expected_sectors = 1 + (section.len() - 1) / sector_size;
    if selected_groups.len() != expected_sectors {
        return Err(RomWeaverError::Validation(
            "xdelta djw selector vector has the wrong size".into(),
        ));
    }
    if group_lengths.is_empty() {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder has no group code tables".into(),
        ));
    }

    for (sector_index, sector) in section.chunks(sector_size).enumerate() {
        let mut winner = 0usize;
        let mut winner_cost = usize::MAX;

        for (group_index, lengths) in group_lengths.iter().enumerate() {
            let mut cost = 0usize;
            let mut valid = true;
            for &symbol in sector {
                let bits = usize::from(lengths[usize::from(symbol)]);
                if bits == 0 {
                    valid = false;
                    break;
                }
                cost = cost.saturating_add(bits);
            }
            if valid && cost < winner_cost {
                winner = group_index;
                winner_cost = cost;
            }
        }

        selected_groups[sector_index] = u8::try_from(winner).map_err(|_| {
            RomWeaverError::Validation("xdelta djw winner index exceeded u8".into())
        })?;
    }

    Ok(())
}

fn djw_rebuild_group_frequencies(
    section: &[u8],
    sector_size: usize,
    selected_groups: &[u8],
    group_frequencies: &mut [[u32; DJW_ALPHABET_SIZE]],
) -> Result<()> {
    for group in group_frequencies.iter_mut() {
        group.fill(0);
    }

    for (sector_index, sector) in section.chunks(sector_size).enumerate() {
        let group_index = usize::from(selected_groups[sector_index]);
        let group = group_frequencies.get_mut(group_index).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "xdelta djw selector chose invalid group index {group_index}"
            ))
        })?;
        for &symbol in sector {
            let slot = &mut group[usize::from(symbol)];
            *slot = slot.saturating_add(1);
        }
    }

    Ok(())
}

fn xdelta_fgk_compress(section: &[u8]) -> Result<Vec<u8>> {
    let mut state = FgkState::new(DJW_ALPHABET_SIZE)?;
    let mut writer = DjwBitWriter::new();

    for &symbol in section {
        let mut bits = state.fgk_encode_data(usize::from(symbol))?;
        while bits != 0 {
            bits -= 1;
            writer.write_bit(state.fgk_get_encoded_bit()?)?;
        }
    }

    Ok(writer.finish())
}

#[derive(Default)]
struct DjwBitWriter {
    output: Vec<u8>,
    current_byte: u8,
    current_mask: u16,
}

impl DjwBitWriter {
    fn new() -> Self {
        Self {
            output: Vec::new(),
            current_byte: 0,
            current_mask: 1,
        }
    }

    fn write_bit(&mut self, bit: u8) -> Result<()> {
        if bit > 1 {
            return Err(RomWeaverError::Validation(
                "xdelta secondary encoder received a non-bit value".into(),
            ));
        }
        if bit == 1 {
            self.current_byte |= self.current_mask as u8;
        }
        if self.current_mask == 0x80 {
            self.output.push(self.current_byte);
            self.current_byte = 0;
            self.current_mask = 1;
        } else {
            self.current_mask <<= 1;
        }
        Ok(())
    }

    fn write_bits(&mut self, bit_count: usize, value: usize) -> Result<()> {
        if bit_count == 0 || bit_count >= usize::BITS as usize {
            return Err(RomWeaverError::Validation(
                "xdelta secondary encoder invalid bit width".into(),
            ));
        }
        let mask = 1usize
            .checked_shl(u32::try_from(bit_count).unwrap_or(u32::MAX))
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta secondary encoder bit mask overflowed".into())
            })?;
        if value >= mask {
            return Err(RomWeaverError::Validation(
                "xdelta secondary encoder bit value out of range".into(),
            ));
        }
        let mut current = mask;
        while current != 1 {
            current >>= 1;
            self.write_bit(if value & current != 0 { 1 } else { 0 })?;
        }
        Ok(())
    }

    fn finish(mut self) -> Vec<u8> {
        if self.current_mask != 1 {
            self.output.push(self.current_byte);
        }
        self.output
    }
}

fn xdelta_lzma2_compress(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = XzWriter::new(Vec::new(), XzOptions::with_preset(6)).map_err(|error| {
        RomWeaverError::Validation(format!("xdelta lzma secondary init failed: {error}"))
    })?;
    encoder.write_all(bytes).map_err(|error| {
        RomWeaverError::Validation(format!("xdelta lzma secondary encode failed: {error}"))
    })?;
    encoder.flush().map_err(|error| {
        RomWeaverError::Validation(format!("xdelta lzma secondary finalize failed: {error}"))
    })?;
    Ok(encoder.into_inner())
}

fn xdelta_lzma2_decompress(bytes: &[u8], expected_size: usize) -> Result<Vec<u8>> {
    let mut decoder = XzReader::new(Cursor::new(bytes), false);
    let mut output = vec![0u8; expected_size];
    decoder.read_exact(&mut output).map_err(|error| {
        RomWeaverError::Validation(format!("xdelta lzma secondary decode failed: {error}"))
    })?;
    Ok(output)
}

fn window_win_indicator(window: &WindowIndex) -> u8 {
    let mut win_indicator = match window.source_kind {
        Some(WindowSourceKind::Source) => WIN_SOURCE,
        Some(WindowSourceKind::Target) => WIN_TARGET,
        None => 0,
    };
    if window.checksum.is_some() {
        win_indicator |= WIN_CHECKSUM;
    }
    win_indicator
}

fn encode_varint_raw(bytes: &mut Vec<u8>, mut value: u64) {
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

fn decode_varint_raw(bytes: &[u8]) -> Result<(u64, usize)> {
    let mut value = 0u64;
    for (index, byte) in bytes.iter().copied().enumerate() {
        value = value
            .checked_mul(128)
            .and_then(|current| current.checked_add(u64::from(byte & 0x7F)))
            .ok_or_else(|| RomWeaverError::Validation("base-128 integer overflowed u64".into()))?;
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
        if index >= 9 {
            break;
        }
    }
    Err(RomWeaverError::Validation(
        "base-128 integer exceeds the supported length".into(),
    ))
}

fn decode_window_with_native_engine<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    secondary_compressor_id: Option<u8>,
    source_segment: &[u8],
    validate_checksums: bool,
) -> Result<Vec<u8>> {
    let (data, inst, addr) = read_window_sections(patch_reader, window, secondary_compressor_id)?;
    let source_len = if window.source_kind.is_some() {
        window.source_segment_size
    } else {
        0
    };
    let header = build_native_window_header(window, source_len);
    let mut source: &[u8] = source_segment;
    let mut copy_buf = Vec::new();

    let decoded = oxidelta_decoder::decode_window(
        &header,
        &data,
        &inst,
        &addr,
        &mut source,
        validate_checksums,
        &mut copy_buf,
    )
    .map_err(|error| native_decode_error(error, window))?;

    if decoded.len() as u64 != window.target_window_size {
        return Err(RomWeaverError::Validation(format!(
            "native VCDIFF decoder produced {} byte(s) but expected {}",
            decoded.len(),
            window.target_window_size
        )));
    }

    if validate_checksums && let Some(expected) = window.checksum {
        let actual = adler32(&decoded);
        if actual != expected {
            return Err(RomWeaverError::Validation(format!(
                "target window checksum mismatch: expected 0x{expected:08X}, got 0x{actual:08X}"
            )));
        }
    }

    Ok(decoded)
}

fn read_window_sections<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    secondary_compressor_id: Option<u8>,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = read_section(patch_reader, window.data_start, window.data_len)?;
    let inst = read_section(patch_reader, window.inst_start, window.inst_len)?;
    let addr = read_section(patch_reader, window.addr_start, window.addr_len)?;

    if window.delta_indicator == 0 {
        return Ok((data, inst, addr));
    }

    if secondary_compressor_id == Some(XDELTA_LZMA_SECONDARY_ID)
        && let Ok(decoded) =
            try_decode_xdelta_lzma_sections(&data, &inst, &addr, window.delta_indicator)
    {
        return Ok(decoded);
    }

    if secondary_compressor_id == Some(XDELTA_DJW_SECONDARY_ID) {
        return try_decode_xdelta_djw_sections(&data, &inst, &addr, window.delta_indicator);
    }

    if secondary_compressor_id == Some(XDELTA_FGK_SECONDARY_ID) {
        return try_decode_xdelta_fgk_sections(&data, &inst, &addr, window.delta_indicator);
    }

    ensure_supported_secondary_compressor(secondary_compressor_id)?;

    oxidelta::compress::secondary::decompress_sections(
        &data,
        &inst,
        &addr,
        window.delta_indicator,
        secondary_compressor_id,
    )
    .map_err(|error| {
        RomWeaverError::Validation(format!(
            "native VCDIFF secondary decompression failed at output offset {}: {error}",
            window.output_offset
        ))
    })
}

fn try_decode_xdelta_lzma_sections(
    data: &[u8],
    inst: &[u8],
    addr: &[u8],
    delta_indicator: u8,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = decode_xdelta_lzma_section_if_flag(data, delta_indicator & DELTA_DATA_COMP != 0)?;
    let inst = decode_xdelta_lzma_section_if_flag(inst, delta_indicator & DELTA_INST_COMP != 0)?;
    let addr = decode_xdelta_lzma_section_if_flag(addr, delta_indicator & DELTA_ADDR_COMP != 0)?;
    Ok((data, inst, addr))
}

fn decode_xdelta_lzma_section_if_flag(section: &[u8], compressed: bool) -> Result<Vec<u8>> {
    if !compressed {
        return Ok(section.to_vec());
    }

    let (decoded_size, prefix_len) = decode_varint_raw(section)?;
    let payload = section.get(prefix_len..).ok_or_else(|| {
        RomWeaverError::Validation("xdelta lzma section payload is missing".into())
    })?;
    let expected = usize::try_from(decoded_size).map_err(|_| {
        RomWeaverError::Validation("xdelta lzma section decoded size is too large".into())
    })?;
    let decoded = xdelta_lzma2_decompress(payload, expected)?;
    if decoded.len() != expected {
        return Err(RomWeaverError::Validation(format!(
            "xdelta lzma section decoded to {} byte(s) but expected {}",
            decoded.len(),
            expected
        )));
    }
    Ok(decoded)
}

#[derive(Clone, Copy)]
struct DjwBitState {
    cur_byte: u8,
    cur_mask: u16,
}

impl DjwBitState {
    fn decode_init() -> Self {
        Self {
            cur_byte: 0,
            cur_mask: 0x100,
        }
    }
}

#[derive(Clone)]
struct DjwDecodeTable {
    inorder: Vec<u8>,
    base: Vec<usize>,
    limit: Vec<usize>,
    min_len: usize,
    max_len: usize,
}

fn decode_djw_secondary(input: &[u8], output_size: usize) -> Result<Vec<u8>> {
    if output_size == 0 {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary decoder invalid output size".into(),
        ));
    }

    let mut state = DjwBitState::decode_init();
    let mut input_pos = 0usize;
    let mut output = Vec::with_capacity(output_size);

    let groups = decode_djw_bits(&mut state, input, &mut input_pos, DJW_GROUP_BITS)? + 1;
    if groups == 0 || groups > DJW_MAX_GROUPS {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw secondary decoder invalid group count {groups}"
        )));
    }

    let sector_size = if groups > 1 {
        (decode_djw_bits(&mut state, input, &mut input_pos, DJW_SECTORSZ_BITS)? + 1)
            .checked_mul(DJW_SECTORSZ_MULT)
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "xdelta djw secondary decoder sector size overflowed".into(),
                )
            })?
    } else {
        output_size
    };
    let sectors = 1 + (output_size - 1) / sector_size;

    let mut cl_mtf = [0u8; DJW_TOTAL_CODES];
    let cl_decode_table = decode_djw_clclen_table(&mut state, input, &mut input_pos, &mut cl_mtf)?;

    let mut clen = vec![0u8; groups * DJW_ALPHABET_SIZE];
    decode_djw_1_2(
        &mut state,
        input,
        &mut input_pos,
        &cl_decode_table,
        &mut cl_mtf,
        groups * DJW_ALPHABET_SIZE,
        DJW_ALPHABET_SIZE,
        &mut clen,
    )?;

    let mut group_tables = Vec::with_capacity(groups);
    for group in 0..groups {
        let start = group * DJW_ALPHABET_SIZE;
        let end = start + DJW_ALPHABET_SIZE;
        group_tables.push(build_djw_decoder_table(
            &clen[start..end],
            DJW_ALPHABET_SIZE,
            DJW_MAX_CODELEN,
        )?);
    }

    let mut selected_groups = vec![0u8; sectors];
    if groups > 1 {
        let mut sel_clen = vec![0u8; groups + 1];
        let mut sel_mtf = vec![0u8; groups + 1];
        for i in 0..(groups + 1) {
            let code_len = decode_djw_bits(&mut state, input, &mut input_pos, DJW_GBCLEN_BITS)?;
            sel_clen[i] = u8::try_from(code_len).map_err(|_| {
                RomWeaverError::Validation("xdelta djw selector code length exceeded u8".into())
            })?;
            sel_mtf[i] = u8::try_from(i).map_err(|_| {
                RomWeaverError::Validation("xdelta djw selector index exceeded u8".into())
            })?;
        }

        let selector_table = build_djw_decoder_table(&sel_clen, groups + 1, DJW_MAX_GBCLEN)?;
        decode_djw_1_2(
            &mut state,
            input,
            &mut input_pos,
            &selector_table,
            &mut sel_mtf,
            sectors,
            0,
            &mut selected_groups,
        )?;
    }

    for sector_index in 0..sectors {
        let group_index = if groups > 1 {
            usize::from(selected_groups[sector_index])
        } else {
            0
        };
        if group_index >= group_tables.len() {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw secondary decoder selected invalid group index {group_index}"
            )));
        }

        let remaining = output_size.checked_sub(output.len()).ok_or_else(|| {
            RomWeaverError::Validation("xdelta djw output size underflowed".into())
        })?;
        let symbols = sector_size.min(remaining);
        let table = &group_tables[group_index];

        for _ in 0..symbols {
            let symbol =
                decode_djw_symbol(&mut state, input, &mut input_pos, table, DJW_ALPHABET_SIZE)?;
            output.push(u8::try_from(symbol).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "xdelta djw secondary decoder produced out-of-range symbol {symbol}"
                ))
            })?);
        }
    }

    if output.len() != output_size {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw secondary decoder produced {} byte(s) but expected {}",
            output.len(),
            output_size
        )));
    }

    Ok(output)
}

fn decode_djw_clclen_table(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    cl_mtf: &mut [u8; DJW_TOTAL_CODES],
) -> Result<DjwDecodeTable> {
    let num_codes = decode_djw_bits(state, input, input_pos, DJW_EXTRA_CODE_BITS)?
        .checked_add(DJW_EXTRA_12OFFSET)
        .ok_or_else(|| {
            RomWeaverError::Validation("xdelta djw code length count overflowed".into())
        })?;
    if num_codes > DJW_TOTAL_CODES {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw code length count {num_codes} exceeds limit {DJW_TOTAL_CODES}"
        )));
    }

    let mut cl_clen = vec![0u8; DJW_TOTAL_CODES];
    for value in cl_clen.iter_mut().take(num_codes) {
        *value = u8::try_from(decode_djw_bits(state, input, input_pos, DJW_CLCLEN_BITS)?)
            .map_err(|_| RomWeaverError::Validation("xdelta djw code length exceeded u8".into()))?;
    }

    init_djw_clen_mtf(cl_mtf);
    build_djw_decoder_table(&cl_clen, DJW_TOTAL_CODES, DJW_MAX_CLCLEN)
}

fn decode_djw_1_2(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    table: &DjwDecodeTable,
    mtf_values: &mut [u8],
    elements: usize,
    skip_offset: usize,
    output: &mut [u8],
) -> Result<()> {
    let mut index = 0usize;
    let mut repeat = 0usize;
    let mut mtf = 0usize;
    let mut shift = 0usize;

    while index < elements {
        if skip_offset != 0 && index >= skip_offset && output[index - skip_offset] == 0 {
            output[index] = 0;
            index += 1;
            continue;
        }

        if repeat != 0 {
            output[index] = mtf_values[0];
            repeat -= 1;
            index += 1;
            continue;
        }

        if mtf != 0 {
            let symbol = djw_update_mtf(mtf_values, mtf)?;
            output[index] = symbol;
            mtf = 0;
            index += 1;
            continue;
        }

        mtf = decode_djw_symbol(state, input, input_pos, table, DJW_TOTAL_CODES)?;
        if mtf <= DJW_RUN_1 {
            repeat = (mtf + 1)
                .checked_shl(u32::try_from(shift).unwrap_or(u32::MAX))
                .ok_or_else(|| {
                    RomWeaverError::Validation("xdelta djw repeat count overflowed".into())
                })?;
            mtf = 0;
            shift = shift
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("xdelta djw shift overflowed".into()))?;
        } else {
            mtf -= 1;
            shift = 0;
        }
    }

    if repeat != 0 {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary decoder invalid repeat code".into(),
        ));
    }

    Ok(())
}

fn build_djw_decoder_table(
    code_lengths: &[u8],
    alphabet_size: usize,
    max_code_len: usize,
) -> Result<DjwDecodeTable> {
    if code_lengths.len() < alphabet_size {
        return Err(RomWeaverError::Validation(
            "xdelta djw decoder table input is too short".into(),
        ));
    }

    let mut counts = vec![0usize; max_code_len + 1];
    for &code_len in code_lengths.iter().take(alphabet_size) {
        let value = usize::from(code_len);
        if value > max_code_len {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw code length {value} exceeds max {max_code_len}"
            )));
        }
        counts[value] += 1;
    }

    let mut min_len = None;
    let mut max_len = None;
    for (length, &count) in counts.iter().enumerate().skip(1) {
        if count != 0 {
            min_len.get_or_insert(length);
            max_len = Some(length);
        }
    }

    let min_len = min_len.ok_or_else(|| {
        RomWeaverError::Validation("xdelta djw decoder table has no symbols".into())
    })?;
    let max_len = max_len.unwrap_or(min_len);

    let mut base = vec![0usize; max_code_len + 2];
    let mut limit = vec![0usize; max_code_len + 2];
    let mut cursor = vec![0usize; max_code_len + 2];
    let mut inorder = vec![0u8; alphabet_size];

    base[min_len] = 0;
    limit[min_len] = counts[min_len]
        .checked_sub(1)
        .ok_or_else(|| RomWeaverError::Validation("xdelta djw invalid prefix table".into()))?;
    cursor[min_len] = 0;

    for length in (min_len + 1)..=max_len {
        let previous = (limit[length - 1] + 1) << 1;
        cursor[length] = cursor[length - 1]
            .checked_add(counts[length - 1])
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta djw prefix cursor overflowed".into())
            })?;
        limit[length] = previous
            .checked_add(counts[length])
            .and_then(|value| value.checked_sub(1))
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta djw prefix limit overflowed".into())
            })?;
        base[length] = previous.checked_sub(cursor[length]).ok_or_else(|| {
            RomWeaverError::Validation("xdelta djw prefix base overflowed".into())
        })?;
    }

    for (symbol, &code_len) in code_lengths.iter().take(alphabet_size).enumerate() {
        let length = usize::from(code_len);
        if length == 0 {
            continue;
        }
        let position = cursor[length];
        if position >= inorder.len() {
            return Err(RomWeaverError::Validation(
                "xdelta djw inorder table overflowed".into(),
            ));
        }
        inorder[position] = u8::try_from(symbol).map_err(|_| {
            RomWeaverError::Validation("xdelta djw symbol index exceeded u8".into())
        })?;
        cursor[length] += 1;
    }

    Ok(DjwDecodeTable {
        inorder,
        base,
        limit,
        min_len,
        max_len,
    })
}

fn decode_djw_symbol(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    table: &DjwDecodeTable,
    max_symbol: usize,
) -> Result<usize> {
    let mut code = 0usize;
    let mut bits = 0usize;

    loop {
        if state.cur_mask == 0x100 {
            if *input_pos >= input.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta djw secondary decoder reached end of input".into(),
                ));
            }
            state.cur_byte = input[*input_pos];
            *input_pos += 1;
            state.cur_mask = 1;
        }

        if bits == table.max_len {
            return Err(RomWeaverError::Validation(
                "xdelta djw secondary decoder encountered an invalid symbol".into(),
            ));
        }

        bits += 1;
        code <<= 1;
        if (usize::from(state.cur_byte) & usize::from(state.cur_mask)) != 0 {
            code |= 1;
        }
        state.cur_mask <<= 1;

        if bits >= table.min_len && code <= table.limit[bits] {
            if table.base[bits] > code {
                break;
            }
            let offset = code - table.base[bits];
            if offset < table.inorder.len() && offset <= max_symbol {
                return Ok(usize::from(table.inorder[offset]));
            }
            break;
        }
    }

    Err(RomWeaverError::Validation(
        "xdelta djw secondary decoder encountered an invalid symbol".into(),
    ))
}

fn decode_djw_bits(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    bit_count: usize,
) -> Result<usize> {
    if bit_count == 0 || bit_count >= usize::BITS as usize {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary decoder requested an invalid bit count".into(),
        ));
    }

    let mut value = 0usize;
    let mut mask = 1usize << bit_count;
    loop {
        if state.cur_mask == 0x100 {
            if *input_pos >= input.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta djw secondary decoder reached end of input".into(),
                ));
            }
            state.cur_byte = input[*input_pos];
            *input_pos += 1;
            state.cur_mask = 1;
        }

        mask >>= 1;
        if (usize::from(state.cur_byte) & usize::from(state.cur_mask)) != 0 {
            value |= mask;
        }
        state.cur_mask <<= 1;
        if mask == 1 {
            break;
        }
    }
    Ok(value)
}

fn init_djw_clen_mtf(cl_mtf: &mut [u8]) {
    if cl_mtf.len() < DJW_MAX_CODELEN + 1 {
        return;
    }
    let mut index = 0usize;
    cl_mtf[index] = 0;
    index += 1;
    for &value in &DJW_ENCODE_12BASIC {
        cl_mtf[index] = value;
        index += 1;
    }
    for &value in &DJW_ENCODE_12EXTRA {
        cl_mtf[index] = value;
        index += 1;
    }
}

fn djw_update_mtf(mtf_values: &mut [u8], mtf_index: usize) -> Result<u8> {
    if mtf_index >= mtf_values.len() {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw mtf index {mtf_index} is out of bounds"
        )));
    }

    let symbol = mtf_values[mtf_index];
    for index in (1..=mtf_index).rev() {
        mtf_values[index] = mtf_values[index - 1];
    }
    mtf_values[0] = symbol;
    Ok(symbol)
}

#[derive(Clone, Copy, Default)]
struct DjwHeapNode {
    depth: u32,
    freq: u32,
    parent: usize,
}

#[derive(Clone)]
struct DjwPrefix {
    symbol: Vec<u8>,
    mtfsym: Vec<u8>,
    mcount: usize,
}

impl DjwPrefix {
    fn new(symbol: Vec<u8>) -> Self {
        Self {
            mtfsym: vec![0; symbol.len().max(1)],
            symbol,
            mcount: 0,
        }
    }
}

fn djw_count_byte_frequencies(section: &[u8]) -> [u32; DJW_ALPHABET_SIZE] {
    let mut freq = [0u32; DJW_ALPHABET_SIZE];
    for &byte in section {
        freq[usize::from(byte)] += 1;
    }
    freq
}

fn djw_heap_less(ents: &[DjwHeapNode], left: usize, right: usize) -> bool {
    ents[left].freq < ents[right].freq
        || (ents[left].freq == ents[right].freq && ents[left].depth < ents[right].depth)
}

fn djw_heap_insert(heap: &mut [usize], ents: &[DjwHeapNode], mut position: usize, entry: usize) {
    let mut parent = position / 2;
    while djw_heap_less(ents, entry, heap[parent]) {
        heap[position] = heap[parent];
        position = parent;
        parent = position / 2;
    }
    heap[position] = entry;
}

fn djw_heap_extract(heap: &mut [usize], ents: &[DjwHeapNode], heap_last: usize) -> usize {
    let smallest = heap[1];
    heap[1] = heap[heap_last + 1];
    let mut parent = 1usize;
    loop {
        let mut child = parent * 2;
        if child > heap_last {
            break;
        }
        if child < heap_last && djw_heap_less(ents, heap[child + 1], heap[child]) {
            child += 1;
        }
        if !djw_heap_less(ents, heap[child], heap[parent]) {
            break;
        }
        heap.swap(parent, child);
        parent = child;
    }
    smallest
}

fn djw_build_prefix_lengths(freq: &[u32], max_code_len: usize) -> Result<(Vec<u8>, usize)> {
    if freq.is_empty() {
        return Err(RomWeaverError::Validation(
            "xdelta djw prefix builder received empty frequency input".into(),
        ));
    }
    let asize = freq.len();
    let mut work_freq = freq.to_vec();

    loop {
        let mut heap = vec![0usize; asize + 1];
        let mut ents = vec![DjwHeapNode::default(); asize * 2 + 1];
        let mut heap_last = 0usize;
        let mut ents_size = 1usize;
        let mut total_bits = 0usize;

        ents[0].depth = 0;
        ents[0].freq = 0;
        heap[0] = 0;

        for &value in &work_freq {
            ents[ents_size].depth = 0;
            ents[ents_size].parent = 0;
            ents[ents_size].freq = value;
            if value != 0 {
                heap_last += 1;
                djw_heap_insert(&mut heap, &ents, heap_last, ents_size);
            }
            ents_size += 1;
        }

        if heap_last == 0 {
            return Err(RomWeaverError::Validation(
                "xdelta djw prefix builder requires at least one symbol".into(),
            ));
        }

        if heap_last == 1 {
            let fake = if work_freq[0] != 0 { asize - 1 } else { 0 };
            work_freq[fake] = 1;
            continue;
        }

        while heap_last > 1 {
            heap_last -= 1;
            let first = djw_heap_extract(&mut heap, &ents, heap_last);
            heap_last -= 1;
            let second = djw_heap_extract(&mut heap, &ents, heap_last);
            let node = ents_size;
            ents[node].freq = ents[first]
                .freq
                .checked_add(ents[second].freq)
                .ok_or_else(|| {
                    RomWeaverError::Validation("xdelta djw frequency sum overflowed".into())
                })?;
            ents[node].depth = 1 + ents[first].depth.max(ents[second].depth);
            ents[node].parent = 0;
            ents[first].parent = node;
            ents[second].parent = node;
            heap_last += 1;
            djw_heap_insert(&mut heap, &ents, heap_last, node);
            ents_size += 1;
        }

        let mut overflow = false;
        let mut lengths = vec![0u8; asize];
        for i in 1..=asize {
            let mut bits = 0usize;
            if ents[i].freq != 0 {
                let mut parent = i;
                while ents[parent].parent != 0 {
                    bits += 1;
                    parent = ents[parent].parent;
                }
                if bits > max_code_len {
                    overflow = true;
                }
                total_bits = total_bits
                    .checked_add(bits.saturating_mul(work_freq[i - 1] as usize))
                    .ok_or_else(|| {
                        RomWeaverError::Validation("xdelta djw total bit count overflowed".into())
                    })?;
            }
            lengths[i - 1] = u8::try_from(bits).map_err(|_| {
                RomWeaverError::Validation("xdelta djw code length exceeded u8".into())
            })?;
        }

        if !overflow {
            return Ok((lengths, total_bits));
        }

        for value in &mut work_freq {
            *value = value.saturating_div(2).saturating_add(1);
        }
    }
}

fn djw_build_codes_from_lengths(code_lengths: &[u8], max_code_len: usize) -> Result<Vec<usize>> {
    let mut min_len = max_code_len;
    let mut max_len = 0usize;
    for &length in code_lengths {
        let length = usize::from(length);
        if length > 0 && length < min_len {
            min_len = length;
        }
        if length > max_len {
            max_len = length;
        }
    }
    if max_len == 0 {
        return Err(RomWeaverError::Validation(
            "xdelta djw code table has no symbols".into(),
        ));
    }
    if max_len > max_code_len {
        return Err(RomWeaverError::Validation(
            "xdelta djw code length exceeded configured maximum".into(),
        ));
    }

    let mut code = 0usize;
    let mut codes = vec![0usize; code_lengths.len()];
    for length in min_len..=max_len {
        for (symbol, &symbol_len) in code_lengths.iter().enumerate() {
            if usize::from(symbol_len) == length {
                codes[symbol] = code;
                code = code.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("xdelta djw code counter overflowed".into())
                })?;
            }
        }
        code = code
            .checked_shl(1)
            .ok_or_else(|| RomWeaverError::Validation("xdelta djw code shift overflowed".into()))?;
    }
    Ok(codes)
}

fn djw_update_1_2(
    mtf_run: &mut usize,
    mtf_index: &mut usize,
    mtf_symbols: &mut [u8],
    frequencies: &mut [u32],
) -> Result<()> {
    loop {
        *mtf_run = mtf_run.saturating_sub(1);
        let code = if (*mtf_run & 1) != 0 { DJW_RUN_1 } else { 0 };
        if *mtf_index >= mtf_symbols.len() {
            return Err(RomWeaverError::Validation(
                "xdelta djw mtf symbol buffer overflowed".into(),
            ));
        }
        mtf_symbols[*mtf_index] = code as u8;
        *mtf_index += 1;
        frequencies[code] = frequencies[code].saturating_add(1);
        *mtf_run >>= 1;
        if *mtf_run < 1 {
            break;
        }
    }
    *mtf_run = 0;
    Ok(())
}

fn djw_compute_mtf_1_2(
    prefix: &mut DjwPrefix,
    mtf_values: &mut [u8],
    frequencies_out: &mut [u32],
    symbol_count: usize,
) -> Result<()> {
    frequencies_out.fill(0);
    let mut mtf_index = 0usize;
    let mut mtf_run = 0usize;

    for &symbol in &prefix.symbol {
        let position = mtf_values
            .iter()
            .position(|value| *value == symbol)
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "xdelta djw prefix symbol was missing from MTF table".into(),
                )
            })?;
        let _ = djw_update_mtf(mtf_values, position)?;

        if position == 0 {
            mtf_run = mtf_run.saturating_add(1);
            continue;
        }

        if mtf_run > 0 {
            djw_update_1_2(
                &mut mtf_run,
                &mut mtf_index,
                &mut prefix.mtfsym,
                frequencies_out,
            )?;
        }

        let encoded = position
            .checked_add(DJW_RUN_1)
            .ok_or_else(|| RomWeaverError::Validation("xdelta djw mtf offset overflowed".into()))?;
        if encoded >= symbol_count + 2 {
            return Err(RomWeaverError::Validation(
                "xdelta djw mtf symbol exceeded expected range".into(),
            ));
        }
        if mtf_index >= prefix.mtfsym.len() {
            return Err(RomWeaverError::Validation(
                "xdelta djw mtf output overflowed".into(),
            ));
        }
        prefix.mtfsym[mtf_index] = encoded as u8;
        mtf_index += 1;
        frequencies_out[encoded] = frequencies_out[encoded].saturating_add(1);
    }

    if mtf_run > 0 {
        djw_update_1_2(
            &mut mtf_run,
            &mut mtf_index,
            &mut prefix.mtfsym,
            frequencies_out,
        )?;
    }

    prefix.mcount = mtf_index;
    Ok(())
}

fn djw_compute_prefix_1_2(prefix: &mut DjwPrefix, frequencies: &mut [u32]) -> Result<()> {
    let mut code_len_mtf = [0u8; DJW_MAX_CODELEN + 1];
    init_djw_clen_mtf(&mut code_len_mtf);
    djw_compute_mtf_1_2(prefix, &mut code_len_mtf, frequencies, DJW_MAX_CODELEN)
}

fn djw_encode_prefix(writer: &mut DjwBitWriter, prefix: &mut DjwPrefix) -> Result<()> {
    let mut code_len_freq = [0u32; DJW_TOTAL_CODES];
    djw_compute_prefix_1_2(prefix, &mut code_len_freq)?;
    let (code_len_lengths, _) = djw_build_prefix_lengths(&code_len_freq, DJW_MAX_CLCLEN)?;
    let code_len_codes = djw_build_codes_from_lengths(&code_len_lengths, DJW_MAX_CLCLEN)?;

    let mut num_to_encode = DJW_TOTAL_CODES;
    while num_to_encode > DJW_EXTRA_12OFFSET && code_len_lengths[num_to_encode - 1] == 0 {
        num_to_encode -= 1;
    }
    if num_to_encode < DJW_EXTRA_12OFFSET {
        return Err(RomWeaverError::Validation(
            "xdelta djw prefix encoder computed invalid code count".into(),
        ));
    }
    let extra_codes = num_to_encode - DJW_EXTRA_12OFFSET;
    if extra_codes >= (1 << DJW_EXTRA_CODE_BITS) {
        return Err(RomWeaverError::Validation(
            "xdelta djw prefix encoder overflowed extra code count".into(),
        ));
    }

    writer.write_bits(DJW_EXTRA_CODE_BITS, extra_codes)?;
    for &length in code_len_lengths.iter().take(num_to_encode) {
        writer.write_bits(DJW_CLCLEN_BITS, usize::from(length))?;
    }

    for &symbol in prefix.mtfsym.iter().take(prefix.mcount) {
        let index = usize::from(symbol);
        let bits = usize::from(code_len_lengths[index]);
        let code = code_len_codes[index];
        writer.write_bits(bits, code)?;
    }

    Ok(())
}

#[derive(Clone, Copy, Default)]
struct FgkNode {
    weight: u32,
    parent: Option<usize>,
    left_child: Option<usize>,
    right_child: Option<usize>,
    left: Option<usize>,
    right: Option<usize>,
    my_block: Option<usize>,
}

#[derive(Clone, Copy, Default)]
struct FgkBlock {
    leader: Option<usize>,
    free_next: Option<usize>,
}

struct FgkState {
    alphabet_size: usize,
    zero_freq_count: usize,
    zero_freq_exp: usize,
    zero_freq_rem: usize,
    coded_depth: usize,
    coded_bits: Vec<u8>,
    blocks: Vec<FgkBlock>,
    free_block: Option<usize>,
    nodes: Vec<FgkNode>,
    decode_ptr: usize,
    remaining_zeros: Option<usize>,
    root_node: usize,
    free_node: usize,
}

impl FgkState {
    fn new(alphabet_size: usize) -> Result<Self> {
        let total_nodes = (2 * alphabet_size).checked_sub(1).ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk total node count overflowed".into())
        })?;
        let total_blocks = total_nodes.checked_mul(2).ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk block count overflowed".into())
        })?;

        let mut nodes = vec![FgkNode::default(); total_nodes];
        for index in 0..alphabet_size {
            let right_child = if index + 1 < alphabet_size {
                Some(index + 1)
            } else {
                None
            };
            let left_child = if index >= 1 { Some(index - 1) } else { None };
            nodes[index] = FgkNode {
                weight: 0,
                parent: None,
                left_child,
                right_child,
                left: None,
                right: None,
                my_block: None,
            };
        }

        let mut blocks = vec![FgkBlock::default(); total_blocks];
        for (index, block) in blocks.iter_mut().enumerate() {
            block.free_next = if index + 1 < total_blocks {
                Some(index + 1)
            } else {
                None
            };
        }

        let mut state = Self {
            alphabet_size,
            zero_freq_count: alphabet_size + 2,
            zero_freq_exp: 0,
            zero_freq_rem: 0,
            coded_depth: 0,
            coded_bits: vec![0; alphabet_size],
            blocks,
            free_block: Some(0),
            nodes,
            decode_ptr: 0,
            remaining_zeros: Some(0),
            root_node: 0,
            free_node: alphabet_size,
        };

        state.fgk_factor_remaining()?;
        state.fgk_factor_remaining()?;
        Ok(state)
    }

    fn fgk_decode_bit(&mut self, bit: u8) -> Result<bool> {
        if bit > 1 {
            return Err(RomWeaverError::Validation(
                "xdelta fgk decoder received an invalid bit".into(),
            ));
        }

        if self.nodes[self.decode_ptr].weight == 0 {
            let bits_required = if self.zero_freq_rem == 0 {
                self.zero_freq_exp
            } else {
                self.zero_freq_exp + 1
            };
            if self.coded_depth >= self.coded_bits.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta fgk coded bit buffer overflowed".into(),
                ));
            }
            self.coded_bits[self.coded_depth] = bit;
            self.coded_depth += 1;
            return Ok(self.coded_depth >= bits_required);
        }

        let next = if bit == 1 {
            self.nodes[self.decode_ptr].right_child.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk missing right child".into())
            })?
        } else {
            self.nodes[self.decode_ptr]
                .left_child
                .ok_or_else(|| RomWeaverError::Validation("xdelta fgk missing left child".into()))?
        };
        self.decode_ptr = next;

        if self.nodes[self.decode_ptr].left_child.is_none() {
            if self.nodes[self.decode_ptr].weight != 0 {
                return Ok(true);
            }
            return Ok(self.zero_freq_count == 1);
        }
        Ok(false)
    }

    fn fgk_find_nth_zero(&self, symbol_index: usize) -> Result<usize> {
        if symbol_index >= self.alphabet_size {
            return Err(RomWeaverError::Validation(format!(
                "xdelta fgk symbol index {symbol_index} exceeds alphabet size {}",
                self.alphabet_size
            )));
        }
        let mut cursor = self
            .remaining_zeros
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk zero list is empty".into()))?;
        let target = symbol_index;
        let mut index = 0usize;
        while cursor != target {
            cursor = self.nodes[cursor].right_child.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero list traversal failed".into())
            })?;
            index = index.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero index overflowed".into())
            })?;
        }
        Ok(index)
    }

    fn fgk_encode_data(&mut self, symbol_index: usize) -> Result<usize> {
        if symbol_index >= self.alphabet_size {
            return Err(RomWeaverError::Validation(format!(
                "xdelta fgk symbol index {symbol_index} exceeds alphabet size {}",
                self.alphabet_size
            )));
        }

        self.coded_depth = 0;
        let mut target = symbol_index;
        if self.nodes[target].weight == 0 {
            let where_zero = self.fgk_find_nth_zero(symbol_index)?;
            let bits_required = if self.zero_freq_rem == 0 {
                self.zero_freq_exp
            } else {
                self.zero_freq_exp + 1
            };
            let mut shift = 1usize;
            let mut bits_left = bits_required;
            while bits_left > 0 {
                if self.coded_depth >= self.coded_bits.len() {
                    return Err(RomWeaverError::Validation(
                        "xdelta fgk coded bit buffer overflowed".into(),
                    ));
                }
                self.coded_bits[self.coded_depth] = if (shift & where_zero) != 0 { 1 } else { 0 };
                self.coded_depth += 1;
                bits_left -= 1;
                shift <<= 1;
            }
            target = self.remaining_zeros.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero list is empty".into())
            })?;
        }

        while target != self.root_node {
            let parent = self.nodes[target].parent.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk node is missing a parent".into())
            })?;
            if self.coded_depth >= self.coded_bits.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta fgk coded bit buffer overflowed".into(),
                ));
            }
            self.coded_bits[self.coded_depth] = if self.nodes[parent].right_child == Some(target) {
                1
            } else {
                0
            };
            self.coded_depth += 1;
            target = parent;
        }

        self.fgk_update_tree(symbol_index)?;
        Ok(self.coded_depth)
    }

    fn fgk_get_encoded_bit(&mut self) -> Result<u8> {
        if self.coded_depth == 0 {
            return Err(RomWeaverError::Validation(
                "xdelta fgk encoded bit buffer was empty".into(),
            ));
        }
        self.coded_depth -= 1;
        Ok(self.coded_bits[self.coded_depth])
    }

    fn fgk_nth_zero(&self, mut index: usize) -> Result<usize> {
        let mut cursor = self
            .remaining_zeros
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk zero list is empty".into()))?;
        while index != 0 {
            if let Some(next) = self.nodes[cursor].right_child {
                cursor = next;
            } else {
                break;
            }
            index -= 1;
        }
        Ok(cursor)
    }

    fn fgk_decode_data(&mut self) -> Result<u8> {
        let mut symbol_index = self.decode_ptr;
        if self.nodes[self.decode_ptr].weight == 0 {
            let mut value = 0usize;
            if self.coded_depth > 0 {
                for &bit in self.coded_bits.iter().take(self.coded_depth - 1) {
                    value |= usize::from(bit);
                    value <<= 1;
                }
                value |= usize::from(self.coded_bits[self.coded_depth - 1]);
            }
            symbol_index = self.fgk_nth_zero(value)?;
        }

        self.coded_depth = 0;
        self.fgk_update_tree(symbol_index)?;
        self.decode_ptr = self.root_node;

        if symbol_index >= self.alphabet_size {
            return Err(RomWeaverError::Validation(format!(
                "xdelta fgk decoded symbol index {symbol_index} exceeds alphabet size {}",
                self.alphabet_size
            )));
        }
        u8::try_from(symbol_index).map_err(|_| {
            RomWeaverError::Validation("xdelta fgk decoded symbol index exceeded u8".into())
        })
    }

    fn fgk_update_tree(&mut self, symbol_index: usize) -> Result<()> {
        let mut current = if self.nodes[symbol_index].weight == 0 {
            self.fgk_increase_zero_weight(symbol_index)?
        } else {
            symbol_index
        };

        while current != self.root_node {
            self.fgk_move_right(current)?;
            self.fgk_promote(current)?;
            self.nodes[current].weight = self.nodes[current]
                .weight
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("xdelta fgk weight overflowed".into()))?;
            let parent = self.nodes[current].parent.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk node is missing a parent".into())
            })?;
            current = parent;
        }

        self.nodes[self.root_node].weight = self.nodes[self.root_node]
            .weight
            .checked_add(1)
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk root weight overflowed".into())
            })?;
        Ok(())
    }

    fn fgk_move_right(&mut self, move_fwd: usize) -> Result<()> {
        let block_index = self.nodes[move_fwd].my_block.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk node is missing a block".into())
        })?;
        let move_back = self.blocks[block_index].leader.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk block is missing a leader".into())
        })?;

        if move_fwd == move_back
            || self.nodes[move_fwd].parent == Some(move_back)
            || self.nodes[move_fwd].weight == 0
        {
            return Ok(());
        }

        let move_back_right = self.nodes[move_back].right.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk move-back node is missing right link".into())
        })?;
        self.nodes[move_back_right].left = Some(move_fwd);

        if let Some(left) = self.nodes[move_fwd].left {
            self.nodes[left].right = Some(move_back);
        }

        let tmp_right = self.nodes[move_fwd].right;
        self.nodes[move_fwd].right = self.nodes[move_back].right;
        if tmp_right == Some(move_back) {
            self.nodes[move_back].right = Some(move_fwd);
        } else {
            let tmp = tmp_right.ok_or_else(|| {
                RomWeaverError::Validation(
                    "xdelta fgk move-forward node is missing right link".into(),
                )
            })?;
            self.nodes[tmp].left = Some(move_back);
            self.nodes[move_back].right = Some(tmp);
        }

        let tmp_left = self.nodes[move_back].left;
        self.nodes[move_back].left = self.nodes[move_fwd].left;
        if tmp_left == Some(move_fwd) {
            self.nodes[move_fwd].left = Some(move_back);
        } else {
            let tmp = tmp_left.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk move-back node is missing left link".into())
            })?;
            self.nodes[tmp].right = Some(move_fwd);
            self.nodes[move_fwd].left = Some(tmp);
        }

        let move_fwd_parent = self.nodes[move_fwd].parent.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk move-forward parent missing".into())
        })?;
        let move_back_parent = self.nodes[move_back].parent.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk move-back parent missing".into())
        })?;

        let fwd_is_right = self.nodes[move_fwd_parent].right_child == Some(move_fwd);
        let back_is_right = self.nodes[move_back_parent].right_child == Some(move_back);

        self.nodes[move_fwd].parent = Some(move_back_parent);
        self.nodes[move_back].parent = Some(move_fwd_parent);

        if fwd_is_right {
            self.nodes[move_fwd_parent].right_child = Some(move_back);
        } else {
            self.nodes[move_fwd_parent].left_child = Some(move_back);
        }
        if back_is_right {
            self.nodes[move_back_parent].right_child = Some(move_fwd);
        } else {
            self.nodes[move_back_parent].left_child = Some(move_fwd);
        }

        self.blocks[block_index].leader = Some(move_fwd);
        Ok(())
    }

    fn fgk_promote(&mut self, node: usize) -> Result<()> {
        if self.nodes[node].weight == 0 {
            return Ok(());
        }

        let my_right = self.nodes[node].right.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk promote missing right link".into())
        })?;
        let my_left = self.nodes[node].left;
        let current_block = self.nodes[node]
            .my_block
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk promote missing block".into()))?;

        if my_left == self.nodes[node].right_child
            && self.nodes[node].left_child.is_some()
            && self.nodes[self.nodes[node].left_child.unwrap()].weight == 0
        {
            if self.nodes[node].weight == self.nodes[my_right].weight.saturating_sub(1)
                && my_right != self.root_node
            {
                self.fgk_free_block(current_block);
                let right_block = self.nodes[my_right].my_block.ok_or_else(|| {
                    RomWeaverError::Validation("xdelta fgk right node missing block".into())
                })?;
                self.nodes[node].my_block = Some(right_block);
                let left_child = self.nodes[node].left_child.unwrap();
                self.nodes[left_child].my_block = Some(right_block);
            }
            return Ok(());
        }

        if my_left == self.remaining_zeros {
            return Ok(());
        }

        if let Some(left_index) = my_left {
            if self.nodes[left_index].my_block == Some(current_block) {
                self.blocks[current_block].leader = Some(left_index);
            } else {
                self.fgk_free_block(current_block);
            }
        } else {
            self.fgk_free_block(current_block);
        }

        if self.nodes[node].weight == self.nodes[my_right].weight.saturating_sub(1)
            && my_right != self.root_node
        {
            self.nodes[node].my_block = self.nodes[my_right].my_block;
        } else {
            let block = self.fgk_make_block(node)?;
            self.nodes[node].my_block = Some(block);
        }

        Ok(())
    }

    fn fgk_increase_zero_weight(&mut self, symbol_index: usize) -> Result<usize> {
        let this_zero = symbol_index;
        if self.zero_freq_count == 1 {
            self.nodes[this_zero].right_child = None;
            let right = self.nodes[this_zero].right.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero node missing right link".into())
            })?;
            if self.nodes[right].weight == 1 {
                self.nodes[this_zero].my_block = self.nodes[right].my_block;
            } else {
                let block = self.fgk_make_block(this_zero)?;
                self.nodes[this_zero].my_block = Some(block);
            }
            self.remaining_zeros = None;
            return Ok(this_zero);
        }

        let zero_ptr = self
            .remaining_zeros
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk zero list is empty".into()))?;
        let new_internal = self.free_node;
        if new_internal >= self.nodes.len() {
            return Err(RomWeaverError::Validation(
                "xdelta fgk exhausted internal node capacity".into(),
            ));
        }
        self.free_node += 1;

        self.nodes[new_internal].parent = self.nodes[zero_ptr].parent;
        self.nodes[new_internal].right = self.nodes[zero_ptr].right;
        self.nodes[new_internal].weight = 0;
        self.nodes[new_internal].right_child = Some(this_zero);
        self.nodes[new_internal].left = Some(this_zero);

        if self.remaining_zeros == Some(self.root_node) {
            self.root_node = new_internal;
            let zero_block = self.fgk_make_block(this_zero)?;
            self.nodes[this_zero].my_block = Some(zero_block);
            let internal_block = self.fgk_make_block(new_internal)?;
            self.nodes[new_internal].my_block = Some(internal_block);
        } else {
            let right = self.nodes[new_internal].right.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk internal node missing right link".into())
            })?;
            self.nodes[right].left = Some(new_internal);

            let zero_parent = self.nodes[zero_ptr].parent.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero node missing parent".into())
            })?;
            if self.nodes[zero_parent].right_child == Some(zero_ptr) {
                self.nodes[zero_parent].right_child = Some(new_internal);
            } else {
                self.nodes[zero_parent].left_child = Some(new_internal);
            }

            if self.nodes[right].weight == 1 {
                self.nodes[new_internal].my_block = self.nodes[right].my_block;
            } else {
                let block = self.fgk_make_block(new_internal)?;
                self.nodes[new_internal].my_block = Some(block);
            }
            self.nodes[this_zero].my_block = self.nodes[new_internal].my_block;
        }

        self.fgk_eliminate_zero(this_zero)?;

        self.nodes[new_internal].left_child = self.remaining_zeros;
        self.nodes[this_zero].right = Some(new_internal);
        self.nodes[this_zero].left = self.remaining_zeros;
        self.nodes[this_zero].parent = Some(new_internal);
        self.nodes[this_zero].left_child = None;
        self.nodes[this_zero].right_child = None;

        let remaining = self.remaining_zeros.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk zero list became empty".into())
        })?;
        self.nodes[remaining].parent = Some(new_internal);
        self.nodes[remaining].right = Some(this_zero);

        Ok(this_zero)
    }

    fn fgk_eliminate_zero(&mut self, node: usize) -> Result<()> {
        if self.zero_freq_count == 1 {
            return Ok(());
        }

        self.fgk_factor_remaining()?;

        if self.nodes[node].left_child.is_none() {
            let next = self
                .remaining_zeros
                .and_then(|index| self.nodes[index].right_child)
                .ok_or_else(|| {
                    RomWeaverError::Validation("xdelta fgk zero list is missing a successor".into())
                })?;
            self.remaining_zeros = Some(next);
            self.nodes[next].left_child = None;
            return Ok(());
        }

        if self.nodes[node].right_child.is_none() {
            let left = self.nodes[node].left_child.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero node missing left child".into())
            })?;
            self.nodes[left].right_child = None;
            return Ok(());
        }

        let right = self.nodes[node].right_child.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk zero node missing right child".into())
        })?;
        let left = self.nodes[node].left_child.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk zero node missing left child".into())
        })?;
        self.nodes[right].left_child = Some(left);
        self.nodes[left].right_child = Some(right);
        Ok(())
    }

    fn fgk_make_block(&mut self, leader: usize) -> Result<usize> {
        let block = self.free_block.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk block allocator exhausted".into())
        })?;
        self.free_block = self.blocks[block].free_next;
        self.blocks[block].leader = Some(leader);
        self.blocks[block].free_next = None;
        Ok(block)
    }

    fn fgk_free_block(&mut self, block: usize) {
        self.blocks[block].leader = None;
        self.blocks[block].free_next = self.free_block;
        self.free_block = Some(block);
    }

    fn fgk_factor_remaining(&mut self) -> Result<()> {
        if self.zero_freq_count == 0 {
            return Err(RomWeaverError::Validation(
                "xdelta fgk zero-frequency count underflowed".into(),
            ));
        }
        self.zero_freq_count -= 1;
        let mut i = self.zero_freq_count;
        self.zero_freq_exp = 0;
        while i > 1 {
            self.zero_freq_exp += 1;
            i >>= 1;
        }
        let base = 1usize
            .checked_shl(u32::try_from(self.zero_freq_exp).unwrap_or(u32::MAX))
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk exponent overflowed".into()))?;
        self.zero_freq_rem = self
            .zero_freq_count
            .checked_sub(base)
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk remainder underflowed".into()))?;
        Ok(())
    }
}

fn decode_fgk_secondary(input: &[u8], output_size: usize) -> Result<Vec<u8>> {
    let mut state = FgkState::new(DJW_ALPHABET_SIZE)?;
    let mut output = Vec::with_capacity(output_size);
    let mut input_pos = 0usize;

    while output.len() < output_size {
        if input_pos >= input.len() {
            return Err(RomWeaverError::Validation(
                "xdelta fgk secondary decoder reached end of input".into(),
            ));
        }
        let byte = input[input_pos];
        input_pos += 1;
        let mut mask = 1u16;
        while mask != 0x100 {
            let bit = if (u16::from(byte) & mask) != 0 { 1 } else { 0 };
            let done = state.fgk_decode_bit(bit)?;
            mask <<= 1;
            if !done {
                continue;
            }
            let symbol = state.fgk_decode_data()?;
            output.push(symbol);
            if output.len() == output_size {
                break;
            }
        }
    }

    Ok(output)
}

fn try_decode_xdelta_djw_sections(
    data: &[u8],
    inst: &[u8],
    addr: &[u8],
    delta_indicator: u8,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = decode_xdelta_djw_section_if_flag(data, delta_indicator & DELTA_DATA_COMP != 0)?;
    let inst = decode_xdelta_djw_section_if_flag(inst, delta_indicator & DELTA_INST_COMP != 0)?;
    let addr = decode_xdelta_djw_section_if_flag(addr, delta_indicator & DELTA_ADDR_COMP != 0)?;
    Ok((data, inst, addr))
}

fn decode_xdelta_djw_section_if_flag(section: &[u8], compressed: bool) -> Result<Vec<u8>> {
    if !compressed {
        return Ok(section.to_vec());
    }

    let (decoded_size, prefix_len) = decode_varint_raw(section)?;
    let payload = section.get(prefix_len..).ok_or_else(|| {
        RomWeaverError::Validation("xdelta djw section payload is missing".into())
    })?;
    let decoded = decode_djw_secondary(
        payload,
        usize::try_from(decoded_size).map_err(|_| {
            RomWeaverError::Validation("xdelta djw section decoded size is too large".into())
        })?,
    )?;
    Ok(decoded)
}

fn try_decode_xdelta_fgk_sections(
    data: &[u8],
    inst: &[u8],
    addr: &[u8],
    delta_indicator: u8,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = decode_xdelta_fgk_section_if_flag(data, delta_indicator & DELTA_DATA_COMP != 0)?;
    let inst = decode_xdelta_fgk_section_if_flag(inst, delta_indicator & DELTA_INST_COMP != 0)?;
    let addr = decode_xdelta_fgk_section_if_flag(addr, delta_indicator & DELTA_ADDR_COMP != 0)?;
    Ok((data, inst, addr))
}

fn decode_xdelta_fgk_section_if_flag(section: &[u8], compressed: bool) -> Result<Vec<u8>> {
    if !compressed {
        return Ok(section.to_vec());
    }

    let (decoded_size, prefix_len) = decode_varint_raw(section)?;
    let payload = section.get(prefix_len..).ok_or_else(|| {
        RomWeaverError::Validation("xdelta fgk section payload is missing".into())
    })?;
    let decoded = decode_fgk_secondary(
        payload,
        usize::try_from(decoded_size).map_err(|_| {
            RomWeaverError::Validation("xdelta fgk section decoded size is too large".into())
        })?,
    )?;
    Ok(decoded)
}

fn build_native_window_header(window: &WindowIndex, source_len: u64) -> OxideltaWindowHeader {
    let mut win_ind = 0u8;
    match window.source_kind {
        Some(WindowSourceKind::Source) => {
            win_ind |= VCD_SOURCE;
        }
        Some(WindowSourceKind::Target) => {
            win_ind |= VCD_TARGET;
        }
        None => {}
    }

    if window.checksum.is_some() {
        win_ind |= VCD_ADLER32;
    }

    let mut header = OxideltaWindowHeader {
        win_ind,
        copy_window_len: source_len,
        copy_window_offset: 0,
        enc_len: 0,
        target_window_len: window.target_window_size,
        del_ind: 0,
        data_len: window.data_len,
        inst_len: window.inst_len,
        addr_len: window.addr_len,
        adler32: window.checksum,
    };
    header.enc_len = header.compute_enc_len();
    header
}

fn ensure_supported_secondary_compressor(secondary_id: Option<u8>) -> Result<()> {
    match secondary_id {
        Some(id)
            if id != XDELTA_LZMA_SECONDARY_ID
                && id != XDELTA_DJW_SECONDARY_ID
                && id != XDELTA_FGK_SECONDARY_ID =>
        {
            Err(RomWeaverError::Validation(format!(
                "native VCDIFF backend does not support secondary compressor ID {id}"
            )))
        }
        _ => Ok(()),
    }
}

fn native_decode_error(error: OxideltaDecodeError, window: &WindowIndex) -> RomWeaverError {
    RomWeaverError::Validation(format!(
        "native VCDIFF decoder failed at output offset {}: {error}",
        window.output_offset
    ))
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
        path::PathBuf,
        process,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{CancellationToken, NoopProgressSink, ThreadBudget};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

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
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(b"xdelta-test".as_slice())
        );

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

        let parsed = parse_patch(&mut Cursor::new(&patch_bytes)).expect("parse custom code table");
        assert!(parsed.windows.is_empty());
        let code_table = parsed
            .custom_code_table
            .as_ref()
            .expect("custom code table metadata");
        assert_eq!(code_table.near_size, 4);
        assert_eq!(code_table.same_size, 3);
        assert_eq!(code_table.data_len, 1);

        let temp = create_temp_dir();
        let patch_path = temp.join("custom-table.vcdiff");
        fs::write(&patch_path, &patch_bytes).expect("write patch");
        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .parse(&patch_path, &test_context())
            .expect("parse report");
        assert!(report.label.contains("custom code table declared"));
    }

    #[test]
    fn parse_rejects_custom_code_table_header_without_table_data() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_CODE_TABLE,
            code_table_near: Some(4),
            code_table_same: Some(3),
            code_table_data: Vec::new(),
            ..Default::default()
        });

        let error = parse_patch(&mut Cursor::new(&patch_bytes))
            .expect_err("custom code table without payload should fail");
        assert!(format!("{error}").contains("invalid custom code table size"));
    }

    #[test]
    fn apply_rejects_custom_code_table_headers() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_CODE_TABLE,
            code_table_near: Some(4),
            code_table_same: Some(3),
            code_table_data: vec![0x00],
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE,
                source_segment_size: Some(4),
                source_segment_position: Some(0),
                target_window_size: 4,
                checksum: None,
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
        fs::write(&input_path, b"abcd").expect("write input");
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
            .expect_err("custom code table should be rejected");
        assert!(format!("{error}").contains("does not support custom code tables"));
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
        assert_eq!(parsed.app_header, None);

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
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context_with_threads(8),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            !report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );
        assert!(report.label.contains("secondary compression"));

        let baseline_probe = temp.join("baseline-probe.xdelta");
        let baseline_with_header_probe = temp.join("baseline-header-probe.xdelta");
        let secondary_probe = temp.join("secondary-probe.xdelta");
        let expected_app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        let baseline = encode_patch_with_native_streaming(
            &input_path,
            &modified_path,
            &baseline_probe,
            create_native_compress_options(&crate::XDELTA, true),
        )
        .expect("encode baseline xdelta patch");
        let baseline_with_header = recode_patch_with_xdelta_options(
            &baseline.path,
            &baseline_with_header_probe,
            None,
            Some(expected_app_header.as_slice()),
        )
        .expect("add xdelta app header");
        let secondary = recode_patch_with_xdelta_options(
            &baseline_with_header.path,
            &secondary_probe,
            Some(XDELTA_LZMA_SECONDARY_ID),
            Some(expected_app_header.as_slice()),
        )
        .expect("encode secondary xdelta patch");
        let should_choose_secondary = secondary.size < baseline_with_header.size;

        let patch = fs::read(&patch_path).expect("read patch");
        assert_eq!(
            patch.len() as u64,
            secondary.size.min(baseline_with_header.size),
            "created patch should match the smallest native candidate"
        );
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(expected_app_header.as_slice())
        );
        if should_choose_secondary {
            assert_eq!(parsed.secondary_compressor_id, Some(2));
        } else {
            assert_eq!(parsed.secondary_compressor_id, None);
        }

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
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context(),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        let expected_app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(expected_app_header.as_slice())
        );
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
    fn create_xdelta_patch_can_skip_checksums_via_context_toggle() {
        let input = b"hello old world";
        let expected = b"hello new world";

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        fs::write(&input_path, input).expect("write input");
        fs::write(&modified_path, expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context().with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("create xdelta patch without checksums");

        let parsed = parse_patch(&mut Cursor::new(fs::read(&patch_path).expect("read patch")))
            .expect("parse created xdelta patch");
        assert!(!parsed.windows.is_empty());
        assert!(
            parsed
                .windows
                .iter()
                .all(|window| window.checksum.is_none())
        );
        let expected_app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(expected_app_header.as_slice())
        );
    }

    #[test]
    fn apply_supports_oxidelta_style_lzma_secondary_patch() {
        let (input, expected) = generated_secondary_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("oxidelta-style.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let patch = encode_patch_with_native_streaming(
            &input_path,
            &modified_path,
            &patch_path,
            CompressOptions {
                checksum: true,
                secondary: SecondaryCompression::Lzma,
                ..CompressOptions::default()
            },
        )
        .expect("encode oxidelta lzma patch");
        assert!(patch.size > 0);

        let parsed = parse_patch(&mut Cursor::new(fs::read(&patch_path).expect("read patch")))
            .expect("parse oxidelta patch");
        assert_eq!(
            parsed.secondary_compressor_id,
            Some(XDELTA_LZMA_SECONDARY_ID)
        );
        assert!(
            parsed
                .windows
                .iter()
                .any(|window| window.delta_indicator != 0)
        );

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply oxidelta lzma patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn recode_supports_all_xdelta_secondary_encoders() {
        let (input, expected) = generated_secondary_source_and_target();
        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let baseline_path = temp.join("baseline.xdelta");
        let baseline = encode_patch_with_native_streaming(
            &input_path,
            &modified_path,
            &baseline_path,
            create_native_compress_options(&crate::XDELTA, true),
        )
        .expect("encode baseline");
        assert!(baseline.size > 0);

        let app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        let handler = VcdiffPatchHandler::new(&crate::XDELTA);

        for secondary_id in XDELTA_SECONDARY_CANDIDATES {
            let patch_path = temp.join(format!("secondary-{secondary_id}.xdelta"));
            let output_path = temp.join(format!("output-{secondary_id}.bin"));
            let recoded = recode_patch_with_xdelta_options(
                &baseline.path,
                &patch_path,
                Some(secondary_id),
                Some(app_header.as_slice()),
            )
            .expect("recode patch");
            assert!(recoded.size > 0);

            let parsed = parse_patch(&mut Cursor::new(fs::read(&patch_path).expect("read patch")))
                .expect("parse recoded patch");
            assert_eq!(parsed.secondary_compressor_id, Some(secondary_id));
            assert_eq!(parsed.app_header.as_deref(), Some(app_header.as_slice()));

            handler
                .apply(
                    &PatchApplyRequest {
                        input: input_path.clone(),
                        patches: vec![patch_path],
                        output: output_path.clone(),
                    },
                    &test_context(),
                )
                .expect("apply recoded patch");
            assert_eq!(fs::read(output_path).expect("read output"), expected);
        }
    }

    #[test]
    fn apply_fails_for_mismatched_djw_header_and_lzma_payload() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = XDELTA_DJW_SECONDARY_ID;

        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse djw patch");
        assert_eq!(
            parsed.secondary_compressor_id,
            Some(XDELTA_DJW_SECONDARY_ID)
        );
        assert!(
            parsed
                .windows
                .iter()
                .any(|window| window.delta_indicator != 0)
        );

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
            .expect_err("mismatched DJW header should fail");
        assert!(
            format!("{error}").contains("xdelta djw")
                || format!("{error}").contains("secondary decompression")
        );
    }

    #[test]
    fn apply_supports_legacy_djw_fixture() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-djw-legacy.xdelta"), &patch_path)
            .expect("copy legacy djw fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

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
            .expect("legacy djw fixture should apply");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_fails_for_mismatched_fgk_header_and_lzma_payload() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = XDELTA_FGK_SECONDARY_ID;

        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse fgk patch");
        assert_eq!(
            parsed.secondary_compressor_id,
            Some(XDELTA_FGK_SECONDARY_ID)
        );
        assert!(
            parsed
                .windows
                .iter()
                .any(|window| window.delta_indicator != 0)
        );

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
            .expect_err("mismatched FGK header should fail");
        assert!(
            format!("{error}").contains("xdelta fgk")
                || format!("{error}").contains("secondary decompression")
        );
    }

    #[test]
    fn apply_supports_legacy_fgk_fixture() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-fgk-legacy.xdelta"), &patch_path)
            .expect("copy legacy fgk fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

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
            .expect("legacy fgk fixture should apply");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_supports_legacy_lzma_fixture() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-lzma-legacy.xdelta"), &patch_path)
            .expect("copy legacy lzma fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

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
            .expect("legacy lzma fixture should apply");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_fails_for_unknown_secondary_compressor_id() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = 0x7F;

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
        assert!(format!("{error}").contains("secondary compressor ID"));
    }

    #[test]
    fn apply_fails_for_unknown_secondary_id_without_compressed_sections() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_SECONDARY,
            secondary_id: Some(0x7F),
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE,
                source_segment_size: Some(4),
                source_segment_position: Some(0),
                target_window_size: 4,
                checksum: None,
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
        fs::write(&input_path, b"abcd").expect("write input");
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
            .expect_err("unknown secondary header id should fail");
        assert!(format!("{error}").contains("secondary compressor ID"));
    }

    #[test]
    fn apply_fails_when_compressed_sections_lack_secondary_header() {
        let mut patch = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: 0,
                source_segment_size: None,
                source_segment_position: None,
                target_window_size: 4,
                checksum: None,
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });
        patch[8] = DELTA_DATA_COMP;

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, b"abcd").expect("write input");
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
            .expect_err("compressed sections without secondary header should fail");
        assert!(format!("{error}").contains("compressed sections"));
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
        assert!(
            message.contains("native VCDIFF secondary decompression failed")
                || message.contains("native VCDIFF decoder failed")
                || message.contains("checksum mismatch")
        );
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

    fn build_patch(patch: TestPatch) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&VCDIFF_MAGIC_BYTES);
        bytes.push(patch.version);
        bytes.push(patch.header_flags);

        if patch.header_flags & HDR_SECONDARY != 0 {
            bytes.push(patch.secondary_id.expect("secondary id"));
        }
        if patch.header_flags & HDR_CODE_TABLE != 0 {
            let code_table_len = patch.code_table_data.len() as u64 + 2;
            encode_varint(&mut bytes, code_table_len);
            bytes.push(patch.code_table_near.expect("near size"));
            bytes.push(patch.code_table_same.expect("same size"));
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
