use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
};

use bzip2::{Compression as Bzip2Compression, read::MultiBzDecoder, write::BzEncoder};
use flate2::{
    Compression as FlateCompression, read::DeflateDecoder, read::ZlibDecoder, write::GzEncoder,
};
use lzma_rust2::{Lzma2Reader, LzmaReader, XzOptions, XzReader, XzWriter};
use rayon::prelude::*;
use rom_weaver_core::{
    BoundedIoPolicy, ChunkPlanner, CodecBackend, CodecCapabilities, CodecDescriptor,
    CodecOperationRequest, FileChunk, OperationContext, OperationFamily, OperationReport,
    OrderedChunkWriter, Result, RomWeaverError, SharedThreadPool, ThreadCapability,
    ThreadExecution,
};
use rom_weaver_libarchive::{ReadArchive, ReadFilter};
use zstd::stream::{Decoder as ZstdDecoder, write::Encoder as ZstdEncoder};

#[path = "definitions.rs"]
mod definitions;
use self::definitions::*;
pub use self::definitions::{
    CanonicalCodec, CodecRegistry, RequestedCodec, normalize_codec_label, parse_requested_codec,
};

#[path = "backend.rs"]
mod backend;

#[path = "backend_trait.rs"]
mod backend_trait;

#[path = "helpers.rs"]
mod helpers;
pub use self::helpers::{
    DeflateDecodeIntoBufferResult, decode_bzip2_exact, decode_deflate_exact,
    decode_deflate_into_buffer, decode_lzma_with_props, decode_lzma2, decode_xz_exact,
    decode_zlib_exact, decode_zstd_exact, encode_xz_preset, encode_zstd,
};

#[cfg(test)]
#[path = "../tests/unit/registry.rs"]
mod tests;
