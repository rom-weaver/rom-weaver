use super::*;
use rom_weaver_checksum::IdentityPrefix;
use tracing::{debug, trace};

/// `(bytes_written, optional per-file checksums, identity prefix)` from the RVZ
/// extract copy loop — the identity prefix is fed the same decoded stream as the
/// checksum so the caller can detect platform/medium without a second read.
type RvzExtractOutput = (u64, Option<BTreeMap<String, String>>, IdentityPrefix);

/// RVZ container file magic (`RVZ\x01`), mirroring `nod`'s `RVZ_MAGIC`. Canonical
/// source for the web UI's synchronous rom-specific magic probe (surfaced via
/// typegen container metadata).
pub(crate) const RVZ_MAGIC: [u8; 4] = *b"RVZ\x01";

const RVZ_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&RVZ, NodFormat::Rvz);
const RVZ_INITIAL_EXTRACT_PROGRESS_DIVISOR: u64 = 1000;
const RVZ_INITIAL_EXTRACT_PROGRESS_MAX_PERCENT: f32 = 0.1;

pub(crate) struct RvzContainerHandler;

impl RvzContainerHandler {
    const SUPPORTED_CODECS: &[&str] = &["zstd"];

    pub(crate) fn extract_read_buffer_size(
        default_buffer_size: usize,
        total_bytes: u64,
        bytes_written: u64,
    ) -> usize {
        if bytes_written != 0 || total_bytes < RVZ_INITIAL_EXTRACT_PROGRESS_DIVISOR {
            return default_buffer_size;
        }
        (total_bytes / RVZ_INITIAL_EXTRACT_PROGRESS_DIVISOR)
            .max(1)
            .min(default_buffer_size as u64) as usize
    }

    /// Reads from `reader` into `buffer` until it is full or the reader is exhausted, returning the
    /// number of bytes filled. The disc reader returns short reads (~1.3 MiB), so writing each one
    /// directly lands every `write_all` just under the host file shim's direct-write threshold,
    /// forcing a full-size staging-buffer copy on the OPFS/wasm side. Coalescing the short reads into
    /// one large buffer here lets each downstream write clear that threshold and skip the copy —
    /// without adding a copy of our own, since each read writes straight into `buffer` at its offset.
    fn fill_extract_buffer<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<usize> {
        let mut filled = 0;
        while filled < buffer.len() {
            let read = reader.read(&mut buffer[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        Ok(filled)
    }

    fn maybe_emit_extract_progress(
        context: &OperationContext,
        total_bytes: u64,
        bytes_written: u64,
        last_emitted_percent: &mut f32,
        emitted_initial_zero: &mut bool,
        execution: &ThreadExecution,
    ) {
        if total_bytes == 0 || bytes_written == 0 {
            return;
        }

        let percent = ((bytes_written.min(total_bytes) as f32 / total_bytes as f32) * 100.0)
            .clamp(0.0, 100.0);
        if percent >= 100.0 {
            return;
        }

        let should_emit_initial_zero =
            !*emitted_initial_zero && percent <= RVZ_INITIAL_EXTRACT_PROGRESS_MAX_PERCENT;
        if should_emit_initial_zero || percent - *last_emitted_percent >= 1.0 {
            *last_emitted_percent = percent;
            if should_emit_initial_zero {
                *emitted_initial_zero = true;
            }
            emit_container_running_progress(
                context,
                "extract",
                RVZ.name,
                "extract",
                format!("extracting rvz ({percent:.0}%)"),
                percent,
                Some(execution),
            );
        }
    }

    fn maybe_emit_create_progress(
        context: &OperationContext,
        total_units: u64,
        processed_units: u64,
        last_emitted_percent: &mut u8,
        execution: &ThreadExecution,
    ) {
        if total_units == 0 || processed_units == 0 {
            return;
        }

        let percent_bucket = (((processed_units.min(total_units) as u128) * 100)
            / total_units as u128)
            .min(100) as u8;
        if percent_bucket == 0 || percent_bucket >= 100 || percent_bucket <= *last_emitted_percent {
            return;
        }

        let start_bucket = last_emitted_percent.saturating_add(1);
        for bucket in start_bucket..=percent_bucket {
            emit_container_running_progress(
                context,
                "compress",
                RVZ.name,
                "create",
                format!("creating rvz ({bucket}%)"),
                bucket as f32,
                Some(execution),
            );
        }
        *last_emitted_percent = percent_bucket;
    }

    fn open_disc(&self, source: &Path) -> Result<NodDiscReader> {
        self.open_disc_with_threads(source, 0)
    }

    fn open_disc_with_threads(
        &self,
        source: &Path,
        preloader_threads: usize,
    ) -> Result<NodDiscReader> {
        RVZ_NOD_CORE.open_disc(source, preloader_threads)
    }

    fn create_extract_output(&self, output_path: &Path, overwrite: bool) -> Result<File> {
        if !overwrite {
            return create_extract_output_file(output_path, false);
        }
        match File::create(output_path) {
            Ok(file) => Ok(file),
            Err(error) if error.raw_os_error() == Some(69) => OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(output_path)
                .map_err(RomWeaverError::from),
            Err(error) => Err(RomWeaverError::from(error)),
        }
    }

    fn copy_extract_with_progress<R: Read>(
        &self,
        reader: &mut R,
        writer: &mut BufWriter<File>,
        total_bytes: u64,
        context: &OperationContext,
        execution: &ThreadExecution,
        extension: Option<&str>,
    ) -> Result<RvzExtractOutput> {
        let buffer_size = copy_progress_buffer_size(total_bytes);
        // Identity detection is a separate consumer of the same decoded stream as the
        // checksum — fed alongside it, no extra read.
        let mut identity = IdentityPrefix::new();
        // Tracks the one-shot mid-extract `probe-identity` emission so the ROM-type tag pops as soon
        // as the disc header has decoded, not only at completion.
        let mut identity_emitted = false;

        let mut bytes_written = 0_u64;
        let mut last_emitted_percent = -1.0_f32;
        let mut emitted_initial_zero = false;
        let checksum_algorithm_count =
            StreamingChecksum::requested_algorithm_count(context.extract_checksum_algorithms())?;

        let first_read_size =
            Self::extract_read_buffer_size(buffer_size, total_bytes, bytes_written);
        let mut first_buffer = vec![0_u8; first_read_size];
        let first_bytes_read = reader.read(&mut first_buffer)?;
        if first_bytes_read > 0 {
            writer.write_all(&first_buffer[..first_bytes_read])?;
            bytes_written = bytes_written.saturating_add(first_bytes_read as u64);
            Self::maybe_emit_extract_progress(
                context,
                total_bytes,
                bytes_written,
                &mut last_emitted_percent,
                &mut emitted_initial_zero,
                execution,
            );
            if total_bytes > 0 {
                writer.get_ref().set_len(total_bytes)?;
            }
        }

        let mut checksum = if checksum_algorithm_count == 0 {
            None
        } else {
            create_extract_checksum(context)?
        };
        if first_bytes_read > 0
            && let Some(checksum) = checksum.as_mut()
        {
            stream_extract_identity(
                context,
                RVZ.name,
                &mut identity,
                &mut identity_emitted,
                total_bytes,
                extension,
                &first_buffer[..first_bytes_read],
            );
            first_buffer.truncate(first_bytes_read);
            checksum.update_owned(first_buffer)?;
        }

        if first_bytes_read > 0 && checksum.is_some() {
            loop {
                let mut buffer = vec![0_u8; buffer_size];
                let bytes_read = Self::fill_extract_buffer(reader, &mut buffer)?;
                if bytes_read == 0 {
                    break;
                }
                writer.write_all(&buffer[..bytes_read])?;
                if let Some(checksum) = checksum.as_mut() {
                    stream_extract_identity(
                        context,
                        RVZ.name,
                        &mut identity,
                        &mut identity_emitted,
                        total_bytes,
                        extension,
                        &buffer[..bytes_read],
                    );
                    buffer.truncate(bytes_read);
                    checksum.update_owned(buffer)?;
                }
                bytes_written = bytes_written.saturating_add(bytes_read as u64);
                Self::maybe_emit_extract_progress(
                    context,
                    total_bytes,
                    bytes_written,
                    &mut last_emitted_percent,
                    &mut emitted_initial_zero,
                    execution,
                );
            }
        } else if first_bytes_read > 0 {
            let mut buffer = vec![0_u8; buffer_size];
            loop {
                let bytes_read = Self::fill_extract_buffer(reader, &mut buffer)?;
                if bytes_read == 0 {
                    break;
                }
                writer.write_all(&buffer[..bytes_read])?;
                bytes_written = bytes_written.saturating_add(bytes_read as u64);
                Self::maybe_emit_extract_progress(
                    context,
                    total_bytes,
                    bytes_written,
                    &mut last_emitted_percent,
                    &mut emitted_initial_zero,
                    execution,
                );
            }
        }

        Ok(match checksum {
            Some(checksum) => (bytes_written, Some(checksum.finalize()?), identity),
            None => (bytes_written, None, identity),
        })
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        let explicit_codec = codec.map(str::trim).is_some_and(|codec| !codec.is_empty());
        match resolve_create_codec(RVZ.name, codec, Self::SUPPORTED_CODECS, "zstd")? {
            "zstd" if !explicit_codec => {
                let mut compression = NodFormat::Rvz.default_compression();
                if let Some(level) = level {
                    compression =
                        NodCompression::Zstandard(RVZ_NOD_CORE.validate_i8_level("zstd", level)?);
                }
                Ok(compression)
            }
            "zstd" => Ok(NodCompression::Zstandard(
                RVZ_NOD_CORE.validate_i8_level("zstd", level.unwrap_or(0))?,
            )),
            _ => unreachable!("validated rvz create codec"),
        }
    }
}

impl ContainerHandlerOperations for RvzContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &RVZ
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Rvz
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        RVZ_NOD_CORE.probe_details_with(request, context, |source| self.open_disc(source))
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(RVZ_NOD_CORE.list_entries(&request.source))
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        RVZ_NOD_CORE.list_entry_records_for_probe(&request.source)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut plan =
            RVZ_NOD_CORE.prepare_extract_with(request, context, |source, preloader_threads| {
                self.open_disc_with_threads(source, preloader_threads)
            })?;
        trace!(
            format = RVZ.name,
            disc_size = plan.disc_size,
            compression = %plan.compression_label,
            effective_threads = plan.execution.effective_threads,
            "rvz extract begin output copy"
        );
        let mut output_file = self.create_extract_output(&plan.output_path, request.overwrite)?;
        if plan.disc_size > 0 {
            output_file.seek(SeekFrom::Start(0))?;
        }
        let mut output = BufWriter::new(output_file);
        let extension = plan
            .output_path
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()));
        let (bytes_written, checksums, identity) = self.copy_extract_with_progress(
            &mut plan.disc,
            &mut output,
            plan.disc_size,
            context,
            &plan.execution,
            extension.as_deref(),
        )?;
        output.flush()?;
        let rom_identity = identity.detect(extension.as_deref());

        let report = RVZ_NOD_CORE.extracted_report(
            &request.source,
            &plan.output_path,
            bytes_written,
            plan.disc_size,
            &plan.compression_label,
            plan.execution,
        );
        Ok(match checksums {
            Some(values) => attach_extract_checksum_details(
                report,
                vec![ExtractedFileChecksum {
                    path: plan.output_path,
                    values,
                    variants: Vec::new(),
                    timing: None,
                    rom_identity,
                }],
            ),
            None => report,
        })
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let input = RVZ_NOD_CORE.ensure_single_create_input(request)?;
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Rvz,
            compression,
            block_size: NodFormat::Rvz.default_block_size(),
        };
        let input_bytes = fs::metadata(input)?.len();
        let compression_label = normalize_codec_label(&options.compression.to_string());
        let compression_level = match &options.compression {
            NodCompression::Zstandard(level) => Some(i32::from(*level)),
            _ => None,
        };
        debug!(
            format = RVZ.name,
            input = %input.display(),
            input_bytes,
            compression = %compression_label,
            block_size = options.block_size,
            effective_threads = execution.effective_threads,
            "rvz create start"
        );

        RVZ_NOD_CORE.ensure_create_output_parent(&request.output)?;

        let mut last_emitted_percent = 0_u8;
        let output_bytes = RVZ_NOD_CORE.process_create_with_progress(
            input,
            &request.output,
            &options,
            &execution,
            |processed_bytes, total| {
                Self::maybe_emit_create_progress(
                    context,
                    total,
                    processed_bytes,
                    &mut last_emitted_percent,
                    &execution,
                );
            },
        )?;

        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "create",
            format!(
                "created rvz `{}` from `{}` (codec={}, block={} bytes, {} bytes)",
                request.output.display(),
                input.display(),
                compression_label,
                options.block_size,
                output_bytes
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        Ok(attach_compression_details(
            report,
            compression_label,
            compression_level,
            input_bytes,
            &execution,
        ))
    }

    fn create_dry_run_size(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<u64> {
        let input = RVZ_NOD_CORE.ensure_single_create_input(request)?;
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Rvz,
            compression,
            block_size: NodFormat::Rvz.default_block_size(),
        };

        let mut last_emitted_percent = 0_u8;
        RVZ_NOD_CORE.process_create_dry_run_size_with_progress(
            input,
            &options,
            &execution,
            |processed_bytes, total| {
                Self::maybe_emit_create_progress(
                    context,
                    total,
                    processed_bytes,
                    &mut last_emitted_percent,
                    &execution,
                );
            },
        )
    }
}
