use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use bzip2::read::MultiBzDecoder;
use flate2::{
    read::DeflateDecoder, read::ZlibDecoder,
};
use lzma_rust2::{Lzma2Reader, LzmaReader, XzOptions, XzReader, XzWriter};
use rayon::prelude::*;
use rom_weaver_core::{
    BoundedIoPolicy, ChunkPlanner, CodecBackend, CodecCapabilities, CodecDescriptor,
    CodecOperationRequest, FileChunk, FormatDescriptor, OperationContext, OperationFamily,
    OperationReport, OrderedChunkWriter, Result, RomWeaverError, SharedThreadPool, ThreadCapability,
    ThreadExecution,
};
use rom_weaver_libarchive::{
    EntryFileType, EntrySpec, ReadArchive, ReadFilter, WriteArchive, WriteFilter, WriteFormat,
    ZeroWriteBehavior,
};
use zstd::stream::Decoder as ZstdDecoder;

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
    Lz4,
    Brotli,
    Ppmd,
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
            Self::Lz4 => "lz4",
            Self::Brotli => "brotli",
            Self::Ppmd => "ppmd",
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
                "lz4" => RequestedCodec::Known(CanonicalCodec::Lz4),
                "brotli" | "br" => RequestedCodec::Known(CanonicalCodec::Brotli),
                "ppmd" => RequestedCodec::Known(CanonicalCodec::Ppmd),
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
