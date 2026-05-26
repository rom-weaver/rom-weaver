/* jscpd:ignore-start */
#[derive(Clone, Copy, Debug)]
enum ZipContainerFlavor {
    Zip,
    Zipx,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ZipCompressionMethod {
    Stored,
    Deflated,
    Bzip2,
    Zstd,
}

struct ZipContainerHandler {
    descriptor: &'static FormatDescriptor,
    flavor: ZipContainerFlavor,
}

impl ZipContainerHandler {
    const ZSTD_LEVEL_MIN: i32 = -7;
    const ZSTD_LEVEL_MAX: i32 = 22;

    const fn new(descriptor: &'static FormatDescriptor, flavor: ZipContainerFlavor) -> Self {
        Self { descriptor, flavor }
    }

    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<(ZipCompressionMethod, Option<i32>)> {
        let default = match self.flavor {
            ZipContainerFlavor::Zip => ZipCompressionMethod::Deflated,
            ZipContainerFlavor::Zipx => ZipCompressionMethod::Zstd,
        };
        let method = match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => default,
            RequestedCodec::Known(CanonicalCodec::Store) => ZipCompressionMethod::Stored,
            RequestedCodec::Known(CanonicalCodec::Deflate) => ZipCompressionMethod::Deflated,
            RequestedCodec::Known(CanonicalCodec::Bzip2) => ZipCompressionMethod::Bzip2,
            RequestedCodec::Known(CanonicalCodec::Zstd) => ZipCompressionMethod::Zstd,
            RequestedCodec::Known(codec) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {} codec `{}`; supported codecs are store, deflate, bzip2, and zstd",
                    self.descriptor.name,
                    codec.name()
                )));
            }
            RequestedCodec::Unknown(name) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {} codec `{name}`; supported codecs are store, deflate, bzip2, and zstd",
                    self.descriptor.name
                )));
            }
        };

        if let Some(level) = level {
            let in_range = match method {
                ZipCompressionMethod::Stored => false,
                ZipCompressionMethod::Deflated => (0..=9).contains(&level),
                ZipCompressionMethod::Bzip2 => (1..=9).contains(&level),
                ZipCompressionMethod::Zstd => (-7..=22).contains(&level),
            };
            if !in_range {
                return Err(RomWeaverError::Validation(format!(
                    "level `{level}` is invalid for {} codec `{}`",
                    self.descriptor.name,
                    self.method_name(method)
                )));
            }
        }

        if method == ZipCompressionMethod::Stored && level.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{} codec `store` does not accept --level",
                self.descriptor.name
            )));
        }

        Ok((method, level))
    }

    fn method_name(&self, method: ZipCompressionMethod) -> &'static str {
        match method {
            ZipCompressionMethod::Stored => "store",
            ZipCompressionMethod::Deflated => "deflate",
            ZipCompressionMethod::Bzip2 => "bzip2",
            ZipCompressionMethod::Zstd => "zstd",
        }
    }

    fn libarchive_method_name(&self, method: ZipCompressionMethod) -> Option<&'static str> {
        match method {
            ZipCompressionMethod::Stored => Some("store"),
            ZipCompressionMethod::Deflated => Some("deflate"),
            ZipCompressionMethod::Bzip2 => Some("bzip2"),
            ZipCompressionMethod::Zstd => Some("zstd"),
        }
    }

    fn libarchive_level(&self, method: ZipCompressionMethod, level: Option<i32>) -> Option<i32> {
        match method {
            ZipCompressionMethod::Deflated => level,
            ZipCompressionMethod::Bzip2 => level,
            ZipCompressionMethod::Zstd => {
                level.map(|value| Self::map_zstd_level_to_zip_level(value))
            }
            _ => None,
        }
    }

    fn libarchive_threads(
        &self,
        method: ZipCompressionMethod,
        execution: &ThreadExecution,
    ) -> Option<usize> {
        match method {
            ZipCompressionMethod::Stored
            | ZipCompressionMethod::Deflated
            | ZipCompressionMethod::Bzip2
            | ZipCompressionMethod::Zstd => Some(execution.effective_threads.max(1)),
        }
    }

    fn create_thread_capability(&self, _method: ZipCompressionMethod) -> ThreadCapability {
        ThreadCapability::parallel(None)
    }

    fn libarchive_io_buffer_bytes(method: ZipCompressionMethod) -> usize {
        match method {
            ZipCompressionMethod::Zstd => LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES,
            _ => LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
        }
    }

    fn map_zstd_level_to_zip_level(level: i32) -> i32 {
        level.clamp(Self::ZSTD_LEVEL_MIN, Self::ZSTD_LEVEL_MAX)
    }

    fn create_with_libarchive(
        &self,
        request: &ContainerCreateRequest,
        entries: &[ArchiveInputEntry],
        method: ZipCompressionMethod,
        level: Option<i32>,
        context: &OperationContext,
    ) -> Result<(u64, ThreadExecution)> {
        let execution = context.plan_threads(self.create_thread_capability(method));

        let method_name = self.libarchive_method_name(method).ok_or_else(|| {
            RomWeaverError::Unsupported(format!(
                "libarchive does not support {} codec `{}`",
                self.descriptor.name,
                self.method_name(method)
            ))
        })?;
        let logical_bytes = write_archive_with_libarchive(
            request,
            entries,
            context,
            &execution,
            LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::Zip,
                filter: LibarchiveCreateFilter::None,
                format_compression: Some(method_name),
                compression_level: self.libarchive_level(method, level),
                format_threads: self.libarchive_threads(method, &execution),
                filter_threads: None,
                io_buffer_bytes: Self::libarchive_io_buffer_bytes(method),
            },
        )?;
        Ok((logical_bytes, execution))
    }
}

impl ContainerHandler for ZipContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        probe_regular_archive_with_libarchive(
            source,
            self.descriptor.name,
            LibarchiveProbeFormat::Zip,
        )
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let summary =
            inspect_regular_archive_with_libarchive(&request.source, self.descriptor.name)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name,
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
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        list_regular_archive_entries_with_libarchive(&request.source, self.descriptor.name)
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
        let (method, level) = self.parse_codec(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let (logical_bytes, execution) =
            self.create_with_libarchive(request, &entries, method, level, context)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                self.method_name(method),
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
            extract_threads: regular_archive_extract_thread_capability(),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}
/* jscpd:ignore-end */
