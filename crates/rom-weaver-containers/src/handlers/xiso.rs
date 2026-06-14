/* jscpd:ignore-start */
use super::*;
use tracing::debug;

type XisoSourceDevice = XdvdfsOffsetWrapper<BufReader<File>, io::Error>;
type XisoSourceFilesystem = XdvdfsFilesystem<io::Error, XisoSourceDevice>;

pub(crate) struct XisoContainerHandler;

impl XisoContainerHandler {
    fn open_source_filesystem(&self, source_path: &Path) -> Result<XisoSourceFilesystem> {
        let source_file = File::options()
            .read(true)
            .open(source_path)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open xiso source `{}`: {error}",
                    source_path.display()
                ))
            })?;
        let source_reader = BufReader::new(source_file);
        let source_device = XdvdfsOffsetWrapper::new(source_reader).map_err(|error| {
            RomWeaverError::Validation(format!(
                "source `{}` is not an Xbox XDVDFS image (raw/XGD probe failed: {error})",
                source_path.display()
            ))
        })?;
        XdvdfsFilesystem::new(source_device).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "source `{}` could not be read as an XDVDFS filesystem",
                source_path.display()
            ))
        })
    }

    fn output_name(&self, source: &Path) -> String {
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(XISO.name);
        let file_name_lower = file_name.to_ascii_lowercase();

        let trimmed = if file_name_lower.ends_with(".xiso.iso") {
            file_name[..file_name.len() - ".xiso.iso".len()].to_string()
        } else if file_name_lower.ends_with(".xiso") {
            file_name[..file_name.len() - ".xiso".len()].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };

        let normalized = trimmed.trim().trim_matches('.');
        if normalized.is_empty() {
            "xiso.iso".to_string()
        } else {
            format!("{normalized}.iso")
        }
    }
}

impl ContainerHandlerOperations for XisoContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &XISO
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.open_source_filesystem(source).is_ok() {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn probe_details(
        &self,
        _request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "xiso probe is not supported yet".into(),
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
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;
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

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let mut source_fs = self.open_source_filesystem(&request.source)?;
        debug!(
            format = XISO.name,
            source = %request.source.display(),
            "xiso extract start (rebuild XDVDFS image)"
        );
        let output_path = request.out_dir.join(&output_name);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let output_file = create_extract_output_file(&output_path, request.overwrite)?;
        let mut output = BufWriter::new(output_file);
        let extract_progress_label = format!("extracting `{}`", XISO.name);
        let mut listed_entries = 0usize;
        let mut listed_directories = 0usize;
        let mut completed_steps = 0usize;
        let extract_result =
            xdvdfs::write::img::create_xdvdfs_image(&mut source_fs, &mut output, |progress| {
                match progress {
                    xdvdfs::write::img::ProgressInfo::FileCount(count) => {
                        listed_entries = count;
                        let total_steps = listed_entries.saturating_add(listed_directories);
                        emit_container_step_progress(
                            &ContainerProgressContext {
                                context,
                                command: "extract",
                                format: XISO.name,
                                stage: "extract",
                                thread_execution: Some(&execution),
                            },
                            completed_steps,
                            total_steps,
                            extract_progress_label.as_str(),
                        );
                    }
                    xdvdfs::write::img::ProgressInfo::DirCount(count) => {
                        listed_directories = count;
                        let total_steps = listed_entries.saturating_add(listed_directories);
                        emit_container_step_progress(
                            &ContainerProgressContext {
                                context,
                                command: "extract",
                                format: XISO.name,
                                stage: "extract",
                                thread_execution: Some(&execution),
                            },
                            completed_steps,
                            total_steps,
                            extract_progress_label.as_str(),
                        );
                    }
                    xdvdfs::write::img::ProgressInfo::DirAdded(_, _)
                    | xdvdfs::write::img::ProgressInfo::FileAdded(_, _) => {
                        completed_steps = completed_steps.saturating_add(1);
                        let total_steps = listed_entries.saturating_add(listed_directories);
                        emit_container_step_progress(
                            &ContainerProgressContext {
                                context,
                                command: "extract",
                                format: XISO.name,
                                stage: "extract",
                                thread_execution: Some(&execution),
                            },
                            completed_steps,
                            total_steps,
                            extract_progress_label.as_str(),
                        );
                    }
                    xdvdfs::write::img::ProgressInfo::DiscoveredDirectory(_)
                    | xdvdfs::write::img::ProgressInfo::FinishedPacking => {}
                    _ => {}
                }
            });
        if let Err(error) = extract_result {
            let _ = fs::remove_file(&output_path);
            return Err(RomWeaverError::Validation(format!(
                "xiso extract failed while rebuilding `{}`: {error}",
                request.source.display()
            )));
        }
        output.flush()?;
        let output_bytes = fs::metadata(&output_path)?.len();
        debug!(
            format = XISO.name,
            output_bytes,
            files = listed_entries,
            directories = listed_directories,
            "xiso extract complete"
        );

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(XISO.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` (1 file, {} bytes written)",
                request.source.display(),
                output_path.display(),
                output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "xiso container create is not supported; xiso is trim-only (use `trim`)".into(),
        ))
    }
}
/* jscpd:ignore-end */
