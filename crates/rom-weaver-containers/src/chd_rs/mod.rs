#![warn(missing_docs)]
//! An implementation of the MAME CHD (Compressed Hunks of Data) format in pure Safe Rust, with support
//! for CHD V1-5.
//!
//! ## Supported Compression Codecs
//! chd-rs supports the following compression codecs.
//!
//! * None
//! * Zlib/Zlib+/Zlib V5
//! * CDZL (CD Zlib)
//! * CDLZ (CD LZMA)
//! * CDFL (CD FLAC)
//! * FLAC (Raw FLAC)
//! * LZMA (Raw LZMA)
//! * Huff (MAME Static Huffman)
//! * AVHU (AV Huffman)
//! * Zstandard
//! * CDZS (CD Zstandard)
//!
//! ## Iterating over hunks
//! Because [`Hunk`](crate::chd_rs::Hunk) keeps a mutable reference to its owning
//! [`Chd`](crate::chd_rs::Chd), direct iteration of hunks is not possible without
//! Generic Associated Types. Instead, the hunk indices should be iterated over.
//!
//!```no_run
//! use std::fs::File;
//! use std::io::BufReader;
//! use rom_weaver_containers::chd_rs::Chd;
//!
//! # fn main() -> rom_weaver_containers::chd_rs::Result<()> {
//! let mut f = BufReader::new(File::open("file.chd")?);
//! let mut chd = Chd::open(&mut f, None)?;
//! let hunk_count = chd.header().hunk_count();
//! let hunk_size = chd.header().hunk_size();
//!
//! // buffer to store uncompressed hunk data must be the same length as the hunk size.
//! let mut hunk_buf = chd.get_hunksized_buffer();
//! // buffer to store compressed data.
//! let mut cmp_buf = Vec::new();
//!
//! for hunk_num in 0..hunk_count {
//!     let mut hunk = chd.hunk(hunk_num)?;
//!     hunk.read_hunk_in(&mut cmp_buf, &mut hunk_buf)?;
//! }
//! # Ok(())
//! # }
//! ```
//!
//! ## Iterating over metadata
//! Metadata in a CHD file consists of a list of entries that contain offsets to the
//! byte data of the metadata contents in the CHD file. The individual metadata entries
//! can be iterated directly, but a reference to the source stream has to be provided to
//! read the data.
//! ```no_run
//! use std::fs::File;
//! use std::io::BufReader;
//! use rom_weaver_containers::chd_rs::Chd;
//! use rom_weaver_containers::chd_rs::metadata::MetadataRef;
//!
//! # fn main() -> rom_weaver_containers::chd_rs::Result<()> {
//! let mut f = BufReader::new(File::open("file.chd")?);
//! let mut chd = Chd::open(&mut f, None)?;
//! let entries = chd.metadata_refs().collect::<Result<Vec<MetadataRef>, _>>()?;
//! for entry in entries {
//!     let metadata = entry.read(chd.inner())?;
//! }
//! # Ok(())
//! # }
//!```
//! `Vec<Metadata>` implements `TryFrom<MetadataRefs>` so all metadata entries
//! can be collected at once without requiring a reference to the file.
//! ```no_run
//! use std::fs::File;
//! use std::io::BufReader;
//! use rom_weaver_containers::chd_rs::Chd;
//! use rom_weaver_containers::chd_rs::metadata::Metadata;
//!
//! # fn main() -> rom_weaver_containers::chd_rs::Result<()> {
//! let mut f = BufReader::new(File::open("file.chd")?);
//! // chd takes ownership of f here
//! let mut chd = Chd::open(f, None)?;
//!
//! let metadatas: Vec<Metadata> = chd.metadata_refs().try_into()?;
//! # Ok(())
//! # }
//!```
//!

mod error;

mod block_hash;
pub(crate) mod cdrom;
mod chdfile;
pub(crate) mod compression;

/// cbindgen:ignore
mod huffman;

/// Implementations of codecs used in MAME CHD.
///
/// Each codec may have restrictions on the hunk size, lengths and contents
/// of the buffer. If [`decompress`](crate::chd_rs::codecs::CodecImplementation::decompress) is called
/// with buffers that do not satisfy the constraints, it may return [`CompressionError`](crate::chd_rs::Error),
/// or panic, especially if the output buffer does not satisfy length requirements.
///
/// Because codecs are allowed to be used outside of a hunk-sized granularity, such as in
/// CD-ROM wrapped codecs that use Deflate to decompress subcode data, the codec implementations
/// do not check the length of the output buffer against the hunk size. It is up to the caller
/// of [`decompress`](crate::chd_rs::codecs::CodecImplementation::decompress) to uphold length invariants.
pub mod codecs {
    pub use crate::chd_rs::compression::codecs::*;
    pub use crate::chd_rs::compression::{
        CodecImplementation, CompressionCodec, CompressionCodecType, DecompressResult,
    };
}

const fn make_tag(a: &[u8; 4]) -> u32 {
    ((a[0] as u32) << 24) | ((a[1] as u32) << 16) | ((a[2] as u32) << 8) | (a[3] as u32)
}

macro_rules! const_assert {
    ($($list:ident : $ty:ty),* => $expr:expr) => {{
        struct Assert<$(const $list: $ty,)*>;
        impl<$(const $list: $ty,)*> Assert<$($list,)*> {
            const OK: u8 = 0 - !($expr) as u8;
        }
        Assert::<$($list,)*>::OK
    }};
    ($expr:expr) => {
        const OK: u8 = 0 - !($expr) as u8;
    };
}

pub(crate) use const_assert;

pub use chdfile::{Chd, Hunk};
pub use error::{Error, Result};
pub mod header;
pub mod map;
pub mod metadata;
pub mod read;

pub mod write;
