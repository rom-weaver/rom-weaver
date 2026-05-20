impl NativeCodecBackend {
    const XZ_MT_BLOCK_BYTES: u64 = 1 << 20;
    const STORE_COPY_MIN_PARALLEL_BYTES: usize = 1 << 20;
    const DEFLATE_PARALLEL_MIN_BYTES: usize = 256 * 1024;
    const DEFLATE_PARALLEL_MIN_CHUNK_BYTES: usize = 128 * 1024;
    const DEFLATE_PARALLEL_TARGET_CHUNKS_PER_THREAD: usize = 4;
    const BZIP2_PARALLEL_MIN_BYTES: usize = 1 << 20;
    const BZIP2_PARALLEL_MIN_CHUNK_BYTES: usize = 900 * 1024;
    const BZIP2_PARALLEL_TARGET_CHUNKS_PER_THREAD: usize = 2;
    const ZSTD_PARALLEL_MIN_BYTES: usize = 1 << 20;
    const ZSTD_PARALLEL_MIN_CHUNK_BYTES: usize = 256 * 1024;
    const ZSTD_PARALLEL_TARGET_CHUNKS_PER_THREAD: usize = 2;

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

    fn xz_thread_count(effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn xz_mt_options(level: u32) -> Result<XzOptions> {
        let mut options = XzOptions::with_preset(level);
        let block_size = NonZeroU64::new(Self::XZ_MT_BLOCK_BYTES).ok_or_else(|| {
            RomWeaverError::Validation("lzma2 internal block size must be non-zero".into())
        })?;
        options.set_block_size(Some(block_size));
        Ok(options)
    }

    fn store_copy_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        total_len.div_ceil(threads).max(1)
    }

    fn deflate_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        let chunk_budget = threads
            .saturating_mul(Self::DEFLATE_PARALLEL_TARGET_CHUNKS_PER_THREAD)
            .max(1);
        total_len
            .div_ceil(chunk_budget)
            .max(Self::DEFLATE_PARALLEL_MIN_CHUNK_BYTES)
    }

    fn bzip2_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        let chunk_budget = threads
            .saturating_mul(Self::BZIP2_PARALLEL_TARGET_CHUNKS_PER_THREAD)
            .max(1);
        total_len
            .div_ceil(chunk_budget)
            .max(Self::BZIP2_PARALLEL_MIN_CHUNK_BYTES)
    }

    fn zstd_chunk_len(total_len: usize, effective_threads: usize) -> usize {
        let threads = effective_threads.max(1);
        let chunk_budget = threads
            .saturating_mul(Self::ZSTD_PARALLEL_TARGET_CHUNKS_PER_THREAD)
            .max(1);
        total_len
            .div_ceil(chunk_budget)
            .max(Self::ZSTD_PARALLEL_MIN_CHUNK_BYTES)
    }

    fn encode_deflate_parallel(
        &self,
        request: &CodecOperationRequest,
        level: u32,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "deflate payload is empty; using single-threaded encoder".to_string(),
            );
            return Ok(None);
        }
        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("deflate payload exceeded addressable memory".into())
        })?;
        if input_len < Self::DEFLATE_PARALLEL_MIN_BYTES {
            execution.apply_pool_fallback(format!(
                "deflate payload too small for threaded encode ({input_len} bytes)"
            ));
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let chunk_len = Self::deflate_chunk_len(input_len, execution.effective_threads);

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let members = pool.install(|| {
                    input_bytes
                        .par_chunks(chunk_len)
                        .map(|chunk| -> Result<Vec<u8>> {
                            let mut encoder =
                                GzEncoder::new(Vec::new(), DeflateCompression::new(level));
                            encoder.write_all(chunk)?;
                            encoder.finish().map_err(Into::into)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;
                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                for member in members {
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(input_len_u64))
            }
            Err(error) => {
                execution.apply_pool_fallback(format!(
                    "deflate codec thread pool build failed: {error}"
                ));
                Ok(None)
            }
        }
    }

    fn encode_bzip2_parallel(
        &self,
        request: &CodecOperationRequest,
        level: u32,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "bzip2 payload is empty; using single-threaded encoder".to_string(),
            );
            return Ok(None);
        }
        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("bzip2 payload exceeded addressable memory".into())
        })?;
        if input_len < Self::BZIP2_PARALLEL_MIN_BYTES {
            execution.apply_pool_fallback(format!(
                "bzip2 payload too small for threaded encode ({input_len} bytes)"
            ));
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let chunk_len = Self::bzip2_chunk_len(input_len, execution.effective_threads);

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let members = pool.install(|| {
                    input_bytes
                        .par_chunks(chunk_len)
                        .map(|chunk| -> Result<Vec<u8>> {
                            let mut encoder =
                                BzEncoder::new(Vec::new(), Bzip2Compression::new(level));
                            encoder.write_all(chunk)?;
                            encoder.finish().map_err(Into::into)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;
                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                for member in members {
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(input_len_u64))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("bzip2 codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn buffered_cursor_consumed(reader: BufReader<Cursor<&[u8]>>, codec: &str) -> Result<usize> {
        let cursor_position_u64 = reader.get_ref().position();
        let cursor_position = usize::try_from(cursor_position_u64).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{codec} decoder consumed beyond addressable input size"
            ))
        })?;
        let buffered_unread = reader.buffer().len();
        cursor_position.checked_sub(buffered_unread).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{codec} decoder reported invalid buffered consumption state"
            ))
        })
    }

    fn scan_deflate_member_ranges(payload: &[u8]) -> Result<Vec<(usize, usize)>> {
        let mut ranges = Vec::new();
        let mut offset = 0usize;
        while offset < payload.len() {
            let slice = &payload[offset..];
            let mut decoder = BufReadGzDecoder::new(BufReader::new(Cursor::new(slice)));
            let mut sink = io::sink();
            io::copy(&mut decoder, &mut sink)?;
            let reader = decoder.into_inner();
            let consumed = Self::buffered_cursor_consumed(reader, "deflate")?;
            if consumed == 0 {
                return Err(RomWeaverError::Validation(
                    "deflate decoder did not consume input while scanning members".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(consumed);
            if next_offset > payload.len() {
                return Err(RomWeaverError::Validation(
                    "deflate member scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn scan_bzip2_member_ranges(payload: &[u8]) -> Result<Vec<(usize, usize)>> {
        let mut ranges = Vec::new();
        let mut offset = 0usize;
        while offset < payload.len() {
            let slice = &payload[offset..];
            let mut decoder = BufReadBzDecoder::new(BufReader::new(Cursor::new(slice)));
            let mut sink = io::sink();
            io::copy(&mut decoder, &mut sink)?;
            let reader = decoder.into_inner();
            let consumed = Self::buffered_cursor_consumed(reader, "bzip2")?;
            if consumed == 0 {
                return Err(RomWeaverError::Validation(
                    "bzip2 decoder did not consume input while scanning members".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(consumed);
            if next_offset > payload.len() {
                return Err(RomWeaverError::Validation(
                    "bzip2 member scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn scan_zstd_frame_ranges(payload: &[u8]) -> Result<Vec<(usize, usize)>> {
        let mut ranges = Vec::new();
        let mut offset = 0usize;
        while offset < payload.len() {
            let frame_size = zstd::zstd_safe::find_frame_compressed_size(&payload[offset..])
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "zstd frame scan failed at byte {offset}: {error}"
                    ))
                })?;
            if frame_size == 0 {
                return Err(RomWeaverError::Validation(
                    "zstd frame scanner returned a zero-sized frame".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(frame_size);
            if next_offset > payload.len() {
                return Err(RomWeaverError::Validation(
                    "zstd frame scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn encode_zstd_parallel(
        &self,
        request: &CodecOperationRequest,
        level: i32,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "zstd payload is empty; using single-threaded encoder".to_string(),
            );
            return Ok(None);
        }
        let input_len = usize::try_from(input_len_u64).map_err(|_| {
            RomWeaverError::Validation("zstd payload exceeded addressable memory".into())
        })?;
        if input_len < Self::ZSTD_PARALLEL_MIN_BYTES {
            execution.apply_pool_fallback(format!(
                "zstd payload too small for threaded encode ({input_len} bytes)"
            ));
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let chunk_len = Self::zstd_chunk_len(input_len, execution.effective_threads);

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let frames = pool.install(|| {
                    input_bytes
                        .par_chunks(chunk_len)
                        .map(|chunk| zstd::bulk::compress(chunk, level).map_err(Into::into))
                        .collect::<Result<Vec<_>>>()
                })?;
                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                for frame in frames {
                    output.write_all(&frame)?;
                }
                output.flush()?;
                Ok(Some(input_len_u64))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("zstd codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn decode_deflate_parallel(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "deflate payload is empty; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let ranges = Self::scan_deflate_member_ranges(input_bytes)?;
        if ranges.len() <= 1 {
            execution.apply_pool_fallback(format!(
                "deflate stream has {} member(s); using single-threaded decoder",
                ranges.len()
            ));
            return Ok(None);
        }

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let decoded_members = pool.install(|| {
                    ranges
                        .par_iter()
                        .map(|(start, end)| -> Result<Vec<u8>> {
                            let member_slice = &input_bytes[*start..*end];
                            let mut decoder =
                                MultiGzDecoder::new(BufReader::new(Cursor::new(member_slice)));
                            let mut decoded = Vec::new();
                            io::copy(&mut decoder, &mut decoded)?;
                            Ok(decoded)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;

                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                let mut total_written = 0u64;
                for member in decoded_members {
                    total_written = total_written.saturating_add(member.len() as u64);
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(total_written))
            }
            Err(error) => {
                execution.apply_pool_fallback(format!(
                    "deflate codec thread pool build failed: {error}"
                ));
                Ok(None)
            }
        }
    }

    fn decode_bzip2_parallel(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "bzip2 payload is empty; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let ranges = Self::scan_bzip2_member_ranges(input_bytes)?;
        if ranges.len() <= 1 {
            execution.apply_pool_fallback(format!(
                "bzip2 stream has {} member(s); using single-threaded decoder",
                ranges.len()
            ));
            return Ok(None);
        }

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let decoded_members = pool.install(|| {
                    ranges
                        .par_iter()
                        .map(|(start, end)| -> Result<Vec<u8>> {
                            let member_slice = &input_bytes[*start..*end];
                            let mut decoder =
                                MultiBzDecoder::new(BufReader::new(Cursor::new(member_slice)));
                            let mut decoded = Vec::new();
                            io::copy(&mut decoder, &mut decoded)?;
                            Ok(decoded)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;

                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                let mut total_written = 0u64;
                for member in decoded_members {
                    total_written = total_written.saturating_add(member.len() as u64);
                    output.write_all(&member)?;
                }
                output.flush()?;
                Ok(Some(total_written))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("bzip2 codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn decode_zstd_parallel(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<Option<u64>> {
        if !execution.used_parallelism {
            return Ok(None);
        }

        let input_len_u64 = fs::metadata(&request.input)?.len();
        if input_len_u64 == 0 {
            execution.apply_pool_fallback(
                "zstd payload is empty; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }

        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes: &[u8] = input_bytes.as_ref();
        let ranges = Self::scan_zstd_frame_ranges(input_bytes)?;
        if ranges.len() <= 1 {
            execution.apply_pool_fallback(format!(
                "zstd stream has {} frame(s); using single-threaded decoder",
                ranges.len()
            ));
            return Ok(None);
        }

        match rayon::ThreadPoolBuilder::new()
            .num_threads(execution.effective_threads.max(1))
            .build()
        {
            Ok(pool) => {
                let decoded_frames = pool.install(|| {
                    ranges
                        .par_iter()
                        .map(|(start, end)| -> Result<Vec<u8>> {
                            let frame_slice = &input_bytes[*start..*end];
                            let mut decoder =
                                ZstdDecoder::new(BufReader::new(Cursor::new(frame_slice)))?
                                    .single_frame();
                            let mut decoded = Vec::new();
                            io::copy(&mut decoder, &mut decoded)?;
                            Ok(decoded)
                        })
                        .collect::<Result<Vec<_>>>()
                })?;

                let mut output =
                    BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                let mut total_written = 0u64;
                for frame in decoded_frames {
                    total_written = total_written.saturating_add(frame.len() as u64);
                    output.write_all(&frame)?;
                }
                output.flush()?;
                Ok(Some(total_written))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("zstd codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn copy_store_payload(
        &self,
        request: &CodecOperationRequest,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let input_bytes = map_file_read_only(&request.input)?;
        let input_bytes = input_bytes.as_ref();
        let input_len = input_bytes.len();
        if input_len == 0 {
            fs::write(&request.output, [])?;
            return Ok(0);
        }

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
                        let mut output_bytes = vec![0u8; input_len];
                        let chunk_len =
                            Self::store_copy_chunk_len(input_len, execution.effective_threads);
                        pool.install(|| {
                            output_bytes.par_chunks_mut(chunk_len).enumerate().for_each(
                                |(chunk_index, chunk)| {
                                    let start = chunk_index.saturating_mul(chunk_len);
                                    let end = start + chunk.len();
                                    chunk.copy_from_slice(&input_bytes[start..end]);
                                },
                            );
                        });
                        fs::write(&request.output, output_bytes)?;
                        return Ok(input_len as u64);
                    }
                    Err(error) => execution.apply_pool_fallback(format!(
                        "store codec thread pool build failed: {error}"
                    )),
                }
            }
        }

        fs::write(&request.output, input_bytes)?;
        Ok(input_len as u64)
    }

    fn encode_impl(
        &self,
        request: &CodecOperationRequest,
        level: Option<i32>,
        execution: &mut ThreadExecution,
    ) -> Result<u64> {
        let bytes = match self.kind {
            NativeCodecKind::Store => fs::copy(&request.input, &request.output)?,
            NativeCodecKind::Deflate => {
                if let Some(copied) =
                    self.encode_deflate_parallel(request, level.unwrap_or(6) as u32, execution)?
                {
                    copied
                } else {
                    let mut source = BufReader::new(File::open(&request.input)?);
                    let output =
                        BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                    let mut encoder =
                        GzEncoder::new(output, DeflateCompression::new(level.unwrap_or(6) as u32));
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Zstd => {
                if let Some(copied) =
                    self.encode_zstd_parallel(request, level.unwrap_or(3), execution)?
                {
                    copied
                } else {
                    let mut source = BufReader::new(File::open(&request.input)?);
                    let output =
                        BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                    let mut encoder = ZstdEncoder::new(output, level.unwrap_or(3))?;
                    if execution.effective_threads > 1 {
                        match u32::try_from(execution.effective_threads) {
                            Ok(workers) => {
                                if let Err(error) = encoder
                                    .set_parameter(zstd::zstd_safe::CParameter::NbWorkers(workers))
                                {
                                    execution.apply_pool_fallback(format!(
                                        "zstd encoder rejected multithread setting: {error}"
                                    ));
                                }
                            }
                            Err(_) => execution.apply_pool_fallback(
                                "zstd encoder thread count exceeded supported range".to_string(),
                            ),
                        }
                    }
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Lzma2 => {
                let mut source = BufReader::new(File::open(&request.input)?);
                let output = BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                let level = level.unwrap_or(6) as u32;
                if execution.used_parallelism {
                    let mut encoder = XzWriterMt::new(
                        output,
                        Self::xz_mt_options(level)?,
                        Self::xz_thread_count(execution.effective_threads),
                    )?;
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                } else {
                    let mut encoder = XzWriter::new(output, XzOptions::with_preset(level))?;
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Bzip2 => {
                if let Some(copied) =
                    self.encode_bzip2_parallel(request, level.unwrap_or(6) as u32, execution)?
                {
                    copied
                } else {
                    let mut source = BufReader::new(File::open(&request.input)?);
                    let output =
                        BufWriter::new(NonVectoredWriter::new(File::create(&request.output)?));
                    let mut encoder =
                        BzEncoder::new(output, Bzip2Compression::new(level.unwrap_or(6) as u32));
                    let copied = io::copy(&mut source, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    copied
                }
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
            NativeCodecKind::Deflate => {
                if let Some(copied) = self.decode_deflate_parallel(request, execution)? {
                    copied
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = MultiGzDecoder::new(source);
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Zstd => {
                if let Some(copied) = self.decode_zstd_parallel(request, execution)? {
                    copied
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = ZstdDecoder::new(source)?;
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Lzma2 => {
                if execution.used_parallelism {
                    let workers = Self::xz_thread_count(execution.effective_threads);
                    let source = BufReader::new(File::open(&request.input)?);
                    match XzReaderMt::new(source, false, workers) {
                        Ok(mut decoder) => {
                            let mut output = BufWriter::new(File::create(&request.output)?);
                            let copied = io::copy(&mut decoder, &mut output)?;
                            output.flush()?;
                            copied
                        }
                        Err(error) => {
                            execution.apply_pool_fallback(format!(
                                "lzma2 decoder rejected multithread setting: {error}"
                            ));
                            let source = BufReader::new(File::open(&request.input)?);
                            let mut decoder = XzReader::new(source, false);
                            let mut output = BufWriter::new(File::create(&request.output)?);
                            let copied = io::copy(&mut decoder, &mut output)?;
                            output.flush()?;
                            copied
                        }
                    }
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = XzReader::new(source, false);
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
            }
            NativeCodecKind::Bzip2 => {
                if let Some(copied) = self.decode_bzip2_parallel(request, execution)? {
                    copied
                } else {
                    let source = BufReader::new(File::open(&request.input)?);
                    let mut decoder = MultiBzDecoder::new(source);
                    let mut output = BufWriter::new(File::create(&request.output)?);
                    let copied = io::copy(&mut decoder, &mut output)?;
                    output.flush()?;
                    copied
                }
            }
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

