use super::*;

enum ChdReadBackend {
    Rust {
        metadata_by_tag_and_index: BTreeMap<(u32, u32), Vec<u8>>,
    },
}

pub(super) struct ChdReadSession {
    source: PathBuf,
    parent_source: Option<PathBuf>,
    header: ChdHeader,
    media_kind: ChdMediaKind,
    backend: ChdReadBackend,
}

// CHD v5 stores a CRC-16/IBM-3740 (CCITT-FALSE) of each hunk's decompressed data; the threaded
// WASM decode workers verify it to match the `verify_block_crc` integrity check the single-thread
// path performs.
#[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
const CHD_HUNK_CRC16: crc::Crc<u16> = crc::Crc::<u16>::new(&crc::CRC_16_IBM_3740);

// Bound on copy-from-self chain following while resolving a hunk to a concrete source hunk.
#[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
const CHD_MAX_SELF_FOLLOW: usize = 64;

// One decode unit handed from the main thread to a worker in the threaded WASM decode path.
#[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
enum WasmHunkJob {
    // Heavy compressed hunk: decompress `input` with codec slot `codec_index`, verify `crc`.
    Decode {
        codec_index: usize,
        input: Vec<u8>,
        crc: u16,
        write_len: usize,
    },
    // Bytes already resolved on the main thread (uncompressed, parent-referenced, legacy, or
    // otherwise decoded inline): the worker passes them straight through.
    Ready {
        data: Vec<u8>,
        write_len: usize,
    },
}

#[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
struct WasmDecodedHunk {
    hunk_index: u32,
    data: Vec<u8>,
    write_len: u64,
}

impl ChdReadSession {
    pub(super) fn open(source: &Path, parent_source: Option<&Path>) -> Result<Self> {
        Self::open_rust(source, parent_source).map_err(|rust_error| {
            RomWeaverError::Validation(format!(
                "failed to open chd `{}` with rust backend ({rust_error})",
                source.display()
            ))
        })
    }

    pub(super) fn open_rust(
        source: &Path,
        parent_source: Option<&Path>,
    ) -> std::result::Result<Self, String> {
        let mut chd = Self::open_rust_chd(source, parent_source)?;

        let header = Self::convert_header(chd.header());
        let mut metadata_by_tag_and_index = BTreeMap::new();
        let metadatas: Vec<chd::metadata::Metadata> = chd
            .metadata_refs()
            .try_into()
            .map_err(|error| format!("failed to read CHD metadata: {error}"))?;
        for metadata in metadatas {
            metadata_by_tag_and_index.insert((metadata.metatag, metadata.index), metadata.value);
        }
        let media_kind = Self::detect_media_kind(&metadata_by_tag_and_index);

        Ok(Self {
            source: source.to_path_buf(),
            parent_source: parent_source.map(Path::to_path_buf),
            header,
            media_kind,
            backend: ChdReadBackend::Rust {
                metadata_by_tag_and_index,
            },
        })
    }

    fn detect_media_kind(
        metadata_by_tag_and_index: &BTreeMap<(u32, u32), Vec<u8>>,
    ) -> ChdMediaKind {
        let has_tag = |tag: u32| {
            metadata_by_tag_and_index
                .keys()
                .any(|(candidate, _)| *candidate == tag)
        };
        if has_tag(GDROM_TRACK_METADATA_TAG) || has_tag(GDROM_OLD_METADATA_TAG) {
            return ChdMediaKind::GdRom;
        }
        if has_tag(CDROM_TRACK_METADATA2_TAG)
            || has_tag(CDROM_TRACK_METADATA_TAG)
            || has_tag(CDROM_OLD_METADATA_TAG)
        {
            return ChdMediaKind::CdRom;
        }
        if has_tag(HARD_DISK_METADATA_TAG) {
            return ChdMediaKind::HardDisk;
        }
        if has_tag(DVD_METADATA_TAG) {
            return ChdMediaKind::Dvd;
        }
        if has_tag(AV_METADATA_TAG) || has_tag(AV_LD_METADATA_TAG) {
            return ChdMediaKind::Av;
        }
        ChdMediaKind::Raw
    }

    fn codec_from_raw(raw: u32) -> ChdCodec {
        match raw {
            0 => ChdCodec::NONE,
            1 | 2 => ChdCodec::ZLIB,
            value if value == ChdCodec::ZLIB.raw() => ChdCodec::ZLIB,
            value if value == ChdCodec::ZSTD.raw() => ChdCodec::ZSTD,
            value if value == ChdCodec::LZMA.raw() => ChdCodec::LZMA,
            value if value == ChdCodec::HUFFMAN.raw() => ChdCodec::HUFFMAN,
            value if value == ChdCodec::AVHUFF.raw() => ChdCodec::AVHUFF,
            value if value == ChdCodec::FLAC.raw() => ChdCodec::FLAC,
            value if value == ChdCodec::CD_ZLIB.raw() => ChdCodec::CD_ZLIB,
            value if value == ChdCodec::CD_ZSTD.raw() => ChdCodec::CD_ZSTD,
            value if value == ChdCodec::CD_LZMA.raw() => ChdCodec::CD_LZMA,
            value if value == ChdCodec::CD_FLAC.raw() => ChdCodec::CD_FLAC,
            _ => ChdCodec::NONE,
        }
    }

    fn convert_header(header: &chd::header::Header) -> ChdHeader {
        let compression = match header {
            chd::header::Header::V1Header(value) | chd::header::Header::V2Header(value) => {
                [value.compression, 0, 0, 0]
            }
            chd::header::Header::V3Header(value) => [value.compression, 0, 0, 0],
            chd::header::Header::V4Header(value) => [value.compression, 0, 0, 0],
            chd::header::Header::V5Header(value) => value.compression,
        };
        ChdHeader {
            version: header.version() as u32,
            logical_bytes: header.logical_bytes(),
            hunk_bytes: header.hunk_size(),
            hunk_count: header.hunk_count(),
            unit_bytes: header.unit_bytes(),
            unit_count: header.unit_count(),
            compressed: header.is_compressed(),
            compression: compression.map(Self::codec_from_raw),
            sha1: header.sha1(),
            raw_sha1: header.raw_sha1(),
        }
    }

    pub(super) fn header(&self) -> ChdHeader {
        self.header
    }

    pub(super) fn media_kind(&self) -> ChdMediaKind {
        self.media_kind
    }

    pub(super) fn read_metadata(&self, tag: u32, index: u32) -> Result<Option<Vec<u8>>> {
        match &self.backend {
            ChdReadBackend::Rust {
                metadata_by_tag_and_index,
            } => Ok(metadata_by_tag_and_index.get(&(tag, index)).cloned()),
        }
    }

    pub(super) fn open_rust_chd(
        source: &Path,
        parent_source: Option<&Path>,
    ) -> std::result::Result<chd::Chd<BufReader<File>>, String> {
        let parent = if let Some(parent_source) = parent_source {
            let parent_file = File::open(parent_source).map_err(|error| {
                format!(
                    "failed to open parent chd `{}`: {error}",
                    parent_source.display()
                )
            })?;
            let parent_reader = BufReader::new(parent_file);
            let parent_chd = chd::Chd::open(parent_reader, None).map_err(|error| {
                format!(
                    "failed to parse parent chd `{}`: {error}",
                    parent_source.display()
                )
            })?;
            Some(Box::new(parent_chd))
        } else {
            None
        };

        let file = File::open(source)
            .map_err(|error| format!("failed to open `{}`: {error}", source.display()))?;
        let reader = BufReader::new(file);
        chd::Chd::open(reader, parent)
            .map_err(|error| format!("failed to parse `{}`: {error}", source.display()))
    }

    // Browser worker threads cannot open OPFS-backed files (only the main runner thread holds
    // the filesystem access handles), so the threaded WASM decode paths use a producer/consumer
    // split: the main thread reads each hunk's compressed bytes from the file and worker threads
    // only run the CPU-bound decompression. Peak memory is bounded to the in-flight batch
    // instead of a whole-file copy, and there is no contiguous multi-GiB allocation (which
    // wasm32 caps at isize::MAX), so arbitrarily large CHDs decode in parallel.

    // Reads `len` bytes at `file_offset` from the CHD's underlying reader. Used by the main
    // thread to pull a hunk's raw compressed bytes without decompressing them.
    #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
    fn read_raw_block(
        chd: &mut chd::Chd<BufReader<File>>,
        file_offset: u64,
        len: usize,
        source: &Path,
    ) -> std::result::Result<Vec<u8>, String> {
        let reader = chd.inner();
        reader.seek(SeekFrom::Start(file_offset)).map_err(|error| {
            format!(
                "failed to seek `{}` to offset {file_offset}: {error}",
                source.display()
            )
        })?;
        let mut buffer = vec![0u8; len];
        reader.read_exact(&mut buffer).map_err(|error| {
            format!(
                "failed to read compressed hunk bytes from `{}`: {error}",
                source.display()
            )
        })?;
        Ok(buffer)
    }

    // Classifies hunk `hunk_index` into a `WasmHunkJob`, reading its compressed bytes on the main
    // thread. Copy-from-self chains are followed to the concrete source hunk so the worker can
    // decode independently; uncompressed/parent/legacy entries are resolved inline on the main
    // thread (which holds an open reader) and handed over as ready bytes. Returns `None` for
    // hunks that begin past `logical_bytes` (nothing to write).
    #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
    fn build_wasm_hunk_job(
        chd: &mut chd::Chd<BufReader<File>>,
        hunk_index: u32,
        hunk_bytes: u64,
        logical_bytes: u64,
        source: &Path,
    ) -> std::result::Result<Option<WasmHunkJob>, String> {
        use chd::map::{CompressionTypeV5, MapEntry};

        let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
        if offset >= logical_bytes {
            return Ok(None);
        }
        let write_len = usize::try_from(logical_bytes.saturating_sub(offset).min(hunk_bytes))
            .map_err(|_| "decoded CHD hunk exceeded addressable memory".to_string())?;

        enum Action {
            Decode {
                codec_index: usize,
                file_offset: u64,
                len: usize,
                crc: u16,
            },
            Raw {
                file_offset: u64,
                len: usize,
            },
            FollowSelf(u32),
            Inline,
        }

        let mut current = hunk_index;
        for _ in 0..CHD_MAX_SELF_FOLLOW {
            let action = {
                let entry = chd.map().get_entry(current as usize).ok_or_else(|| {
                    format!(
                        "CHD hunk {current} is out of range in `{}`",
                        source.display()
                    )
                })?;
                match entry {
                    MapEntry::V5Compressed(entry) => {
                        let comptype = entry.hunk_type().map_err(|error| {
                            format!("failed to read CHD hunk {current} type: {error:?}")
                        })?;
                        let codec_index = match comptype {
                            CompressionTypeV5::CompressionType0 => Some(0usize),
                            CompressionTypeV5::CompressionType1 => Some(1),
                            CompressionTypeV5::CompressionType2 => Some(2),
                            CompressionTypeV5::CompressionType3 => Some(3),
                            _ => None,
                        };
                        match (codec_index, comptype) {
                            (Some(codec_index), _) => Action::Decode {
                                codec_index,
                                file_offset: entry.block_offset().map_err(|error| {
                                    format!("failed to read CHD hunk {current} offset: {error:?}")
                                })?,
                                len: entry.block_size().map_err(|error| {
                                    format!("failed to read CHD hunk {current} size: {error:?}")
                                })? as usize,
                                crc: entry.hunk_crc().map_err(|error| {
                                    format!("failed to read CHD hunk {current} crc: {error:?}")
                                })?,
                            },
                            (None, CompressionTypeV5::CompressionNone) => Action::Raw {
                                file_offset: entry.block_offset().map_err(|error| {
                                    format!("failed to read CHD hunk {current} offset: {error:?}")
                                })?,
                                len: entry.block_size().map_err(|error| {
                                    format!("failed to read CHD hunk {current} size: {error:?}")
                                })? as usize,
                            },
                            (None, CompressionTypeV5::CompressionSelf) => {
                                Action::FollowSelf(entry.block_offset().map_err(|error| {
                                    format!("failed to read CHD hunk {current} self ref: {error:?}")
                                })? as u32)
                            }
                            _ => Action::Inline,
                        }
                    }
                    _ => Action::Inline,
                }
            };
            match action {
                Action::Decode {
                    codec_index,
                    file_offset,
                    len,
                    crc,
                } => {
                    let input = Self::read_raw_block(chd, file_offset, len, source)?;
                    return Ok(Some(WasmHunkJob::Decode {
                        codec_index,
                        input,
                        crc,
                        write_len,
                    }));
                }
                Action::Raw { file_offset, len } => {
                    let mut data = Self::read_raw_block(chd, file_offset, len, source)?;
                    data.truncate(write_len);
                    return Ok(Some(WasmHunkJob::Ready { data, write_len }));
                }
                Action::FollowSelf(source_hunk) => {
                    current = source_hunk;
                    continue;
                }
                Action::Inline => break,
            }
        }

        // Fallback (parent reference, legacy map, uncompressed v5 map, or an over-long self
        // chain): decode this hunk on the main thread, which already holds an open reader.
        let mut compressed_buffer = Vec::new();
        let mut hunk_buffer = chd.get_hunksized_buffer();
        let mut hunk = chd.hunk(hunk_index).map_err(|error| {
            format!(
                "failed to decode hunk {hunk_index} of `{}`: {error:?}",
                source.display()
            )
        })?;
        hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
            .map_err(|error| {
                format!(
                    "failed to read hunk {hunk_index} of `{}`: {error:?}",
                    source.display()
                )
            })?;
        hunk_buffer.truncate(write_len);
        Ok(Some(WasmHunkJob::Ready {
            data: hunk_buffer,
            write_len,
        }))
    }

    // Producer/consumer batched decode for the threaded WASM target. The main thread reads each
    // batch's compressed hunk bytes (workers cannot open the OPFS-backed file), worker threads
    // decompress in parallel, and decoded hunks are emitted in order via `write_hunk`.
    #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
    fn wasm_parallel_decode_hunks<W>(
        source: &Path,
        parent_source: Option<&Path>,
        logical_bytes: u64,
        effective_threads: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
        mut write_hunk: W,
    ) -> std::result::Result<(), String>
    where
        W: FnMut(u32, &[u8], u64) -> std::result::Result<(), String>,
    {
        let mut chd = Self::open_rust_chd(source, parent_source)
            .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;
        let header = chd.header().clone();
        let hunk_count = chd.header().hunk_count();
        let hunk_bytes = chd.header().hunk_size() as u64;
        let hunk_bytes_usize = usize::try_from(hunk_bytes)
            .ok()
            .filter(|bytes| *bytes > 0)
            .unwrap_or(usize::MAX);
        let target_batch_hunks = (64 * 1024 * 1024_usize) / hunk_bytes_usize;
        let batch_hunks = target_batch_hunks
            .max(effective_threads.saturating_mul(16))
            .max(effective_threads);
        debug!(
            hunk_count,
            hunk_bytes = hunk_bytes_usize,
            effective_threads,
            batch_hunks,
            "chd wasm parallel decode start"
        );

        // Browser wasi-threads guard against a V8 shared-memory growth race.
        //
        // V8 propagates a shared `memory.grow` to already-running thread instances without
        // synchronizing it against their in-flight bounds checks, so a `memory.grow` triggered
        // while sibling decode threads are running can make one of them read a stale (smaller)
        // size and trap with "memory access out of bounds"; the trapped thread never signals its
        // join and the main thread wedges forever. wasmtime uses guard-page bounds checks and is
        // immune, so the same module decodes fine natively.
        //
        // dlmalloc starts its heap at the initial `memory.size` and only ever grows above it, so
        // a large shared-memory maximum (or a larger initial size) does not help — every batch's
        // first allocations still call `memory.grow`. The observed pattern matches exactly: only
        // the first batch traps (its stacks/buffers grow the heap while threads run), while later
        // batches reuse the now-large freed heap and never grow. Make the first batch behave like
        // the later ones by growing the heap once here, on the main thread, to cover a full
        // batch's concurrent working set (per-thread stacks + the batch's decoded output). The
        // parallel decode below then reuses committed memory and performs no `memory.grow`.
        {
            const STACK_RESERVE_PER_THREAD: usize = 4 * 1024 * 1024;
            const HEAP_RESERVE_MARGIN: usize = 32 * 1024 * 1024;
            const HEAP_RESERVE_MAX: usize = 768 * 1024 * 1024;
            // During the parallel scope the live set is the batch's decoded output plus the
            // already-read compressed jobs (held until the batch finishes) plus the per-thread
            // stacks. Reserve ~2x the batch's logical size to cover decoded + compressed, plus
            // stacks and a margin for allocator overhead.
            let batch_bytes = batch_hunks.saturating_mul(hunk_bytes_usize);
            let reserve = batch_bytes
                .saturating_mul(2)
                .saturating_add(effective_threads.saturating_mul(STACK_RESERVE_PER_THREAD))
                .saturating_add(HEAP_RESERVE_MARGIN)
                .min(HEAP_RESERVE_MAX);
            trace!(
                reserve,
                batch_bytes,
                effective_threads,
                "chd wasm decode pregrow heap to avoid memory.grow race"
            );
            // Touch the allocation so the compiler cannot elide the grow, then drop it; wasm
            // memory never shrinks, so the committed pages stay in dlmalloc's free list for the
            // decode threads to reuse without growing.
            let mut heap_warm: Vec<u8> = Vec::with_capacity(reserve);
            heap_warm.push(0);
            std::hint::black_box(heap_warm.as_ptr());
            drop(heap_warm);
        }

        let hunk_indices: Vec<u32> = (0..hunk_count).collect();
        for batch in hunk_indices.chunks(batch_hunks) {
            // Read this batch's compressed bytes on the main thread (worker threads cannot open
            // the OPFS-backed file); the parallel decode below works only from these bytes.
            let mut jobs: Vec<(u32, WasmHunkJob)> = Vec::with_capacity(batch.len());
            for &hunk_index in batch {
                if let Some(job) = Self::build_wasm_hunk_job(
                    &mut chd,
                    hunk_index,
                    hunk_bytes,
                    logical_bytes,
                    source,
                )? {
                    jobs.push((hunk_index, job));
                }
            }
            if jobs.is_empty() {
                continue;
            }

            let chunk_size = jobs.len().div_ceil(effective_threads).max(1);
            let header_ref = &header;
            // Decode chunks on one-shot scoped threads. The node wasi-threads runtime maps one
            // Worker per thread-spawn, so `std::thread::scope` matches that model and
            // `JoinHandle::join` surfaces a worker panic instead of hanging.
            std::thread::scope(|scope| -> std::result::Result<(), String> {
                let (decoded_tx, decoded_rx) =
                    std::sync::mpsc::channel::<std::result::Result<WasmDecodedHunk, String>>();
                let handles: Vec<_> = jobs
                        .chunks(chunk_size)
                        .map(|chunk| {
                            let decoded_tx = decoded_tx.clone();
                            scope.spawn(move || -> std::result::Result<(), String> {
                                let mut codecs: Option<chd::Codecs> = None;
                                let mut hunk_buffer = vec![0u8; hunk_bytes_usize];
                                for (hunk_index, job) in chunk {
                                    let decoded = match job {
                                        WasmHunkJob::Decode {
                                            codec_index,
                                            input,
                                            crc,
                                            write_len,
                                        } => {
                                            if codecs.is_none() {
                                                codecs = Some(header_ref.create_compression_codecs().map_err(
                                                    |error| format!("failed to build CHD codecs: {error:?}"),
                                                )?);
                                            }
                                            let codec = codecs
                                                .as_mut()
                                                .expect("codecs initialized above")
                                                .get_mut(*codec_index)
                                                .ok_or_else(|| {
                                                    format!(
                                                        "CHD hunk {hunk_index} uses unconfigured codec slot {codec_index}"
                                                    )
                                                })?;
                                            codec.decompress(input, &mut hunk_buffer).map_err(|error| {
                                                format!("failed to decompress hunk {hunk_index}: {error:?}")
                                            })?;
                                            if CHD_HUNK_CRC16.checksum(&hunk_buffer) != *crc {
                                                return Err(format!("CHD hunk {hunk_index} failed CRC validation"));
                                            }
                                            WasmDecodedHunk {
                                                hunk_index: *hunk_index,
                                                data: hunk_buffer[..*write_len].to_vec(),
                                                write_len: *write_len as u64,
                                            }
                                        }
                                        WasmHunkJob::Ready { data, write_len } => WasmDecodedHunk {
                                            hunk_index: *hunk_index,
                                            data: data.clone(),
                                            write_len: *write_len as u64,
                                        },
                                    };
                                    if decoded_tx.send(Ok(decoded)).is_err() {
                                        return Ok(());
                                    }
                                }
                                Ok(())
                            })
                        })
                        .collect();
                drop(decoded_tx);

                let mut first_error: Option<String> = None;
                let mut pending = BTreeMap::<u32, WasmDecodedHunk>::new();
                let mut next_hunk_index =
                    jobs.first().map(|(hunk_index, _)| *hunk_index).unwrap_or(0);
                let mut written_hunks = 0usize;

                for result in decoded_rx {
                    match result {
                        Ok(decoded) => {
                            pending.insert(decoded.hunk_index, decoded);
                            while let Some(decoded) = pending.remove(&next_hunk_index) {
                                write_hunk(decoded.hunk_index, &decoded.data, decoded.write_len)?;
                                if let Some(on_progress) = on_progress {
                                    on_progress(decoded.write_len);
                                }
                                written_hunks = written_hunks.saturating_add(1);
                                next_hunk_index = next_hunk_index.saturating_add(1);
                            }
                        }
                        Err(error) => {
                            if first_error.is_none() {
                                first_error = Some(error);
                            }
                        }
                    }
                }

                for handle in handles {
                    handle
                        .join()
                        .unwrap_or_else(|_| Err("CHD decode worker thread panicked".to_string()))?;
                }
                if let Some(error) = first_error {
                    return Err(error);
                }
                if written_hunks != jobs.len() || !pending.is_empty() {
                    return Err("CHD decode workers did not produce every hunk".to_string());
                }
                Ok(())
            })?;
        }

        Ok(())
    }

    #[allow(dead_code)]
    pub(super) fn extract_to_file_with_progress(
        &self,
        output_path: &Path,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
    ) -> Result<ChdHeader> {
        match &self.backend {
            ChdReadBackend::Rust { .. } => Self::extract_to_file_with_rust(
                &self.source,
                self.parent_source.as_deref(),
                self.header.logical_bytes,
                output_path,
                thread_count,
                on_progress,
            )
            .map_err(RomWeaverError::Validation)
            .map(|_| self.header),
        }
    }

    pub(super) fn stream_with_progress<F>(
        &self,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
        mut on_bytes: F,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) -> Result<()>,
    {
        match &self.backend {
            ChdReadBackend::Rust { .. } => Self::stream_with_rust(
                &self.source,
                self.parent_source.as_deref(),
                self.header.logical_bytes,
                thread_count,
                on_progress,
                &mut on_bytes,
            )
            .map_err(RomWeaverError::Validation),
        }
    }

    /// Decode a single hunk into `hunk_buffer` (with `compressed_buffer` as scratch), using the
    /// uniform "failed to decode/read hunk N of `path`" wording shared by every Rust decode path.
    fn decode_hunk_into(
        chd: &mut chd::Chd<BufReader<File>>,
        hunk_index: u32,
        source: &Path,
        compressed_buffer: &mut Vec<u8>,
        hunk_buffer: &mut [u8],
    ) -> std::result::Result<(), String> {
        let mut hunk = chd.hunk(hunk_index).map_err(|error| {
            format!(
                "failed to decode hunk {} of `{}`: {error}",
                hunk_index,
                source.display()
            )
        })?;
        hunk.read_hunk_in(compressed_buffer, hunk_buffer)
            .map_err(|error| {
                format!(
                    "failed to read hunk {} of `{}`: {error}",
                    hunk_index,
                    source.display()
                )
            })?;
        Ok(())
    }

    fn stream_with_rust<F>(
        source: &Path,
        parent_source: Option<&Path>,
        logical_bytes: u64,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
        on_bytes: &mut F,
    ) -> std::result::Result<(), String>
    where
        F: FnMut(&[u8]) -> Result<()>,
    {
        if thread_count > 1 {
            return Self::stream_with_rust_parallel_ordered(
                source,
                parent_source,
                logical_bytes,
                thread_count,
                on_progress,
                on_bytes,
            );
        }

        let mut chd = Self::open_rust_chd(source, parent_source)
            .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;
        debug!(
            hunk_count = chd.header().hunk_count(),
            logical_bytes, "chd single-thread decode start"
        );
        let mut remaining = logical_bytes;
        let mut hunk_buffer = chd.get_hunksized_buffer();
        let mut compressed_buffer = Vec::new();
        for hunk_index in 0..chd.header().hunk_count() {
            if remaining == 0 {
                break;
            }
            Self::decode_hunk_into(
                &mut chd,
                hunk_index,
                source,
                &mut compressed_buffer,
                &mut hunk_buffer,
            )?;
            let write_len = usize::try_from(remaining.min(hunk_buffer.len() as u64))
                .map_err(|_| "decoded CHD chunk exceeded addressable memory".to_string())?;
            on_bytes(&hunk_buffer[..write_len]).map_err(|error| match error {
                RomWeaverError::Validation(message) => message,
                other => other.to_string(),
            })?;
            remaining -= write_len as u64;
            if let Some(on_progress) = on_progress {
                on_progress(write_len as u64);
            }
        }
        Ok(())
    }

    fn stream_with_rust_parallel_ordered<F>(
        source: &Path,
        parent_source: Option<&Path>,
        logical_bytes: u64,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
        on_bytes: &mut F,
    ) -> std::result::Result<(), String>
    where
        F: FnMut(&[u8]) -> Result<()>,
    {
        let chd = Self::open_rust_chd(source, parent_source)
            .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;
        let hunk_count = chd.header().hunk_count();
        let hunk_bytes = chd.header().hunk_size() as u64;
        drop(chd);

        let hunk_count_usize = usize::try_from(hunk_count)
            .map_err(|_| "CHD hunk count exceeded addressable memory".to_string())?;
        if hunk_count_usize == 0 {
            return Ok(());
        }
        let effective_threads = thread_count.max(1).min(hunk_count_usize);
        if effective_threads <= 1 {
            return Self::stream_with_rust(
                source,
                parent_source,
                logical_bytes,
                1,
                on_progress,
                on_bytes,
            );
        }

        debug!(
            hunk_count,
            hunk_bytes,
            requested_threads = thread_count,
            effective_threads,
            logical_bytes,
            "chd parallel decode start"
        );

        let source = source.to_path_buf();
        let parent_source = parent_source.map(Path::to_path_buf);

        // Threaded WASM uses the producer/consumer helper because workers cannot open the OPFS
        // file. Native opens one reader per scoped worker and decodes directly.
        #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
        let result = {
            let _ = hunk_bytes;
            trace!(
                effective_threads,
                "chd parallel decode using wasm read-on-main producer/consumer path"
            );
            Self::wasm_parallel_decode_hunks(
                &source,
                parent_source.as_deref(),
                logical_bytes,
                effective_threads,
                on_progress,
                |_hunk_index, bytes, _write_len| {
                    on_bytes(bytes).map_err(|error| match error {
                        RomWeaverError::Validation(message) => message,
                        other => other.to_string(),
                    })
                },
            )
        };

        #[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
        let result = {
            let hunk_indices: Vec<u32> = (0..hunk_count).collect();
            let hunk_bytes_usize = usize::try_from(hunk_bytes)
                .ok()
                .filter(|bytes| *bytes > 0)
                .unwrap_or(usize::MAX);
            let target_batch_hunks = (64 * 1024 * 1024_usize) / hunk_bytes_usize;
            let batch_hunks = target_batch_hunks
                .max(effective_threads.saturating_mul(16))
                .max(effective_threads);
            trace!(
                batch_hunks,
                target_batch_hunks,
                effective_threads,
                "chd parallel decode native scoped-reader batch sizing"
            );
            let mut remaining = logical_bytes;

            for batch in hunk_indices.chunks(batch_hunks) {
                if remaining == 0 {
                    break;
                }
                let chunk_size = batch.len().div_ceil(effective_threads).max(1);
                let source_path = source.as_path();
                let parent_source_path = parent_source.as_deref();
                let chunk_results = std::thread::scope(|scope| {
                    let handles = batch
                        .chunks(chunk_size)
                        .map(|chunk| {
                            scope.spawn(move || {
                                let mut chd = Self::open_rust_chd(source_path, parent_source_path)
                                    .map_err(|error| {
                                        format!(
                                            "failed to decode `{}`: {error}",
                                            source_path.display()
                                        )
                                    })?;
                                let mut hunk_buffer = chd.get_hunksized_buffer();
                                let mut compressed_buffer = Vec::new();
                                let mut decoded = Vec::with_capacity(chunk.len());

                                for &hunk_index in chunk {
                                    let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                                    if offset >= logical_bytes {
                                        continue;
                                    }
                                    Self::decode_hunk_into(
                                        &mut chd,
                                        hunk_index,
                                        source_path,
                                        &mut compressed_buffer,
                                        &mut hunk_buffer,
                                    )?;
                                    let write_len = usize::try_from(
                                        logical_bytes
                                            .saturating_sub(offset)
                                            .min(hunk_buffer.len() as u64),
                                    )
                                    .map_err(|_| {
                                        "decoded CHD chunk exceeded addressable memory".to_string()
                                    })?;
                                    decoded.push((
                                        hunk_index,
                                        hunk_buffer[..write_len].to_vec(),
                                        write_len as u64,
                                    ));
                                }
                                Ok(decoded)
                            })
                        })
                        .collect::<Vec<_>>();

                    let mut results = Vec::with_capacity(handles.len());
                    for handle in handles {
                        results.push(handle.join().unwrap_or_else(|_| {
                            Err("CHD stream worker thread panicked".to_string())
                        }));
                    }
                    Ok::<_, String>(results)
                })?;

                let mut decoded_batch = Vec::new();
                for result in chunk_results {
                    decoded_batch.extend(result?);
                }
                decoded_batch.sort_by_key(|(hunk_index, _, _)| *hunk_index);

                for (_, bytes, write_len) in decoded_batch {
                    on_bytes(&bytes).map_err(|error| match error {
                        RomWeaverError::Validation(message) => message,
                        other => other.to_string(),
                    })?;
                    remaining = remaining.saturating_sub(write_len);
                    if let Some(on_progress) = on_progress {
                        on_progress(write_len);
                    }
                    if remaining == 0 {
                        break;
                    }
                }
            }

            Ok(())
        };

        result
    }

    #[allow(dead_code)]
    fn extract_to_file_with_rust(
        source: &Path,
        parent_source: Option<&Path>,
        logical_bytes: u64,
        output_path: &Path,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
    ) -> std::result::Result<(), String> {
        #[cfg(not(any(unix, windows, all(target_family = "wasm", rom_weaver_wasi_threads))))]
        let _ = thread_count;

        #[cfg(any(unix, windows))]
        if thread_count > 1 {
            return Self::extract_to_file_with_rust_parallel(
                source,
                parent_source,
                logical_bytes,
                output_path,
                thread_count,
                on_progress,
            );
        }

        #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
        if thread_count > 1 {
            return Self::extract_to_file_with_rust_parallel_portable(
                source,
                parent_source,
                logical_bytes,
                output_path,
                thread_count,
                on_progress,
            );
        }

        let mut chd = Self::open_rust_chd(source, parent_source)
            .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;

        let mut output = File::create(output_path)
            .map_err(|error| format!("failed to create `{}`: {error}", output_path.display()))?;
        let mut remaining = logical_bytes;
        let mut hunk_buffer = chd.get_hunksized_buffer();
        let mut compressed_buffer = Vec::new();
        for hunk_index in 0..chd.header().hunk_count() {
            if remaining == 0 {
                break;
            }
            Self::decode_hunk_into(
                &mut chd,
                hunk_index,
                source,
                &mut compressed_buffer,
                &mut hunk_buffer,
            )?;
            let write_len = usize::try_from(remaining.min(hunk_buffer.len() as u64))
                .map_err(|_| "decoded CHD chunk exceeded addressable memory".to_string())?;
            output
                .write_all(&hunk_buffer[..write_len])
                .map_err(|error| format!("failed to write `{}`: {error}", output_path.display()))?;
            remaining -= write_len as u64;
            if let Some(on_progress) = on_progress {
                on_progress(write_len as u64);
            }
        }

        Ok(())
    }

    #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
    #[allow(dead_code)]
    fn extract_to_file_with_rust_parallel_portable(
        source: &Path,
        parent_source: Option<&Path>,
        logical_bytes: u64,
        output_path: &Path,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
    ) -> std::result::Result<(), String> {
        // Read the header cheaply from the file on the calling (main) thread; the full
        // in-memory copy is only loaded below once we commit to the parallel path.
        let chd = Self::open_rust_chd(source, parent_source)
            .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;
        let hunk_count = chd.header().hunk_count();
        let hunk_bytes = chd.header().hunk_size() as u64;
        drop(chd);

        let mut output = File::create(output_path)
            .map_err(|error| format!("failed to create `{}`: {error}", output_path.display()))?;
        output.set_len(logical_bytes).map_err(|error| {
            format!(
                "failed to size `{}` to {} bytes: {error}",
                output_path.display(),
                logical_bytes
            )
        })?;

        let hunk_count_usize = usize::try_from(hunk_count)
            .map_err(|_| "CHD hunk count exceeded addressable memory".to_string())?;
        if hunk_count_usize == 0 {
            return Ok(());
        }
        let effective_threads = thread_count.max(1).min(hunk_count_usize);
        if effective_threads <= 1 {
            return Self::extract_to_file_with_rust(
                source,
                parent_source,
                logical_bytes,
                output_path,
                1,
                on_progress,
            );
        }

        // The producer/consumer helper reads each hunk's compressed bytes on the main thread and
        // decodes them on its own scoped worker threads (which cannot open the OPFS-backed file).
        // Decoded hunks arrive in order; write each to its logical offset in the pre-sized output.
        Self::wasm_parallel_decode_hunks(
            source,
            parent_source,
            logical_bytes,
            effective_threads,
            on_progress,
            |hunk_index, bytes, _write_len| {
                let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                output.seek(SeekFrom::Start(offset)).map_err(|error| {
                    format!(
                        "failed to seek `{}` to offset {}: {error}",
                        output_path.display(),
                        offset
                    )
                })?;
                output.write_all(bytes).map_err(|error| {
                    format!(
                        "failed to write `{}` at offset {}: {error}",
                        output_path.display(),
                        offset
                    )
                })?;
                Ok(())
            },
        )
    }

    #[cfg(any(unix, windows))]
    fn extract_to_file_with_rust_parallel(
        source: &Path,
        parent_source: Option<&Path>,
        logical_bytes: u64,
        output_path: &Path,
        thread_count: usize,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
    ) -> std::result::Result<(), String> {
        let chd = Self::open_rust_chd(source, parent_source)
            .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;
        let hunk_count = chd.header().hunk_count();
        let hunk_bytes = chd.header().hunk_size() as u64;
        drop(chd);

        let output = File::create(output_path)
            .map_err(|error| format!("failed to create `{}`: {error}", output_path.display()))?;
        output.set_len(logical_bytes).map_err(|error| {
            format!(
                "failed to size `{}` to {} bytes: {error}",
                output_path.display(),
                logical_bytes
            )
        })?;

        let hunk_count_usize = usize::try_from(hunk_count)
            .map_err(|_| "CHD hunk count exceeded addressable memory".to_string())?;
        if hunk_count_usize == 0 {
            return Ok(());
        }
        let effective_threads = thread_count.max(1).min(hunk_count_usize);
        if effective_threads <= 1 {
            return Self::extract_to_file_with_rust(
                source,
                parent_source,
                logical_bytes,
                output_path,
                1,
                on_progress,
            );
        }

        let source = source.to_path_buf();
        let parent_source = parent_source.map(Path::to_path_buf);
        let output = Arc::new(output);
        let on_progress = on_progress.cloned();
        let hunk_indices: Vec<u32> = (0..hunk_count).collect();
        let chunk_size = hunk_indices.len().div_ceil(effective_threads).max(1);

        let source_path = source.as_path();
        let parent_source_path = parent_source.as_deref();
        let chunk_results = std::thread::scope(|scope| {
            let handles = hunk_indices
                .chunks(chunk_size)
                .map(|chunk| {
                    let output = Arc::clone(&output);
                    let on_progress = on_progress.clone();
                    scope.spawn(move || {
                        let mut chd = Self::open_rust_chd(source_path, parent_source_path)
                            .map_err(|error| {
                                format!("failed to decode `{}`: {error}", source_path.display())
                            })?;

                        let mut hunk_buffer = chd.get_hunksized_buffer();
                        let mut compressed_buffer = Vec::new();

                        for &hunk_index in chunk {
                            Self::decode_hunk_into(
                                &mut chd,
                                hunk_index,
                                source_path,
                                &mut compressed_buffer,
                                &mut hunk_buffer,
                            )?;

                            let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                            if offset >= logical_bytes {
                                continue;
                            }
                            let write_len = usize::try_from(
                                logical_bytes
                                    .saturating_sub(offset)
                                    .min(hunk_buffer.len() as u64),
                            )
                            .map_err(|_| {
                                "decoded CHD chunk exceeded addressable memory".to_string()
                            })?;
                            Self::write_all_at(&output, &hunk_buffer[..write_len], offset)
                                .map_err(|error| {
                                    format!(
                                        "failed to write `{}` at offset {}: {error}",
                                        output_path.display(),
                                        offset
                                    )
                                })?;
                            if let Some(on_progress) = on_progress.as_ref() {
                                on_progress(write_len as u64);
                            }
                        }
                        Ok(())
                    })
                })
                .collect::<Vec<_>>();

            let mut results = Vec::with_capacity(handles.len());
            for handle in handles {
                results.push(
                    handle
                        .join()
                        .unwrap_or_else(|_| Err("CHD extract worker thread panicked".to_string())),
                );
            }
            results
        });

        for result in chunk_results {
            result?;
        }
        Ok(())
    }

    #[cfg(unix)]
    fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
        use std::os::unix::fs::FileExt as _;

        while !bytes.is_empty() {
            let written = file.write_at(bytes, offset)?;
            if written == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "failed to write CHD chunk",
                ));
            }
            offset = offset.saturating_add(written as u64);
            bytes = &bytes[written..];
        }
        Ok(())
    }

    #[cfg(all(not(unix), windows))]
    fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
        use std::os::windows::fs::FileExt as _;

        while !bytes.is_empty() {
            let written = file.seek_write(bytes, offset)?;
            if written == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "failed to write CHD chunk",
                ));
            }
            offset = offset.saturating_add(written as u64);
            bytes = &bytes[written..];
        }
        Ok(())
    }
}
