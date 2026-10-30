use super::*;
use crate::extract_support::{ExtractHasher, emit_extract_identity, emit_variant_plan};
use tracing::{debug, trace};

#[derive(Clone, Copy, Debug)]
pub(crate) enum StreamCompression {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
    Lz4,
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
            StreamCompression::Lz4 => LibarchiveReadFilter::Lz4,
        }
    }

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Lz4 => ThreadCapability::single_threaded(),
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
    ) -> Result<(u64, Option<ExtractedFileChecksum>)> {
        let format_name = self.descriptor.name;
        // The uncompressed size is unknown without decoding the whole stream, and a probe pass to
        // learn it would decompress the payload a second time - emit indeterminate progress instead.
        debug!(
            format = format_name,
            compression = ?self.compression,
            used_parallelism = execution.used_parallelism,
            "stream extract start"
        );
        emit_container_indeterminate_progress(
            context,
            "extract",
            format_name,
            "extract",
            format!("extracting `{}`", format_name),
            Some(execution),
        );
        let mut archive =
            libarchive_open_read_stream(source, format_name, self.libarchive_read_filter())?;
        let mut created_output = false;
        let result = (|| -> Result<(u64, Option<ExtractedFileChecksum>)> {
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
            let output_file = if overwrite {
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(output_path)
                {
                    Ok(file) => {
                        created_output = true;
                        file
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        create_extract_output_file(output_path, true)?
                    }
                    Err(error) => {
                        return Err(RomWeaverError::io_path(
                            rom_weaver_core::IoOp::Create,
                            output_path,
                            error,
                        ));
                    }
                }
            } else {
                let file = create_extract_output_file(output_path, false)?;
                created_output = true;
                file
            };
            let mut output = BufWriter::new(output_file);
            let mut hasher = ExtractHasher::new(context, None, output_path, 1)?;
            let mut copied = 0_u64;
            let mut buffer = vec![0_u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
            loop {
                context.cancel().check()?;
                let read = archive.read_data(
                    &mut buffer,
                    &format!("{format_name} extract failed while reading payload"),
                )?;
                if read == 0 {
                    break;
                }
                output.write_all(&buffer[..read])?;
                hasher.update(&buffer[..read])?;
                if let Some(identity) = hasher.take_ready_identity(output_path) {
                    emit_extract_identity(context, format_name, &identity);
                }
                if let Some(plan) = hasher.take_ready_variant_plan() {
                    emit_variant_plan(context, format_name, output_path, &plan);
                }
                copied = copied.saturating_add(read as u64);
                trace!(format = format_name, copied, "stream extract progress");
            }
            output.flush()?;
            drop(output);
            Ok((copied, hasher.finish(output_path)?))
        })();

        let result = match (result, libarchive_close_read_stream(archive, format_name)) {
            (Ok(bytes), Ok(())) => Ok(bytes),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        };
        if result.is_err() && created_output {
            let _ = fs::remove_file(output_path);
        }
        result
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
            StreamCompression::Lz4 => lz4_signature_matches(source),
        }
    }
}

/// Mirror libarchive's lz4 bidder: skip leading skippable frames (also zstd's skippable magic,
/// so a real lz4 frame must follow), then require a modern or legacy (`lz4 -l`) frame magic.
fn lz4_signature_matches(source: &Path) -> bool {
    const SKIPPABLE_MASK: u32 = 0xFFFF_FFF0;
    const SKIPPABLE_START: u32 = 0x184D_2A50;
    const MAX_LOOKAHEAD: u64 = 64 * 1024;
    let Ok(mut file) = fs::File::open(source) else {
        return false;
    };
    let read_u32 = |file: &mut fs::File| -> Option<u32> {
        let mut bytes = [0u8; 4];
        file.read_exact(&mut bytes).ok()?;
        Some(u32::from_le_bytes(bytes))
    };
    let mut offset = 0u64;
    loop {
        let Some(magic) = read_u32(&mut file) else {
            return false;
        };
        if magic & SKIPPABLE_MASK != SKIPPABLE_START {
            return magic == u32::from_le_bytes(LZ4_SIGNATURE)
                || magic == u32::from_le_bytes(LZ4_LEGACY_SIGNATURE);
        }
        let Some(size) = read_u32(&mut file) else {
            return false;
        };
        offset += 8 + u64::from(size);
        if offset + 8 > MAX_LOOKAHEAD || file.seek(SeekFrom::Start(offset)).is_err() {
            return false;
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
        // The payload name is derived from the wrapper name (`rom.gz` -> `rom`), not stored metadata,
        // so an extension-less name carries no kind information: the name filters cannot reject it.
        // Callers classify such a payload by its bytes (patch magic) after extraction.
        let extensionless = Path::new(&output_name).extension().is_none();
        if !extensionless
            && !request
                .kind_filter
                .matches_payload_or_container_name(&output_name)
        {
            return Err(RomWeaverError::Validation(format!(
                "no extract entries from `{}` matched {}",
                request.source.display(),
                request.kind_filter.flag_label()
            )));
        }

        trace!(
            format = self.descriptor.name,
            payload = %output_name,
            extensionless,
            filter = %request.kind_filter.flag_label(),
            "stream payload accepted by kind filter"
        );
        let output_path = request.out_dir.join(&output_name);
        let (written, checksum) = self.extract_with_libarchive(
            &request.source,
            &output_path,
            request.overwrite,
            context,
            &execution,
        )?;
        selections.ensure_all_matched()?;

        let report = OperationReport::succeeded(
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
        );
        let report = attach_emitted_file_paths(report, &[output_path]);
        Ok(attach_extract_checksum_details(
            report,
            checksum.into_iter().collect(),
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
