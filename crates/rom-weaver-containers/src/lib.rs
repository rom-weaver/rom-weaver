// The vendored `xdvdfs` module is upstream no_std source using `alloc::*`
// paths; `alloc` is not in the extern prelude, so it is linked here.
extern crate alloc;

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

mod archive_entries;
mod archive_formats;
mod constants;
mod extract_support;
mod formats;
mod libarchive_support;
pub mod nod;
pub mod xdvdfs;

use crate::nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
    write::{
        DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
        ProcessOptions as NodProcessOptions,
    },
};
use crate::xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper, write::fs::XDVDFSFilesystem as XdvdfsFilesystem,
};
use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
#[cfg(test)]
use rom_weaver_chd::ChdCodec;
#[cfg(test)]
use rom_weaver_chd::ChdContainerHandler;
use rom_weaver_checksum::StreamingChecksum;
use rom_weaver_codecs::{decode_deflate_into_buffer, normalize_codec_label};
use rom_weaver_core::{
    ContainerByteProgress, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandlerOperations, ContainerListEntry, ContainerProbeRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, OrderedChunkWriter,
    OrderedStreamingMessages, ProbeConfidence, Result, RomWeaverError, SelectionMatcher,
    ThreadCapability, ThreadExecution, UnsupportedOp, attach_emitted_file_paths,
    attach_extraction_details, bounded_items_for_threads, create_extract_output_file,
    emit_container_running_progress, file_starts_with, insert_thread_execution_details,
    maybe_emit_container_byte_progress, operation_report_details, ordered_streaming_compress,
    physical_memory_bytes,
};
use rom_weaver_libarchive::{
    ReadFilter as LibarchiveReadFilter, RegularArchiveProbeFormat as LibarchiveProbeFormat,
    WriteFilter as LibarchiveCreateFilter, WriteFormat as LibarchiveCreateFormat,
};
use serde_json::{Map, Value, json};
use zeekstd::{DecodeOptions as ZeekstdDecodeOptions, SeekTable as ZeekstdSeekTable};
use zstd::bulk::Compressor as ZstdCompressor;

use archive_entries::{ArchiveInputEntry, collect_archive_inputs, sum_input_file_bytes};
pub use archive_formats::{
    ArchiveExtensionAlias, ArchiveFormatMetadata, ArchiveMagicSignature, archive_format_metadata,
};
use constants::{
    LIBARCHIVE_CREATE_IO_BUFFER_BYTES, LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES,
    LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES, Z3DS_DECODE_BUFFER_BYTES, Z3DS_DEFAULT_COMPRESSION_LEVEL,
    Z3DS_DEFAULT_FRAME_SIZE_BYTES, Z3DS_EXTRACT_MAX_CHUNK_BYTES, Z3DS_EXTRACT_TASKS_PER_THREAD,
    Z3DS_MAX_COMPRESSION_LEVEL, Z3DS_MIN_COMPRESSION_LEVEL, copy_progress_buffer_size,
};
use extract_support::{
    ContainerProgressContext, ExtractChunkWriter, ExtractedFileChecksum,
    attach_extract_checksum_details, copy_reader_with_progress, create_extract_checksum,
    decode_tasks_ordered, emit_container_indeterminate_progress, emit_container_step_progress,
    stream_extract_identity,
};
#[cfg(test)]
use formats::SEVEN_Z;
pub use formats::{
    CompressFormatRecommendation, ContainerCapabilitiesMetadata, ContainerDefaultOutputMetadata,
    ContainerFormatMetadata, ContainerOutputExtensionStrategy, ContainerRegistry,
    ContainerThreadCapabilityMetadata, DiscImagePolicyMetadata, container_format_metadata,
    disc_image_policy_metadata, extract_only_create_error, extract_only_create_validation_message,
    is_ambiguous_disc_image_extension, is_likely_disc_image_size, is_likely_disc_image_source,
    recommend_container_for_identity,
};
use formats::{GCZ, NFS, PBP, RVZ, TGC, WBFS, WIA, XISO, Z3DS};
use libarchive_support::{
    LibarchiveCreateConfig, extract_regular_archive_with_libarchive, libarchive_close_read_stream,
    libarchive_open_read_stream, list_regular_archive_entries_with_libarchive,
    list_regular_archive_entry_records_with_libarchive,
    probe_regular_archive_details_with_libarchive, probe_regular_archive_with_libarchive,
    probe_stream_with_libarchive, write_archive_with_libarchive,
};
pub use z3ds::{Z3dsSubtypeMetadata, z3ds_subtype_metadata};

const GZIP_SIGNATURE: [u8; 2] = [0x1F, 0x8B];
const BZIP2_SIGNATURE: [u8; 3] = [b'B', b'Z', b'h'];
const XZ_SIGNATURE: [u8; 6] = [0xFD, b'7', b'z', b'X', b'Z', 0x00];
const ZSTD_SIGNATURE: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const CSO_SIGNATURE: [u8; 4] = [b'C', b'I', b'S', b'O'];
const PBP_SIGNATURE: [u8; 4] = [0x00, b'P', b'B', b'P'];

fn supported_codec_clause(supported_codecs: &[&str]) -> String {
    match supported_codecs {
        [] => "no codecs are supported".to_string(),
        [codec] => format!("supported codec is {codec}"),
        [first, second] => format!("supported codecs are {first} and {second}"),
        [first @ .., last] => format!("supported codecs are {}, and {last}", first.join(", ")),
    }
}

fn unsupported_create_codec_error(
    format_name: &str,
    codec_name: &str,
    supported_codecs: &[&str],
) -> RomWeaverError {
    RomWeaverError::Validation(format!(
        "unsupported {format_name} codec `{codec_name}`; {}",
        supported_codec_clause(supported_codecs)
    ))
}

fn resolve_create_codec<'a>(
    format_name: &str,
    codec: Option<&str>,
    supported_codecs: &'a [&'a str],
    default_codec: &'a str,
) -> Result<&'a str> {
    let Some(codec_name) = codec
        .map(str::trim)
        .filter(|codec| !codec.is_empty())
        .map(str::to_ascii_lowercase)
    else {
        return Ok(default_codec);
    };

    supported_codecs
        .iter()
        .copied()
        .find(|supported_codec| *supported_codec == codec_name)
        .ok_or_else(|| unsupported_create_codec_error(format_name, &codec_name, supported_codecs))
}

fn attach_compression_details(
    mut report: OperationReport,
    codec: impl Into<String>,
    level: Option<i32>,
    logical_bytes: u64,
    execution: &ThreadExecution,
) -> OperationReport {
    let mut details = operation_report_details(&mut report);
    let mut compression = Map::new();
    compression.insert("codec".to_string(), json!(codec.into()));
    if let Some(level) = level {
        compression.insert("level".to_string(), json!(level));
    }
    compression.insert("logical_bytes".to_string(), json!(logical_bytes));
    insert_thread_execution_details(&mut compression, execution);
    details.insert("compression".to_string(), Value::Object(compression));
    report.details = Some(Value::Object(details));
    report
}

#[path = "handlers/zip.rs"]
mod zip;
#[cfg(test)]
pub(crate) use zip::zstd_threads_for_budget;
pub(crate) use zip::{ZipContainerFlavor, ZipContainerHandler};

#[path = "handlers/tar.rs"]
mod tar_handler;
pub(crate) use tar_handler::TarContainerHandler;

#[path = "handlers/stream.rs"]
mod stream;
pub(crate) use stream::{StreamCompression, StreamContainerHandler};

#[path = "handlers/cso.rs"]
mod cso;
pub(crate) use cso::CsoContainerHandler;

#[path = "handlers/sevenz.rs"]
mod sevenz;
pub(crate) use sevenz::SevenZContainerHandler;
#[cfg(test)]
pub(crate) use sevenz::SevenZMethod;
#[cfg(test)]
pub(crate) use sevenz::{lzma2_threads_for_budget, lzma2_threads_for_budget_with_limits};

#[path = "handlers/rar.rs"]
mod rar;
pub(crate) use rar::RarContainerHandler;

#[path = "handlers/pbp.rs"]
mod pbp;
pub(crate) use pbp::PbpContainerHandler;

#[path = "handlers/xiso.rs"]
mod xiso;
pub(crate) use xiso::XisoContainerHandler;

#[path = "handlers/nod_shared.rs"]
mod nod_shared;
pub(crate) use nod_shared::NodHandlerCore;

#[path = "handlers/gcz.rs"]
mod gcz;
pub(crate) use gcz::GczContainerHandler;

#[path = "handlers/wia.rs"]
mod wia;
pub(crate) use wia::WiaContainerHandler;

#[path = "handlers/tgc.rs"]
mod tgc;
pub(crate) use tgc::TgcContainerHandler;

#[path = "handlers/nfs.rs"]
mod nfs;
pub(crate) use nfs::NfsContainerHandler;

#[path = "handlers/wbfs.rs"]
mod wbfs;
pub(crate) use wbfs::WbfsContainerHandler;

#[path = "handlers/rvz.rs"]
mod rvz;
pub(crate) use rvz::RvzContainerHandler;

#[path = "handlers/z3ds.rs"]
mod z3ds;
pub(crate) use z3ds::Z3dsContainerHandler;

#[cfg(test)]
#[path = "../tests/unit/handlers.rs"]
mod handlers_tests;
