fn compute_sequential(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_sequential_mapped(mapped.bytes(), algorithms, execution, cancel);
    }

    compute_sequential_stream(source, range, algorithms, execution, cancel)
}

fn compute_sequential_mapped(
    bytes: &[u8],
    algorithms: &[Algorithm],
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = tuned_chunk_size(bytes.len() as u64, execution.effective_threads);
    let mut states = algorithms
        .iter()
        .copied()
        .map(|algorithm| (algorithm, HasherState::new(algorithm)))
        .collect::<Vec<_>>();

    for chunk in bytes.chunks(chunk_size.max(1)) {
        cancel.check()?;
        for (_, state) in &mut states {
            state.update(chunk);
        }
    }

    Ok(states
        .into_iter()
        .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
        .collect())
}

fn compute_sequential_stream(
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let chunk_size = tuned_chunk_size(range.len, execution.effective_threads);
    let mut buffer = vec![0u8; chunk_size];
    let mut states = algorithms
        .iter()
        .copied()
        .map(|algorithm| (algorithm, HasherState::new(algorithm)))
        .collect::<Vec<_>>();

    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range was fully read",
            )));
        }
        let chunk = &buffer[..bytes_read];
        for (_, state) in &mut states {
            state.update(chunk);
        }
        remaining -= bytes_read as u64;
    }

    Ok(states
        .into_iter()
        .map(|(algorithm, state)| (algorithm.name().to_string(), state.finalize()))
        .collect())
}

fn compute_parallel_fanout(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_fanout_mapped(mapped.bytes(), algorithms, pool, execution, cancel);
    }

    compute_parallel_fanout_stream(source, range, algorithms, pool, execution, cancel)
}

fn compute_parallel_fanout_mapped(
    bytes: &[u8],
    algorithms: &[Algorithm],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let worker_count = execution.effective_threads.min(algorithms.len()).max(1);
    let mut workers = partition_algorithms(algorithms, worker_count)
        .into_iter()
        .map(WorkerBatch::new)
        .collect::<Vec<_>>();

    let chunk_size = tuned_chunk_size(bytes.len() as u64, worker_count);
    for chunk in bytes.chunks(chunk_size.max(1)) {
        cancel.check()?;
        pool.install(|| {
            workers
                .par_iter_mut()
                .for_each(|worker| worker.update(chunk));
        });
    }

    let mut results = BTreeMap::new();
    for worker in workers {
        results.extend(worker.into_results());
    }
    Ok(results)
}

fn compute_parallel_fanout_stream(
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let worker_count = execution.effective_threads.min(algorithms.len()).max(1);
    let mut workers = partition_algorithms(algorithms, worker_count)
        .into_iter()
        .map(WorkerBatch::new)
        .collect::<Vec<_>>();

    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let chunk_size = tuned_chunk_size(range.len, worker_count);
    let mut buffer = vec![0u8; chunk_size];

    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        pool.install(|| {
            workers
                .par_iter_mut()
                .for_each(|worker| worker.update(chunk));
        });
        remaining -= bytes_read as u64;
    }

    let mut results = BTreeMap::new();
    for worker in workers {
        results.extend(worker.into_results());
    }
    Ok(results)
}

fn compute_parallel_crc32(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_crc32_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_crc32_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_crc32_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                let mut hasher = Crc32Hasher::new();
                hasher.update(chunk);
                Ok::<_, RomWeaverError>(hasher)
            })
            .collect::<Vec<_>>()
    });

    let combined = combine_crc32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert("crc32".to_string(), format!("{:08x}", combined.finalize()));
    Ok(results)
}

fn compute_parallel_crc32_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];

    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| {
            let mut hasher = Crc32Hasher::new();
            hasher.update(chunk);
            hasher
        });
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }

    let combined = combine_crc32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert("crc32".to_string(), format!("{:08x}", combined.finalize()));
    Ok(results)
}

fn compute_parallel_crc32c(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_crc32c_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_crc32c_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_crc32c_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                Ok::<_, RomWeaverError>((crc32c_append(0, chunk), chunk.len()))
            })
            .collect::<Vec<_>>()
    });
    let combined = combine_crc32c_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc32c.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_crc32c_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];
    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| (crc32c_append(0, chunk), chunk.len()));
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }
    let combined = combine_crc32c_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc32c.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_crc16(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_crc16_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_crc16_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_crc16_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                let mut state = Crc16State::<ARC>::new();
                state.update(chunk);
                Ok::<_, RomWeaverError>((state.get(), chunk.len()))
            })
            .collect::<Vec<_>>()
    });
    let combined = combine_crc16_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc16.name().to_string(),
        format!("{combined:04x}"),
    );
    Ok(results)
}

fn compute_parallel_crc16_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];
    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| {
            let mut state = Crc16State::<ARC>::new();
            state.update(chunk);
            (state.get(), chunk.len())
        });
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }
    let combined = combine_crc16_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Crc16.name().to_string(),
        format!("{combined:04x}"),
    );
    Ok(results)
}

fn compute_parallel_adler32(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    if let Some(mapped) = mapped {
        return compute_parallel_adler32_mapped(mapped.bytes(), pool, execution, cancel);
    }

    compute_parallel_adler32_stream(source, range, pool, execution, cancel)
}

fn compute_parallel_adler32_mapped(
    bytes: &[u8],
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(bytes.len() as u64, execution.effective_threads);
    let partials = pool.install(|| {
        bytes
            .par_chunks(chunk_size as usize)
            .map(|chunk| {
                cancel.check()?;
                Ok::<_, RomWeaverError>((adler32_checksum(chunk), chunk.len()))
            })
            .collect::<Vec<_>>()
    });
    let combined = combine_adler32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Adler32.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_adler32_stream(
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let chunk_size = crc32_parallel_chunk_size(range.len, execution.effective_threads) as usize;
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(range.start))?;

    let mut remaining = range.len;
    let estimated_chunks = range.len.div_ceil(chunk_size as u64) as usize;
    let mut partials = Vec::with_capacity(estimated_chunks);
    let mut buffer = vec![0u8; chunk_size];
    while remaining > 0 {
        cancel.check()?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes_read = file.read(&mut buffer[..limit])?;
        if bytes_read == 0 {
            return Err(RomWeaverError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source ended before checksum range chunk was fully read",
            )));
        }

        let chunk = &buffer[..bytes_read];
        let partial = pool.install(|| (adler32_checksum(chunk), chunk.len()));
        partials.push(Ok(partial));
        remaining -= bytes_read as u64;
    }
    let combined = combine_adler32_partials(partials)?;

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Adler32.name().to_string(),
        format!("{combined:08x}"),
    );
    Ok(results)
}

fn compute_parallel_blake3(
    mapped: Option<&MappedRange>,
    source: &Path,
    range: &ResolvedRange,
    pool: &SharedThreadPool,
    execution: &ThreadExecution,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let mut hasher = Blake3Hasher::new();

    if let Some(mapped) = mapped {
        cancel.check()?;
        pool.install(|| {
            hasher.update_rayon(mapped.bytes());
        });
    } else {
        let mut file = File::open(source)?;
        file.seek(SeekFrom::Start(range.start))?;

        let mut remaining = range.len;
        let chunk_size = tuned_chunk_size(range.len, execution.effective_threads);
        let mut buffer = vec![0u8; chunk_size];
        while remaining > 0 {
            cancel.check()?;
            let limit = remaining.min(buffer.len() as u64) as usize;
            let bytes_read = file.read(&mut buffer[..limit])?;
            if bytes_read == 0 {
                return Err(RomWeaverError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "source ended before checksum range was fully read",
                )));
            }

            let chunk = &buffer[..bytes_read];
            pool.install(|| {
                hasher.update_rayon(chunk);
            });
            remaining -= bytes_read as u64;
        }
    }

    let mut results = BTreeMap::new();
    results.insert(
        Algorithm::Blake3.name().to_string(),
        hasher.finalize().to_hex().to_string(),
    );
    Ok(results)
}

fn combine_crc32_partials(partials: Vec<Result<Crc32Hasher>>) -> Result<Crc32Hasher> {
    let mut partials = partials.into_iter();
    let mut combined = match partials.next() {
        Some(partial) => partial?,
        None => Crc32Hasher::new(),
    };
    for partial in partials {
        combined.combine(&partial?);
    }
    Ok(combined)
}

fn combine_crc32c_partials(partials: Vec<Result<(u32, usize)>>) -> Result<u32> {
    let mut partials = partials.into_iter();
    let (mut combined, _) = match partials.next() {
        Some(partial) => partial?,
        None => (0, 0),
    };
    for partial in partials {
        let (crc, len) = partial?;
        combined = crc32c_combine(combined, crc, len);
    }
    Ok(combined)
}

fn gf2_matrix_times_u16(mat: &[u16; CRC16_GF2_DIM], mut vec: u16) -> u16 {
    let mut sum = 0u16;
    let mut idx = 0usize;
    while vec > 0 {
        if vec & 1 == 1 {
            sum ^= mat[idx];
        }
        vec >>= 1;
        idx += 1;
    }
    sum
}

fn gf2_matrix_square_u16(square: &mut [u16; CRC16_GF2_DIM], mat: &[u16; CRC16_GF2_DIM]) {
    for n in 0..CRC16_GF2_DIM {
        square[n] = gf2_matrix_times_u16(mat, mat[n]);
    }
}

fn crc16_arc_combine(mut crc1: u16, crc2: u16, mut len2: usize) -> u16 {
    let mut row = 1u16;
    let mut even = [0u16; CRC16_GF2_DIM];
    let mut odd = [0u16; CRC16_GF2_DIM];

    if len2 == 0 {
        return crc1;
    }

    odd[0] = CRC16_ARC_REFLECTED_POLY;
    for value in odd.iter_mut().skip(1) {
        *value = row;
        row <<= 1;
    }

    gf2_matrix_square_u16(&mut even, &odd);
    gf2_matrix_square_u16(&mut odd, &even);

    loop {
        gf2_matrix_square_u16(&mut even, &odd);
        if len2 & 1 == 1 {
            crc1 = gf2_matrix_times_u16(&even, crc1);
        }
        len2 >>= 1;
        if len2 == 0 {
            break;
        }

        gf2_matrix_square_u16(&mut odd, &even);
        if len2 & 1 == 1 {
            crc1 = gf2_matrix_times_u16(&odd, crc1);
        }
        len2 >>= 1;
        if len2 == 0 {
            break;
        }
    }

    crc1 ^ crc2
}

fn combine_crc16_partials(partials: Vec<Result<(u16, usize)>>) -> Result<u16> {
    let mut partials = partials.into_iter();
    let (mut combined, _) = match partials.next() {
        Some(partial) => partial?,
        None => (0, 0),
    };
    for partial in partials {
        let (crc, len) = partial?;
        combined = crc16_arc_combine(combined, crc, len);
    }
    Ok(combined)
}

pub fn adler32_checksum(bytes: &[u8]) -> u32 {
    let mut state = Adler32::new();
    state.write_slice(bytes);
    state.checksum()
}

fn adler32_combine(adler1: u32, adler2: u32, len2: usize) -> u32 {
    if len2 == 0 {
        return adler1;
    }

    let a1 = u64::from(adler1 & 0xffff);
    let b1 = u64::from((adler1 >> 16) & 0xffff);
    let a2 = u64::from(adler2 & 0xffff);
    let b2 = u64::from((adler2 >> 16) & 0xffff);

    let a = (a1 + a2 + ADLER32_MODULO - 1) % ADLER32_MODULO;
    let len2_mod = (len2 as u64) % ADLER32_MODULO;
    let a1_minus_one = (a1 + ADLER32_MODULO - 1) % ADLER32_MODULO;
    let b = (b1 + b2 + (len2_mod * a1_minus_one)) % ADLER32_MODULO;

    ((b as u32) << 16) | (a as u32)
}

fn combine_adler32_partials(partials: Vec<Result<(u32, usize)>>) -> Result<u32> {
    let mut partials = partials.into_iter();
    let (mut combined, _) = match partials.next() {
        Some(partial) => partial?,
        None => (1, 0),
    };
    for partial in partials {
        let (crc, len) = partial?;
        combined = adler32_combine(combined, crc, len);
    }
    Ok(combined)
}

fn partition_algorithms(algorithms: &[Algorithm], worker_count: usize) -> Vec<Vec<Algorithm>> {
    let mut groups = vec![Vec::new(); worker_count];
    for (index, algorithm) in algorithms.iter().copied().enumerate() {
        groups[index % worker_count].push(algorithm);
    }
    groups
        .into_iter()
        .filter(|group| !group.is_empty())
        .collect()
}

fn parallel_crc32_max_threads(range_len: u64) -> usize {
    ((range_len / CRC32_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, CRC32_PARALLEL_MAX_THREADS)
}

fn parallel_crc32c_max_threads(range_len: u64) -> usize {
    ((range_len / CRC32C_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, CRC32C_PARALLEL_MAX_THREADS)
}

fn parallel_crc16_max_threads(range_len: u64) -> usize {
    ((range_len / CRC16_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, CRC16_PARALLEL_MAX_THREADS)
}

fn parallel_adler32_max_threads(range_len: u64) -> usize {
    ((range_len / ADLER32_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, ADLER32_PARALLEL_MAX_THREADS)
}

fn parallel_blake3_max_threads(range_len: u64) -> usize {
    ((range_len / BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD) as usize)
        .clamp(1, BLAKE3_PARALLEL_MAX_THREADS)
}

fn crc32_parallel_chunk_size(range_len: u64, worker_count: usize) -> u64 {
    range_len.div_ceil(worker_count.max(1) as u64).max(1)
}

fn map_range(source: &Path, range: &ResolvedRange) -> Option<MappedRange> {
    if range.file_len == 0 || range.len == 0 {
        return None;
    }

    let mut file = File::open(source).ok()?;
    let len = usize::try_from(range.len).ok()?;
    file.seek(SeekFrom::Start(range.start)).ok()?;
    let mut bytes = vec![0u8; len];
    if file.read_exact(&mut bytes).is_err() {
        return None;
    }
    Some(MappedRange { bytes })
}

fn cache_hit_execution(budget: ThreadBudget) -> ThreadExecution {
    ThreadExecution {
        requested_threads: budget.requested_threads(),
        effective_threads: 1,
        thread_mode: budget.mode(),
        used_parallelism: false,
        thread_fallback: false,
        thread_fallback_reason: None,
    }
}

fn tuned_chunk_size(range_len: u64, worker_count: usize) -> usize {
    let worker_count = worker_count.max(1) as u64;
    let suggested = (range_len / (worker_count * TARGET_CHUNKS_PER_WORKER)).max(1);
    suggested.clamp(MIN_CHUNK_SIZE as u64, MAX_CHUNK_SIZE as u64) as usize
}

