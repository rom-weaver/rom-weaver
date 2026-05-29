    /* jscpd:ignore-start */
    pub struct ChdContainerHandler;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct HdGeometry {
        cylinders: u32,
        heads: u32,
        sectors: u32,
        bytes_per_sector: u32,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct DiscLayout {
        kind: DiscKind,
        tracks: Vec<DiscTrack>,
    }

    impl DiscLayout {
        fn logical_bytes(&self) -> Result<u64> {
            self.tracks.iter().try_fold(0_u64, |total, track| {
                let track_bytes = u64::from(track.frames)
                    .checked_mul(u64::from(ChdContainerHandler::CD_FRAME_BYTES))
                    .ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "disc track {} is too large for current chd support",
                            track.number
                        ))
                    })?;
                total.checked_add(track_bytes).ok_or_else(|| {
                    RomWeaverError::Validation(
                        "disc logical size exceeded current chd limits".to_string(),
                    )
                })
            })
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct AvProfile {
        frame_bytes: u32,
        fps: u32,
        fpsfrac: u32,
        width: u32,
        height: u32,
        interlaced: u32,
        channels: u32,
        sample_rate: u32,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct DiscTrack {
        number: u32,
        mode: DiscTrackMode,
        file_path: PathBuf,
        file_offset_bytes: u64,
        frames: u32,
        pregap_frames: u32,
        postgap_frames: u32,
        pregap_has_data: bool,
        has_subcode: bool,
        pad_frames: u32,
        swap_audio_on_read: bool,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DiscKind {
        CdRom,
        GdRom,
    }

    impl DiscKind {
        fn metadata_tag(self) -> u32 {
            match self {
                Self::CdRom => CDROM_TRACK_METADATA2_TAG,
                Self::GdRom => GDROM_TRACK_METADATA_TAG,
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DiscTrackMode {
        Mode1,
        Mode1Raw,
        Mode2,
        Mode2Form1,
        Mode2Form2,
        Mode2FormMix,
        Mode2Raw,
        Audio,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FlacSampleByteOrder {
        LittleEndian,
        BigEndian,
    }

    struct DiscImageReader<'a> {
        tracks: &'a [DiscTrack],
        track_index: usize,
        track_initialized: bool,
        track_reader: Option<BufReader<File>>,
        track_data_frames_remaining: u32,
        track_pad_frames_remaining: u32,
        frame: Vec<u8>,
        frame_cursor: usize,
        frame_len: usize,
        data: Vec<u8>,
    }

    impl<'a> DiscImageReader<'a> {
        fn new(layout: &'a DiscLayout) -> Self {
            Self {
                tracks: &layout.tracks,
                track_index: 0,
                track_initialized: false,
                track_reader: None,
                track_data_frames_remaining: 0,
                track_pad_frames_remaining: 0,
                frame: vec![0_u8; ChdContainerHandler::CD_FRAME_BYTES as usize],
                frame_cursor: 0,
                frame_len: 0,
                data: Vec::new(),
            }
        }

        fn load_next_frame(&mut self) -> io::Result<bool> {
            loop {
                if self.track_index >= self.tracks.len() {
                    self.track_reader = None;
                    return Ok(false);
                }

                if !self.track_initialized {
                    let track = &self.tracks[self.track_index];
                    self.track_data_frames_remaining = track.frames.saturating_sub(track.pad_frames);
                    self.track_pad_frames_remaining = track.pad_frames;
                    self.track_initialized = true;
                }

                if self.track_data_frames_remaining == 0 && self.track_pad_frames_remaining == 0 {
                    self.track_index += 1;
                    self.track_initialized = false;
                    self.track_reader = None;
                    continue;
                }

                let track = &self.tracks[self.track_index];
                if self.track_data_frames_remaining > 0 {
                    if self.track_reader.is_none() {
                        let mut reader = BufReader::new(File::open(&track.file_path)?);
                        reader.seek(SeekFrom::Start(track.file_offset_bytes))?;
                        self.track_reader = Some(reader);
                    }
                    let data_len = track.mode.data_bytes();
                    if self.data.len() != data_len {
                        self.data.resize(data_len, 0);
                    }
                    self.track_reader
                        .as_mut()
                        .expect("track reader should be initialized")
                        .read_exact(&mut self.data)?;
                    if track.swap_audio_on_read {
                        track.mode.swap_audio_bytes(&mut self.data);
                    }
                    self.frame.fill(0);
                    self.frame[..data_len].copy_from_slice(&self.data);
                    self.frame_cursor = 0;
                    self.frame_len = self.frame.len();
                    self.track_data_frames_remaining -= 1;
                    if self.track_data_frames_remaining == 0 && self.track_pad_frames_remaining == 0
                    {
                        self.track_index += 1;
                        self.track_initialized = false;
                        self.track_reader = None;
                    }
                    return Ok(true);
                }

                self.frame.fill(0);
                self.frame_cursor = 0;
                self.frame_len = self.frame.len();
                self.track_pad_frames_remaining -= 1;
                if self.track_data_frames_remaining == 0 && self.track_pad_frames_remaining == 0 {
                    self.track_index += 1;
                    self.track_initialized = false;
                    self.track_reader = None;
                }
                return Ok(true);
            }
        }
    }

    impl Read for DiscImageReader<'_> {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            if output.is_empty() {
                return Ok(0);
            }

            let mut written = 0_usize;
            while written < output.len() {
                if self.frame_cursor >= self.frame_len && !self.load_next_frame()? {
                    break;
                }
                let available = self.frame_len.saturating_sub(self.frame_cursor);
                if available == 0 {
                    break;
                }
                let write_len = available.min(output.len() - written);
                output[written..written + write_len].copy_from_slice(
                    &self.frame[self.frame_cursor..self.frame_cursor + write_len],
                );
                self.frame_cursor += write_len;
                written += write_len;
            }
            Ok(written)
        }
    }

    impl DiscTrackMode {
        fn cue_label(self) -> &'static str {
            match self {
                Self::Mode1 => "MODE1/2048",
                Self::Mode1Raw => "MODE1/2352",
                Self::Mode2 => "MODE2/2336",
                Self::Mode2Form1 => "MODE2/2048",
                Self::Mode2Form2 => "MODE2/2324",
                Self::Mode2FormMix => "MODE2_FORM_MIX",
                Self::Mode2Raw => "MODE2/2352",
                Self::Audio => "AUDIO",
            }
        }

        fn metadata_label(self) -> &'static str {
            match self {
                Self::Mode1 => "MODE1",
                Self::Mode1Raw => "MODE1_RAW",
                Self::Mode2 => "MODE2",
                Self::Mode2Form1 => "MODE2_FORM1",
                Self::Mode2Form2 => "MODE2_FORM2",
                Self::Mode2FormMix => "MODE2_FORM_MIX",
                Self::Mode2Raw => "MODE2_RAW",
                Self::Audio => "AUDIO",
            }
        }

        fn pregap_metadata_label(self) -> &'static str {
            match self {
                Self::Mode1Raw => "MODE1",
                Self::Mode2Raw => "MODE2",
                _ => self.metadata_label(),
            }
        }

        fn data_bytes(self) -> usize {
            match self {
                Self::Mode1 | Self::Mode2Form1 => 2048,
                Self::Mode2 | Self::Mode2FormMix => 2336,
                Self::Mode2Form2 => 2324,
                Self::Mode1Raw | Self::Mode2Raw | Self::Audio => 2352,
            }
        }

        fn gdi_track_descriptor(self) -> Result<(u32, u32)> {
            match self {
                Self::Mode1Raw => Ok((4, 2352)),
                Self::Mode1 => Ok((4, 2048)),
                Self::Audio => Ok((0, 2352)),
                other => Err(RomWeaverError::Validation(format!(
                    "gd-rom output does not support {} tracks",
                    other.metadata_label()
                ))),
            }
        }

        fn swap_audio_bytes(self, buffer: &mut [u8]) {
            if !matches!(self, Self::Audio) {
                return;
            }
            for pair in buffer.chunks_exact_mut(2) {
                pair.swap(0, 1);
            }
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum ChdCreateKind {
        Raw,
        HardDisk(HdGeometry),
        Dvd,
        Disc(DiscLayout),
        Av(AvProfile),
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ChdCreateModeOverride {
        Cd,
        Dvd,
        Raw,
        HardDisk,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct ChdCompressionPlan {
        codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
        primary_codec: ChdCodec,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct RustCompressedHunkEntry {
        compression_type: u8,
        offset: u64,
        length: u32,
        crc16: u16,
    }

    #[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
    struct HunkHashKey {
        crc16: u16,
        sha1: [u8; 20],
    }

    struct ParentReuseIndex {
        by_hash: HashMap<HunkHashKey, u64>,
        sha1: [u8; 20],
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct RustMetadataEntry {
        tag: u32,
        flags: u8,
        data: Vec<u8>,
    }

    #[derive(Default)]
    struct MsbBitWriter {
        bytes: Vec<u8>,
        bit_len: usize,
    }

    impl MsbBitWriter {
        fn new() -> Self {
            Self::default()
        }

        fn write_bits(&mut self, value: u64, bit_count: u8) {
            if bit_count == 0 {
                return;
            }
            for shift in (0..bit_count).rev() {
                let bit = ((value >> shift) & 1) as u8;
                let byte_index = self.bit_len / 8;
                if byte_index == self.bytes.len() {
                    self.bytes.push(0);
                }
                let bit_index = 7 - (self.bit_len % 8);
                self.bytes[byte_index] |= bit << bit_index;
                self.bit_len += 1;
            }
        }

        fn align_to_byte(&mut self) {
            let remainder = self.bit_len % 8;
            if remainder == 0 {
                return;
            }
            self.write_bits(0, (8 - remainder) as u8);
        }

        fn finish(self) -> Vec<u8> {
            self.bytes
        }
    }

    const CDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'C', b'D');
    const CDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'T', b'R');
    const GDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'T');
    const AV_METADATA_TAG: u32 = make_tag(b'A', b'V', b'A', b'V');
    const AV_LD_METADATA_TAG: u32 = make_tag(b'A', b'V', b'L', b'D');

    enum ChdReadBackend {
        Rust {
            metadata_by_tag_and_index: BTreeMap<(u32, u32), Vec<u8>>,
        },
    }

    struct ChdReadSession {
        source: PathBuf,
        parent_source: Option<PathBuf>,
        header: ChdHeader,
        media_kind: ChdMediaKind,
        backend: ChdReadBackend,
    }

    impl ChdReadSession {
        fn open(source: &Path, parent_source: Option<&Path>) -> Result<Self> {
            Self::open_rust(source, parent_source).map_err(|rust_error| {
                RomWeaverError::Validation(format!(
                    "failed to open chd `{}` with rust backend ({rust_error})",
                    source.display()
                ))
            })
        }

        fn open_rust(
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
                metadata_by_tag_and_index
                    .insert((metadata.metatag, metadata.index), metadata.value);
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

        fn header(&self) -> ChdHeader {
            self.header
        }

        fn media_kind(&self) -> ChdMediaKind {
            self.media_kind
        }

        fn read_metadata(&self, tag: u32, index: u32) -> Result<Option<Vec<u8>>> {
            match &self.backend {
                ChdReadBackend::Rust {
                    metadata_by_tag_and_index,
                } => Ok(metadata_by_tag_and_index.get(&(tag, index)).cloned()),
            }
        }

        fn open_rust_chd(
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

        // Browser worker threads cannot open OPFS-backed files (only the main runner
        // thread holds the filesystem access handles), so the WASM parallel decode paths
        // read the compressed CHD bytes once on the calling thread and let each worker
        // decode from a shared in-memory copy. The shared `Arc<[u8]>` lives in the shared
        // linear memory, so there is a single copy regardless of thread count.
        #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
        fn read_source_bytes(source: &Path) -> std::result::Result<Arc<[u8]>, String> {
            std::fs::read(source)
                .map(|bytes| Arc::from(bytes.into_boxed_slice()))
                .map_err(|error| format!("failed to read `{}`: {error}", source.display()))
        }

        // The in-memory parallel decode path holds one shared copy of the compressed CHD in
        // linear memory. Browser shared memory is bounded, so for very large inputs fall back
        // to the single-thread streaming path (correct, just not parallel) instead of risking
        // an allocation failure.
        #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
        fn wasm_parallel_decode_source_too_large(source: &Path) -> bool {
            const MAX_SOURCE_BYTES: u64 = 1536 * 1024 * 1024;
            std::fs::metadata(source)
                .map(|metadata| metadata.len() > MAX_SOURCE_BYTES)
                .unwrap_or(false)
        }

        #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
        fn open_rust_chd_from_bytes(
            bytes: Arc<[u8]>,
            parent_bytes: Option<Arc<[u8]>>,
        ) -> std::result::Result<chd::Chd<std::io::Cursor<Arc<[u8]>>>, String> {
            let parent = match parent_bytes {
                Some(parent_bytes) => {
                    let parent_chd = chd::Chd::open(std::io::Cursor::new(parent_bytes), None)
                        .map_err(|error| format!("failed to parse parent chd from memory: {error}"))?;
                    Some(Box::new(parent_chd))
                }
                None => None,
            };
            chd::Chd::open(std::io::Cursor::new(bytes), parent)
                .map_err(|error| format!("failed to parse chd from memory: {error}"))
        }

        #[allow(dead_code)]
        fn extract_to_file_with_progress(
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

        fn stream_with_progress<F>(
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
            let mut remaining = logical_bytes;
            let mut hunk_buffer = chd.get_hunksized_buffer();
            let mut compressed_buffer = Vec::new();
            for hunk_index in 0..chd.header().hunk_count() {
                if remaining == 0 {
                    break;
                }
                let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                    format!(
                        "failed to decode hunk {} of `{}`: {error}",
                        hunk_index,
                        source.display()
                    )
                })?;
                hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                    .map_err(|error| {
                        format!(
                            "failed to read hunk {} of `{}`: {error}",
                            hunk_index,
                            source.display()
                        )
                    })?;
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
            #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
            let source_too_large = Self::wasm_parallel_decode_source_too_large(source);
            #[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
            let source_too_large = false;
            if effective_threads <= 1 || source_too_large {
                return Self::stream_with_rust(
                    source,
                    parent_source,
                    logical_bytes,
                    1,
                    on_progress,
                    on_bytes,
                );
            }

            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(effective_threads)
                .build()
                .map_err(|error| {
                    format!(
                        "failed to build CHD rust stream pool (threads={}): {error}",
                        effective_threads
                    )
                })?;

            let source = source.to_path_buf();
            let parent_source = parent_source.map(Path::to_path_buf);
            #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
            let source_bytes = Self::read_source_bytes(&source)?;
            #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
            let parent_bytes = match parent_source.as_deref() {
                Some(parent_source) => Some(Self::read_source_bytes(parent_source)?),
                None => None,
            };
            let hunk_indices: Vec<u32> = (0..hunk_count).collect();
            let hunk_bytes_usize = usize::try_from(hunk_bytes)
                .ok()
                .filter(|bytes| *bytes > 0)
                .unwrap_or(usize::MAX);
            let target_batch_hunks = (64 * 1024 * 1024_usize) / hunk_bytes_usize;
            let batch_hunks = target_batch_hunks
                .max(effective_threads.saturating_mul(16))
                .max(effective_threads);
            let mut remaining = logical_bytes;

            for batch in hunk_indices.chunks(batch_hunks) {
                if remaining == 0 {
                    break;
                }
                let chunk_size = batch.len().div_ceil(effective_threads).max(1);
                let chunk_results = pool.install(|| {
                    batch
                        .par_chunks(chunk_size)
                        .map(|chunk| {
                            #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
                            let mut chd = Self::open_rust_chd_from_bytes(
                                source_bytes.clone(),
                                parent_bytes.clone(),
                            )
                            .map_err(|error| {
                                format!("failed to decode `{}`: {error}", source.display())
                            })?;
                            #[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
                            let mut chd = Self::open_rust_chd(&source, parent_source.as_deref())
                                .map_err(|error| {
                                    format!("failed to decode `{}`: {error}", source.display())
                                })?;
                            let mut hunk_buffer = chd.get_hunksized_buffer();
                            let mut compressed_buffer = Vec::new();
                            let mut decoded = Vec::with_capacity(chunk.len());

                            for &hunk_index in chunk {
                                let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                                if offset >= logical_bytes {
                                    continue;
                                }
                                let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                                    format!(
                                        "failed to decode hunk {} of `{}`: {error}",
                                        hunk_index,
                                        source.display()
                                    )
                                })?;
                                hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                                    .map_err(|error| {
                                        format!(
                                            "failed to read hunk {} of `{}`: {error}",
                                            hunk_index,
                                            source.display()
                                        )
                                    })?;
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
                        .collect::<Vec<std::result::Result<Vec<(u32, Vec<u8>, u64)>, String>>>()
                });

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

        #[allow(dead_code)]
        fn extract_to_file_with_rust(
            source: &Path,
            parent_source: Option<&Path>,
            logical_bytes: u64,
            output_path: &Path,
            thread_count: usize,
            on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
        ) -> std::result::Result<(), String> {
            #[cfg(not(any(
                unix,
                windows,
                all(target_family = "wasm", rom_weaver_wasi_threads)
            )))]
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

            let mut output = File::create(output_path).map_err(|error| {
                format!("failed to create `{}`: {error}", output_path.display())
            })?;
            let mut remaining = logical_bytes;
            let mut hunk_buffer = chd.get_hunksized_buffer();
            let mut compressed_buffer = Vec::new();
            for hunk_index in 0..chd.header().hunk_count() {
                if remaining == 0 {
                    break;
                }
                let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                    format!(
                        "failed to decode hunk {} of `{}`: {error}",
                        hunk_index,
                        source.display()
                    )
                })?;
                hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                    .map_err(|error| {
                        format!(
                            "failed to read hunk {} of `{}`: {error}",
                            hunk_index,
                            source.display()
                        )
                    })?;
                let write_len = usize::try_from(remaining.min(hunk_buffer.len() as u64))
                    .map_err(|_| "decoded CHD chunk exceeded addressable memory".to_string())?;
                output
                    .write_all(&hunk_buffer[..write_len])
                    .map_err(|error| {
                        format!("failed to write `{}`: {error}", output_path.display())
                    })?;
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

            let mut output = File::create(output_path).map_err(|error| {
                format!("failed to create `{}`: {error}", output_path.display())
            })?;
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
            if effective_threads <= 1 || Self::wasm_parallel_decode_source_too_large(source) {
                return Self::extract_to_file_with_rust(
                    source,
                    parent_source,
                    logical_bytes,
                    output_path,
                    1,
                    on_progress,
                );
            }

            // Commit to the parallel path: load the compressed CHD once so worker threads can
            // decode from shared memory without opening the (OPFS-backed) file themselves.
            let source_bytes = Self::read_source_bytes(source)?;
            let parent_bytes = match parent_source {
                Some(parent_source) => Some(Self::read_source_bytes(parent_source)?),
                None => None,
            };

            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(effective_threads)
                .build()
                .map_err(|error| {
                    format!(
                        "failed to build CHD rust extraction pool (threads={}): {error}",
                        effective_threads
                    )
                })?;

            let source = source.to_path_buf();
            let on_progress = on_progress.cloned();
            let hunk_indices: Vec<u32> = (0..hunk_count).collect();
            let batch_hunks = effective_threads.saturating_mul(16).max(effective_threads);

            for batch in hunk_indices.chunks(batch_hunks) {
                let chunk_size = batch.len().div_ceil(effective_threads).max(1);
                let chunk_results = pool.install(|| {
                    batch
                        .par_chunks(chunk_size)
                        .map(|chunk| {
                            let mut chd = Self::open_rust_chd_from_bytes(
                                source_bytes.clone(),
                                parent_bytes.clone(),
                            )
                            .map_err(|error| {
                                format!("failed to decode `{}`: {error}", source.display())
                            })?;
                            let mut hunk_buffer = chd.get_hunksized_buffer();
                            let mut compressed_buffer = Vec::new();
                            let mut decoded = Vec::with_capacity(chunk.len());

                            for &hunk_index in chunk {
                                let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                                if offset >= logical_bytes {
                                    continue;
                                }
                                let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                                    format!(
                                        "failed to decode hunk {} of `{}`: {error}",
                                        hunk_index,
                                        source.display()
                                    )
                                })?;
                                hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                                    .map_err(|error| {
                                        format!(
                                            "failed to read hunk {} of `{}`: {error}",
                                            hunk_index,
                                            source.display()
                                        )
                                    })?;
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
                        .collect::<Vec<std::result::Result<Vec<(u32, Vec<u8>, u64)>, String>>>()
                });

                let mut decoded_batch = Vec::new();
                for result in chunk_results {
                    decoded_batch.extend(result?);
                }
                decoded_batch.sort_by_key(|(hunk_index, _, _)| *hunk_index);

                for (hunk_index, bytes, write_len) in decoded_batch {
                    let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                    output.seek(SeekFrom::Start(offset)).map_err(|error| {
                        format!(
                            "failed to seek `{}` to offset {}: {error}",
                            output_path.display(),
                            offset
                        )
                    })?;
                    output.write_all(&bytes).map_err(|error| {
                        format!(
                            "failed to write `{}` at offset {}: {error}",
                            output_path.display(),
                            offset
                        )
                    })?;
                    if let Some(on_progress) = on_progress.as_ref() {
                        on_progress(write_len);
                    }
                }
            }

            Ok(())
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

            let output = File::create(output_path).map_err(|error| {
                format!("failed to create `{}`: {error}", output_path.display())
            })?;
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

            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(effective_threads)
                .build()
                .map_err(|error| {
                    format!(
                        "failed to build CHD rust extraction pool (threads={}): {error}",
                        effective_threads
                    )
                })?;

            let source = source.to_path_buf();
            let parent_source = parent_source.map(Path::to_path_buf);
            let output = Arc::new(output);
            let on_progress = on_progress.cloned();
            let hunk_indices: Vec<u32> = (0..hunk_count).collect();
            let chunk_size = hunk_indices.len().div_ceil(effective_threads).max(1);

            let chunk_results = pool.install(|| {
                hunk_indices
                    .par_chunks(chunk_size)
                    .map(|chunk| {
                        let mut chd = Self::open_rust_chd(&source, parent_source.as_deref())
                            .map_err(|error| {
                                format!("failed to decode `{}`: {error}", source.display())
                            })?;

                        let mut hunk_buffer = chd.get_hunksized_buffer();
                        let mut compressed_buffer = Vec::new();

                        for &hunk_index in chunk {
                            let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                                format!(
                                    "failed to decode hunk {} of `{}`: {error}",
                                    hunk_index,
                                    source.display()
                                )
                            })?;
                            hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                                .map_err(|error| {
                                    format!(
                                        "failed to read hunk {} of `{}`: {error}",
                                        hunk_index,
                                        source.display()
                                    )
                                })?;

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
                    .collect::<Vec<std::result::Result<(), String>>>()
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

    fn split_token(text: &str) -> Option<(&str, &str)> {
        let trimmed = text.trim_start();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix('"') {
            let end = rest.find('"')?;
            let token = &rest[..end];
            let remainder = &rest[end + 1..];
            Some((token, remainder))
        } else {
            let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
            Some((&trimmed[..end], &trimmed[end..]))
        }
    }
    /* jscpd:ignore-end */
