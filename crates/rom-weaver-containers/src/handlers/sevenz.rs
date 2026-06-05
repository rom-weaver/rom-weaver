/* jscpd:ignore-start */
struct SevenZContainerHandler {
    descriptor: &'static FormatDescriptor,
}

#[derive(Clone)]
struct SevenZCodecSettings {
    level: u32,
    method: SevenZMethod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SevenZMethod {
    Lzma2,
}

impl SevenZContainerHandler {
    const DEFAULT_CODEC_LEVEL: u32 = 6;

    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    #[cfg(test)]
    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
        _execution: &rom_weaver_core::ThreadExecution,
    ) -> Result<SevenZMethod> {
        self.resolve_codec_settings(codec, level)
            .map(|settings| settings.method)
    }

    fn resolve_codec_settings(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<SevenZCodecSettings> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Lzma2) => {}
            RequestedCodec::Known(codec) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported 7z codec `{}`; supported codec is lzma2",
                    codec.name()
                )));
            }
            RequestedCodec::Unknown(name) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported 7z codec `{name}`; supported codec is lzma2"
                )));
            }
        }

        let level = Self::parse_level(level)?;
        let level = level.unwrap_or(Self::DEFAULT_CODEC_LEVEL);
        Ok(SevenZCodecSettings {
            level,
            method: SevenZMethod::Lzma2,
        })
    }

    fn parse_level(level: Option<i32>) -> Result<Option<u32>> {
        let Some(level) = level else {
            return Ok(None);
        };
        let max_level = 9;
        if !(0..=max_level).contains(&level) {
            return Err(RomWeaverError::Validation(format!(
                "7z level `{level}` is out of range for codec `lzma2` (0..={max_level})"
            )));
        }
        Ok(Some(level as u32))
    }

    fn method_name(method: SevenZMethod) -> &'static str {
        match method {
            SevenZMethod::Lzma2 => "lzma2",
        }
    }

    fn create_with_libarchive(
        &self,
        request: &ContainerCreateRequest,
        entries: &[ArchiveInputEntry],
        settings: &SevenZCodecSettings,
        execution: &ThreadExecution,
        context: &OperationContext,
    ) -> Result<u64> {
        let logical_bytes = write_archive_with_libarchive(
            request,
            entries,
            context,
            execution,
            LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::SevenZ,
                filter: LibarchiveCreateFilter::None,
                format_compression: Some("lzma2"),
                compression_level: Some(settings.level as i32),
                format_threads: Some(execution.effective_threads.max(1)),
                filter_threads: None,
                io_buffer_bytes: LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
            },
        )?;
        Ok(logical_bytes)
    }
}

impl ContainerHandlerOperations for SevenZContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        probe_regular_archive_with_libarchive(
            source,
            self.descriptor.name,
            LibarchiveProbeFormat::SevenZ,
        )
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let summary =
            probe_regular_archive_details_with_libarchive(&request.source, self.descriptor.name)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "probe",
            format!(
                "7z: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                summary.entries_total,
                summary.files,
                summary.directories,
                summary.archive_bytes,
                summary.logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        list_regular_archive_entries_with_libarchive(&request.source, self.descriptor.name)
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        list_regular_archive_entry_records_with_libarchive(&request.source, self.descriptor.name)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        extract_regular_archive_with_libarchive(request, context, self.descriptor.name)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let settings = self.resolve_codec_settings(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let logical_bytes =
            self.create_with_libarchive(request, &entries, &settings, &execution, context)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                Self::method_name(settings.method),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }
}
/* jscpd:ignore-end */
