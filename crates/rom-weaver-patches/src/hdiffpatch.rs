use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    sync::Arc,
};

use rayon::prelude::*;
use rom_weaver_core::codecs::{
    decode_bzip2_exact, decode_deflate_exact, decode_lzma_with_props, decode_lzma2,
    decode_zlib_exact, decode_zstd_exact,
};
use rom_weaver_core::{
    DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchCreateRequest, PatchHandler, PatchValidateRequest, ProbeConfidence, Result,
    RomWeaverError, SharedBlockCacheReader, StagedOutput, ThreadCapability, ThreadExecution,
    UnsupportedOp, ValidationCodeError,
};

use tracing::{debug, trace};

use crate::shared::threading::run_with_optional_pool;

const HDIFF13_OUTPUT_BUFFER_SIZE: usize = 1024 * 1024;

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
        debug!(
            format = self.descriptor.name,
            patch = %patch_path.display(),
            "hdiffpatch apply start"
        );
        let replacement = StagedOutput::new(&request.output)?;
        let target_path = replacement.path();
        let staged_path = fs::symlink_metadata(target_path).is_ok().then(|| {
            context
                .temp_paths()
                .next_path("hdiffpatch-output", Some("bin"))
        });
        let output_path = staged_path.as_deref().unwrap_or(target_path);
        let rendered: Result<_> = (|| {
            let rendered = render_hdiff_patch(&request.input, patch_path, context, || {
                crate::create_buffered_output(output_path)
            })?;
            if staged_path.is_some() {
                trace!("hdiffpatch copying completed output over an existing file");
                let mut source = BufReader::new(File::open(output_path)?);
                let mut output = crate::create_buffered_output(target_path)?;
                std::io::copy(&mut source, &mut output)?;
                output.flush()?;
            }
            Ok(rendered)
        })();
        if let Some(path) = staged_path {
            let _ = fs::remove_file(path);
        } else if rendered.is_err() {
            let _ = fs::remove_file(target_path);
        }
        let (output_len, execution) = rendered?;
        replacement.commit()?;

        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch; output {} byte(s)",
                self.descriptor.name, output_len
            ),
            Some(execution),
        ))
    }

    fn validate(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let (output_len, execution) =
            render_hdiff_patch(&request.input, patch_path, context, || Ok(std::io::sink()))?;

        Ok(crate::patch_success_report(
            self.descriptor,
            "validate",
            format!(
                "validated {} patch; output would be {} byte(s)",
                self.descriptor.name, output_len
            ),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.single_thread_execution();
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

fn render_hdiff_patch<W: Write>(
    input_path: &Path,
    patch_path: &Path,
    context: &OperationContext,
    create_output: impl Fn() -> Result<W>,
) -> Result<(usize, ThreadExecution)> {
    let variant = parse_hdiff_patch_file(patch_path)?;
    let patch_len = fs::metadata(patch_path)?.len();
    let patch_reader = Arc::new(SharedBlockCacheReader::open(
        patch_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?);
    let old_len = fs::metadata(input_path)?.len();
    let old_data = HdiffOldData::from_path(input_path)?;

    match variant {
        ParsedPatchVariant::SingleFile13(header) => {
            if old_len != header.old_data_size {
                return Err(RomWeaverError::ValidationCode(
                    hdiff_validation_code("HDIFF_SOURCE_SIZE_MISMATCH")
                        .with_message("HDiffPatch source size mismatch")
                        .with_field("expected", header.old_data_size)
                        .with_field("actual", old_len),
                ));
            }
            trace!(
                variant = "HDIFF13",
                old_len,
                new_len = header.new_data_size,
                cover_count = header.cover_count,
                "hdiffpatch render; chunk-parallel apply via worker pool"
            );

            let thread_capability = hdiff13_apply_thread_capability(&header);
            let (execution, chunks) = run_with_optional_pool(
                context,
                thread_capability,
                true,
                |pool| {
                    // `pool.size()` always matches the negotiated
                    // `effective_threads`, so chunk-level parallelism stays
                    // disabled after a single-thread pool fallback.
                    let chunk_parallel = pool.size() > 1;
                    pool.install(|| {
                        read_hdiff13_chunks_from_patch_reader(
                            &patch_reader,
                            patch_len,
                            &header,
                            chunk_parallel,
                        )
                    })
                },
                || read_hdiff13_chunks_from_patch_reader(&patch_reader, patch_len, &header, false),
            )?;
            let mut output = create_output()?;
            let output_len = apply_hdiff13_with_chunks(&old_data, &header, chunks, &mut output)?;
            output.flush()?;
            Ok((output_len, execution))
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
            trace!(
                variant = "HDIFFSF20",
                old_len,
                new_len = header.new_data_size,
                cover_count = header.cover_count,
                "hdiffpatch render; step-parallel apply via worker pool"
            );

            let thread_capability = hdiffsf20_apply_thread_capability(&header);
            // The serial branch never reports a step-parallelism fallback, so
            // each branch tags whether the parallel path ran.
            let (mut execution, (apply, ran_parallel)) = run_with_optional_pool(
                context,
                thread_capability,
                true,
                |pool| {
                    // `pool.size()` always matches the negotiated
                    // `effective_threads`, so step-level parallelism stays
                    // disabled after a single-thread pool fallback.
                    let step_parallel = pool.size() > 1;
                    pool.install(|| {
                        apply_hdiffsf20_with_step_parallelism_from_reader(
                            &old_data,
                            &patch_reader,
                            patch_len,
                            &header,
                            step_parallel,
                        )
                    })
                    .map(|apply| (apply, true))
                },
                || {
                    apply_hdiffsf20_with_step_parallelism_from_reader(
                        &old_data,
                        &patch_reader,
                        patch_len,
                        &header,
                        false,
                    )
                    .map(|apply| (apply, false))
                },
            )?;
            if ran_parallel && !apply.used_parallelism {
                execution.apply_pool_fallback(
                    "HDIFFSF20 payload had no independent step-level parallel work".to_string(),
                );
            }
            let mut output = create_output()?;
            output.write_all(&apply.output)?;
            output.flush()?;
            Ok((apply.output.len(), execution))
        }
        ParsedPatchVariant::Directory19(_) => Err(RomWeaverError::Unsupported(
            UnsupportedOp::HdiffDirectoryPatch,
        )),
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

/// Compressor names the reference decompress plugins define but this handler cannot decode.
const HDIFF_UNSUPPORTED_COMPRESSORS: [&str; 5] = ["lz4", "brotli", "lzham", "tuz", "7zxz"];

impl HdiffCompression {
    fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "nocomp" => Ok(Self::NoComp),
            "zstd" => Ok(Self::Zstd),
            "zlib" | "pzlib" => Ok(Self::Zlib),
            "bz2" | "pbz2" | "bzip2" | "pbzip2" => Ok(Self::Bz2),
            "lzma" => Ok(Self::Lzma),
            "lzma2" => Ok(Self::Lzma2),
            other if HDIFF_UNSUPPORTED_COMPRESSORS.contains(&other) => Err(
                RomWeaverError::Unsupported(UnsupportedOp::HdiffCompression {
                    compression: other.to_string(),
                }),
            ),
            other => Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_COMPRESSION_UNRECOGNIZED")
                    .with_message("HDiffPatch compression is not recognized")
                    .with_field("compression", other),
            )),
        }
    }

    /// Parses a raw header name; a name that is not UTF-8 matches no compressor.
    fn parse_bytes(value: &[u8]) -> Result<Self> {
        match std::str::from_utf8(value) {
            Ok(text) => Self::parse(text),
            Err(_) => Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_COMPRESSION_UNRECOGNIZED")
                    .with_message("HDiffPatch compression is not recognized")
                    .with_field("compression", String::from_utf8_lossy(value).into_owned()),
            )),
        }
    }

    /// Resolves the header's compressor name only when a chunk is actually compressed;
    /// patch.c never consults the name for a patch whose chunks are all stored raw.
    fn resolve(value: &[u8], has_compressed_chunks: bool) -> Result<Self> {
        if has_compressed_chunks {
            Self::parse_bytes(value)
        } else {
            Ok(Self::NoComp)
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
        decode_hdiff_varint(tag_bits, first_byte, || self.read_u8(label))
    }

    fn read_null_terminated_bytes(&mut self, max_len: usize) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        for _ in 0..max_len {
            let byte = self.read_u8("header")?;
            if byte == 0 {
                return Ok(bytes);
            }
            bytes.push(byte);
        }
        Err(RomWeaverError::Validation(
            "HDiffPatch header was missing null terminator".into(),
        ))
    }
}

enum HdiffOldData {
    #[cfg(test)]
    Bytes(Vec<u8>),
    Cached {
        len: usize,
        reader: Arc<SharedBlockCacheReader>,
    },
}

impl HdiffOldData {
    fn from_path(path: &Path) -> Result<Self> {
        let reader = SharedBlockCacheReader::open(
            path,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )?;
        let len = usize::try_from(fs::metadata(path)?.len()).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch input size overflowed usize".into())
        })?;
        Ok(Self::Cached {
            len,
            reader: Arc::new(reader),
        })
    }

    fn len(&self) -> usize {
        match self {
            #[cfg(test)]
            Self::Bytes(bytes) => bytes.len(),
            Self::Cached { len, .. } => *len,
        }
    }

    fn read_into(&self, start: usize, output: &mut [u8]) -> Result<()> {
        let end = start.checked_add(output.len()).ok_or_else(|| {
            RomWeaverError::Validation("HDiffPatch source range overflowed".into())
        })?;
        if end > self.len() {
            return Err(RomWeaverError::Validation(
                "HDiffPatch source range exceeded bounds".into(),
            ));
        }
        match self {
            #[cfg(test)]
            Self::Bytes(bytes) => output.copy_from_slice(&bytes[start..end]),
            Self::Cached { reader, .. } => reader.read_exact_at(start as u64, output)?,
        }
        Ok(())
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

/// Layouts `hdiffz` can write that are valid HDiffPatch patches but are not implemented here.
const HDIFF_UNSUPPORTED_LAYOUT_SIGNATURES: [(&[u8], &str); 2] = [
    (b"HDIFFW26", "HDIFFW26 windowed patch"),
    (b"ENDSLEY/BSDIFF43", "ENDSLEY/BSDIFF43 patch"),
];

fn unsupported_layout_error(layout: &'static str) -> RomWeaverError {
    RomWeaverError::Unsupported(UnsupportedOp::HdiffLayout { layout })
}

/// hdiffz writes an HDIFF19 directory diff when either side is a directory
/// (dir_patch.c reads both flags); only directory-to-directory patches reach the
/// directory handler, so every other combination is named here.
fn reject_hdiff19_non_directory_layout(is_input_dir: bool, is_output_dir: bool) -> Result<()> {
    match (is_input_dir, is_output_dir) {
        (true, true) => Ok(()),
        (false, false) => Err(unsupported_layout_error("HDIFF19 file-to-file diff")),
        (false, true) => Err(unsupported_layout_error("HDIFF19 file-to-directory diff")),
        (true, false) => Err(unsupported_layout_error("HDIFF19 directory-to-file diff")),
    }
}

/// Whether any HDIFF13 chunk is stored compressed, which decides if the named compressor is needed.
fn hdiff13_has_compressed_chunks(
    compress_cover_buf_size: u64,
    compress_rle_ctrl_buf_size: u64,
    compress_rle_code_buf_size: u64,
    compress_new_data_diff_size: u64,
) -> bool {
    [
        compress_cover_buf_size,
        compress_rle_ctrl_buf_size,
        compress_rle_code_buf_size,
        compress_new_data_diff_size,
    ]
    .into_iter()
    .any(|size| size > 0)
}

fn reject_unsupported_layout(prefix: &[u8]) -> Result<()> {
    for (signature, layout) in HDIFF_UNSUPPORTED_LAYOUT_SIGNATURES {
        if prefix.starts_with(signature) {
            return Err(unsupported_layout_error(layout));
        }
    }
    Ok(())
}

fn parse_hdiff_patch_file(path: &Path) -> Result<ParsedPatchVariant> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    reject_unsupported_layout(reader.fill_buf()?)?;
    let mut parser = HdiffFileParser::new(reader, file_len);

    let header_text = parser.read_null_terminated_bytes(1024)?;
    let parts = header_text.split(|&byte| byte == b'&').collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch header is incomplete".into(),
        ));
    }

    let magic = String::from_utf8_lossy(parts[0]);
    let compression_name = parts[1];

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
        let has_compressed_chunks = hdiff13_has_compressed_chunks(
            compress_cover_buf_size,
            compress_rle_ctrl_buf_size,
            compress_rle_code_buf_size,
            compress_new_data_diff_size,
        );

        ParsedPatchVariant::SingleFile13(ParsedHdiff13 {
            compression: HdiffCompression::resolve(compression_name, has_compressed_chunks)?,
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
        check_hdiffsf20_header_sizes(
            new_data_size,
            step_mem_size,
            uncompressed_size,
            compressed_size,
        )?;

        ParsedPatchVariant::SingleStream20(ParsedHdiffSf20 {
            compression: HdiffCompression::resolve(compression_name, compressed_size > 0)?,
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

        reject_hdiff19_non_directory_layout(is_input_dir, is_output_dir)?;

        ParsedPatchVariant::Directory19(ParsedHdiffDir19 {
            compression: HdiffCompression::parse_bytes(compression_name)?,
            old_data_size: input_sum_size,
            new_data_size: output_sum_size,
        })
    } else {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_MAGIC_UNSUPPORTED")
                .with_message("HDiffPatch magic is not supported")
                .with_field("magic", magic.as_ref()),
        ));
    };

    Ok(variant)
}

/// Slack the reference allows `step_mem_size` above the data sizes (patch.c `_kStepMemSizeSafeLimit`).
const HDIFFSF20_STEP_MEM_SLACK: u64 = 4 * 1024 * 1024;

/// The HDIFFSF20 header checks of patch.c `getSingleCompressedDiffInfo`.
fn check_hdiffsf20_header_sizes(
    new_data_size: u64,
    step_mem_size: u64,
    uncompressed_size: u64,
    compressed_size: u64,
) -> Result<()> {
    let step_mem_limit = new_data_size
        .min(uncompressed_size)
        .saturating_add(HDIFFSF20_STEP_MEM_SLACK);
    if compressed_size > uncompressed_size || step_mem_size > step_mem_limit {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFFSF20_HEADER_SIZES_INCONSISTENT")
                .with_message("HDIFFSF20 header sizes are inconsistent")
                .with_field("new_data_size", new_data_size)
                .with_field("step_mem_size", step_mem_size)
                .with_field("uncompressed_size", uncompressed_size)
                .with_field("compressed_size", compressed_size),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn parse_hdiff_patch_view(raw: &[u8]) -> Result<ParsedPatchVariant> {
    reject_unsupported_layout(raw)?;
    let (header_text, mut index) = read_null_terminated_bytes(raw, 1024)?;
    let parts = header_text.split(|&byte| byte == b'&').collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch header is incomplete".into(),
        ));
    }

    let magic = String::from_utf8_lossy(parts[0]);
    let compression_name = parts[1];

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
        let has_compressed_chunks = hdiff13_has_compressed_chunks(
            compress_cover_buf_size,
            compress_rle_ctrl_buf_size,
            compress_rle_code_buf_size,
            compress_new_data_diff_size,
        );

        ParsedPatchVariant::SingleFile13(ParsedHdiff13 {
            compression: HdiffCompression::resolve(compression_name, has_compressed_chunks)?,
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
        check_hdiffsf20_header_sizes(
            new_data_size,
            step_mem_size,
            uncompressed_size,
            compressed_size,
        )?;

        ParsedPatchVariant::SingleStream20(ParsedHdiffSf20 {
            compression: HdiffCompression::resolve(compression_name, compressed_size > 0)?,
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

        reject_hdiff19_non_directory_layout(is_input_dir, is_output_dir)?;

        ParsedPatchVariant::Directory19(ParsedHdiffDir19 {
            compression: HdiffCompression::parse_bytes(compression_name)?,
            old_data_size: input_sum_size,
            new_data_size: output_sum_size,
        })
    } else {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_MAGIC_UNSUPPORTED")
                .with_message("HDiffPatch magic is not supported")
                .with_field("magic", magic.as_ref()),
        ));
    };

    Ok(variant)
}

#[cfg(test)]
fn apply_hdiff13(old_bytes: &[u8], patch_bytes: &[u8], header: &ParsedHdiff13) -> Result<Vec<u8>> {
    let old_data = HdiffOldData::Bytes(old_bytes.to_vec());
    apply_hdiff13_with_chunk_parallelism(&old_data, patch_bytes, header, false)
}

#[cfg(test)]
fn apply_hdiff13_with_chunk_parallelism(
    old_data: &HdiffOldData,
    patch_bytes: &[u8],
    header: &ParsedHdiff13,
    parallel_chunks: bool,
) -> Result<Vec<u8>> {
    let chunks = read_hdiff13_chunks_from_patch_bytes(patch_bytes, header, parallel_chunks)?;
    let mut output = Vec::new();
    apply_hdiff13_with_chunks(old_data, header, chunks, &mut output)?;
    Ok(output)
}

#[derive(Debug)]
struct Hdiff13Chunks {
    cover_raw: Vec<u8>,
    rle_ctrl_raw: Vec<u8>,
    rle_code_raw: Vec<u8>,
    new_diff_raw: Vec<u8>,
}

/// Returns the four chunk start offsets, and fails when bytes follow the last chunk
/// (patch.c requires the chunks to end exactly at the end of the patch).
fn hdiff13_chunk_offsets(
    header: &ParsedHdiff13,
    patch_len: u64,
) -> Result<(usize, usize, usize, usize)> {
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
    let new_diff_end = add_usize_u64(
        new_diff_start,
        hdiff_chunk_raw_size(
            header.new_data_diff_size,
            header.compress_new_data_diff_size,
        ),
        "new_data_diff end",
    )?;
    if u64::try_from(new_diff_end).is_ok_and(|end| end < patch_len) {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_TRAILING_BYTES")
                .with_message("HDiffPatch patch has bytes after the last chunk")
                .with_field("chunks_end", new_diff_end)
                .with_field("patch_len", patch_len),
        ));
    }
    Ok((cover_start, rle_ctrl_start, rle_code_start, new_diff_start))
}

#[cfg(test)]
fn read_hdiff13_chunks_from_patch_bytes(
    patch_bytes: &[u8],
    header: &ParsedHdiff13,
    parallel_chunks: bool,
) -> Result<Hdiff13Chunks> {
    let patch_len = u64::try_from(patch_bytes.len())
        .map_err(|_| RomWeaverError::Validation("HDiffPatch patch length overflowed u64".into()))?;
    let (cover_start, rle_ctrl_start, rle_code_start, new_diff_start) =
        hdiff13_chunk_offsets(header, patch_len)?;

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
    patch_reader: &Arc<SharedBlockCacheReader>,
    patch_len: u64,
    header: &ParsedHdiff13,
    parallel_chunks: bool,
) -> Result<Hdiff13Chunks> {
    let (cover_start, rle_ctrl_start, rle_code_start, new_diff_start) =
        hdiff13_chunk_offsets(header, patch_len)?;
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

/// One cover decoded from the HDIFF13 cover buffer.
struct Hdiff13Cover {
    old_pos: u64,
    cover_length: u64,
    new_pos: u64,
    new_end: u64,
}

/// Reads covers from the HDIFF13 cover buffer, tracking the end of the previous cover.
struct Hdiff13CoverReader<'a> {
    raw: &'a [u8],
    index: usize,
    last_old_end: u64,
    last_new_end: u64,
    new_data_size: usize,
}

impl<'a> Hdiff13CoverReader<'a> {
    fn new(raw: &'a [u8], new_data_size: usize) -> Self {
        Self {
            raw,
            index: 0,
            last_old_end: 0,
            last_new_end: 0,
            new_data_size,
        }
    }

    fn bytes_left(&self) -> usize {
        self.raw.len() - self.index
    }

    fn read_cover(&mut self) -> Result<Hdiff13Cover> {
        let p_sign = read_u8_slice(self.raw, &mut self.index, "cover sign")?;
        let old_sign = p_sign >> 7;
        let old_delta =
            read_var_u64_tagged_slice(self.raw, &mut self.index, 1, p_sign, "cover old_delta")?;
        let old_pos = if old_sign == 0 {
            self.last_old_end.checked_add(old_delta).ok_or_else(|| {
                RomWeaverError::Validation("HDiffPatch cover old position overflowed".into())
            })?
        } else {
            self.last_old_end.checked_sub(old_delta).ok_or_else(|| {
                RomWeaverError::Validation("HDiffPatch cover old position underflowed".into())
            })?
        };

        let copy_length = read_var_u64(self.raw, &mut self.index, "cover copy")?;
        let cover_length = read_var_u64(self.raw, &mut self.index, "cover length")?;

        let new_data_limit = self.new_data_size as u64;
        let new_pos = self
            .last_new_end
            .checked_add(copy_length)
            .filter(|&position| position <= new_data_limit)
            .ok_or_else(|| hdiff13_output_size_mismatch(self.new_data_size))?;
        let new_end = new_pos
            .checked_add(cover_length)
            .filter(|&position| position <= new_data_limit)
            .ok_or_else(|| hdiff13_output_size_mismatch(self.new_data_size))?;
        Ok(Hdiff13Cover {
            old_pos,
            cover_length,
            new_pos,
            new_end,
        })
    }

    fn finish_cover(&mut self, cover: &Hdiff13Cover) -> Result<()> {
        self.last_old_end = cover
            .old_pos
            .checked_add(cover.cover_length)
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch old end overflowed".into()))?;
        self.last_new_end = cover.new_end;
        Ok(())
    }
}

/// Writes the ordered HDIFF13 output: new-data-diff bytes for gaps and old-file bytes with
/// the RLE delta added for covers.
struct Hdiff13Emitter<'a, W: Write> {
    new_diff: Vec<u8>,
    new_diff_index: usize,
    rle: HdiffRleDecoder<'a>,
    buffer: Vec<u8>,
    output: &'a mut W,
}

impl<W: Write> Hdiff13Emitter<'_, W> {
    fn fill_from_new_diff(&mut self, fill_len: usize, label: &'static str) -> Result<()> {
        let fill = take_new_diff(
            self.new_diff.as_mut_slice(),
            &mut self.new_diff_index,
            fill_len,
            label,
        )?;
        self.rle.skip(fill_len)?;
        self.output.write_all(fill)?;
        Ok(())
    }

    fn copy_old_range(
        &mut self,
        old_data: &HdiffOldData,
        old_range: std::ops::Range<usize>,
    ) -> Result<()> {
        let mut old_position = old_range.start;
        while old_position < old_range.end {
            let len = self.buffer.len().min(old_range.end - old_position);
            let target = &mut self.buffer[..len];
            old_data.read_into(old_position, target)?;
            self.rle.add(target)?;
            self.output.write_all(target)?;
            old_position += len;
        }
        Ok(())
    }

    fn new_diff_bytes_left(&self) -> usize {
        self.new_diff.len() - self.new_diff_index
    }
}

fn hdiff13_output_size_mismatch(new_data_size: usize) -> RomWeaverError {
    RomWeaverError::ValidationCode(
        hdiff_validation_code("HDIFF_OUTPUT_SIZE_MISMATCH")
            .with_message("HDiffPatch output size mismatch")
            .with_field("expected", new_data_size),
    )
}

/// Checks the old data against the header and returns the declared new data size.
fn check_hdiff13_sizes(old_data: &HdiffOldData, header: &ParsedHdiff13) -> Result<usize> {
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
    if new_data_size > isize::MAX as usize {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch declared new_data_size {new_data_size} exceeds allocatable memory"
        )));
    }
    Ok(new_data_size)
}

/// Returns the old-data range a cover copies from, which must lie inside the old data.
fn hdiff13_cover_old_range(
    cover: &Hdiff13Cover,
    old_data_size: usize,
) -> Result<std::ops::Range<usize>> {
    let old_start = usize::try_from(cover.old_pos).map_err(|_| {
        RomWeaverError::Validation("HDiffPatch old position overflowed usize".into())
    })?;
    let cover_len = usize::try_from(cover.cover_length).map_err(|_| {
        RomWeaverError::Validation("HDiffPatch cover length overflowed usize".into())
    })?;
    let old_end = old_start.checked_add(cover_len).ok_or_else(|| {
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
    Ok(old_start..old_end)
}

fn check_hdiff13_streams_consumed(
    cover_bytes_left: usize,
    new_diff_bytes_left: usize,
) -> Result<()> {
    let leftover_streams = [
        ("cover", cover_bytes_left),
        ("new_data_diff", new_diff_bytes_left),
    ];
    for (stream, bytes_left) in leftover_streams {
        if bytes_left != 0 {
            return Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_STREAM_NOT_CONSUMED")
                    .with_message("HDiffPatch stream was not consumed exactly")
                    .with_field("stream", stream)
                    .with_field("bytes_left", bytes_left),
            ));
        }
    }
    Ok(())
}

fn apply_hdiff13_with_chunks(
    old_data: &HdiffOldData,
    header: &ParsedHdiff13,
    chunks: Hdiff13Chunks,
    output: &mut impl Write,
) -> Result<usize> {
    let Hdiff13Chunks {
        cover_raw,
        rle_ctrl_raw,
        rle_code_raw,
        new_diff_raw,
    } = chunks;

    let new_data_size = check_hdiff13_sizes(old_data, header)?;
    let old_data_size = old_data.len();
    let buffer = vec![0u8; HDIFF13_OUTPUT_BUFFER_SIZE.min(old_data_size)];
    trace!(
        new_data_size,
        buffer_size = buffer.len(),
        "hdiffpatch streaming ordered HDIFF13 output"
    );

    let mut covers = Hdiff13CoverReader::new(cover_raw.as_slice(), new_data_size);
    let mut emitter = Hdiff13Emitter {
        new_diff: new_diff_raw,
        new_diff_index: 0,
        rle: HdiffRleDecoder::new(rle_ctrl_raw.as_slice(), rle_code_raw.as_slice()),
        buffer,
        output,
    };
    let mut position = 0usize;

    for _ in 0..header.cover_count {
        let cover = covers.read_cover()?;

        let new_pos = usize::try_from(cover.new_pos).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch new position overflowed usize".into())
        })?;
        if position > new_pos {
            return Err(RomWeaverError::Validation(
                "HDiffPatch cover new position moved backward".into(),
            ));
        }
        if position < new_pos {
            let fill_len = new_pos - position;
            emitter.fill_from_new_diff(fill_len, "new_data_diff gap")?;
            position = position
                .checked_add(fill_len)
                .ok_or_else(|| hdiff13_output_size_mismatch(new_data_size))?;
        }

        let old_range = hdiff13_cover_old_range(&cover, old_data_size)?;
        let next_position = position
            .checked_add(old_range.len())
            .ok_or_else(|| hdiff13_output_size_mismatch(new_data_size))?;
        emitter.copy_old_range(old_data, old_range)?;
        position = next_position;

        covers.finish_cover(&cover)?;
    }

    if position < new_data_size {
        let fill_len = new_data_size - position;
        emitter.fill_from_new_diff(fill_len, "new_data_diff tail")?;
        position = position
            .checked_add(fill_len)
            .ok_or_else(|| hdiff13_output_size_mismatch(new_data_size))?;
    }

    if position != new_data_size {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_OUTPUT_SIZE_MISMATCH")
                .with_message("HDiffPatch output size mismatch")
                .with_field("expected", new_data_size)
                .with_field("actual", position),
        ));
    }
    check_hdiff13_streams_consumed(covers.bytes_left(), emitter.new_diff_bytes_left())?;
    emitter.rle.finish()?;

    Ok(position)
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

#[cfg(test)]
fn apply_hdiffsf20(
    old_bytes: &[u8],
    patch_bytes: &[u8],
    header: &ParsedHdiffSf20,
) -> Result<Vec<u8>> {
    let old_data = HdiffOldData::Bytes(old_bytes.to_vec());
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

#[cfg(test)]
fn apply_hdiffsf20_with_step_parallelism(
    old_data: &HdiffOldData,
    patch_bytes: &[u8],
    header: &ParsedHdiffSf20,
    enable_parallel_steps: bool,
) -> Result<HdiffSf20ApplyOutput> {
    let diff = read_hdiffsf20_diff_from_patch_bytes(patch_bytes, header)?;
    apply_hdiffsf20_with_diff(old_data, diff.as_slice(), header, enable_parallel_steps)
}

fn apply_hdiffsf20_with_step_parallelism_from_reader(
    old_data: &HdiffOldData,
    patch_reader: &Arc<SharedBlockCacheReader>,
    patch_len: u64,
    header: &ParsedHdiffSf20,
    enable_parallel_steps: bool,
) -> Result<HdiffSf20ApplyOutput> {
    let diff = read_hdiffsf20_diff_from_patch_reader(patch_reader, patch_len, header)?;
    apply_hdiffsf20_with_diff(old_data, diff.as_slice(), header, enable_parallel_steps)
}

#[cfg(test)]
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
    patch_reader: &Arc<SharedBlockCacheReader>,
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
    old_data: &HdiffOldData,
    diff: &[u8],
    header: &ParsedHdiffSf20,
    enable_parallel_steps: bool,
) -> Result<HdiffSf20ApplyOutput> {
    let new_data_size = usize::try_from(header.new_data_size)
        .map_err(|_| RomWeaverError::Validation("HDIFFSF20 new size overflowed usize".into()))?;
    let step_mem_size = usize::try_from(header.step_mem_size).map_err(|_| {
        RomWeaverError::Validation("HDIFFSF20 step_mem_size overflowed usize".into())
    })?;
    let parsed = parse_hdiffsf20_steps(
        diff,
        Sf20PlanLimits {
            old_len: old_data.len(),
            new_data_size,
            cover_count: header.cover_count,
            step_mem_size,
        },
    )?;

    // `new_data_size` is an attacker-controlled varint, but `parse_hdiffsf20_steps`
    // already bounds it by the data the patch can produce, so a refused reservation
    // is memory pressure; `try_reserve_exact` reports it as out of memory rather
    // than aborting the process on a multi-gigabyte `vec![0u8; n]`.
    let mut output = Vec::new();
    output.try_reserve_exact(new_data_size).map_err(|_| {
        RomWeaverError::coded(
            rom_weaver_core::ERROR_CODE_RESOURCE_OUT_OF_MEMORY,
            format!("cannot reserve {new_data_size} bytes for the HDIFFSF20 output"),
        )
    })?;
    output.resize(new_data_size, 0);
    let mut targets = Vec::with_capacity(parsed.steps.len());
    let mut remaining = output.as_mut_slice();
    let mut position = 0usize;
    for step in &parsed.steps {
        let (_, target) = remaining.split_at_mut(step.output_start - position);
        let (target, tail) = target.split_at_mut(step.output_len);
        targets.push((step, target));
        remaining = tail;
        position = step.output_start + step.output_len;
    }
    let used_parallelism = enable_parallel_steps && targets.len() > 1;
    trace!(
        steps = targets.len(),
        used_parallelism, "hdiffpatch rendering HDIFFSF20 steps directly into output slices"
    );
    if used_parallelism {
        targets
            .into_par_iter()
            .try_for_each(|(step, target)| render_hdiffsf20_step(old_data, diff, step, target))?;
    } else {
        for (step, target) in targets {
            render_hdiffsf20_step(old_data, diff, step, target)?;
        }
    }

    Ok(HdiffSf20ApplyOutput {
        output,
        used_parallelism,
    })
}

#[derive(Clone, Copy, Debug)]
struct Sf20PlanLimits {
    old_len: usize,
    new_data_size: usize,
    cover_count: u64,
    step_mem_size: usize,
}

/// One cover as encoded in a step's cover buffer, before conversion to `usize`.
struct Sf20CoverRead {
    old_pos: u64,
    new_pos: u64,
    new_gap: u64,
    cover_length: u64,
}

fn parse_hdiffsf20_steps(diff: &[u8], limits: Sf20PlanLimits) -> Result<ParsedSf20Plan> {
    Sf20PlanParser::new(diff, limits).parse()
}

/// Walks the HDIFFSF20 payload step by step, validating it the way patch.c does and
/// recording where each step's covers, gaps and RLE bytes live.
struct Sf20PlanParser<'a> {
    diff: &'a [u8],
    limits: Sf20PlanLimits,
    diff_index: usize,
    last_old_end: u64,
    last_new_end: u64,
    remaining_covers: u64,
    steps: Vec<Sf20StepPlan>,
}

impl<'a> Sf20PlanParser<'a> {
    fn new(diff: &'a [u8], limits: Sf20PlanLimits) -> Self {
        Self {
            diff,
            limits,
            diff_index: 0,
            last_old_end: 0,
            last_new_end: 0,
            remaining_covers: limits.cover_count,
            steps: Vec::new(),
        }
    }

    fn parse(mut self) -> Result<ParsedSf20Plan> {
        while self.remaining_covers > 0 {
            let step = self.parse_step()?;
            self.steps.push(step);
        }

        let produced_len = usize::try_from(self.last_new_end).map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 produced size overflowed usize".into())
        })?;
        if produced_len != self.limits.new_data_size {
            return Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFFSF20_OUTPUT_SIZE_MISMATCH")
                    .with_message("HDIFFSF20 output size mismatch")
                    .with_field("expected", self.limits.new_data_size)
                    .with_field("actual", produced_len),
            ));
        }
        if self.diff_index != self.diff.len() {
            return Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_STREAM_NOT_CONSUMED")
                    .with_message("HDIFFSF20 payload has bytes after the last cover")
                    .with_field("bytes_left", self.diff.len() - self.diff_index),
            ));
        }

        Ok(ParsedSf20Plan { steps: self.steps })
    }

    fn parse_step(&mut self) -> Result<Sf20StepPlan> {
        let (cover_range, rle_range) = self.read_step_extent()?;
        let diff = self.diff;
        let covers = &diff[cover_range];

        let output_start = usize::try_from(self.last_new_end).map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 step output start overflowed usize".into())
        })?;
        let gap_start = self.diff_index;
        let covers_before = self.remaining_covers;
        let (step_covers, gap_end) = self.read_step_covers(covers)?;

        if self.remaining_covers == covers_before {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step declared no decodable covers".into(),
            ));
        }

        let output_end = usize::try_from(self.last_new_end).map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 step output end overflowed usize".into())
        })?;
        if output_end < output_start {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step output moved backward".into(),
            ));
        }
        self.check_step_follows_previous(output_start)?;

        self.diff_index = gap_end;
        Ok(Sf20StepPlan {
            output_start,
            output_len: output_end - output_start,
            rle_range,
            gap_range: gap_start..gap_end,
            covers: step_covers,
        })
    }

    /// Reads a step header and returns the ranges of its cover and RLE buffers, leaving
    /// `diff_index` at the end of the step buffers.
    fn read_step_extent(&mut self) -> Result<(std::ops::Range<usize>, std::ops::Range<usize>)> {
        let diff = self.diff;
        let cover_buf_size = usize::try_from(read_var_u64(
            diff,
            &mut self.diff_index,
            "sf20 cover_buf_size",
        )?)
        .map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 cover_buf_size overflowed usize".into())
        })?;
        let rle_buf_size = usize::try_from(read_var_u64(
            diff,
            &mut self.diff_index,
            "sf20 rle_buf_size",
        )?)
        .map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 rle_buf_size overflowed usize".into())
        })?;
        let step_size = cover_buf_size
            .checked_add(rle_buf_size)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 step size overflowed".into()))?;
        let step_end = self
            .diff_index
            .checked_add(step_size)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 step end overflowed".into()))?;
        if step_end > diff.len() {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step buffer exceeded payload".into(),
            ));
        }
        if step_size > self.limits.step_mem_size {
            return Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFFSF20_STEP_EXCEEDED_STEP_MEM_SIZE")
                    .with_message("HDIFFSF20 step buffers exceed the declared step_mem_size")
                    .with_field("step_size", step_size)
                    .with_field("step_mem_size", self.limits.step_mem_size),
            ));
        }

        let cover_end = self.diff_index + cover_buf_size;
        let cover_range = self.diff_index..cover_end;
        self.diff_index = step_end;
        Ok((cover_range, cover_end..step_end))
    }

    /// Decodes every cover in one step's cover buffer and returns them with the end of the
    /// step's gap bytes, which follow the step buffers in the payload.
    fn read_step_covers(&mut self, covers: &[u8]) -> Result<(Vec<Sf20CoverPlan>, usize)> {
        let mut gap_cursor = self.diff_index;
        let mut cover_index = 0usize;
        let mut step_covers = Vec::<Sf20CoverPlan>::new();

        while cover_index < covers.len() {
            if self.remaining_covers == 0 {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 step has cover bytes beyond the declared cover count".into(),
                ));
            }
            let read = self.read_cover(covers, &mut cover_index)?;
            let cover = self.plan_cover(&read)?;

            gap_cursor = gap_cursor.checked_add(cover.gap_len).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 gap cursor overflowed".into())
            })?;
            if gap_cursor > self.diff.len() {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 gap bytes exceeded payload".into(),
                ));
            }

            self.remaining_covers -= 1;
            // A zero-length cover only carries the final gap, so it must be the last cover.
            if cover.cover_len == 0 && self.remaining_covers != 0 {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 zero-length cover is not the last cover".into(),
                ));
            }
            step_covers.push(cover);
            self.advance_last_ends(&read)?;
        }

        Ok((step_covers, gap_cursor))
    }

    fn read_cover(&self, covers: &[u8], cover_index: &mut usize) -> Result<Sf20CoverRead> {
        let p_sign = read_u8_slice(covers, cover_index, "sf20 cover sign")?;
        let delta = read_var_u64_tagged_slice(covers, cover_index, 1, p_sign, "sf20 cover delta")?;
        let old_pos = if (p_sign >> 7) == 0 {
            self.last_old_end.checked_add(delta).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 old position overflowed".into())
            })?
        } else {
            self.last_old_end.checked_sub(delta).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 old position underflowed".into())
            })?
        };
        let new_gap = read_var_u64(covers, cover_index, "sf20 new gap")?;
        let cover_length = read_var_u64(covers, cover_index, "sf20 cover length")?;
        let new_pos = self.last_new_end.checked_add(new_gap).ok_or_else(|| {
            RomWeaverError::Validation("HDIFFSF20 new position overflowed".into())
        })?;
        Ok(Sf20CoverRead {
            old_pos,
            new_pos,
            new_gap,
            cover_length,
        })
    }

    /// Converts a decoded cover to `usize` offsets and checks it lies inside the old data.
    fn plan_cover(&self, read: &Sf20CoverRead) -> Result<Sf20CoverPlan> {
        let old_start = usize::try_from(read.old_pos).map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 old position overflowed usize".into())
        })?;
        let cover_len = usize::try_from(read.cover_length).map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 cover length overflowed usize".into())
        })?;
        let gap_len = usize::try_from(read.new_gap)
            .map_err(|_| RomWeaverError::Validation("HDIFFSF20 gap overflowed usize".into()))?;
        let old_end = old_start
            .checked_add(cover_len)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 old range overflowed".into()))?;
        if old_end > self.limits.old_len {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 cover exceeded source bounds".into(),
            ));
        }
        Ok(Sf20CoverPlan {
            old_start,
            cover_len,
            gap_len,
        })
    }

    fn advance_last_ends(&mut self, read: &Sf20CoverRead) -> Result<()> {
        self.last_old_end = read
            .old_pos
            .checked_add(read.cover_length)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 old end overflowed".into()))?;
        self.last_new_end = read
            .new_pos
            .checked_add(read.cover_length)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 new end overflowed".into()))?;
        Ok(())
    }

    fn check_step_follows_previous(&self, output_start: usize) -> Result<()> {
        let Some(previous) = self.steps.last() else {
            return Ok(());
        };
        let previous_end = previous
            .output_start
            .checked_add(previous.output_len)
            .ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 step output range overflowed".into())
            })?;
        if output_start < previous_end {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step output ranges overlapped".into(),
            ));
        }
        Ok(())
    }
}

fn render_hdiffsf20_step(
    old_data: &HdiffOldData,
    diff: &[u8],
    step: &Sf20StepPlan,
    output: &mut [u8],
) -> Result<()> {
    if step.rle_range.end > diff.len() || step.gap_range.end > diff.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 step referenced bytes past payload".into(),
        ));
    }

    if output.len() != step.output_len {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 rendered step length mismatch".into(),
        ));
    }
    let mut position = 0usize;
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
            let end = position + cover.gap_len;
            let target = output.get_mut(position..end).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 step output exceeded target size".into())
            })?;
            target.copy_from_slice(&gap_bytes[gap_index..gap_index + cover.gap_len]);
            gap_index += cover.gap_len;
            position = end;
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
        let end = position + cover.cover_len;
        let target = output.get_mut(position..end).ok_or_else(|| {
            RomWeaverError::Validation("HDIFFSF20 step output exceeded target size".into())
        })?;
        old_data.read_into(cover.old_start, target)?;
        rle_decoder.add(target)?;
        position = end;
    }

    if gap_index != gap_bytes.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 step left unused gap bytes".into(),
        ));
    }
    if position != step.output_len {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 rendered step size mismatch".into(),
        ));
    }

    Ok(())
}

#[cfg(test)]
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
    patch_reader: &Arc<SharedBlockCacheReader>,
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
    patch_reader.read_exact_at(start as u64, raw.as_mut_slice())?;

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

/// Decoder for the HDIFF13 RLE streams (`rle_ctrl` and `rle_code`) that add a delta onto the
/// bytes copied from the old file, mirroring patch.c `_TBytesRle_load_stream`.
struct HdiffRleDecoder<'a> {
    ctrl: &'a [u8],
    ctrl_index: usize,
    code: &'a [u8],
    code_index: usize,
    set_length: usize,
    set_value: u8,
    copy_length: usize,
}

impl<'a> HdiffRleDecoder<'a> {
    fn new(ctrl: &'a [u8], code: &'a [u8]) -> Self {
        Self {
            ctrl,
            ctrl_index: 0,
            code,
            code_index: 0,
            set_length: 0,
            set_value: 0,
            copy_length: 0,
        }
    }

    /// Adds the next `target.len()` RLE bytes onto `target`.
    fn add(&mut self, target: &mut [u8]) -> Result<()> {
        let len = target.len();
        self.advance(Some(target), len)
    }

    /// Consumes the next `len` RLE bytes without applying them (patch.c `_rle_decode_skip`).
    fn skip(&mut self, len: usize) -> Result<()> {
        self.advance(None, len)
    }

    /// Fails unless every RLE run and both streams were consumed exactly.
    fn finish(&self) -> Result<()> {
        if self.set_length != 0
            || self.copy_length != 0
            || self.ctrl_index != self.ctrl.len()
            || self.code_index != self.code.len()
        {
            return Err(RomWeaverError::ValidationCode(
                hdiff_validation_code("HDIFF_STREAM_NOT_CONSUMED")
                    .with_message("HDiffPatch rle streams were not consumed exactly")
                    .with_field("rle_ctrl_left", self.ctrl.len() - self.ctrl_index)
                    .with_field("rle_code_left", self.code.len() - self.code_index)
                    .with_field("pending_set", self.set_length)
                    .with_field("pending_copy", self.copy_length),
            ));
        }
        Ok(())
    }

    fn advance(&mut self, mut target: Option<&mut [u8]>, len: usize) -> Result<()> {
        let mut offset = 0usize;
        self.apply_pending(&mut target, &mut offset, len)?;
        while offset < len {
            if self.ctrl_index >= self.ctrl.len() {
                return Err(RomWeaverError::Validation(
                    "HDiffPatch rle_ctrl ended unexpectedly".into(),
                ));
            }
            let p_sign = read_u8_slice(self.ctrl, &mut self.ctrl_index, "rle ctrl")?;
            let rle_type = p_sign >> 6;
            let run_length = read_var_u64_tagged_slice(
                self.ctrl,
                &mut self.ctrl_index,
                2,
                p_sign,
                "rle ctrl length",
            )?
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch rle length overflowed".into()))?;
            let run_length = usize::try_from(run_length).map_err(|_| {
                RomWeaverError::Validation("HDiffPatch rle length overflowed usize".into())
            })?;

            match rle_type {
                3 => self.copy_length = run_length,
                2 => {
                    self.set_length = run_length;
                    self.set_value = read_u8_slice(self.code, &mut self.code_index, "rle value")?;
                }
                _ => {
                    self.set_length = run_length;
                    self.set_value = 0u8.wrapping_sub(rle_type);
                }
            }
            self.apply_pending(&mut target, &mut offset, len)?;
        }
        Ok(())
    }

    fn apply_pending(
        &mut self,
        target: &mut Option<&mut [u8]>,
        offset: &mut usize,
        len: usize,
    ) -> Result<()> {
        let set_step = self.set_length.min(len - *offset);
        if set_step > 0 {
            if let Some(target) = target.as_deref_mut()
                && self.set_value != 0
            {
                for byte in &mut target[*offset..*offset + set_step] {
                    *byte = byte.wrapping_add(self.set_value);
                }
            }
            self.set_length -= set_step;
            *offset += set_step;
        }

        let copy_step = self.copy_length.min(len - *offset);
        if copy_step > 0 {
            if self.code.len() - self.code_index < copy_step {
                return Err(RomWeaverError::Validation(
                    "HDiffPatch rle_code ended unexpectedly".into(),
                ));
            }
            if let Some(target) = target.as_deref_mut() {
                let source = &self.code[self.code_index..self.code_index + copy_step];
                for (dst, src) in target[*offset..*offset + copy_step].iter_mut().zip(source) {
                    *dst = dst.wrapping_add(*src);
                }
            }
            self.code_index += copy_step;
            self.copy_length -= copy_step;
            *offset += copy_step;
        }
        Ok(())
    }
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
    let value = read_var_u64(bytes, index, label)?;
    usize::try_from(value)
        .map_err(|_| RomWeaverError::Validation("HDIFFSF20 rle varint overflowed usize".into()))
}

fn take_new_diff<'a>(
    source: &'a mut [u8],
    source_index: &mut usize,
    len: usize,
    label: &'static str,
) -> Result<&'a mut [u8]> {
    if source.len().saturating_sub(*source_index) < len {
        return Err(RomWeaverError::ValidationCode(
            hdiff_validation_code("HDIFF_NEW_DIFF_UNEXPECTED_EOF")
                .with_field("label", label)
                .with_field("source_index", *source_index)
                .with_field("len", len)
                .with_field("source_len", source.len()),
        ));
    }
    let start = *source_index;
    *source_index += len;
    Ok(&mut source[start..*source_index])
}

#[cfg(test)]
fn read_null_terminated_bytes(bytes: &[u8], max_len: usize) -> Result<(Vec<u8>, usize)> {
    let limit = bytes.len().min(max_len);
    for index in 0..limit {
        if bytes[index] == 0 {
            return Ok((bytes[..index].to_vec(), index + 1));
        }
    }

    Err(RomWeaverError::Validation(
        "HDiffPatch header was missing null terminator".into(),
    ))
}

#[cfg(test)]
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

fn read_var_u64_tagged_slice(
    bytes: &[u8],
    index: &mut usize,
    tag_bits: u8,
    first_byte: u8,
    label: &'static str,
) -> Result<u64> {
    decode_hdiff_varint(tag_bits, first_byte, || read_u8_slice(bytes, index, label))
}

/// Decode an HDiffPatch tagged varint: `tag_bits` high bits of the first byte are a caller tag
/// (the first byte is `first_byte` unless `tag_bits == 0`, in which case it is read), then
/// 7-bit continuation groups follow. Shared by the stream and slice readers via `read_byte`.
fn decode_hdiff_varint(
    tag_bits: u8,
    first_byte: u8,
    mut read_byte: impl FnMut() -> Result<u8>,
) -> Result<u64> {
    if tag_bits > 6 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch varint tag_bits must be <= 6".into(),
        ));
    }

    let first = if tag_bits == 0 {
        read_byte()?
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
        // A 7-bit shift must not push set bits out of the top of the u64 (patch.c:120).
        if (value >> (u64::BITS - 7)) != 0 {
            return Err(RomWeaverError::Validation(
                "HDiffPatch varint overflowed".into(),
            ));
        }
        let byte = read_byte()?;
        value = (value << 7) | u64::from(byte & 0x7f);
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

/// Appends one HDIFF13 rle control record: `rle_type` in the top two bits, then `length - 1`
/// as a tagged varint (rle0 = 0, rle255 = 1, rle with a code byte = 2, unrle copy = 3).
#[cfg(test)]
fn write_rle_ctrl(out: &mut Vec<u8>, rle_type: u8, length: u64) {
    let first_payload_bits = 5u32;
    let mut rest = length - 1;
    let mut groups = Vec::new();
    while rest >> first_payload_bits != 0 {
        groups.push((rest & 0x7f) as u8);
        rest >>= 7;
    }
    let continuation = if groups.is_empty() {
        0
    } else {
        1 << first_payload_bits
    };
    out.push((rle_type << 6) | continuation | rest as u8);
    for (index, group) in groups.iter().rev().enumerate() {
        let is_last = index + 1 == groups.len();
        out.push(if is_last { *group } else { *group | 0x80 });
    }
}

/// An `hdiffz`-shaped patch with no covers: the rle control stream spans the whole output
/// as one rle0 run and `new_data_diff` carries the new bytes.
#[cfg(test)]
fn build_uncompressed_hdiff13_patch(old_bytes: &[u8], new_bytes: &[u8]) -> Result<Vec<u8>> {
    let old_size = u64::try_from(old_bytes.len())
        .map_err(|_| RomWeaverError::Validation("old file length overflowed u64".into()))?;
    let new_size = u64::try_from(new_bytes.len())
        .map_err(|_| RomWeaverError::Validation("new file length overflowed u64".into()))?;

    let mut rle_ctrl = Vec::new();
    if new_size > 0 {
        write_rle_ctrl(&mut rle_ctrl, 0, new_size);
    }

    let mut out = Vec::with_capacity(64usize.saturating_add(new_bytes.len()));
    write_uncompressed_hdiff13_header_vec(&mut out, old_size, new_size, rle_ctrl.len() as u64);

    out.extend_from_slice(&rle_ctrl);
    out.extend_from_slice(new_bytes);
    Ok(out)
}

#[cfg(test)]
fn write_uncompressed_hdiff13_header_vec(
    out: &mut Vec<u8>,
    old_size: u64,
    new_size: u64,
    rle_ctrl_size: u64,
) {
    out.extend_from_slice(b"HDIFF13&nocomp");
    out.push(0);
    write_var_u64(out, new_size);
    write_var_u64(out, old_size);
    write_var_u64(out, 0); // cover_count
    write_var_u64(out, 0); // cover_buf_size
    write_var_u64(out, 0); // compress_cover_buf_size
    write_var_u64(out, rle_ctrl_size); // rle_ctrl_buf_size
    write_var_u64(out, 0); // compress_rle_ctrl_buf_size
    write_var_u64(out, 0); // rle_code_buf_size
    write_var_u64(out, 0); // compress_rle_code_buf_size
    write_var_u64(out, new_size); // new_data_diff_size
    write_var_u64(out, 0); // compress_new_data_diff_size
}

#[cfg(test)]
#[path = "../tests/unit/hdiffpatch.rs"]
mod tests;
