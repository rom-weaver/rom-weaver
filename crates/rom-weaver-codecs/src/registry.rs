use std::io::{BufReader, Cursor, Read, Write};

use bzip2::read::MultiBzDecoder;
use flate2::{read::DeflateDecoder, read::ZlibDecoder};
use lzma_rust2::{Lzma2Reader, LzmaReader, XzOptions, XzReader, XzWriter};
use rom_weaver_core::{Result, RomWeaverError};
use zstd::stream::Decoder as ZstdDecoder;

#[path = "definitions.rs"]
mod definitions;
pub use self::definitions::{
    CanonicalCodec, RequestedCodec, normalize_codec_label, parse_requested_codec,
};

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
