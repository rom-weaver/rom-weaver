/* jscpd:ignore-start */
const TGC_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&TGC, NodFormat::Tgc);

struct TgcContainerHandler;

impl TgcContainerHandler {
    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        TGC_NOD_CORE.resolve_store_only_compression(codec, level)
    }
}

impl ContainerHandlerOperations for TgcContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &TGC
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        TGC_NOD_CORE.probe(source)
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        TGC_NOD_CORE.inspect(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(TGC_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        TGC_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let input = TGC_NOD_CORE.ensure_single_create_input(request)?;
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Tgc,
            compression,
            block_size: NodFormat::Tgc.default_block_size(),
        };

        TGC_NOD_CORE.ensure_create_output_parent(&request.output)?;

        let progress_label = format!("creating `{}`", TGC.name);
        let emitted_progress_bucket = AtomicU8::new(0);
        let output_bytes = TGC_NOD_CORE.process_create_with_progress(
            input,
            &request.output,
            &options,
            &execution,
            |processed_bytes, total| {
                maybe_emit_container_byte_progress(
                    context,
                    processed_bytes,
                    total,
                    ContainerByteProgress {
                        command: "compress",
                        format: TGC.name,
                        stage: "create",
                        label: &progress_label,
                        thread_execution: Some(&execution),
                        emitted_progress_bucket: &emitted_progress_bucket,
                    },
                );
            },
        )?;

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
}
/* jscpd:ignore-end */
