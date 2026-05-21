struct SevenZContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl SevenZContainerHandler {
    const DEFAULT_CODEC_LEVEL: u32 = 6;
    const LZMA2_MT_CHUNK_BYTES: u64 = 1 << 20;
    const ZSTD_LEVEL_MAP: [u32; 10] = [1, 3, 5, 7, 9, 11, 13, 15, 18, 22];
    const BROTLI_QUALITY_MAP: [u32; 10] = [0, 1, 3, 4, 5, 6, 7, 8, 10, 11];
    const LZ4_SKIPPABLE_FRAME_BYTES: [u32; 10] = [
        0,
        64 * 1024,
        128 * 1024,
        256 * 1024,
        512 * 1024,
        1024 * 1024,
        2 * 1024 * 1024,
        4 * 1024 * 1024,
        8 * 1024 * 1024,
        16 * 1024 * 1024,
    ];

    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_reader(&self, source: &Path) -> Result<SevenZReader<File>> {
        let file = File::open(source)?;
        SevenZReader::new(file, SevenZPassword::empty())
            .map_err(|error| RomWeaverError::Validation(format!("7z archive is invalid: {error}")))
    }

    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
        execution: &rom_weaver_core::ThreadExecution,
    ) -> Result<SevenZMethodConfiguration> {
        let codec = match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => CanonicalCodec::Lzma2,
            RequestedCodec::Known(codec) => codec,
            RequestedCodec::Unknown(name) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported 7z codec `{name}`; supported codecs are lzma2, lzma, store, zstd, deflate, bzip2, lz4, brotli, and ppmd"
                )));
            }
        };

        if !matches!(
            codec,
            CanonicalCodec::Lzma2
                | CanonicalCodec::Lzma
                | CanonicalCodec::Store
                | CanonicalCodec::Zstd
                | CanonicalCodec::Deflate
                | CanonicalCodec::Bzip2
                | CanonicalCodec::Lz4
                | CanonicalCodec::Brotli
                | CanonicalCodec::Ppmd
        ) {
            return Err(RomWeaverError::Validation(format!(
                "unsupported 7z codec `{}`; supported codecs are lzma2, lzma, store, zstd, deflate, bzip2, lz4, brotli, and ppmd",
                codec.name()
            )));
        }

        let level = Self::parse_level(level)?;
        if codec == CanonicalCodec::Store && level.is_some() {
            return Err(RomWeaverError::Validation(
                "7z codec `store` does not accept --level".into(),
            ));
        }

        let level = level.unwrap_or(Self::DEFAULT_CODEC_LEVEL);
        let method = match codec {
            CanonicalCodec::Lzma2 => {
                let mut method = SevenZMethodConfiguration::new(SevenZMethod::LZMA2);
                let options = if execution.used_parallelism {
                    SevenZLzma2Options::from_level_mt(
                        level,
                        self.thread_count(execution.effective_threads),
                        Self::LZMA2_MT_CHUNK_BYTES,
                    )
                } else {
                    SevenZLzma2Options::from_level(level)
                };
                method = method.with_options(options.into());
                method
            }
            CanonicalCodec::Lzma => SevenZMethodConfiguration::new(SevenZMethod::LZMA)
                .with_options(SevenZEncoderOptions::Lzma(SevenZLzmaOptions::from_level(
                    level,
                ))),
            CanonicalCodec::Store => SevenZMethodConfiguration::new(SevenZMethod::COPY),
            CanonicalCodec::Zstd => SevenZMethodConfiguration::new(SevenZMethod::ZSTD)
                .with_options(SevenZZstdOptions::from_level(Self::map_zstd_level(level)).into()),
            CanonicalCodec::Deflate => SevenZMethodConfiguration::new(SevenZMethod::DEFLATE)
                .with_options(SevenZDeflateOptions::from_level(level).into()),
            CanonicalCodec::Bzip2 => SevenZMethodConfiguration::new(SevenZMethod::BZIP2)
                .with_options(SevenZBzip2Options::from_level(level.max(1)).into()),
            CanonicalCodec::Lz4 => SevenZMethodConfiguration::new(SevenZMethod::LZ4).with_options(
                SevenZLz4Options::default()
                    .with_skippable_frame_size(Self::map_lz4_skippable_frame_size(level))
                    .into(),
            ),
            CanonicalCodec::Brotli => SevenZMethodConfiguration::new(SevenZMethod::BROTLI)
                .with_options(
                    SevenZBrotliOptions::from_quality_window(Self::map_brotli_quality(level), 22)
                        .into(),
                ),
            CanonicalCodec::Ppmd => SevenZMethodConfiguration::new(SevenZMethod::PPMD)
                .with_options(SevenZPpmdOptions::from_level(level).into()),
            CanonicalCodec::Huffman => {
                return Err(RomWeaverError::Validation(
                    "unsupported 7z codec `huffman`; supported codecs are lzma2, lzma, store, zstd, deflate, bzip2, lz4, brotli, and ppmd".to_string(),
                ));
            }
        };

        Ok(method)
    }

    fn parse_level(level: Option<i32>) -> Result<Option<u32>> {
        let Some(level) = level else {
            return Ok(None);
        };
        if !(0..=9).contains(&level) {
            return Err(RomWeaverError::Validation(format!(
                "7z level `{level}` is out of range (0..=9)"
            )));
        }
        Ok(Some(level as u32))
    }

    const fn map_zstd_level(level: u32) -> u32 {
        Self::ZSTD_LEVEL_MAP[level as usize]
    }

    const fn map_brotli_quality(level: u32) -> u32 {
        Self::BROTLI_QUALITY_MAP[level as usize]
    }

    const fn map_lz4_skippable_frame_size(level: u32) -> u32 {
        Self::LZ4_SKIPPABLE_FRAME_BYTES[level as usize]
    }

    fn thread_count(&self, effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn method_name(method: &SevenZMethodConfiguration) -> &'static str {
        match method.method {
            SevenZMethod::COPY => "store",
            SevenZMethod::LZMA2 => "lzma2",
            SevenZMethod::LZMA => "lzma",
            SevenZMethod::ZSTD => "zstd",
            SevenZMethod::DEFLATE => "deflate",
            SevenZMethod::BZIP2 => "bzip2",
            SevenZMethod::LZ4 => "lz4",
            SevenZMethod::BROTLI => "brotli",
            SevenZMethod::PPMD => "ppmd",
            _ => "unknown",
        }
    }

    fn create_archive_entry(&self, entry: &ArchiveInputEntry) -> SevenZArchiveEntry {
        #[cfg(target_family = "wasm")]
        {
            // Avoid filesystem timestamp conversion in sevenz-rust on wasm, which can panic on
            // platforms that cannot represent pre-UNIX-EPOCH SystemTime values.
            if entry.is_dir {
                SevenZArchiveEntry::new_directory(&entry.archive_name)
            } else {
                SevenZArchiveEntry::new_file(&entry.archive_name)
            }
        }
        #[cfg(not(target_family = "wasm"))]
        {
            SevenZArchiveEntry::from_path(&entry.source, entry.archive_name.clone())
        }
    }
}

impl ContainerHandler for SevenZContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        let mut signature = [0u8; SEVEN_Z_SIGNATURE.len()];
        if let Ok(mut file) = File::open(source) {
            if file.read_exact(&mut signature).is_ok() && signature == SEVEN_Z_SIGNATURE {
                return ProbeConfidence::Signature;
            }
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let reader = self.open_reader(&request.source)?;
        let archive = reader.archive();
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut compressed_bytes = 0u64;
        let mut logical_bytes = 0u64;

        for entry in &archive.files {
            if entry.is_directory() {
                directories += 1;
            } else {
                files += 1;
            }
            compressed_bytes = compressed_bytes.saturating_add(entry.compressed_size);
            logical_bytes = logical_bytes.saturating_add(entry.size());
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "7z: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                archive.files.len(),
                files,
                directories,
                compressed_bytes,
                logical_bytes
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
        let reader = self.open_reader(&request.source)?;
        let archive = reader.archive();
        let mut entries = Vec::new();
        for entry in &archive.files {
            let entry_name = normalize_archive_name(entry.name());
            if !entry_name.is_empty() {
                entries.push(entry_name);
            }
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        fs::create_dir_all(&request.out_dir)?;

        let mut reader = self.open_reader(&request.source)?;
        reader.set_thread_count(self.thread_count(execution.effective_threads));
        let mut preview_selections = SelectionMatcher::new(&request.selections);
        let total_selected_entries = reader
            .archive()
            .files
            .iter()
            .filter(|entry| {
                let entry_name = normalize_archive_name(entry.name());
                !entry_name.is_empty() && preview_selections.matches(&entry_name)
            })
            .count();
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;
        let mut selected_entries_completed = 0usize;

        if total_selected_entries > 0 {
            emit_container_running_progress(
                context,
                "extract",
                self.descriptor.name,
                "extract",
                format!(
                    "extracting `{}` ({} selected entries)",
                    self.descriptor.name, total_selected_entries
                ),
                0.0,
                Some(&execution),
            );
        }

        reader
            .for_each_entries(|entry, source| {
                let entry_name = normalize_archive_name(entry.name());
                if entry_name.is_empty() || !selections.matches(&entry_name) {
                    if entry.size() > 0 {
                        io::copy(source, &mut io::sink())?;
                    }
                    return Ok(true);
                }

                let relative = sanitize_archive_relative_path_from_str(entry.name())
                    .map_err(|error| io::Error::other(error.to_string()))?;
                let output_path = request.out_dir.join(relative);

                if entry.is_directory() {
                    fs::create_dir_all(&output_path)?;
                    selected_entries_completed = selected_entries_completed.saturating_add(1);
                    emit_container_step_progress(
                        context,
                        "extract",
                        self.descriptor.name,
                        "extract",
                        selected_entries_completed,
                        total_selected_entries,
                        format!(
                            "extracting `{}` ({}/{})",
                            self.descriptor.name,
                            selected_entries_completed,
                            total_selected_entries
                        ),
                        Some(&execution),
                    );
                    return Ok(true);
                }

                if let Some(parent) = output_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut output = BufWriter::new(File::create(&output_path)?);
                let copied = io::copy(source, &mut output)?;
                extracted_files += 1;
                written_bytes = written_bytes.saturating_add(copied);
                selected_entries_completed = selected_entries_completed.saturating_add(1);
                emit_container_step_progress(
                    context,
                    "extract",
                    self.descriptor.name,
                    "extract",
                    selected_entries_completed,
                    total_selected_entries,
                    format!(
                        "extracting `{}` ({}/{})",
                        self.descriptor.name, selected_entries_completed, total_selected_entries
                    ),
                    Some(&execution),
                );
                Ok(true)
            })
            .map_err(|error| RomWeaverError::Validation(format!("7z extract failed: {error}")))?;

        selections.ensure_all_matched()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} file(s), {} bytes written)",
                request.source.display(),
                request.out_dir.display(),
                extracted_files,
                written_bytes
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
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let method = self.parse_codec(request.codec.as_deref(), request.level, &execution)?;
        let entries = collect_archive_inputs(&request.inputs)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let output = File::create(&request.output)?;
        let mut writer = SevenZWriter::new(output).map_err(|error| {
            RomWeaverError::Validation(format!("7z create failed to initialize writer: {error}"))
        })?;
        writer.set_content_methods(vec![method.clone()]);

        let mut logical_bytes = 0u64;
        let total_entries = entries.len();
        for (entry_index, entry) in entries.iter().enumerate() {
            let archive_entry = self.create_archive_entry(entry);
            if entry.is_dir {
                writer
                    .push_archive_entry::<&[u8]>(archive_entry, None)
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "7z create failed for `{}`: {error}",
                            entry.archive_name
                        ))
                    })?;
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
                    Some(&execution),
                );
                continue;
            }

            writer
                .push_archive_entry(
                    archive_entry,
                    Some({
                        File::open(&entry.source)?
                    }),
                )
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "7z create failed for `{}`: {error}",
                        entry.archive_name
                    ))
                })?;
            logical_bytes = logical_bytes.saturating_add(fs::metadata(&entry.source)?.len());
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
                Some(&execution),
            );
        }

        writer.finish().map_err(|error| {
            RomWeaverError::Validation(format!(
                "7z create failed while finalizing archive: {error}"
            ))
        })?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                Self::method_name(&method),
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
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}
