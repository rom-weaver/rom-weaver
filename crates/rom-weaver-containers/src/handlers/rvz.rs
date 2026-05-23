struct RvzContainerHandler;

impl RvzContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn negotiated_threads(&self, used_parallelism: bool, effective_threads: usize) -> usize {
        if used_parallelism {
            effective_threads
        } else {
            0
        }
    }

    fn open_disc(&self, source: &Path) -> Result<NodDiscReader> {
        self.open_disc_with_threads(source, 0)
    }

    fn open_disc_with_threads(&self, source: &Path, preloader_threads: usize) -> Result<NodDiscReader> {
        let options = self.read_options(preloader_threads);
        #[cfg(target_arch = "wasm32")]
        let result = File::open(source)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open rvz source `{}`: {error}",
                    source.display()
                ))
            })
            .and_then(|file| {
                NodDiscReader::new_from_non_cloneable_read(file, &options).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to open rvz source `{}`: {error}",
                        source.display()
                    ))
                })
            });
        #[cfg(not(target_arch = "wasm32"))]
        let result = NodDiscReader::new(source, &options).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open rvz source `{}`: {error}",
                source.display()
            ))
        });
        result
    }

    fn validate_rvz_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Rvz {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not an rvz container (detected {})",
                source.display(),
                meta.format
            )))
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }

    fn create_extract_output(&self, output_path: &Path) -> Result<File> {
        match File::create(output_path) {
            Ok(file) => Ok(file),
            Err(error) if error.raw_os_error() == Some(69) => OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(output_path)
                .map_err(RomWeaverError::from),
            Err(error) => Err(RomWeaverError::from(error)),
        }
    }

    fn copy_extract_with_progress<R: Read, W: Write>(
        &self,
        reader: &mut R,
        writer: &mut W,
        total_bytes: u64,
        context: &OperationContext,
        execution: &ThreadExecution,
    ) -> Result<u64> {
        let buffer_size = if total_bytes == 0 {
            64 * 1024
        } else {
            ((total_bytes / 100).max(16 * 1024).min(1024 * 1024)) as usize
        };

        let mut buffer = vec![0_u8; buffer_size];
        let mut bytes_written = 0_u64;
        let mut last_emitted_percent = -1.0_f32;

        emit_container_running_progress(
            context,
            "extract",
            RVZ.name,
            "extract",
            "extracting rvz",
            0.0,
            Some(execution),
        );

        loop {
            let bytes_read = reader.read(&mut buffer)?;
            if bytes_read == 0 {
                break;
            }
            writer.write_all(&buffer[..bytes_read])?;
            bytes_written = bytes_written.saturating_add(bytes_read as u64);

            if total_bytes == 0 {
                continue;
            }

            let percent = ((bytes_written.min(total_bytes) as f32 / total_bytes as f32) * 100.0)
                .clamp(0.0, 100.0);
            if percent < 100.0 && percent - last_emitted_percent >= 1.0 {
                last_emitted_percent = percent;
                emit_container_running_progress(
                    context,
                    "extract",
                    RVZ.name,
                    "extract",
                    format!("extracting rvz ({percent:.0}%)"),
                    percent,
                    Some(execution),
                );
            }
        }

        Ok(bytes_written)
    }

    fn to_u8_level(&self, level: i32, codec: &str) -> Result<u8> {
        if level < 0 {
            return Err(RomWeaverError::Validation(format!(
                "rvz codec `{codec}` requires a non-negative level"
            )));
        }
        u8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!("rvz codec `{codec}` level `{level}` is too large"))
        })
    }

    fn to_i8_level(&self, level: i32, codec: &str) -> Result<i8> {
        i8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!(
                "rvz codec `{codec}` level `{level}` is out of range"
            ))
        })
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => {
                let mut compression = NodFormat::Rvz.default_compression();
                if let Some(level) = level {
                    compression = NodCompression::Zstandard(self.to_i8_level(level, "zstd")?);
                }
                Ok(compression)
            }
            RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "rvz codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(CanonicalCodec::Bzip2) => Ok(NodCompression::Bzip2(
                self.to_u8_level(level.unwrap_or(0), "bzip2")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma) => Ok(NodCompression::Lzma(
                self.to_u8_level(level.unwrap_or(0), "lzma")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma2) => Ok(NodCompression::Lzma2(
                self.to_u8_level(level.unwrap_or(0), "lzma2")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(NodCompression::Zstandard(
                self.to_i8_level(level.unwrap_or(0), "zstd")?,
            )),
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported rvz codec `{}`; supported codecs are store, zstd, bzip2, lzma, and lzma2",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported rvz codec `{name}`; supported codecs are store, zstd, bzip2, lzma, and lzma2"
            ))),
        }
    }

    fn process_create_attempt(
        &self,
        input: &Path,
        output_path: &Path,
        options: &NodFormatOptions,
        preloader_threads: usize,
        processor_threads: usize,
        context: &OperationContext,
        execution: &ThreadExecution,
    ) -> Result<u64> {
        let input_disc =
            NodDiscReader::new(input, &self.read_options(preloader_threads)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for rvz create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize rvz writer: {error}"))
        })?;

        let mut output = File::create(output_path)?;
        let mut process_options = NodProcessOptions::default();
        process_options.processor_threads = processor_threads;
        let mut last_emitted_percent = -1.0_f32;
        let finalization = writer
            .process(
                |data, processed, total| {
                    output.write_all(data.as_ref())?;
                    if total > 0 {
                        let processed_bytes = processed.saturating_add(data.as_ref().len() as u64);
                        let percent = ((processed_bytes.min(total) as f32 / total as f32) * 100.0)
                            .clamp(0.0, 100.0);
                        if percent < 100.0 && percent - last_emitted_percent >= 1.0 {
                            last_emitted_percent = percent;
                            emit_container_running_progress(
                                context,
                                "compress",
                                RVZ.name,
                                "create",
                                format!("creating rvz ({percent:.0}%)"),
                                percent,
                                Some(execution),
                            );
                        }
                    }
                    Ok(())
                },
                &process_options,
            )
            .map_err(|error| RomWeaverError::Validation(format!("rvz create failed: {error}")))?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        Ok(fs::metadata(output_path)?.len())
    }
}

impl ContainerHandler for RvzContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &RVZ
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Rvz
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let disc = self.open_disc(&request.source)?;
        let meta = self.validate_rvz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "inspect",
            format!(
                "rvz: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
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
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let mut disc = self.open_disc_with_threads(&request.source, preloader_threads)?;
        let meta = self.validate_rvz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        if !request.out_dir.exists() {
            fs::create_dir_all(&request.out_dir)?;
        }
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(self.create_extract_output(&output_path)?);
        let bytes_written =
            self.copy_extract_with_progress(&mut disc, &mut output, disc_size, context, &execution)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                request.source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
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
                "rvz create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Rvz,
            compression,
            block_size: NodFormat::Rvz.default_block_size(),
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let processor_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let output_bytes = self.process_create_attempt(
            input,
            &request.output,
            &options,
            preloader_threads,
            processor_threads,
            context,
            &execution,
        )?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "create",
            format!(
                "created rvz `{}` from `{}` (codec={}, block={} bytes, {} bytes)",
                request.output.display(),
                input.display(),
                normalize_codec_label(&options.compression.to_string()),
                options.block_size,
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
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}
