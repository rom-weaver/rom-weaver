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
            let write_len =
                usize::try_from(logical_bytes.saturating_sub(offset).min(hunk_bytes))
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
                                (None, CompressionTypeV5::CompressionSelf) => Action::FollowSelf(
                                    entry.block_offset().map_err(|error| {
                                        format!(
                                            "failed to read CHD hunk {current} self ref: {error:?}"
                                        )
                                    })? as u32,
                                ),
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
                // Decode chunks on one-shot scoped threads. rayon keeps persistent work-stealing
                // workers whose sleep/wake latch deadlocks the node wasi-threads runtime (one Worker
                // per thread-spawn); `std::thread::scope` matches that model (spawn, run once, join)
                // and `JoinHandle::join` surfaces a worker panic instead of hanging.
                let chunk_results: Vec<std::result::Result<Vec<(u32, Vec<u8>, u64)>, String>> =
                    std::thread::scope(|scope| {
                        let handles: Vec<_> = jobs
                            .chunks(chunk_size)
                            .map(|chunk| {
                                scope.spawn(
                                    move || -> std::result::Result<Vec<(u32, Vec<u8>, u64)>, String> {
                                        let mut codecs: Option<chd::Codecs> = None;
                                        let mut hunk_buffer = vec![0u8; hunk_bytes_usize];
                                        let mut decoded = Vec::with_capacity(chunk.len());
                                        for (hunk_index, job) in chunk {
                                            match job {
                                                WasmHunkJob::Decode {
                                                    codec_index,
                                                    input,
                                                    crc,
                                                    write_len,
                                                } => {
                                                    if codecs.is_none() {
                                                        codecs = Some(
                                                            header_ref
                                                                .create_compression_codecs()
                                                                .map_err(|error| {
                                                                    format!("failed to build CHD codecs: {error:?}")
                                                                })?,
                                                        );
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
                                                    codec.decompress(input, &mut hunk_buffer).map_err(
                                                        |error| {
                                                            format!(
                                                                "failed to decompress hunk {hunk_index}: {error:?}"
                                                            )
                                                        },
                                                    )?;
                                                    if CHD_HUNK_CRC16.checksum(&hunk_buffer) != *crc {
                                                        return Err(format!(
                                                            "CHD hunk {hunk_index} failed CRC validation"
                                                        ));
                                                    }
                                                    decoded.push((
                                                        *hunk_index,
                                                        hunk_buffer[..*write_len].to_vec(),
                                                        *write_len as u64,
                                                    ));
                                                }
                                                WasmHunkJob::Ready { data, write_len } => {
                                                    decoded.push((
                                                        *hunk_index,
                                                        data.clone(),
                                                        *write_len as u64,
                                                    ));
                                                }
                                            }
                                        }
                                        Ok(decoded)
                                    },
                                )
                            })
                            .collect();
                        handles
                            .into_iter()
                            .map(|handle| {
                                handle.join().unwrap_or_else(|_| {
                                    Err("CHD decode worker thread panicked".to_string())
                                })
                            })
                            .collect()
                    });

                let mut decoded_batch = Vec::new();
                for result in chunk_results {
                    decoded_batch.extend(result?);
                }
                decoded_batch.sort_by_key(|(hunk_index, _, _)| *hunk_index);
                for (hunk_index, bytes, write_len) in decoded_batch {
                    write_hunk(hunk_index, &bytes, write_len)?;
                    if let Some(on_progress) = on_progress {
                        on_progress(write_len);
                    }
                }
            }

            Ok(())
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

            let source = source.to_path_buf();
            let parent_source = parent_source.map(Path::to_path_buf);

            // Threaded WASM uses the producer/consumer helper (workers cannot open the file) with its
            // own scoped threads — no rayon pool. Native builds a rayon pool and opens a reader per
            // worker, decoding the file directly.
            #[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
            let result = {
                let _ = hunk_bytes;
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
                let pool = build_chd_thread_pool("stream", effective_threads)?;
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
                                let mut chd =
                                    Self::open_rust_chd(&source, parent_source.as_deref())
                                        .map_err(|error| {
                                            format!(
                                                "failed to decode `{}`: {error}",
                                                source.display()
                                            )
                                        })?;
                                let mut hunk_buffer = chd.get_hunksized_buffer();
                                let mut compressed_buffer = Vec::new();
                                let mut decoded = Vec::with_capacity(chunk.len());

                                for &hunk_index in chunk {
                                    let offset =
                                        u64::from(hunk_index).saturating_mul(hunk_bytes);
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
                                        "decoded CHD chunk exceeded addressable memory"
                                            .to_string()
                                    })?;
                                    decoded.push((
                                        hunk_index,
                                        hunk_buffer[..write_len].to_vec(),
                                        write_len as u64,
                                    ));
                                }
                                Ok(decoded)
                            })
                            .collect::<Vec<std::result::Result<Vec<(u32, Vec<u8>, u64)>, String>>>(
                            )
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

            let pool = build_chd_thread_pool("extraction", effective_threads)?;

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
