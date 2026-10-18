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

impl ciso::read::Read for ExactCsoFileReader {
    type ReadError = io::Error;

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

impl ciso::read::Read for CsoSourceReader {
    type ReadError = io::Error;

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

struct CsoReader<R> {
    source: R,
    logical_bytes: u64,
    block_size: usize,
    alignment: u8,
    version: u8,
    source_size: u64,
    index: Vec<u32>,
}

/// CSO v0/v1 images store raw-deflate blocks; v2 images mix deflate, LZ4, and raw blocks.
fn is_deflate_version(version: u8) -> bool {
    version <= 1
}

/// Decodes an LZ4 block until `out_len` bytes exist, ignoring any trailing alignment padding.
fn decode_lz4_prefix(src: &[u8], out_len: usize) -> Option<Vec<u8>> {
    fn length(src: &[u8], position: &mut usize, mut value: usize) -> Option<usize> {
        if value == 15 {
            loop {
                let byte = *src.get(*position)?;
                *position += 1;
                value = value.checked_add(usize::from(byte))?;
                if byte != 255 {
                    break;
                }
            }
        }
        Some(value)
    }
    let mut out = Vec::with_capacity(out_len);
    let mut position = 0;
    while out.len() < out_len {
        let token = *src.get(position)?;
        position += 1;
        let literals = length(src, &mut position, usize::from(token >> 4))?;
        let literal_end = position.checked_add(literals)?;
        if literals > out_len - out.len() {
            return None;
        }
        out.extend_from_slice(src.get(position..literal_end)?);
        position = literal_end;
        if out.len() == out_len {
            break;
        }
        let offset = usize::from(u16::from_le_bytes([
            *src.get(position)?,
            *src.get(position + 1)?,
        ]));
        position += 2;
        if offset == 0 || offset > out.len() {
            return None;
        }
        let matched = length(src, &mut position, usize::from(token & 15))?.checked_add(4)?;
        if matched > out_len - out.len() {
            return None;
        }
        for _ in 0..matched {
            out.push(out[out.len() - offset]);
        }
    }
    Some(out)
}

type CsoImageReader = CsoReader<CsoSourceReader>;

struct CsoHeader {
    uncompressed_size: u64,
    block_size: u32,
    version: u8,
    alignment: u8,
}

impl CsoHeader {
    fn parse(bytes: &[u8; 24]) -> io::Result<Self> {
        let invalid =
            |message: &str| io::Error::new(io::ErrorKind::InvalidData, message.to_owned());
        if bytes[0..4] != CSO_SIGNATURE {
            return Err(invalid("Invalid CSO header"));
        }
        let version = bytes[20];
        if version > 2 {
            return Err(invalid("Unsupported CSO version"));
        }
        // The original v1 `ciso` tool leaves the header size at 0; v2 requires 24.
        // GameCube CISO stores its block size here, so it is still rejected.
        let header_size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        if header_size != 24 && !(header_size == 0 && is_deflate_version(version)) {
            return Err(invalid("Invalid CSO header"));
        }
        let mut size = [0; 8];
        size.copy_from_slice(&bytes[8..16]);
        Ok(Self {
            uncompressed_size: u64::from_le_bytes(size),
            block_size: u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
            version,
            alignment: bytes[21],
        })
    }
}

impl<R: ciso::read::Read<ReadError = io::Error>> CsoReader<R> {
    fn invalid(message: &str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, message)
    }

    fn new(mut source: R) -> io::Result<Self> {
        let mut bytes = [0; 24];
        source.read(0, &mut bytes)?;
        // The `ciso` header parser rejects every version except 2, so the header is read here.
        let header = CsoHeader::parse(&bytes)?;
        let block_size = header.block_size as usize;
        if block_size == 0 || block_size > 16 * 1024 * 1024 || header.alignment > 31 {
            return Err(Self::invalid("invalid CSO block size or alignment"));
        }
        let blocks = header.uncompressed_size.div_ceil(block_size as u64);
        let table_bytes = blocks
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| Self::invalid("CSO index size overflow"))?;
        let data_start = 24_u64
            .checked_add(table_bytes)
            .ok_or_else(|| Self::invalid("CSO index offset overflow"))?;
        let source_size = source.size()?;
        if data_start > source_size {
            return Err(Self::invalid("CSO index extends beyond source"));
        }
        let table_len = usize::try_from(table_bytes)
            .map_err(|_| Self::invalid("CSO index exceeds address space"))?;
        let mut table = vec![0; table_len];
        source.read(24, &mut table)?;
        let index = table
            .chunks_exact(4)
            .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect::<Vec<_>>();
        let mut previous = data_start;
        for entry in &index {
            let offset = u64::from(entry & 0x7fff_ffff) << header.alignment;
            if offset < previous || offset > source_size {
                return Err(Self::invalid(
                    "CSO block offsets are unordered or outside source",
                ));
            }
            previous = offset;
        }
        Ok(Self {
            source,
            logical_bytes: header.uncompressed_size,
            block_size,
            alignment: header.alignment,
            version: header.version,
            source_size,
            index,
        })
    }

    fn file_size(&self) -> u64 {
        self.logical_bytes
    }

    fn read_deflate_block(
        &mut self,
        start: u64,
        end: u64,
        block_len: usize,
    ) -> io::Result<Vec<u8>> {
        let stored_len = usize::try_from(end - start)
            .ok()
            .filter(|len| *len != 0 && *len <= self.block_size + self.block_size / 255 + 64)
            .ok_or_else(|| Self::invalid("invalid CSO deflate block length"))?;
        let mut stored = vec![0; stored_len];
        self.source.read(start, &mut stored)?;
        let mut decoded = vec![0; block_len];
        flate2::read::DeflateDecoder::new(stored.as_slice())
            .read_exact(&mut decoded)
            .map_err(|_| Self::invalid("invalid CSO deflate block"))?;
        trace!(stored_len, block_len, "cso deflate block");
        Ok(decoded)
    }

    /// Decodes a v2 block with the index high bit set. The `ciso` crate prefixes the LZ4 data
    /// with a 4-byte length; maxcso stores the bare LZ4 block, possibly followed by padding.
    fn read_lz4_block(&mut self, start: u64, end: u64, block_len: usize) -> io::Result<Vec<u8>> {
        let span = end - start;
        let max_stored = self.block_size + self.block_size / 255 + 16;
        if span >= 4 {
            let mut length = [0; 4];
            self.source.read(start, &mut length)?;
            let length = u32::from_le_bytes(length);
            let stored_len = (length & 0x7fff_ffff) as usize;
            if stored_len != 0 && stored_len <= max_stored && stored_len as u64 <= span - 4 {
                let mut stored = vec![0; stored_len];
                self.source.read(start + 4, &mut stored)?;
                let decoded = if length & 0x8000_0000 != 0 {
                    (stored_len == block_len).then_some(stored)
                } else {
                    let mut decoded = vec![0; self.block_size];
                    lz4_flex::block::decompress_into(&stored, &mut decoded)
                        .ok()
                        .filter(|decoded_len| *decoded_len == block_len)
                        .map(|_| decoded)
                };
                if let Some(mut decoded) = decoded {
                    trace!(stored_len, block_len, "cso ciso-layout lz4 block");
                    decoded.truncate(block_len);
                    return Ok(decoded);
                }
            }
        }
        let max_span = (max_stored as u64).saturating_add(1_u64 << self.alignment);
        if span == 0 || span > max_span {
            return Err(Self::invalid("invalid CSO LZ4 block length"));
        }
        let mut stored = vec![0; span as usize];
        self.source.read(start, &mut stored)?;
        let decoded = decode_lz4_prefix(&stored, block_len)
            .ok_or_else(|| Self::invalid("invalid CSO LZ4 compressed block"))?;
        trace!(span, block_len, "cso maxcso lz4 block");
        Ok(decoded)
    }

    fn read_offset(&mut self, mut pos: u64, mut output: &mut [u8]) -> io::Result<()> {
        if pos
            .checked_add(output.len() as u64)
            .is_none_or(|end| end > self.logical_bytes)
        {
            return Err(Self::invalid("CSO read exceeds logical size"));
        }
        while !output.is_empty() {
            let block = (pos / self.block_size as u64) as usize;
            let within = (pos % self.block_size as u64) as usize;
            let entry = self.index[block];
            let start = u64::from(entry & 0x7fff_ffff) << self.alignment;
            let mut end = u64::from(self.index[block + 1] & 0x7fff_ffff) << self.alignment;
            // The ciso writer rounds the final sentinel down to its alignment boundary.
            if block + 2 == self.index.len() && self.source_size - end < (1_u64 << self.alignment) {
                end = self.source_size;
            }
            let block_len = (self.logical_bytes - block as u64 * self.block_size as u64)
                .min(self.block_size as u64) as usize;
            let count = output.len().min(block_len - within);
            let raw = if is_deflate_version(self.version) {
                // In v0/v1 the high index bit marks a block stored without compression.
                entry & 0x8000_0000 != 0
            } else {
                // maxcso v2 stores a block raw when it is not smaller than its logical size.
                entry & 0x8000_0000 == 0 && end - start >= block_len as u64
            };
            if raw {
                if end - start < block_len as u64 {
                    return Err(Self::invalid("CSO raw block is truncated"));
                }
                self.source
                    .read(start + within as u64, &mut output[..count])?;
            } else {
                let decoded = if !is_deflate_version(self.version) && entry & 0x8000_0000 != 0 {
                    self.read_lz4_block(start, end, block_len)?
                } else {
                    self.read_deflate_block(start, end, block_len)?
                };
                output[..count].copy_from_slice(&decoded[within..within + count]);
            }
            pos += count as u64;
            output = &mut output[count..];
        }
        Ok(())
    }
}

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
        if file_starts_with(source, &CSO_SIGNATURE)
            && !super::gc_ciso::is_gamecube_ciso_file(source)
        {
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
        // Each worker opens its own reader and decodes its assigned range. It reads
        // only the compressed blocks in that range; the OPFS proxy supports this
        // path for spawned WASM threads.
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

#[cfg(test)]
mod reader_regressions {
    use super::*;

    fn image_with_spans(
        block_size: u32,
        logical_bytes: u64,
        alignment: u8,
        index: &[u32],
        payload: &[u8],
    ) -> Vec<u8> {
        let mut bytes = ciso::layout::CSOHeader::new().serialize().to_vec();
        bytes[8..16].copy_from_slice(&logical_bytes.to_le_bytes());
        bytes[16..20].copy_from_slice(&block_size.to_le_bytes());
        bytes[21] = alignment;
        for entry in index {
            bytes.extend_from_slice(&entry.to_le_bytes());
        }
        bytes.extend_from_slice(payload);
        bytes
    }

    /// Encodes `data` as a CSO v1 image: odd blocks are stored raw (high index bit), even
    /// blocks are raw deflate, and every block starts on a `1 << alignment` boundary.
    fn v1_image(data: &[u8], block_size: usize, alignment: u8) -> Vec<u8> {
        let unit = 1_usize << alignment;
        let blocks = data.len().div_ceil(block_size);
        let table_len = 24 + (blocks + 1) * 4;
        let mut body = vec![0; table_len.next_multiple_of(unit) - table_len];
        let mut index = Vec::new();
        for (number, chunk) in data.chunks(block_size).enumerate() {
            let position = (table_len + body.len()) >> alignment;
            let (stored, flag) = if number % 2 == 1 {
                (chunk.to_vec(), 0x8000_0000_u32)
            } else {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(chunk).expect("deflate chunk");
                (encoder.finish().expect("finish deflate"), 0)
            };
            index.push(position as u32 | flag);
            body.extend_from_slice(&stored);
            body.resize(
                (table_len + body.len()).next_multiple_of(unit) - table_len,
                0,
            );
        }
        index.push(((table_len + body.len()) >> alignment) as u32);
        let mut bytes = Vec::from(*b"CISO");
        bytes.extend_from_slice(&24_u32.to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&(block_size as u32).to_le_bytes());
        bytes.extend_from_slice(&[1, alignment, 0, 0]);
        for entry in index {
            bytes.extend_from_slice(&entry.to_le_bytes());
        }
        bytes.extend_from_slice(&body);
        bytes
    }

    fn v1_payload(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i / 7) ^ (i % 5)) as u8).collect()
    }

    #[test]
    fn cso_v1_reads_deflate_and_raw_blocks_with_alignment() {
        for alignment in [0_u8, 2, 5] {
            for len in [2048 * 4, 2048 * 4 + 100] {
                let data = v1_payload(len);
                let bytes = v1_image(&data, 2048, alignment);
                let mut reader =
                    CsoReader::new(std::io::Cursor::new(bytes)).expect("valid v1 image");
                assert_eq!(reader.file_size(), len as u64);
                let mut output = vec![0; len];
                reader.read_offset(0, &mut output).expect("full v1 read");
                assert_eq!(output, data, "alignment {alignment} len {len}");
                let mut window = [0; 3000];
                reader
                    .read_offset(1000, &mut window)
                    .expect("cross-block read");
                assert_eq!(window, data[1000..4000]);
            }
        }
    }

    #[test]
    fn cso_v1_rejects_corrupt_deflate_and_unknown_versions() {
        let data = v1_payload(2048);
        let mut bytes = v1_image(&data, 2048, 0);
        let start = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
        bytes[start..start + 4].copy_from_slice(&[0xff; 4]);
        let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("geometry is valid");
        assert!(reader.read_offset(0, &mut [0; 2048]).is_err());
        let mut bytes = v1_image(&data, 2048, 0);
        bytes[20] = 3;
        assert!(CsoReader::new(std::io::Cursor::new(bytes)).is_err());
    }

    #[test]
    fn cso_header_size_zero_is_accepted_only_for_v1() {
        let data = v1_payload(2048 * 3);
        let mut bytes = v1_image(&data, 2048, 0);
        bytes[4..8].copy_from_slice(&0_u32.to_le_bytes());
        let mut reader =
            CsoReader::new(std::io::Cursor::new(bytes.clone())).expect("v1 header size 0");
        let mut output = vec![0; data.len()];
        reader.read_offset(0, &mut output).expect("full v1 read");
        assert_eq!(output, data);
        bytes[20] = 2;
        assert!(CsoReader::new(std::io::Cursor::new(bytes.clone())).is_err());
        bytes[20] = 1;
        bytes[4..8].copy_from_slice(&0x0020_0000_u32.to_le_bytes());
        assert!(CsoReader::new(std::io::Cursor::new(bytes)).is_err());
    }

    #[test]
    fn cso_final_sentinel_tail_respects_alignment_boundary() {
        for tail in [3, 4, 5] {
            let payload = (0..4 + tail).map(|index| index as u8).collect::<Vec<_>>();
            let bytes = image_with_spans(8, 7, 2, &[8, 9], &payload);
            let mut reader =
                CsoReader::new(std::io::Cursor::new(bytes)).expect("valid aligned index");
            let mut output = [0; 7];
            let result = reader.read_offset(0, &mut output);
            if tail < 4 {
                result.expect("rounded-down final sentinel retains its partial alignment tail");
                assert_eq!(output, payload[..7]);
            } else {
                assert!(
                    result.is_err(),
                    "tail {tail} exceeds the final sentinel's alignment unit"
                );
            }
        }
        let bytes = image_with_spans(1, 2, 2, &[9, 9, 9], &[7, 8]);
        let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("ordered index");
        assert!(
            reader.read_offset(0, &mut [0]).is_err(),
            "a nonfinal block cannot borrow the file's alignment tail"
        );
    }

    #[test]
    fn cso_reads_partial_final_logical_block() {
        let payload = (0..10).collect::<Vec<u8>>();
        let bytes = image_with_spans(8, 10, 0, &[36, 44, 46], &payload);
        let mut reader =
            CsoReader::new(std::io::Cursor::new(bytes)).expect("partial final geometry");
        let mut output = [0; 3];
        reader
            .read_offset(7, &mut output)
            .expect("read across partial final block");
        assert_eq!(output, [7, 8, 9]);
    }

    #[test]
    fn cso_declared_spans_bound_raw_and_compressed_reads() {
        let bytes = image_with_spans(8, 8, 0, &[32, 36], &[7; 16]);
        let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("ordered raw index");
        assert!(reader.read_offset(0, &mut [0; 8]).is_err());
        let mut payload = (0x8000_0008_u32).to_le_bytes().to_vec();
        payload.extend_from_slice(&[7; 8]);
        for span in [0, 1, 2, 3, 11, 12] {
            let bytes = image_with_spans(8, 8, 0, &[32 | 0x8000_0000, 32 + span], &payload);
            let mut reader =
                CsoReader::new(std::io::Cursor::new(bytes)).expect("ordered compressed index");
            let mut output = [0; 8];
            let result = reader.read_offset(0, &mut output);
            if span == 12 {
                result.expect("complete uncompressed LZ4 frame block");
                assert_eq!(output, [7; 8]);
            } else {
                assert!(
                    result.is_err(),
                    "declared span {span} cannot read the payload beyond it"
                );
            }
        }
    }

    #[test]
    fn cso_lz4_literal_blocks_accept_valid_expansion() {
        for size in [2048_usize, 65536] {
            let mut compressed = vec![0xf0];
            let mut remaining = size - 15;
            while remaining >= 255 {
                compressed.push(255);
                remaining -= 255;
            }
            compressed.push(remaining as u8);
            let original = (0..size).map(|index| index as u8).collect::<Vec<_>>();
            compressed.extend_from_slice(&original);
            let mut payload = (compressed.len() as u32).to_le_bytes().to_vec();
            payload.extend_from_slice(&compressed);
            let bytes = image_with_spans(
                size as u32,
                size as u64,
                0,
                &[32 | 0x8000_0000, 32 + payload.len() as u32],
                &payload,
            );
            let mut reader =
                CsoReader::new(std::io::Cursor::new(bytes)).expect("valid literal block geometry");
            let mut output = vec![0; size];
            reader
                .read_offset(0, &mut output)
                .expect("valid expanded LZ4 literal stream");
            assert_eq!(output, original);
        }
    }

    fn match_block(offset: u8, preceding_match: bool) -> Vec<u8> {
        let mut compressed = if preceding_match {
            vec![0x10, b'A', 1, 0, 0x0f, offset, 0]
        } else {
            vec![0x1f, b'A', offset, 0]
        };
        compressed.extend_from_slice(&[255; 7]);
        compressed.push(if preceding_match { 234 } else { 238 });
        compressed.extend_from_slice(&[0x50, b'B', b'B', b'B', b'B', b'B']);
        let mut payload = (compressed.len() as u32).to_le_bytes().to_vec();
        payload.extend_from_slice(&compressed);
        image_with_spans(
            2048,
            2048,
            0,
            &[0x8000_0020, 32 + payload.len() as u32],
            &payload,
        )
    }

    #[test]
    fn cso_lz4_rejects_zero_match_offsets() {
        for preceding_match in [false, true] {
            let bytes = match_block(0, preceding_match);
            let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("valid geometry");
            let error = reader
                .read_offset(0, &mut [0; 2048])
                .expect_err("zero offset after literals or a match must be rejected");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn cso_lz4_match_offsets_preserve_bytes_and_bounds() {
        for preceding_match in [false, true] {
            let bytes = match_block(1, preceding_match);
            for logical_bytes in [2047_u64, 2048, 2049] {
                let mut bytes = bytes.clone();
                bytes[8..16].copy_from_slice(&logical_bytes.to_le_bytes());
                bytes[16..20].copy_from_slice(&4096_u32.to_le_bytes());
                let mut reader =
                    CsoReader::new(std::io::Cursor::new(bytes)).expect("valid geometry");
                let mut output = vec![0; logical_bytes as usize];
                let result = reader.read_offset(0, &mut output);
                if logical_bytes == 2048 {
                    result.expect("valid offset one");
                    assert_eq!(&output[..2043], &[b'A'; 2043]);
                    assert_eq!(&output[2043..], &[b'B'; 5]);
                    let mut tail = [0; 6];
                    reader
                        .read_offset(2042, &mut tail)
                        .expect("partial match read");
                    assert_eq!(tail, [b'A', b'B', b'B', b'B', b'B', b'B']);
                    assert!(reader.read_offset(2048, &mut [0]).is_err());
                } else {
                    assert!(
                        result.is_err(),
                        "decoded size must equal logical block length"
                    );
                }
            }
        }
    }

    #[test]
    fn cso_oversized_lz4_payload_is_rejected_before_body_read() {
        struct ObservedSource {
            bytes: Vec<u8>,
            body_reads: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        }
        impl ciso::read::Read for ObservedSource {
            type ReadError = io::Error;
            fn size(&mut self) -> io::Result<u64> {
                Ok(self.bytes.len() as u64)
            }
            fn read(&mut self, pos: u64, output: &mut [u8]) -> io::Result<()> {
                if pos >= 36 {
                    self.body_reads
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                let start = pos as usize;
                output.copy_from_slice(&self.bytes[start..start + output.len()]);
                Ok(())
            }
        }
        let length = 2048 + 2048 / 255 + 17;
        let mut payload = (length as u32).to_le_bytes().to_vec();
        payload.resize(4 + length, 0);
        let bytes = image_with_spans(
            2048,
            2048,
            0,
            &[32 | 0x8000_0000, 32 + payload.len() as u32],
            &payload,
        );
        let body_reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let source = ObservedSource {
            bytes,
            body_reads: body_reads.clone(),
        };
        let mut reader = CsoReader::new(source).expect("valid geometry");
        assert!(reader.read_offset(0, &mut [0; 2048]).is_err());
        assert_eq!(
            body_reads.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "invalid compressed length must be rejected before reading its body"
        );
    }

    #[test]
    fn cso_v2_raw_and_lz4_blocks_support_partial_reads() {
        let mut seed = 1_u32;
        let raw = (0..4096)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect::<Vec<_>>();
        for (source, compressed) in [(raw, false), (vec![0; 4096], true)] {
            let mut image = std::io::Cursor::new(Vec::new());
            ciso::write::write_ciso_image(&mut std::io::Cursor::new(&source), &mut image, |_| {})
                .expect("write v2 fixture");
            let bytes = image.into_inner();
            let entry = u32::from_le_bytes(bytes[24..28].try_into().expect("index entry"));
            assert_eq!(entry & 0x8000_0000 != 0, compressed);
            let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("open v2 fixture");
            let mut output = vec![0; 3000];
            reader
                .read_offset(37, &mut output)
                .expect("partial multi-block read");
            assert_eq!(output, source[37..3037]);
        }
    }

    #[test]
    fn cso_rejects_invalid_geometry_and_index() {
        for (block_size, alignment, first, last) in [
            (0, 0, 32, 2080),
            (2048, 32, 32, 2080),
            (2048, 0, 2080, 32),
            (2048, 0, 32, 4096),
            (2048, 0, 0, 2080),
        ] {
            let mut bytes = ciso::layout::CSOHeader::new().serialize().to_vec();
            bytes[8..16].copy_from_slice(&2048_u64.to_le_bytes());
            bytes[16..20].copy_from_slice(&u32::to_le_bytes(block_size));
            bytes[21] = alignment;
            bytes.extend_from_slice(&u32::to_le_bytes(first));
            bytes.extend_from_slice(&u32::to_le_bytes(last));
            bytes.resize(2080, 0);
            assert!(CsoReader::new(std::io::Cursor::new(bytes)).is_err());
        }
    }

    #[test]
    fn cso_invalid_lz4_payload_returns_error() {
        let mut bytes = ciso::layout::CSOHeader::new().serialize().to_vec();
        bytes[8..16].copy_from_slice(&2048_u64.to_le_bytes());
        bytes[21] = 0;
        bytes.extend_from_slice(&(32_u32 | 0x8000_0000).to_le_bytes());
        bytes.extend_from_slice(&37_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.push(0);
        let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("valid geometry");
        assert!(reader.read_offset(0, &mut [0; 2048]).is_err());
    }

    #[test]
    fn cso_malformed_compressed_block_returns_error() {
        let mut bytes = ciso::layout::CSOHeader::new().serialize().to_vec();
        bytes[8..16].copy_from_slice(&2048_u64.to_le_bytes());
        bytes[21] = 0;
        bytes.extend_from_slice(&(32_u32 | 0x8000_0000).to_le_bytes());
        bytes.extend_from_slice(&2080_u32.to_le_bytes());
        bytes.resize(2080, 0x55);
        let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("valid geometry");
        assert!(reader.read_offset(0, &mut [0; 2048]).is_err());
    }

    /// Builds a CSO v2 image the way maxcso documents it: bit 31 selects LZ4 (bare block) over
    /// deflate, a block whose stored length is not below its logical size is raw, and padding
    /// (here 0xAA, since any byte is allowed) fills each block to the alignment boundary.
    fn maxcso_image(data: &[u8], block_size: usize, alignment: u8, only_lz4: bool) -> Vec<u8> {
        let unit = 1_usize << alignment;
        let blocks = data.len().div_ceil(block_size);
        let table_len = 24 + (blocks + 1) * 4;
        let mut body = vec![0xaa; table_len.next_multiple_of(unit) - table_len];
        let mut index = Vec::new();
        for (number, chunk) in data.chunks(block_size).enumerate() {
            let position = ((table_len + body.len()) >> alignment) as u32;
            let (stored, flag) = if only_lz4 || number % 3 == 0 {
                (lz4_flex::block::compress(chunk), 0x8000_0000_u32)
            } else {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
                encoder.write_all(chunk).expect("deflate chunk");
                (encoder.finish().expect("finish deflate"), 0)
            };
            let (stored, flag) = if stored.len().next_multiple_of(unit) >= chunk.len() {
                (chunk.to_vec(), 0)
            } else {
                (stored, flag)
            };
            index.push(position | flag);
            body.extend_from_slice(&stored);
            body.resize(
                (table_len + body.len()).next_multiple_of(unit) - table_len,
                0xaa,
            );
        }
        index.push(((table_len + body.len()) >> alignment) as u32);
        let mut bytes = Vec::from(*b"CISO");
        bytes.extend_from_slice(&24_u32.to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&(block_size as u32).to_le_bytes());
        bytes.extend_from_slice(&[2, alignment, 0, 0]);
        for entry in index {
            bytes.extend_from_slice(&entry.to_le_bytes());
        }
        bytes.extend_from_slice(&body);
        bytes
    }

    /// Compressible blocks, incompressible blocks, and a run, so every storage kind appears.
    fn maxcso_payload(len: usize) -> Vec<u8> {
        let mut seed = 7_u32;
        (0..len)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                match (i / 2048) % 3 {
                    0 => (i % 11) as u8,
                    1 => seed as u8,
                    _ => 0,
                }
            })
            .collect()
    }

    #[test]
    fn cso_maxcso_v2_reads_deflate_lz4_and_raw_blocks() {
        for only_lz4 in [false, true] {
            for alignment in [0_u8, 2, 5] {
                for len in [2048 * 9, 2048 * 9 + 100, 700] {
                    let data = maxcso_payload(len);
                    let bytes = maxcso_image(&data, 2048, alignment, only_lz4);
                    let mut reader =
                        CsoReader::new(std::io::Cursor::new(bytes)).expect("maxcso v2 image");
                    let mut output = vec![0; len];
                    reader.read_offset(0, &mut output).expect("full v2 read");
                    assert_eq!(
                        output, data,
                        "lz4 {only_lz4} alignment {alignment} len {len}"
                    );
                    if len > 4000 {
                        let mut window = [0; 3000];
                        reader.read_offset(1000, &mut window).expect("window");
                        assert_eq!(window, data[1000..4000]);
                    }
                }
            }
        }
    }

    #[test]
    fn cso_maxcso_v2_fixtures_use_every_block_kind() {
        let data = maxcso_payload(2048 * 9);
        for only_lz4 in [false, true] {
            let bytes = maxcso_image(&data, 2048, 0, only_lz4);
            let offsets = (0..10)
                .map(|n| u32::from_le_bytes(bytes[24 + n * 4..28 + n * 4].try_into().unwrap()))
                .collect::<Vec<_>>();
            let kinds = (0..9)
                .map(|n| {
                    let span = (offsets[n + 1] & 0x7fff_ffff) - (offsets[n] & 0x7fff_ffff);
                    (offsets[n] & 0x8000_0000 != 0, span >= 2048)
                })
                .collect::<Vec<_>>();
            assert!(kinds.contains(&(true, false)), "lz4 block present");
            assert!(kinds.contains(&(false, true)), "raw block present");
            assert_eq!(kinds.contains(&(false, false)), !only_lz4, "deflate block");
        }
    }

    #[test]
    fn cso_maxcso_v2_lz4_tolerates_padding_but_rejects_corruption() {
        let data = vec![5_u8; 2048];
        let bytes = maxcso_image(&data, 2048, 5, true);
        let start =
            ((u32::from_le_bytes(bytes[24..28].try_into().unwrap()) & 0x7fff_ffff) << 5) as usize;
        // Corrupt the token stream: a match offset of zero must be rejected.
        let mut corrupt = bytes.clone();
        corrupt[start + 2] = 0;
        corrupt[start + 3] = 0;
        let mut reader = CsoReader::new(std::io::Cursor::new(corrupt)).expect("geometry");
        assert!(reader.read_offset(0, &mut [0; 2048]).is_err());
        let mut reader = CsoReader::new(std::io::Cursor::new(bytes)).expect("geometry");
        let mut output = [0; 2048];
        reader.read_offset(0, &mut output).expect("padded block");
        assert_eq!(output.as_slice(), data.as_slice());
    }

    #[test]
    fn lz4_prefix_decoder_stops_at_output_length_and_checks_bounds() {
        let data = (0..300_u32).map(|i| (i % 7) as u8).collect::<Vec<_>>();
        let mut compressed = lz4_flex::block::compress(&data);
        assert_eq!(
            decode_lz4_prefix(&compressed, 300).as_deref(),
            Some(&data[..])
        );
        compressed.extend_from_slice(&[0, 0, 0, 0, 0]);
        assert_eq!(
            decode_lz4_prefix(&compressed, 300).as_deref(),
            Some(&data[..])
        );
        assert!(decode_lz4_prefix(&compressed, 301).is_none());
        assert!(decode_lz4_prefix(&[], 1).is_none());
        // literal-only block of 3 bytes, then a match with offset beyond history
        assert_eq!(decode_lz4_prefix(&[0x30, 1, 2, 3], 3), Some(vec![1, 2, 3]));
        assert!(decode_lz4_prefix(&[0x30, 1, 2, 3], 4).is_none());
        assert!(decode_lz4_prefix(&[0x30, 1, 2, 3], 2).is_none());
        assert!(decode_lz4_prefix(&[0x20, 1, 2, 3], 1).is_none());
        // Extended literal length: 15 + 255 + 3 literals.
        let mut long = vec![0xf0, 255, 3];
        long.extend((0..273).map(|i| i as u8));
        assert_eq!(
            decode_lz4_prefix(&long, 273).map(|out| out.len()),
            Some(273)
        );
        assert!(decode_lz4_prefix(&long, 272).is_none());
        assert!(decode_lz4_prefix(&[0x31, 1, 2, 3, 4, 0, 0], 8).is_none());
        assert!(decode_lz4_prefix(&[0x11, 1, 2, 0], 6).is_none());
        assert_eq!(
            decode_lz4_prefix(&[0x11, 1, 1, 0], 6),
            Some(vec![1, 1, 1, 1, 1, 1])
        );
        assert!(decode_lz4_prefix(&[0x11, 1, 1, 0], 5).is_none());
        assert!(decode_lz4_prefix(&[0xf0, 255], 270).is_none());
    }
}
