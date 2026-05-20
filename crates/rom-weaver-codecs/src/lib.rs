use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Cursor, Seek, SeekFrom, Write},
    num::NonZeroU64,
    path::Path,
    sync::Arc,
};

use bzip2::{
    Compression as Bzip2Compression, bufread::BzDecoder as BufReadBzDecoder, read::MultiBzDecoder,
    write::BzEncoder,
};
use flate2::{
    Compression as DeflateCompression, bufread::GzDecoder as BufReadGzDecoder,
    read::MultiGzDecoder, write::GzEncoder,
};
use lzma_rust2::{XzOptions, XzReader, XzReaderMt, XzWriter, XzWriterMt};
use memmap2::{Mmap, MmapOptions};
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

enum ReadOnlyFile {
    Mapped(Mmap),
    Owned(Vec<u8>),
}

impl AsRef<[u8]> for ReadOnlyFile {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Mapped(map) => map.as_ref(),
            Self::Owned(bytes) => bytes.as_ref(),
        }
    }
}

/// Avoid vectored writes on WASI file descriptors, which can trigger runtime crashes
/// in some host runtimes when certain codec pipelines flush output.
struct NonVectoredWriter<W> {
    inner: W,
}

impl<W> NonVectoredWriter<W> {
    fn new(inner: W) -> Self {
        Self { inner }
    }
}

impl<W: Write> Write for NonVectoredWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }

    fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
        for slice in bufs {
            if !slice.is_empty() {
                return self.inner.write(slice);
            }
        }
        Ok(0)
    }
}

impl<W: Seek> Seek for NonVectoredWriter<W> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl NativeCodecBackend {
    const XZ_MT_BLOCK_BYTES: u64 = 1 << 20;
    const STORE_COPY_MIN_PARALLEL_BYTES: usize = 1 << 20;
    const DEFLATE_PARALLEL_MIN_BYTES: usize = 256 * 1024;
    const DEFLATE_PARALLEL_MIN_CHUNK_BYTES: usize = 128 * 1024;
    const DEFLATE_PARALLEL_TARGET_CHUNKS_PER_THREAD: usize = 4;
    const BZIP2_PARALLEL_MIN_BYTES: usize = 1 << 20;
    const BZIP2_PARALLEL_MIN_CHUNK_BYTES: usize = 900 * 1024;
    const BZIP2_PARALLEL_TARGET_CHUNKS_PER_THREAD: usize = 2;
    const ZSTD_PARALLEL_MIN_BYTES: usize = 1 << 20;
    const ZSTD_PARALLEL_MIN_CHUNK_BYTES: usize = 256 * 1024;
    const ZSTD_PARALLEL_TARGET_CHUNKS_PER_THREAD: usize = 2;

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
            NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => ThreadCapability::parallel(None),
            NativeCodecKind::Store => ThreadCapability::single_threaded(),
        }
    }

    fn decode_thread_capability(&self) -> ThreadCapability {
        match self.kind {
            NativeCodecKind::Store
            | NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => ThreadCapability::parallel(None),
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

    fn deflate_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        let chunk_budget = threads
            .saturating_mul(Self::DEFLATE_PARALLEL_TARGET_CHUNKS_PER_THREAD)
            .max(1);
        total_len
            .div_ceil(chunk_budget)
            .max(Self::DEFLATE_PARALLEL_MIN_CHUNK_BYTES)
    }

    fn bzip2_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        let chunk_budget = threads
            .saturating_mul(Self::BZIP2_PARALLEL_TARGET_CHUNKS_PER_THREAD)
            .max(1);
        total_len
            .div_ceil(chunk_budget)
            .max(Self::BZIP2_PARALLEL_MIN_CHUNK_BYTES)
    }

    fn zstd_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        let chunk_budget = threads
            .saturating_mul(Self::ZSTD_PARALLEL_TARGET_CHUNKS_PER_THREAD)
            .max(1);
        total_len
            .div_ceil(chunk_budget)
            .max(Self::ZSTD_PARALLEL_MIN_CHUNK_BYTES)
    }

    fn encode_deflate_parallel(
        &self,
        request: &CodecOperationRequest,
        level: u32,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "deflate payload is empty; using single-threaded encoder".to_string(),
            );
            return Ok(None);
        }
        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("deflate payload exceeded addressable memory".into())
        })?;
        if input_len < Self::DEFLATE_PARALLEL_MIN_BYTES {
            execution.apply_pool_fallback(format!(
                "deflate payload too small for threaded encode ({input_len} bytes)"
            ));
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let chunk_len = Self::deflate_chunk_len(input_len, execution.effective_threads);

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let members = pool.install(|| {
                    input_bytes
                        .par_chunks(chunk_len)
                        .map(|chunk| -> Result<Vec<u8>> {
                            let mut encoder =
                                GzEncoder::new(Vec::new(), DeflateCompression::new(level));
                            encoder.write_all(chunk)?;
                            encoder.finish().map_err(Into::into)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;
                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                for member in members {
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(input_len_u64))
            }
            Err(error) => {
                execution.apply_pool_fallback(format!(
                    "deflate codec thread pool build failed: {error}"
                ));
                Ok(None)
            }
        }
    }

    fn encode_bzip2_parallel(
        &self,
        request: &CodecOperationRequest,
        level: u32,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "bzip2 payload is empty; using single-threaded encoder".to_string(),
            );
            return Ok(None);
        }
        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("bzip2 payload exceeded addressable memory".into())
        })?;
        if input_len < Self::BZIP2_PARALLEL_MIN_BYTES {
            execution.apply_pool_fallback(format!(
                "bzip2 payload too small for threaded encode ({input_len} bytes)"
            ));
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let chunk_len = Self::bzip2_chunk_len(input_len, execution.effective_threads);

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let members = pool.install(|| {
                    input_bytes
                        .par_chunks(chunk_len)
                        .map(|chunk| -> Result<Vec<u8>> {
                            let mut encoder =
                                BzEncoder::new(Vec::new(), Bzip2Compression::new(level));
                            encoder.write_all(chunk)?;
                            encoder.finish().map_err(Into::into)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;
                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                for member in members {
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(input_len_u64))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("bzip2 codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn buffered_cursor_consumed(reader: BufReader<Cursor<&[u8]>>, codec: &str) -> Result<usize> {
        let cursor_position_u64 = reader.get_ref().position();
        let cursor_position = usize::try_from(cursor_position_u64).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{codec} decoder consumed beyond addressable input size"
            ))
        })?;
        let buffered_unread = reader.buffer().len();
        cursor_position.checked_sub(buffered_unread).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{codec} decoder reported invalid buffered consumption state"
            ))
        })
    }

    fn scan_deflate_member_ranges(payload: &[u8]) -> Result<Vec<(usize, usize)>> {
        let mut ranges = Vec::new();
        let mut offset = 0usize;
        while offset < payload.len() {
            let slice = &payload[offset..];
            let mut decoder = BufReadGzDecoder::new(BufReader::new(Cursor::new(slice)));
            let mut sink = io::sink();
            io::copy(&mut decoder, &mut sink)?;
            let reader = decoder.into_inner();
            let consumed = Self::buffered_cursor_consumed(reader, "deflate")?;
            if consumed == 0 {
                return Err(RomWeaverError::Validation(
                    "deflate decoder did not consume input while scanning members".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(consumed);
            if next_offset > payload.len() {
                return Err(RomWeaverError::Validation(
                    "deflate member scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn scan_bzip2_member_ranges(payload: &[u8]) -> Result<Vec<(usize, usize)>> {
        let mut ranges = Vec::new();
        let mut offset = 0usize;
        while offset < payload.len() {
            let slice = &payload[offset..];
            let mut decoder = BufReadBzDecoder::new(BufReader::new(Cursor::new(slice)));
            let mut sink = io::sink();
            io::copy(&mut decoder, &mut sink)?;
            let reader = decoder.into_inner();
            let consumed = Self::buffered_cursor_consumed(reader, "bzip2")?;
            if consumed == 0 {
                return Err(RomWeaverError::Validation(
                    "bzip2 decoder did not consume input while scanning members".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(consumed);
            if next_offset > payload.len() {
                return Err(RomWeaverError::Validation(
                    "bzip2 member scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn scan_zstd_frame_ranges(payload: &[u8]) -> Result<Vec<(usize, usize)>> {
        let mut ranges = Vec::new();
        let mut offset = 0usize;
        while offset < payload.len() {
            let frame_size = zstd::zstd_safe::find_frame_compressed_size(&payload[offset..])
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "zstd frame scan failed at byte {offset}: {error}"
                    ))
                })?;
            if frame_size == 0 {
                return Err(RomWeaverError::Validation(
                    "zstd frame scanner returned a zero-sized frame".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(frame_size);
            if next_offset > payload.len() {
                return Err(RomWeaverError::Validation(
                    "zstd frame scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn encode_zstd_parallel(
        &self,
        request: &CodecOperationRequest,
        level: i32,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "zstd payload is empty; using single-threaded encoder".to_string(),
            );
            return Ok(None);
        }
        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("zstd payload exceeded addressable memory".into())
        })?;
        if input_len < Self::ZSTD_PARALLEL_MIN_BYTES {
            execution.apply_pool_fallback(format!(
                "zstd payload too small for threaded encode ({input_len} bytes)"
            ));
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let chunk_len = Self::zstd_chunk_len(input_len, execution.effective_threads);

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let frames = pool.install(|| {
                    input_bytes
                        .par_chunks(chunk_len)
                        .map(|chunk| zstd::bulk::compress(chunk, level).map_err(Into::into))
                        .collect::<Result<Vec<_>>>()
                })?;
                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                for frame in frames {
                    output.write_all(&frame)?;
                }
                output.flush()?;
                Ok(Some(input_len_u64))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("zstd codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn decode_deflate_parallel(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "deflate payload is empty; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let ranges = Self::scan_deflate_member_ranges(input_bytes)?;
        if ranges.len() <= 1 {
            execution.apply_pool_fallback(format!(
                "deflate stream has {} member(s); using single-threaded decoder",
                ranges.len()
            ));
            return Ok(None);
        }

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let decoded_members = pool.install(|| {
                    ranges
                        .par_iter()
                        .map(|(start, end)| -> Result<Vec<u8>> {
                            let member_slice = &input_bytes[*start..*end];
                            let mut decoder =
                                MultiGzDecoder::new(BufReader::new(Cursor::new(member_slice)));
                            let mut decoded = Vec::new();
                            io::copy(&mut decoder, &mut decoded)?;
                            Ok(decoded)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;

                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                let mut total_written = 0u64;
                for member in decoded_members {
                    total_written = total_written.saturating_add(member.len() as u64);
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(total_written))
            }
            Err(error) => {
                execution.apply_pool_fallback(format!(
                    "deflate codec thread pool build failed: {error}"
                ));
                Ok(None)
            }
        }
    }

    fn decode_bzip2_parallel(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "bzip2 payload is empty; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let ranges = Self::scan_bzip2_member_ranges(input_bytes)?;
        if ranges.len() <= 1 {
            execution.apply_pool_fallback(format!(
                "bzip2 stream has {} member(s); using single-threaded decoder",
                ranges.len()
            ));
            return Ok(None);
        }

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let decoded_members = pool.install(|| {
                    ranges
                        .par_iter()
                        .map(|(start, end)| -> Result<Vec<u8>> {
                            let member_slice = &input_bytes[*start..*end];
                            let mut decoder =
                                MultiBzDecoder::new(BufReader::new(Cursor::new(member_slice)));
                            let mut decoded = Vec::new();
                            io::copy(&mut decoder, &mut decoded)?;
                            Ok(decoded)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;

                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                let mut total_written = 0u64;
                for member in decoded_members {
                    total_written = total_written.saturating_add(member.len() as u64);
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(total_written))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("bzip2 codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn decode_zstd_parallel(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "zstd payload is empty; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let ranges = Self::scan_zstd_frame_ranges(input_bytes)?;
        if ranges.len() <= 1 {
            execution.apply_pool_fallback(format!(
                "zstd stream has {} frame(s); using single-threaded decoder",
                ranges.len()
            ));
            return Ok(None);
        }

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let decoded_frames = pool.install(|| {
                    ranges
                        .par_iter()
                        .map(|(start, end)| -> Result<Vec<u8>> {
                            let frame_slice = &input_bytes[*start..*end];
                            let mut decoder =
                                ZstdDecoder::new(BufReader::new(Cursor::new(frame_slice)))?
                                    .single_frame();
                            let mut decoded = Vec::new();
                            io::copy(&mut decoder, &mut decoded)?;
                            Ok(decoded)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;

                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                let mut total_written = 0u64;
                for frame in decoded_frames {
                    total_written = total_written.saturating_add(frame.len() as u64);
                    output.write_all(&frame)?;
                }
                output.flush()?;
                Ok(Some(total_written))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("zstd codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
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
                if let Some(copied) =
                    self.encode_deflate_parallel(request, level.unwrap_or(6) as u32, execution)?
                {
                    copied
                } else {
                    let mut source = BufReader::new(File::open(&request.input)?);
                    let output =
                        BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                    let mut encoder =
                        GzEncoder::new(output, DeflateCompression::new(level.unwrap_or(6) as u32));
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Zstd => {
                if let Some(copied) =
                    self.encode_zstd_parallel(request, level.unwrap_or(3), execution)?
                {
                    copied
                } else {
                    let mut source = BufReader::new(File::open(&request.input)?);
                    let output =
                        BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
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
            }
            NativeCodecKind::Lzma2 => {
                let mut source = BufReader::new(File::open(&request.input)?);
                let output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
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
                if let Some(copied) =
                    self.encode_bzip2_parallel(request, level.unwrap_or(6) as u32, execution)?
                {
                    copied
                } else {
                    let mut source = BufReader::new(File::open(&request.input)?);
                    let output =
                        BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                    let mut encoder =
                        BzEncoder::new(output, Bzip2Compression::new(level.unwrap_or(6) as u32));
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                }
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
                if let Some(copied) = self.decode_deflate_parallel(request, execution)? {
                    copied
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = MultiGzDecoder::new(source);
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Zstd => {
                if let Some(copied) = self.decode_zstd_parallel(request, execution)? {
                    copied
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = ZstdDecoder::new(source)?;
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
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
                if let Some(copied) = self.decode_bzip2_parallel(request, execution)? {
                    copied
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = MultiBzDecoder::new(source);
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
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

        for codec in ["deflate", "zstd", "lzma2", "bzip2"] {
            let backend = registry.find_by_name(codec).expect("codec backend");
            assert_eq!(
                backend.capabilities().encode_threads,
                ThreadCapability::parallel(None)
            );
        }

        for codec in ["store"] {
            let backend = registry.find_by_name(codec).expect("codec backend");
            assert_eq!(
                backend.capabilities().encode_threads,
                ThreadCapability::single_threaded()
            );
        }

        for codec in ["store", "deflate", "zstd", "lzma2", "bzip2"] {
            let backend = registry.find_by_name(codec).expect("codec backend");
            assert_eq!(
                backend.capabilities().decode_threads,
                ThreadCapability::parallel(None)
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
    fn deflate_backend_encode_runtime_threads_match_capability() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.gz");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(23))
            .collect::<Vec<_>>();
        fs::write(&source, payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("deflate").expect("deflate backend");
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
    fn bzip2_backend_encode_runtime_threads_match_capability() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.bz2");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&source, payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("bzip2").expect("bzip2 backend");
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
    fn bzip2_backend_decode_supports_multistream_payloads() {
        let temp = TestDir::new();
        let member_a = temp.path().join("member-a.bz2");
        let member_b = temp.path().join("member-b.bz2");
        let joined = temp.path().join("joined.bz2");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(5).wrapping_add(3))
            .collect::<Vec<_>>();
        let split = payload.len() / 2;

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("bzip2").expect("bzip2 backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        let part_a = temp.path().join("part-a.bin");
        let part_b = temp.path().join("part-b.bin");
        fs::write(&part_a, &payload[..split]).expect("write part a");
        fs::write(&part_b, &payload[split..]).expect("write part b");

        backend
            .encode(
                &CodecOperationRequest {
                    input: part_a,
                    output: member_a.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member a");
        backend
            .encode(
                &CodecOperationRequest {
                    input: part_b,
                    output: member_b.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member b");

        let mut joined_bytes = fs::read(&member_a).expect("read member a");
        joined_bytes.extend(fs::read(&member_b).expect("read member b"));
        fs::write(&joined, joined_bytes).expect("write joined");

        let decode = backend
            .decode(
                &CodecOperationRequest {
                    input: joined,
                    output: decoded.clone(),
                    level: None,
                },
                &context,
            )
            .expect("decode multistream");
        assert_eq!(decode.status, OperationStatus::Succeeded);
        let execution = decode.thread_execution.expect("thread execution");
        assert!(capabilities.decode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(
            execution.effective_threads > 1,
            "fallback: {:?}",
            execution.thread_fallback_reason
        );
        assert!(
            execution.used_parallelism,
            "fallback: {:?}",
            execution.thread_fallback_reason
        );
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }

    #[test]
    fn deflate_backend_decode_runtime_threads_match_capability_with_multimember_input() {
        let temp = TestDir::new();
        let member_a = temp.path().join("member-a.gz");
        let member_b = temp.path().join("member-b.gz");
        let joined = temp.path().join("joined.gz");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(13).wrapping_add(11))
            .collect::<Vec<_>>();
        let split = payload.len() / 2;

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("deflate").expect("deflate backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        let part_a = temp.path().join("part-a.bin");
        let part_b = temp.path().join("part-b.bin");
        fs::write(&part_a, &payload[..split]).expect("write part a");
        fs::write(&part_b, &payload[split..]).expect("write part b");

        backend
            .encode(
                &CodecOperationRequest {
                    input: part_a,
                    output: member_a.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member a");
        backend
            .encode(
                &CodecOperationRequest {
                    input: part_b,
                    output: member_b.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member b");

        let mut joined_bytes = fs::read(&member_a).expect("read member a");
        joined_bytes.extend(fs::read(&member_b).expect("read member b"));
        fs::write(&joined, joined_bytes).expect("write joined");

        let decode = backend
            .decode(
                &CodecOperationRequest {
                    input: joined,
                    output: decoded.clone(),
                    level: None,
                },
                &context,
            )
            .expect("decode multistream");
        assert_eq!(decode.status, OperationStatus::Succeeded);
        let execution = decode.thread_execution.expect("thread execution");
        assert!(capabilities.decode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(
            execution.effective_threads > 1,
            "fallback: {:?}",
            execution.thread_fallback_reason
        );
        assert!(
            execution.used_parallelism,
            "fallback: {:?}",
            execution.thread_fallback_reason
        );
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }

    #[test]
    fn zstd_backend_decode_runtime_threads_match_capability_with_multiframe_input() {
        let temp = TestDir::new();
        let frame_a = temp.path().join("frame-a.zst");
        let frame_b = temp.path().join("frame-b.zst");
        let joined = temp.path().join("joined.zst");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(19).wrapping_add(7))
            .collect::<Vec<_>>();
        let split = payload.len() / 2;

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("zstd").expect("zstd backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        let part_a = temp.path().join("part-a.bin");
        let part_b = temp.path().join("part-b.bin");
        fs::write(&part_a, &payload[..split]).expect("write part a");
        fs::write(&part_b, &payload[split..]).expect("write part b");

        backend
            .encode(
                &CodecOperationRequest {
                    input: part_a,
                    output: frame_a.clone(),
                    level: Some(3),
                },
                &context,
            )
            .expect("encode frame a");
        backend
            .encode(
                &CodecOperationRequest {
                    input: part_b,
                    output: frame_b.clone(),
                    level: Some(3),
                },
                &context,
            )
            .expect("encode frame b");

        let mut joined_bytes = fs::read(&frame_a).expect("read frame a");
        joined_bytes.extend(fs::read(&frame_b).expect("read frame b"));
        fs::write(&joined, joined_bytes).expect("write joined");

        let decode = backend
            .decode(
                &CodecOperationRequest {
                    input: joined,
                    output: decoded.clone(),
                    level: None,
                },
                &context,
            )
            .expect("decode multiframe");
        assert_eq!(decode.status, OperationStatus::Succeeded);
        let execution = decode.thread_execution.expect("thread execution");
        assert!(capabilities.decode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
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
