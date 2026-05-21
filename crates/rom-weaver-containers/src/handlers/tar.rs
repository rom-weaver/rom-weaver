#[derive(Clone, Copy, Debug)]
enum TarCompression {
    None,
    Gzip,
    Bzip2,
    Xz,
}

struct TarContainerHandler {
    descriptor: &'static FormatDescriptor,
    compression: TarCompression,
}

#[derive(Clone, Debug)]
struct TarCreateTask {
    entry_index: usize,
    source: PathBuf,
    archive_name: String,
    is_dir: bool,
    temp_archive: PathBuf,
}

#[derive(Clone, Debug)]
struct TarCreateArtifact {
    entry_index: usize,
    archive_name: String,
    logical_bytes: u64,
    temp_archive: PathBuf,
}

impl TarContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor, compression: TarCompression) -> Self {
        Self {
            descriptor,
            compression,
        }
    }

    fn parse_codec_and_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<u32> {
        let codec = parse_requested_codec(codec);
        match self.compression {
            TarCompression::None => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar codec `{}`; use store or omit --codec",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar codec `{codec}`; use store or omit --codec"
                        )));
                    }
                }
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "tar does not accept --level".into(),
                    ));
                }
                Ok(0)
            }
            TarCompression::Gzip => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Deflate) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.gz codec `{}`; use gzip",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.gz codec `{codec}`; use gzip"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.gz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            TarCompression::Bzip2 => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Bzip2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.bz2 codec `{}`; use bzip2",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.bz2 codec `{codec}`; use bzip2"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (1..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.bz2 level `{value}` is out of range (1..=9)"
                    ))),
                }
            }
            TarCompression::Xz => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Lzma)
                    | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.xz codec `{}`; use xz",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.xz codec `{codec}`; use xz"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.xz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
        }
    }

    fn backend_codec_name(&self) -> Option<&'static str> {
        match self.compression {
            TarCompression::None => None,
            TarCompression::Gzip => Some("deflate"),
            TarCompression::Bzip2 => Some("bzip2"),
            TarCompression::Xz => Some("lzma2"),
        }
    }

    fn codec_backend(&self) -> Result<Arc<dyn CodecBackend>> {
        let codec_name = self.backend_codec_name().ok_or_else(|| {
            RomWeaverError::Unsupported(format!(
                "codec backend is not defined for {}",
                self.descriptor.name
            ))
        })?;
        resolve_container_codec_backend(self.descriptor.name, codec_name)
    }

    fn append_entries<W: Write>(
        &self,
        builder: &mut TarBuilder<W>,
        entries: &[ArchiveInputEntry],
        context: &OperationContext,
        execution: &ThreadExecution,
    ) -> Result<u64> {
        let mut logical_bytes = 0u64;
        let total_entries = entries.len();
        for (entry_index, entry) in entries.iter().enumerate() {
            if entry.is_dir {
                builder.append_dir(&entry.archive_name, &entry.source)?;
            } else {
                builder.append_path_with_name(&entry.source, &entry.archive_name)?;
                logical_bytes = logical_bytes.saturating_add(fs::metadata(&entry.source)?.len());
            }
            emit_container_step_progress(
                context,
                "compress",
                self.descriptor.name,
                "create",
                entry_index.saturating_add(1),
                total_entries,
                format!(
                    "creating `{}` ({}/{})",
                    self.descriptor.name,
                    entry_index.saturating_add(1),
                    total_entries
                ),
                Some(execution),
            );
        }
        Ok(logical_bytes)
    }

    fn build_uncompressed_create_tasks(
        &self,
        entries: &[ArchiveInputEntry],
        context: &OperationContext,
    ) -> Vec<TarCreateTask> {
        entries
            .iter()
            .enumerate()
            .map(|(entry_index, entry)| TarCreateTask {
                entry_index,
                source: entry.source.clone(),
                archive_name: entry.archive_name.clone(),
                is_dir: entry.is_dir,
                temp_archive: context.temp_paths().next_path(
                    &format!("{}-create-{entry_index}", self.descriptor.name),
                    Some("tar"),
                ),
            })
            .collect()
    }

    fn stage_uncompressed_create_task(&self, task: &TarCreateTask) -> Result<TarCreateArtifact> {
        if let Some(parent) = task.temp_archive.parent() {
            fs::create_dir_all(parent)?;
        }
        let output = BufWriter::new(File::create(&task.temp_archive)?);
        let mut builder = TarBuilder::new(output);
        if task.is_dir {
            builder.append_dir(&task.archive_name, &task.source)?;
        } else {
            builder.append_path_with_name(&task.source, &task.archive_name)?;
        }
        builder.finish()?;

        Ok(TarCreateArtifact {
            entry_index: task.entry_index,
            archive_name: task.archive_name.clone(),
            logical_bytes: if task.is_dir {
                0
            } else {
                fs::metadata(&task.source)?.len()
            },
            temp_archive: task.temp_archive.clone(),
        })
    }

    fn merge_uncompressed_create_artifact<W: Write>(
        &self,
        output: &mut W,
        artifact: &TarCreateArtifact,
    ) -> Result<()> {
        let staged_len = fs::metadata(&artifact.temp_archive)?.len();
        if staged_len < 1024 {
            return Err(RomWeaverError::Validation(format!(
                "{} create failed while finalizing staged entry `{}`",
                self.descriptor.name, artifact.archive_name
            )));
        }
        let payload_len = staged_len.saturating_sub(1024);
        let mut staged = BufReader::new(File::open(&artifact.temp_archive)?);
        let copied = io::copy(&mut staged.by_ref().take(payload_len), output).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed while reading staged entry `{}`: {error}",
                self.descriptor.name, artifact.archive_name
            ))
        })?;
        if copied != payload_len {
            return Err(RomWeaverError::Validation(format!(
                "{} create failed while reading staged entry `{}`: expected {} bytes, copied {} bytes",
                self.descriptor.name, artifact.archive_name, payload_len, copied
            )));
        }
        Ok(())
    }

    fn cleanup_uncompressed_create_tasks(&self, tasks: &[TarCreateTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_archive);
        }
    }

    fn cleanup_uncompressed_create_artifacts(&self, artifacts: &[TarCreateArtifact]) {
        for artifact in artifacts {
            let _ = fs::remove_file(&artifact.temp_archive);
        }
    }

    fn xz_thread_count(effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn open_reader_with_execution(
        &self,
        source: &Path,
        execution: Option<&mut ThreadExecution>,
    ) -> Result<Box<dyn Read>> {
        let reader: Box<dyn Read> = match self.compression {
            TarCompression::None => Box::new(BufReader::new(File::open(source)?)),
            TarCompression::Gzip => {
                Box::new(MultiGzDecoder::new(BufReader::new(File::open(source)?)))
            }
            TarCompression::Bzip2 => {
                Box::new(Bzip2Decoder::new(BufReader::new(File::open(source)?)))
            }
            TarCompression::Xz => {
                if let Some(execution) = execution {
                    if execution.used_parallelism {
                        let workers = Self::xz_thread_count(execution.effective_threads);
                        let source_reader = BufReader::new(File::open(source)?);
                        match XzReaderMt::new(source_reader, false, workers) {
                            Ok(reader) => Box::new(reader),
                            Err(error) => {
                                execution.apply_pool_fallback(format!(
                                    "tar.xz decoder rejected multithread setting: {error}"
                                ));
                                Box::new(XzReader::new(BufReader::new(File::open(source)?), false))
                            }
                        }
                    } else {
                        Box::new(XzReader::new(BufReader::new(File::open(source)?), false))
                    }
                } else {
                    Box::new(XzReader::new(BufReader::new(File::open(source)?), false))
                }
            }
        };
        Ok(reader)
    }

    fn open_reader(&self, source: &Path) -> Result<Box<dyn Read>> {
        self.open_reader_with_execution(source, None)
    }

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            TarCompression::None
            | TarCompression::Gzip
            | TarCompression::Bzip2
            | TarCompression::Xz => ThreadCapability::parallel(None),
        }
    }

    fn create_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            TarCompression::None
            | TarCompression::Gzip
            | TarCompression::Bzip2
            | TarCompression::Xz => ThreadCapability::parallel(None),
        }
    }

    fn inspect_archive_reader<R: Read>(&self, reader: R) -> Result<(usize, usize, usize, u64)> {
        let mut archive = TarArchive::new(reader);
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        let mut entries_total = 0usize;
        for entry in archive.entries()? {
            let entry = entry?;
            entries_total += 1;
            let entry_type = entry.header().entry_type();
            if entry_type.is_dir() {
                directories += 1;
            } else if entry_type.is_file() {
                files += 1;
                logical_bytes = logical_bytes.saturating_add(entry.header().size()?);
            }
        }
        Ok((entries_total, files, directories, logical_bytes))
    }

    fn inspect_uncompressed_archive(&self, source: &Path) -> Result<(usize, usize, usize, u64)> {
        self.inspect_archive_reader(BufReader::new(File::open(source)?))
    }

    fn list_entries_from_reader<R: Read>(&self, reader: R) -> Result<Vec<String>> {
        let mut archive = TarArchive::new(reader);
        let mut entries = Vec::new();
        for entry in archive.entries()? {
            let entry = entry?;
            let raw_path = entry.path()?;
            let relative = sanitize_archive_relative_path(raw_path.as_ref())?;
            let archive_name = archive_path_to_name(&relative)?;
            if !archive_name.is_empty() {
                entries.push(archive_name);
            }
        }
        Ok(entries)
    }

    fn list_uncompressed_entries(&self, source: &Path) -> Result<Vec<String>> {
        self.list_entries_from_reader(BufReader::new(File::open(source)?))
    }

    fn looks_like_tar_archive(&self, source: &Path) -> bool {
        let mut reader = match self.open_reader(source) {
            Ok(reader) => reader,
            Err(_) => return false,
        };
        let mut header = [0u8; 512];
        reader.read_exact(&mut header).is_ok() && is_ustar_header(&header)
    }
}

impl ContainerHandler for TarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.looks_like_tar_archive(source) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let (entries_total, files, directories, logical_bytes) =
            if matches!(self.compression, TarCompression::None) {
                self.inspect_uncompressed_archive(&request.source)?
            } else {
                let mut execution = context.plan_threads(self.extract_thread_capability());
                let reader =
                    self.open_reader_with_execution(&request.source, Some(&mut execution))?;
                self.inspect_archive_reader(reader)?
            };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes uncompressed",
                self.descriptor.name, entries_total, files, directories, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        if matches!(self.compression, TarCompression::None) {
            return self.list_uncompressed_entries(&request.source);
        }
        let mut execution = context.plan_threads(self.extract_thread_capability());
        let reader = self.open_reader_with_execution(&request.source, Some(&mut execution))?;
        self.list_entries_from_reader(reader)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        extract_regular_archive_with_libarchive(request, context, self.descriptor.name, true)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut execution = context.plan_threads(self.create_thread_capability());
        let level = self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let logical_bytes = match self.compression {
            TarCompression::None => {
                let create_tasks = self.build_uncompressed_create_tasks(&entries, context);
                if create_tasks.is_empty() || !execution.used_parallelism {
                    let output = BufWriter::new(File::create(&request.output)?);
                    let mut builder = TarBuilder::new(output);
                    let bytes = self.append_entries(&mut builder, &entries, context, &execution)?;
                    builder.finish()?;
                    bytes
                } else {
                    let (create_execution, pool) =
                        context.build_pool(ThreadCapability::parallel(Some(create_tasks.len())))?;
                    execution = create_execution;
                    let completed_tasks = Arc::new(AtomicUsize::new(0));
                    let progress_context = context.clone();
                    let progress_execution = execution.clone();
                    let progress_format = self.descriptor.name;
                    let total_create_tasks = create_tasks.len();
                    let staged_result = if execution.used_parallelism {
                        pool.install(|| {
                            create_tasks
                                .par_iter()
                                .map(|task| {
                                    let artifact = self.stage_uncompressed_create_task(task)?;
                                    let completed = completed_tasks
                                        .fetch_add(1, Ordering::Relaxed)
                                        .saturating_add(1);
                                    emit_container_step_progress(
                                        &progress_context,
                                        "compress",
                                        progress_format,
                                        "create",
                                        completed,
                                        total_create_tasks,
                                        format!(
                                            "creating `{}` ({}/{})",
                                            progress_format, completed, total_create_tasks
                                        ),
                                        Some(&progress_execution),
                                    );
                                    Ok(artifact)
                                })
                                .collect::<Result<Vec<_>>>()
                        })
                    } else {
                        create_tasks
                            .iter()
                            .map(|task| {
                                let artifact = self.stage_uncompressed_create_task(task)?;
                                let completed = completed_tasks
                                    .fetch_add(1, Ordering::Relaxed)
                                    .saturating_add(1);
                                emit_container_step_progress(
                                    &progress_context,
                                    "compress",
                                    progress_format,
                                    "create",
                                    completed,
                                    total_create_tasks,
                                    format!(
                                        "creating `{}` ({}/{})",
                                        progress_format, completed, total_create_tasks
                                    ),
                                    Some(&progress_execution),
                                );
                                Ok(artifact)
                            })
                            .collect::<Result<Vec<_>>>()
                    };
                    let mut staged_artifacts = match staged_result {
                        Ok(artifacts) => artifacts,
                        Err(error) => {
                            self.cleanup_uncompressed_create_tasks(&create_tasks);
                            return Err(error);
                        }
                    };
                    staged_artifacts.sort_by_key(|artifact| artifact.entry_index);

                    let create_result: Result<u64> = (|| {
                        let output = BufWriter::new(File::create(&request.output)?);
                        let mut output = output;
                        let mut logical_bytes = 0u64;
                        let mut staged_iter = staged_artifacts.iter();

                        for (entry_index, entry) in entries.iter().enumerate() {
                            let staged = staged_iter.next().ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{} create failed while finalizing staged entries for `{}`",
                                    self.descriptor.name, entry.archive_name
                                ))
                            })?;
                            if staged.entry_index != entry_index {
                                return Err(RomWeaverError::Validation(format!(
                                    "{} create failed due to staged entry order mismatch for `{}`",
                                    self.descriptor.name, entry.archive_name
                                )));
                            }
                            self.merge_uncompressed_create_artifact(&mut output, staged)?;
                            logical_bytes = logical_bytes.saturating_add(staged.logical_bytes);
                        }
                        if staged_iter.next().is_some() {
                            return Err(RomWeaverError::Validation(format!(
                                "{} create failed due to unexpected staged entries",
                                self.descriptor.name
                            )));
                        }
                        output.write_all(&[0u8; 1024])?;
                        output.flush()?;
                        Ok(logical_bytes)
                    })();
                    self.cleanup_uncompressed_create_artifacts(&staged_artifacts);
                    create_result?
                }
            }
            TarCompression::Gzip | TarCompression::Bzip2 | TarCompression::Xz => {
                let staged_label = match self.compression {
                    TarCompression::None => unreachable!(),
                    TarCompression::Gzip => "tar-gz-create-stage",
                    TarCompression::Bzip2 => "tar-bz2-create-stage",
                    TarCompression::Xz => "tar-xz-create-stage",
                };
                let staged_tar = context.temp_paths().next_path(staged_label, Some("tar"));
                let staged_result = (|| -> Result<(u64, Option<ThreadExecution>)> {
                    if let Some(parent) = staged_tar.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let staged_output = BufWriter::new(File::create(&staged_tar)?);
                    let mut builder = TarBuilder::new(staged_output);
                    let bytes = self.append_entries(&mut builder, &entries, context, &execution)?;
                    let mut staged_output = builder.into_inner().map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "{} create failed while finalizing staged archive: {error}",
                            self.descriptor.name
                        ))
                    })?;
                    staged_output.flush()?;
                    drop(staged_output);

                    let backend = self.codec_backend()?;
                    let level = i32::try_from(level).map_err(|_| {
                        RomWeaverError::Validation("tar compression level exceeded i32".into())
                    })?;
                    let encode_report = backend.encode(
                        &CodecOperationRequest {
                            input: staged_tar.clone(),
                            output: request.output.clone(),
                            level: Some(level),
                        },
                        context,
                    )?;
                    if encode_report.status != OperationStatus::Succeeded {
                        return Err(RomWeaverError::Unsupported(encode_report.label));
                    }
                    Ok((bytes, encode_report.thread_execution))
                })();
                let _ = fs::remove_file(&staged_tar);
                let (bytes, encode_execution) = staged_result?;
                if let Some(encode_execution) = encode_execution {
                    execution = encode_execution;
                }
                bytes
            }
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                logical_bytes
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
            extract_threads: self.extract_thread_capability(),
            create_threads: self.create_thread_capability(),
        }
    }
}
