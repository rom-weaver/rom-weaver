use super::*;
use tracing::{debug, trace};

pub(crate) struct Z3dsContainerHandler;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Z3dsFileHeader {
    underlying_magic: [u8; 4],
    metadata_size: u32,
    compressed_size: u64,
    uncompressed_size: u64,
}

impl Z3dsFileHeader {
    const MAGIC: [u8; 4] = *b"Z3DS";
    const VERSION: u16 = 1;
    const HEADER_SIZE: u16 = 0x20;

    fn read_from(source: &Path, file: &mut File) -> Result<Self> {
        let mut raw = [0_u8; Self::HEADER_SIZE as usize];
        file.seek(SeekFrom::Start(0))?;
        if let Err(error) = file.read_exact(&mut raw) {
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Err(RomWeaverError::Validation(format!(
                    "source `{}` is too small to be a z3ds container",
                    source.display()
                )))
            } else {
                Err(error.into())
            };
        }

        if raw[..4] != Self::MAGIC {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` is not a z3ds container (missing Z3DS magic)",
                source.display()
            )));
        }

        let version = u16::from_le_bytes([raw[8], raw[9]]);
        if version != Self::VERSION {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` uses unsupported z3ds version {}; expected {}",
                source.display(),
                version,
                Self::VERSION
            )));
        }

        let header_size = u16::from_le_bytes([raw[10], raw[11]]);
        if header_size != Self::HEADER_SIZE {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has unsupported z3ds header size {}; expected {}",
                source.display(),
                header_size,
                Self::HEADER_SIZE
            )));
        }

        Ok(Self {
            underlying_magic: [raw[4], raw[5], raw[6], raw[7]],
            metadata_size: u32::from_le_bytes([raw[12], raw[13], raw[14], raw[15]]),
            compressed_size: u64::from_le_bytes([
                raw[16], raw[17], raw[18], raw[19], raw[20], raw[21], raw[22], raw[23],
            ]),
            uncompressed_size: u64::from_le_bytes([
                raw[24], raw[25], raw[26], raw[27], raw[28], raw[29], raw[30], raw[31],
            ]),
        })
    }

    fn write_to(self, file: &mut File) -> Result<()> {
        let mut raw = [0_u8; Self::HEADER_SIZE as usize];
        raw[..4].copy_from_slice(&Self::MAGIC);
        raw[4..8].copy_from_slice(&self.underlying_magic);
        raw[8..10].copy_from_slice(&Self::VERSION.to_le_bytes());
        raw[10..12].copy_from_slice(&Self::HEADER_SIZE.to_le_bytes());
        raw[12..16].copy_from_slice(&self.metadata_size.to_le_bytes());
        raw[16..24].copy_from_slice(&self.compressed_size.to_le_bytes());
        raw[24..32].copy_from_slice(&self.uncompressed_size.to_le_bytes());
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&raw)?;
        Ok(())
    }

    fn payload_offset(self) -> u64 {
        u64::from(Self::HEADER_SIZE) + u64::from(self.metadata_size)
    }
}

#[derive(Debug, Default)]
struct Z3dsMetadata {
    version: Option<u8>,
    item_names: Vec<String>,
}

impl Z3dsMetadata {
    const VERSION: u8 = 1;
    const TYPE_END: u8 = 0;
    const TYPE_BINARY: u8 = 1;

    fn parse(bytes: &[u8]) -> Self {
        if bytes.is_empty() {
            return Self::default();
        }
        let version = bytes[0];
        let mut metadata = Self {
            version: Some(version),
            item_names: Vec::new(),
        };
        if version != Self::VERSION {
            return metadata;
        }

        let mut cursor = 1_usize;
        while cursor + 4 <= bytes.len() {
            let item_type = bytes[cursor];
            let name_len = usize::from(bytes[cursor + 1]);
            let data_len = usize::from(u16::from_le_bytes([bytes[cursor + 2], bytes[cursor + 3]]));
            cursor += 4;

            if item_type == Self::TYPE_END {
                break;
            }
            if item_type != Self::TYPE_BINARY {
                break;
            }

            let Some(name_end) = cursor.checked_add(name_len) else {
                break;
            };
            let Some(item_end) = name_end.checked_add(data_len) else {
                break;
            };
            if item_end > bytes.len() {
                break;
            }

            let name = String::from_utf8_lossy(&bytes[cursor..name_end]).to_string();
            if !name.is_empty() {
                metadata.item_names.push(name);
            }
            cursor = item_end;
        }

        metadata
    }

    fn encode_default(frame_size: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(Self::VERSION);
        Self::push_binary_item(&mut bytes, "compressor", b"rom-weaver");
        Self::push_binary_item(
            &mut bytes,
            "maxframesize",
            frame_size.to_string().as_bytes(),
        );
        bytes.push(Self::TYPE_END);
        bytes.push(0);
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    fn push_binary_item(buffer: &mut Vec<u8>, name: &str, data: &[u8]) {
        if name.is_empty()
            || name.len() > usize::from(u8::MAX)
            || data.len() > usize::from(u16::MAX)
        {
            return;
        }
        buffer.push(Self::TYPE_BINARY);
        buffer.push(name.len() as u8);
        buffer.extend_from_slice(&(data.len() as u16).to_le_bytes());
        buffer.extend_from_slice(name.as_bytes());
        buffer.extend_from_slice(data);
    }
}

struct Z3dsPayloadReader<R> {
    inner: R,
    start: u64,
    len: u64,
    pos: u64,
}

#[derive(Clone, Debug)]
struct Z3dsExtractTask {
    index: usize,
    offset: u64,
    len: u64,
}

#[derive(Debug)]
struct Z3dsDecodedExtractChunk {
    index: usize,
    data: Vec<u8>,
}

#[derive(Clone, Debug)]
struct Z3dsCreateTask {
    index: usize,
    offset: u64,
    len: u64,
}

#[derive(Debug)]
struct Z3dsCompressedFrame {
    index: usize,
    decompressed_size: u32,
    compressed_size: u32,
    compressed: Vec<u8>,
}

#[derive(Debug, Default)]
struct Z3dsCreateTotals {
    compressed_frame_bytes: u64,
    uncompressed_bytes: u64,
    frame_count: usize,
}

impl<R: Read + Seek> Z3dsPayloadReader<R> {
    fn new(mut inner: R, start: u64, len: u64) -> io::Result<Self> {
        inner.seek(SeekFrom::Start(start))?;
        Ok(Self {
            inner,
            start,
            len,
            pos: 0,
        })
    }
}

impl<R: Read + Seek> Read for Z3dsPayloadReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let remaining = usize::try_from(self.len - self.pos).unwrap_or(usize::MAX);
        let cap = remaining.min(buffer.len());
        let read = self.inner.read(&mut buffer[..cap])?;
        self.pos = self.pos.saturating_add(read as u64);
        Ok(read)
    }
}

impl<R: Read + Seek> Seek for Z3dsPayloadReader<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let target = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(delta) => i128::from(self.pos) + i128::from(delta),
            SeekFrom::End(delta) => i128::from(self.len) + i128::from(delta),
        };
        if target < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "negative seek offset",
            ));
        }
        let target = u64::try_from(target)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "seek offset overflow"))?;
        if target > self.len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek offset exceeds z3ds payload",
            ));
        }
        let absolute = self
            .start
            .checked_add(target)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek offset overflow"))?;
        self.inner.seek(SeekFrom::Start(absolute))?;
        self.pos = target;
        Ok(self.pos)
    }
}

/// Whether the threaded container create/extract pipelines (z3ds, cso) must read the source on
/// the calling (main) thread instead of opening it from spawned worker threads.
///
/// Delegates to the shared [`rom_weaver_core::reads_source_on_main_thread`] gate: always true on
/// wasm32 (only the main runner thread can open OPFS-backed files; worker `path_open` fails with
/// `os error 44`), and gated by [`crate::constants::MAIN_THREAD_READER_ENV`] on native so tests
/// can exercise the main-thread reader path.
pub(crate) fn container_reads_source_on_main_thread() -> bool {
    rom_weaver_core::reads_source_on_main_thread(crate::constants::MAIN_THREAD_READER_ENV)
}

thread_local! {
    /// Per-worker reusable zstd compression context, keyed by level. `zstd::bulk::compress` builds
    /// and frees a fresh `CCtx` (and its match-finder workspace) on every call; a z3ds create fans
    /// hundreds-to-thousands of frames across a handful of workers, so re-allocating that workspace
    /// per frame is pure overhead. Caching one compressor per thread reuses the workspace across
    /// every frame the thread handles. Keyed by level so a level change rebuilds it; each
    /// `compress` call is independent (one frame in, one frame out), so reuse never changes output
    /// bytes. Lives across the scoped-thread create path.
    static Z3DS_THREAD_COMPRESSOR: std::cell::RefCell<Option<(i32, ZstdCompressor<'static>)>> =
        const { std::cell::RefCell::new(None) };
}

impl Z3dsContainerHandler {
    const SUPPORTED_CODECS: &[&str] = &["zstd"];

    fn align_16(size: usize) -> usize {
        let rem = size % 16;
        if rem == 0 { size } else { size + (16 - rem) }
    }

    fn format_magic(&self, magic: [u8; 4]) -> String {
        if magic.iter().all(|byte| byte.is_ascii_graphic()) {
            String::from_utf8_lossy(&magic).to_string()
        } else {
            format!(
                "{:02X}{:02X}{:02X}{:02X}",
                magic[0], magic[1], magic[2], magic[3]
            )
        }
    }

    fn decompressed_extension_for_underlying_magic(
        &self,
        underlying_magic: [u8; 4],
    ) -> Option<&'static str> {
        match underlying_magic {
            [b'C', b'I', b'A', 0] => Some(".cia"),
            [b'N', b'C', b'S', b'D'] => Some(".cci"),
            [b'N', b'C', b'C', b'H'] => Some(".cxi"),
            [b'3', b'D', b'S', b'X'] => Some(".3dsx"),
            _ => None,
        }
    }

    fn decompressed_extension_for_source(
        &self,
        source: &Path,
        underlying_magic: Option<[u8; 4]>,
    ) -> &'static str {
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        match source_name.as_deref() {
            Some(name) if name.ends_with(".zcci") => ".cci",
            Some(name) if name.ends_with(".zcxi") => ".cxi",
            Some(name) if name.ends_with(".zcia") => ".cia",
            Some(name) if name.ends_with(".z3dsx") => ".3dsx",
            Some(name) if name.ends_with(".z3ds") => underlying_magic
                .and_then(|magic| self.decompressed_extension_for_underlying_magic(magic))
                .unwrap_or(".3ds"),
            _ => underlying_magic
                .and_then(|magic| self.decompressed_extension_for_underlying_magic(magic))
                .unwrap_or(".3ds"),
        }
    }

    pub(crate) fn extract_name_with_underlying_magic(
        &self,
        source: &Path,
        underlying_magic: Option<[u8; 4]>,
    ) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!(
            "{stem}{}",
            self.decompressed_extension_for_source(source, underlying_magic)
        )
    }

    fn map_zstd_error(&self, stage: &str, error: zeekstd::Error) -> RomWeaverError {
        RomWeaverError::Validation(format!("z3ds {stage} failed: {error}"))
    }

    fn resolve_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<i32> {
        let level = level.unwrap_or(Z3DS_DEFAULT_COMPRESSION_LEVEL);
        if !(Z3DS_MIN_COMPRESSION_LEVEL..=Z3DS_MAX_COMPRESSION_LEVEL).contains(&level) {
            return Err(RomWeaverError::Validation(format!(
                "z3ds level `{level}` is out of range; expected {}..={}",
                Z3DS_MIN_COMPRESSION_LEVEL, Z3DS_MAX_COMPRESSION_LEVEL
            )));
        }

        match resolve_create_codec(Z3DS.name, codec, Self::SUPPORTED_CODECS, "zstd")? {
            "zstd" => Ok(level),
            _ => unreachable!("validated z3ds create codec"),
        }
    }

    fn read_header(&self, source: &Path, file: &mut File) -> Result<Z3dsFileHeader> {
        let header = Z3dsFileHeader::read_from(source, file)?;
        let file_size = file.metadata()?.len();
        let payload_offset = header.payload_offset();
        if payload_offset > file_size {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has invalid z3ds metadata size",
                source.display()
            )));
        }
        if header.compressed_size > file_size.saturating_sub(payload_offset) {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has invalid z3ds compressed size",
                source.display()
            )));
        }
        Ok(header)
    }

    fn read_metadata(&self, file: &mut File, header: Z3dsFileHeader) -> Result<Vec<u8>> {
        let metadata_len = usize::try_from(header.metadata_size)
            .map_err(|_| RomWeaverError::Validation("z3ds metadata is too large to read".into()))?;
        if metadata_len == 0 {
            return Ok(Vec::new());
        }
        let mut metadata = vec![0_u8; metadata_len];
        file.seek(SeekFrom::Start(u64::from(Z3dsFileHeader::HEADER_SIZE)))?;
        file.read_exact(&mut metadata)?;
        Ok(metadata)
    }

    /// Group the seekable frames into frame-aligned extract tasks.
    ///
    /// Every task starts exactly on a frame boundary (`frame_start_decomp`), so the decoder seeks
    /// straight to a frame start and decompresses zero bytes it then discards — unlike a fixed
    /// byte-grid, which would force a worker landing mid-frame to re-inflate that frame's prefix.
    /// Deriving boundaries from the seek table (rather than the create-time frame constant) keeps
    /// extract optimal for archives written with any frame size, including older 256 KiB ones.
    ///
    /// Task span is [`Z3DS_EXTRACT_MAX_CHUNK_BYTES`] for large archives but shrinks so the count
    /// reaches roughly `requested_threads * Z3DS_EXTRACT_TASKS_PER_THREAD`; otherwise a mid-size
    /// file would collapse into a handful of big tasks and leave most requested threads idle.
    fn build_extract_tasks(
        &self,
        seek_table: &ZeekstdSeekTable,
        requested_threads: usize,
    ) -> Result<Vec<Z3dsExtractTask>> {
        let frame_count = seek_table.num_frames();
        if frame_count == 0 {
            return Ok(Vec::new());
        }

        let desired_tasks = requested_threads
            .max(1)
            .saturating_mul(Z3DS_EXTRACT_TASKS_PER_THREAD)
            .max(1) as u64;
        let by_thread_budget = seek_table.size_decomp().div_ceil(desired_tasks).max(1);
        let target = by_thread_budget.min(Z3DS_EXTRACT_MAX_CHUNK_BYTES as u64);
        let mut tasks = Vec::new();
        let mut index = 0_usize;
        let mut frame = 0_u32;
        while frame < frame_count {
            let offset = seek_table
                .frame_start_decomp(frame)
                .map_err(|error| self.map_zstd_error("extract frame start", error))?;
            let mut end = offset;
            while frame < frame_count {
                end = seek_table
                    .frame_end_decomp(frame)
                    .map_err(|error| self.map_zstd_error("extract frame end", error))?;
                frame += 1;
                if end.saturating_sub(offset) >= target {
                    break;
                }
            }
            tasks.push(Z3dsExtractTask {
                index,
                offset,
                len: end.saturating_sub(offset),
            });
            index += 1;
        }
        Ok(tasks)
    }

    fn extract_chunk_from_reader<R: Read + Seek>(
        &self,
        payload_reader: R,
        seek_table: &ZeekstdSeekTable,
        task: &Z3dsExtractTask,
    ) -> Result<Z3dsDecodedExtractChunk> {
        let extract_end = task
            .offset
            .checked_add(task.len)
            .ok_or_else(|| RomWeaverError::Validation("z3ds extract offset overflowed".into()))?;
        // Inject the already-parsed seek table instead of letting the decoder re-read and re-parse
        // it from the source for every task (the trailing table is identical for all of them).
        let mut decompressor = ZeekstdDecodeOptions::new(payload_reader)
            .seek_table(seek_table.clone())
            .into_decoder()
            .map_err(|error| self.map_zstd_error("extract initialize", error))?;
        decompressor
            .set_offset(task.offset)
            .map_err(|error| self.map_zstd_error("extract seek", error))?;
        decompressor
            .set_offset_limit(extract_end)
            .map_err(|error| self.map_zstd_error("extract limit", error))?;

        let capacity = usize::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("z3ds extract chunk size exceeded supported range".into())
        })?;
        let mut output = Vec::with_capacity(capacity);
        let buffer_len = capacity.clamp(1, Z3DS_DECODE_BUFFER_BYTES);
        let mut buffer = vec![0_u8; buffer_len];
        let mut written = 0_u64;
        while written < task.len {
            let remaining = task.len - written;
            let to_decode = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(buffer.len());
            let decoded = decompressor
                .decompress(&mut buffer[..to_decode])
                .map_err(|error| self.map_zstd_error("extract", error))?;
            if decoded == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "z3ds extract chunk {} stopped early at {} of {} bytes",
                    task.index, written, task.len
                )));
            }
            output.extend_from_slice(&buffer[..decoded]);
            written = written.saturating_add(decoded as u64);
        }
        Ok(Z3dsDecodedExtractChunk {
            index: task.index,
            data: output,
        })
    }

    fn extract_chunk_task(
        &self,
        source: &Path,
        payload_start: u64,
        compressed_size: u64,
        seek_table: &ZeekstdSeekTable,
        task: &Z3dsExtractTask,
    ) -> Result<Z3dsDecodedExtractChunk> {
        let source_file = File::open(source)?;
        let payload_reader = Z3dsPayloadReader::new(source_file, payload_start, compressed_size)?;
        self.extract_chunk_from_reader(payload_reader, seek_table, task)
    }

    fn extract_pipeline_messages() -> OrderedStreamingMessages {
        OrderedStreamingMessages {
            worker_closed: "z3ds extract workers ended before all chunks were consumed",
            result_closed: "z3ds extract pipeline ended before all chunks were produced",
        }
    }

    fn build_create_tasks(&self, total_len: u64) -> Result<Vec<Z3dsCreateTask>> {
        if total_len == 0 {
            return Ok(Vec::new());
        }

        let mut tasks = Vec::new();
        let chunk_len = Z3DS_DEFAULT_FRAME_SIZE_BYTES as u64;
        let mut offset = 0_u64;
        let mut index = 0_usize;
        while offset < total_len {
            let len = (total_len - offset).min(chunk_len);
            tasks.push(Z3dsCreateTask { index, offset, len });
            offset = offset.saturating_add(len);
            index += 1;
        }
        Ok(tasks)
    }

    fn compress_create_task(
        &self,
        source: &Path,
        level: i32,
        task: &Z3dsCreateTask,
    ) -> Result<Z3dsCompressedFrame> {
        let mut file = BufReader::new(File::open(source)?);
        file.seek(SeekFrom::Start(task.offset))?;
        let read_len = usize::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("z3ds create chunk size exceeded supported range".into())
        })?;
        let mut data = vec![0_u8; read_len];
        file.read_exact(&mut data)?;

        self.compress_frame_bytes(level, task, data)
    }

    fn compress_frame_bytes(
        &self,
        level: i32,
        task: &Z3dsCreateTask,
        data: Vec<u8>,
    ) -> Result<Z3dsCompressedFrame> {
        let compressed = Z3DS_THREAD_COMPRESSOR.with(|cell| -> Result<Vec<u8>> {
            let mut slot = cell.borrow_mut();
            if !matches!(slot.as_ref(), Some((cached, _)) if *cached == level) {
                let compressor = ZstdCompressor::new(level).map_err(|error| {
                    RomWeaverError::Validation(format!("z3ds compressor init failed: {error}"))
                })?;
                *slot = Some((level, compressor));
            }
            let (_, compressor) = slot.as_mut().expect("z3ds compressor initialized above");
            compressor
                .compress(&data)
                .map_err(|error| RomWeaverError::Validation(format!("z3ds create failed: {error}")))
        })?;
        let compressed_size = u32::try_from(compressed.len()).map_err(|_| {
            RomWeaverError::Validation("z3ds compressed chunk exceeded 4 GiB".into())
        })?;
        let decompressed_size = u32::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("z3ds frame exceeded seekable format limits".into())
        })?;

        Ok(Z3dsCompressedFrame {
            index: task.index,
            decompressed_size,
            compressed_size,
            compressed,
        })
    }

    /// Stream one finished frame straight to the output and record it in the running seek table,
    /// updating the running totals. Frames must arrive in `index` order (the streaming pipeline and
    /// the sequential path both deliver them ordered), which lets create avoid buffering the entire
    /// compressed file in memory before writing — critical under the browser's wasm memory cap.
    fn write_create_frame(
        &self,
        output: &mut BufWriter<File>,
        seek_table: &mut ZeekstdSeekTable,
        totals: &mut Z3dsCreateTotals,
        frame: Z3dsCompressedFrame,
    ) -> Result<()> {
        if frame.index != totals.frame_count {
            return Err(RomWeaverError::Validation(format!(
                "z3ds frame {} arrived out of order (expected {})",
                frame.index, totals.frame_count
            )));
        }
        let copied = u64::try_from(frame.compressed.len()).map_err(|_| {
            RomWeaverError::Validation("z3ds compressed frame length overflowed".into())
        })?;
        if copied != u64::from(frame.compressed_size) {
            return Err(RomWeaverError::Validation(format!(
                "z3ds frame {} buffered {} bytes but expected {} bytes",
                frame.index, copied, frame.compressed_size
            )));
        }
        output.write_all(&frame.compressed)?;
        seek_table
            .log_frame(frame.compressed_size, frame.decompressed_size)
            .map_err(|error| self.map_zstd_error("seek table build", error))?;
        totals.compressed_frame_bytes = totals.compressed_frame_bytes.saturating_add(copied);
        totals.uncompressed_bytes = totals
            .uncompressed_bytes
            .saturating_add(u64::from(frame.decompressed_size));
        totals.frame_count += 1;
        Ok(())
    }

    fn write_seek_table(
        &self,
        output: &mut BufWriter<File>,
        seek_table: ZeekstdSeekTable,
    ) -> Result<u64> {
        let mut serializer = seek_table.into_serializer();
        let seek_table_bytes = u64::try_from(serializer.encoded_len())
            .map_err(|_| RomWeaverError::Validation("z3ds seek table size overflowed".into()))?;
        io::copy(&mut serializer, output)?;

        Ok(seek_table_bytes)
    }
}

impl ContainerHandlerOperations for Z3dsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &Z3DS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        match File::open(source).and_then(|mut file| {
            let mut magic = [0_u8; 4];
            file.read_exact(&mut magic)?;
            Ok(magic)
        }) {
            Ok(magic) if magic == Z3dsFileHeader::MAGIC => ProbeConfidence::Signature,
            _ => ProbeConfidence::Extension,
        }
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        let metadata = self.read_metadata(&mut file, header)?;
        let parsed_metadata = Z3dsMetadata::parse(&metadata);
        let ratio = if header.uncompressed_size == 0 {
            0.0
        } else {
            (header.compressed_size as f64 / header.uncompressed_size as f64) * 100.0
        };
        let metadata_label = if header.metadata_size == 0 {
            "metadata=none".to_string()
        } else if parsed_metadata.item_names.is_empty() {
            format!(
                "metadata={} bytes, version={}",
                header.metadata_size,
                parsed_metadata
                    .version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )
        } else {
            format!(
                "metadata={} bytes, keys={}",
                header.metadata_size,
                parsed_metadata.item_names.join(",")
            )
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(Z3DS.name.to_string()),
            "probe",
            format!(
                "z3ds: {} bytes -> {} bytes ({ratio:.2}%), underlying_magic={}, {}",
                header.uncompressed_size,
                header.compressed_size,
                self.format_magic(header.underlying_magic),
                metadata_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        Ok(vec![self.extract_name_with_underlying_magic(
            &request.source,
            Some(header.underlying_magic),
        )])
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        // Report the decompressed output name and its size straight from the header so input
        // discovery can enumerate the single produced file without performing a full extract.
        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        Ok(vec![ContainerListEntry {
            path: self
                .extract_name_with_underlying_magic(&request.source, Some(header.underlying_magic)),
            size: Some(header.uncompressed_size),
        }])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        let output_name =
            self.extract_name_with_underlying_magic(&request.source, Some(header.underlying_magic));
        request.ensure_single_output_selected(&output_name)?;

        let payload_start = header.payload_offset();
        drop(file);
        // Parse the seekable frame table once on this (main) thread. `SeekTable::from_seekable`
        // only reads the trailing table, not the payload, so it is cheap; every worker then shares
        // this parse instead of re-reading and re-parsing the table for each chunk it decodes.
        let seek_table = {
            let mut table_reader = Z3dsPayloadReader::new(
                File::open(&request.source)?,
                payload_start,
                header.compressed_size,
            )?;
            ZeekstdSeekTable::from_seekable(&mut table_reader)
                .map_err(|error| self.map_zstd_error("extract seek table", error))?
        };
        let tasks =
            self.build_extract_tasks(&seek_table, context.thread_budget().requested_threads())?;

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);

        let execution = context.plan_threads(ThreadCapability::parallel(Some(tasks.len().max(1))));
        debug!(
            format = Z3DS.name,
            compressed_size = header.compressed_size,
            uncompressed_size = header.uncompressed_size,
            tasks = tasks.len(),
            used_parallelism = execution.used_parallelism,
            effective_threads = execution.effective_threads,
            read_on_main = execution.used_parallelism && container_reads_source_on_main_thread(),
            "z3ds extract start"
        );
        let extract_progress_label = format!("extracting `{}`", Z3DS.name);
        // Hash the decompressed output as it is written so a requested `--checksum` is computed
        // during extract (overlapping the work) instead of forcing the caller into a second full
        // read of the output, matching the libarchive/chd/rvz extract paths.
        let mut extract_writer = ExtractChunkWriter::new(
            context,
            &execution,
            Z3DS.name,
            extract_progress_label,
            header.uncompressed_size,
            &output_path,
            request.overwrite,
        )?;
        let source = request.source.clone();

        let decode_result: Result<()> =
            if execution.used_parallelism && container_reads_source_on_main_thread() {
                // Read-on-main pipeline (browser/wasm): the OPFS source is opened only on the main
                // runner thread, so the compressed payload range is read here into a single shared
                // buffer. Worker threads then decompress from that in-memory buffer (never the
                // file). The payload buffer already begins at `payload_start`, so each reader uses
                // start 0. Bytes written are identical to the native path.
                let payload_len = usize::try_from(header.compressed_size).map_err(|_| {
                    RomWeaverError::Validation(
                        "z3ds compressed payload exceeded addressable memory".into(),
                    )
                })?;
                let mut payload = vec![0_u8; payload_len];
                {
                    let mut payload_file = BufReader::new(File::open(&source)?);
                    payload_file.seek(SeekFrom::Start(payload_start))?;
                    payload_file.read_exact(&mut payload)?;
                }
                trace!(
                    format = Z3DS.name,
                    payload_bytes = payload_len,
                    payload_start,
                    "z3ds read-on-main payload buffered"
                );
                let payload = payload.as_slice();

                decode_tasks_ordered(
                    &tasks,
                    execution.effective_threads,
                    Self::extract_pipeline_messages(),
                    |task: &Z3dsExtractTask| task.len,
                    |task| {
                        let reader = Z3dsPayloadReader::new(
                            io::Cursor::new(payload),
                            0,
                            header.compressed_size,
                        )?;
                        self.extract_chunk_from_reader(reader, &seek_table, &task)
                    },
                    |chunk: Z3dsDecodedExtractChunk, task_len| {
                        extract_writer.write(chunk.index, chunk.data, task_len)
                    },
                )
            } else if execution.used_parallelism {
                decode_tasks_ordered(
                    &tasks,
                    execution.effective_threads,
                    Self::extract_pipeline_messages(),
                    |task: &Z3dsExtractTask| task.len,
                    |task| {
                        self.extract_chunk_task(
                            &source,
                            payload_start,
                            header.compressed_size,
                            &seek_table,
                            &task,
                        )
                    },
                    |chunk: Z3dsDecodedExtractChunk, task_len| {
                        extract_writer.write(chunk.index, chunk.data, task_len)
                    },
                )
            } else {
                for task in &tasks {
                    let chunk = self.extract_chunk_task(
                        &source,
                        payload_start,
                        header.compressed_size,
                        &seek_table,
                        task,
                    )?;
                    extract_writer.write(chunk.index, chunk.data, task.len)?;
                }
                Ok(())
            };
        if let Err(error) = decode_result {
            let _ = fs::remove_file(&output_path);
            return Err(error);
        }
        let output_checksums = match extract_writer.finish(&output_path) {
            Ok(checksums) => checksums,
            Err(error) => {
                let _ = fs::remove_file(&output_path);
                return Err(error);
            }
        };

        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(Z3DS.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written)",
                request.source.display(),
                output_path.display(),
                header.uncompressed_size
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        let report = attach_extraction_details(report, 1, 1, header.uncompressed_size, &execution);
        let report = attach_extract_checksum_details(report, output_checksums);
        Ok(attach_emitted_file_paths(report, &[output_path]))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "z3ds create currently requires exactly one input file".into(),
            ));
        }

        let input_path = &request.inputs[0];
        let level = self.resolve_level(request.codec.as_deref(), request.level)?;
        let input_size = fs::metadata(input_path)?.len();
        let create_tasks = self.build_create_tasks(input_size)?;
        // Plan threads without building a shared pool: the scoped pipeline owns exactly the worker
        // threads it needs, which avoids double-booking the bounded wasm worker pool.
        let execution =
            context.plan_threads(ThreadCapability::parallel(Some(create_tasks.len().max(1))));
        debug!(
            format = Z3DS.name,
            input = %input_path.display(),
            input_size,
            level,
            frames = create_tasks.len(),
            used_parallelism = execution.used_parallelism,
            effective_threads = execution.effective_threads,
            "z3ds create start"
        );
        let create_progress_label = format!("creating `{}`", Z3DS.name);
        let create_progress_bytes = Arc::new(AtomicU64::new(0));
        let create_progress_bucket = Arc::new(AtomicU8::new(0));

        let mut underlying_magic = [0_u8; 4];
        {
            let mut input = BufReader::new(File::open(input_path)?);
            let magic_read = input.read(&mut underlying_magic)?;
            if magic_read < underlying_magic.len() {
                for byte in &mut underlying_magic[magic_read..] {
                    *byte = 0;
                }
            }
        }

        let metadata = Z3dsMetadata::encode_default(Z3DS_DEFAULT_FRAME_SIZE_BYTES);
        let metadata_aligned = Self::align_16(metadata.len());
        let metadata_size = u32::try_from(metadata_aligned).map_err(|_| {
            RomWeaverError::Validation("z3ds metadata exceeded supported size".into())
        })?;

        let source = input_path.clone();
        let mut header = Z3dsFileHeader {
            underlying_magic,
            metadata_size,
            compressed_size: 0,
            uncompressed_size: 0,
        };
        let mut totals = Z3dsCreateTotals::default();

        // Build the archive by streaming: write the header + metadata, then append each compressed
        // frame to the output (and log it in the seek table) the instant it is produced, in order.
        // Buffering every frame until the end held the whole compressed file (hundreds of MiB) in
        // memory at once, which on top of the concurrent zstd contexts overflowed the browser's
        // 1 GiB wasm linear-memory cap on large high-level jobs. Streaming bounds peak memory to the
        // read-ahead window plus the worker contexts. On any error the partial output is removed.
        let build: Result<()> = (|| {
            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }
            // Large write buffer: streaming frames to disk interleaves the writes with the
            // coordinator thread's read-ahead, so batching them into a few big writes (instead of
            // the default 8 KiB BufWriter's thousands of small ones) keeps the reader feeding the
            // compressors at fast levels. 4 MiB is negligible against the wasm memory budget.
            let mut output =
                BufWriter::with_capacity(4 * 1024 * 1024, File::create(&request.output)?);
            let mut seek_table = ZeekstdSeekTable::new();
            header.write_to(output.get_mut())?;
            if !metadata.is_empty() {
                output.write_all(&metadata)?;
            }
            if metadata_aligned > metadata.len() {
                output.write_all(&vec![0_u8; metadata_aligned - metadata.len()])?;
            }

            if execution.used_parallelism {
                // Single threaded-reader/parallel-compressor pipeline for every target. The calling
                // thread reads each frame and hands it to `std::thread::scope` workers that run zstd
                // in parallel, reading ahead up to `inflight` frames and draining compressed frames
                // in order. Reading on one thread is required in the browser — only the main OPFS
                // runner can open the source — and costs nothing on native because create is
                // compression-bound, so the reader stays ahead of the compressors. It also keeps
                // the worker count exactly `effective_threads`, so it never double-books the
                // bounded wasm thread pool.
                let create_progress_bytes = Arc::clone(&create_progress_bytes);
                let create_progress_bucket = Arc::clone(&create_progress_bucket);
                let mut input = BufReader::new(File::open(input_path)?);
                input.seek(SeekFrom::Start(0))?;

                ordered_streaming_compress(
                    &create_tasks,
                    execution.effective_threads,
                    OrderedStreamingMessages {
                        worker_closed: "z3ds compression workers ended before all frames were consumed",
                        result_closed: "z3ds compression pipeline ended before all frames were produced",
                    },
                    |_, task| {
                        let read_len = usize::try_from(task.len).map_err(|_| {
                            RomWeaverError::Validation(
                                "z3ds create chunk size exceeded supported range".into(),
                            )
                        })?;
                        let mut data = vec![0_u8; read_len];
                        input.read_exact(&mut data)?;
                        if input_size > 0 {
                            let completed = create_progress_bytes
                                .fetch_add(task.len, Ordering::Relaxed)
                                .saturating_add(task.len)
                                .min(input_size);
                            maybe_emit_container_byte_progress(
                                context,
                                completed,
                                input_size,
                                ContainerByteProgress {
                                    command: "compress",
                                    format: Z3DS.name,
                                    stage: "create",
                                    label: &create_progress_label,
                                    thread_execution: Some(&execution),
                                    emitted_progress_bucket: create_progress_bucket.as_ref(),
                                },
                            );
                        }
                        Ok((task.index, task.len, data))
                    },
                    || (),
                    |_, _, (index, len, data)| {
                        let task = Z3dsCreateTask {
                            index,
                            offset: 0,
                            len,
                        };
                        self.compress_frame_bytes(level, &task, data)
                    },
                    |_, frame| {
                        self.write_create_frame(&mut output, &mut seek_table, &mut totals, frame)
                    },
                )?;
            } else {
                for task in &create_tasks {
                    let frame = self.compress_create_task(&source, level, task)?;
                    if input_size > 0 {
                        let completed = create_progress_bytes
                            .fetch_add(task.len, Ordering::Relaxed)
                            .saturating_add(task.len)
                            .min(input_size);
                        maybe_emit_container_byte_progress(
                            context,
                            completed,
                            input_size,
                            ContainerByteProgress {
                                command: "compress",
                                format: Z3DS.name,
                                stage: "create",
                                label: &create_progress_label,
                                thread_execution: Some(&execution),
                                emitted_progress_bucket: create_progress_bucket.as_ref(),
                            },
                        );
                    }
                    self.write_create_frame(&mut output, &mut seek_table, &mut totals, frame)?;
                }
            }

            let seek_table_bytes = self.write_seek_table(&mut output, seek_table)?;
            output.flush()?;
            header.compressed_size = totals
                .compressed_frame_bytes
                .saturating_add(seek_table_bytes);
            header.uncompressed_size = totals.uncompressed_bytes;
            header.write_to(output.get_mut())?;
            output.flush()?;
            Ok(())
        })();
        if let Err(error) = build {
            let _ = fs::remove_file(&request.output);
            return Err(error);
        }

        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(Z3DS.name.to_string()),
            "create",
            format!(
                "created z3ds `{}` from `{}` (zstd level={}, frame={} bytes, {} bytes, {} frame(s))",
                request.output.display(),
                input_path.display(),
                level,
                Z3DS_DEFAULT_FRAME_SIZE_BYTES,
                header.compressed_size,
                totals.frame_count
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        Ok(attach_compression_details(
            report,
            "zstd",
            Some(level),
            header.uncompressed_size,
            &execution,
        ))
    }
}
