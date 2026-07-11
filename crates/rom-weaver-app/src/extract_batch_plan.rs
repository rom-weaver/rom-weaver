//! Memory-/thread-aware extraction-batch PLANNING, shared by the native batch executor
//! (`extract_batch.rs`) and the `plan-extract-batch` command. It is pure - no threads, no
//! filesystem - so unlike the native executor it compiles and runs in the browser too, which is the
//! point: one Rust policy schedules both. The browser drives the existing multi-worker pool; this
//! tells it how many extractions to run at once and how many threads to give each.

use super::*;
use rom_weaver_core::{
    BatchPlan, ConcurrencyLimits, JobDemand, physical_memory_bytes, plan_batch,
    resolve_memory_ceiling, working_set_estimate,
};

/// Fixed per-extraction overhead (runtime, buffers, staging) and the floor for an unknown input
/// size, so an unsized job stays small and still overlaps others.
pub(crate) const EXTRACT_WORKING_SET_BASE_BYTES: u64 = 16 * 1024 * 1024;
/// A decoded/extracted payload can exceed its compressed input, so budget ~2x the source. Mirrors
/// the browser scheduler's `MULTIPLIER_DECODED`.
pub(crate) const EXTRACT_WORKING_SET_MULTIPLIER: f64 = 2.0;
/// Fraction of the memory budget concurrent jobs may collectively reserve, leaving headroom for the
/// runtime and the per-job overhead the estimate does not capture.
const MEMORY_CEILING_FRACTION: f64 = 0.75;
const MEMORY_CEILING_MIN_BYTES: u64 = 256 * 1024 * 1024;
const MEMORY_CEILING_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Used when no memory budget is supplied and the platform cannot report one.
const MEMORY_CEILING_FALLBACK_BYTES: u64 = 1024 * 1024 * 1024;

/// Plan a concurrent extraction schedule from per-job source sizes, the shared thread budget, a hard
/// concurrency cap, and a total memory budget (`None` falls back to the platform's
/// [`physical_memory_bytes`]). The single source of truth both the native executor and the browser
/// scheduler use, so they group jobs identically.
pub(crate) fn plan_extract_batch(
    job_sizes: &[u64],
    thread_budget: usize,
    max_concurrency: usize,
    total_memory: Option<u64>,
    explicit_ceiling: Option<u64>,
) -> BatchPlan {
    // An explicit ceiling (the browser's own resolved, mobile-capped working-set budget) is used
    // verbatim - the browser owns the device-memory signal the native fraction/clamp cannot see. The
    // native path passes `None` and derives the ceiling from the platform's physical memory.
    let memory_ceiling = explicit_ceiling
        .filter(|&value| value > 0)
        .unwrap_or_else(|| {
            resolve_memory_ceiling(
                total_memory.or_else(physical_memory_bytes),
                MEMORY_CEILING_FRACTION,
                MEMORY_CEILING_MIN_BYTES,
                MEMORY_CEILING_MAX_BYTES,
                MEMORY_CEILING_FALLBACK_BYTES,
            )
        });
    let limits = ConcurrencyLimits {
        max_concurrency: max_concurrency.max(1),
        thread_budget: thread_budget.max(1),
        memory_ceiling,
    };
    let demands: Vec<JobDemand> = job_sizes
        .iter()
        .map(|&size| {
            JobDemand::new(
                working_set_estimate(
                    size,
                    EXTRACT_WORKING_SET_MULTIPLIER,
                    EXTRACT_WORKING_SET_BASE_BYTES,
                ),
                1,
            )
        })
        .collect();
    plan_batch(&demands, &limits)
}

impl CliApp {
    pub(super) fn run_plan_extract_batch(&self, args: PlanExtractBatchCommand) -> AppRunOutcome {
        trace!(
            job_count = args.job_sizes.len(),
            threads = %args.threads,
            max_concurrency = ?args.max_concurrency,
            total_memory_bytes = ?args.total_memory_bytes,
            memory_ceiling_bytes = ?args.memory_ceiling_bytes,
            "starting plan-extract-batch command"
        );
        let context = self.context(args.threads);
        let thread_budget = args.threads.requested_threads().max(1);
        let max_concurrency = args.max_concurrency.unwrap_or(thread_budget);
        let plan = plan_extract_batch(
            &args.job_sizes,
            thread_budget,
            max_concurrency,
            args.total_memory_bytes,
            args.memory_ceiling_bytes,
        );
        let mut report = OperationReport::succeeded(
            OperationFamily::Container,
            Some("plan".to_string()),
            "plan",
            format!(
                "planned {} job(s) into {} concurrent wave(s)",
                args.job_sizes.len(),
                plan.waves.len()
            ),
            Some(100.0),
            context.single_thread_execution(),
        );
        report.details = Some(serde_json::json!({ "extract_batch_plan": plan }));
        self.finish("plan-extract-batch", report)
    }
}

#[cfg(test)]
mod tests {
    use super::plan_extract_batch;

    const MB: u64 = 1024 * 1024;

    #[test]
    fn explicit_ceiling_is_used_verbatim_and_gates_overlap() {
        // working_set_estimate(100 MiB, 2.0x, 16 MiB base) = 216 MiB per job.
        let jobs = [100 * MB, 100 * MB];
        // A tight explicit ceiling (the browser's own, e.g. mobile-capped) holds only one job's
        // working set, so the two jobs split across waves instead of overlapping.
        let tight = plan_extract_batch(&jobs, 8, 8, None, Some(300 * MB));
        assert_eq!(tight.waves.len(), 2);
        // A roomy explicit ceiling lets both share a wave and split the 8-thread budget 4/4. The
        // explicit value is used verbatim (no fraction/clamp), so 500 MiB > 432 MiB combined admits both.
        let roomy = plan_extract_batch(&jobs, 8, 8, None, Some(500 * MB));
        assert_eq!(roomy.waves.len(), 1);
        assert_eq!(roomy.waves[0].jobs, vec![0, 1]);
        assert_eq!(roomy.waves[0].threads_per_job, 4);
    }
}
