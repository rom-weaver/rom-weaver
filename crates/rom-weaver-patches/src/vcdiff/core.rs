use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use oxidelta::{
    compress::{
        encoder::{CompressOptions, DeltaEncoder},
        secondary::SecondaryCompression,
    },
    vcdiff::{
        decoder::{self as oxidelta_decoder, DecodeError as OxideltaDecodeError},
        header::{WindowHeader as OxideltaWindowHeader, VCD_ADLER32, VCD_SOURCE, VCD_TARGET},
    },
};
use rayon::prelude::*;
use rom_weaver_checksum::adler32_checksum as adler32;
use rom_weaver_codecs::{decode_xz_exact, encode_xz_preset};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability, XdeltaSecondaryMode,
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
const XDELTA_AUTO_FAST_SAMPLE_BYTES_PER_SECTION: usize = 256;
const XDELTA_AUTO_FAST_MAX_SECTIONS: usize = 512;
const XDELTA_AUTO_FAST_MIN_SAMPLED_BYTES: usize = 32 * 1024;
const XDELTA_AUTO_FAST_MIN_UNIQUE_RATIO: f64 = 0.93;
const XDELTA_AUTO_FAST_MAX_REPEAT_RATIO: f64 = 0.015;
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

fn xdelta_secondary_candidates_for_mode(mode: XdeltaSecondaryMode) -> &'static [u8] {
    match mode {
        XdeltaSecondaryMode::Auto => &XDELTA_SECONDARY_CANDIDATES,
        XdeltaSecondaryMode::AutoFast => &[XDELTA_LZMA_SECONDARY_ID],
        XdeltaSecondaryMode::Lzma => &[XDELTA_LZMA_SECONDARY_ID],
        XdeltaSecondaryMode::None => &[],
    }
}

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
        let secondary_mode = context.xdelta_secondary_mode();
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

        let create_result = (|| -> Result<(ParsedPatch, rom_weaver_core::ThreadExecution)> {
            let baseline_raw = encode_patch_with_native_streaming(
                &request.original,
                &request.modified,
                &baseline_raw_path,
                create_native_compress_options(self.descriptor, include_checksums),
            )?;
            let baseline_secondary_source_path = baseline_raw.path.clone();
            let baseline_loaded_for_secondary = if compare_secondary {
                Some(Arc::new(load_patch_for_xdelta_recode(
                    &baseline_secondary_source_path,
                )?))
            } else {
                None
            };
            let mut secondary_candidates = if compare_secondary {
                xdelta_secondary_candidates_for_mode(secondary_mode)
            } else {
                &[]
            };
            if compare_secondary
                && secondary_mode == XdeltaSecondaryMode::AutoFast
                && !secondary_candidates.is_empty()
                && baseline_loaded_for_secondary
                    .as_ref()
                    .is_some_and(|patch| should_skip_secondary_for_auto_fast(patch))
            {
                secondary_candidates = &[];
            }
            let (execution, secondary_pool) = if !secondary_candidates.is_empty() {
                let (execution, pool) =
                    context.build_pool(ThreadCapability::parallel(Some(secondary_candidates.len())))?;
                (execution, Some(pool))
            } else {
                (
                    context.plan_threads(ThreadCapability::single_threaded()),
                    None,
                )
            };
            let baseline = if xdelta_app_header.is_some() {
                recode_loaded_patch_with_xdelta_options(
                    baseline_loaded_for_secondary
                        .as_ref()
                        .expect("xdelta baseline should be loaded when app header is enabled"),
                    &baseline_path,
                    None,
                    xdelta_app_header.as_deref(),
                )?
            } else {
                baseline_raw
            };
            let selected = if compare_secondary {
                let mut best = baseline;
                if !secondary_candidates.is_empty() {
                    let baseline_loaded = Arc::clone(
                        baseline_loaded_for_secondary
                            .as_ref()
                            .expect("xdelta baseline should be loaded when evaluating candidates"),
                    );
                    let candidate_specs = secondary_candidates
                        .iter()
                        .copied()
                        .map(|secondary_id| {
                            (
                                secondary_id,
                                context.temp_paths().next_path(
                                    &format!("vcdiff-create-secondary-{secondary_id}"),
                                    output_extension,
                                ),
                            )
                        })
                        .collect::<Vec<_>>();
                    let app_header = xdelta_app_header.as_deref();
                    let candidate_results = if let Some(pool) = secondary_pool.as_ref() {
                        let baseline_for_workers = Arc::clone(&baseline_loaded);
                        pool.install(|| {
                            candidate_specs
                                .into_par_iter()
                                .map(|(secondary_id, candidate_path)| {
                                    recode_loaded_patch_with_xdelta_options(
                                        &baseline_for_workers,
                                        &candidate_path,
                                        Some(secondary_id),
                                        app_header,
                                    )
                                })
                                .collect::<Vec<_>>()
                        })
                    } else {
                        candidate_specs
                            .into_iter()
                            .map(|(secondary_id, candidate_path)| {
                                recode_loaded_patch_with_xdelta_options(
                                    &baseline_loaded,
                                    &candidate_path,
                                    Some(secondary_id),
                                    app_header,
                                )
                            })
                            .collect::<Vec<_>>()
                    };

                    for candidate in candidate_results
                        .into_iter()
                        .filter_map(|result| result.ok())
                    {
                        if candidate.size < best.size {
                            best = candidate;
                        }
                    }
                }
                best
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

#[derive(Debug)]
struct LoadedXdeltaRecodePatch {
    parsed: ParsedPatch,
    windows: Vec<LoadedXdeltaRecodeWindow>,
}

#[derive(Debug)]
struct LoadedXdeltaRecodeWindow {
    data: Vec<u8>,
    inst: Vec<u8>,
    addr: Vec<u8>,
}

fn should_skip_secondary_for_auto_fast(baseline_patch: &LoadedXdeltaRecodePatch) -> bool {
    let mut histogram = [0u32; 256];
    let mut sampled_bytes = 0usize;
    let mut adjacent_matches = 0usize;

    for section in baseline_patch
        .windows
        .iter()
        .flat_map(|window| [&window.data[..], &window.inst[..], &window.addr[..]])
        .filter(|section| !section.is_empty())
        .take(XDELTA_AUTO_FAST_MAX_SECTIONS)
    {
        let sample_len = section.len().min(XDELTA_AUTO_FAST_SAMPLE_BYTES_PER_SECTION);
        let sample = &section[..sample_len];
        sampled_bytes += sample.len();
        for (index, &byte) in sample.iter().enumerate() {
            histogram[byte as usize] = histogram[byte as usize].saturating_add(1);
            if index > 0 && byte == sample[index - 1] {
                adjacent_matches = adjacent_matches.saturating_add(1);
            }
        }
    }

    if sampled_bytes < XDELTA_AUTO_FAST_MIN_SAMPLED_BYTES {
        return false;
    }

    let unique_values = histogram.iter().filter(|&&count| count > 0).count();
    let unique_ratio = unique_values as f64 / 256.0;
    let adjacent_total = sampled_bytes.saturating_sub(1).max(1);
    let repeat_ratio = adjacent_matches as f64 / adjacent_total as f64;
    unique_ratio >= XDELTA_AUTO_FAST_MIN_UNIQUE_RATIO
        && repeat_ratio <= XDELTA_AUTO_FAST_MAX_REPEAT_RATIO
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
    let level = if is_xdelta_descriptor(descriptor) { 2 } else { 6 };
    CompressOptions {
        level,
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
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let output_file = File::create(output_path)?;
    let writer = BufWriter::with_capacity(NATIVE_CHUNK_SIZE, output_file);
    let source = fs::read(source_path)?;
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

fn load_patch_for_xdelta_recode(baseline_patch_path: &Path) -> Result<LoadedXdeltaRecodePatch> {
    let mut reader = BufReader::new(File::open(baseline_patch_path)?);
    let parsed = parse_patch(&mut reader)?;
    if parsed.custom_code_table.is_some() {
        return Err(RomWeaverError::Validation(
            "native VCDIFF secondary recoder does not support custom code tables".into(),
        ));
    }

    let mut patch_reader = BufReader::new(File::open(baseline_patch_path)?);
    let mut windows = Vec::with_capacity(parsed.windows.len());
    for window in &parsed.windows {
        let data = read_section(&mut patch_reader, window.data_start, window.data_len)?;
        let inst = read_section(&mut patch_reader, window.inst_start, window.inst_len)?;
        let addr = read_section(&mut patch_reader, window.addr_start, window.addr_len)?;
        windows.push(LoadedXdeltaRecodeWindow { data, inst, addr });
    }

    Ok(LoadedXdeltaRecodePatch { parsed, windows })
}

#[cfg(test)]
fn recode_patch_with_xdelta_options(
    baseline_patch_path: &Path,
    output_path: &Path,
    secondary_compressor_id: Option<u8>,
    app_header: Option<&[u8]>,
) -> Result<CreatedPatchCandidate> {
    let loaded = load_patch_for_xdelta_recode(baseline_patch_path)?;
    recode_loaded_patch_with_xdelta_options(
        &loaded,
        output_path,
        secondary_compressor_id,
        app_header,
    )
}

fn recode_loaded_patch_with_xdelta_options(
    baseline_patch: &LoadedXdeltaRecodePatch,
    output_path: &Path,
    secondary_compressor_id: Option<u8>,
    app_header: Option<&[u8]>,
) -> Result<CreatedPatchCandidate> {
    ensure_supported_secondary_compressor(secondary_compressor_id)?;
    if secondary_compressor_id.is_some() && baseline_patch.parsed.secondary_compressor_id.is_some()
    {
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

    for (window, sections) in baseline_patch
        .parsed
        .windows
        .iter()
        .zip(baseline_patch.windows.iter())
    {
        let (data_out, data_comp) = recode_window_section(
            &sections.data,
            window.delta_indicator & DELTA_DATA_COMP != 0,
            secondary_compressor_id,
            DjwSectionKind::Data,
        )?;
        let (inst_out, inst_comp) = recode_window_section(
            &sections.inst,
            window.delta_indicator & DELTA_INST_COMP != 0,
            secondary_compressor_id,
            DjwSectionKind::Inst,
        )?;
        let (addr_out, addr_comp) = recode_window_section(
            &sections.addr,
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
