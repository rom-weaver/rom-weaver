use super::*;
use rom_weaver_core::{
    CancellationToken, SharedThreadPool, VALIDATION_CODE_WBFS_SIZE_MISMATCH, ValidationCodeError,
};
#[cfg(target_family = "wasm")]
use std::collections::HashMap;
#[cfg(target_family = "wasm")]
use std::thread::ThreadId;
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
    /// WIA/RVZ integrity checks that run during the output copy.
    pub(crate) integrity: Option<IntegrityCheck>,
}

/// Integrity checks folded into the single WIA/RVZ output copy: Wii partitions whose H0-H3
/// hashes the disc reader verifies while it is read, and optional NKit image digests computed
/// over the bytes written. Mismatches become warnings once the copy finishes.
pub(crate) struct IntegrityCheck {
    format: &'static str,
    partitions: Vec<usize>,
    digests: Option<ImageDigests>,
}

/// Adds the disc header's game ID and title, and each Wii partition's kind and data size, to
/// probe details. Fields that are blank or not valid text are left out.
pub(crate) fn write_disc_header_details(
    disc: &NodDiscReader,
    details: &mut serde_json::Map<String, serde_json::Value>,
) {
    let header = disc.header();
    let printable = |text: &str| {
        let text = text.trim();
        (!text.is_empty() && !text.chars().any(char::is_control)).then(|| text.to_string())
    };
    let game_id = std::str::from_utf8(&header.game_id)
        .ok()
        .and_then(printable);
    let title = std::ffi::CStr::from_bytes_until_nul(&header.game_title)
        .ok()
        .and_then(|title| title.to_str().ok())
        .and_then(printable);
    trace!(
        ?game_id,
        ?title,
        partitions = disc.partitions().len(),
        "nod disc probe header"
    );
    if let Some(game_id) = game_id {
        details.insert("game_id".to_string(), game_id.into());
    }
    if let Some(title) = title {
        details.insert("title".to_string(), title.into());
    }
    if !disc.partitions().is_empty() {
        let partitions = disc
            .partitions()
            .iter()
            .map(|partition| {
                serde_json::json!({
                    "index": partition.index,
                    "kind": partition.kind.to_string(),
                    "data_size": partition.data_size(),
                })
            })
            .collect();
        details.insert(
            "partitions".to_string(),
            serde_json::Value::Array(partitions),
        );
    }
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
    // Every spawned wasm thread runs in its own worker with its own WASI fd table, so a descriptor
    // is only meaningful on the thread that opened it - reading one from another thread yields
    // EBADF, and *closing* one from another thread evicts whatever that thread has under the same
    // number. Cloning gives each thread its own handle, but a single instance can still be shared:
    // nod's preloader falls back to one mutex-guarded loader when it has no preloader threads, and
    // the block processors then read through it concurrently. Keep one handle per calling thread so
    // no descriptor is ever read or dropped off-thread.
    files: HashMap<ThreadId, File>,
}

#[cfg(target_family = "wasm")]
impl ReopenablePathDiscStream {
    fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            files: HashMap::new(),
        }
    }

    fn file(&mut self) -> io::Result<&mut File> {
        use std::collections::hash_map::Entry;

        match self.files.entry(std::thread::current().id()) {
            Entry::Occupied(entry) => Ok(entry.into_mut()),
            Entry::Vacant(entry) => Ok(entry.insert(File::open(&self.path)?)),
        }
    }
}

#[cfg(target_family = "wasm")]
impl Drop for ReopenablePathDiscStream {
    fn drop(&mut self) {
        // Closing another thread's descriptor would corrupt that thread's fd table. Whoever drops
        // the stream may not be the thread that opened every handle, so release only its own and
        // leak the rest; those tables die with their worker.
        let current = std::thread::current().id();
        for (owner, file) in self.files.drain() {
            if owner != current {
                std::mem::forget(file);
            }
        }
    }
}

#[cfg(target_family = "wasm")]
impl Clone for ReopenablePathDiscStream {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            files: HashMap::new(),
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

        // Create splits workers between the preloader and output processor.
        // Reserve most workers for compression while keeping a preloader active.
        //
        // Keep >=1 preloader thread whenever there is more than one thread to split: with zero of
        // them nod's preloader serves every processor from a single shared loader, which is both a
        // read bottleneck and, in the browser, a cross-thread descriptor hazard.
        let preloader_threads = if total_threads > 1 {
            (total_threads / 4).max(1)
        } else {
            0
        };
        let processor_threads = (total_threads - preloader_threads).max(1);
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

    fn open_disc_with<F>(
        &self,
        source: &Path,
        preloader_threads: usize,
        open_disc: F,
    ) -> Result<NodDiscReader>
    where
        F: FnOnce(&Path, &NodDiscOptions) -> std::result::Result<NodDiscReader, DiscOpenFailure>,
    {
        let options = self.read_options(preloader_threads);
        open_disc(source, &options).map_err(|failure| {
            let message = format!(
                "failed to open {} source `{}`: {}",
                self.format_name(),
                source.display(),
                failure.message
            );
            match failure.wbfs_size {
                Some((actual, expected)) => RomWeaverError::ValidationCode(
                    ValidationCodeError::new(VALIDATION_CODE_WBFS_SIZE_MISMATCH)
                        .with_message(message)
                        .with_field("actual", actual)
                        .with_field("expected", expected),
                ),
                None => RomWeaverError::Validation(message),
            }
        })
    }

    pub(crate) fn open_disc(
        &self,
        source: &Path,
        preloader_threads: usize,
    ) -> Result<NodDiscReader> {
        self.open_disc_with(source, preloader_threads, |path, options| {
            self.open_disc_detailed(path, options)
        })
    }

    fn open_disc_from_path_or_stream(
        &self,
        source: &Path,
        options: &NodDiscOptions,
    ) -> std::result::Result<NodDiscReader, String> {
        self.open_disc_detailed(source, options)
            .map_err(|failure| failure.message)
    }

    /// Opens a disc by path, falling back to a stream. The failure keeps the last WBFS size
    /// mismatch, because the message joins every attempt's report.
    fn open_disc_detailed(
        &self,
        source: &Path,
        options: &NodDiscOptions,
    ) -> std::result::Result<NodDiscReader, DiscOpenFailure> {
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
                        DiscOpenFailure {
                            message: format!("{stream_error}; path fallback failed: {path_error}"),
                            wbfs_size: wbfs_size_mismatch(&path_error)
                                .or_else(|| wbfs_size_mismatch(&stream_error)),
                        }
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
                let file = File::open(source).map_err(|stream_open_error| DiscOpenFailure {
                    message: format!(
                        "{path_error}; stream fallback open failed: {stream_open_error}"
                    ),
                    wbfs_size: wbfs_size_mismatch(&path_error),
                })?;
                NodDiscReader::new_from_non_cloneable_read(file, &fallback_options).map_err(
                    |stream_error| {
                        // The path attempt reads the whole split set; the stream fallback sees one file.
                        let wbfs_size = wbfs_size_mismatch(&path_error)
                            .or_else(|| wbfs_size_mismatch(&stream_error));
                        let stream_message = stream_error.to_string();
                        let path_message = path_error.to_string();
                        // Both attempts usually fail identically; report that once.
                        let message = if stream_message == path_message {
                            path_message
                        } else {
                            format!("{path_message}; stream fallback failed: {stream_message}")
                        };
                        DiscOpenFailure { message, wbfs_size }
                    },
                )
            }
            Err(path_error) => Err(DiscOpenFailure {
                message: path_error.to_string(),
                wbfs_size: wbfs_size_mismatch(&path_error),
            }),
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
        let mut disc = open_disc(&request.source)?;
        let meta = self.validate_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        trace!(
            format = self.format_name(),
            disc_size,
            compression = %compression_label,
            "nod disc probe"
        );
        // Detect the console from a bounded DECODED prefix, so a metadata-only
        // probe of a compressed disc still reports its platform. Hosts use it
        // to pick which identify database to load before hashing.
        let identity = {
            use std::io::Read;
            let take = disc_size.min(rom_weaver_checksum::DETECT_PREFIX_BYTES as u64);
            let mut prefix = Vec::new();
            match (&mut disc).take(take).read_to_end(&mut prefix) {
                Ok(_) => rom_weaver_checksum::detect_rom_identity(&prefix, disc_size, Some(".iso")),
                Err(error) => {
                    trace!(
                        format = self.format_name(),
                        %error,
                        "nod disc probe: decoded prefix read failed; skipping identity"
                    );
                    rom_weaver_checksum::RomIdentity::default()
                }
            }
        };
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        let mut report = OperationReport::succeeded(
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
        );
        let mut details = serde_json::Map::new();
        identity.write_into(&mut details);
        write_disc_header_details(&disc, &mut details);
        if !details.is_empty() {
            report.details = Some(serde_json::Value::Object(details));
        }
        Ok(report)
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
        // Mutable so WIA/RVZ can enable copy-pass hash verification.
        let mut disc = open_disc(&request.source, preloader_threads)?;
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

        let integrity = if matches!(self.nod_format, NodFormat::Wia | NodFormat::Rvz) {
            rom_weaver_core::ensure_output_available(&output_path, request.overwrite)?;
            Some(prepare_integrity(&mut disc, self.format_name(), context)?)
        } else {
            None
        };

        Ok(NodExtractPlan {
            execution,
            disc,
            disc_size,
            compression_label,
            output_path,
            integrity,
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
        let output = create_extract_output_file(&plan.output_path, request.overwrite)?;
        let mut output = ExtractOutput::new(output, &mut plan.integrity);
        let progress_label = format!("extracting `{}`", self.format_name());
        let hasher = ExtractHasher::new(context, None, &plan.output_path, 1)?;
        let copied = (|| {
            output.set_len(plan.disc_size)?;
            let mut output = HashingWriter::new(BufWriter::new(&mut output), hasher);
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
            Ok((bytes_written, output.into_hasher()))
        })();
        let digests = output.finish();
        let finished = copied.and_then(|(bytes_written, hasher)| {
            let warnings = self.finish_extract_integrity(&mut plan, digests, context)?;
            Ok((bytes_written, hasher, warnings))
        });
        let (bytes_written, hasher, warnings) = match finished {
            Ok(finished) => finished,
            Err(error) => {
                // A failed or cancelled copy or verification leaves a partial or unverified
                // disc image; the output is already closed.
                let _ = fs::remove_file(&plan.output_path);
                return Err(error);
            }
        };
        let checksum = match hasher.finish(&plan.output_path) {
            Ok(checksum) => checksum,
            Err(error) => {
                let _ = fs::remove_file(&plan.output_path);
                return Err(error);
            }
        };
        trace!(
            format = self.format_name(),
            checksummed = checksum.is_some(),
            "nod disc extract copy finished"
        );

        let mut report = self.extracted_report(
            &request.source,
            &plan.output_path,
            bytes_written,
            plan.disc_size,
            &plan.compression_label,
            plan.execution,
        );
        attach_integrity_warnings(&mut report, warnings);
        Ok(attach_extract_checksum_details(
            report,
            checksum.into_iter().collect(),
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
                "{} create currently requires exactly one input file; pass one disc image (such as .iso, .gcm, or .rvz)",
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

    /// The create-time failure for an input nod could not open. An unrecognized disc format
    /// gets a plain "not a GameCube or Wii disc" message naming the file and, when the header
    /// identifies it, what it is; the raw backend text carries nothing the user can act on.
    fn create_open_error(&self, input: &Path, error: &str) -> RomWeaverError {
        let name = display_input_name(input);
        if !error.contains("Unknown disc format") {
            return RomWeaverError::Validation(format!(
                "failed to open input `{name}` for {} create: {error}",
                self.format_name()
            ));
        }
        let identity = rom_weaver_checksum::detect_rom_identity_for_path(input);
        debug!(
            format = self.format_name(),
            input = %name,
            platform = ?identity.platform,
            disc_format = ?identity.disc_format,
            "nod create input is not a GameCube or Wii disc"
        );
        let detected = match (identity.platform, identity.disc_format) {
            (Some(platform), Some(disc)) => {
                format!(" (detected: {platform}, {} disc)", disc.label())
            }
            (Some(platform), None) => format!(" (detected: {platform})"),
            (None, Some(disc)) => format!(" (detected: {} disc)", disc.label()),
            (None, None) => String::new(),
        };
        RomWeaverError::Validation(format!(
            "`{name}` is not a GameCube or Wii disc image{detected}; {} create only supports GameCube and Wii disc images",
            self.format_name()
        ))
    }

    /// Open `input` as a disc image without reading its data, so a create request for a
    /// non-GameCube/Wii input fails with the same error the real create reports.
    pub(crate) fn validate_create_input(&self, input: &Path) -> Result<()> {
        debug!(format = self.format_name(), input = %input.display(), "nod create input check");
        let read_options = self.read_options(0);
        self.open_disc_from_path_or_stream(input, &read_options)
            .map(drop)
            .map_err(|error| self.create_open_error(input, &error))
    }

    pub(crate) fn process_create_with_progress<F>(
        &self,
        input: &Path,
        output_path: &Path,
        options: &NodFormatOptions,
        execution: &ThreadExecution,
        cancel: &CancellationToken,
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
            .map_err(|error| self.create_open_error(input, &error))?;

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
                    cancel_nod_write(cancel)?;
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
            });
        let finalization = cancel.or_cancelled(finalization)?;
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
        cancel: &CancellationToken,
        mut emit_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64, u64),
    {
        let thread_plan = self.create_thread_plan(execution);
        let read_options = self.read_options(thread_plan.preloader_threads);
        let input_disc = self
            .open_disc_from_path_or_stream(input, &read_options)
            .map_err(|error| self.create_open_error(input, &error))?;

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
                    cancel_nod_write(cancel)?;
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
            });
        let finalization = cancel.or_cancelled(finalization)?;
        if !finalization.header.is_empty() {
            output_bytes = output_bytes.max(finalization.header.len() as u64);
        }
        Ok(output_bytes)
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

/// Fails nod's per-block write callback once `cancel` trips, which stops its reader and
/// compressor threads; the caller reports the error as `Cancelled`.
fn cancel_nod_write(cancel: &CancellationToken) -> std::io::Result<()> {
    if cancel.is_cancelled() {
        return Err(std::io::Error::other("operation cancelled"));
    }
    Ok(())
}

/// File name only, so errors do not leak internal staging directories (e.g. `/work` in the browser).
fn display_input_name(input: &Path) -> String {
    input.file_name().map_or_else(
        || input.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// A failed disc open: the joined message of every attempt, plus the last WBFS size mismatch.
struct DiscOpenFailure {
    message: String,
    wbfs_size: Option<(u64, u64)>,
}

/// Reads the sizes out of nod's `Invalid WBFS file size: {actual}, expected {expected}` error.
/// The mapping lives here so the vendored nod source stays unmodified.
fn wbfs_size_mismatch(error: &crate::nod::Error) -> Option<(u64, u64)> {
    let crate::nod::Error::DiscFormat(message) = error else {
        return None;
    };
    let sizes = message.strip_prefix("Invalid WBFS file size: ")?;
    let (actual, expected) = sizes.split_once(", expected ")?;
    Some((actual.parse().ok()?, expected.parse().ok()?))
}

/// Checks that must pass before any WIA/RVZ output is written: each hashed Wii partition's H3
/// table is read and covers every group, then the disc reader verifies H0-H3 hashes during the
/// copy. NKit digests are prepared for the copy when the image stores them.
fn prepare_integrity(
    disc: &mut NodDiscReader,
    format: &'static str,
    context: &OperationContext,
) -> Result<IntegrityCheck> {
    use crate::nod::disc::wii::H3_TABLE_SIZE;

    let hashed = disc
        .partitions()
        .iter()
        .filter(|partition| partition.has_hashes)
        .map(|partition| {
            (
                partition.index,
                (partition.data_end_sector - partition.data_start_sector).div_ceil(64),
            )
        })
        .collect::<Vec<_>>();
    let h3_groups = (H3_TABLE_SIZE / 20) as u32;
    let mut partitions = Vec::with_capacity(hashed.len());
    for (index, groups) in hashed {
        context.cancel().check()?;
        // Verification would fail at the first group past the H3 table; fail before writing.
        if groups > h3_groups {
            debug!(
                partition = index,
                groups, h3_groups, format, "Wii partition exceeds its H3 table"
            );
            return Err(RomWeaverError::Validation(format!(
                "{format} partition {index} integrity check failed: H3 table missing hash for group {h3_groups}"
            )));
        }
        disc.enable_hash_verification(index).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format} partition {index} integrity check failed: {error}"
            ))
        })?;
        debug!(
            partition = index,
            groups, format, "Wii partition hashes verify during the copy"
        );
        partitions.push(index);
    }

    let digests = ImageDigests::new(&disc.meta(), context)?;
    debug!(
        format,
        partitions = partitions.len(),
        nkit_digests = digests.is_some(),
        "disc integrity checks prepared"
    );
    Ok(IntegrityCheck {
        format,
        partitions,
        digests,
    })
}

/// Turns the copy's integrity results into warnings, in partition order and then CRC32, MD5,
/// SHA-1, XXH64. Groups of a hashed partition that the copy never reached (data past the disc
/// size) are verified here with a validating partition reader, continuing the same summary.
fn finish_integrity(
    integrity: Option<IntegrityCheck>,
    digests: Option<ImageDigests>,
    disc: &NodDiscReader,
    output_name: &str,
    context: &OperationContext,
) -> Result<Vec<String>> {
    use crate::nod::{disc::wii::SECTOR_DATA_SIZE, read::PartitionOptions};
    use tracing::warn;

    let Some(IntegrityCheck {
        format, partitions, ..
    }) = integrity
    else {
        return Ok(Vec::new());
    };
    let mut warnings = Vec::new();
    for index in partitions {
        context.cancel().check()?;
        let mut summary = disc.hash_mismatches(index).cloned().unwrap_or_default();
        let next_group = disc.next_unverified_group(index).unwrap_or(0);
        let groups = disc
            .partitions()
            .iter()
            .find(|partition| partition.index == index)
            .map_or(0, |partition| {
                (partition.data_end_sector - partition.data_start_sector).div_ceil(64)
            });
        trace!(
            partition = index,
            next_group, groups, format, "Wii partition copy-pass verification result"
        );
        if next_group < groups {
            debug!(
                partition = index,
                next_group, groups, format, "verifying Wii partition groups the copy did not reach"
            );
            let failed = |error: &dyn std::fmt::Display| {
                RomWeaverError::Validation(format!(
                    "{format} partition {index} integrity check failed: {error}"
                ))
            };
            let mut reader = disc
                .open_partition(
                    index,
                    &PartitionOptions {
                        validate_hashes: true,
                        hash_mismatch_warnings: true,
                    },
                )
                .map_err(|error| failed(&error))?;
            reader
                .seek(SeekFrom::Start(
                    u64::from(next_group) * 64 * SECTOR_DATA_SIZE as u64,
                ))
                .map_err(|error| failed(&error))?;
            loop {
                context.cancel().check()?;
                let len = reader.fill_buf().map_err(|error| failed(&error))?.len();
                if len == 0 {
                    break;
                }
                reader.consume(len);
            }
            if let Some(later) = reader.hash_mismatches() {
                summary.append(later);
            }
        }
        if let Some(first) = &summary.first {
            let warning = format!(
                "{format} partition {index} hash mismatch: {first}; {} hashes in {} sectors across {} groups; ISO extracted as-is; source-disc errors and payload corruption cannot be distinguished (output `{output_name}`)",
                summary.hashes, summary.sectors, summary.groups
            );
            warn!(format, partition = index, %warning, "Wii partition hash mismatch");
            warnings.push(warning);
        }
    }

    if let Some(digests) = digests {
        for algorithm in digests.mismatches(&disc.meta()) {
            let warning = format!(
                "{format} NKit {algorithm} checksum mismatch; ISO extracted as-is; source-disc errors and payload corruption cannot be distinguished (output `{output_name}`)"
            );
            warn!(format, algorithm, %warning, "NKit image checksum mismatch");
            warnings.push(warning);
        }
    }
    debug!(
        format,
        warnings = warnings.len(),
        "disc integrity verification complete"
    );
    Ok(warnings)
}

/// Optional NKit image digests, computed over the ISO bytes as the copy writes them.
pub(crate) struct ImageDigests {
    crc32: Option<crc32fast::Hasher>,
    md5: Option<md5::Md5>,
    sha1: Option<sha1::Sha1>,
    xxh64: Option<xxhash_rust::xxh64::Xxh64>,
    /// Shared operation pool for hashing the digests concurrently; `None` hashes inline.
    pool: Option<SharedThreadPool>,
}

impl ImageDigests {
    fn new(meta: &crate::nod::read::DiscMeta, context: &OperationContext) -> Result<Option<Self>> {
        use digest::Digest;

        let crc32 = meta.crc32.map(|_| crc32fast::Hasher::new());
        let md5 = meta.md5.map(|_| md5::Md5::new());
        let sha1 = meta.sha1.map(|_| sha1::Sha1::new());
        let xxh64 = meta.xxh64.map(|_| xxhash_rust::xxh64::Xxh64::new(0));
        let count = [
            crc32.is_some(),
            md5.is_some(),
            sha1.is_some(),
            xxh64.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count();
        if count == 0 {
            return Ok(None);
        }
        // Each digest is serial; with a parallel pool they run side by side (and, natively,
        // alongside the chunk write) instead of one after another.
        let (execution, pool) = context.build_pool(ThreadCapability::parallel(Some(count + 1)))?;
        let pool = execution.used_parallelism.then_some(pool);
        debug!(
            digests = count,
            parallel = pool.is_some(),
            effective_threads = execution.effective_threads,
            "NKit image digests compute during the copy"
        );
        Ok(Some(Self {
            crc32,
            md5,
            sha1,
            xxh64,
            pool,
        }))
    }

    fn update_inline(&mut self, data: &[u8]) {
        use digest::Digest;

        if let Some(hash) = &mut self.crc32 {
            hash.update(data);
        }
        if let Some(hash) = &mut self.md5 {
            hash.update(data);
        }
        if let Some(hash) = &mut self.sha1 {
            hash.update(data);
        }
        if let Some(hash) = &mut self.xxh64 {
            hash.update(data);
        }
    }

    /// Hashes `data` into every digest on the pool.
    #[cfg(target_family = "wasm")]
    fn update_parallel(&mut self, pool: &SharedThreadPool, data: &[u8]) {
        let Self {
            crc32,
            md5,
            sha1,
            xxh64,
            ..
        } = self;
        pool.install(|| {
            rayon::scope(|scope| {
                spawn_digest_updates(scope, crc32, md5, sha1, xxh64, data);
            });
        });
    }

    /// Writes `data` with `write` and hashes it. Natively the write runs on the pool beside the
    /// hashing; under wasm it stays on the calling thread, whose WASI descriptors other threads
    /// cannot use, and hashing follows it.
    fn write_and_update(
        &mut self,
        data: &[u8],
        write: impl FnOnce(&[u8]) -> io::Result<()> + Send,
    ) -> io::Result<()> {
        let Some(pool) = self.pool.clone() else {
            write(data)?;
            self.update_inline(data);
            return Ok(());
        };
        #[cfg(not(target_family = "wasm"))]
        {
            let Self {
                crc32,
                md5,
                sha1,
                xxh64,
                ..
            } = self;
            pool.install(|| {
                rayon::scope(|scope| {
                    spawn_digest_updates(scope, crc32, md5, sha1, xxh64, data);
                    write(data)
                })
            })
        }
        #[cfg(target_family = "wasm")]
        {
            write(data)?;
            self.update_parallel(&pool, data);
            Ok(())
        }
    }

    /// Names of the stored digests that differ from the computed ones, in report order.
    fn mismatches(self, meta: &crate::nod::read::DiscMeta) -> Vec<&'static str> {
        use digest::Digest;

        [
            (
                "CRC32",
                self.crc32.map(|hash| hash.finalize()) != meta.crc32,
            ),
            (
                "MD5",
                self.md5.map(|hash| <[u8; 16]>::from(hash.finalize())) != meta.md5,
            ),
            (
                "SHA-1",
                self.sha1.map(|hash| <[u8; 20]>::from(hash.finalize())) != meta.sha1,
            ),
            ("XXH64", self.xxh64.map(|hash| hash.digest()) != meta.xxh64),
        ]
        .into_iter()
        .filter_map(|(algorithm, mismatch)| mismatch.then_some(algorithm))
        .collect()
    }
}

fn spawn_digest_updates<'scope>(
    scope: &rayon::Scope<'scope>,
    crc32: &'scope mut Option<crc32fast::Hasher>,
    md5: &'scope mut Option<md5::Md5>,
    sha1: &'scope mut Option<sha1::Sha1>,
    xxh64: &'scope mut Option<xxhash_rust::xxh64::Xxh64>,
    data: &'scope [u8],
) {
    use digest::Digest;

    if let Some(hash) = crc32 {
        scope.spawn(move |_| hash.update(data));
    }
    if let Some(hash) = md5 {
        scope.spawn(move |_| hash.update(data));
    }
    if let Some(hash) = sha1 {
        scope.spawn(move |_| hash.update(data));
    }
    if let Some(hash) = xxh64 {
        scope.spawn(move |_| hash.update(data));
    }
}

/// The extracted ISO file. When NKit digests are checked, every byte written is also hashed.
pub(crate) struct ExtractOutput {
    file: File,
    digests: Option<ImageDigests>,
}

impl ExtractOutput {
    pub(crate) fn new(file: File, integrity: &mut Option<IntegrityCheck>) -> Self {
        Self {
            file,
            digests: integrity
                .as_mut()
                .and_then(|integrity| integrity.digests.take()),
        }
    }

    pub(crate) fn set_len(&self, len: u64) -> io::Result<()> {
        self.file.set_len(len)
    }

    /// Closes the file and returns the digests for [`NodHandlerCore::finish_extract_integrity`].
    pub(crate) fn finish(self) -> Option<ImageDigests> {
        drop(self.file);
        self.digests
    }
}

impl Write for ExtractOutput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let Some(digests) = &mut self.digests else {
            return self.file.write(buf);
        };
        let file = &mut self.file;
        digests.write_and_update(buf, |data| file.write_all(data))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl NodHandlerCore {
    /// Integrity warnings for a finished copy; errors mean the output must be removed.
    pub(crate) fn finish_extract_integrity(
        &self,
        plan: &mut NodExtractPlan,
        digests: Option<ImageDigests>,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        let output_name = plan
            .output_path
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
        finish_integrity(
            plan.integrity.take(),
            digests,
            &plan.disc,
            &output_name,
            context,
        )
    }
}

pub(crate) fn attach_integrity_warnings(report: &mut OperationReport, warnings: Vec<String>) {
    if warnings.is_empty() {
        return;
    }
    for warning in &warnings {
        report.label.push_str("; warning=");
        report.label.push_str(warning);
    }
    let details = report.details.get_or_insert_with(|| serde_json::json!({}));
    if let Some(details) = details.as_object_mut() {
        details.insert("warnings".to_string(), serde_json::json!(warnings));
    }
}
