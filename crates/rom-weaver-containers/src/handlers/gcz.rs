struct GczContainerHandler;

impl GczContainerHandler {
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
                "failed to open gcz source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_gcz_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Gcz {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a gcz container (detected {})",
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
}

impl ContainerHandler for GczContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &GCZ
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Gcz
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
        let meta = self.validate_gcz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(GCZ.name.to_string()),
            "inspect",
            format!(
                "gcz: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
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
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let mut disc = NodDiscReader::new(&request.source, &self.read_options(preloader_threads))
            .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open gcz source `{}`: {error}",
                request.source.display()
            ))
        })?;
        let meta = self.validate_gcz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let progress_label = format!("extracting `{}`", GCZ.name);
        let bytes_written = copy_reader_with_progress(
            &mut disc,
            &mut output,
            disc_size,
            context,
            "extract",
            GCZ.name,
            "extract",
            &progress_label,
            Some(&execution),
        )?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(GCZ.name.to_string()),
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
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "warning: gcz compression is not supported; use `--format rvz` instead".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}
