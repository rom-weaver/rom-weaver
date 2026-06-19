use super::*;
use tracing::{debug, trace};

const CSO_EXTRACT_TASK_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug)]
struct CsoExtractTask {
    index: usize,
    offset: u64,
    len: u64,
}

#[derive(Debug)]
struct CsoDecodedExtractChunk {
    index: usize,
    data: Vec<u8>,
}

struct ExactCsoFileReader {
    file: File,
}

impl ExactCsoFileReader {
    fn open(path: &Path) -> std::result::Result<Self, io::Error> {
        Ok(Self {
            file: File::open(path)?,
        })
    }
}

impl ciso::read::Read<io::Error> for ExactCsoFileReader {
    fn size(&mut self) -> std::result::Result<u64, io::Error> {
        self.file.seek(SeekFrom::End(0))
    }

    fn read(&mut self, pos: u64, buf: &mut [u8]) -> std::result::Result<(), io::Error> {
        self.file.seek(SeekFrom::Start(pos))?;
        self.file.read_exact(buf)?;
        Ok(())
    }
}

enum CsoSourceReader {
    Single(ExactCsoFileReader),
    Split(SplitFileReader<io::Error, ExactCsoFileReader>),
}

impl ciso::read::Read<io::Error> for CsoSourceReader {
    fn size(&mut self) -> std::result::Result<u64, io::Error> {
        match self {
            Self::Single(reader) => ciso::read::Read::size(reader),
            Self::Split(reader) => ciso::read::Read::size(reader),
        }
    }

    fn read(&mut self, pos: u64, buf: &mut [u8]) -> std::result::Result<(), io::Error> {
        match self {
            Self::Single(reader) => ciso::read::Read::read(reader, pos, buf),
            Self::Split(reader) => ciso::read::Read::read(reader, pos, buf),
        }
    }
}

type CsoImageReader = CsoReader<io::Error, CsoSourceReader>;

pub(crate) struct CsoContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl CsoContainerHandler {
    pub(crate) const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_split_source(&self, source: &Path) -> Result<Option<CsoSourceReader>> {
        let file_extension = source.extension().and_then(|value| value.to_str());
        let Some(file_extension) = file_extension else {
            return Ok(None);
        };
        if !file_extension.eq_ignore_ascii_case("cso") {
            return Ok(None);
        }

        let source_base = source.with_extension("");
        let split_root = source_base
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == "1");
        if !split_root {
            return Ok(None);
        }

        let mut parts = Vec::new();
        for index in 1.. {
            let part_path = source_base.with_extension(format!("{index}.{file_extension}"));
            if !part_path.exists() {
                break;
            }
            parts.push(ExactCsoFileReader::open(&part_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open cso split part `{}`: {error}",
                    part_path.display()
                ))
            })?);
        }

        if parts.is_empty() {
            return Ok(None);
        }

        let split_reader = SplitFileReader::new(parts).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open split cso source `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(Some(CsoSourceReader::Split(split_reader)))
    }

    fn open_source(&self, source: &Path) -> Result<CsoSourceReader> {
        if let Some(split_reader) = self.open_split_source(source)? {
            return Ok(split_reader);
        }
        let file = ExactCsoFileReader::open(source).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open cso source `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(CsoSourceReader::Single(file))
    }

    fn open_reader(&self, source: &Path) -> Result<CsoImageReader> {
        CsoReader::new(self.open_source(source)?).map_err(|error| {
            RomWeaverError::Validation(format!(
                "cso source `{}` is invalid: {error}",
                source.display()
            ))
        })
    }

    fn output_name(&self, source: &Path) -> String {
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(self.descriptor.name);
        let file_name_lower = file_name.to_ascii_lowercase();

        let mut trimmed = if file_name_lower.ends_with(".cso") {
            file_name[..file_name.len() - ".cso".len()].to_string()
        } else if file_name_lower.ends_with(".ciso") {
            file_name[..file_name.len() - ".ciso".len()].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };
        if let Some(without_split_suffix) = trimmed.strip_suffix(".1") {
            trimmed = without_split_suffix.to_string();
        }

        let normalized = trimmed.trim().trim_matches('.');
        if normalized.is_empty() {
            "cso.iso".to_string()
        } else {
            format!("{normalized}.iso")
        }
    }

    fn build_extract_tasks(&self, logical_bytes: u64) -> Vec<CsoExtractTask> {
        if logical_bytes == 0 {
            return Vec::new();
        }
        let mut tasks = Vec::new();
        let mut offset = 0_u64;
        let mut index = 0_usize;
        while offset < logical_bytes {
            let len = (logical_bytes - offset).min(CSO_EXTRACT_TASK_BYTES);
            tasks.push(CsoExtractTask { index, offset, len });
            offset = offset.saturating_add(len);
            index += 1;
        }
        tasks
    }

    fn decode_extract_task(
        &self,
        source: &Path,
        task: &CsoExtractTask,
    ) -> Result<CsoDecodedExtractChunk> {
        let mut reader = self.open_reader(source)?;
        self.decode_extract_task_from_reader(source, &mut reader, task)
    }

    fn decode_extract_task_from_reader(
        &self,
        source: &Path,
        reader: &mut CsoImageReader,
        task: &CsoExtractTask,
    ) -> Result<CsoDecodedExtractChunk> {
        let read_len = usize::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("cso extract task length overflowed usize".into())
        })?;
        let mut decoded = vec![0_u8; read_len];
        reader
            .read_offset(task.offset, &mut decoded)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "cso extract failed while decoding `{}` chunk {} at offset {}: {error}",
                    source.display(),
                    task.index,
                    task.offset
                ))
            })?;
        Ok(CsoDecodedExtractChunk {
            index: task.index,
            data: decoded,
        })
    }

    fn extract_pipeline_messages() -> OrderedStreamingMessages {
        OrderedStreamingMessages {
            worker_closed: "cso extract workers ended before all chunks were consumed",
            result_closed: "cso extract pipeline ended before all chunks were produced",
        }
    }
}

impl ContainerHandlerOperations for CsoContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if file_starts_with(source, &CSO_SIGNATURE) {
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
        let reader = self.open_reader(&request.source)?;
        let logical_bytes = reader.file_size();
        trace!(
            format = self.descriptor.name,
            compressed_bytes, logical_bytes, "cso probe"
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
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        request.ensure_single_output_selected(&output_name)?;

        let output_path = request.out_dir.join(&output_name);
        let reader = self.open_reader(&request.source)?;
        let logical_bytes = reader.file_size();
        let tasks = self.build_extract_tasks(logical_bytes);
        let extract_capability = ThreadCapability::parallel(Some(tasks.len().max(1)));
        let execution = context.plan_threads(extract_capability);
        debug!(
            format = self.descriptor.name,
            logical_bytes,
            tasks = tasks.len(),
            used_parallelism = execution.used_parallelism,
            effective_threads = execution.effective_threads,
            "cso extract start"
        );
        let extract_progress_label = format!("extracting `{}`", self.descriptor.name);

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Hash the decompressed output as it is written so a requested `--checksum` is computed
        // during extract instead of forcing the caller into a second full read of the output,
        // matching the libarchive/chd/rvz extract paths.
        let mut extract_writer = ExtractChunkWriter::new(
            context,
            &execution,
            self.descriptor.name,
            extract_progress_label,
            logical_bytes,
            &output_path,
            request.overwrite,
        )?;
        let source = request.source.clone();
        // Each worker opens its own file-backed `ciso` reader and decodes its assigned task range,
        // reading only the compressed blocks that range spans (peak memory is one task's decoded
        // output per worker, not the whole file). In the browser the OPFS proxy worker owns the
        // source handle, so a spawned wasm thread's `path_open` is marshalled to it and succeeds —
        // the old read-on-main path (buffer the whole compressed source on the main thread, or
        // serial-decode it over a cap) is no longer needed.
        let decode_result = if execution.used_parallelism {
            decode_tasks_ordered(
                &tasks,
                execution.effective_threads,
                Self::extract_pipeline_messages(),
                |task: &CsoExtractTask| task.len,
                |task| self.decode_extract_task(&source, &task),
                |chunk: CsoDecodedExtractChunk, task_len| {
                    extract_writer.write(chunk.index, chunk.data, task_len)
                },
            )
        } else {
            tasks.iter().try_for_each(|task| {
                let chunk = self.decode_extract_task(&source, task)?;
                extract_writer.write(chunk.index, chunk.data, task.len)
            })
        };
        if let Err(error) = decode_result {
            let _ = fs::remove_file(&output_path);
            return Err(error);
        }
        let output_checksums = match extract_writer.finish(&output_path) {
            Ok(checksums) => checksums,
            Err(error) => {
                let _ = fs::remove_file(&output_path);
                return Err(error);
            }
        };

        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` (1 file, {} bytes written)",
                request.source.display(),
                output_path.display(),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        );
        let report = attach_extract_checksum_details(report, output_checksums);
        Ok(attach_emitted_file_paths(report, &[output_path]))
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
