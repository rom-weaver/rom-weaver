impl NativeCodecBackend {
    const XZ_MT_BLOCK_BYTES: u64 = 1 << 20;
    const STORE_COPY_MIN_PARALLEL_BYTES: usize = 1 << 20;
    const DEFLATE_PARALLEL_MIN_BYTES: usize = 256 * 1024;
    const BZIP2_PARALLEL_MIN_BYTES: usize = 1 << 20;
    const ZSTD_PARALLEL_MIN_BYTES: usize = 1 << 20;

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

        let policy = Self::io_policy(execution);
        let chunks = Self::file_chunks(&request.input, &policy)?;
        if chunks.len() <= 1 {
            execution.apply_pool_fallback(
                "deflate payload produced a single chunk; using single-threaded encoder"
                    .to_string(),
            );
            return Ok(None);
        }

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
                    let encoded_batch = pool.install(|| {
                        batch_bytes
                            .into_par_iter()
                            .map(|(chunk_index, chunk)| -> Result<(u64, Vec<u8>)> {
                                let mut encoder =
                                    GzEncoder::new(Vec::new(), DeflateCompression::new(level));
                                encoder.write_all(&chunk)?;
                                let member = encoder.finish()?;
                                Ok((chunk_index, member))
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;

                    for (chunk_index, member) in encoded_batch {
                        ordered.write_chunk(chunk_index, member)?;
                    }
                }
                let _ = ordered.finish()?;
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

        let policy = Self::io_policy(execution);
        let chunks = Self::file_chunks(&request.input, &policy)?;
        if chunks.len() <= 1 {
            execution.apply_pool_fallback(
                "bzip2 payload produced a single chunk; using single-threaded encoder"
                    .to_string(),
            );
            return Ok(None);
        }

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
                    let encoded_batch = pool.install(|| {
                        batch_bytes
                            .into_par_iter()
                            .map(|(chunk_index, chunk)| -> Result<(u64, Vec<u8>)> {
                                let mut encoder =
                                    BzEncoder::new(Vec::new(), Bzip2Compression::new(level));
                                encoder.write_all(&chunk)?;
                                let member = encoder.finish()?;
                                Ok((chunk_index, member))
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;

                    for (chunk_index, member) in encoded_batch {
                        ordered.write_chunk(chunk_index, member)?;
                    }
                }
                let _ = ordered.finish()?;
                Ok(Some(input_len_u64))
            }
            Err(error) => {
                execution
                    .apply_pool_fallback(format!("bzip2 codec thread pool build failed: {error}"));
                Ok(None)
            }
        }
    }

    fn scan_deflate_member_ranges(path: &Path) -> Result<Vec<(u64, u64)>> {
        let input_len = fs::metadata(path)?.len();
        let mut ranges = Vec::new();
        let mut offset = 0u64;
        while offset < input_len {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(offset))?;
            let mut decoder = BufReadGzDecoder::new(BufReader::new(file));
            let mut sink = io::sink();
            io::copy(&mut decoder, &mut sink)?;
            let mut reader = decoder.into_inner();
            let consumed_position = reader.stream_position()?;
            let consumed = consumed_position.checked_sub(offset).ok_or_else(|| {
                RomWeaverError::Validation(
                    "deflate decoder reported invalid buffered consumption state".to_string(),
                )
            })?;
            if consumed == 0 {
                return Err(RomWeaverError::Validation(
                    "deflate decoder did not consume input while scanning members".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(consumed);
            if next_offset > input_len {
                return Err(RomWeaverError::Validation(
                    "deflate member scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn scan_bzip2_member_ranges(path: &Path) -> Result<Vec<(u64, u64)>> {
        let input_len = fs::metadata(path)?.len();
        let mut ranges = Vec::new();
        let mut offset = 0u64;
        while offset < input_len {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(offset))?;
            let mut decoder = BufReadBzDecoder::new(BufReader::new(file));
            let mut sink = io::sink();
            io::copy(&mut decoder, &mut sink)?;
            let mut reader = decoder.into_inner();
            let consumed_position = reader.stream_position()?;
            let consumed = consumed_position.checked_sub(offset).ok_or_else(|| {
                RomWeaverError::Validation(
                    "bzip2 decoder reported invalid buffered consumption state".to_string(),
                )
            })?;
            if consumed == 0 {
                return Err(RomWeaverError::Validation(
                    "bzip2 decoder did not consume input while scanning members".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(consumed);
            if next_offset > input_len {
                return Err(RomWeaverError::Validation(
                    "bzip2 member scanner overshot input length".to_string(),
                ));
            }
            ranges.push((offset, next_offset));
            offset = next_offset;
        }
        Ok(ranges)
    }

    fn scan_zstd_frame_ranges(path: &Path) -> Result<Vec<(u64, u64)>> {
        let input_len = fs::metadata(path)?.len();
        let mut ranges = Vec::new();
        let mut offset = 0u64;
        while offset < input_len {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(offset))?;
            let mut decoder = ZstdDecoder::new(BufReader::new(file))?.single_frame();
            let mut sink = io::sink();
            io::copy(&mut decoder, &mut sink)?;
            let mut reader = decoder.finish();
            let consumed_position = reader.stream_position()?;
            let frame_size = consumed_position.checked_sub(offset).ok_or_else(|| {
                RomWeaverError::Validation(
                    "zstd decoder reported invalid buffered consumption state".to_string(),
                )
            })?;
            if frame_size == 0 {
                return Err(RomWeaverError::Validation(
                    "zstd frame scanner returned a zero-sized frame".to_string(),
                ));
            }
            let next_offset = offset.saturating_add(frame_size);
            if next_offset > input_len {
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

        let policy = Self::io_policy(execution);
        let chunks = Self::file_chunks(&request.input, &policy)?;
        if chunks.len() <= 1 {
            execution.apply_pool_fallback(
                "zstd payload produced a single chunk; using single-threaded encoder".to_string(),
            );
            return Ok(None);
        }

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
                    let encoded_batch = pool.install(|| {
                        batch_bytes
                            .into_par_iter()
                            .map(|(chunk_index, chunk)| {
                                zstd::bulk::compress(&chunk, level)
                                    .map(|frame| (chunk_index, frame))
                                    .map_err(Into::into)
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;

                    for (chunk_index, frame) in encoded_batch {
                        ordered.write_chunk(chunk_index, frame)?;
                    }
                }
                let _ = ordered.finish()?;
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

        let ranges = Self::scan_deflate_member_ranges(&request.input)?;
        if ranges.is_empty() {
            execution.apply_pool_fallback(
                "deflate stream scan produced zero members; using single-threaded decoder"
                    .to_string(),
            );
            return Ok(None);
        }

        let policy = Self::io_policy(execution);
        let batch_limit = policy.max_in_flight_items.max(1);

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
                let mut total_written = 0u64;

                for (batch_index, batch) in ranges.chunks(batch_limit).enumerate() {
                    let member_start_index = batch_index.saturating_mul(batch_limit);
                    let mut member_payloads = Vec::with_capacity(batch.len());
                    for (relative_index, (start, end)) in batch.iter().enumerate() {
                        let member_len_u64 = end.saturating_sub(*start);
                        let member_len = usize::try_from(member_len_u64).map_err(|_| {
                            RomWeaverError::Validation(
                                "deflate member length exceeded addressable memory".to_string(),
                            )
                        })?;
                        source.seek(SeekFrom::Start(*start))?;
                        let mut member_payload = vec![0u8; member_len];
                        source.read_exact(&mut member_payload)?;
                        member_payloads
                            .push((member_start_index.saturating_add(relative_index) as u64, member_payload));
                    }

                    let decoded_members = pool.install(|| {
                        member_payloads
                            .into_par_iter()
                            .map(|(member_index, member_payload)| -> Result<(u64, Vec<u8>)> {
                                let mut decoder =
                                    MultiGzDecoder::new(BufReader::new(Cursor::new(member_payload)));
                                let mut decoded = Vec::new();
                                io::copy(&mut decoder, &mut decoded)?;
                                Ok((member_index, decoded))
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;

                    for (member_index, member) in decoded_members {
                        total_written = total_written.saturating_add(member.len() as u64);
                        ordered.write_chunk(member_index, member)?;
                    }
                }
                let _ = ordered.finish()?;
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

        let ranges = Self::scan_bzip2_member_ranges(&request.input)?;
        if ranges.is_empty() {
            execution.apply_pool_fallback(
                "bzip2 stream scan produced zero members; using single-threaded decoder"
                    .to_string(),
            );
            return Ok(None);
        }

        let policy = Self::io_policy(execution);
        let batch_limit = policy.max_in_flight_items.max(1);

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
                let mut total_written = 0u64;

                for (batch_index, batch) in ranges.chunks(batch_limit).enumerate() {
                    let member_start_index = batch_index.saturating_mul(batch_limit);
                    let mut member_payloads = Vec::with_capacity(batch.len());
                    for (relative_index, (start, end)) in batch.iter().enumerate() {
                        let member_len_u64 = end.saturating_sub(*start);
                        let member_len = usize::try_from(member_len_u64).map_err(|_| {
                            RomWeaverError::Validation(
                                "bzip2 member length exceeded addressable memory".to_string(),
                            )
                        })?;
                        source.seek(SeekFrom::Start(*start))?;
                        let mut member_payload = vec![0u8; member_len];
                        source.read_exact(&mut member_payload)?;
                        member_payloads
                            .push((member_start_index.saturating_add(relative_index) as u64, member_payload));
                    }

                    let decoded_members = pool.install(|| {
                        member_payloads
                            .into_par_iter()
                            .map(|(member_index, member_payload)| -> Result<(u64, Vec<u8>)> {
                                let mut decoder =
                                    MultiBzDecoder::new(BufReader::new(Cursor::new(member_payload)));
                                let mut decoded = Vec::new();
                                io::copy(&mut decoder, &mut decoded)?;
                                Ok((member_index, decoded))
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;

                    for (member_index, member) in decoded_members {
                        total_written = total_written.saturating_add(member.len() as u64);
                        ordered.write_chunk(member_index, member)?;
                    }
                }
                let _ = ordered.finish()?;
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

        let ranges = match Self::scan_zstd_frame_ranges(&request.input) {
            Ok(ranges) => ranges,
            Err(error) => {
                execution.apply_pool_fallback(format!(
                    "zstd frame scanner could not split stream ({error}); using single-threaded decoder"
                ));
                return Ok(None);
            }
        };
        if ranges.is_empty() {
            execution.apply_pool_fallback(
                "zstd stream scan produced zero frames; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }
        if ranges.len() == 1 {
            execution.apply_pool_fallback(
                "zstd stream has one frame; using single-threaded decoder".to_string(),
            );
            return Ok(None);
        }

        let policy = Self::io_policy(execution);
        let batch_limit = policy.max_in_flight_items.max(1);

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
                let mut total_written = 0u64;

                for (batch_index, batch) in ranges.chunks(batch_limit).enumerate() {
                    let frame_start_index = batch_index.saturating_mul(batch_limit);
                    let mut frame_payloads = Vec::with_capacity(batch.len());
                    for (relative_index, (start, end)) in batch.iter().enumerate() {
                        let frame_len_u64 = end.saturating_sub(*start);
                        let frame_len = usize::try_from(frame_len_u64).map_err(|_| {
                            RomWeaverError::Validation(
                                "zstd frame length exceeded addressable memory".to_string(),
                            )
                        })?;
                        source.seek(SeekFrom::Start(*start))?;
                        let mut frame_payload = vec![0u8; frame_len];
                        source.read_exact(&mut frame_payload)?;
                        frame_payloads
                            .push((frame_start_index.saturating_add(relative_index) as u64, frame_payload));
                    }

                    let decoded_frames = pool.install(|| {
                        frame_payloads
                            .into_par_iter()
                            .map(|(frame_index, frame_payload)| -> Result<(u64, Vec<u8>)> {
                                let mut decoder =
                                    ZstdDecoder::new(BufReader::new(Cursor::new(frame_payload)))?
                                        .single_frame();
                                let mut decoded = Vec::new();
                                io::copy(&mut decoder, &mut decoded)?;
                                Ok((frame_index, decoded))
                            })
                            .collect::<Result<Vec<_>>>()
                    })?;

                    for (frame_index, frame) in decoded_frames {
                        total_written = total_written.saturating_add(frame.len() as u64);
                        ordered.write_chunk(frame_index, frame)?;
                    }
                }
                let _ = ordered.finish()?;
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
