/* jscpd:ignore-start */
const RVZ_NOD_CORE: NodHandlerCore = NodHandlerCore::new(&RVZ, NodFormat::Rvz);
const RVZ_INITIAL_EXTRACT_PROGRESS_DIVISOR: u64 = 1000;
const RVZ_INITIAL_EXTRACT_PROGRESS_MAX_PERCENT: f32 = 0.1;

struct RvzContainerHandler;

impl RvzContainerHandler {
    fn extract_read_buffer_size(
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

        let should_emit_initial_zero = !*emitted_initial_zero
            && percent <= RVZ_INITIAL_EXTRACT_PROGRESS_MAX_PERCENT;
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
    ) -> Result<(u64, Option<BTreeMap<String, String>>)> {
        let buffer_size = copy_progress_buffer_size(total_bytes);

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
            first_buffer.truncate(first_bytes_read);
            checksum.update_owned(first_buffer)?;
        }

        if first_bytes_read > 0 && checksum.is_some() {
            loop {
                let mut buffer = vec![0_u8; buffer_size];
                let bytes_read = reader.read(&mut buffer)?;
                if bytes_read == 0 {
                    break;
                }
                writer.write_all(&buffer[..bytes_read])?;
                if let Some(checksum) = checksum.as_mut() {
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
                let bytes_read = reader.read(&mut buffer)?;
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
            Some(checksum) => (bytes_written, Some(checksum.finalize()?)),
            None => (bytes_written, None),
        })
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => {
                let mut compression = NodFormat::Rvz.default_compression();
                if let Some(level) = level {
                    compression =
                        NodCompression::Zstandard(RVZ_NOD_CORE.validate_i8_level("zstd", level)?);
                }
                Ok(compression)
            }
            RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(NodCompression::Zstandard(
                RVZ_NOD_CORE.validate_i8_level("zstd", level.unwrap_or(0))?,
            )),
            RequestedCodec::Known(codec) => Err(RVZ_NOD_CORE.unsupported_codec_error(
                codec.name(),
                "supported codec is zstd",
            )),
            RequestedCodec::Unknown(name) => Err(RVZ_NOD_CORE.unsupported_codec_error(
                &name,
                "supported codec is zstd",
            )),
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
        let mut output_file = self.create_extract_output(&plan.output_path, request.overwrite)?;
        if plan.disc_size > 0 {
            output_file.seek(SeekFrom::Start(0))?;
        }
        let mut output = BufWriter::new(output_file);
        let (bytes_written, checksums) = self.copy_extract_with_progress(
            &mut plan.disc,
            &mut output,
            plan.disc_size,
            context,
            &plan.execution,
        )?;
        output.flush()?;

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

        RVZ_NOD_CORE.ensure_create_output_parent(&request.output)?;

        let mut last_emitted_percent = -1.0_f32;
        let output_bytes = RVZ_NOD_CORE.process_create_with_progress(
            input,
            &request.output,
            &options,
            &execution,
            |processed_bytes, total| {
                let percent = ((processed_bytes as f32 / total as f32) * 100.0).clamp(0.0, 100.0);
                if percent < 100.0 && percent - last_emitted_percent >= 1.0 {
                    last_emitted_percent = percent;
                    emit_container_running_progress(
                        context,
                        "compress",
                        RVZ.name,
                        "create",
                        format!("creating rvz ({percent:.0}%)"),
                        percent,
                        Some(&execution),
                    );
                }
            },
        )?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "create",
            format!(
                "created rvz `{}` from `{}` (codec={}, block={} bytes, {} bytes)",
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

        let mut last_emitted_percent = -1.0_f32;
        RVZ_NOD_CORE.process_create_dry_run_size_with_progress(
            input,
            &options,
            &execution,
            |processed_bytes, total| {
                let percent = ((processed_bytes as f32 / total as f32) * 100.0).clamp(0.0, 100.0);
                if percent < 100.0 && percent - last_emitted_percent >= 1.0 {
                    last_emitted_percent = percent;
                    emit_container_running_progress(
                        context,
                        "compress",
                        RVZ.name,
                        "create",
                        format!("creating rvz ({percent:.0}%)"),
                        percent,
                        Some(&execution),
                    );
                }
            },
        )
    }
}
/* jscpd:ignore-end */
