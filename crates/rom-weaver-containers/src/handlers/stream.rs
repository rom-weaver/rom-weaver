/* jscpd:ignore-start */
use super::*;
use tracing::{debug, trace};

#[derive(Clone, Copy, Debug)]
pub(crate) enum StreamCompression {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

pub(crate) struct StreamContainerHandler {
    descriptor: &'static FormatDescriptor,
    compression: StreamCompression,
}

impl StreamContainerHandler {
    pub(crate) const fn new(
        descriptor: &'static FormatDescriptor,
        compression: StreamCompression,
    ) -> Self {
        Self {
            descriptor,
            compression,
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

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Gzip
            | StreamCompression::Bzip2
            | StreamCompression::Xz
            | StreamCompression::Zstd => ThreadCapability::parallel(None),
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
            probe_stream_with_libarchive(source, format_name, self.libarchive_read_filter())?;
        debug!(
            format = format_name,
            compression = ?self.compression,
            total_bytes,
            used_parallelism = execution.used_parallelism,
            "stream extract start"
        );
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

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let compressed_bytes = fs::metadata(&request.source)?.len();
        let logical_bytes = probe_stream_with_libarchive(
            &request.source,
            self.descriptor.name,
            self.libarchive_read_filter(),
        )?;
        trace!(
            format = self.descriptor.name,
            compression = ?self.compression,
            compressed_bytes,
            logical_bytes,
            "stream probe"
        );

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "probe",
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
        request: &ContainerProbeRequest,
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
        if !request
            .kind_filter
            .matches_payload_or_container_name(&output_name)
        {
            return Err(RomWeaverError::Validation(format!(
                "no extract entries from `{}` matched {}",
                request.source.display(),
                request.kind_filter.flag_label()
            )));
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
        let _ = (request, context);
        Err(extract_only_create_error(self.descriptor.name))
    }
}
/* jscpd:ignore-end */
