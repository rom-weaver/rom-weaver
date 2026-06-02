use std::collections::{BTreeMap, HashMap};
use std::{
    borrow::Cow,
    fs::{self, File},
    io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

use flacenc::{component::BitRepr as _, error::Verify as _};
use flate2::{Compression as GzipCompression, write::DeflateEncoder};
// The rayon parallel-iterator prelude is only needed by decode paths that do not use wasi threads
// paths (`par_chunks`); the wasi-threads build parallelises with scoped threads instead.
#[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
use rayon::prelude::*;
use rom_weaver_checksum::StreamingChecksum;
use rom_weaver_codecs::{CanonicalCodec, RequestedCodec, parse_requested_codec};
use rom_weaver_core::{
    ContainerByteProgress, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandlerOperations, ContainerInspectRequest, FormatDescriptor, OperationContext,
    OperationFamily, OperationReport, OperationStatus, OrderedStreamingMessages, ProbeConfidence,
    Result, RomWeaverError, SelectionMatcher, ThreadCapability, ThreadExecution,
    create_extract_output_file, file_starts_with, maybe_emit_container_byte_progress,
    ordered_streaming_compress,
};
// Only the decode paths use a shared pool, and they are absent on the wasi-threads build.
#[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
use rom_weaver_core::SharedThreadPool;
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use zstd::bulk::compress as zstd_compress;

pub const CHD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "chd",
    aliases: &["chd-cd", "chd-dvd", "chd-raw", "chd-hd"],
    extensions: &[".chd"],
};

const CHD_SIGNATURE: [u8; 8] = *b"MComprHD";
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

#[derive(Clone, Debug)]
struct ExtractedFileChecksum {
    path: PathBuf,
    values: BTreeMap<String, String>,
}

fn create_extract_checksum(context: &OperationContext) -> Result<Option<StreamingChecksum>> {
    StreamingChecksum::new_with_context(context.extract_checksum_algorithms(), context)
}

// Only the decode paths build a shared pool; the compressed-create path uses scoped threads. Both
// decode callers are absent on the wasi-threads build, so gate this to match and avoid dead code.
#[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
fn build_chd_thread_pool(
    label: &str,
    threads: usize,
) -> std::result::Result<SharedThreadPool, String> {
    SharedThreadPool::with_size(threads).map_err(|error| {
        let reason = match error {
            RomWeaverError::ThreadPoolBuild(reason) => reason,
            other => other.to_string(),
        };
        format!("failed to build CHD rust {label} pool (threads={threads}): {reason}")
    })
}

fn build_extract_checksum_emitted_file_detail(
    path: &Path,
    checksums: BTreeMap<String, String>,
) -> Option<Value> {
    if checksums.is_empty() {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let file_name = canonical.file_name()?.to_string_lossy().into_owned();
    let mut entry = Map::new();
    entry.insert(
        "path".to_string(),
        json!(canonical.to_string_lossy().replace('\\', "/")),
    );
    entry.insert("file_name".to_string(), json!(file_name));
    entry.insert("size_bytes".to_string(), json!(metadata.len()));
    entry.insert("checksums".to_string(), json!(checksums));
    Some(Value::Object(entry))
}

fn attach_extract_checksum_details(
    mut report: OperationReport,
    checksums: Vec<ExtractedFileChecksum>,
) -> OperationReport {
    if checksums.is_empty() || report.status != OperationStatus::Succeeded {
        return report;
    }
    let mut details = match report.details.take() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let emitted = checksums
        .into_iter()
        .filter_map(|entry| build_extract_checksum_emitted_file_detail(&entry.path, entry.values))
        .collect::<Vec<_>>();
    if !emitted.is_empty() {
        details.insert("emitted_files".to_string(), Value::Array(emitted));
    }
    report.details = Some(Value::Object(details));
    report
}

fn push_finalized_extract_checksum(
    output_checksums: &mut Vec<ExtractedFileChecksum>,
    path: PathBuf,
    checksum: Option<StreamingChecksum>,
) -> Result<()> {
    if let Some(checksum) = checksum {
        output_checksums.push(ExtractedFileChecksum {
            path,
            values: checksum.finalize()?,
        });
    }
    Ok(())
}

mod handler;

pub use handler::ChdContainerHandler;
