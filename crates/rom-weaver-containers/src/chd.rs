use std::collections::BTreeMap;
use std::{
    borrow::Cow,
    fs::{self, File},
    io::{self, BufRead, BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

use crate::extract_support::{
    ExtractedFileChecksum, ExtractedTrackChecksum, attach_extract_checksum_details,
    create_extract_checksum,
};
use rom_weaver_checksum::{StreamingChecksum, detect_rom_identity_for_path};
use rom_weaver_core::{
    CancellationToken, ContainerByteProgress, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandlerOperations, ContainerListEntry, ContainerProbeRequest, CreateInputOverride,
    CreateInputSource, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    OrderedStreamingMessages, ProbeConfidence, Result, RomWeaverError, SelectionMatcher,
    ThreadCapability, ThreadExecution, UnsupportedOp, attach_emitted_file_paths,
    attach_extraction_details, create_extract_output_file, file_starts_with,
    insert_thread_execution_details, maybe_emit_container_byte_progress, operation_report_details,
    ordered_streaming_compress, parallel_heap_reserve, reserve_parallel_heap,
};
use serde_json::{Map, Value, json};
use tracing::{debug, trace};

pub const CHD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "chd",
    aliases: &[
        "chd-cd", "chd-gd", "chd-dvd", "chd-raw", "chd-hd", "chd-av", "chd-ld",
    ],
    extensions: &[".chd"],
};

/// CHD create-mode names accepted after `chd-`, each paired with the canonical
/// mode it selects. Shared by the create-format parser and typegen so callers
/// normalize `ld` to `av` from one table.
pub const CHD_CREATE_MODES: &[(&str, &str)] = &[
    ("cd", "cd"),
    ("gd", "gd"),
    ("dvd", "dvd"),
    ("raw", "raw"),
    ("hd", "hd"),
    ("av", "av"),
    ("ld", "av"),
];

/// CHD container file magic. Canonical source for the web UI's synchronous
/// rom-specific magic probe (surfaced via typegen container metadata).
pub const CHD_SIGNATURE: [u8; 8] = *b"MComprHD";
/// Canonical CD/DVD logical sector sizes, shared with the web UI via typegen for
/// the ambiguous-`.bin` disc-image heuristic: raw CD Mode1/Mode2 sectors are 2352
/// bytes, cooked CD and DVD sectors are 2048. The disc codec's internal sector
/// constants derive from this array so the two never drift.
pub const CD_SECTOR_SIZES: [u32; 2] = [2352, 2048];
const CHD_MAX_COMPRESSORS: usize = 4;
const CHD_METADATA_FLAG_CHECKSUM: u8 = 0x01;
const CD_FRAME_SIZE: u32 = 2352 + 96;
const HARD_DISK_METADATA_TAG: u32 = make_tag(b'G', b'D', b'D', b'D');
const CDROM_TRACK_METADATA2_TAG: u32 = make_tag(b'C', b'H', b'T', b'2');
const GDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'D');
const DVD_METADATA_TAG: u32 = make_tag(b'D', b'V', b'D', b' ');

const fn make_tag(a: u8, b: u8, c: u8, d: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((c as u32) << 8) | (d as u32)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChdCodec(u32);

impl ChdCodec {
    pub const NONE: Self = Self(0);
    pub const ZLIB: Self = Self(make_tag(b'z', b'l', b'i', b'b'));
    pub const ZSTD: Self = Self(make_tag(b'z', b's', b't', b'd'));
    pub const LZMA: Self = Self(make_tag(b'l', b'z', b'm', b'a'));
    pub const HUFFMAN: Self = Self(make_tag(b'h', b'u', b'f', b'f'));
    pub const AVHUFF: Self = Self(make_tag(b'a', b'v', b'h', b'u'));
    pub const FLAC: Self = Self(make_tag(b'f', b'l', b'a', b'c'));
    pub const CD_ZLIB: Self = Self(make_tag(b'c', b'd', b'z', b'l'));
    pub const CD_ZSTD: Self = Self(make_tag(b'c', b'd', b'z', b's'));
    pub const CD_LZMA: Self = Self(make_tag(b'c', b'd', b'l', b'z'));
    pub const CD_FLAC: Self = Self(make_tag(b'c', b'd', b'f', b'l'));

    const fn raw(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChdMediaKind {
    Raw,
    HardDisk,
    CdRom,
    GdRom,
    Dvd,
    Av,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChdHeader {
    version: u32,
    logical_bytes: u64,
    hunk_bytes: u32,
    hunk_count: u32,
    unit_bytes: u32,
    unit_count: u64,
    compressed: bool,
    compression: [ChdCodec; CHD_MAX_COMPRESSORS],
    sha1: Option<[u8; 20]>,
    raw_sha1: Option<[u8; 20]>,
}

fn push_finalized_extract_checksum(
    output_checksums: &mut Vec<ExtractedFileChecksum>,
    path: PathBuf,
    checksum: Option<StreamingChecksum>,
) -> Result<()> {
    push_finalized_extract_checksum_with_tracks(output_checksums, path, checksum, Vec::new())
}

fn push_finalized_extract_checksum_with_tracks(
    output_checksums: &mut Vec<ExtractedFileChecksum>,
    path: PathBuf,
    checksum: Option<StreamingChecksum>,
    track_values: Vec<ExtractedTrackChecksum>,
) -> Result<()> {
    if let Some(checksum) = checksum {
        let values = checksum.finalize()?;
        // Skip entries whose output is not a readable regular file, as the emitted-file
        // builder always has. The disc platform/medium is detected from a bounded prefix
        // read of the just-written output (no re-decode of the CHD); a `.cue` sheet or
        // non-disc track yields nothing.
        let Some(size_bytes) = fs::metadata(&path)
            .ok()
            .filter(fs::Metadata::is_file)
            .map(|metadata| metadata.len())
        else {
            return Ok(());
        };
        let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        output_checksums.push(ExtractedFileChecksum {
            rom_identity: detect_rom_identity_for_path(&canonical),
            path,
            size_bytes,
            values,
            variants: Vec::new(),
            timing: None,
            track_values,
        });
    }
    Ok(())
}

mod handler;

pub use handler::ChdContainerHandler;
