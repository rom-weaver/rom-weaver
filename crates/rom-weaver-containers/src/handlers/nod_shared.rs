use super::*;
use tracing::{debug, trace};

#[derive(Clone, Copy)]
pub(crate) struct NodHandlerCore {
    descriptor: &'static FormatDescriptor,
    nod_format: NodFormat,
}

pub(crate) struct NodExtractPlan {
    pub(crate) execution: ThreadExecution,
    pub(crate) disc: NodDiscReader,
    pub(crate) disc_size: u64,
    pub(crate) compression_label: String,
    pub(crate) output_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NodCreateThreadPlan {
    preloader_threads: usize,
    processor_threads: usize,
}

#[cfg(target_family = "wasm")]
#[derive(Debug)]
struct ReopenablePathDiscStream {
    path: PathBuf,
    file: Option<File>,
}

#[cfg(target_family = "wasm")]
impl ReopenablePathDiscStream {
    fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            file: None,
        }
    }

    fn file(&mut self) -> io::Result<&mut File> {
        if self.file.is_none() {
            self.file = Some(File::open(&self.path)?);
        }
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("failed to reopen disc stream"))
    }
}

#[cfg(target_family = "wasm")]
impl Clone for ReopenablePathDiscStream {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            file: None,
        }
    }
}

#[cfg(target_family = "wasm")]
impl crate::nod::read::DiscStream for ReopenablePathDiscStream {
    fn read_exact_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        let file = self.file()?;
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(buf)
    }

    fn stream_len(&mut self) -> io::Result<u64> {
        self.file()?.seek(SeekFrom::End(0))
    }
}

impl NodHandlerCore {
    pub(crate) const fn new(descriptor: &'static FormatDescriptor, nod_format: NodFormat) -> Self {
        Self {
            descriptor,
            nod_format,
        }
    }

    fn format_name(&self) -> &'static str {
        self.descriptor.name
    }

    fn negotiated_threads(&self, execution: &ThreadExecution) -> usize {
        if execution.used_parallelism {
            execution.effective_threads
        } else {
            0
        }
    }

    fn negotiated_preloader_threads(&self, execution: &ThreadExecution) -> usize {
        // Preloader fanout follows the full negotiated worker-thread budget; worker reuse keeps
        // browser WASI startup bounded, so no separate native/wasm cap is applied.
        self.negotiated_threads(execution)
    }

    fn create_thread_plan(&self, execution: &ThreadExecution) -> NodCreateThreadPlan {
        let total_threads = self.negotiated_threads(execution);
        if total_threads == 0 {
            return NodCreateThreadPlan {
                preloader_threads: 0,
                processor_threads: 0,
            };
        }

        // Create has two internal worker consumers: the preloader (reads, and for compressed
        // sources decompresses, the input) and the processor (compresses the output). The
        // processor is the throughput bottleneck for disc create - especially at high zstd levels,
        // where compression dwarfs reading a raw source - so an even split parks ~half the budget
        // on a largely idle preloader. Bias toward processors (~3/4), keeping >=1 processor.
        let processor_threads = (total_threads - total_threads / 4).max(1);
        let preloader_threads = total_threads - processor_threads;
        NodCreateThreadPlan {
            preloader_threads,
            processor_threads,
        }
    }

    #[cfg(test)]
    pub(crate) fn create_thread_counts_for_test(
        &self,
        execution: &ThreadExecution,
    ) -> (usize, usize) {
        let plan = self.create_thread_plan(execution);
        (plan.preloader_threads, plan.processor_threads)
    }

    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        NodDiscOptions {
            preloader_threads,
            ..Default::default()
        }
    }

    fn open_disc_with<E, F>(
        &self,
        source: &Path,
        preloader_threads: usize,
        open_disc: F,
    ) -> Result<NodDiscReader>
    where
        E: std::fmt::Display,
        F: FnOnce(&Path, &NodDiscOptions) -> std::result::Result<NodDiscReader, E>,
    {
        let options = self.read_options(preloader_threads);
        open_disc(source, &options).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open {} source `{}`: {error}",
                self.format_name(),
                source.display()
            ))
        })
    }

    pub(crate) fn open_disc(
        &self,
        source: &Path,
        preloader_threads: usize,
    ) -> Result<NodDiscReader> {
        self.open_disc_with(source, preloader_threads, |path, options| {
            self.open_disc_from_path_or_stream(path, options)
        })
    }

    fn open_disc_from_path_or_stream(
        &self,
        source: &Path,
        options: &NodDiscOptions,
    ) -> std::result::Result<NodDiscReader, String> {
        #[cfg(target_family = "wasm")]
        if self.nod_format != NodFormat::Nfs {
            // Browser WASI thread workers have their own fd tables, so cloned NOD readers must
            // reopen the path inside the worker instead of carrying a parent-opened fd number.
            match NodDiscReader::new_stream(
                Box::new(ReopenablePathDiscStream::new(source)),
                options,
            ) {
                Ok(disc) => return Ok(disc),
                Err(stream_error) => {
                    return NodDiscReader::new(source, options).map_err(|path_error| {
                        format!("{stream_error}; path fallback failed: {path_error}")
                    });
                }
            }
        }

        match NodDiscReader::new(source, options) {
            Ok(disc) => Ok(disc),
            Err(path_error) if self.nod_format != NodFormat::Nfs => {
                let mut fallback_options = options.clone();
                // Non-cloneable stream fallback is mutex-serialized, so preloader fanout only
                // adds startup thread spawn overhead without improving throughput.
                fallback_options.preloader_threads = 0;
                let file = File::open(source).map_err(|stream_open_error| {
                    format!("{path_error}; stream fallback open failed: {stream_open_error}")
                })?;
                NodDiscReader::new_from_non_cloneable_read(file, &fallback_options).map_err(
                    |stream_error| format!("{path_error}; stream fallback failed: {stream_error}"),
                )
            }
            Err(path_error) => Err(path_error.to_string()),
        }
    }

    fn open_disc_for_probe(&self, source: &Path) -> Result<NodDiscReader> {
        self.open_disc(source, 0)
    }

    fn detect_disc_format(&self, source: &Path) -> Option<NodFormat> {
        let mut file = File::open(source).ok()?;
        NodDiscReader::detect(&mut file).ok().flatten()
    }

    fn validate_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<crate::nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == self.nod_format {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a {} container (detected {})",
                source.display(),
                self.format_name(),
                meta.format
            )))
        }
    }

    pub(crate) fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.detect_disc_format(source) == Some(self.nod_format) {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    pub(crate) fn probe_details_with(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
        open_disc: impl FnOnce(&Path) -> Result<NodDiscReader>,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        emit_container_indeterminate_progress(
            context,
            "probe",
            self.format_name(),
            "probe",
            format!("opening {} metadata", self.format_name()),
            Some(&execution),
        );
        let disc = open_disc(&request.source)?;
        let meta = self.validate_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        trace!(
            format = self.format_name(),
            disc_size,
            compression = %compression_label,
            "nod disc probe"
        );
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.format_name().to_string()),
            "probe",
            format!(
                "{}: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                self.format_name(),
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    pub(crate) fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.probe_details_with(request, context, |source| self.open_disc_for_probe(source))
    }

    pub(crate) fn list_entries(&self, source: &Path) -> Vec<String> {
        vec![self.extract_name(source)]
    }

    /// Enumerate the single decompressed output and its disc size using only the disc metadata
    /// (no block decode), so input discovery can list the produced file without a full extract.
    pub(crate) fn list_entry_records_for_probe(
        &self,
        source: &Path,
    ) -> Result<Vec<ContainerListEntry>> {
        let disc = self.open_disc_for_probe(source)?;
        let meta = self.validate_meta(source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        Ok(vec![ContainerListEntry {
            path: self.extract_name(source),
            size: Some(disc_size),
        }])
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }

    pub(crate) fn prepare_extract_with(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
        open_disc: impl FnOnce(&Path, usize) -> Result<NodDiscReader>,
    ) -> Result<NodExtractPlan> {
        let output_name = self.extract_name(&request.source);
        request.ensure_single_output_selected(&output_name)?;

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads = self.negotiated_preloader_threads(&execution);
        emit_container_indeterminate_progress(
            context,
            "extract",
            self.format_name(),
            "prepare",
            format!("opening {} for extraction", self.format_name()),
            Some(&execution),
        );
        let disc = open_disc(&request.source, preloader_threads)?;
        emit_container_indeterminate_progress(
            context,
            "extract",
            self.format_name(),
            "prepare",
            format!("preparing {} output", self.format_name()),
            Some(&execution),
        );
        let meta = self.validate_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        debug!(
            format = self.format_name(),
            disc_size,
            compression = %compression_label,
            preloader_threads,
            used_parallelism = execution.used_parallelism,
            effective_threads = execution.effective_threads,
            "nod disc extract prepared"
        );

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(output_name);

        Ok(NodExtractPlan {
            execution,
            disc,
            disc_size,
            compression_label,
            output_path,
        })
    }

    fn prepare_extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<NodExtractPlan> {
        self.prepare_extract_with(request, context, |source, preloader_threads| {
            self.open_disc(source, preloader_threads)
        })
    }

    pub(crate) fn extract_with_standard_copy(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut plan = self.prepare_extract(request, context)?;
        let mut output = BufWriter::new(create_extract_output_file(
            &plan.output_path,
            request.overwrite,
        )?);
        let progress_label = format!("extracting `{}`", self.format_name());
        let bytes_written = copy_reader_with_progress(
            &mut plan.disc,
            &mut output,
            plan.disc_size,
            &ContainerProgressContext {
                context,
                command: "extract",
                format: self.format_name(),
                stage: "extract",
                thread_execution: Some(&plan.execution),
            },
            &progress_label,
        )?;
        output.flush()?;

        Ok(self.extracted_report(
            &request.source,
            &plan.output_path,
            bytes_written,
            plan.disc_size,
            &plan.compression_label,
            plan.execution,
        ))
    }

    pub(crate) fn extracted_report(
        &self,
        source: &Path,
        output_path: &Path,
        bytes_written: u64,
        disc_size: u64,
        compression_label: &str,
        execution: ThreadExecution,
    ) -> OperationReport {
        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.format_name().to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        let report = attach_extraction_details(report, 1, 1, bytes_written, &execution);
        attach_emitted_file_paths(report, &[output_path])
    }

    pub(crate) fn ensure_single_create_input<'a>(
        &self,
        request: &'a ContainerCreateRequest,
    ) -> Result<&'a Path> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} create currently requires exactly one input file",
                self.format_name()
            )));
        }
        Ok(request.inputs[0].as_path())
    }

    pub(crate) fn ensure_create_output_parent(&self, output: &Path) -> Result<()> {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    pub(crate) fn process_create_with_progress<F>(
        &self,
        input: &Path,
        output_path: &Path,
        options: &NodFormatOptions,
        execution: &ThreadExecution,
        mut emit_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64, u64),
    {
        let thread_plan = self.create_thread_plan(execution);
        debug!(
            format = self.format_name(),
            input = %input.display(),
            preloader_threads = thread_plan.preloader_threads,
            processor_threads = thread_plan.processor_threads,
            "nod disc create start"
        );
        let read_options = self.read_options(thread_plan.preloader_threads);
        let input_disc = self
            .open_disc_from_path_or_stream(input, &read_options)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for {} create: {error}",
                    input.display(),
                    self.format_name()
                ))
            })?;

        let writer = NodDiscWriter::new(input_disc, options).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to initialize {} writer: {error}",
                self.format_name()
            ))
        })?;

        // Wrap the output in a BufWriter: in the parallel create pipeline every compressed
        // block funnels through this single callback on the main thread, so coalescing the
        // per-block writes into larger syscalls keeps the worker threads from stalling on I/O.
        let mut output = BufWriter::new(File::create(output_path)?);
        let process_options = NodProcessOptions {
            processor_threads: thread_plan.processor_threads,
            ..Default::default()
        };
        let finalization = writer
            .process(
                |data, processed, total| {
                    output.write_all(data.as_ref())?;
                    if total > 0 {
                        emit_progress(processed.min(total), total);
                    }
                    Ok(())
                },
                &process_options,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!("{} create failed: {error}", self.format_name()))
            })?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        let output_bytes = fs::metadata(output_path)?.len();
        debug!(
            format = self.format_name(),
            output_bytes, "nod disc create complete"
        );
        Ok(output_bytes)
    }

    pub(crate) fn process_create_dry_run_size_with_progress<F>(
        &self,
        input: &Path,
        options: &NodFormatOptions,
        execution: &ThreadExecution,
        mut emit_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64, u64),
    {
        let thread_plan = self.create_thread_plan(execution);
        let read_options = self.read_options(thread_plan.preloader_threads);
        let input_disc = self
            .open_disc_from_path_or_stream(input, &read_options)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for {} create: {error}",
                    input.display(),
                    self.format_name()
                ))
            })?;

        let writer = NodDiscWriter::new(input_disc, options).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to initialize {} writer: {error}",
                self.format_name()
            ))
        })?;

        let mut output_bytes = 0_u64;
        let process_options = NodProcessOptions {
            processor_threads: thread_plan.processor_threads,
            ..Default::default()
        };
        let finalization = writer
            .process(
                |data, processed, total| {
                    output_bytes = output_bytes.saturating_add(data.as_ref().len() as u64);
                    if total > 0 {
                        emit_progress(processed.min(total), total);
                    }
                    Ok(())
                },
                &process_options,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!("{} create failed: {error}", self.format_name()))
            })?;
        if !finalization.header.is_empty() {
            output_bytes = output_bytes.max(finalization.header.len() as u64);
        }
        Ok(output_bytes)
    }

    pub(crate) fn validate_i8_level(&self, codec: &str, level: i32) -> Result<i8> {
        i8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} codec `{codec}` level `{level}` is out of range",
                self.format_name()
            ))
        })
    }
}

/// Generate an extract-only NOD container handler that forwards every operation to a shared
/// [`NodHandlerCore`]. The five GameCube/Wii compressed formats (GCZ/WBFS/TGC/NFS/WIA) decode
/// identically; only the descriptor and [`NodFormat`] variant differ. `create` is rejected with
/// the standard "extract-only" message.
macro_rules! nod_extract_only_handler {
    ($core:ident, $handler:ident, $descriptor:expr, $format:expr $(,)?) => {
        const $core: NodHandlerCore = NodHandlerCore::new($descriptor, $format);

        pub(crate) struct $handler;

        impl ContainerHandlerOperations for $handler {
            fn descriptor(&self) -> &'static FormatDescriptor {
                $descriptor
            }

            fn probe(&self, source: &Path) -> ProbeConfidence {
                $core.probe(source)
            }

            fn probe_details(
                &self,
                request: &ContainerProbeRequest,
                context: &OperationContext,
            ) -> Result<OperationReport> {
                $core.probe_details(request, context)
            }

            fn list_entries(
                &self,
                request: &ContainerProbeRequest,
                _context: &OperationContext,
            ) -> Result<Vec<String>> {
                Ok($core.list_entries(&request.source))
            }

            fn extract(
                &self,
                request: &ContainerExtractRequest,
                context: &OperationContext,
            ) -> Result<OperationReport> {
                $core.extract_with_standard_copy(request, context)
            }

            fn create(
                &self,
                request: &ContainerCreateRequest,
                context: &OperationContext,
            ) -> Result<OperationReport> {
                let _ = (request, context);
                Err(extract_only_create_error($descriptor.name))
            }
        }
    };
}

pub(crate) use nod_extract_only_handler;
