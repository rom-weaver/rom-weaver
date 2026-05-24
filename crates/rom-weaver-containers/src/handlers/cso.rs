/* jscpd:ignore-start */
#[derive(Clone, Debug)]
struct CsoExtractTask {
    index: usize,
    offset: u64,
    len: u64,
}

#[derive(Debug)]
struct CsoDecodedExtractChunk {
    index: usize,
    data: Vec<u8>,
}

#[derive(Clone, Debug)]
struct CsoCreateTask {
    index: usize,
    start_sector: usize,
    sector_count: usize,
    temp_path: PathBuf,
}

#[derive(Clone, Copy, Debug)]
struct CsoSectorEncoding {
    encoded_len: u32,
    is_compressed: bool,
}

#[derive(Clone, Debug)]
struct CsoEncodedTask {
    index: usize,
    start_sector: usize,
    temp_path: PathBuf,
    sector_encodings: Vec<CsoSectorEncoding>,
}

struct ExactCsoFileReader {
    file: File,
}

impl ExactCsoFileReader {
    fn open(path: &Path) -> std::result::Result<Self, io::Error> {
        Ok(Self {
            file: File::open(path)?,
        })
    }
}

impl ciso::read::Read<io::Error> for ExactCsoFileReader {
    fn size(&mut self) -> std::result::Result<u64, io::Error> {
        self.file.seek(SeekFrom::End(0))
    }

    fn read(&mut self, pos: u64, buf: &mut [u8]) -> std::result::Result<(), io::Error> {
        self.file.seek(SeekFrom::Start(pos))?;
        self.file.read_exact(buf)?;
        Ok(())
    }
}

enum CsoSourceReader {
    Single(ExactCsoFileReader),
    Split(SplitFileReader<io::Error, ExactCsoFileReader>),
}

impl ciso::read::Read<io::Error> for CsoSourceReader {
    fn size(&mut self) -> std::result::Result<u64, io::Error> {
        match self {
            Self::Single(reader) => ciso::read::Read::size(reader),
            Self::Split(reader) => ciso::read::Read::size(reader),
        }
    }

    fn read(&mut self, pos: u64, buf: &mut [u8]) -> std::result::Result<(), io::Error> {
        match self {
            Self::Single(reader) => ciso::read::Read::read(reader, pos, buf),
            Self::Split(reader) => ciso::read::Read::read(reader, pos, buf),
        }
    }
}

type CsoImageReader = CsoReader<io::Error, CsoSourceReader>;

struct CsoContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl CsoContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_split_source(&self, source: &Path) -> Result<Option<CsoSourceReader>> {
        let file_extension = source.extension().and_then(|value| value.to_str());
        let Some(file_extension) = file_extension else {
            return Ok(None);
        };
        if !file_extension.eq_ignore_ascii_case("cso") {
            return Ok(None);
        }

        let source_base = source.with_extension("");
        let split_root = source_base
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == "1");
        if !split_root {
            return Ok(None);
        }

        let mut parts = Vec::new();
        for index in 1.. {
            let part_path = source_base.with_extension(format!("{index}.{file_extension}"));
            if !part_path.exists() {
                break;
            }
            parts.push(ExactCsoFileReader::open(&part_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open cso split part `{}`: {error}",
                    part_path.display()
                ))
            })?);
        }

        if parts.is_empty() {
            return Ok(None);
        }

        let split_reader = SplitFileReader::new(parts).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open split cso source `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(Some(CsoSourceReader::Split(split_reader)))
    }

    fn open_source(&self, source: &Path) -> Result<CsoSourceReader> {
        if let Some(split_reader) = self.open_split_source(source)? {
            return Ok(split_reader);
        }
        let file = ExactCsoFileReader::open(source).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open cso source `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(CsoSourceReader::Single(file))
    }

    fn open_reader(&self, source: &Path) -> Result<CsoImageReader> {
        CsoReader::new(self.open_source(source)?).map_err(|error| {
            RomWeaverError::Validation(format!(
                "cso source `{}` is invalid: {error}",
                source.display()
            ))
        })
    }

    fn output_name(&self, source: &Path) -> String {
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(self.descriptor.name);
        let file_name_lower = file_name.to_ascii_lowercase();

        let mut trimmed = if file_name_lower.ends_with(".cso") {
            file_name[..file_name.len() - ".cso".len()].to_string()
        } else if file_name_lower.ends_with(".ciso") {
            file_name[..file_name.len() - ".ciso".len()].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };
        if let Some(without_split_suffix) = trimmed.strip_suffix(".1") {
            trimmed = without_split_suffix.to_string();
        }

        let normalized = trimmed.trim().trim_matches('.');
        if normalized.is_empty() {
            "cso.iso".to_string()
        } else {
            format!("{normalized}.iso")
        }
    }

    fn build_extract_tasks(&self, logical_bytes: u64) -> Vec<CsoExtractTask> {
        if logical_bytes == 0 {
            return Vec::new();
        }
        let mut tasks = Vec::new();
        let mut offset = 0_u64;
        let mut index = 0_usize;
        while offset < logical_bytes {
            let len = (logical_bytes - offset).min(CSO_EXTRACT_TASK_BYTES);
            tasks.push(CsoExtractTask { index, offset, len });
            offset = offset.saturating_add(len);
            index += 1;
        }
        tasks
    }

    fn decode_extract_task(
        &self,
        source: &Path,
        task: &CsoExtractTask,
    ) -> Result<CsoDecodedExtractChunk> {
        let read_len = usize::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("cso extract task length overflowed usize".into())
        })?;
        let mut reader = self.open_reader(source)?;
        let mut decoded = vec![0_u8; read_len];
        reader
            .read_offset(task.offset, &mut decoded)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "cso extract failed while decoding `{}` chunk {} at offset {}: {error}",
                    source.display(),
                    task.index,
                    task.offset
                ))
            })?;
        Ok(CsoDecodedExtractChunk {
            index: task.index,
            data: decoded,
        })
    }

    fn build_create_tasks(
        &self,
        logical_bytes: u64,
        context: &OperationContext,
    ) -> Vec<CsoCreateTask> {
        let mut header = ciso::layout::CSOHeader::new();
        header.uncompressed_size = logical_bytes;
        let sector_count = header.index_table_len().saturating_sub(1);
        if sector_count == 0 {
            return Vec::new();
        }

        let mut tasks = Vec::new();
        let mut start_sector = 0_usize;
        let mut index = 0_usize;
        while start_sector < sector_count {
            let sector_count = (sector_count - start_sector).min(CSO_CREATE_TASK_SECTORS);
            tasks.push(CsoCreateTask {
                index,
                start_sector,
                sector_count,
                temp_path: context
                    .temp_paths()
                    .next_path(&format!("cso-create-{index}"), Some("chunk")),
            });
            start_sector += sector_count;
            index += 1;
        }
        tasks
    }

    fn create_task_logical_bytes(&self, task: &CsoCreateTask, logical_bytes: u64) -> Result<u64> {
        let block_bytes = CSO_DEFAULT_BLOCK_BYTES as u64;
        let start = u64::try_from(task.start_sector)
            .ok()
            .and_then(|sector| sector.checked_mul(block_bytes))
            .ok_or_else(|| {
                RomWeaverError::Validation("cso create source offset overflowed".into())
            })?;
        let task_len = u64::try_from(task.sector_count)
            .ok()
            .and_then(|sector_count| sector_count.checked_mul(block_bytes))
            .ok_or_else(|| {
                RomWeaverError::Validation("cso create task length overflowed".into())
            })?;
        let end = start.checked_add(task_len).ok_or_else(|| {
            RomWeaverError::Validation("cso create source offset overflowed".into())
        })?;
        let clamped_start = start.min(logical_bytes);
        let clamped_end = end.min(logical_bytes);
        Ok(clamped_end.saturating_sub(clamped_start))
    }

    fn compress_sector_for_create(&self, sector: &[u8]) -> Result<(Vec<u8>, bool)> {
        let frame_info = Lz4FrameInfo::new()
            .block_mode(Lz4BlockMode::Independent)
            .block_size(Lz4BlockSize::Max64KB)
            .content_checksum(false)
            .block_checksums(false)
            .legacy_frame(true)
            .content_size(None);
        let mut encoder = Lz4FrameEncoder::with_frame_info(frame_info, Vec::new());
        encoder.write_all(sector).map_err(|error| {
            RomWeaverError::Validation(format!(
                "cso create failed while compressing sector: {error}"
            ))
        })?;
        let encoded = encoder.finish().map_err(|error| {
            RomWeaverError::Validation(format!(
                "cso create failed while finalizing sector compression: {error}"
            ))
        })?;
        if encoded.len() <= 11 {
            return Err(RomWeaverError::Validation(
                "cso create produced an invalid compressed sector frame".into(),
            ));
        }

        let payload = encoded[7..encoded.len() - 4].to_vec();
        if payload.len() + 12 < sector.len() {
            Ok((payload, true))
        } else {
            Ok((sector.to_vec(), false))
        }
    }

    fn encode_create_task(&self, source: &Path, task: &CsoCreateTask) -> Result<CsoEncodedTask> {
        let mut input = BufReader::new(File::open(source)?);
        let start_offset = u64::try_from(task.start_sector)
            .ok()
            .and_then(|sector| sector.checked_mul(CSO_DEFAULT_BLOCK_BYTES as u64))
            .ok_or_else(|| {
                RomWeaverError::Validation("cso create source offset overflowed".into())
            })?;
        input.seek(SeekFrom::Start(start_offset))?;

        if let Some(parent) = task.temp_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&task.temp_path)?);

        let mut sector = vec![0_u8; CSO_DEFAULT_BLOCK_BYTES];
        let mut sector_encodings = Vec::with_capacity(task.sector_count);
        for _ in 0..task.sector_count {
            input.read_exact(&mut sector)?;
            let (encoded, is_compressed) = self.compress_sector_for_create(&sector)?;
            let encoded_len = u32::try_from(encoded.len()).map_err(|_| {
                RomWeaverError::Validation("cso create encoded sector length overflowed u32".into())
            })?;
            output.write_all(&encoded)?;
            sector_encodings.push(CsoSectorEncoding {
                encoded_len,
                is_compressed,
            });
        }
        output.flush()?;

        Ok(CsoEncodedTask {
            index: task.index,
            start_sector: task.start_sector,
            temp_path: task.temp_path.clone(),
            sector_encodings,
        })
    }

    fn cleanup_create_tasks(&self, tasks: &[CsoCreateTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_path);
        }
    }

    fn assemble_create_output(
        &self,
        output_path: &Path,
        logical_bytes: u64,
        encoded_tasks: &[CsoEncodedTask],
    ) -> Result<u64> {
        let mut header = ciso::layout::CSOHeader::new();
        header.uncompressed_size = logical_bytes;

        let sector_count = header.index_table_len().saturating_sub(1);
        let index_entry_count = sector_count
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("cso index table size overflowed".into()))?;
        let index_table_len = index_entry_count
            .checked_mul(4)
            .ok_or_else(|| RomWeaverError::Validation("cso index table size overflowed".into()))?;

        let mut output = BufWriter::new(File::create(output_path)?);
        output.write_all(&header.serialize())?;
        output.write_all(&vec![0_u8; index_table_len])?;

        let align_base = 1_u64 << header.alignment;
        let align_mask = align_base - 1;
        let mut position = u64::from(header.header_size)
            .checked_add(u64::try_from(index_table_len).map_err(|_| {
                RomWeaverError::Validation("cso index table size overflowed".into())
            })?)
            .ok_or_else(|| RomWeaverError::Validation("cso output offset overflowed".into()))?;

        let mut index_table = Vec::with_capacity(index_entry_count);
        let mut expected_sector = 0_usize;
        for task in encoded_tasks {
            if task.start_sector != expected_sector {
                return Err(RomWeaverError::Validation(format!(
                    "cso create task order is invalid (expected sector {}, found {})",
                    expected_sector, task.start_sector
                )));
            }

            let mut input = BufReader::new(File::open(&task.temp_path)?);
            for sector in &task.sector_encodings {
                let align = position & align_mask;
                if align != 0 {
                    let pad = align_base - align;
                    output.write_all(&vec![
                        0_u8;
                        usize::try_from(pad).map_err(|_| {
                            RomWeaverError::Validation(
                                "cso alignment padding overflowed usize".into(),
                            )
                        })?
                    ])?;
                    position = position.saturating_add(pad);
                }

                let index_position = u32::try_from(position >> header.alignment).map_err(|_| {
                    RomWeaverError::Validation(
                        "cso output exceeded supported index table range".into(),
                    )
                })?;
                let mut entry = index_position & 0x7FFF_FFFF;
                if sector.is_compressed {
                    entry |= 0x8000_0000;
                }
                index_table.push(entry);

                let encoded_len = usize::try_from(sector.encoded_len).map_err(|_| {
                    RomWeaverError::Validation("cso encoded sector length overflowed usize".into())
                })?;
                let mut payload = vec![0_u8; encoded_len];
                input.read_exact(&mut payload)?;
                output.write_all(&payload)?;
                position = position.saturating_add(u64::from(sector.encoded_len));
                expected_sector += 1;
            }

            let mut trailing = [0_u8; 1];
            if input.read(&mut trailing)? != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "cso create task {} produced trailing bytes after encoded sectors",
                    task.index
                )));
            }
        }

        if expected_sector != sector_count {
            return Err(RomWeaverError::Validation(format!(
                "cso create encoded {} sector(s) but expected {}",
                expected_sector, sector_count
            )));
        }

        let final_position = u32::try_from(position >> header.alignment).map_err(|_| {
            RomWeaverError::Validation("cso output exceeded supported index table range".into())
        })?;
        index_table.push(final_position & 0x7FFF_FFFF);
        if index_table.len() != index_entry_count {
            return Err(RomWeaverError::Validation(
                "cso index table entry count did not match expected value".into(),
            ));
        }

        output.flush()?;
        let output_file = output.get_mut();
        output_file.seek(SeekFrom::Start(u64::from(header.header_size)))?;
        for entry in &index_table {
            output_file.write_all(&entry.to_le_bytes())?;
        }
        output.flush()?;

        Ok(fs::metadata(output_path)?.len())
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "cso codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported cso codec `{}`; supported codec is store",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported cso codec `{name}`; supported codec is store"
            ))),
        }
    }
}

impl ContainerHandler for CsoContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if file_starts_with(source, &CSO_SIGNATURE) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let compressed_bytes = fs::metadata(&request.source)?.len();
        let reader = self.open_reader(&request.source)?;
        let logical_bytes = reader.file_size();
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name, compressed_bytes, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.output_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let output_path = request.out_dir.join(&output_name);
        let reader = self.open_reader(&request.source)?;
        let logical_bytes = reader.file_size();
        let tasks = self.build_extract_tasks(logical_bytes);
        let extract_capability = cso_extract_thread_capability(Some(tasks.len().max(1)));
        let (execution, pool) = context.build_pool(extract_capability)?;
        let extract_progress_label = format!("extracting `{}`", self.descriptor.name);
        let extract_progress_bytes = Arc::new(AtomicU64::new(0));
        let extract_progress_bucket = Arc::new(AtomicU8::new(0));

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut ordered_writer = OrderedChunkWriter::new(
            BufWriter::new(File::create(&output_path)?),
            bounded_items_for_threads(execution.effective_threads),
        )?;
        let source = request.source.clone();
        let decode_result = if execution.used_parallelism {
            let progress_context = context.clone();
            let progress_execution = execution.clone();
            write_decoded_chunks_from_workers(
                &pool,
                &tasks,
                bounded_items_for_threads(execution.effective_threads),
                "cso extract output receiver closed",
                |task| {
                    let chunk = self.decode_extract_task(&source, task)?;
                    let chunk_len = u64::try_from(chunk.data.len()).map_err(|_| {
                        RomWeaverError::Validation("cso extract chunk length overflowed".into())
                    })?;
                    if chunk_len != task.len {
                        return Err(RomWeaverError::Validation(format!(
                            "cso extract chunk {} wrote {} bytes but expected {}",
                            task.index, chunk_len, task.len
                        )));
                    }
                    let chunk_index = u64::try_from(chunk.index).map_err(|_| {
                        RomWeaverError::Validation("cso extract chunk index overflowed".into())
                    })?;
                    Ok((chunk_index, chunk.data, chunk_len))
                },
                |(chunk_index, data, chunk_len)| {
                    ordered_writer.write_chunk(chunk_index, data)?;
                    if logical_bytes > 0 {
                        let completed = extract_progress_bytes
                            .fetch_add(chunk_len, Ordering::Relaxed)
                            .saturating_add(chunk_len)
                            .min(logical_bytes);
                        maybe_emit_container_byte_progress(
                            &progress_context,
                            "extract",
                            self.descriptor.name,
                            "extract",
                            completed,
                            logical_bytes,
                            &extract_progress_label,
                            Some(&progress_execution),
                            extract_progress_bucket.as_ref(),
                        );
                    }
                    Ok(())
                },
            )
        } else {
            tasks.iter().try_for_each(|task| {
                let chunk = self.decode_extract_task(&source, task)?;
                let chunk_len = u64::try_from(chunk.data.len()).map_err(|_| {
                    RomWeaverError::Validation("cso extract chunk length overflowed".into())
                })?;
                if chunk_len != task.len {
                    return Err(RomWeaverError::Validation(format!(
                        "cso extract chunk {} wrote {} bytes but expected {}",
                        task.index, chunk_len, task.len
                    )));
                }
                let chunk_index = u64::try_from(chunk.index).map_err(|_| {
                    RomWeaverError::Validation("cso extract chunk index overflowed".into())
                })?;
                ordered_writer.write_chunk(chunk_index, chunk.data)?;
                if logical_bytes > 0 {
                    let completed = extract_progress_bytes
                        .fetch_add(chunk_len, Ordering::Relaxed)
                        .saturating_add(chunk_len)
                        .min(logical_bytes);
                    maybe_emit_container_byte_progress(
                        context,
                        "extract",
                        self.descriptor.name,
                        "extract",
                        completed,
                        logical_bytes,
                        &extract_progress_label,
                        Some(&execution),
                        extract_progress_bucket.as_ref(),
                    );
                }
                Ok(())
            })
        };
        if let Err(error) = decode_result {
            let _ = fs::remove_file(&output_path);
            return Err(error);
        }
        if let Err(error) = ordered_writer.finish() {
            let _ = fs::remove_file(&output_path);
            return Err(error);
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` (1 file, {} bytes written)",
                request.source.display(),
                output_path.display(),
                logical_bytes
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
                "cso create currently requires exactly one input file".into(),
            ));
        }

        let input = &request.inputs[0];
        let _compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let logical_bytes = fs::metadata(input)?.len();
        let create_tasks = self.build_create_tasks(logical_bytes, context);
        let create_progress_label = format!("creating `{}`", self.descriptor.name);
        let create_progress_bytes = Arc::new(AtomicU64::new(0));
        let create_progress_bucket = Arc::new(AtomicU8::new(0));

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let (execution, encode_result) = if create_tasks.is_empty() {
            (
                context.plan_threads(cso_create_thread_capability(None)),
                Ok(Vec::new()),
            )
        } else {
            let create_capability = cso_create_thread_capability(Some(create_tasks.len().max(1)));
            let (execution, pool) = context.build_pool(create_capability)?;
            let source = input.clone();
            let encode_result = if execution.used_parallelism {
                let progress_context = context.clone();
                let progress_execution = execution.clone();
                let create_progress_bytes = Arc::clone(&create_progress_bytes);
                let create_progress_bucket = Arc::clone(&create_progress_bucket);
                pool.install(|| {
                    create_tasks
                        .par_iter()
                        .map(|task| {
                            let encoded = self.encode_create_task(&source, task)?;
                            if logical_bytes > 0 {
                                let task_logical_bytes =
                                    self.create_task_logical_bytes(task, logical_bytes)?;
                                let completed = create_progress_bytes
                                    .fetch_add(task_logical_bytes, Ordering::Relaxed)
                                    .saturating_add(task_logical_bytes)
                                    .min(logical_bytes);
                                maybe_emit_container_byte_progress(
                                    &progress_context,
                                    "compress",
                                    self.descriptor.name,
                                    "create",
                                    completed,
                                    logical_bytes,
                                    &create_progress_label,
                                    Some(&progress_execution),
                                    create_progress_bucket.as_ref(),
                                );
                            }
                            Ok(encoded)
                        })
                        .collect::<Result<Vec<_>>>()
                })
            } else {
                create_tasks
                    .iter()
                    .map(|task| {
                        let encoded = self.encode_create_task(&source, task)?;
                        if logical_bytes > 0 {
                            let task_logical_bytes =
                                self.create_task_logical_bytes(task, logical_bytes)?;
                            let completed = create_progress_bytes
                                .fetch_add(task_logical_bytes, Ordering::Relaxed)
                                .saturating_add(task_logical_bytes)
                                .min(logical_bytes);
                            maybe_emit_container_byte_progress(
                                context,
                                "compress",
                                self.descriptor.name,
                                "create",
                                completed,
                                logical_bytes,
                                &create_progress_label,
                                Some(&execution),
                                create_progress_bucket.as_ref(),
                            );
                        }
                        Ok(encoded)
                    })
                    .collect::<Result<Vec<_>>>()
            };
            (execution, encode_result)
        };

        let mut encoded_tasks = match encode_result {
            Ok(tasks) => tasks,
            Err(error) => {
                self.cleanup_create_tasks(&create_tasks);
                return Err(error);
            }
        };
        encoded_tasks.sort_by_key(|task| task.start_sector);
        let output_bytes =
            match self.assemble_create_output(&request.output, logical_bytes, &encoded_tasks) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.cleanup_create_tasks(&create_tasks);
                    return Err(error);
                }
            };
        self.cleanup_create_tasks(&create_tasks);

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} `{}` from `{}` (codec=store, {} bytes)",
                self.descriptor.name,
                request.output.display(),
                input.display(),
                output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: cso_extract_thread_capability(None),
            create_threads: cso_create_thread_capability(None),
        }
    }
}
/* jscpd:ignore-end */
