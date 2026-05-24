const WBFS_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&WBFS, NodFormat::Wbfs);

struct WbfsContainerHandler;

impl WbfsContainerHandler {
    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        WBFS_NOD_CORE.resolve_store_only_compression(codec, level)
    }
}

impl ContainerHandler for WbfsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WBFS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        WBFS_NOD_CORE.probe(source)
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WBFS_NOD_CORE.inspect(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(WBFS_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WBFS_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let input = WBFS_NOD_CORE.ensure_single_create_input(request)?;
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Wbfs,
            compression,
            block_size: NodFormat::Wbfs.default_block_size(),
        };

        WBFS_NOD_CORE.ensure_create_output_parent(&request.output)?;

        let progress_label = format!("creating `{}`", WBFS.name);
        let emitted_progress_bucket = AtomicU8::new(0);
        let output_bytes = WBFS_NOD_CORE.process_create_with_progress(
            input,
            &request.output,
            &options,
            &execution,
            |processed_bytes, total| {
                maybe_emit_container_byte_progress(
                    context,
                    "compress",
                    WBFS.name,
                    "create",
                    processed_bytes,
                    total,
                    &progress_label,
                    Some(&execution),
                    &emitted_progress_bucket,
                );
            },
        )?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WBFS.name.to_string()),
            "create",
            format!(
                "created wbfs `{}` from `{}` (codec=store, block={} bytes, {} bytes)",
                request.output.display(),
                input.display(),
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
