#[derive(Clone, Copy, Debug)]
enum ZipContainerFlavor {
    Zip,
    Zipx,
}

struct ZipContainerHandler {
    descriptor: &'static FormatDescriptor,
    flavor: ZipContainerFlavor,
}

#[derive(Clone, Debug)]
struct ZipCreateTask {
    entry_index: usize,
    source: PathBuf,
    archive_name: String,
    temp_archive: PathBuf,
}

#[derive(Clone, Debug)]
struct ZipCreateArtifact {
    entry_index: usize,
    archive_name: String,
    logical_bytes: u64,
    temp_archive: PathBuf,
}

impl ZipContainerHandler {
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
                ZipCompressionMethod::Deflated | ZipCompressionMethod::Bzip2 => {
                    (0..=9).contains(&level)
                }
                ZipCompressionMethod::Zstd => (-7..=22).contains(&level),
                _ => false,
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
            _ => "unknown",
        }
    }

    fn build_options(&self, method: ZipCompressionMethod, level: Option<i32>) -> ZipFileOptions {
        ZipFileOptions::default()
            .compression_method(method)
            .compression_level(level.map(i64::from))
    }

    fn open_archive(&self, source: &Path) -> Result<ZipFileArchive<BufReader<File>>> {
        let file = File::open(source)?;
        ZipFileArchive::new(BufReader::new(file)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} archive is invalid: {error}",
                self.descriptor.name
            ))
        })
    }

    fn build_create_tasks(
        &self,
        entries: &[ArchiveInputEntry],
        context: &OperationContext,
    ) -> Vec<ZipCreateTask> {
        entries
            .iter()
            .enumerate()
            .filter_map(|(entry_index, entry)| {
                (!entry.is_dir).then(|| ZipCreateTask {
                    entry_index,
                    source: entry.source.clone(),
                    archive_name: entry.archive_name.clone(),
                    temp_archive: context.temp_paths().next_path(
                        &format!("{}-create-{entry_index}", self.descriptor.name),
                        Some("zip"),
                    ),
                })
            })
            .collect()
    }

    fn compress_create_task(
        &self,
        task: &ZipCreateTask,
        method: ZipCompressionMethod,
        level: Option<i32>,
    ) -> Result<ZipCreateArtifact> {
        if let Some(parent) = task.temp_archive.parent() {
            fs::create_dir_all(parent)?;
        }

        let output = File::create(&task.temp_archive)?;
        let mut staged_archive = ZipFileWriter::new(BufWriter::new(output));
        staged_archive
            .start_file(task.archive_name.clone(), self.build_options(method, level))
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} create failed for `{}`: {error}",
                    self.descriptor.name, task.archive_name
                ))
            })?;

        let mut source = BufReader::new(File::open(&task.source)?);
        let logical_bytes = io::copy(&mut source, &mut staged_archive)?;
        staged_archive.finish().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed for `{}`: {error}",
                self.descriptor.name, task.archive_name
            ))
        })?;

        Ok(ZipCreateArtifact {
            entry_index: task.entry_index,
            archive_name: task.archive_name.clone(),
            logical_bytes,
            temp_archive: task.temp_archive.clone(),
        })
    }

    fn merge_create_artifact(
        &self,
        archive: &mut ZipFileWriter<BufWriter<File>>,
        artifact: &ZipCreateArtifact,
    ) -> Result<()> {
        let staged_file = File::open(&artifact.temp_archive)?;
        let mut staged_archive =
            ZipFileArchive::new(BufReader::new(staged_file)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} create failed while reading staged entry `{}`: {error}",
                    self.descriptor.name, artifact.archive_name
                ))
            })?;
        let staged_entry = staged_archive.by_index(0).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed while reading staged entry `{}`: {error}",
                self.descriptor.name, artifact.archive_name
            ))
        })?;
        archive.raw_copy_file(staged_entry).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed for `{}`: {error}",
                self.descriptor.name, artifact.archive_name
            ))
        })?;
        Ok(())
    }

    fn cleanup_create_artifacts(&self, artifacts: &[ZipCreateArtifact]) {
        for artifact in artifacts {
            let _ = fs::remove_file(&artifact.temp_archive);
        }
    }

    fn cleanup_create_tasks(&self, tasks: &[ZipCreateTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_archive);
        }
    }
}

impl ContainerHandler for ZipContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.open_archive(source).is_ok() {
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
        let mut archive = self.open_archive(&request.source)?;
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut compressed_bytes = 0u64;
        let mut logical_bytes = 0u64;

        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} inspect failed while reading entry {index}: {error}",
                    self.descriptor.name
                ))
            })?;
            if entry.is_dir() {
                directories += 1;
            } else {
                files += 1;
            }
            compressed_bytes = compressed_bytes.saturating_add(entry.compressed_size());
            logical_bytes = logical_bytes.saturating_add(entry.size());
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name,
                archive.len(),
                files,
                directories,
                compressed_bytes,
                logical_bytes
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
        let mut archive = self.open_archive(&request.source)?;
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} list failed while reading entry {index}: {error}",
                    self.descriptor.name
                ))
            })?;
            let entry_name = normalize_archive_name(entry.name());
            if !entry_name.is_empty() {
                entries.push(entry_name);
            }
        }
        Ok(entries)
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
        let (method, level) = self.parse_codec(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let create_tasks = self.build_create_tasks(&entries, context);
        let total_create_tasks = create_tasks.len();
        let (execution, staged_artifacts) = if create_tasks.is_empty() {
            (
                context.plan_threads(ThreadCapability::parallel(None)),
                Vec::new(),
            )
        } else {
            let (execution, pool) =
                context.build_pool(ThreadCapability::parallel(Some(create_tasks.len())))?;
            let completed_tasks = Arc::new(AtomicUsize::new(0));
            let progress_context = context.clone();
            let progress_execution = execution.clone();
            let progress_format = self.descriptor.name;
            let staged_result = if execution.used_parallelism {
                pool.install(|| {
                    create_tasks
                        .par_iter()
                        .map(|task| {
                            let artifact = self.compress_create_task(task, method, level)?;
                            let completed = completed_tasks
                                .fetch_add(1, Ordering::Relaxed)
                                .saturating_add(1);
                            emit_container_step_progress(
                                &progress_context,
                                "compress",
                                progress_format,
                                "create",
                                completed,
                                total_create_tasks,
                                format!(
                                    "creating `{}` ({}/{})",
                                    progress_format, completed, total_create_tasks
                                ),
                                Some(&progress_execution),
                            );
                            Ok(artifact)
                        })
                        .collect::<Result<Vec<_>>>()
                })
            } else {
                create_tasks
                    .iter()
                    .map(|task| {
                        let artifact = self.compress_create_task(task, method, level)?;
                        let completed = completed_tasks
                            .fetch_add(1, Ordering::Relaxed)
                            .saturating_add(1);
                        emit_container_step_progress(
                            &progress_context,
                            "compress",
                            progress_format,
                            "create",
                            completed,
                            total_create_tasks,
                            format!(
                                "creating `{}` ({}/{})",
                                progress_format, completed, total_create_tasks
                            ),
                            Some(&progress_execution),
                        );
                        Ok(artifact)
                    })
                    .collect::<Result<Vec<_>>>()
            };
            let mut staged_artifacts = match staged_result {
                Ok(staged_artifacts) => staged_artifacts,
                Err(error) => {
                    self.cleanup_create_tasks(&create_tasks);
                    return Err(error);
                }
            };
            staged_artifacts.sort_by_key(|artifact| artifact.entry_index);
            (execution, staged_artifacts)
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = File::create(&request.output)?;
        let writer = BufWriter::new(file);
        let mut archive = ZipFileWriter::new(writer);
        let create_result: Result<u64> = (|| {
            let mut logical_bytes = 0u64;
            let mut staged_iter = staged_artifacts.iter();

            for (entry_index, entry) in entries.iter().enumerate() {
                if entry.is_dir {
                    let directory_name = format!("{}/", entry.archive_name);
                    archive
                        .add_directory(directory_name, self.build_options(method, level))
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "{} create failed for `{}`: {error}",
                                self.descriptor.name, entry.archive_name
                            ))
                        })?;
                    continue;
                }

                let staged = staged_iter.next().ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "{} create failed while finalizing staged entries for `{}`",
                        self.descriptor.name, entry.archive_name
                    ))
                })?;
                if staged.entry_index != entry_index {
                    return Err(RomWeaverError::Validation(format!(
                        "{} create failed due to staged entry order mismatch for `{}`",
                        self.descriptor.name, entry.archive_name
                    )));
                }
                self.merge_create_artifact(&mut archive, staged)?;
                logical_bytes = logical_bytes.saturating_add(staged.logical_bytes);
            }
            if staged_iter.next().is_some() {
                return Err(RomWeaverError::Validation(format!(
                    "{} create failed due to unexpected staged entries",
                    self.descriptor.name
                )));
            }

            archive.finish().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} create failed while finalizing archive: {error}",
                    self.descriptor.name
                ))
            })?;
            Ok(logical_bytes)
        })();
        self.cleanup_create_artifacts(&staged_artifacts);
        let logical_bytes = create_result?;

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
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}
