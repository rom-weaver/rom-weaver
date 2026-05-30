/* jscpd:ignore-start */
struct SevenZContainerHandler {
    descriptor: &'static FormatDescriptor,
}

#[derive(Clone)]
struct SevenZCodecSettings {
    codec: CanonicalCodec,
    level: u32,
    method: SevenZMethod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SevenZMethod {
    Store,
    Lzma2,
    Lzma,
    Zstd,
    Deflate,
    Bzip2,
    Ppmd,
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
        let codec = match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => CanonicalCodec::Lzma2,
            RequestedCodec::Known(codec) => codec,
            RequestedCodec::Unknown(name) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported 7z codec `{name}`; supported codecs are lzma2, lzma, store, zstd, deflate, bzip2, and ppmd"
                )));
            }
        };

        if !matches!(
            codec,
            CanonicalCodec::Lzma2
                | CanonicalCodec::Lzma
                | CanonicalCodec::Store
                | CanonicalCodec::Zstd
                | CanonicalCodec::Deflate
                | CanonicalCodec::Bzip2
                | CanonicalCodec::Ppmd
        ) {
            return Err(RomWeaverError::Validation(format!(
                "unsupported 7z codec `{}`; supported codecs are lzma2, lzma, store, zstd, deflate, bzip2, and ppmd",
                codec.name()
            )));
        }

        let level = Self::parse_level(codec, level)?;
        if codec == CanonicalCodec::Store && level.is_some() {
            return Err(RomWeaverError::Validation(
                "7z codec `store` does not accept --level".into(),
            ));
        }

        let level = level.unwrap_or(Self::DEFAULT_CODEC_LEVEL);
        let method = match codec {
            CanonicalCodec::Lzma2 => SevenZMethod::Lzma2,
            CanonicalCodec::Lzma => SevenZMethod::Lzma,
            CanonicalCodec::Store => SevenZMethod::Store,
            CanonicalCodec::Zstd => SevenZMethod::Zstd,
            CanonicalCodec::Deflate => SevenZMethod::Deflate,
            CanonicalCodec::Bzip2 => SevenZMethod::Bzip2,
            CanonicalCodec::Ppmd => SevenZMethod::Ppmd,
            CanonicalCodec::Lz4 | CanonicalCodec::Brotli | CanonicalCodec::Huffman => {
                return Err(RomWeaverError::Validation(
                    format!(
                        "unsupported 7z codec `{}`; supported codecs are lzma2, lzma, store, zstd, deflate, bzip2, and ppmd",
                        codec.name()
                    ),
                ));
            }
        };

        Ok(SevenZCodecSettings {
            codec,
            level,
            method,
        })
    }

    fn parse_level(codec: CanonicalCodec, level: Option<i32>) -> Result<Option<u32>> {
        let Some(level) = level else {
            return Ok(None);
        };
        let max_level = if matches!(codec, CanonicalCodec::Zstd) {
            22
        } else {
            9
        };
        if !(0..=max_level).contains(&level) {
            return Err(RomWeaverError::Validation(format!(
                "7z level `{level}` is out of range for codec `{}` (0..={max_level})",
                codec.name()
            )));
        }
        Ok(Some(level as u32))
    }

    fn method_name(method: SevenZMethod) -> &'static str {
        match method {
            SevenZMethod::Store => "store",
            SevenZMethod::Lzma2 => "lzma2",
            SevenZMethod::Lzma => "lzma",
            SevenZMethod::Zstd => "zstd",
            SevenZMethod::Deflate => "deflate",
            SevenZMethod::Bzip2 => "bzip2",
            SevenZMethod::Ppmd => "ppmd",
        }
    }

    fn method_name_from_codec(codec: CanonicalCodec) -> &'static str {
        match codec {
            CanonicalCodec::Store => "store",
            CanonicalCodec::Deflate => "deflate",
            CanonicalCodec::Bzip2 => "bzip2",
            CanonicalCodec::Lzma => "lzma",
            CanonicalCodec::Lzma2 => "lzma2",
            CanonicalCodec::Zstd => "zstd",
            CanonicalCodec::Lz4 => "lz4",
            CanonicalCodec::Brotli => "brotli",
            CanonicalCodec::Ppmd => "ppmd",
            CanonicalCodec::Huffman => "huffman",
        }
    }

    fn libarchive_method_name(codec: CanonicalCodec) -> Option<&'static str> {
        match codec {
            CanonicalCodec::Store => Some("copy"),
            CanonicalCodec::Deflate => Some("deflate"),
            CanonicalCodec::Bzip2 => Some("bzip2"),
            CanonicalCodec::Lzma => Some("lzma1"),
            CanonicalCodec::Lzma2 => Some("lzma2"),
            CanonicalCodec::Zstd => Some("zstd"),
            CanonicalCodec::Ppmd => Some("ppmd"),
            CanonicalCodec::Lz4 | CanonicalCodec::Brotli => None,
            CanonicalCodec::Huffman => None,
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
        let method_name = Self::libarchive_method_name(settings.codec).ok_or_else(|| {
            RomWeaverError::Unsupported(format!(
                "libarchive does not support 7z codec `{}`",
                Self::method_name_from_codec(settings.codec)
            ))
        })?;
        let logical_bytes = write_archive_with_libarchive(
            request,
            entries,
            context,
            execution,
            LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::SevenZ,
                filter: LibarchiveCreateFilter::None,
                format_compression: Some(method_name),
                compression_level: if matches!(settings.codec, CanonicalCodec::Store) {
                    None
                } else {
                    Some(settings.level as i32)
                },
                format_threads: Some(execution.effective_threads.max(1)),
                filter_threads: None,
                io_buffer_bytes: LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
            },
        )?;
        Ok(logical_bytes)
    }
}

impl ContainerHandler for SevenZContainerHandler {
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
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        list_regular_archive_entries_with_libarchive(&request.source, self.descriptor.name)
    }

    fn list_entry_records(
        &self,
        request: &ContainerInspectRequest,
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
