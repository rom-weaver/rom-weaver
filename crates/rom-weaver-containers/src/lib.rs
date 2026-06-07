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
mod constants;
mod extract_support;
mod formats;
mod libarchive_support;

use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
use nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
    write::{
        DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
        ProcessOptions as NodProcessOptions,
    },
};
#[cfg(test)]
use rom_weaver_chd::ChdCodec;
#[cfg(test)]
use rom_weaver_chd::ChdContainerHandler;
use rom_weaver_checksum::StreamingChecksum;
use rom_weaver_codecs::{
    CanonicalCodec, RequestedCodec, decode_deflate_into_buffer, normalize_codec_label,
    parse_requested_codec,
};
use rom_weaver_core::{
    ContainerByteProgress, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandlerOperations, ContainerListEntry, ContainerProbeRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, OrderedChunkWriter,
    OrderedStreamingMessages, ProbeConfidence, Result, RomWeaverError, SelectionMatcher,
    ThreadCapability, ThreadExecution, bounded_items_for_threads, create_extract_output_file,
    emit_container_running_progress, file_starts_with, maybe_emit_container_byte_progress,
    ordered_streaming_compress,
};
use rom_weaver_libarchive::{
    ReadFilter as LibarchiveReadFilter, RegularArchiveProbeFormat as LibarchiveProbeFormat,
    WriteFilter as LibarchiveCreateFilter, WriteFormat as LibarchiveCreateFormat,
};
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper, write::fs::XDVDFSFilesystem as XdvdfsFilesystem,
};
use zeekstd::{DecodeOptions as ZeekstdDecodeOptions, SeekTable as ZeekstdSeekTable};
use zstd::bulk::Compressor as ZstdCompressor;

use archive_entries::{ArchiveInputEntry, collect_archive_inputs};
use constants::{
    LIBARCHIVE_CREATE_IO_BUFFER_BYTES, LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES,
    LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES, Z3DS_DECODE_BUFFER_BYTES, Z3DS_DEFAULT_COMPRESSION_LEVEL,
    Z3DS_DEFAULT_FRAME_SIZE_BYTES, Z3DS_EXTRACT_MAX_CHUNK_BYTES, Z3DS_EXTRACT_TASKS_PER_THREAD,
    Z3DS_MAX_COMPRESSION_LEVEL, Z3DS_MIN_COMPRESSION_LEVEL, copy_progress_buffer_size,
};
use extract_support::{
    ContainerProgressContext, ExtractedFileChecksum, attach_extract_checksum_details,
    copy_reader_with_progress, create_extract_checksum, emit_container_indeterminate_progress,
    emit_container_step_progress, write_decoded_chunks_from_workers,
};
#[cfg(test)]
use formats::SEVEN_Z;
pub use formats::{CompressFormatRecommendation, ContainerRegistry};
use formats::{GCZ, NFS, PBP, RVZ, TGC, WBFS, WIA, XISO, Z3DS};
use libarchive_support::{
    LibarchiveCreateConfig, extract_regular_archive_with_libarchive, libarchive_close_read_stream,
    libarchive_open_read_stream, list_regular_archive_entries_with_libarchive,
    list_regular_archive_entry_records_with_libarchive,
    probe_regular_archive_details_with_libarchive, probe_regular_archive_with_libarchive,
    probe_stream_with_libarchive, write_archive_with_libarchive,
};

const GZIP_SIGNATURE: [u8; 2] = [0x1F, 0x8B];
const BZIP2_SIGNATURE: [u8; 3] = [b'B', b'Z', b'h'];
const XZ_SIGNATURE: [u8; 6] = [0xFD, b'7', b'z', b'X', b'Z', 0x00];
const ZSTD_SIGNATURE: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const CSO_SIGNATURE: [u8; 4] = [b'C', b'I', b'S', b'O'];
const PBP_SIGNATURE: [u8; 4] = [0x00, b'P', b'B', b'P'];

include!("handlers/zip.rs");

include!("handlers/tar.rs");

include!("handlers/stream.rs");

include!("handlers/cso.rs");

include!("handlers/sevenz.rs");

include!("handlers/rar.rs");

include!("handlers/pbp.rs");

include!("handlers/xiso.rs");

include!("handlers/nod_shared.rs");

include!("handlers/gcz.rs");

include!("handlers/wia.rs");

include!("handlers/tgc.rs");

include!("handlers/nfs.rs");

include!("handlers/wbfs.rs");

include!("handlers/rvz.rs");

include!("handlers/z3ds.rs");

include!("../tests/unit/handlers.rs");
