struct WiaContainerHandler;

impl WiaContainerHandler {
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
        NodDiscReader::new(source, &self.read_options(0)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open wia source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_wia_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Wia {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a wia container (detected {})",
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

    fn to_u8_level(&self, level: i32, codec: &str) -> Result<u8> {
        if level < 0 {
            return Err(RomWeaverError::Validation(format!(
                "wia codec `{codec}` requires a non-negative level"
            )));
        }
        u8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!("wia codec `{codec}` level `{level}` is too large"))
        })
    }

    fn to_i8_level(&self, level: i32, codec: &str) -> Result<i8> {
        i8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!(
                "wia codec `{codec}` level `{level}` is out of range"
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
                if let Some(level) = level {
                    return Ok(NodCompression::Lzma(self.to_u8_level(level, "lzma")?));
                }
                Ok(NodFormat::Wia.default_compression())
            }
            RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "wia codec `store` does not accept --level".into(),
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
                "unsupported wia codec `{}`; supported codecs are store, bzip2, lzma, lzma2, and zstd",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported wia codec `{name}`; supported codecs are store, bzip2, lzma, lzma2, and zstd"
            ))),
        }
    }
}

impl ContainerHandler for WiaContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WIA
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Wia
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
        let meta = self.validate_wia_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WIA.name.to_string()),
            "inspect",
            format!(
                "wia: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
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
        let mut disc = NodDiscReader::new(&request.source, &self.read_options(preloader_threads))
            .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open wia source `{}`: {error}",
                request.source.display()
            ))
        })?;
        let meta = self.validate_wia_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let progress_label = format!("extracting `{}`", WIA.name);
        let bytes_written = copy_reader_with_progress(
            &mut disc,
            &mut output,
            disc_size,
            context,
            "extract",
            WIA.name,
            "extract",
            &progress_label,
            Some(&execution),
        )?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WIA.name.to_string()),
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
                "wia create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Wia,
            compression,
            block_size: NodFormat::Wia.default_block_size(),
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let input_disc =
            NodDiscReader::new(input, &self.read_options(preloader_threads)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for wia create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, &options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize wia writer: {error}"))
        })?;

        let mut output = File::create(&request.output)?;
        let mut process_options = NodProcessOptions::default();
        process_options.processor_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let progress_label = format!("creating `{}`", WIA.name);
        let emitted_progress_bucket = AtomicU8::new(0);
        let finalization = writer
            .process(
                |data, processed, total| {
                    output.write_all(data.as_ref())?;
                    if total > 0 {
                        let processed_bytes =
                            processed.saturating_add(data.as_ref().len() as u64).min(total);
                        maybe_emit_container_byte_progress(
                            context,
                            "compress",
                            WIA.name,
                            "create",
                            processed_bytes,
                            total,
                            &progress_label,
                            Some(&execution),
                            &emitted_progress_bucket,
                        );
                    }
                    Ok(())
                },
                &process_options,
            )
            .map_err(|error| RomWeaverError::Validation(format!("wia create failed: {error}")))?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        let output_bytes = fs::metadata(&request.output)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WIA.name.to_string()),
            "create",
            format!(
                "created wia `{}` from `{}` (codec={}, block={} bytes, {} bytes)",
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
