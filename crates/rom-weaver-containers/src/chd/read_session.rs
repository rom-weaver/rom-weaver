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
            let parent_file_len = parent_file
                .metadata()
                .map_err(|error| {
                    format!(
                        "failed to read parent chd `{}` size: {error}",
                        parent_source.display()
                    )
                })?
                .len();
            let mut parent_reader = BufReader::new(parent_file);
            Self::validate_v5_map_allocation(&mut parent_reader, parent_source, parent_file_len)?;
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
        let file_len = file
            .metadata()
            .map_err(|error| format!("failed to read `{}` size: {error}", source.display()))?
            .len();
        let mut reader = BufReader::new(file);
        Self::validate_v5_map_allocation(&mut reader, source, file_len)?;
        chd::Chd::open(reader, parent)
            .map_err(|error| format!("failed to parse `{}`: {error}", source.display()))
    }

    pub(super) fn validate_v5_map_allocation<R: Read + Seek>(
        reader: &mut R,
        source: &Path,
        file_len: u64,
    ) -> std::result::Result<(), String> {
        const V5_HEADER_BYTES: usize = 124;
        const V5_COMPRESSED_MAP_HEADER_BYTES: u64 = 16;

        if file_len < V5_HEADER_BYTES as u64 {
            return Ok(());
        }

        let mut header = [0_u8; V5_HEADER_BYTES];
        reader
            .seek(SeekFrom::Start(0))
            .and_then(|_| reader.read_exact(&mut header))
            .map_err(|error| format!("failed to inspect `{}`: {error}", source.display()))?;
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("failed to inspect `{}`: {error}", source.display()))?;

        let read_u32 = |offset: usize| {
            u32::from_be_bytes([
                header[offset],
                header[offset + 1],
                header[offset + 2],
                header[offset + 3],
            ])
        };
        let read_u64 = |offset: usize| {
            u64::from_be_bytes([
                header[offset],
                header[offset + 1],
                header[offset + 2],
                header[offset + 3],
                header[offset + 4],
                header[offset + 5],
                header[offset + 6],
                header[offset + 7],
            ])
        };

        if header[..8] != CHD_SIGNATURE
            || read_u32(8) != V5_HEADER_BYTES as u32
            || read_u32(12) != 5
        {
            return Ok(());
        }

        let codec = read_u32(16);
        let logical_bytes = read_u64(32);
        let map_offset = read_u64(40);
        let hunk_bytes = read_u32(56);
        if hunk_bytes == 0 {
            return Ok(());
        }

        let hunk_count = logical_bytes
            .checked_add(u64::from(hunk_bytes) - 1)
            .ok_or_else(|| format!("CHD `{}` hunk count overflows", source.display()))?
            / u64::from(hunk_bytes);
        let map_entry_bytes = if codec == 0 { 4 } else { 12 };
        let expanded_map_bytes = hunk_count
            .checked_mul(map_entry_bytes)
            .ok_or_else(|| format!("CHD `{}` map size overflows", source.display()))?;
        u32::try_from(hunk_count)
            .map_err(|_| format!("CHD `{}` hunk count exceeds u32", source.display()))?;
        usize::try_from(expanded_map_bytes).map_err(|_| {
            format!(
                "CHD `{}` expanded map exceeds addressable memory",
                source.display()
            )
        })?;

        if codec == 0 {
            Self::validate_map_span(source, map_offset, expanded_map_bytes, file_len)?;
            return Ok(());
        }

        Self::validate_map_span(source, map_offset, V5_COMPRESSED_MAP_HEADER_BYTES, file_len)?;
        reader
            .seek(SeekFrom::Start(map_offset))
            .map_err(|error| format!("failed to inspect `{}` map: {error}", source.display()))?;
        let mut map_bytes = [0_u8; 4];
        reader
            .read_exact(&mut map_bytes)
            .map_err(|error| format!("failed to inspect `{}` map: {error}", source.display()))?;
        let map_bytes = u64::from(u32::from_be_bytes(map_bytes));
        let compressed_map_offset = map_offset
            .checked_add(V5_COMPRESSED_MAP_HEADER_BYTES)
            .ok_or_else(|| format!("CHD `{}` map span overflows", source.display()))?;
        Self::validate_map_span(source, compressed_map_offset, map_bytes, file_len)?;

        let encoded_bits = map_bytes
            .checked_mul(8)
            .ok_or_else(|| format!("CHD `{}` compressed map size overflows", source.display()))?;
        // Every valid Huffman lookup consumes at least one bit, and RleLarge expands one decoded
        // symbol to at most 274 entries; counting all payload bits keeps this bound conservative.
        const MAX_RLE_LARGE_ENTRIES: u64 = 274;
        let max_encodable_hunks = encoded_bits
            .checked_mul(MAX_RLE_LARGE_ENTRIES)
            .ok_or_else(|| format!("CHD `{}` map entry bound overflows", source.display()))?;
        if hunk_count > max_encodable_hunks {
            return Err(format!(
                "CHD `{}` declares {hunk_count} hunks, but its compressed map can encode at most {max_encodable_hunks}",
                source.display()
            ));
        }
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("failed to inspect `{}`: {error}", source.display()))?;
        Ok(())
    }

    fn validate_map_span(
        source: &Path,
        offset: u64,
        length: u64,
        file_len: u64,
    ) -> std::result::Result<(), String> {
        let end = offset
            .checked_add(length)
            .ok_or_else(|| format!("CHD `{}` map span overflows", source.display()))?;
        if end > file_len {
            return Err(format!(
                "CHD `{}` map span ends at byte {end}, past the {file_len}-byte file",
                source.display()
            ));
        }
        Ok(())
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

    /// Browser wasi-threads guard: pre-grow the heap once on the main thread to cover a full
    /// batch's concurrent working set (per-thread stacks + decoded output + in-flight compressed
    /// bytes), so the parallel decode reuses committed memory and performs no `memory.grow` while
    /// sibling threads run. dlmalloc only grows above the initial `memory.size`, so without this the
    /// first batch's allocations grow the heap mid-decode and V8 can race that into an OOB trap that
    /// wedges the join. No-op off wasm.
    #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
    fn pregrow_decode_heap(batch_hunks: usize, hunk_bytes_usize: usize, effective_threads: usize) {
        const STACK_RESERVE_PER_THREAD: usize = 4 * 1024 * 1024;
        const HEAP_RESERVE_MARGIN: usize = 32 * 1024 * 1024;
        const HEAP_RESERVE_MAX: usize = 768 * 1024 * 1024;
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
        // Touch the allocation so the grow cannot be elided, then drop it; wasm memory never
        // shrinks, so the committed pages stay in dlmalloc's free list for the decode threads.
        let mut heap_warm: Vec<u8> = Vec::with_capacity(reserve);
        heap_warm.push(0);
        std::hint::black_box(heap_warm.as_ptr());
        drop(heap_warm);
    }

    #[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
    fn pregrow_decode_heap(
        _batch_hunks: usize,
        _hunk_bytes_usize: usize,
        _effective_threads: usize,
    ) {
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

        // WASM workers use the OPFS proxy to open and read their own readers.
        // Native and browser use the same scoped-reader path.
        {
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
                "chd parallel decode scoped-reader batch sizing"
            );
            // Pre-grow the heap once before any worker spawns: on browser wasi-threads a
            // `memory.grow` while sibling decode threads run can race V8's bounds checks into an
            // OOB trap. No-op off wasm.
            Self::pregrow_decode_heap(batch_hunks, hunk_bytes_usize, effective_threads);
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
        }
    }
}
