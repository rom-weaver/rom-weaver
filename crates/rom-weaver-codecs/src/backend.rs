use super::*;
use tracing::{debug, trace};

impl NativeCodecBackend {
    const STORE_COPY_MIN_PARALLEL_BYTES: usize = 1 << 20;
    const LIBARCHIVE_IO_BUFFER_BYTES: usize = 128 * 1024;
    const LIBARCHIVE_OPEN_BLOCK_BYTES: usize = 64 * 1024;

    pub(super) const fn new(descriptor: &'static CodecDescriptor, kind: NativeCodecKind) -> Self {
        Self { descriptor, kind }
    }

    pub(super) fn ensure_output_parent(path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    pub(super) fn validate_decode_level(&self, request: &CodecOperationRequest) -> Result<()> {
        if request.level.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{} decode does not accept a compression level",
                self.descriptor.name
            )));
        }
        Ok(())
    }

    pub(super) fn resolve_encode_level(
        &self,
        request: &CodecOperationRequest,
    ) -> Result<Option<i32>> {
        let resolved = match self.kind {
            NativeCodecKind::Store => {
                if request.level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "store codec does not accept a compression level".to_string(),
                    ));
                }
                None
            }
            NativeCodecKind::Deflate => Some(match request.level {
                None => 6,
                Some(value) if (0..=9).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "deflate level `{value}` is out of range (0..=9)"
                    )));
                }
            }),
            NativeCodecKind::Zstd => Some(match request.level {
                None => 3,
                Some(value) if (-7..=22).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "zstd level `{value}` is out of range (-7..=22)"
                    )));
                }
            }),
            NativeCodecKind::Lzma2 => Some(match request.level {
                None => 6,
                Some(value) if (0..=9).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "lzma2 level `{value}` is out of range (0..=9)"
                    )));
                }
            }),
            NativeCodecKind::Bzip2 => Some(match request.level {
                None => 6,
                Some(value) if (1..=9).contains(&value) => value,
                Some(value) => {
                    return Err(RomWeaverError::Validation(format!(
                        "bzip2 level `{value}` is out of range (1..=9)"
                    )));
                }
            }),
        };
        Ok(resolved)
    }

    pub(super) fn encode_thread_capability(&self) -> ThreadCapability {
        ThreadCapability::single_threaded()
    }

    pub(super) fn decode_thread_capability(&self) -> ThreadCapability {
        match self.kind {
            NativeCodecKind::Store
            | NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => ThreadCapability::parallel(None),
        }
    }

    pub(super) fn io_policy(execution: &ThreadExecution) -> BoundedIoPolicy {
        BoundedIoPolicy::for_effective_threads(execution.effective_threads)
    }

    pub(super) fn file_chunks(path: &Path, policy: &BoundedIoPolicy) -> Result<Vec<FileChunk>> {
        let file_len = fs::metadata(path)?.len();
        let planner = ChunkPlanner::new(policy.chunk_size_bytes)?;
        Ok(planner.plan(file_len))
    }

    pub(super) fn read_chunk_batch(
        source: &mut BufReader<File>,
        chunks: &[FileChunk],
    ) -> Result<Vec<(u64, Vec<u8>)>> {
        let mut batch = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            let len = usize::try_from(chunk.len).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "chunk length exceeded addressable memory (index={}, len={})",
                    chunk.index, chunk.len
                ))
            })?;
            source.seek(SeekFrom::Start(chunk.offset))?;
            let mut payload = vec![0u8; len];
            source.read_exact(&mut payload)?;
            batch.push((chunk.index, payload));
        }
        Ok(batch)
    }

    pub(super) fn encode_with_native_writer(
        &self,
        request: &CodecOperationRequest,
        level: i32,
    ) -> Result<u64> {
        let input_len = fs::metadata(&request.input)?.len();
        let mut source = BufReader::new(File::open(&request.input)?);
        let output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
        match self.kind {
            NativeCodecKind::Deflate => {
                let mut encoder = GzEncoder::new(output, FlateCompression::new(level as u32));
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
            }
            NativeCodecKind::Zstd => {
                let mut encoder = ZstdEncoder::new(output, level).map_err(|error| {
                    RomWeaverError::Validation(format!("zstd encode init failed: {error}"))
                })?;
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish().map_err(|error| {
                    RomWeaverError::Validation(format!("zstd encode finalize failed: {error}"))
                })?;
                output.flush()?;
            }
            NativeCodecKind::Lzma2 => {
                let mut encoder = XzWriter::new(output, XzOptions::with_preset(level as u32))
                    .map_err(|error| {
                        RomWeaverError::Validation(format!("xz encode init failed: {error}"))
                    })?;
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish().map_err(|error| {
                    RomWeaverError::Validation(format!("xz encode finalize failed: {error}"))
                })?;
                output.flush()?;
            }
            NativeCodecKind::Bzip2 => {
                let mut encoder = BzEncoder::new(output, Bzip2Compression::new(level as u32));
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
            }
            NativeCodecKind::Store => {
                return Err(RomWeaverError::Validation(
                    "store codec does not use native compression writers".to_string(),
                ));
            }
        }
        Ok(input_len)
    }

    pub(super) fn decode_with_libarchive(&self, request: &CodecOperationRequest) -> Result<u64> {
        let mut archive =
            libarchive_open_read_archive(self.descriptor.name, self.kind, &request.input)?;
        let result = (|| -> Result<u64> {
            if !archive.next_header(&format!(
                "{} decode failed while reading header",
                self.descriptor.name
            ))? {
                return Err(RomWeaverError::Validation(format!(
                    "{} decode found no compressed payload entries",
                    self.descriptor.name
                )));
            }

            let mut output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
            let copied = libarchive_read_entry_to_writer(
                &mut archive,
                self.descriptor.name,
                &mut output,
                Self::LIBARCHIVE_IO_BUFFER_BYTES,
            )?;
            output.flush()?;
            Ok(copied)
        })();

        match (
            result,
            libarchive_close_read_archive(archive, self.descriptor.name),
        ) {
            (Ok(bytes), Ok(())) => Ok(bytes),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    pub(super) fn copy_store_payload(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            let mut output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
            output.flush()?;
            return Ok(0);
        }

        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("store payload exceeded addressable memory".into())
        })?;
        let policy = Self::io_policy(execution);
        let chunks = Self::file_chunks(&request.input, &policy)?;
        trace!(
            codec = self.descriptor.name,
            input_len,
            chunks = chunks.len(),
            used_parallelism = execution.used_parallelism,
            "store payload copy plan"
        );

        if execution.used_parallelism {
            if input_len < Self::STORE_COPY_MIN_PARALLEL_BYTES {
                execution.apply_pool_fallback(format!(
                    "store codec payload too small for threaded copy ({input_len} bytes)"
                ));
            } else {
                let (pool_execution, pool) =
                    SharedThreadPool::with_execution_fallback(execution.clone())?;
                *execution = pool_execution;
                if execution.used_parallelism {
                    let mut source = BufReader::new(File::open(&request.input)?);
                    let output =
                        BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                    let mut ordered =
                        OrderedChunkWriter::new(output, policy.max_reorder_items.max(1))?;
                    for batch in chunks.chunks(policy.max_in_flight_items.max(1)) {
                        let batch_bytes = Self::read_chunk_batch(&mut source, batch)?;
                        let copied_batch = pool.install(|| {
                            batch_bytes
                                .into_par_iter()
                                .map(|(chunk_index, chunk)| Ok((chunk_index, chunk)))
                                .collect::<Result<Vec<_>>>()
                        })?;
                        for (chunk_index, chunk) in copied_batch {
                            ordered.write_chunk(chunk_index, chunk)?;
                        }
                    }
                    let _ = ordered.finish()?;
                    return Ok(input_len_u64);
                }
            }
        }

        let mut source = BufReader::new(File::open(&request.input)?);
        let mut output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
        let copied = io::copy(&mut source, &mut output)?;
        output.flush()?;
        Ok(copied)
    }

    pub(super) fn encode_impl(
        &self,
        request: &CodecOperationRequest,
        level: Option<i32>,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        trace!(
            codec = self.descriptor.name,
            kind = ?self.kind,
            level,
            "codec encode path selected"
        );
        let bytes = match self.kind {
            NativeCodecKind::Store => self.copy_store_payload(request, execution)?,
            NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => {
                let resolved_level = level.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "{} encode level resolution failed",
                        self.descriptor.name
                    ))
                })?;
                self.encode_with_native_writer(request, resolved_level)?
            }
        };
        Ok(bytes)
    }

    pub(super) fn decode_impl(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        trace!(
            codec = self.descriptor.name,
            kind = ?self.kind,
            "codec decode path selected"
        );
        let bytes = match self.kind {
            NativeCodecKind::Store => self.copy_store_payload(request, execution)?,
            NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => self.decode_with_libarchive(request)?,
        };
        Ok(bytes)
    }

    pub(super) fn run_encode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let level = self.resolve_encode_level(request)?;
        Self::ensure_output_parent(&request.output)?;
        let mut execution = context.plan_threads(self.encode_thread_capability());
        debug!(
            codec = self.descriptor.name,
            kind = ?self.kind,
            level,
            input = %request.input.display(),
            "codec encode start"
        );
        let bytes = self.encode_impl(request, level, &mut execution)?;
        debug!(
            codec = self.descriptor.name,
            output_bytes = bytes,
            "codec encode complete"
        );
        Ok(OperationReport::succeeded(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "encode",
            format!(
                "encoded `{}` to `{}` using {} ({} bytes)",
                request.input.display(),
                request.output.display(),
                self.descriptor.name,
                bytes
            ),
            Some(1.0),
            Some(execution),
        ))
    }

    pub(super) fn run_decode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.validate_decode_level(request)?;
        Self::ensure_output_parent(&request.output)?;
        let mut execution = context.plan_threads(self.decode_thread_capability());
        debug!(
            codec = self.descriptor.name,
            kind = ?self.kind,
            input = %request.input.display(),
            "codec decode start"
        );
        let bytes = self.decode_impl(request, &mut execution)?;
        debug!(
            codec = self.descriptor.name,
            output_bytes = bytes,
            "codec decode complete"
        );
        Ok(OperationReport::succeeded(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "decode",
            format!(
                "decoded `{}` to `{}` using {} ({} bytes)",
                request.input.display(),
                request.output.display(),
                self.descriptor.name,
                bytes
            ),
            Some(1.0),
            Some(execution),
        ))
    }
}

pub(super) fn libarchive_open_read_archive(
    codec_name: &str,
    kind: NativeCodecKind,
    input: &Path,
) -> Result<ReadArchive> {
    let mut archive = ReadArchive::new(&format!("{codec_name} decode failed"))?;
    let setup_result = (|| -> Result<()> {
        archive.support_raw_format(&format!(
            "{codec_name} decode failed while enabling raw format"
        ))?;

        let filter = libarchive_read_filter(kind)?;
        archive.support_filter(
            filter,
            &format!(
                "{codec_name} decode failed while enabling {} filter",
                libarchive_read_filter_name(filter)
            ),
        )?;

        archive.open_filename(
            input,
            "codec input",
            NativeCodecBackend::LIBARCHIVE_OPEN_BLOCK_BYTES,
            &format!(
                "{codec_name} decode failed while opening input `{}`",
                input.display()
            ),
        )?;
        Ok(())
    })();

    setup_result?;

    Ok(archive)
}

pub(super) fn libarchive_read_filter(kind: NativeCodecKind) -> Result<ReadFilter> {
    match kind {
        NativeCodecKind::Deflate => Ok(ReadFilter::Gzip),
        NativeCodecKind::Zstd => Ok(ReadFilter::Zstd),
        NativeCodecKind::Lzma2 => Ok(ReadFilter::Xz),
        NativeCodecKind::Bzip2 => Ok(ReadFilter::Bzip2),
        NativeCodecKind::Store => Err(RomWeaverError::Validation(
            "store codec does not use libarchive filters".to_string(),
        )),
    }
}

pub(super) fn libarchive_read_filter_name(filter: ReadFilter) -> &'static str {
    match filter {
        ReadFilter::Gzip => "gzip",
        ReadFilter::Bzip2 => "bzip2",
        ReadFilter::Xz => "xz",
        ReadFilter::Zstd => "zstd",
    }
}

pub(super) fn libarchive_read_entry_to_writer<W: Write>(
    archive: &mut ReadArchive,
    codec_name: &str,
    output: &mut W,
    buffer_bytes: usize,
) -> Result<u64> {
    archive.read_entry_to_writer(
        output,
        buffer_bytes,
        &format!("{codec_name} decode failed while reading payload data"),
    )
}

pub(super) fn libarchive_close_read_archive(archive: ReadArchive, codec_name: &str) -> Result<()> {
    archive.close(
        &format!("{codec_name} decode failed while closing reader"),
        &format!("{codec_name} decode failed while freeing reader"),
    )
}
