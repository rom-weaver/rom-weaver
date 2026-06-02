/* jscpd:ignore-start */
#[derive(Clone, Copy, Debug)]
enum StreamCompression {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

struct StreamContainerHandler {
    descriptor: &'static FormatDescriptor,
    compression: StreamCompression,
}

impl StreamContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor, compression: StreamCompression) -> Self {
        Self {
            descriptor,
            compression,
        }
    }

    fn parse_codec_and_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<i32> {
        let codec = parse_requested_codec(codec);
        match self.compression {
            StreamCompression::Gzip => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Deflate) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported gz codec `{}`; use gzip",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported gz codec `{codec}`; use gzip"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "gz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            StreamCompression::Bzip2 => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Bzip2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported bz2 codec `{}`; use bzip2",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported bz2 codec `{codec}`; use bzip2"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (1..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "bz2 level `{value}` is out of range (1..=9)"
                    ))),
                }
            }
            StreamCompression::Xz => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Lzma)
                    | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported xz codec `{}`; use xz",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported xz codec `{codec}`; use xz"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "xz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            StreamCompression::Zstd => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Zstd) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported zst codec `{}`; use zstd",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported zst codec `{codec}`; use zstd"
                        )));
                    }
                }
                match level {
                    None => Ok(3),
                    Some(value) if (-7..=22).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "zst level `{value}` is out of range (-7..=22)"
                    ))),
                }
            }
        }
    }

    fn libarchive_read_filter(&self) -> LibarchiveReadFilter {
        match self.compression {
            StreamCompression::Gzip => LibarchiveReadFilter::Gzip,
            StreamCompression::Bzip2 => LibarchiveReadFilter::Bzip2,
            StreamCompression::Xz => LibarchiveReadFilter::Xz,
            StreamCompression::Zstd => LibarchiveReadFilter::Zstd,
        }
    }

    fn libarchive_create_filter(&self) -> LibarchiveCreateFilter {
        match self.compression {
            StreamCompression::Gzip => LibarchiveCreateFilter::Gzip,
            StreamCompression::Bzip2 => LibarchiveCreateFilter::Bzip2,
            StreamCompression::Xz => LibarchiveCreateFilter::Xz,
            StreamCompression::Zstd => LibarchiveCreateFilter::Zstd,
        }
    }

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Gzip
            | StreamCompression::Bzip2
            | StreamCompression::Xz
            | StreamCompression::Zstd => ThreadCapability::parallel(None),
        }
    }

    fn create_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Gzip
            | StreamCompression::Bzip2
            | StreamCompression::Xz
            | StreamCompression::Zstd => ThreadCapability::parallel(None),
        }
    }

    fn create_io_buffer_bytes(&self) -> usize {
        match self.compression {
            StreamCompression::Zstd => LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES,
            StreamCompression::Gzip | StreamCompression::Bzip2 | StreamCompression::Xz => {
                LIBARCHIVE_CREATE_IO_BUFFER_BYTES
            }
        }
    }

    fn extract_with_libarchive(
        &self,
        source: &Path,
        output_path: &Path,
        overwrite: bool,
        context: &OperationContext,
        execution: &ThreadExecution,
    ) -> Result<u64> {
        let format_name = self.descriptor.name;
        let total_bytes =
            inspect_stream_with_libarchive(source, format_name, self.libarchive_read_filter())?;
        let mut archive =
            libarchive_open_read_stream(source, format_name, self.libarchive_read_filter())?;
        let result = (|| -> Result<u64> {
            if !archive.next_header(&format!(
                "{format_name} extract failed while reading header"
            ))? {
                return Err(RomWeaverError::Validation(format!(
                    "{format_name} extract found no compressed payload entries"
                )));
            }

            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = BufWriter::new(create_extract_output_file(output_path, overwrite)?);
            let progress_label = format!("extracting `{}`", format_name);
            let emitted_progress_bucket = AtomicU8::new(0);
            let mut copied = 0_u64;
            let mut buffer = vec![0_u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
            loop {
                let read = archive.read_data(
                    &mut buffer,
                    &format!("{format_name} extract failed while reading payload"),
                )?;
                if read == 0 {
                    break;
                }
                output.write_all(&buffer[..read])?;
                copied = copied.saturating_add(read as u64).min(total_bytes);
                maybe_emit_container_byte_progress(
                    context,
                    copied,
                    total_bytes,
                    ContainerByteProgress {
                        command: "extract",
                        format: format_name,
                        stage: "extract",
                        label: &progress_label,
                        thread_execution: Some(execution),
                        emitted_progress_bucket: &emitted_progress_bucket,
                    },
                );
            }
            output.flush()?;
            Ok(copied)
        })();

        match (result, libarchive_close_read_stream(archive, format_name)) {
            (Ok(bytes), Ok(())) => Ok(bytes),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    fn create_with_libarchive(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
        execution: &ThreadExecution,
        level: i32,
    ) -> Result<u64> {
        let input = &request.inputs[0];
        let entry_name = input
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("payload.bin")
            .to_string();
        let entries = vec![ArchiveInputEntry {
            source: input.clone(),
            archive_name: entry_name,
            is_dir: false,
        }];
        let create_config = LibarchiveCreateConfig {
            format_name: self.descriptor.name,
            format: LibarchiveCreateFormat::Raw,
            filter: self.libarchive_create_filter(),
            format_compression: None,
            compression_level: Some(level),
            format_threads: None,
            filter_threads: Some(execution.effective_threads.max(1)),
            io_buffer_bytes: self.create_io_buffer_bytes(),
        };
        write_archive_with_libarchive(request, &entries, context, execution, create_config)
    }

    fn output_name(&self, source: &Path) -> String {
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(self.descriptor.name);
        let file_name_lower = file_name.to_ascii_lowercase();
        let mut longest_extension = 0usize;
        for extension in self.descriptor.extensions {
            let extension_lower = extension.to_ascii_lowercase();
            if file_name_lower.ends_with(&extension_lower)
                && extension_lower.len() > longest_extension
            {
                longest_extension = extension_lower.len();
            }
        }

        let trimmed = if longest_extension > 0 && longest_extension < file_name.len() {
            file_name[..file_name.len() - longest_extension].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };

        let normalized = trimmed.trim().trim_matches('.');
        if normalized.is_empty() {
            format!("{}.out", self.descriptor.name)
        } else {
            normalized.to_string()
        }
    }

    fn matches_signature(&self, source: &Path) -> bool {
        match self.compression {
            StreamCompression::Gzip => file_starts_with(source, &GZIP_SIGNATURE),
            StreamCompression::Bzip2 => file_starts_with(source, &BZIP2_SIGNATURE),
            StreamCompression::Xz => file_starts_with(source, &XZ_SIGNATURE),
            StreamCompression::Zstd => file_starts_with(source, &ZSTD_SIGNATURE),
        }
    }
}

impl ContainerHandlerOperations for StreamContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.matches_signature(source) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let compressed_bytes = fs::metadata(&request.source)?.len();
        let logical_bytes = inspect_stream_with_libarchive(
            &request.source,
            self.descriptor.name,
            self.libarchive_read_filter(),
        )?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name, compressed_bytes, logical_bytes
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
        Ok(vec![self.output_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(self.extract_thread_capability());
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }

        let output_path = request.out_dir.join(&output_name);
        let written = match self.extract_with_libarchive(
            &request.source,
            &output_path,
            request.overwrite,
            context,
            &execution,
        ) {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = fs::remove_file(&output_path);
                return Err(error);
            }
        };
        selections.ensure_all_matched()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` (1 file, {} bytes written)",
                request.source.display(),
                output_path.display(),
                written
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
            return Err(RomWeaverError::Validation(format!(
                "{} create currently requires exactly one input file",
                self.descriptor.name
            )));
        }

        let execution = context.plan_threads(self.create_thread_capability());
        let level = self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let input = &request.inputs[0];
        let metadata = fs::metadata(input)?;
        if !metadata.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "{} create requires a file input: `{}`",
                self.descriptor.name,
                input.display()
            )));
        }
        let logical_bytes = metadata.len();

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        self.create_with_libarchive(request, context, &execution, level)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from `{}` ({} bytes)",
                request.output.display(),
                input.display(),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }
}

const CSO_DEFAULT_BLOCK_BYTES: usize = 2 * 1024;
const CSO_EXTRACT_TASK_BYTES: u64 = 8 * 1024 * 1024;
const CSO_CREATE_TASK_SECTORS: usize = 2048;
/* jscpd:ignore-end */
