impl NativeCodecBackend {
    const STORE_COPY_MIN_PARALLEL_BYTES: usize = 1 << 20;
    const LIBARCHIVE_IO_BUFFER_BYTES: usize = 128 * 1024;
    const LIBARCHIVE_OPEN_BLOCK_BYTES: usize = 64 * 1024;

    const fn new(descriptor: &'static CodecDescriptor, kind: NativeCodecKind) -> Self {
        Self { descriptor, kind }
    }

    fn ensure_output_parent(path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    fn validate_decode_level(&self, request: &CodecOperationRequest) -> Result<()> {
        if request.level.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{} decode does not accept a compression level",
                self.descriptor.name
            )));
        }
        Ok(())
    }

    fn resolve_encode_level(&self, request: &CodecOperationRequest) -> Result<Option<i32>> {
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

    fn encode_thread_capability(&self) -> ThreadCapability {
        match self.kind {
            NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => ThreadCapability::parallel(None),
            NativeCodecKind::Store => ThreadCapability::single_threaded(),
        }
    }

    fn decode_thread_capability(&self) -> ThreadCapability {
        match self.kind {
            NativeCodecKind::Store
            | NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => ThreadCapability::parallel(None),
        }
    }

    fn io_policy(execution: &ThreadExecution) -> BoundedIoPolicy {
        BoundedIoPolicy::for_effective_threads(execution.effective_threads)
    }

    fn file_chunks(path: &Path, policy: &BoundedIoPolicy) -> Result<Vec<FileChunk>> {
        let file_len = fs::metadata(path)?.len();
        let planner = ChunkPlanner::new(policy.chunk_size_bytes)?;
        Ok(planner.plan(file_len))
    }

    fn read_chunk_batch(
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

    fn encode_with_libarchive(
        &self,
        request: &CodecOperationRequest,
        level: i32,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let input_len = fs::metadata(&request.input)?.len();
        let mut source = BufReader::new(File::open(&request.input)?);
        let archive_name = request
            .input
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("data");

        let thread_count = Some(execution.effective_threads.max(1));
        let archive_ptr = libarchive_open_write_archive(
            self.descriptor.name,
            self.kind,
            &request.output,
            level,
            thread_count,
        )?;
        let result = (|| -> Result<u64> {
            libarchive_write_raw_entry_from_reader(
                archive_ptr,
                self.descriptor.name,
                archive_name,
                input_len,
                &mut source,
                Self::LIBARCHIVE_IO_BUFFER_BYTES,
            )?;
            Ok(input_len)
        })();

        match (
            result,
            libarchive_close_write_archive(archive_ptr, self.descriptor.name),
        ) {
            (Ok(bytes), Ok(())) => Ok(bytes),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    fn decode_with_libarchive(&self, request: &CodecOperationRequest) -> Result<u64> {
        let archive_ptr =
            libarchive_open_read_archive(self.descriptor.name, self.kind, &request.input)?;
        let result = (|| -> Result<u64> {
            let mut entry: *mut archive_entry = ptr::null_mut();
            let next_status = unsafe { archive_read_next_header(archive_ptr, &mut entry) };
            if next_status == ARCHIVE_EOF {
                return Err(RomWeaverError::Validation(format!(
                    "{} decode found no compressed payload entries",
                    self.descriptor.name
                )));
            }
            libarchive_check_status(
                next_status,
                archive_ptr,
                &format!(
                    "{} decode failed while reading header",
                    self.descriptor.name
                ),
            )?;

            let output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
            let mut output = output;
            let copied = libarchive_read_entry_to_writer(
                archive_ptr,
                self.descriptor.name,
                &mut output,
                Self::LIBARCHIVE_IO_BUFFER_BYTES,
            )?;
            output.flush()?;
            Ok(copied)
        })();

        match (
            result,
            libarchive_close_read_archive(archive_ptr, self.descriptor.name),
        ) {
            (Ok(bytes), Ok(())) => Ok(bytes),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    fn copy_store_payload(
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

        if execution.used_parallelism {
            if input_len < Self::STORE_COPY_MIN_PARALLEL_BYTES {
                execution.apply_pool_fallback(format!(
                    "store codec payload too small for threaded copy ({input_len} bytes)"
                ));
            } else {
                match rayon::ThreadPoolBuilder::new()
                    .num_threads(execution.effective_threads.max(1))
                    .build()
                {
                    Ok(pool) => {
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
                    Err(error) => execution.apply_pool_fallback(format!(
                        "store codec thread pool build failed: {error}"
                    )),
                }
            }
        }

        let mut source = BufReader::new(File::open(&request.input)?);
        let mut output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
        let copied = io::copy(&mut source, &mut output)?;
        output.flush()?;
        Ok(copied)
    }

    fn encode_impl(
        &self,
        request: &CodecOperationRequest,
        level: Option<i32>,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
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
                self.encode_with_libarchive(request, resolved_level, execution)?
            }
        };
        Ok(bytes)
    }

    fn decode_impl(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let bytes = match self.kind {
            NativeCodecKind::Store => self.copy_store_payload(request, execution)?,
            NativeCodecKind::Deflate
            | NativeCodecKind::Zstd
            | NativeCodecKind::Lzma2
            | NativeCodecKind::Bzip2 => self.decode_with_libarchive(request)?,
        };
        Ok(bytes)
    }

    fn run_encode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let level = self.resolve_encode_level(request)?;
        Self::ensure_output_parent(&request.output)?;
        let mut execution = context.plan_threads(self.encode_thread_capability());
        let bytes = self.encode_impl(request, level, &mut execution)?;
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

    fn run_decode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.validate_decode_level(request)?;
        Self::ensure_output_parent(&request.output)?;
        let mut execution = context.plan_threads(self.decode_thread_capability());
        let bytes = self.decode_impl(request, &mut execution)?;
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

fn libarchive_open_write_archive(
    codec_name: &str,
    kind: NativeCodecKind,
    output: &Path,
    level: i32,
    thread_count: Option<usize>,
) -> Result<*mut archive> {
    let archive_ptr = unsafe { archive_write_new() };
    if archive_ptr.is_null() {
        return Err(RomWeaverError::Validation(format!(
            "{codec_name} encode failed: libarchive writer allocation returned null"
        )));
    }

    let output_path = path_to_cstring(output, "codec output")?;
    let setup_result = (|| -> Result<()> {
        libarchive_check_status(
            unsafe { archive_write_set_format_raw(archive_ptr) },
            archive_ptr,
            &format!("{codec_name} encode failed while selecting raw format"),
        )?;

        match kind {
            NativeCodecKind::Deflate => libarchive_check_status(
                unsafe { archive_write_add_filter_gzip(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} encode failed while enabling gzip filter"),
            )?,
            NativeCodecKind::Zstd => libarchive_check_status(
                unsafe { archive_write_add_filter_zstd(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} encode failed while enabling zstd filter"),
            )?,
            NativeCodecKind::Lzma2 => libarchive_check_status(
                unsafe { archive_write_add_filter_xz(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} encode failed while enabling xz filter"),
            )?,
            NativeCodecKind::Bzip2 => libarchive_check_status(
                unsafe { archive_write_add_filter_bzip2(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} encode failed while enabling bzip2 filter"),
            )?,
            NativeCodecKind::Store => {
                return Err(RomWeaverError::Validation(
                    "store codec does not use libarchive filters".to_string(),
                ));
            }
        }

        let module = match kind {
            NativeCodecKind::Deflate => "gzip",
            NativeCodecKind::Zstd => "zstd",
            NativeCodecKind::Lzma2 => "xz",
            NativeCodecKind::Bzip2 => "bzip2",
            NativeCodecKind::Store => "",
        };
        if !module.is_empty() {
            libarchive_set_filter_option(
                archive_ptr,
                codec_name,
                module,
                "compression-level",
                &level.to_string(),
            )?;
        }
        if let Some(threads) = thread_count {
            libarchive_try_set_filter_option(
                archive_ptr,
                codec_name,
                module,
                "threads",
                &threads.to_string(),
            )?;
        }

        libarchive_check_status(
            unsafe { archive_write_open_filename(archive_ptr, output_path.as_ptr()) },
            archive_ptr,
            &format!(
                "{codec_name} encode failed while opening output `{}`",
                output.display()
            ),
        )?;
        Ok(())
    })();

    if let Err(error) = setup_result {
        let _ = unsafe { archive_write_free(archive_ptr) };
        return Err(error);
    }

    Ok(archive_ptr)
}

fn libarchive_open_read_archive(
    codec_name: &str,
    kind: NativeCodecKind,
    input: &Path,
) -> Result<*mut archive> {
    let archive_ptr = unsafe { archive_read_new() };
    if archive_ptr.is_null() {
        return Err(RomWeaverError::Validation(format!(
            "{codec_name} decode failed: libarchive reader allocation returned null"
        )));
    }

    let input_path = path_to_cstring(input, "codec input")?;
    let setup_result = (|| -> Result<()> {
        libarchive_check_status(
            unsafe { archive_read_support_format_raw(archive_ptr) },
            archive_ptr,
            &format!("{codec_name} decode failed while enabling raw format"),
        )?;

        match kind {
            NativeCodecKind::Deflate => libarchive_check_status(
                unsafe { archive_read_support_filter_gzip(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} decode failed while enabling gzip filter"),
            )?,
            NativeCodecKind::Zstd => libarchive_check_status(
                unsafe { archive_read_support_filter_zstd(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} decode failed while enabling zstd filter"),
            )?,
            NativeCodecKind::Lzma2 => libarchive_check_status(
                unsafe { archive_read_support_filter_xz(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} decode failed while enabling xz filter"),
            )?,
            NativeCodecKind::Bzip2 => libarchive_check_status(
                unsafe { archive_read_support_filter_bzip2(archive_ptr) },
                archive_ptr,
                &format!("{codec_name} decode failed while enabling bzip2 filter"),
            )?,
            NativeCodecKind::Store => {
                return Err(RomWeaverError::Validation(
                    "store codec does not use libarchive filters".to_string(),
                ));
            }
        }

        libarchive_check_status(
            unsafe {
                archive_read_open_filename(
                    archive_ptr,
                    input_path.as_ptr(),
                    NativeCodecBackend::LIBARCHIVE_OPEN_BLOCK_BYTES,
                )
            },
            archive_ptr,
            &format!(
                "{codec_name} decode failed while opening input `{}`",
                input.display()
            ),
        )?;
        Ok(())
    })();

    if let Err(error) = setup_result {
        let _ = unsafe { archive_read_free(archive_ptr) };
        return Err(error);
    }

    Ok(archive_ptr)
}

fn libarchive_set_filter_option(
    archive_ptr: *mut archive,
    codec_name: &str,
    module: &str,
    option: &str,
    value: &str,
) -> Result<()> {
    let module_cstr = CString::new(module).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: filter module contained interior NUL"
        ))
    })?;
    let option_cstr = CString::new(option).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: filter option contained interior NUL"
        ))
    })?;
    let value_cstr = CString::new(value).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: filter option value contained interior NUL"
        ))
    })?;

    libarchive_check_status(
        unsafe {
            archive_write_set_filter_option(
                archive_ptr,
                module_cstr.as_ptr(),
                option_cstr.as_ptr(),
                value_cstr.as_ptr(),
            )
        },
        archive_ptr,
        &format!("{codec_name} encode failed while setting {module}:{option}={value}"),
    )
}

fn libarchive_try_set_filter_option(
    archive_ptr: *mut archive,
    codec_name: &str,
    module: &str,
    option: &str,
    value: &str,
) -> Result<()> {
    let module_cstr = CString::new(module).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: filter module contained interior NUL"
        ))
    })?;
    let option_cstr = CString::new(option).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: filter option contained interior NUL"
        ))
    })?;
    let value_cstr = CString::new(value).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: filter option value contained interior NUL"
        ))
    })?;

    let status = unsafe {
        archive_write_set_filter_option(
            archive_ptr,
            module_cstr.as_ptr(),
            option_cstr.as_ptr(),
            value_cstr.as_ptr(),
        )
    };
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ if libarchive_unsupported_option_error(archive_ptr) => Ok(()),
        _ => Err(libarchive_error(
            archive_ptr,
            &format!("{codec_name} encode failed while setting {module}:{option}={value}"),
        )),
    }
}

fn libarchive_write_raw_entry_from_reader<R: Read>(
    archive_ptr: *mut archive,
    codec_name: &str,
    entry_name: &str,
    input_len: u64,
    source: &mut R,
    buffer_bytes: usize,
) -> Result<()> {
    const AE_IFREG_MODE: c_uint = 0o100000;
    let entry_ptr = unsafe { archive_entry_new() };
    if entry_ptr.is_null() {
        return Err(RomWeaverError::Validation(format!(
            "{codec_name} encode failed: libarchive entry allocation returned null"
        )));
    }

    let entry_name_cstr = CString::new(entry_name).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: archive entry name contained interior NUL"
        ))
    })?;
    let size = i64::try_from(input_len).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{codec_name} encode failed: input length exceeded libarchive entry size range"
        ))
    })?;

    let write_result = (|| -> Result<()> {
        unsafe {
            archive_entry_set_pathname(entry_ptr, entry_name_cstr.as_ptr());
            archive_entry_set_filetype(entry_ptr, AE_IFREG_MODE);
            archive_entry_set_perm(entry_ptr, 0o644);
            archive_entry_set_size(entry_ptr, size);
        }

        libarchive_check_status(
            unsafe { archive_write_header(archive_ptr, entry_ptr) },
            archive_ptr,
            &format!("{codec_name} encode failed while writing raw entry header"),
        )?;

        let mut buffer = vec![0u8; buffer_bytes];
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            libarchive_write_payload(archive_ptr, codec_name, &buffer[..read])?;
        }

        libarchive_check_status(
            unsafe { archive_write_finish_entry(archive_ptr) },
            archive_ptr,
            &format!("{codec_name} encode failed while finalizing entry"),
        )?;
        Ok(())
    })();

    unsafe { archive_entry_free(entry_ptr) };
    write_result
}

fn libarchive_write_payload(
    archive_ptr: *mut archive,
    codec_name: &str,
    payload: &[u8],
) -> Result<()> {
    let mut offset = 0usize;
    while offset < payload.len() {
        let written = unsafe {
            archive_write_data(
                archive_ptr,
                payload[offset..].as_ptr().cast(),
                payload.len() - offset,
            )
        };
        if written < 0 {
            return Err(libarchive_error(
                archive_ptr,
                &format!("{codec_name} encode failed while writing payload data"),
            ));
        }
        if written == 0 {
            // libarchive can report zero on success in some code paths.
            offset = payload.len();
            continue;
        }
        let advanced = usize::try_from(written).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{codec_name} encode failed: libarchive reported an invalid write length"
            ))
        })?;
        if advanced > payload.len() - offset {
            return Err(RomWeaverError::Validation(format!(
                "{codec_name} encode failed: libarchive reported a write length larger than the buffered payload"
            )));
        }
        offset = offset.saturating_add(advanced);
    }
    Ok(())
}

fn libarchive_read_entry_to_writer<W: Write>(
    archive_ptr: *mut archive,
    codec_name: &str,
    output: &mut W,
    buffer_bytes: usize,
) -> Result<u64> {
    let mut copied = 0u64;
    let mut buffer = vec![0u8; buffer_bytes];
    loop {
        let read =
            unsafe { archive_read_data(archive_ptr, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read > 0 {
            let bytes = usize::try_from(read).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "{codec_name} decode failed: libarchive returned an invalid read length"
                ))
            })?;
            output.write_all(&buffer[..bytes])?;
            copied = copied.saturating_add(bytes as u64);
            continue;
        }
        if read == 0 {
            break;
        }
        return Err(libarchive_error(
            archive_ptr,
            &format!("{codec_name} decode failed while reading payload data"),
        ));
    }
    Ok(copied)
}

fn libarchive_close_write_archive(archive_ptr: *mut archive, codec_name: &str) -> Result<()> {
    let close_result = libarchive_check_status(
        unsafe { archive_write_close(archive_ptr) },
        archive_ptr,
        &format!("{codec_name} encode failed while closing writer"),
    );
    let free_result = libarchive_check_status(
        unsafe { archive_write_free(archive_ptr) },
        archive_ptr,
        &format!("{codec_name} encode failed while freeing writer"),
    );
    close_result.and(free_result)
}

fn libarchive_close_read_archive(archive_ptr: *mut archive, codec_name: &str) -> Result<()> {
    let close_result = libarchive_check_status(
        unsafe { archive_read_close(archive_ptr) },
        archive_ptr,
        &format!("{codec_name} decode failed while closing reader"),
    );
    let free_result = libarchive_check_status(
        unsafe { archive_read_free(archive_ptr) },
        archive_ptr,
        &format!("{codec_name} decode failed while freeing reader"),
    );
    close_result.and(free_result)
}

fn libarchive_check_status(status: i32, archive_ptr: *mut archive, context: &str) -> Result<()> {
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ => Err(libarchive_error(archive_ptr, context)),
    }
}

fn libarchive_error(archive_ptr: *mut archive, context: &str) -> RomWeaverError {
    unsafe {
        let error_ptr = archive_error_string(archive_ptr);
        if !error_ptr.is_null() {
            let message = CStr::from_ptr(error_ptr).to_string_lossy().into_owned();
            return RomWeaverError::Validation(format!("{context}: {message}"));
        }
        let error_number = archive_errno(archive_ptr);
        let message = if error_number != 0 {
            io::Error::from_raw_os_error(error_number).to_string()
        } else {
            "unknown libarchive failure".to_string()
        };
        RomWeaverError::Validation(format!("{context}: {message}"))
    }
}

fn libarchive_unsupported_option_error(archive_ptr: *mut archive) -> bool {
    unsafe {
        let error_ptr = archive_error_string(archive_ptr);
        if error_ptr.is_null() {
            return false;
        }
        let message = CStr::from_ptr(error_ptr)
            .to_string_lossy()
            .to_ascii_lowercase();
        message.contains("undefined option") || message.contains("unknown module name")
    }
}

fn path_to_cstring(path: &Path, label: &str) -> Result<CString> {
    let path_text = path.to_str().ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "{label} path is not valid UTF-8: `{}`",
            path.display()
        ))
    })?;
    CString::new(path_text).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{label} path contains an interior NUL byte: `{}`",
            path.display()
        ))
    })
}
