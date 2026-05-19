use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Write},
    num::NonZeroU64,
    path::Path,
    sync::Arc,
};

use bzip2::{Compression as Bzip2Compression, read::BzDecoder, write::BzEncoder};
use flate2::{Compression as DeflateCompression, read::GzDecoder, write::GzEncoder};
use lzma_rust2::{XzOptions, XzReader, XzReaderMt, XzWriter, XzWriterMt};
use memmap2::MmapOptions;
use rayon::prelude::*;
use rom_weaver_core::{
    CodecBackend, CodecCapabilities, CodecDescriptor, CodecOperationRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, Result, RomWeaverError, ThreadCapability,
    ThreadExecution,
};
use zstd::stream::{Decoder as ZstdDecoder, Encoder as ZstdEncoder};

const STORE: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "store",
    aliases: &[],
    extensions: &[],
};
const DEFLATE: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "deflate",
    aliases: &["zlib", "gzip", "gz"],
    extensions: &[],
};
const ZSTD: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "zstd",
    aliases: &[],
    extensions: &[],
};
const LZMA2: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "lzma2",
    aliases: &["xz"],
    extensions: &[],
};
const BZIP2: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "bzip2",
    aliases: &["bz2"],
    extensions: &[],
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CanonicalCodec {
    Store,
    Deflate,
    Zstd,
    Lzma,
    Lzma2,
    Bzip2,
    Huffman,
}

impl CanonicalCodec {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Store => "store",
            Self::Deflate => "deflate",
            Self::Zstd => "zstd",
            Self::Lzma => "lzma",
            Self::Lzma2 => "lzma2",
            Self::Bzip2 => "bzip2",
            Self::Huffman => "huffman",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestedCodec {
    Unspecified,
    Known(CanonicalCodec),
    Unknown(String),
}

pub fn parse_requested_codec(codec: Option<&str>) -> RequestedCodec {
    match codec {
        None => RequestedCodec::Unspecified,
        Some(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "store" | "none" | "uncompressed" => RequestedCodec::Known(CanonicalCodec::Store),
                "deflate" | "zlib" | "gzip" | "gz" => {
                    RequestedCodec::Known(CanonicalCodec::Deflate)
                }
                "zstd" | "zst" | "zstandard" => RequestedCodec::Known(CanonicalCodec::Zstd),
                "lzma" => RequestedCodec::Known(CanonicalCodec::Lzma),
                "lzma2" | "xz" => RequestedCodec::Known(CanonicalCodec::Lzma2),
                "bzip2" | "bz2" => RequestedCodec::Known(CanonicalCodec::Bzip2),
                "huffman" | "huff" => RequestedCodec::Known(CanonicalCodec::Huffman),
                _ => RequestedCodec::Unknown(normalized),
            }
        }
    }
}

pub fn normalize_codec_label(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let split_at = trimmed
        .char_indices()
        .find(|(_, ch)| !(ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_'))
        .map(|(index, _)| index)
        .unwrap_or(trimmed.len());
    let (head, tail) = trimmed.split_at(split_at);

    match parse_requested_codec(Some(head)) {
        RequestedCodec::Known(codec) => format!("{}{}", codec.name(), tail),
        RequestedCodec::Unspecified | RequestedCodec::Unknown(_) => trimmed.to_ascii_lowercase(),
    }
}

pub struct CodecRegistry {
    backends: Vec<Arc<dyn CodecBackend>>,
}

impl Default for CodecRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CodecRegistry {
    pub fn new() -> Self {
        let backends = vec![
            Arc::new(NativeCodecBackend::new(&STORE, NativeCodecKind::Store))
                as Arc<dyn CodecBackend>,
            Arc::new(NativeCodecBackend::new(&DEFLATE, NativeCodecKind::Deflate)),
            Arc::new(NativeCodecBackend::new(&ZSTD, NativeCodecKind::Zstd)),
            Arc::new(NativeCodecBackend::new(&LZMA2, NativeCodecKind::Lzma2)),
            Arc::new(NativeCodecBackend::new(&BZIP2, NativeCodecKind::Bzip2)),
        ];
        Self {
            backends: backends
                .into_iter()
                .map(rom_weaver_core::traced_codec_backend)
                .collect(),
        }
    }

    pub fn backends(&self) -> &[Arc<dyn CodecBackend>] {
        &self.backends
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn CodecBackend>> {
        self.backends
            .iter()
            .find(|backend| backend.descriptor().matches_name(name))
            .cloned()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeCodecKind {
    Store,
    Deflate,
    Zstd,
    Lzma2,
    Bzip2,
}

struct NativeCodecBackend {
    descriptor: &'static CodecDescriptor,
    kind: NativeCodecKind,
}

impl NativeCodecBackend {
    const XZ_MT_BLOCK_BYTES: u64 = 1 << 20;
    const STORE_COPY_MIN_PARALLEL_BYTES: usize = 1 << 20;

    const fn new(descriptor: &'static CodecDescriptor, kind: NativeCodecKind) -> Self {
        Self { descriptor, kind }
    }

    fn ensure_output_parent(path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    fn validate_decode_level(&self, request: &CodecOperationRequest) -> Result<()> {
        if request.level.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{} decode does not accept a compression level",
                self.descriptor.name
            )));
        }
        Ok(())
    }

    fn resolve_encode_level(&self, request: &CodecOperationRequest) -> Result<Option<i32>> {
        let resolved = match self.kind {
            NativeCodecKind::Store => {
                if request.level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "store codec does not accept a compression level".to_string(),
                    ));
                }
                None
            }
            NativeCodecKind::Deflate => Some(match request.level {
                None => 6,
                Some(value) if (0..=9).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "deflate level `{value}` is out of range (0..=9)"
                    )));
                }
            }),
            NativeCodecKind::Zstd => Some(match request.level {
                None => 3,
                Some(value) if (-7..=22).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "zstd level `{value}` is out of range (-7..=22)"
                    )));
                }
            }),
            NativeCodecKind::Lzma2 => Some(match request.level {
                None => 6,
                Some(value) if (0..=9).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "lzma2 level `{value}` is out of range (0..=9)"
                    )));
                }
            }),
            NativeCodecKind::Bzip2 => Some(match request.level {
                None => 6,
                Some(value) if (1..=9).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "bzip2 level `{value}` is out of range (1..=9)"
                    )));
                }
            }),
        };
        Ok(resolved)
    }

    fn encode_thread_capability(&self) -> ThreadCapability {
        match self.kind {
            NativeCodecKind::Zstd | NativeCodecKind::Lzma2 => ThreadCapability::parallel(None),
            NativeCodecKind::Store | NativeCodecKind::Deflate | NativeCodecKind::Bzip2 => {
                ThreadCapability::single_threaded()
            }
        }
    }

    fn decode_thread_capability(&self) -> ThreadCapability {
        match self.kind {
            NativeCodecKind::Store | NativeCodecKind::Lzma2 => ThreadCapability::parallel(None),
            NativeCodecKind::Deflate | NativeCodecKind::Zstd | NativeCodecKind::Bzip2 => {
                ThreadCapability::single_threaded()
            }
        }
    }

    fn xz_thread_count(effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn xz_mt_options(level: u32) -> Result<XzOptions> {
        let mut options = XzOptions::with_preset(level);
        let block_size = NonZeroU64::new(Self::XZ_MT_BLOCK_BYTES).ok_or_else(|| {
            RomWeaverError::Validation("lzma2 internal block size must be non-zero".into())
        })?;
        options.set_block_size(Some(block_size));
        Ok(options)
    }

    fn store_copy_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        total_len.div_ceil(threads).max(1)
    }

    fn copy_store_payload(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let input_len_u64 = fs::metadata(&request.input)?.len();
        let output = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&request.output)?;
        output.set_len(input_len_u64)?;
        if input_len_u64 == 0 {
            return Ok(0);
        }

        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("store codec payload exceeded addressable memory".into())
        })?;
        let input = File::open(&request.input)?;
        // SAFETY: Both mappings are file-backed and remain valid for the lifetime of this scope.
        let input_map = unsafe { MmapOptions::new().map(&input)? };
        // SAFETY: The output file is opened read+write and sized to the mapped length above.
        let mut output_map = unsafe { MmapOptions::new().map_mut(&output)? };

        if execution.used_parallelism {
            if input_len < Self::STORE_COPY_MIN_PARALLEL_BYTES {
                execution.apply_pool_fallback(format!(
                    "store codec payload too small for threaded copy ({input_len} bytes)"
                ));
            } else {
                match rayon::ThreadPoolBuilder::new()
                    .num_threads(execution.effective_threads.max(1))
                    .build()
                {
                    Ok(pool) => {
                        let input_bytes: &[u8] = input_map.as_ref();
                        let chunk_len =
                            Self::store_copy_chunk_len(input_len, execution.effective_threads);
                        pool.install(|| {
                            output_map.par_chunks_mut(chunk_len).enumerate().for_each(
                                |(chunk_index, chunk)| {
                                    let start = chunk_index.saturating_mul(chunk_len);
                                    let end = start + chunk.len();
                                    chunk.copy_from_slice(&input_bytes[start..end]);
                                },
                            );
                        });
                    }
                    Err(error) => execution.apply_pool_fallback(format!(
                        "store codec thread pool build failed: {error}"
                    )),
                }
            }
        }

        if !execution.used_parallelism {
            output_map[..].copy_from_slice(input_map.as_ref());
        }
        output_map.flush()?;
        Ok(input_len_u64)
    }

    fn encode_impl(
        &self,
        request: &CodecOperationRequest,
        level: Option<i32>,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let bytes = match self.kind {
            NativeCodecKind::Store => fs::copy(&request.input, &request.output)?,
            NativeCodecKind::Deflate => {
                let mut source = BufReader::new(File::open(&request.input)?);
                let output = BufWriter::new(File::create(&request.output)?);
                let mut encoder =
                    GzEncoder::new(output, DeflateCompression::new(level.unwrap_or(6) as u32));
                let copied = io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
                copied
            }
            NativeCodecKind::Zstd => {
                let mut source = BufReader::new(File::open(&request.input)?);
                let output = BufWriter::new(File::create(&request.output)?);
                let mut encoder = ZstdEncoder::new(output, level.unwrap_or(3))?;
                if execution.effective_threads > 1 {
                    match u32::try_from(execution.effective_threads) {
                        Ok(workers) => {
                            if let Err(error) = encoder
                                .set_parameter(zstd::zstd_safe::CParameter::NbWorkers(workers))
                            {
                                execution.apply_pool_fallback(format!(
                                    "zstd encoder rejected multithread setting: {error}"
                                ));
                            }
                        }
                        Err(_) => execution.apply_pool_fallback(
                            "zstd encoder thread count exceeded supported range".to_string(),
                        ),
                    }
                }
                let copied = io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
                copied
            }
            NativeCodecKind::Lzma2 => {
                let mut source = BufReader::new(File::open(&request.input)?);
                let output = BufWriter::new(File::create(&request.output)?);
                let level = level.unwrap_or(6) as u32;
                if execution.used_parallelism {
                    let mut encoder = XzWriterMt::new(
                        output,
                        Self::xz_mt_options(level)?,
                        Self::xz_thread_count(execution.effective_threads),
                    )?;
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                } else {
                    let mut encoder = XzWriter::new(output, XzOptions::with_preset(level))?;
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Bzip2 => {
                let mut source = BufReader::new(File::open(&request.input)?);
                let output = BufWriter::new(File::create(&request.output)?);
                let mut encoder =
                    BzEncoder::new(output, Bzip2Compression::new(level.unwrap_or(6) as u32));
                let copied = io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
                copied
            }
        };
        Ok(bytes)
    }

    fn decode_impl(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let bytes = match self.kind {
            NativeCodecKind::Store => self.copy_store_payload(request, execution)?,
            NativeCodecKind::Deflate => {
                let source = BufReader::new(File::open(&request.input)?);
                let mut decoder = GzDecoder::new(source);
                let mut output = BufWriter::new(File::create(&request.output)?);
                let copied = io::copy(&mut decoder, &mut output)?;
                output.flush()?;
                copied
            }
            NativeCodecKind::Zstd => {
                let source = BufReader::new(File::open(&request.input)?);
                let mut decoder = ZstdDecoder::new(source)?;
                let mut output = BufWriter::new(File::create(&request.output)?);
                let copied = io::copy(&mut decoder, &mut output)?;
                output.flush()?;
                copied
            }
            NativeCodecKind::Lzma2 => {
                if execution.used_parallelism {
                    let workers = Self::xz_thread_count(execution.effective_threads);
                    let source = BufReader::new(File::open(&request.input)?);
                    match XzReaderMt::new(source, false, workers) {
                        Ok(mut decoder) => {
                            let mut output = BufWriter::new(File::create(&request.output)?);
                            let copied = io::copy(&mut decoder, &mut output)?;
                            output.flush()?;
                            copied
                        }
                        Err(error) => {
                            execution.apply_pool_fallback(format!(
                                "lzma2 decoder rejected multithread setting: {error}"
                            ));
                            let source = BufReader::new(File::open(&request.input)?);
                            let mut decoder = XzReader::new(source, false);
                            let mut output = BufWriter::new(File::create(&request.output)?);
                            let copied = io::copy(&mut decoder, &mut output)?;
                            output.flush()?;
                            copied
                        }
                    }
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = XzReader::new(source, false);
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Bzip2 => {
                let source = BufReader::new(File::open(&request.input)?);
                let mut decoder = BzDecoder::new(source);
                let mut output = BufWriter::new(File::create(&request.output)?);
                let copied = io::copy(&mut decoder, &mut output)?;
                output.flush()?;
                copied
            }
        };
        Ok(bytes)
    }

    fn run_encode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let level = self.resolve_encode_level(request)?;
        Self::ensure_output_parent(&request.output)?;
        let mut execution = context.plan_threads(self.encode_thread_capability());
        let bytes = self.encode_impl(request, level, &mut execution)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "encode",
            format!(
                "encoded `{}` to `{}` using {} ({} bytes)",
                request.input.display(),
                request.output.display(),
                self.descriptor.name,
                bytes
            ),
            Some(1.0),
            Some(execution),
        ))
    }

    fn run_decode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.validate_decode_level(request)?;
        Self::ensure_output_parent(&request.output)?;
        let mut execution = context.plan_threads(self.decode_thread_capability());
        let bytes = self.decode_impl(request, &mut execution)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "decode",
            format!(
                "decoded `{}` to `{}` using {} ({} bytes)",
                request.input.display(),
                request.output.display(),
                self.descriptor.name,
                bytes
            ),
            Some(1.0),
            Some(execution),
        ))
    }
}

impl CodecBackend for NativeCodecBackend {
    fn descriptor(&self) -> &'static CodecDescriptor {
        self.descriptor
    }

    fn encode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.run_encode(request, context)
    }

    fn decode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.run_decode(request, context)
    }

    fn capabilities(&self) -> CodecCapabilities {
        CodecCapabilities {
            encode: true,
            decode: true,
            encode_threads: self.encode_thread_capability(),
            decode_threads: self.decode_thread_capability(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, CodecOperationRequest, NoopProgressSink, OperationContext,
        OperationStatus, ThreadBudget, ThreadCapability,
    };

    use super::{
        CanonicalCodec, CodecRegistry, RequestedCodec, normalize_codec_label, parse_requested_codec,
    };

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let sequence = TEST_DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "rom-weaver-codecs-tests-{}-{unique}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn codec_context(root: &Path) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(8),
            root.join("op"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn codec_round_trip(codec: &str, level: Option<i32>) {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.bin");
        let decoded = temp.path().join("decoded.bin");
        let bytes = (0..32_768)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(&source, &bytes).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name(codec).expect("codec backend");
        let context = codec_context(temp.path());

        let encode = backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded.clone(),
                    level,
                },
                &context,
            )
            .expect("encode");
        assert_eq!(encode.status, OperationStatus::Succeeded);

        let decode = backend
            .decode(
                &CodecOperationRequest {
                    input: encoded,
                    output: decoded.clone(),
                    level: None,
                },
                &context,
            )
            .expect("decode");
        assert_eq!(decode.status, OperationStatus::Succeeded);

        let decoded_bytes = fs::read(decoded).expect("read decoded");
        assert_eq!(decoded_bytes, bytes);
    }

    fn codec_rejects_level(codec: &str, level: i32, expected_message: &str) {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.bin");
        fs::write(&source, b"abc").expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name(codec).expect("codec backend");
        let context = codec_context(temp.path());

        let error = backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded,
                    level: Some(level),
                },
                &context,
            )
            .expect_err("level should fail");
        assert!(error.to_string().contains(expected_message));
    }

    #[test]
    fn registry_contains_planned_backends() {
        let registry = CodecRegistry::new();
        let names = registry
            .backends()
            .iter()
            .map(|backend| backend.descriptor().name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["store", "deflate", "zstd", "lzma2", "bzip2"]);
    }

    #[test]
    fn parses_shared_codec_aliases() {
        assert_eq!(
            parse_requested_codec(Some("xz")),
            RequestedCodec::Known(CanonicalCodec::Lzma2)
        );
        assert_eq!(
            parse_requested_codec(Some("gzip")),
            RequestedCodec::Known(CanonicalCodec::Deflate)
        );
        assert_eq!(
            parse_requested_codec(Some("zst")),
            RequestedCodec::Known(CanonicalCodec::Zstd)
        );
        assert_eq!(
            parse_requested_codec(Some("huff")),
            RequestedCodec::Known(CanonicalCodec::Huffman)
        );
    }

    #[test]
    fn unknown_codec_is_preserved() {
        assert_eq!(
            parse_requested_codec(Some("foo-codec")),
            RequestedCodec::Unknown("foo-codec".to_string())
        );
    }

    #[test]
    fn normalizes_codec_labels_for_reporting() {
        assert_eq!(normalize_codec_label("LZMA2 (6)"), "lzma2 (6)");
        assert_eq!(normalize_codec_label("xz(9)"), "lzma2(9)");
        assert_eq!(normalize_codec_label("Zstandard level=3"), "zstd level=3");
        assert_eq!(normalize_codec_label("mystery-codec"), "mystery-codec");
    }

    #[test]
    fn codec_backends_round_trip_supported_formats() {
        codec_round_trip("store", None);
        codec_round_trip("deflate", Some(6));
        codec_round_trip("zstd", Some(3));
        codec_round_trip("lzma2", Some(6));
        codec_round_trip("bzip2", Some(6));
    }

    #[test]
    fn codec_backends_apply_default_levels() {
        codec_round_trip("deflate", None);
        codec_round_trip("zstd", None);
        codec_round_trip("lzma2", None);
        codec_round_trip("bzip2", None);
    }

    #[test]
    fn store_backend_rejects_levels() {
        codec_rejects_level(
            "store",
            1,
            "store codec does not accept a compression level",
        );
    }

    #[test]
    fn deflate_backend_rejects_invalid_level() {
        codec_rejects_level("deflate", 10, "deflate level `10` is out of range (0..=9)");
    }

    #[test]
    fn zstd_backend_rejects_invalid_level() {
        codec_rejects_level("zstd", 23, "zstd level `23` is out of range (-7..=22)");
    }

    #[test]
    fn lzma2_backend_rejects_invalid_level() {
        codec_rejects_level("lzma2", 10, "lzma2 level `10` is out of range (0..=9)");
    }

    #[test]
    fn bzip2_backend_rejects_invalid_level() {
        codec_rejects_level("bzip2", 0, "bzip2 level `0` is out of range (1..=9)");
    }

    #[test]
    fn decode_rejects_level_parameter() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.bin");
        let decoded = temp.path().join("decoded.bin");
        fs::write(&source, b"hello").expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("deflate").expect("deflate backend");
        let context = codec_context(temp.path());

        backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode");

        let error = backend
            .decode(
                &CodecOperationRequest {
                    input: encoded,
                    output: decoded,
                    level: Some(6),
                },
                &context,
            )
            .expect_err("decode level should fail");
        assert!(
            error
                .to_string()
                .contains("deflate decode does not accept a compression level")
        );
    }

    #[test]
    fn capabilities_report_thread_support_per_codec_backend() {
        let registry = CodecRegistry::new();

        for codec in ["zstd", "lzma2"] {
            let backend = registry.find_by_name(codec).expect("codec backend");
            assert_eq!(
                backend.capabilities().encode_threads,
                ThreadCapability::parallel(None)
            );
        }

        for codec in ["store", "deflate", "bzip2"] {
            let backend = registry.find_by_name(codec).expect("codec backend");
            assert_eq!(
                backend.capabilities().encode_threads,
                ThreadCapability::single_threaded()
            );
        }

        for codec in ["store", "lzma2"] {
            let backend = registry.find_by_name(codec).expect("codec backend");
            assert_eq!(
                backend.capabilities().decode_threads,
                ThreadCapability::parallel(None)
            );
        }

        for codec in ["deflate", "zstd", "bzip2"] {
            let backend = registry.find_by_name(codec).expect("codec backend");
            assert_eq!(
                backend.capabilities().decode_threads,
                ThreadCapability::single_threaded()
            );
        }
    }

    #[test]
    fn lzma2_backend_encode_runtime_threads_match_capability() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.xz");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(19))
            .collect::<Vec<_>>();
        fs::write(&source, payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("lzma2").expect("lzma2 backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        let encode = backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded,
                    level: Some(6),
                },
                &context,
            )
            .expect("encode");
        assert_eq!(encode.status, OperationStatus::Succeeded);

        let execution = encode.thread_execution.expect("thread execution");
        assert!(capabilities.encode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn lzma2_backend_decode_runtime_threads_match_capability() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.xz");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(29))
            .collect::<Vec<_>>();
        fs::write(&source, &payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("lzma2").expect("lzma2 backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode");

        let decode = backend
            .decode(
                &CodecOperationRequest {
                    input: encoded,
                    output: decoded.clone(),
                    level: None,
                },
                &context,
            )
            .expect("decode");
        assert_eq!(decode.status, OperationStatus::Succeeded);

        let execution = decode.thread_execution.expect("thread execution");
        assert!(capabilities.decode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }

    #[test]
    fn store_backend_decode_runs_with_parallel_runtime_when_budget_allows() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.store");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(7))
            .collect::<Vec<_>>();
        fs::write(&source, &payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("store").expect("store backend");
        let context = codec_context(temp.path());

        backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded.clone(),
                    level: None,
                },
                &context,
            )
            .expect("encode");

        let decode = backend
            .decode(
                &CodecOperationRequest {
                    input: encoded,
                    output: decoded.clone(),
                    level: None,
                },
                &context,
            )
            .expect("decode");
        assert_eq!(decode.status, OperationStatus::Succeeded);

        let execution = decode.thread_execution.expect("thread execution");
        assert!(
            backend
                .capabilities()
                .decode_threads
                .supports_execution(&execution)
        );
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }
}
