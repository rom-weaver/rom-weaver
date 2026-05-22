use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::Path,
    sync::{Arc, Mutex},
};

use rayon::prelude::*;
use rom_weaver_codecs::{
    decode_bzip2_exact, decode_deflate_exact, decode_lzma_with_props, decode_lzma2,
    decode_zlib_exact, decode_zstd_exact,
};
use rom_weaver_core::{
    BlockCacheReader, DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES,
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability, ValidationCodeError,
};

fn hdiff_validation_code(code: &'static str) -> ValidationCodeError {
    ValidationCodeError::new(code)
}

pub struct HdiffPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl HdiffPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for HdiffPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let variant = parse_hdiff_patch_file(patch_path)?;
        let label = match variant {
            ParsedPatchVariant::SingleFile13(header) => format!(
                "parsed {} patch: HDIFF13 comp={} old={} new={} cover_count={} new_diff={} byte(s)",
                self.descriptor.name,
                header.compression.as_str(),
                header.old_data_size,
                header.new_data_size,
                header.cover_count,
                header.new_data_diff_size
            ),
            ParsedPatchVariant::SingleStream20(header) => format!(
                "parsed {} patch: HDIFFSF20 comp={} old={} new={} cover_count={} step_mem={} uncompressed={} compressed={} byte(s)",
                self.descriptor.name,
                header.compression.as_str(),
                header.old_data_size,
                header.new_data_size,
                header.cover_count,
                header.step_mem_size,
                header.uncompressed_size,
                header.compressed_size
            ),
            ParsedPatchVariant::Directory19(header) => format!(
                "parsed {} patch: HDIFF19 comp={} old={} new={} (directory patch; apply unsupported)",
                self.descriptor.name,
                header.compression.as_str(),
                header.old_data_size,
                header.new_data_size
            ),
        };

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
        let variant = parse_hdiff_patch_file(patch_path)?;
        let patch_len = fs::metadata(patch_path)?.len();
        let patch_reader = Arc::new(Mutex::new(BlockCacheReader::open(
            patch_path,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )?));
        let old_len = fs::metadata(&request.input)?.len();
        let old_data = HdiffOldData::from_path(&request.input)?;

        let (output_bytes, execution) = match variant {
            ParsedPatchVariant::SingleFile13(header) => {
                if old_len != header.old_data_size {
                    return Err(RomWeaverError::ValidationCode(
                        hdiff_validation_code("HDIFF_SOURCE_SIZE_MISMATCH")
                            .with_message("HDiffPatch source size mismatch")
                            .with_field("expected", header.old_data_size)
                            .with_field("actual", old_len),
                    ));
                }

                let thread_capability = hdiff13_apply_thread_capability(&header);
                let planned_execution = context.plan_threads(thread_capability.clone());
                if planned_execution.used_parallelism {
                    let (execution, pool) = context.build_pool(thread_capability)?;
                    let chunk_parallel = execution.used_parallelism;
                    let output = pool.install(|| {
                        apply_hdiff13_with_chunk_parallelism_from_reader(
                            &old_data,
                            &patch_reader,
                            patch_len,
                            &header,
                            chunk_parallel,
                        )
                    })?;
                    (output, execution)
                } else {
                    let output = apply_hdiff13_with_chunk_parallelism_from_reader(
                        &old_data,
                        &patch_reader,
                        patch_len,
                        &header,
                        false,
                    )?;
                    (output, planned_execution)
                }
            }
            ParsedPatchVariant::SingleStream20(header) => {
                if old_len != header.old_data_size {
                    return Err(RomWeaverError::ValidationCode(
                        hdiff_validation_code("HDIFF_SOURCE_SIZE_MISMATCH")
                            .with_message("HDiffPatch source size mismatch")
                            .with_field("expected", header.old_data_size)
                            .with_field("actual", old_len),
                    ));
                }

                let thread_capability = hdiffsf20_apply_thread_capability(&header);
                let planned_execution = context.plan_threads(thread_capability.clone());
                if planned_execution.used_parallelism {
                    let (mut execution, pool) = context.build_pool(thread_capability)?;
                    let step_parallel = execution.used_parallelism;
                    let apply = pool.install(|| {
                        apply_hdiffsf20_with_step_parallelism_from_reader(
                            &old_data,
                            &patch_reader,
                            patch_len,
                            &header,
                            step_parallel,
                        )
                    })?;
                    if !apply.used_parallelism {
                        execution.apply_pool_fallback(
                            "HDIFFSF20 payload had no independent step-level parallel work"
                                .to_string(),
                        );
                    }
                    (apply.output, execution)
                } else {
                    let output = apply_hdiffsf20_with_step_parallelism_from_reader(
                        &old_data,
                        &patch_reader,
                        patch_len,
                        &header,
                        false,
                    )?
                    .output;
                    (output, planned_execution)
                }
            }
            ParsedPatchVariant::Directory19(_) => {
                return Err(RomWeaverError::Unsupported(
                    "HDiffPatch directory patches (HDIFF19) are not supported for patch-apply; expected single-file patch (.hdiff/.hpatchz)".into(),
                ));
            }
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&request.output)?);
        output.write_all(&output_bytes)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch; output {} byte(s)",
                self.descriptor.name,
                output_bytes.len()
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = Some(context.plan_threads(ThreadCapability::single_threaded()));
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            "HDiffPatch/HPatchZ patch creation is disabled; use upstream hdiffz/hpatchz tooling",
            execution,
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HdiffCompression {
    NoComp,
    Zstd,
    Zlib,
    Bz2,
    Lzma,
    Lzma2,
}

impl HdiffCompression {
    fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "nocomp" => Ok(Self::NoComp),
            "zstd" => Ok(Self::Zstd),
            "zlib" => Ok(Self::Zlib),
            "bz2" | "pbz2" => Ok(Self::Bz2),
            "lzma" => Ok(Self::Lzma),
            "lzma2" => Ok(Self::Lzma2),
            other => Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_COMPRESSION_UNRECOGNIZED")
                    .with_message("HDiffPatch compression is not recognized")
                    .with_field("compression", other),
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::NoComp => "nocomp",
            Self::Zstd => "zstd",
            Self::Zlib => "zlib",
            Self::Bz2 => "bz2",
            Self::Lzma => "lzma",
            Self::Lzma2 => "lzma2",
        }
    }
}

#[derive(Clone, Debug)]
struct ParsedHdiff13 {
    compression: HdiffCompression,
    old_data_size: u64,
    new_data_size: u64,
    cover_count: u64,
    cover_buf_size: u64,
    compress_cover_buf_size: u64,
    rle_ctrl_buf_size: u64,
    compress_rle_ctrl_buf_size: u64,
    rle_code_buf_size: u64,
    compress_rle_code_buf_size: u64,
    new_data_diff_size: u64,
    compress_new_data_diff_size: u64,
    header_end: usize,
}

#[derive(Clone, Debug)]
struct ParsedHdiffSf20 {
    compression: HdiffCompression,
    old_data_size: u64,
    new_data_size: u64,
    cover_count: u64,
    step_mem_size: u64,
    uncompressed_size: u64,
    compressed_size: u64,
    diff_data_pos: usize,
}

#[derive(Clone, Debug)]
struct Sf20CoverPlan {
    old_start: usize,
    cover_len: usize,
    gap_len: usize,
}

#[derive(Clone, Debug)]
struct Sf20StepPlan {
    output_start: usize,
    output_len: usize,
    rle_range: std::ops::Range<usize>,
    gap_range: std::ops::Range<usize>,
    covers: Vec<Sf20CoverPlan>,
}

#[derive(Clone, Debug)]
struct ParsedSf20Plan {
    steps: Vec<Sf20StepPlan>,
    tail_range: std::ops::Range<usize>,
    produced_len: usize,
}

#[derive(Clone, Debug)]
struct HdiffSf20ApplyOutput {
    output: Vec<u8>,
    used_parallelism: bool,
}

#[derive(Clone, Debug)]
struct ParsedHdiffDir19 {
    compression: HdiffCompression,
    old_data_size: u64,
    new_data_size: u64,
}

#[derive(Clone, Debug)]
enum ParsedPatchVariant {
    SingleFile13(ParsedHdiff13),
    SingleStream20(ParsedHdiffSf20),
    Directory19(ParsedHdiffDir19),
}

struct HdiffFileParser<R> {
    reader: R,
    file_len: u64,
    offset: u64,
}

impl<R: Read> HdiffFileParser<R> {
    fn new(reader: R, file_len: u64) -> Self {
        Self {
            reader,
            file_len,
            offset: 0,
        }
    }

    fn offset_usize(&self, label: &'static str) -> Result<usize> {
        usize::try_from(self.offset).map_err(|_| {
            RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_OFFSET_OVERFLOW_USIZE").with_field("label", label),
            )
        })
    }

    fn read_u8(&mut self, label: &'static str) -> Result<u8> {
        if self.offset >= self.file_len {
            return Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_READ_UNEXPECTED_EOF")
                    .with_field("label", label)
                    .with_field("offset", self.offset)
                    .with_field("len", self.file_len),
            ));
        }
        let mut byte = [0u8; 1];
        self.reader.read_exact(&mut byte)?;
        self.offset += 1;
        Ok(byte[0])
    }

    fn read_bool(&mut self, label: &'static str) -> Result<bool> {
        Ok(self.read_u8(label)? != 0)
    }

    fn read_var_u64(&mut self, label: &'static str) -> Result<u64> {
        self.read_var_u64_tagged(0, 0, label)
    }

    fn read_var_u64_tagged(
        &mut self,
        tag_bits: u8,
        first_byte: u8,
        label: &'static str,
    ) -> Result<u64> {
        if tag_bits > 6 {
            return Err(RomWeaverError::Validation(
                "HDiffPatch varint tag_bits must be <= 6".into(),
            ));
        }

        let first = if tag_bits == 0 {
            self.read_u8(label)?
        } else {
            first_byte
        };
        let continuation_bit = 1u8 << (7 - tag_bits);
        let payload_mask = continuation_bit - 1;

        let mut value = u64::from(first & payload_mask);
        if (first & continuation_bit) == 0 {
            return Ok(value);
        }

        loop {
            let byte = self.read_u8(label)?;
            value = value
                .checked_shl(7)
                .and_then(|value| value.checked_add(u64::from(byte & 0x7f)))
                .ok_or_else(|| RomWeaverError::Validation("HDiffPatch varint overflowed".into()))?;
            if (byte & 0x80) == 0 {
                break;
            }
        }

        Ok(value)
    }

    fn read_null_terminated_string(&mut self, max_len: usize) -> Result<String> {
        let mut bytes = Vec::new();
        for _ in 0..max_len {
            let byte = self.read_u8("header")?;
            if byte == 0 {
                let text = std::str::from_utf8(bytes.as_slice()).map_err(|_| {
                    RomWeaverError::Validation("HDiffPatch header contained non-UTF8 bytes".into())
                })?;
                return Ok(text.to_string());
            }
            bytes.push(byte);
        }
        Err(RomWeaverError::Validation(
            "HDiffPatch header was missing null terminator".into(),
        ))
    }
}

enum HdiffOldData<'a> {
    Bytes(&'a [u8]),
    Cached {
        len: usize,
        reader: Arc<Mutex<BlockCacheReader>>,
    },
}

impl<'a> HdiffOldData<'a> {
    fn from_path(path: &Path) -> Result<Self> {
        let reader = BlockCacheReader::open(
            path,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )?;
        let len = usize::try_from(fs::metadata(path)?.len()).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch input size overflowed usize".into())
        })?;
        Ok(Self::Cached {
            len,
            reader: Arc::new(Mutex::new(reader)),
        })
    }

    fn len(&self) -> usize {
        match self {
            Self::Bytes(bytes) => bytes.len(),
            Self::Cached { len, .. } => *len,
        }
    }

    fn read_range(&self, start: usize, len: usize) -> Result<Vec<u8>> {
        match self {
            Self::Bytes(bytes) => {
                let end = start.checked_add(len).ok_or_else(|| {
                    RomWeaverError::Validation("HDiffPatch source range overflowed".into())
                })?;
                if end > bytes.len() {
                    return Err(RomWeaverError::Validation(
                        "HDiffPatch source range exceeded bounds".into(),
                    ));
                }
                Ok(bytes[start..end].to_vec())
            }
            Self::Cached {
                len: total_len,
                reader,
            } => {
                let end = start.checked_add(len).ok_or_else(|| {
                    RomWeaverError::Validation("HDiffPatch source range overflowed".into())
                })?;
                if end > *total_len {
                    return Err(RomWeaverError::Validation(
                        "HDiffPatch source range exceeded bounds".into(),
                    ));
                }
                let mut range = vec![0u8; len];
                let mut guard = reader.lock().map_err(|_| {
                    RomWeaverError::Validation(
                        "HDiffPatch source block cache lock is poisoned".into(),
                    )
                })?;
                guard.read_exact_at(start as u64, range.as_mut_slice())?;
                Ok(range)
            }
        }
    }
}

#[cfg(test)]
struct ParsedPatchFile {
    bytes: Vec<u8>,
    variant: ParsedPatchVariant,
}

#[cfg(test)]
fn parse_hdiff_patch_bytes(bytes: Vec<u8>) -> Result<ParsedPatchFile> {
    let variant = parse_hdiff_patch_view(bytes.as_slice())?;
    Ok(ParsedPatchFile { bytes, variant })
}

fn parse_hdiff_patch_file(path: &Path) -> Result<ParsedPatchVariant> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut parser = HdiffFileParser::new(BufReader::new(file), file_len);

    let header_text = parser.read_null_terminated_string(1024)?;
    let parts = header_text.split('&').collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch header is incomplete".into(),
        ));
    }

    let magic = parts[0];
    let compression = HdiffCompression::parse(parts[1])?;

    let variant = if magic == "HDIFF13" {
        let new_data_size = parser.read_var_u64("new_data_size")?;
        let old_data_size = parser.read_var_u64("old_data_size")?;
        let cover_count = parser.read_var_u64("cover_count")?;
        let cover_buf_size = parser.read_var_u64("cover_buf_size")?;
        let compress_cover_buf_size = parser.read_var_u64("compress_cover_buf_size")?;
        let rle_ctrl_buf_size = parser.read_var_u64("rle_ctrl_buf_size")?;
        let compress_rle_ctrl_buf_size = parser.read_var_u64("compress_rle_ctrl_buf_size")?;
        let rle_code_buf_size = parser.read_var_u64("rle_code_buf_size")?;
        let compress_rle_code_buf_size = parser.read_var_u64("compress_rle_code_buf_size")?;
        let new_data_diff_size = parser.read_var_u64("new_data_diff_size")?;
        let compress_new_data_diff_size = parser.read_var_u64("compress_new_data_diff_size")?;

        ParsedPatchVariant::SingleFile13(ParsedHdiff13 {
            compression,
            old_data_size,
            new_data_size,
            cover_count,
            cover_buf_size,
            compress_cover_buf_size,
            rle_ctrl_buf_size,
            compress_rle_ctrl_buf_size,
            rle_code_buf_size,
            compress_rle_code_buf_size,
            new_data_diff_size,
            compress_new_data_diff_size,
            header_end: parser.offset_usize("header_end")?,
        })
    } else if magic == "HDIFFSF20" {
        let new_data_size = parser.read_var_u64("new_data_size")?;
        let old_data_size = parser.read_var_u64("old_data_size")?;
        let cover_count = parser.read_var_u64("cover_count")?;
        let step_mem_size = parser.read_var_u64("step_mem_size")?;
        let uncompressed_size = parser.read_var_u64("uncompressed_size")?;
        let compressed_size = parser.read_var_u64("compressed_size")?;

        ParsedPatchVariant::SingleStream20(ParsedHdiffSf20 {
            compression,
            old_data_size,
            new_data_size,
            cover_count,
            step_mem_size,
            uncompressed_size,
            compressed_size,
            diff_data_pos: parser.offset_usize("diff_data_pos")?,
        })
    } else if magic == "HDIFF19" {
        let is_input_dir = parser.read_bool("is_input_dir")?;
        let is_output_dir = parser.read_bool("is_output_dir")?;

        let _input_dir_count = parser.read_var_u64("input_dir_count")?;
        let input_sum_size = parser.read_var_u64("input_sum_size")?;
        let _output_dir_count = parser.read_var_u64("output_dir_count")?;
        let output_sum_size = parser.read_var_u64("output_sum_size")?;

        if !is_input_dir || !is_output_dir {
            return Err(RomWeaverError::Validation(
                "HDIFF19 patch flagged non-directory I/O unexpectedly".into(),
            ));
        }

        ParsedPatchVariant::Directory19(ParsedHdiffDir19 {
            compression,
            old_data_size: input_sum_size,
            new_data_size: output_sum_size,
        })
    } else {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_MAGIC_UNSUPPORTED")
                .with_message("HDiffPatch magic is not supported")
                .with_field("magic", magic),
        ));
    };

    Ok(variant)
}

fn parse_hdiff_patch_view(raw: &[u8]) -> Result<ParsedPatchVariant> {
    let (header_text, mut index) = read_null_terminated_string(raw, 1024)?;
    let parts = header_text.split('&').collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch header is incomplete".into(),
        ));
    }

    let magic = parts[0];
    let compression = HdiffCompression::parse(parts[1])?;

    let variant = if magic == "HDIFF13" {
        let new_data_size = read_var_u64(raw, &mut index, "new_data_size")?;
        let old_data_size = read_var_u64(raw, &mut index, "old_data_size")?;
        let cover_count = read_var_u64(raw, &mut index, "cover_count")?;
        let cover_buf_size = read_var_u64(raw, &mut index, "cover_buf_size")?;
        let compress_cover_buf_size = read_var_u64(raw, &mut index, "compress_cover_buf_size")?;
        let rle_ctrl_buf_size = read_var_u64(raw, &mut index, "rle_ctrl_buf_size")?;
        let compress_rle_ctrl_buf_size =
            read_var_u64(raw, &mut index, "compress_rle_ctrl_buf_size")?;
        let rle_code_buf_size = read_var_u64(raw, &mut index, "rle_code_buf_size")?;
        let compress_rle_code_buf_size =
            read_var_u64(raw, &mut index, "compress_rle_code_buf_size")?;
        let new_data_diff_size = read_var_u64(raw, &mut index, "new_data_diff_size")?;
        let compress_new_data_diff_size =
            read_var_u64(raw, &mut index, "compress_new_data_diff_size")?;

        ParsedPatchVariant::SingleFile13(ParsedHdiff13 {
            compression,
            old_data_size,
            new_data_size,
            cover_count,
            cover_buf_size,
            compress_cover_buf_size,
            rle_ctrl_buf_size,
            compress_rle_ctrl_buf_size,
            rle_code_buf_size,
            compress_rle_code_buf_size,
            new_data_diff_size,
            compress_new_data_diff_size,
            header_end: index,
        })
    } else if magic == "HDIFFSF20" {
        let new_data_size = read_var_u64(raw, &mut index, "new_data_size")?;
        let old_data_size = read_var_u64(raw, &mut index, "old_data_size")?;
        let cover_count = read_var_u64(raw, &mut index, "cover_count")?;
        let step_mem_size = read_var_u64(raw, &mut index, "step_mem_size")?;
        let uncompressed_size = read_var_u64(raw, &mut index, "uncompressed_size")?;
        let compressed_size = read_var_u64(raw, &mut index, "compressed_size")?;

        ParsedPatchVariant::SingleStream20(ParsedHdiffSf20 {
            compression,
            old_data_size,
            new_data_size,
            cover_count,
            step_mem_size,
            uncompressed_size,
            compressed_size,
            diff_data_pos: index,
        })
    } else if magic == "HDIFF19" {
        let is_input_dir = read_bool_byte(raw, &mut index, "is_input_dir")?;
        let is_output_dir = read_bool_byte(raw, &mut index, "is_output_dir")?;

        let _input_dir_count = read_var_u64(raw, &mut index, "input_dir_count")?;
        let input_sum_size = read_var_u64(raw, &mut index, "input_sum_size")?;
        let _output_dir_count = read_var_u64(raw, &mut index, "output_dir_count")?;
        let output_sum_size = read_var_u64(raw, &mut index, "output_sum_size")?;

        if !is_input_dir || !is_output_dir {
            return Err(RomWeaverError::Validation(
                "HDIFF19 patch flagged non-directory I/O unexpectedly".into(),
            ));
        }

        ParsedPatchVariant::Directory19(ParsedHdiffDir19 {
            compression,
            old_data_size: input_sum_size,
            new_data_size: output_sum_size,
        })
    } else {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_MAGIC_UNSUPPORTED")
                .with_message("HDiffPatch magic is not supported")
                .with_field("magic", magic),
        ));
    };

    Ok(variant)
}

fn apply_hdiff13(old_bytes: &[u8], patch_bytes: &[u8], header: &ParsedHdiff13) -> Result<Vec<u8>> {
    let old_data = HdiffOldData::Bytes(old_bytes);
    apply_hdiff13_with_chunk_parallelism(&old_data, patch_bytes, header, false)
}

fn apply_hdiff13_with_chunk_parallelism(
    old_data: &HdiffOldData<'_>,
    patch_bytes: &[u8],
    header: &ParsedHdiff13,
    parallel_chunks: bool,
) -> Result<Vec<u8>> {
    let chunks = read_hdiff13_chunks_from_patch_bytes(patch_bytes, header, parallel_chunks)?;
    apply_hdiff13_with_chunks(old_data, header, chunks)
}

fn apply_hdiff13_with_chunk_parallelism_from_reader(
    old_data: &HdiffOldData<'_>,
    patch_reader: &Arc<Mutex<BlockCacheReader>>,
    patch_len: u64,
    header: &ParsedHdiff13,
    parallel_chunks: bool,
) -> Result<Vec<u8>> {
    let chunks =
        read_hdiff13_chunks_from_patch_reader(patch_reader, patch_len, header, parallel_chunks)?;
    apply_hdiff13_with_chunks(old_data, header, chunks)
}

#[derive(Debug)]
struct Hdiff13Chunks {
    cover_raw: Vec<u8>,
    rle_ctrl_raw: Vec<u8>,
    rle_code_raw: Vec<u8>,
    new_diff_raw: Vec<u8>,
}

fn hdiff13_chunk_offsets(header: &ParsedHdiff13) -> Result<(usize, usize, usize, usize)> {
    let cover_start = header.header_end;
    let cover_end = add_usize_u64(
        cover_start,
        hdiff_chunk_raw_size(header.cover_buf_size, header.compress_cover_buf_size),
        "cover end",
    )?;
    let rle_ctrl_start = cover_end;
    let rle_ctrl_end = add_usize_u64(
        rle_ctrl_start,
        hdiff_chunk_raw_size(header.rle_ctrl_buf_size, header.compress_rle_ctrl_buf_size),
        "rle_ctrl end",
    )?;
    let rle_code_start = rle_ctrl_end;
    let rle_code_end = add_usize_u64(
        rle_code_start,
        hdiff_chunk_raw_size(header.rle_code_buf_size, header.compress_rle_code_buf_size),
        "rle_code end",
    )?;
    let new_diff_start = rle_code_end;
    Ok((cover_start, rle_ctrl_start, rle_code_start, new_diff_start))
}

fn read_hdiff13_chunks_from_patch_bytes(
    patch_bytes: &[u8],
    header: &ParsedHdiff13,
    parallel_chunks: bool,
) -> Result<Hdiff13Chunks> {
    let (cover_start, rle_ctrl_start, rle_code_start, new_diff_start) =
        hdiff13_chunk_offsets(header)?;

    let (cover_raw, rle_ctrl_raw, rle_code_raw, new_diff_raw) = if parallel_chunks {
        let ((cover_raw, rle_ctrl_raw), (rle_code_raw, new_diff_raw)) = rayon::join(
            || {
                rayon::join(
                    || {
                        read_hdiff_chunk(
                            patch_bytes,
                            cover_start,
                            header.cover_buf_size,
                            header.compress_cover_buf_size,
                            header.compression,
                            "cover",
                        )
                    },
                    || {
                        read_hdiff_chunk(
                            patch_bytes,
                            rle_ctrl_start,
                            header.rle_ctrl_buf_size,
                            header.compress_rle_ctrl_buf_size,
                            header.compression,
                            "rle_ctrl",
                        )
                    },
                )
            },
            || {
                rayon::join(
                    || {
                        read_hdiff_chunk(
                            patch_bytes,
                            rle_code_start,
                            header.rle_code_buf_size,
                            header.compress_rle_code_buf_size,
                            header.compression,
                            "rle_code",
                        )
                    },
                    || {
                        read_hdiff_chunk(
                            patch_bytes,
                            new_diff_start,
                            header.new_data_diff_size,
                            header.compress_new_data_diff_size,
                            header.compression,
                            "new_data_diff",
                        )
                    },
                )
            },
        );
        (cover_raw?, rle_ctrl_raw?, rle_code_raw?, new_diff_raw?)
    } else {
        (
            read_hdiff_chunk(
                patch_bytes,
                cover_start,
                header.cover_buf_size,
                header.compress_cover_buf_size,
                header.compression,
                "cover",
            )?,
            read_hdiff_chunk(
                patch_bytes,
                rle_ctrl_start,
                header.rle_ctrl_buf_size,
                header.compress_rle_ctrl_buf_size,
                header.compression,
                "rle_ctrl",
            )?,
            read_hdiff_chunk(
                patch_bytes,
                rle_code_start,
                header.rle_code_buf_size,
                header.compress_rle_code_buf_size,
                header.compression,
                "rle_code",
            )?,
            read_hdiff_chunk(
                patch_bytes,
                new_diff_start,
                header.new_data_diff_size,
                header.compress_new_data_diff_size,
                header.compression,
                "new_data_diff",
            )?,
        )
    };
    Ok(Hdiff13Chunks {
        cover_raw,
        rle_ctrl_raw,
        rle_code_raw,
        new_diff_raw,
    })
}

fn read_hdiff13_chunks_from_patch_reader(
    patch_reader: &Arc<Mutex<BlockCacheReader>>,
    patch_len: u64,
    header: &ParsedHdiff13,
    parallel_chunks: bool,
) -> Result<Hdiff13Chunks> {
    let (cover_start, rle_ctrl_start, rle_code_start, new_diff_start) =
        hdiff13_chunk_offsets(header)?;
    let load = |start: usize, plain_size: u64, compressed_size: u64, label: &'static str| {
        read_hdiff_chunk_from_reader(
            patch_reader,
            patch_len,
            start,
            plain_size,
            compressed_size,
            header.compression,
            label,
        )
    };

    let (cover_raw, rle_ctrl_raw, rle_code_raw, new_diff_raw) = if parallel_chunks {
        let ((cover_raw, rle_ctrl_raw), (rle_code_raw, new_diff_raw)) = rayon::join(
            || {
                rayon::join(
                    || {
                        load(
                            cover_start,
                            header.cover_buf_size,
                            header.compress_cover_buf_size,
                            "cover",
                        )
                    },
                    || {
                        load(
                            rle_ctrl_start,
                            header.rle_ctrl_buf_size,
                            header.compress_rle_ctrl_buf_size,
                            "rle_ctrl",
                        )
                    },
                )
            },
            || {
                rayon::join(
                    || {
                        load(
                            rle_code_start,
                            header.rle_code_buf_size,
                            header.compress_rle_code_buf_size,
                            "rle_code",
                        )
                    },
                    || {
                        load(
                            new_diff_start,
                            header.new_data_diff_size,
                            header.compress_new_data_diff_size,
                            "new_data_diff",
                        )
                    },
                )
            },
        );
        (cover_raw?, rle_ctrl_raw?, rle_code_raw?, new_diff_raw?)
    } else {
        (
            load(
                cover_start,
                header.cover_buf_size,
                header.compress_cover_buf_size,
                "cover",
            )?,
            load(
                rle_ctrl_start,
                header.rle_ctrl_buf_size,
                header.compress_rle_ctrl_buf_size,
                "rle_ctrl",
            )?,
            load(
                rle_code_start,
                header.rle_code_buf_size,
                header.compress_rle_code_buf_size,
                "rle_code",
            )?,
            load(
                new_diff_start,
                header.new_data_diff_size,
                header.compress_new_data_diff_size,
                "new_data_diff",
            )?,
        )
    };

    Ok(Hdiff13Chunks {
        cover_raw,
        rle_ctrl_raw,
        rle_code_raw,
        new_diff_raw,
    })
}

fn apply_hdiff13_with_chunks(
    old_data: &HdiffOldData<'_>,
    header: &ParsedHdiff13,
    chunks: Hdiff13Chunks,
) -> Result<Vec<u8>> {
    let Hdiff13Chunks {
        cover_raw,
        rle_ctrl_raw,
        rle_code_raw,
        new_diff_raw,
    } = chunks;

    let expected_old_data_size = usize::try_from(header.old_data_size).map_err(|_| {
        RomWeaverError::Validation("HDiffPatch old_data_size overflowed usize".into())
    })?;
    let old_data_size = old_data.len();
    if old_data_size != expected_old_data_size {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_SOURCE_SIZE_MISMATCH")
                .with_message("HDiffPatch source size mismatch")
                .with_field("expected", expected_old_data_size)
                .with_field("actual", old_data_size),
        ));
    }

    let new_data_size = usize::try_from(header.new_data_size).map_err(|_| {
        RomWeaverError::Validation("HDiffPatch new_data_size overflowed usize".into())
    })?;
    let mut output = Vec::with_capacity(new_data_size);

    let mut cover_index = 0usize;
    let mut rle_ctrl_index = 0usize;
    let mut rle_code_index = 0usize;
    let mut new_diff_index = 0usize;

    let mut rle_state = HdiffRleState::default();

    let mut last_old_end = 0u64;
    let mut last_new_end = 0u64;
    let mut remaining_covers = header.cover_count;

    while remaining_covers > 0 {
        remaining_covers -= 1;

        let p_sign = read_u8_slice(cover_raw.as_slice(), &mut cover_index, "cover sign")?;
        let old_sign = p_sign >> 7;
        let old_delta = read_var_u64_tagged_slice(
            cover_raw.as_slice(),
            &mut cover_index,
            1,
            p_sign,
            "cover old_delta",
        )?;
        let old_pos = if old_sign == 0 {
            last_old_end.checked_add(old_delta).ok_or_else(|| {
                RomWeaverError::Validation("HDiffPatch cover old position overflowed".into())
            })?
        } else {
            last_old_end.checked_sub(old_delta).ok_or_else(|| {
                RomWeaverError::Validation("HDiffPatch cover old position underflowed".into())
            })?
        };

        let copy_length = read_var_u64_slice(cover_raw.as_slice(), &mut cover_index, "cover copy")?;
        let cover_length =
            read_var_u64_slice(cover_raw.as_slice(), &mut cover_index, "cover length")?;

        let new_pos = last_new_end.checked_add(copy_length).ok_or_else(|| {
            RomWeaverError::Validation("HDiffPatch cover new position overflowed".into())
        })?;

        let new_pos_usize = usize::try_from(new_pos).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch new position overflowed usize".into())
        })?;
        if output.len() > new_pos_usize {
            return Err(RomWeaverError::Validation(
                "HDiffPatch cover new position moved backward".into(),
            ));
        }

        if output.len() < new_pos_usize {
            let fill_len = new_pos_usize - output.len();
            append_from_new_diff(
                &mut output,
                new_diff_raw.as_slice(),
                &mut new_diff_index,
                fill_len,
                "new_data_diff gap",
            )?;
            let begin = output.len() - fill_len;
            apply_hdiff_rle(
                &mut output[begin..],
                rle_ctrl_raw.as_slice(),
                &mut rle_ctrl_index,
                rle_code_raw.as_slice(),
                &mut rle_code_index,
                &mut rle_state,
            )?;
        }

        let old_start = usize::try_from(old_pos).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch old position overflowed usize".into())
        })?;
        let cover_len_usize = usize::try_from(cover_length).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch cover length overflowed usize".into())
        })?;
        let old_end = old_start.checked_add(cover_len_usize).ok_or_else(|| {
            RomWeaverError::Validation("HDiffPatch cover old range overflowed".into())
        })?;
        if old_end > old_data_size {
            return Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_COVER_EXCEEDED_OLD_BOUNDS")
                    .with_message("HDiffPatch cover exceeded old data bounds")
                    .with_field("old_start", old_start)
                    .with_field("old_end", old_end)
                    .with_field("old_len", old_data_size),
            ));
        }

        let old_range = old_data.read_range(old_start, cover_len_usize)?;
        output.extend_from_slice(old_range.as_slice());
        let begin = output.len() - cover_len_usize;
        apply_hdiff_rle(
            &mut output[begin..],
            rle_ctrl_raw.as_slice(),
            &mut rle_ctrl_index,
            rle_code_raw.as_slice(),
            &mut rle_code_index,
            &mut rle_state,
        )?;

        last_old_end = old_pos
            .checked_add(cover_length)
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch old end overflowed".into()))?;
        last_new_end = new_pos
            .checked_add(cover_length)
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch new end overflowed".into()))?;
    }

    if output.len() < new_data_size {
        let fill_len = new_data_size - output.len();
        append_from_new_diff(
            &mut output,
            new_diff_raw.as_slice(),
            &mut new_diff_index,
            fill_len,
            "new_data_diff tail",
        )?;
        let begin = output.len() - fill_len;
        apply_hdiff_rle(
            &mut output[begin..],
            rle_ctrl_raw.as_slice(),
            &mut rle_ctrl_index,
            rle_code_raw.as_slice(),
            &mut rle_code_index,
            &mut rle_state,
        )?;
    }

    if output.len() != new_data_size {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_OUTPUT_SIZE_MISMATCH")
                .with_message("HDiffPatch output size mismatch")
                .with_field("expected", new_data_size)
                .with_field("actual", output.len()),
        ));
    }

    Ok(output)
}

fn hdiff13_apply_thread_capability(header: &ParsedHdiff13) -> ThreadCapability {
    let chunk_count = [
        hdiff_chunk_raw_size(header.cover_buf_size, header.compress_cover_buf_size),
        hdiff_chunk_raw_size(header.rle_ctrl_buf_size, header.compress_rle_ctrl_buf_size),
        hdiff_chunk_raw_size(header.rle_code_buf_size, header.compress_rle_code_buf_size),
        hdiff_chunk_raw_size(
            header.new_data_diff_size,
            header.compress_new_data_diff_size,
        ),
    ]
    .into_iter()
    .filter(|raw_size| *raw_size > 0)
    .count();

    if chunk_count > 1 {
        ThreadCapability::parallel(Some(chunk_count))
    } else {
        ThreadCapability::single_threaded()
    }
}

fn apply_hdiffsf20(
    old_bytes: &[u8],
    patch_bytes: &[u8],
    header: &ParsedHdiffSf20,
) -> Result<Vec<u8>> {
    let old_data = HdiffOldData::Bytes(old_bytes);
    Ok(apply_hdiffsf20_with_step_parallelism(&old_data, patch_bytes, header, false)?.output)
}

fn hdiffsf20_apply_thread_capability(header: &ParsedHdiffSf20) -> ThreadCapability {
    let cover_count = usize::try_from(header.cover_count).unwrap_or(usize::MAX);
    if cover_count > 1 {
        ThreadCapability::parallel(Some(cover_count.min(64)))
    } else {
        ThreadCapability::single_threaded()
    }
}

fn apply_hdiffsf20_with_step_parallelism(
    old_data: &HdiffOldData<'_>,
    patch_bytes: &[u8],
    header: &ParsedHdiffSf20,
    enable_parallel_steps: bool,
) -> Result<HdiffSf20ApplyOutput> {
    let diff = read_hdiffsf20_diff_from_patch_bytes(patch_bytes, header)?;
    apply_hdiffsf20_with_diff(old_data, diff.as_slice(), header, enable_parallel_steps)
}

fn apply_hdiffsf20_with_step_parallelism_from_reader(
    old_data: &HdiffOldData<'_>,
    patch_reader: &Arc<Mutex<BlockCacheReader>>,
    patch_len: u64,
    header: &ParsedHdiffSf20,
    enable_parallel_steps: bool,
) -> Result<HdiffSf20ApplyOutput> {
    let diff = read_hdiffsf20_diff_from_patch_reader(patch_reader, patch_len, header)?;
    apply_hdiffsf20_with_diff(old_data, diff.as_slice(), header, enable_parallel_steps)
}

fn read_hdiffsf20_diff_from_patch_bytes(
    patch_bytes: &[u8],
    header: &ParsedHdiffSf20,
) -> Result<Vec<u8>> {
    let diff_start = header.diff_data_pos;
    let diff_raw_len = hdiff_chunk_raw_size(header.uncompressed_size, header.compressed_size);
    let diff_end = add_usize_u64(diff_start, diff_raw_len, "HDIFFSF20 diff end")?;
    if diff_end > patch_bytes.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 payload exceeded patch length".into(),
        ));
    }

    let diff = if header.compressed_size == 0 {
        patch_bytes[diff_start..diff_end].to_vec()
    } else {
        decompress_hdiff_payload(
            header.compression,
            &patch_bytes[diff_start..diff_end],
            header.uncompressed_size,
            "HDIFFSF20 payload",
        )?
    };
    Ok(diff)
}

fn read_hdiffsf20_diff_from_patch_reader(
    patch_reader: &Arc<Mutex<BlockCacheReader>>,
    patch_len: u64,
    header: &ParsedHdiffSf20,
) -> Result<Vec<u8>> {
    read_hdiff_chunk_from_reader(
        patch_reader,
        patch_len,
        header.diff_data_pos,
        header.uncompressed_size,
        header.compressed_size,
        header.compression,
        "HDIFFSF20 payload",
    )
}

fn apply_hdiffsf20_with_diff(
    old_data: &HdiffOldData<'_>,
    diff: &[u8],
    header: &ParsedHdiffSf20,
    enable_parallel_steps: bool,
) -> Result<HdiffSf20ApplyOutput> {
    let new_data_size = usize::try_from(header.new_data_size)
        .map_err(|_| RomWeaverError::Validation("HDIFFSF20 new size overflowed usize".into()))?;
    let parsed = parse_hdiffsf20_steps(diff, old_data.len(), new_data_size, header.cover_count)?;

    let mut output = vec![0u8; new_data_size];
    let used_parallelism = if enable_parallel_steps && parsed.steps.len() > 1 {
        let rendered = parsed
            .steps
            .par_iter()
            .map(|step| render_hdiffsf20_step(old_data, diff, step))
            .collect::<Result<Vec<_>>>()?;
        for (step, step_bytes) in parsed.steps.iter().zip(rendered.iter()) {
            write_hdiffsf20_step_bytes(output.as_mut_slice(), step, step_bytes)?;
        }
        true
    } else {
        for step in &parsed.steps {
            let step_bytes = render_hdiffsf20_step(old_data, diff, step)?;
            write_hdiffsf20_step_bytes(output.as_mut_slice(), step, step_bytes.as_slice())?;
        }
        false
    };

    if parsed.produced_len < new_data_size {
        output[parsed.produced_len..new_data_size].copy_from_slice(&diff[parsed.tail_range]);
    }

    Ok(HdiffSf20ApplyOutput {
        output,
        used_parallelism,
    })
}

fn parse_hdiffsf20_steps(
    diff: &[u8],
    old_len: usize,
    new_data_size: usize,
    cover_count: u64,
) -> Result<ParsedSf20Plan> {
    let mut diff_index = 0usize;
    let mut last_old_end = 0u64;
    let mut last_new_end = 0u64;
    let mut remaining_covers = cover_count;
    let mut steps = Vec::<Sf20StepPlan>::new();

    while remaining_covers > 0 {
        let cover_buf_size = usize::try_from(read_var_u64_slice(
            diff,
            &mut diff_index,
            "sf20 cover_buf_size",
        )?)
        .map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 cover_buf_size overflowed usize".into())
        })?;
        let rle_buf_size = usize::try_from(read_var_u64_slice(
            diff,
            &mut diff_index,
            "sf20 rle_buf_size",
        )?)
        .map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 rle_buf_size overflowed usize".into())
        })?;
        let step_size = cover_buf_size
            .checked_add(rle_buf_size)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 step size overflowed".into()))?;
        let step_end = diff_index
            .checked_add(step_size)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 step end overflowed".into()))?;
        if step_end > diff.len() {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step buffer exceeded payload".into(),
            ));
        }

        let cover_start = diff_index;
        let cover_end = cover_start + cover_buf_size;
        let rle_start = cover_end;
        let rle_end = step_end;
        let covers = &diff[cover_start..cover_end];
        diff_index = step_end;

        let step_output_start = usize::try_from(last_new_end).map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 step output start overflowed usize".into())
        })?;
        let step_gap_start = diff_index;
        let mut step_gap_cursor = diff_index;
        let mut cover_index = 0usize;
        let mut step_covers = Vec::<Sf20CoverPlan>::new();
        let covers_before = remaining_covers;

        while cover_index < covers.len() && remaining_covers > 0 {
            let p_sign = read_u8_slice(covers, &mut cover_index, "sf20 cover sign")?;
            let delta =
                read_var_u64_tagged_slice(covers, &mut cover_index, 1, p_sign, "sf20 cover delta")?;
            let old_pos = if (p_sign >> 7) == 0 {
                last_old_end.checked_add(delta).ok_or_else(|| {
                    RomWeaverError::Validation("HDIFFSF20 old position overflowed".into())
                })?
            } else {
                last_old_end.checked_sub(delta).ok_or_else(|| {
                    RomWeaverError::Validation("HDIFFSF20 old position underflowed".into())
                })?
            };
            let new_gap = read_var_u64_slice(covers, &mut cover_index, "sf20 new gap")?;
            let cover_length = read_var_u64_slice(covers, &mut cover_index, "sf20 cover length")?;
            let new_pos = last_new_end.checked_add(new_gap).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 new position overflowed".into())
            })?;

            let old_start = usize::try_from(old_pos).map_err(|_| {
                RomWeaverError::Validation("HDIFFSF20 old position overflowed usize".into())
            })?;
            let cover_len = usize::try_from(cover_length).map_err(|_| {
                RomWeaverError::Validation("HDIFFSF20 cover length overflowed usize".into())
            })?;
            let gap_len = usize::try_from(new_gap)
                .map_err(|_| RomWeaverError::Validation("HDIFFSF20 gap overflowed usize".into()))?;
            let old_end = old_start.checked_add(cover_len).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 old range overflowed".into())
            })?;
            if old_end > old_len {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 cover exceeded source bounds".into(),
                ));
            }

            step_gap_cursor = step_gap_cursor.checked_add(gap_len).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 gap cursor overflowed".into())
            })?;
            if step_gap_cursor > diff.len() {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 gap bytes exceeded payload".into(),
                ));
            }

            remaining_covers -= 1;
            step_covers.push(Sf20CoverPlan {
                old_start,
                cover_len,
                gap_len,
            });
            last_old_end = old_pos
                .checked_add(cover_length)
                .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 old end overflowed".into()))?;
            last_new_end = new_pos
                .checked_add(cover_length)
                .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 new end overflowed".into()))?;
        }

        if remaining_covers == covers_before {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step declared no decodable covers".into(),
            ));
        }

        let step_output_end = usize::try_from(last_new_end).map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 step output end overflowed usize".into())
        })?;
        if step_output_end < step_output_start {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step output moved backward".into(),
            ));
        }
        if let Some(previous) = steps.last() {
            let previous_end = previous
                .output_start
                .checked_add(previous.output_len)
                .ok_or_else(|| {
                    RomWeaverError::Validation("HDIFFSF20 step output range overflowed".into())
                })?;
            if step_output_start < previous_end {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 step output ranges overlapped".into(),
                ));
            }
        }

        steps.push(Sf20StepPlan {
            output_start: step_output_start,
            output_len: step_output_end - step_output_start,
            rle_range: rle_start..rle_end,
            gap_range: step_gap_start..step_gap_cursor,
            covers: step_covers,
        });
        diff_index = step_gap_cursor;
    }

    let produced_len = usize::try_from(last_new_end).map_err(|_| {
        RomWeaverError::Validation("HDIFFSF20 produced size overflowed usize".into())
    })?;
    if produced_len > new_data_size {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFFSF20_OUTPUT_SIZE_MISMATCH")
                .with_message("HDIFFSF20 output size mismatch")
                .with_field("expected", new_data_size)
                .with_field("actual", produced_len),
        ));
    }
    let tail_len = new_data_size - produced_len;
    let tail_end = diff_index
        .checked_add(tail_len)
        .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 tail range overflowed".into()))?;
    if tail_end > diff.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 tail diff bytes exceeded payload".into(),
        ));
    }

    Ok(ParsedSf20Plan {
        steps,
        tail_range: diff_index..tail_end,
        produced_len,
    })
}

fn render_hdiffsf20_step(
    old_data: &HdiffOldData<'_>,
    diff: &[u8],
    step: &Sf20StepPlan,
) -> Result<Vec<u8>> {
    if step.rle_range.end > diff.len() || step.gap_range.end > diff.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 step referenced bytes past payload".into(),
        ));
    }

    let mut output = Vec::with_capacity(step.output_len);
    let mut gap_index = 0usize;
    let gap_bytes = &diff[step.gap_range.clone()];
    let rle_bytes = &diff[step.rle_range.clone()];
    let mut rle_decoder = HdiffSf20RleDecoder::new(rle_bytes);

    for cover in &step.covers {
        if cover.gap_len > 0 {
            if gap_bytes.len().saturating_sub(gap_index) < cover.gap_len {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 step gap bytes ended unexpectedly".into(),
                ));
            }
            output.extend_from_slice(&gap_bytes[gap_index..gap_index + cover.gap_len]);
            gap_index += cover.gap_len;
        }

        let old_end = cover
            .old_start
            .checked_add(cover.cover_len)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 old range overflowed".into()))?;
        if old_end > old_data.len() {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 cover exceeded source bounds".into(),
            ));
        }
        let old_range = old_data.read_range(cover.old_start, cover.cover_len)?;
        output.extend_from_slice(old_range.as_slice());
        let begin = output.len() - cover.cover_len;
        rle_decoder.add(&mut output[begin..])?;
    }

    if gap_index != gap_bytes.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 step left unused gap bytes".into(),
        ));
    }
    if output.len() != step.output_len {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 rendered step size mismatch".into(),
        ));
    }

    Ok(output)
}

fn write_hdiffsf20_step_bytes(
    output: &mut [u8],
    step: &Sf20StepPlan,
    step_bytes: &[u8],
) -> Result<()> {
    if step_bytes.len() != step.output_len {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 rendered step length mismatch".into(),
        ));
    }
    let step_end = step
        .output_start
        .checked_add(step.output_len)
        .ok_or_else(|| {
            RomWeaverError::Validation("HDIFFSF20 step output range overflowed".into())
        })?;
    if step_end > output.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 step output exceeded target size".into(),
        ));
    }
    output[step.output_start..step_end].copy_from_slice(step_bytes);
    Ok(())
}

fn read_hdiff_chunk(
    patch_bytes: &[u8],
    start: usize,
    plain_size: u64,
    compressed_size: u64,
    compression: HdiffCompression,
    label: &'static str,
) -> Result<Vec<u8>> {
    let raw_size = hdiff_chunk_raw_size(plain_size, compressed_size);
    let end = add_usize_u64(start, raw_size, label)?;
    if end > patch_bytes.len() {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_CHUNK_EXCEEDED_PATCH_LENGTH")
                .with_field("label", label)
                .with_field("end", end)
                .with_field("patch_len", patch_bytes.len()),
        ));
    }

    if compressed_size == 0 {
        let plain_len = usize::try_from(plain_size).map_err(|_| {
            RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_CHUNK_SIZE_OVERFLOW_USIZE")
                    .with_field("label", label)
                    .with_field("plain_size", plain_size),
            )
        })?;
        return Ok(patch_bytes[start..start + plain_len].to_vec());
    }

    if compression == HdiffCompression::NoComp {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_CHUNK_COMPRESSED_BYTES_WITH_NOCOMP")
                .with_field("label", label),
        ));
    }

    let compressed = &patch_bytes[start..end];
    decompress_hdiff_payload(compression, compressed, plain_size, label)
}

fn read_hdiff_chunk_from_reader(
    patch_reader: &Arc<Mutex<BlockCacheReader>>,
    patch_len: u64,
    start: usize,
    plain_size: u64,
    compressed_size: u64,
    compression: HdiffCompression,
    label: &'static str,
) -> Result<Vec<u8>> {
    let raw_size = hdiff_chunk_raw_size(plain_size, compressed_size);
    let end = add_usize_u64(start, raw_size, label)?;
    let end_u64 = u64::try_from(end).map_err(|_| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_CHUNK_SIZE_OVERFLOW_U64")
                .with_field("label", label)
                .with_field("end", end),
        )
    })?;
    if end_u64 > patch_len {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_CHUNK_EXCEEDED_PATCH_LENGTH")
                .with_field("label", label)
                .with_field("end", end_u64)
                .with_field("patch_len", patch_len),
        ));
    }

    let raw_len = usize::try_from(raw_size).map_err(|_| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_CHUNK_SIZE_OVERFLOW_USIZE")
                .with_field("label", label)
                .with_field("raw_size", raw_size),
        )
    })?;
    let mut raw = vec![0u8; raw_len];
    {
        let mut guard = patch_reader.lock().map_err(|_| {
            RomWeaverError::Validation("HDiffPatch block cache lock is poisoned".into())
        })?;
        guard.read_exact_at(start as u64, raw.as_mut_slice())?;
    }

    if compressed_size == 0 {
        return Ok(raw);
    }
    if compression == HdiffCompression::NoComp {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_CHUNK_COMPRESSED_BYTES_WITH_NOCOMP")
                .with_field("label", label),
        ));
    }

    decompress_hdiff_payload(compression, raw.as_slice(), plain_size, label)
}

fn hdiff_chunk_raw_size(plain_size: u64, compressed_size: u64) -> u64 {
    if compressed_size == 0 {
        plain_size
    } else {
        compressed_size
    }
}

fn decompress_hdiff_payload(
    compression: HdiffCompression,
    compressed: &[u8],
    expected_len: u64,
    label: &'static str,
) -> Result<Vec<u8>> {
    match compression {
        HdiffCompression::NoComp => Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_CHUNK_COMPRESSED_BYTES_WITH_NOCOMP")
                .with_field("label", label),
        )),
        HdiffCompression::Zstd => decompress_zstd_to_vec(compressed, expected_len, label),
        HdiffCompression::Zlib => decompress_zlib_to_vec(compressed, expected_len, label),
        HdiffCompression::Bz2 => decompress_bz2_to_vec(compressed, expected_len, label),
        HdiffCompression::Lzma => decompress_lzma_to_vec(compressed, expected_len, label),
        HdiffCompression::Lzma2 => decompress_lzma2_to_vec(compressed, expected_len, label),
    }
}

fn decompress_zstd_to_vec(
    compressed: &[u8],
    expected_len: u64,
    label: &'static str,
) -> Result<Vec<u8>> {
    decode_zstd_exact(compressed, expected_len).map_err(|error| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_DECODE_FAILED")
                .with_field("label", label)
                .with_field("codec", "zstd")
                .with_field("error", error.to_string()),
        )
    })
}

fn decompress_zlib_to_vec(
    compressed: &[u8],
    expected_len: u64,
    label: &'static str,
) -> Result<Vec<u8>> {
    if compressed.is_empty() {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_ZLIB_WINDOW_BITS_PREFIX_MISSING")
                .with_field("label", label),
        ));
    }
    let window_bits = i8::from_ne_bytes([compressed[0]]);
    let payload = &compressed[1..];

    match window_bits {
        -15..=-8 => decode_deflate_exact(payload, expected_len).map_err(|error| {
            RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_DECODE_FAILED")
                    .with_field("label", label)
                    .with_field("codec", "zlib(deflate)")
                    .with_field("error", error.to_string()),
            )
        }),
        8..=15 => decode_zlib_exact(payload, expected_len).map_err(|error| {
            RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_DECODE_FAILED")
                    .with_field("label", label)
                    .with_field("codec", "zlib")
                    .with_field("error", error.to_string()),
            )
        }),
        _ => Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_ZLIB_WINDOW_BITS_UNSUPPORTED")
                .with_field("label", label)
                .with_field("window_bits", window_bits),
        )),
    }
}

fn decompress_bz2_to_vec(
    compressed: &[u8],
    expected_len: u64,
    label: &'static str,
) -> Result<Vec<u8>> {
    decode_bzip2_exact(compressed, expected_len).map_err(|error| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_DECODE_FAILED")
                .with_field("label", label)
                .with_field("codec", "bz2")
                .with_field("error", error.to_string()),
        )
    })
}

fn decompress_lzma_to_vec(
    compressed: &[u8],
    expected_len: u64,
    label: &'static str,
) -> Result<Vec<u8>> {
    if compressed.is_empty() {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA_PROPS_MISSING").with_field("label", label),
        ));
    }
    let props_size = usize::from(compressed[0]);
    if props_size == 0 {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA_PROPS_SIZE_ZERO").with_field("label", label),
        ));
    }

    let props_begin = 1usize;
    let props_end = props_begin.checked_add(props_size).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA_PROPS_OVERFLOW")
                .with_field("label", label)
                .with_field("props_size", props_size),
        )
    })?;
    if props_end > compressed.len() {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA_PROPS_EXCEEDED_PAYLOAD")
                .with_field("label", label)
                .with_field("props_end", props_end)
                .with_field("payload_len", compressed.len()),
        ));
    }

    let props = &compressed[props_begin..props_end];
    if props.len() < 5 {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA_PROPS_TOO_SHORT")
                .with_field("label", label)
                .with_field("props_len", props.len()),
        ));
    }

    let props_byte = props[0];
    let dict_size = u32::from_le_bytes([props[1], props[2], props[3], props[4]]);
    let payload = &compressed[props_end..];

    decode_lzma_with_props(payload, expected_len, props_byte, dict_size).map_err(|error| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_DECODE_FAILED")
                .with_field("label", label)
                .with_field("codec", "lzma")
                .with_field("error", error.to_string()),
        )
    })
}

fn decompress_lzma2_to_vec(
    compressed: &[u8],
    expected_len: u64,
    label: &'static str,
) -> Result<Vec<u8>> {
    if compressed.is_empty() {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA2_PROPS_MISSING").with_field("label", label),
        ));
    }

    let property = compressed[0];
    let dict_size = decode_lzma2_dict_size(property, label)?;
    let payload = &compressed[1..];

    decode_lzma2(payload, expected_len, dict_size).map_err(|error| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_DECODE_FAILED")
                .with_field("label", label)
                .with_field("codec", "lzma2")
                .with_field("error", error.to_string()),
        )
    })
}

fn decode_lzma2_dict_size(property: u8, label: &'static str) -> Result<u32> {
    let bits = u32::from(property);
    if (bits & !0x3f) != 0 {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA2_PROPERTY_FLAG_BITS_UNSUPPORTED")
                .with_field("label", label)
                .with_field("property", property),
        ));
    }
    if bits > 40 {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA2_PROPERTY_MAX_EXCEEDED")
                .with_field("label", label)
                .with_field("property", property),
        ));
    }
    if bits == 40 {
        return Ok(u32::MAX);
    }

    let shift = bits / 2 + 11;
    let size = (2 | (bits & 1)).checked_shl(shift).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_LZMA2_DICTIONARY_SIZE_OVERFLOW")
                .with_field("label", label)
                .with_field("property", property),
        )
    })?;
    Ok(size)
}

#[derive(Default)]
struct HdiffRleState {
    set_length: usize,
    set_value: u8,
    copy_length: usize,
}

fn apply_hdiff_rle(
    target: &mut [u8],
    rle_ctrl: &[u8],
    rle_ctrl_index: &mut usize,
    rle_code: &[u8],
    rle_code_index: &mut usize,
    state: &mut HdiffRleState,
) -> Result<()> {
    let mut offset = 0usize;

    apply_hdiff_rle_pending(target, &mut offset, rle_code, rle_code_index, state, false)?;
    if offset >= target.len() {
        return Ok(());
    }
    if *rle_ctrl_index >= rle_ctrl.len() {
        return Ok(());
    }

    while offset < target.len() {
        if *rle_ctrl_index >= rle_ctrl.len() {
            return Ok(());
        }
        let p_sign = read_u8_slice(rle_ctrl, rle_ctrl_index, "rle ctrl")?;
        let rle_type = p_sign >> 6;
        let length =
            read_var_u64_tagged_slice(rle_ctrl, rle_ctrl_index, 2, p_sign, "rle ctrl length")?
                .checked_add(1)
                .ok_or_else(|| {
                    RomWeaverError::Validation("HDiffPatch rle length overflowed".into())
                })?;
        let length_usize = usize::try_from(length).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch rle length overflowed usize".into())
        })?;

        if rle_type == 3 {
            state.copy_length = length_usize;
        } else if rle_type == 2 {
            state.set_length = length_usize;
            state.set_value = read_u8_slice(rle_code, rle_code_index, "rle value")?;
        } else {
            state.set_length = length_usize;
            state.set_value = (0u8).wrapping_sub(rle_type);
        }

        apply_hdiff_rle_pending(target, &mut offset, rle_code, rle_code_index, state, true)?;
    }

    Ok(())
}

fn apply_hdiff_rle_pending(
    target: &mut [u8],
    offset: &mut usize,
    rle_code: &[u8],
    rle_code_index: &mut usize,
    state: &mut HdiffRleState,
    allow_partial: bool,
) -> Result<()> {
    while *offset < target.len() {
        if state.set_length > 0 {
            let remaining = target.len() - *offset;
            let step = state.set_length.min(remaining);
            if state.set_value != 0 {
                for byte in &mut target[*offset..*offset + step] {
                    *byte = byte.wrapping_add(state.set_value);
                }
            }
            state.set_length -= step;
            *offset += step;
            if !allow_partial {
                continue;
            }
            if step < remaining {
                continue;
            }
        }

        if state.copy_length > 0 {
            let remaining = target.len() - *offset;
            let step = state.copy_length.min(remaining);
            if rle_code.len().saturating_sub(*rle_code_index) < step {
                return Err(RomWeaverError::Validation(
                    "HDiffPatch rle_code ended unexpectedly".into(),
                ));
            }
            let source = &rle_code[*rle_code_index..*rle_code_index + step];
            for (dst, src) in target[*offset..*offset + step]
                .iter_mut()
                .zip(source.iter().copied())
            {
                *dst = dst.wrapping_add(src);
            }
            *rle_code_index += step;
            state.copy_length -= step;
            *offset += step;
            if !allow_partial {
                continue;
            }
            if step < remaining {
                continue;
            }
        }

        break;
    }
    Ok(())
}

struct HdiffSf20RleDecoder<'a> {
    bytes: &'a [u8],
    index: usize,
    len_zero: usize,
    len_value: usize,
    decode_zero_phase: bool,
}

impl<'a> HdiffSf20RleDecoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            index: 0,
            len_zero: 0,
            len_value: 0,
            decode_zero_phase: true,
        }
    }

    fn add(&mut self, target: &mut [u8]) -> Result<()> {
        let mut offset = 0usize;

        while offset < target.len() {
            if self.len_zero > 0 {
                let step = self.len_zero.min(target.len() - offset);
                self.len_zero -= step;
                offset += step;
                continue;
            }

            if self.len_value > 0 {
                let step = self.len_value.min(target.len() - offset);
                if self.bytes.len().saturating_sub(self.index) < step {
                    return Err(RomWeaverError::Validation(
                        "HDIFFSF20 rle data ended unexpectedly".into(),
                    ));
                }
                let value_bytes = &self.bytes[self.index..self.index + step];
                for (dst, src) in target[offset..offset + step]
                    .iter_mut()
                    .zip(value_bytes.iter().copied())
                {
                    *dst = dst.wrapping_add(src);
                }
                self.index += step;
                self.len_value -= step;
                offset += step;
                continue;
            }

            if self.decode_zero_phase {
                self.decode_zero_phase = false;
                self.len_zero = read_rle_varint(self.bytes, &mut self.index, "sf20 rle zero")?;
            } else {
                self.decode_zero_phase = true;
                self.len_value = read_rle_varint(self.bytes, &mut self.index, "sf20 rle value")?;
            }
        }

        Ok(())
    }
}

fn read_rle_varint(bytes: &[u8], index: &mut usize, label: &'static str) -> Result<usize> {
    let first = read_u8_slice(bytes, index, label)?;
    let mut value = u64::from(first & 0x7f);

    if (first & 0x80) != 0 {
        loop {
            let byte = read_u8_slice(bytes, index, label)?;
            value = value
                .checked_shl(7)
                .and_then(|value| value.checked_add(u64::from(byte & 0x7f)))
                .ok_or_else(|| {
                    RomWeaverError::Validation("HDIFFSF20 rle varint overflowed".into())
                })?;
            if (byte & 0x80) == 0 {
                break;
            }
        }
    }

    usize::try_from(value)
        .map_err(|_| RomWeaverError::Validation("HDIFFSF20 rle varint overflowed usize".into()))
}

fn append_from_new_diff(
    output: &mut Vec<u8>,
    source: &[u8],
    source_index: &mut usize,
    len: usize,
    label: &'static str,
) -> Result<()> {
    if source.len().saturating_sub(*source_index) < len {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_NEW_DIFF_UNEXPECTED_EOF")
                .with_field("label", label)
                .with_field("source_index", *source_index)
                .with_field("len", len)
                .with_field("source_len", source.len()),
        ));
    }
    output.extend_from_slice(&source[*source_index..*source_index + len]);
    *source_index += len;
    Ok(())
}

fn read_null_terminated_string(bytes: &[u8], max_len: usize) -> Result<(String, usize)> {
    let limit = bytes.len().min(max_len);
    for index in 0..limit {
        if bytes[index] == 0 {
            let text = std::str::from_utf8(&bytes[..index]).map_err(|_| {
                RomWeaverError::Validation("HDiffPatch header contained non-UTF8 bytes".into())
            })?;
            return Ok((text.to_string(), index + 1));
        }
    }

    Err(RomWeaverError::Validation(
        "HDiffPatch header was missing null terminator".into(),
    ))
}

fn read_bool_byte(bytes: &[u8], index: &mut usize, label: &'static str) -> Result<bool> {
    Ok(read_u8_slice(bytes, index, label)? != 0)
}

fn read_u8_slice(bytes: &[u8], index: &mut usize, label: &'static str) -> Result<u8> {
    if *index >= bytes.len() {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_READ_UNEXPECTED_EOF")
                .with_field("label", label)
                .with_field("index", *index)
                .with_field("len", bytes.len()),
        ));
    }
    let byte = bytes[*index];
    *index += 1;
    Ok(byte)
}

fn read_var_u64(bytes: &[u8], index: &mut usize, label: &'static str) -> Result<u64> {
    read_var_u64_tagged_slice(bytes, index, 0, 0, label)
}

fn read_var_u64_slice(bytes: &[u8], index: &mut usize, label: &'static str) -> Result<u64> {
    read_var_u64(bytes, index, label)
}

fn read_var_u64_tagged_slice(
    bytes: &[u8],
    index: &mut usize,
    tag_bits: u8,
    first_byte: u8,
    label: &'static str,
) -> Result<u64> {
    if tag_bits > 6 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch varint tag_bits must be <= 6".into(),
        ));
    }

    let first = if tag_bits == 0 {
        read_u8_slice(bytes, index, label)?
    } else {
        first_byte
    };

    let continuation_bit = 1u8 << (7 - tag_bits);
    let payload_mask = continuation_bit - 1;

    let mut value = u64::from(first & payload_mask);
    if (first & continuation_bit) == 0 {
        return Ok(value);
    }

    loop {
        let byte = read_u8_slice(bytes, index, label)?;
        value = value
            .checked_shl(7)
            .and_then(|value| value.checked_add(u64::from(byte & 0x7f)))
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch varint overflowed".into()))?;
        if (byte & 0x80) == 0 {
            break;
        }
    }

    Ok(value)
}

fn add_usize_u64(start: usize, amount: u64, label: &'static str) -> Result<usize> {
    let amount = usize::try_from(amount).map_err(|_| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_USIZE_CONVERSION_OVERFLOW")
                .with_field("label", label)
                .with_field("amount", amount),
        )
    })?;
    start.checked_add(amount).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_USIZE_ADD_OVERFLOW")
                .with_field("label", label)
                .with_field("start", start)
                .with_field("amount", amount),
        )
    })
}

#[cfg(test)]
fn write_var_u64(out: &mut Vec<u8>, mut value: u64) {
    let mut groups = [0u8; 10];
    let mut count = 0usize;
    loop {
        groups[count] = (value & 0x7f) as u8;
        count += 1;
        value >>= 7;
        if value == 0 {
            break;
        }
    }

    for index in (0..count).rev() {
        let mut byte = groups[index];
        if index != 0 {
            byte |= 0x80;
        }
        out.push(byte);
    }
}

#[cfg(test)]
fn build_uncompressed_hdiff13_patch(old_bytes: &[u8], new_bytes: &[u8]) -> Result<Vec<u8>> {
    let old_size = u64::try_from(old_bytes.len())
        .map_err(|_| RomWeaverError::Validation("old file length overflowed u64".into()))?;
    let new_size = u64::try_from(new_bytes.len())
        .map_err(|_| RomWeaverError::Validation("new file length overflowed u64".into()))?;

    let mut out = Vec::with_capacity(64usize.saturating_add(new_bytes.len()));
    write_uncompressed_hdiff13_header_vec(&mut out, old_size, new_size);

    out.extend_from_slice(new_bytes);
    Ok(out)
}

#[cfg(test)]
fn write_uncompressed_hdiff13_header_vec(out: &mut Vec<u8>, old_size: u64, new_size: u64) {
    out.extend_from_slice(b"HDIFF13&nocomp");
    out.push(0);
    write_var_u64(out, new_size);
    write_var_u64(out, old_size);
    write_var_u64(out, 0); // cover_count
    write_var_u64(out, 0); // cover_buf_size
    write_var_u64(out, 0); // compress_cover_buf_size
    write_var_u64(out, 0); // rle_ctrl_buf_size
    write_var_u64(out, 0); // compress_rle_ctrl_buf_size
    write_var_u64(out, 0); // rle_code_buf_size
    write_var_u64(out, 0); // compress_rle_code_buf_size
    write_var_u64(out, new_size); // new_data_diff_size
    write_var_u64(out, 0); // compress_new_data_diff_size
}

#[cfg(test)]
#[path = "../tests/unit/hdiffpatch.rs"]
mod tests;
