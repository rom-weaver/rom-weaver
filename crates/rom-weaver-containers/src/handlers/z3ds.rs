/* jscpd:ignore-start */
struct Z3dsContainerHandler;

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

/// Whether the threaded z3ds create/extract pipelines must read the source on the calling
/// (main) thread instead of opening it from spawned worker threads.
///
/// In the browser/wasm runtime only the main runner thread can open OPFS-backed files; spawned
/// worker threads cannot `path_open` the OPFS source (the open fails with
/// `No such file or directory (os error 44)`). Reading on the main thread keeps the CPU-bound
/// zstd compress/decompress parallel while avoiding worker-thread OPFS access — the same shape
/// the CHD create/extract paths already use (main does I/O, workers compute).
#[cfg(target_arch = "wasm32")]
fn z3ds_reads_source_on_main_thread() -> bool {
    true
}

#[cfg(not(target_arch = "wasm32"))]
fn z3ds_reads_source_on_main_thread() -> bool {
    // Native opens the source per worker for read/compute overlap; this escape hatch exercises
    // the main-thread reader path in tests.
    std::env::var("ROM_WEAVER_CONTAINER_MAIN_THREAD_READER").as_deref() == Ok("1")
}

impl Z3dsContainerHandler {
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

    fn extract_name_with_underlying_magic(
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
                Z3DS_MIN_COMPRESSION_LEVEL,
                Z3DS_MAX_COMPRESSION_LEVEL
            )));
        }

        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(level),
            RequestedCodec::Known(CanonicalCodec::Store) => Err(RomWeaverError::Validation(
                "z3ds does not support uncompressed output; use zstd".into(),
            )),
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported z3ds codec `{}`; supported codec is zstd",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported z3ds codec `{name}`; supported codec is zstd"
            ))),
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

    fn build_extract_tasks(&self, total_len: u64) -> Result<Vec<Z3dsExtractTask>> {
        if total_len == 0 {
            return Ok(Vec::new());
        }

        let mut tasks = Vec::new();
        let chunk_len = Z3DS_EXTRACT_CHUNK_BYTES as u64;
        let mut offset = 0_u64;
        let mut index = 0_usize;
        while offset < total_len {
            let len = (total_len - offset).min(chunk_len);
            tasks.push(Z3dsExtractTask { index, offset, len });
            offset = offset.saturating_add(len);
            index += 1;
        }
        Ok(tasks)
    }

    fn extract_chunk_from_reader<R: Read + Seek>(
        &self,
        payload_reader: R,
        task: &Z3dsExtractTask,
    ) -> Result<Z3dsDecodedExtractChunk> {
        let extract_end = task
            .offset
            .checked_add(task.len)
            .ok_or_else(|| RomWeaverError::Validation("z3ds extract offset overflowed".into()))?;
        let mut decompressor = ZeekstdDecoder::new(payload_reader)
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
        let buffer_len = usize::try_from(task.len.min(Z3DS_EXTRACT_CHUNK_BYTES as u64))
            .unwrap_or(Z3DS_EXTRACT_CHUNK_BYTES)
            .max(1);
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
        task: &Z3dsExtractTask,
    ) -> Result<Z3dsDecodedExtractChunk> {
        let source_file = File::open(source)?;
        let payload_reader = Z3dsPayloadReader::new(source_file, payload_start, compressed_size)?;
        self.extract_chunk_from_reader(payload_reader, task)
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
        let compressed = zstd_compress(&data, level)
            .map_err(|error| RomWeaverError::Validation(format!("z3ds create failed: {error}")))?;
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

    fn write_seek_table(
        &self,
        output: &mut BufWriter<File>,
        frames: &[Z3dsCompressedFrame],
    ) -> Result<u64> {
        let mut seek_table = ZeekstdSeekTable::new();
        for frame in frames {
            seek_table
                .log_frame(frame.compressed_size, frame.decompressed_size)
                .map_err(|error| self.map_zstd_error("seek table build", error))?;
        }
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

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
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
            "inspect",
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
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        Ok(vec![self.extract_name_with_underlying_magic(
            &request.source,
            Some(header.underlying_magic),
        )])
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
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let payload_start = header.payload_offset();
        drop(file);
        let tasks = self.build_extract_tasks(header.uncompressed_size)?;

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);

        let (execution, pool) =
            context.build_pool(ThreadCapability::parallel(Some(tasks.len().max(1))))?;
        let extract_progress_label = format!("extracting `{}`", Z3DS.name);
        let extract_progress_bytes = Arc::new(AtomicU64::new(0));
        let extract_progress_bucket = Arc::new(AtomicU8::new(0));

        {
            let output_file = create_extract_output_file(&output_path, request.overwrite)?;
            let mut ordered_writer = OrderedChunkWriter::new(
                BufWriter::new(output_file),
                bounded_items_for_threads(execution.effective_threads),
            )?;
            let source = request.source.clone();

            let mut write_chunk = |chunk: Z3dsDecodedExtractChunk, task_len: u64| -> Result<()> {
                let chunk_len = u64::try_from(chunk.data.len()).map_err(|_| {
                    RomWeaverError::Validation("z3ds extract chunk length overflowed".into())
                })?;
                if chunk_len != task_len {
                    return Err(RomWeaverError::Validation(format!(
                        "z3ds extract chunk {} wrote {} bytes but expected {}",
                        chunk.index, chunk_len, task_len
                    )));
                }
                let chunk_index = u64::try_from(chunk.index).map_err(|_| {
                    RomWeaverError::Validation("z3ds extract chunk index overflowed".into())
                })?;
                ordered_writer.write_chunk(chunk_index, chunk.data)?;
                if header.uncompressed_size > 0 {
                    let completed = extract_progress_bytes
                        .fetch_add(chunk_len, Ordering::Relaxed)
                        .saturating_add(chunk_len)
                        .min(header.uncompressed_size);
                    maybe_emit_container_byte_progress(
                        context,
                        "extract",
                        Z3DS.name,
                        "extract",
                        completed,
                        header.uncompressed_size,
                        &extract_progress_label,
                        Some(&execution),
                        extract_progress_bucket.as_ref(),
                    );
                }
                Ok(())
            };

            let decode_result: Result<()> = if execution.used_parallelism
                && z3ds_reads_source_on_main_thread()
            {
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
                let payload = payload.as_slice();

                let batch_size = bounded_items_for_threads(execution.effective_threads);
                for task_batch in tasks.chunks(batch_size) {
                    let mut chunks = pool.install(|| {
                        task_batch
                            .par_iter()
                            .map(|task| {
                                let reader = Z3dsPayloadReader::new(
                                    io::Cursor::new(payload),
                                    0,
                                    header.compressed_size,
                                )?;
                                self.extract_chunk_from_reader(reader, task)
                                    .map(|chunk| (task.len, chunk))
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;
                    chunks.sort_by_key(|(_, chunk)| chunk.index);
                    for (task_len, chunk) in chunks {
                        write_chunk(chunk, task_len)?;
                    }
                }
                Ok(())
            } else if execution.used_parallelism {
                let batch_size = bounded_items_for_threads(execution.effective_threads);
                for task_batch in tasks.chunks(batch_size) {
                    let mut chunks = pool.install(|| {
                        task_batch
                            .par_iter()
                            .map(|task| {
                                self.extract_chunk_task(
                                    &source,
                                    payload_start,
                                    header.compressed_size,
                                    task,
                                )
                                .map(|chunk| (task.len, chunk))
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;
                    chunks.sort_by_key(|(_, chunk)| chunk.index);
                    for (task_len, chunk) in chunks {
                        write_chunk(chunk, task_len)?;
                    }
                }
                Ok(())
            } else {
                for task in &tasks {
                    let chunk = self.extract_chunk_task(
                        &source,
                        payload_start,
                        header.compressed_size,
                        task,
                    )?;
                    write_chunk(chunk, task.len)?;
                }
                Ok(())
            };
            if let Err(error) = decode_result {
                let _ = fs::remove_file(&output_path);
                return Err(error);
            }
            if let Err(error) = ordered_writer.finish() {
                let _ = fs::remove_file(&output_path);
                return Err(error);
            }
        }

        Ok(OperationReport::succeeded(
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
            Some(execution),
        ))
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
        let (execution, pool) =
            context.build_pool(ThreadCapability::parallel(Some(create_tasks.len().max(1))))?;
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
        let compress_result = if execution.used_parallelism
            && z3ds_reads_source_on_main_thread()
        {
            // Read-on-main pipeline (browser/wasm): the OPFS source is owned by the main runner
            // thread, so all reads happen here while worker threads run zstd compression in
            // parallel. The main thread reads ahead up to `inflight` frames, then drains
            // compressed frames as they complete; ordering is restored by sorting on `index`
            // before the write phase, so the output bytes are identical to the native path.
            let create_progress_bytes = Arc::clone(&create_progress_bytes);
            let create_progress_bucket = Arc::clone(&create_progress_bucket);
            let mut input = BufReader::new(File::open(input_path)?);
            input.seek(SeekFrom::Start(0))?;
            let mut frames = Vec::with_capacity(create_tasks.len());

            ordered_streaming_compress(
                &create_tasks,
                execution.effective_threads,
                "z3ds compression workers ended before all frames were consumed",
                "z3ds compression pipeline ended before all frames were produced",
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
                            "compress",
                            Z3DS.name,
                            "create",
                            completed,
                            input_size,
                            &create_progress_label,
                            Some(&execution),
                            create_progress_bucket.as_ref(),
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
                    frames.push(frame);
                    Ok(())
                },
            )?;

            Ok(frames)
        } else if execution.used_parallelism {
            let progress_context = context.clone();
            let progress_execution = execution.clone();
            let create_progress_bytes = Arc::clone(&create_progress_bytes);
            let create_progress_bucket = Arc::clone(&create_progress_bucket);
            pool.install(|| {
                create_tasks
                    .par_iter()
                    .map(|task| {
                        let frame = self.compress_create_task(&source, level, task)?;
                        if input_size > 0 {
                            let completed = create_progress_bytes
                                .fetch_add(task.len, Ordering::Relaxed)
                                .saturating_add(task.len)
                                .min(input_size);
                            maybe_emit_container_byte_progress(
                                &progress_context,
                                "compress",
                                Z3DS.name,
                                "create",
                                completed,
                                input_size,
                                &create_progress_label,
                                Some(&progress_execution),
                                create_progress_bucket.as_ref(),
                            );
                        }
                        Ok(frame)
                    })
                    .collect::<Result<Vec<_>>>()
            })
        } else {
            create_tasks
                .iter()
                .map(|task| {
                    let frame = self.compress_create_task(&source, level, task)?;
                    if input_size > 0 {
                        let completed = create_progress_bytes
                            .fetch_add(task.len, Ordering::Relaxed)
                            .saturating_add(task.len)
                            .min(input_size);
                        maybe_emit_container_byte_progress(
                            context,
                            "compress",
                            Z3DS.name,
                            "create",
                            completed,
                            input_size,
                            &create_progress_label,
                            Some(&execution),
                            create_progress_bucket.as_ref(),
                        );
                    }
                    Ok(frame)
                })
                .collect::<Result<Vec<_>>>()
        };
        let mut frames = compress_result?;

        frames.sort_by_key(|frame| frame.index);

        let output_init: Result<(BufWriter<File>, Z3dsFileHeader)> = (|| {
            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = BufWriter::new(File::create(&request.output)?);
            let header = Z3dsFileHeader {
                underlying_magic,
                metadata_size,
                compressed_size: 0,
                uncompressed_size: 0,
            };
            header.write_to(output.get_mut())?;

            if !metadata.is_empty() {
                output.write_all(&metadata)?;
            }
            if metadata_aligned > metadata.len() {
                let padding = vec![0_u8; metadata_aligned - metadata.len()];
                output.write_all(&padding)?;
            }
            Ok((output, header))
        })();
        let (mut output, mut header) = output_init?;

        let mut compressed_frame_bytes = 0_u64;
        let mut uncompressed_bytes = 0_u64;
        for frame in &frames {
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
            compressed_frame_bytes = compressed_frame_bytes.saturating_add(copied);
            uncompressed_bytes =
                uncompressed_bytes.saturating_add(u64::from(frame.decompressed_size));
        }

        let seek_table_bytes = self.write_seek_table(&mut output, &frames)?;

        output.flush()?;
        header.compressed_size = compressed_frame_bytes.saturating_add(seek_table_bytes);
        header.uncompressed_size = uncompressed_bytes;
        header.write_to(output.get_mut())?;
        output.flush()?;

        Ok(OperationReport::succeeded(
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
                frames.len()
            ),
            Some(100.0),
            Some(execution),
        ))
    }
}
/* jscpd:ignore-end */
