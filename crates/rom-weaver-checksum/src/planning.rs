fn resolve_algorithms(values: &[String]) -> Result<Vec<Algorithm>> {
    let mut algorithms = Vec::new();
    let mut seen = BTreeSet::new();
    for value in values {
        let algorithm = Algorithm::parse(value).ok_or_else(|| {
            RomWeaverError::Validation(format!("unsupported checksum algorithm `{value}`"))
        })?;
        if seen.insert(algorithm) {
            algorithms.push(algorithm);
        }
    }
    Ok(algorithms)
}

fn compute_checksum_values(
    request: &ChecksumRequest,
    context: &OperationContext,
) -> Result<ChecksumValues> {
    let mut noop_progress = |_progress: ChecksumProgress| {};
    compute_checksum_values_with_progress(request, context, &mut noop_progress)
}

fn compute_checksum_values_with_progress<F>(
    request: &ChecksumRequest,
    context: &OperationContext,
    on_progress: &mut F,
) -> Result<ChecksumValues>
where
    F: FnMut(ChecksumProgress),
{
    trace!(
        source = %request.source.display(),
        algorithms = ?request.algorithms,
        start = ?request.start,
        length = ?request.length,
        "computing checksum values"
    );
    let algorithms = resolve_algorithms(&request.algorithms)?;
    let range = ResolvedRange::from_request(&request.source, request.start, request.length)?;
    let fingerprint = SourceFingerprint::from_path(&request.source)?;
    let cache = ChecksumCache::new(context.temp_root());

    let mut cached_results = cache.load(&fingerprint, &range).unwrap_or_default();
    let missing_algorithms = algorithms
        .iter()
        .copied()
        .filter(|algorithm| !cached_results.contains_key(algorithm.name()))
        .collect::<Vec<_>>();

    let cached_count = algorithms.len().saturating_sub(missing_algorithms.len());
    trace!(
    source = %request.source.display(),
    total_algorithms = algorithms.len(),
    missing_algorithms = missing_algorithms.len(),
    cached_algorithms = cached_count,
    "resolved checksum cache coverage"
    );
    let execution = if missing_algorithms.is_empty() {
        trace!(source = %request.source.display(), "checksum cache hit for all algorithms");
        cache_hit_execution(context.thread_budget())
    } else {
        let plan = plan_checksum(&missing_algorithms, &range);
        trace!(
            source = %request.source.display(),
            mode = ?plan.mode,
            capability = ?plan.capability,
            "selected checksum execution plan"
        );
        let (execution, computed) = execute_plan(
            &request.source,
            &range,
            &missing_algorithms,
            context,
            &plan,
            on_progress,
        )?;
        cached_results.extend(computed);
        let _ = cache.store(&fingerprint, &range, &cached_results);
        execution
    };

    Ok(ChecksumValues {
        execution,
        cached_count,
        values: cached_results,
    })
}

fn plan_checksum(algorithms: &[Algorithm], range: &ResolvedRange) -> ChecksumPlan {
    if algorithms == [Algorithm::Crc32] && range.len >= CRC32_PARALLEL_THRESHOLD {
        let max_threads = parallel_crc32_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelCrc32, max_threads);
        }
    }

    if algorithms == [Algorithm::Crc32c] && range.len >= CRC32C_PARALLEL_THRESHOLD {
        let max_threads = parallel_crc32c_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelCrc32c, max_threads);
        }
    }

    if algorithms == [Algorithm::Crc16] && range.len >= CRC16_PARALLEL_THRESHOLD {
        let max_threads = parallel_crc16_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelCrc16, max_threads);
        }
    }

    if algorithms == [Algorithm::Adler32] && range.len >= ADLER32_PARALLEL_THRESHOLD {
        let max_threads = parallel_adler32_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelAdler32, max_threads);
        }
    }

    if algorithms == [Algorithm::Blake3] && range.len >= BLAKE3_PARALLEL_THRESHOLD {
        let max_threads = parallel_blake3_max_threads(range.len);
        if max_threads > 1 {
            return ChecksumPlan::parallel(ChecksumMode::ParallelBlake3, max_threads);
        }
    }

    if algorithms.len() > 1 && range.len >= FANOUT_PARALLEL_THRESHOLD {
        return ChecksumPlan::parallel(ChecksumMode::ParallelFanout, algorithms.len());
    }

    ChecksumPlan::sequential()
}

fn execute_plan(
    source: &Path,
    range: &ResolvedRange,
    algorithms: &[Algorithm],
    context: &OperationContext,
    plan: &ChecksumPlan,
    on_progress: &mut dyn FnMut(ChecksumProgress),
) -> Result<(ThreadExecution, BTreeMap<String, String>)> {
    trace!(
        source = %source.display(),
        start = range.start,
        length = range.len,
        algorithms = ?algorithms,
        mode = ?plan.mode,
        capability = ?plan.capability,
        "executing checksum plan"
    );
    let mapped = map_range(source, range);
    let execution = context.plan_threads(plan.capability.clone());
    let mut progress = ChecksumProgressTracker::new(range.len, on_progress);
    trace!(
        source = %source.display(),
        mapped = mapped.is_some(),
        requested_threads = execution.requested_threads,
        effective_threads = execution.effective_threads,
        used_parallelism = execution.used_parallelism,
        "checksum execution thread plan resolved"
    );
    if !execution.used_parallelism || execution.effective_threads == 1 {
        let computed = compute_sequential(
            mapped.as_ref(),
            source,
            range,
            algorithms,
            &execution,
            context.cancel(),
            &mut progress,
        )?;
        trace!(
            source = %source.display(),
            algorithm_count = computed.len(),
            "checksum plan completed with sequential execution"
        );
        progress.finish();
        return Ok((execution, computed));
    }

    let (_, pool) = context.build_pool(plan.capability.clone())?;
    let computed = match plan.mode {
        ChecksumMode::Sequential => compute_sequential(
            mapped.as_ref(),
            source,
            range,
            algorithms,
            &execution,
            context.cancel(),
            &mut progress,
        )?,
        ChecksumMode::ParallelFanout => compute_parallel_fanout(
            ChecksumSourceRef {
                mapped: mapped.as_ref(),
                source,
                range,
            },
            algorithms,
            &pool,
            &execution,
            context.cancel(),
            &mut progress,
        )?,
        ChecksumMode::ParallelCrc32 => compute_parallel_crc32(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
            &mut progress,
        )?,
        ChecksumMode::ParallelCrc32c => compute_parallel_crc32c(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
            &mut progress,
        )?,
        ChecksumMode::ParallelCrc16 => compute_parallel_crc16(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
            &mut progress,
        )?,
        ChecksumMode::ParallelAdler32 => compute_parallel_adler32(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
            &mut progress,
        )?,
        ChecksumMode::ParallelBlake3 => compute_parallel_blake3(
            mapped.as_ref(),
            source,
            range,
            &pool,
            &execution,
            context.cancel(),
            &mut progress,
        )?,
    };
    trace!(
        source = %source.display(),
        algorithm_count = computed.len(),
        "checksum plan completed with pooled execution"
    );
    progress.finish();

    Ok((execution, computed))
}
