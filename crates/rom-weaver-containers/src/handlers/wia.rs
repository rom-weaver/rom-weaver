/* jscpd:ignore-start */
const WIA_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&WIA, NodFormat::Wia);

struct WiaContainerHandler;

impl WiaContainerHandler {
    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => {
                if let Some(level) = level {
                    return Ok(NodCompression::Lzma(
                        WIA_NOD_CORE.validate_u8_level("lzma", level)?,
                    ));
                }
                Ok(NodFormat::Wia.default_compression())
            }
            RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(WIA_NOD_CORE.reject_store_level_error());
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(CanonicalCodec::Bzip2) => Ok(NodCompression::Bzip2(
                WIA_NOD_CORE.validate_u8_level("bzip2", level.unwrap_or(0))?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma) => Ok(NodCompression::Lzma(
                WIA_NOD_CORE.validate_u8_level("lzma", level.unwrap_or(0))?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma2) => Ok(NodCompression::Lzma2(
                WIA_NOD_CORE.validate_u8_level("lzma2", level.unwrap_or(0))?,
            )),
            RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(NodCompression::Zstandard(
                WIA_NOD_CORE.validate_i8_level("zstd", level.unwrap_or(0))?,
            )),
            RequestedCodec::Known(codec) => Err(WIA_NOD_CORE.unsupported_codec_error(
                codec.name(),
                "supported codecs are store, bzip2, lzma, lzma2, and zstd",
            )),
            RequestedCodec::Unknown(name) => Err(WIA_NOD_CORE.unsupported_codec_error(
                &name,
                "supported codecs are store, bzip2, lzma, lzma2, and zstd",
            )),
        }
    }
}

impl ContainerHandlerOperations for WiaContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WIA
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        WIA_NOD_CORE.probe(source)
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WIA_NOD_CORE.inspect(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(WIA_NOD_CORE.list_entries(&request.source))
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        WIA_NOD_CORE.extract_with_standard_copy(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let input = WIA_NOD_CORE.ensure_single_create_input(request)?;
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Wia,
            compression,
            block_size: NodFormat::Wia.default_block_size(),
        };

        WIA_NOD_CORE.ensure_create_output_parent(&request.output)?;

        let progress_label = format!("creating `{}`", WIA.name);
        let emitted_progress_bucket = AtomicU8::new(0);
        let output_bytes = WIA_NOD_CORE.process_create_with_progress(
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
                        format: WIA.name,
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
}
/* jscpd:ignore-end */
