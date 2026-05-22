#[derive(Clone, Copy, Debug)]
enum TarCompression {
    None,
    Gzip,
    Bzip2,
    Xz,
}

struct TarContainerHandler {
    descriptor: &'static FormatDescriptor,
    compression: TarCompression,
}

impl TarContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor, compression: TarCompression) -> Self {
        Self {
            descriptor,
            compression,
        }
    }

    fn parse_codec_and_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<u32> {
        let codec = parse_requested_codec(codec);
        match self.compression {
            TarCompression::None => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar codec `{}`; use store or omit --codec",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar codec `{codec}`; use store or omit --codec"
                        )));
                    }
                }
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "tar does not accept --level".into(),
                    ));
                }
                Ok(0)
            }
            TarCompression::Gzip => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Deflate) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.gz codec `{}`; use gzip",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.gz codec `{codec}`; use gzip"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.gz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            TarCompression::Bzip2 => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Bzip2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.bz2 codec `{}`; use bzip2",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.bz2 codec `{codec}`; use bzip2"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (1..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.bz2 level `{value}` is out of range (1..=9)"
                    ))),
                }
            }
            TarCompression::Xz => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Lzma)
                    | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.xz codec `{}`; use xz",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.xz codec `{codec}`; use xz"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.xz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
        }
    }

    fn xz_thread_count(effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn open_reader_with_execution(
        &self,
        source: &Path,
        execution: Option<&mut ThreadExecution>,
    ) -> Result<Box<dyn Read>> {
        let reader: Box<dyn Read> = match self.compression {
            TarCompression::None => Box::new(BufReader::new(File::open(source)?)),
            TarCompression::Gzip => {
                Box::new(MultiGzDecoder::new(BufReader::new(File::open(source)?)))
            }
            TarCompression::Bzip2 => {
                Box::new(Bzip2Decoder::new(BufReader::new(File::open(source)?)))
            }
            TarCompression::Xz => {
                if let Some(execution) = execution {
                    if execution.used_parallelism {
                        let workers = Self::xz_thread_count(execution.effective_threads);
                        let source_reader = BufReader::new(File::open(source)?);
                        match XzReaderMt::new(source_reader, false, workers) {
                            Ok(reader) => Box::new(reader),
                            Err(error) => {
                                execution.apply_pool_fallback(format!(
                                    "tar.xz decoder rejected multithread setting: {error}"
                                ));
                                Box::new(XzReader::new(BufReader::new(File::open(source)?), false))
                            }
                        }
                    } else {
                        Box::new(XzReader::new(BufReader::new(File::open(source)?), false))
                    }
                } else {
                    Box::new(XzReader::new(BufReader::new(File::open(source)?), false))
                }
            }
        };
        Ok(reader)
    }

    fn open_reader(&self, source: &Path) -> Result<Box<dyn Read>> {
        self.open_reader_with_execution(source, None)
    }

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            TarCompression::None
            | TarCompression::Gzip
            | TarCompression::Bzip2
            | TarCompression::Xz => ThreadCapability::parallel(None),
        }
    }

    fn create_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            TarCompression::None
            | TarCompression::Gzip
            | TarCompression::Bzip2
            | TarCompression::Xz => ThreadCapability::parallel(None),
        }
    }

    fn inspect_archive_reader<R: Read>(&self, reader: R) -> Result<(usize, usize, usize, u64)> {
        let mut archive = TarArchive::new(reader);
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        let mut entries_total = 0usize;
        for entry in archive.entries()? {
            let entry = entry?;
            entries_total += 1;
            let entry_type = entry.header().entry_type();
            if entry_type.is_dir() {
                directories += 1;
            } else if entry_type.is_file() {
                files += 1;
                logical_bytes = logical_bytes.saturating_add(entry.header().size()?);
            }
        }
        Ok((entries_total, files, directories, logical_bytes))
    }

    fn inspect_uncompressed_archive(&self, source: &Path) -> Result<(usize, usize, usize, u64)> {
        self.inspect_archive_reader(BufReader::new(File::open(source)?))
    }

    fn list_entries_from_reader<R: Read>(&self, reader: R) -> Result<Vec<String>> {
        let mut archive = TarArchive::new(reader);
        let mut entries = Vec::new();
        for entry in archive.entries()? {
            let entry = entry?;
            let raw_path = entry.path()?;
            let relative = sanitize_archive_relative_path(raw_path.as_ref())?;
            let archive_name = archive_path_to_name(&relative)?;
            if !archive_name.is_empty() {
                entries.push(archive_name);
            }
        }
        Ok(entries)
    }

    fn list_uncompressed_entries(&self, source: &Path) -> Result<Vec<String>> {
        self.list_entries_from_reader(BufReader::new(File::open(source)?))
    }

    fn looks_like_tar_archive(&self, source: &Path) -> bool {
        let mut reader = match self.open_reader(source) {
            Ok(reader) => reader,
            Err(_) => return false,
        };
        let mut header = [0u8; 512];
        reader.read_exact(&mut header).is_ok() && is_ustar_header(&header)
    }
}

impl ContainerHandler for TarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.looks_like_tar_archive(source) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let (entries_total, files, directories, logical_bytes) =
            if matches!(self.compression, TarCompression::None) {
                self.inspect_uncompressed_archive(&request.source)?
            } else {
                let mut execution = context.plan_threads(self.extract_thread_capability());
                let reader =
                    self.open_reader_with_execution(&request.source, Some(&mut execution))?;
                self.inspect_archive_reader(reader)?
            };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes uncompressed",
                self.descriptor.name, entries_total, files, directories, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        if matches!(self.compression, TarCompression::None) {
            return self.list_uncompressed_entries(&request.source);
        }
        let mut execution = context.plan_threads(self.extract_thread_capability());
        let reader = self.open_reader_with_execution(&request.source, Some(&mut execution))?;
        self.list_entries_from_reader(reader)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        extract_regular_archive_with_libarchive(request, context, self.descriptor.name, true)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(self.create_thread_capability());
        let level = self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let config = match self.compression {
            TarCompression::None => LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::TarPax,
                filter: LibarchiveCreateFilter::None,
                format_compression: None,
                compression_level: None,
                format_threads: None,
                filter_threads: None,
                io_buffer_bytes: LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
            },
            TarCompression::Gzip => LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::TarPax,
                filter: LibarchiveCreateFilter::Gzip,
                format_compression: None,
                compression_level: Some(level as i32),
                format_threads: None,
                filter_threads: Some(execution.effective_threads.max(1)),
                io_buffer_bytes: LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
            },
            TarCompression::Bzip2 => LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::TarPax,
                filter: LibarchiveCreateFilter::Bzip2,
                format_compression: None,
                compression_level: Some(level as i32),
                format_threads: None,
                filter_threads: Some(execution.effective_threads.max(1)),
                io_buffer_bytes: LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
            },
            TarCompression::Xz => LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::TarPax,
                filter: LibarchiveCreateFilter::Xz,
                format_compression: None,
                compression_level: Some(level as i32),
                format_threads: None,
                filter_threads: Some(execution.effective_threads.max(1)),
                io_buffer_bytes: LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
            },
        };
        let logical_bytes =
            write_archive_with_libarchive(request, &entries, context, &execution, config)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) ({} bytes)",
                request.output.display(),
                request.inputs.len(),
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
            extract_threads: self.extract_thread_capability(),
            create_threads: self.create_thread_capability(),
        }
    }
}
