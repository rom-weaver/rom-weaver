use super::*;
use crate::xdvdfs::blockdev::BlockDeviceWrite as XdvdfsBlockDeviceWrite;
use rom_weaver_core::CancellationToken;
use tracing::debug;

type XisoSourceDevice = XdvdfsOffsetWrapper<BufReader<File>, io::Error>;
type XisoSourceFilesystem = XdvdfsFilesystem<io::Error, XisoSourceDevice>;

/// The rebuilt image's writer. Each write fails once `cancel` trips, so a cancelled
/// extract stops within one copied block.
struct CancelCheckedImage<'a, W> {
    inner: W,
    cancel: &'a CancellationToken,
}

#[maybe_async::maybe_async]
impl<W: XdvdfsBlockDeviceWrite<io::Error>> XdvdfsBlockDeviceWrite<io::Error>
    for CancelCheckedImage<'_, W>
{
    async fn write(&mut self, offset: u64, buffer: &[u8]) -> io::Result<()> {
        if self.cancel.is_cancelled() {
            return Err(io::Error::other("operation cancelled"));
        }
        self.inner.write(offset, buffer).await
    }

    async fn len(&mut self) -> io::Result<u64> {
        self.inner.len().await
    }
}

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
        request.ensure_single_output_selected(&output_name)?;

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

        let same_path = request.source == output_path
            || matches!(
                (fs::canonicalize(&request.source), fs::canonicalize(&output_path)),
                (Ok(source), Ok(output)) if source == output
            );
        #[cfg(not(target_arch = "wasm32"))]
        let same_path =
            same_path || same_file::is_same_file(&request.source, &output_path).unwrap_or(false);
        if same_path {
            return Err(RomWeaverError::Validation(format!(
                "xiso input and output resolve to the same file: `{}`",
                output_path.display()
            )));
        }

        let output_file = create_extract_output_file(&output_path, request.overwrite)?;
        let mut output = CancelCheckedImage {
            inner: BufWriter::new(output_file),
            cancel: context.cancel(),
        };
        let extract_progress_label = format!("extracting `{}`", XISO.name);
        let mut listed_entries = 0usize;
        let mut listed_directories = 0usize;
        let mut completed_steps = 0usize;
        let extract_result = crate::xdvdfs::write::img::create_xdvdfs_image(
            &mut source_fs,
            &mut output,
            |progress| match progress {
                crate::xdvdfs::write::img::ProgressInfo::FileCount(count) => {
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
                crate::xdvdfs::write::img::ProgressInfo::DirCount(count) => {
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
                crate::xdvdfs::write::img::ProgressInfo::DirAdded(_, _)
                | crate::xdvdfs::write::img::ProgressInfo::FileAdded(_, _) => {
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
                crate::xdvdfs::write::img::ProgressInfo::DiscoveredDirectory(_)
                | crate::xdvdfs::write::img::ProgressInfo::FinishedPacking => {}
            },
        );
        if let Err(error) = extract_result {
            // Close the output first: Windows cannot remove an open file.
            drop(output);
            let _ = fs::remove_file(&output_path);
            return context
                .cancel()
                .or_cancelled(Err(RomWeaverError::Validation(format!(
                    "xiso extract failed while rebuilding `{}`: {error}",
                    request.source.display()
                ))));
        }
        output.inner.flush()?;
        let output_bytes = fs::metadata(&output_path)?.len();
        debug!(
            format = XISO.name,
            output_bytes,
            files = listed_entries,
            directories = listed_directories,
            "xiso extract complete"
        );

        // The XDVDFS rebuild writes at seeking offsets, so the bytes cannot be hashed in flight.
        let checksum = match hash_extracted_file(context, &output_path) {
            Ok(checksum) => checksum,
            Err(error) => {
                let _ = fs::remove_file(&output_path);
                return Err(error);
            }
        };

        let report = OperationReport::succeeded(
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
        );
        let report = attach_extract_checksum_details(report, checksum.into_iter().collect());
        Ok(attach_emitted_file_paths(report, &[output_path]))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(extract_only_create_error(XISO.name))
    }
}
