struct TgcContainerHandler;

impl TgcContainerHandler {
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

    fn open_disc(&self, source: &Path, preloader_threads: usize) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(preloader_threads)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open tgc source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_tgc_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Tgc {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a tgc container (detected {})",
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

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "tgc codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported tgc codec `{}`; supported codec is store",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported tgc codec `{name}`; supported codec is store"
            ))),
        }
    }
}

impl ContainerHandler for TgcContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &TGC
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source, 0)
            && disc.meta().format == NodFormat::Tgc
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
        let disc = self.open_disc(&request.source, 0)?;
        let meta = self.validate_tgc_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(TGC.name.to_string()),
            "inspect",
            format!(
                "tgc: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
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
        let mut disc = self.open_disc(&request.source, preloader_threads)?;
        let meta = self.validate_tgc_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let progress_label = format!("extracting `{}`", TGC.name);
        let bytes_written = copy_reader_with_progress(
            &mut disc,
            &mut output,
            disc_size,
            context,
            "extract",
            TGC.name,
            "extract",
            &progress_label,
            Some(&execution),
        )?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(TGC.name.to_string()),
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
                "tgc create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Tgc,
            compression,
            block_size: NodFormat::Tgc.default_block_size(),
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let input_disc =
            NodDiscReader::new(input, &self.read_options(preloader_threads)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for tgc create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, &options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize tgc writer: {error}"))
        })?;

        let mut output = File::create(&request.output)?;
        let mut process_options = NodProcessOptions::default();
        process_options.processor_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let progress_label = format!("creating `{}`", TGC.name);
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
                            TGC.name,
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
            .map_err(|error| RomWeaverError::Validation(format!("tgc create failed: {error}")))?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        let output_bytes = fs::metadata(&request.output)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(TGC.name.to_string()),
            "create",
            format!(
                "created tgc `{}` from `{}` (codec=store, {} bytes)",
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
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}
