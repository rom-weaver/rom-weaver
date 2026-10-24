use super::*;
pub(super) fn resolve_algorithms(values: &[String]) -> Result<Vec<Algorithm>> {
    let mut algorithms = Vec::new();
    let mut seen = BTreeSet::new();
    for value in values {
        let algorithm =
            Algorithm::parse(value).ok_or_else(|| unsupported_checksum_algorithm(value))?;
        if seen.insert(algorithm) {
            algorithms.push(algorithm);
        }
    }
    Ok(algorithms)
}

pub(super) fn compute_checksum_values(
    request: &ChecksumRequest,
    context: &OperationContext,
) -> Result<ChecksumValues> {
    let mut noop_progress = |_progress: ChecksumProgress| {};
    compute_checksum_values_with_progress(request, context, &mut noop_progress)
}

pub(super) fn compute_checksum_values_with_progress<F>(
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
    if algorithms.is_empty() {
        return Ok(ChecksumValues {
            execution: context.plan_threads(ThreadCapability::single_threaded()),
            values: BTreeMap::new(),
        });
    }

    let plan = plan_checksum(&algorithms, &range);
    trace!(
        source = %request.source.display(),
        mode = ?plan.mode,
        capability = ?plan.capability,
        "selected checksum execution plan"
    );
    let (execution, values) = execute_plan(
        &request.source,
        &range,
        &algorithms,
        context,
        &plan,
        on_progress,
    )?;

    Ok(ChecksumValues { execution, values })
}

pub(super) fn plan_checksum(algorithms: &[Algorithm], range: &ResolvedRange) -> ChecksumPlan {
    if let [algorithm] = algorithms
        && let Some(entry) = PARALLEL_SINGLE_ALGORITHM_TABLE
            .iter()
            .find(|entry| entry.algorithm == *algorithm)
        && range.len >= entry.threshold
    {
        let max_threads =
            parallel_max_threads(range.len, entry.min_bytes_per_thread, entry.max_threads);
        if max_threads > 1 {
            return ChecksumPlan::parallel(entry.mode, max_threads);
        }
    }

    if algorithms.len() > 1 && range.len >= FANOUT_PARALLEL_THRESHOLD {
        return ChecksumPlan::parallel(ChecksumMode::ParallelFanout, algorithms.len());
    }

    ChecksumPlan::sequential()
}

pub(super) fn execute_plan(
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
