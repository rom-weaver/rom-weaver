struct NfsContainerHandler;

impl NfsContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn open_disc(&self, source: &Path, preloader_threads: usize) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(preloader_threads)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open nfs source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_nfs_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Nfs {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not an nfs container (detected {})",
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

impl ContainerHandler for NfsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &NFS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source, 0)
            && disc.meta().format == NodFormat::Nfs
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
        let meta = self.validate_nfs_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(NFS.name.to_string()),
            "inspect",
            format!(
                "nfs: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
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
        let preloader_threads = if execution.used_parallelism {
            execution.effective_threads
        } else {
            0
        };
        let mut disc = self.open_disc(&request.source, preloader_threads)?;
        let meta = self.validate_nfs_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let progress_label = format!("extracting `{}`", NFS.name);
        let bytes_written = copy_reader_with_progress(
            &mut disc,
            &mut output,
            disc_size,
            context,
            "extract",
            NFS.name,
            "extract",
            &progress_label,
            Some(&execution),
        )?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(NFS.name.to_string()),
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
            "nfs compression is not supported; nfs can only be decompressed with `extract`".into(),
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
