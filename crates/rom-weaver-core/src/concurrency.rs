//! Memory- and thread-aware admission for running independent jobs concurrently.
//!
//! This is the native/wasm-shared analog of the browser runner scheduler (which lives in
//! TypeScript and reasons over separate wasm workers). Here a single process - or a single wasm
//! instance whose main thread plus spawned WASI threads share one linear memory - owns a batch of
//! independent jobs and decides which may run at the same time, gated by three limits:
//!
//! 1. a hard cap on the number of concurrent jobs,
//! 2. a shared worker-thread budget (the sum of admitted jobs' thread demand), and
//! 3. a ceiling on the admitted jobs' combined estimated working set.
//!
//! A lone job is always admitted, even when it alone exceeds a limit, so one oversized job never
//! deadlocks waiting for capacity that will never free; it simply runs by itself.
//!
//! The planner is deliberately pure: it holds no job state and performs no I/O, so it unit-tests
//! cleanly and the same logic drives both a live admit-as-jobs-finish executor (via
//! [`ConcurrencyLimits::can_admit`]) and a static "how would these split" view (via [`plan_waves`]).

use serde::{Deserialize, Serialize};

/// One schedulable job's resource demand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobDemand {
    /// Estimated peak resident working set in bytes. `0` means unknown/negligible - such a job is
    /// treated as free against the memory ceiling so it still overlaps others.
    pub bytes: u64,
    /// Worker threads the job will use once admitted. `0` marks thread-less work (e.g. a metadata
    /// probe) that never counts against the shared thread budget.
    pub threads: usize,
}

impl JobDemand {
    pub fn new(bytes: u64, threads: usize) -> Self {
        Self { bytes, threads }
    }
}

/// Shared limits the planner admits jobs against.
#[derive(Clone, Copy, Debug)]
pub struct ConcurrencyLimits {
    /// Hard cap on jobs running at once. Floored at 1.
    pub max_concurrency: usize,
    /// Total worker-thread budget shared across concurrent jobs. Floored at 1.
    pub thread_budget: usize,
    /// Ceiling on the combined working-set estimate of concurrent jobs. Use [`u64::MAX`] for no
    /// memory gate.
    pub memory_ceiling: u64,
}

impl ConcurrencyLimits {
    /// Whether `candidate` may join the jobs already `in_flight`.
    ///
    /// With nothing in flight the candidate always fits (the lone-job rule). Otherwise all three
    /// gates must hold: the concurrency cap, the summed thread budget, and the summed memory
    /// ceiling. Sums use saturating arithmetic so absurd inputs cannot wrap.
    pub fn can_admit(&self, in_flight: &[JobDemand], candidate: &JobDemand) -> bool {
        if in_flight.is_empty() {
            return true;
        }
        if in_flight.len() >= self.max_concurrency.max(1) {
            return false;
        }
        let used_threads: usize = in_flight.iter().map(|job| job.threads).sum();
        if used_threads.saturating_add(candidate.threads) > self.thread_budget.max(1) {
            return false;
        }
        let used_bytes = in_flight
            .iter()
            .fold(0u64, |sum, job| sum.saturating_add(job.bytes));
        if used_bytes.saturating_add(candidate.bytes) > self.memory_ceiling {
            return false;
        }
        true
    }

    /// Even split of the thread budget across `concurrent` jobs, floored at 1 thread each. A live
    /// executor can hand each admitted job this many threads so the shared pool is not
    /// oversubscribed (the cause of the browser's `EAGAIN`/`os error 6` spawn failures, where N
    /// runners each grabbed the full budget).
    pub fn fair_thread_allotment(&self, concurrent: usize) -> usize {
        (self.thread_budget / concurrent.max(1)).max(1)
    }
}

/// Greedily group jobs - referenced by their original index - into sequential "waves" of
/// concurrently-runnable jobs. First-fit from the front mirrors the runner scheduler's pump: a
/// job that does not fit the current wave is deferred rather than blocking jobs behind it.
///
/// This models a barrier between waves, so it is a *planning/visualisation* aid (and the natural
/// shape for tests); a live executor uses [`ConcurrencyLimits::can_admit`] directly and admits the
/// next queued job the moment an in-flight one frees capacity, with no barrier.
pub fn plan_waves(jobs: &[JobDemand], limits: &ConcurrencyLimits) -> Vec<Vec<usize>> {
    let mut remaining: Vec<usize> = (0..jobs.len()).collect();
    let mut waves: Vec<Vec<usize>> = Vec::new();
    while !remaining.is_empty() {
        let mut wave: Vec<usize> = Vec::new();
        let mut in_flight: Vec<JobDemand> = Vec::new();
        let mut deferred: Vec<usize> = Vec::new();
        for index in remaining {
            if limits.can_admit(&in_flight, &jobs[index]) {
                in_flight.push(jobs[index]);
                wave.push(index);
            } else {
                deferred.push(index);
            }
        }
        waves.push(wave);
        remaining = deferred;
    }
    waves
}

/// Resolve the combined-working-set ceiling from a best-effort total-memory figure.
///
/// `total_memory` is what [`crate::physical_memory_bytes`] reports (host RAM natively, the
/// linear-memory cap on wasm); `None` falls back to `fallback`. The usable ceiling is `fraction`
/// of that total, clamped to `[min, max]`, leaving headroom for the runtime itself and for the
/// per-job overhead the estimates do not capture. Mirrors the browser scheduler's
/// `resolveMemoryCeilingBytes`, but driven by a real memory figure rather than `navigator.deviceMemory`.
pub fn resolve_memory_ceiling(
    total_memory: Option<u64>,
    fraction: f64,
    min: u64,
    max: u64,
    fallback: u64,
) -> u64 {
    let Some(total) = total_memory.filter(|&value| value > 0) else {
        return fallback.clamp(min, max);
    };
    let scaled = (total as f64 * fraction.clamp(0.0, 1.0)) as u64;
    scaled.clamp(min, max)
}

/// Estimate a job's peak resident working set from its input size and a `multiplier` over that
/// size (e.g. ~2× for a decode/extract whose decompressed payload exceeds the compressed input,
/// ~1.5× for a compress). `base` is fixed per-job overhead (runtime, buffers, staging) and is also
/// the floor returned for an unknown (`0`) input size, so unknown jobs stay small and still overlap.
pub fn working_set_estimate(input_bytes: u64, multiplier: f64, base: u64) -> u64 {
    if input_bytes == 0 {
        return base;
    }
    let scaled = (input_bytes as f64 * multiplier.max(0.0)) as u64;
    base.saturating_add(scaled)
}

/// One concurrent group of a [`BatchPlan`]: the original job indices that may run at the same time,
/// and the worker-thread count each of them should use (an even split of the budget for the group,
/// so the group's pools sum to the budget instead of each grabbing all of it).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchWave {
    pub threads_per_job: usize,
    pub jobs: Vec<usize>,
}

/// A serializable concurrent schedule: ordered waves run one after another, the jobs within a wave
/// run together. This is the canonical hand-off the planner produces - the native batch executor
/// runs it directly, and (across the wasm boundary) the browser multi-worker scheduler obeys the
/// same plan, so one Rust policy drives both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchPlan {
    pub waves: Vec<BatchWave>,
}

/// Plan a concurrent schedule for `jobs` under `limits`: group them into waves via the admission
/// gates ([`plan_waves`]), then give each wave an even slice of the thread budget
/// ([`ConcurrencyLimits::fair_thread_allotment`]).
pub fn plan_batch(jobs: &[JobDemand], limits: &ConcurrencyLimits) -> BatchPlan {
    let waves = plan_waves(jobs, limits)
        .into_iter()
        .map(|jobs| BatchWave {
            threads_per_job: limits.fair_thread_allotment(jobs.len()),
            jobs,
        })
        .collect();
    BatchPlan { waves }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1024 * 1024;

    fn limits(
        max_concurrency: usize,
        thread_budget: usize,
        memory_ceiling: u64,
    ) -> ConcurrencyLimits {
        ConcurrencyLimits {
            max_concurrency,
            thread_budget,
            memory_ceiling,
        }
    }

    #[test]
    fn lone_job_always_admitted_even_when_over_every_limit() {
        let limits = limits(2, 4, 100 * MB);
        let huge = JobDemand::new(u64::MAX, 1000);
        assert!(limits.can_admit(&[], &huge));
    }

    #[test]
    fn thread_budget_gate_blocks_oversubscription() {
        let limits = limits(8, 4, u64::MAX);
        let in_flight = [JobDemand::new(0, 3)];
        assert!(limits.can_admit(&in_flight, &JobDemand::new(0, 1))); // 3 + 1 == 4, fits
        assert!(!limits.can_admit(&in_flight, &JobDemand::new(0, 2))); // 3 + 2 > 4, refused
    }

    #[test]
    fn thread_less_jobs_do_not_consume_budget() {
        let limits = limits(8, 1, u64::MAX);
        let in_flight = [JobDemand::new(0, 1)];
        // A second thread-less (probe-like) job still fits even with the budget fully used.
        assert!(limits.can_admit(&in_flight, &JobDemand::new(0, 0)));
    }

    #[test]
    fn memory_ceiling_gate_blocks_combined_overflow() {
        let limits = limits(8, 16, 100 * MB);
        let in_flight = [JobDemand::new(60 * MB, 1)];
        assert!(limits.can_admit(&in_flight, &JobDemand::new(40 * MB, 1))); // 100 == ceiling
        assert!(!limits.can_admit(&in_flight, &JobDemand::new(41 * MB, 1))); // 101 > ceiling
    }

    #[test]
    fn concurrency_cap_is_hard() {
        let limits = limits(2, 64, u64::MAX);
        let in_flight = [JobDemand::new(0, 1), JobDemand::new(0, 1)];
        assert!(!limits.can_admit(&in_flight, &JobDemand::new(0, 1)));
    }

    #[test]
    fn plan_waves_packs_light_jobs_and_isolates_a_heavy_one() {
        // Four 1-thread jobs, budget 4, ceiling 100MB. Three 30MB jobs pack (90MB, 3 threads),
        // then a 200MB job (over ceiling against the others) runs alone in the next wave.
        let limits = limits(8, 4, 100 * MB);
        let jobs = [
            JobDemand::new(30 * MB, 1),
            JobDemand::new(30 * MB, 1),
            JobDemand::new(30 * MB, 1),
            JobDemand::new(200 * MB, 1),
        ];
        let waves = plan_waves(&jobs, &limits);
        assert_eq!(waves, vec![vec![0, 1, 2], vec![3]]);
    }

    #[test]
    fn plan_waves_respects_thread_budget_across_waves() {
        // Two 3-thread jobs cannot share a 4-thread budget: one per wave.
        let limits = limits(8, 4, u64::MAX);
        let jobs = [JobDemand::new(0, 3), JobDemand::new(0, 3)];
        let waves = plan_waves(&jobs, &limits);
        assert_eq!(waves, vec![vec![0], vec![1]]);
    }

    #[test]
    fn fair_thread_allotment_divides_budget() {
        let limits = limits(8, 8, u64::MAX);
        assert_eq!(limits.fair_thread_allotment(1), 8);
        assert_eq!(limits.fair_thread_allotment(2), 4);
        assert_eq!(limits.fair_thread_allotment(3), 2);
        assert_eq!(limits.fair_thread_allotment(16), 1); // floored at 1
    }

    #[test]
    fn resolve_memory_ceiling_clamps_and_falls_back() {
        let half_gib = 512 * MB;
        let two_gib = 2048 * MB;
        // 8 GiB * 0.5 = 4 GiB, clamped to the 2 GiB max.
        assert_eq!(
            resolve_memory_ceiling(Some(8192 * MB), 0.5, half_gib, two_gib, 1536 * MB),
            two_gib
        );
        // Tiny total clamps up to the min.
        assert_eq!(
            resolve_memory_ceiling(Some(256 * MB), 0.5, half_gib, two_gib, 1536 * MB),
            half_gib
        );
        // Unknown total uses the fallback (itself clamped).
        assert_eq!(
            resolve_memory_ceiling(None, 0.5, half_gib, two_gib, 1536 * MB),
            1536 * MB
        );
    }

    #[test]
    fn working_set_estimate_uses_base_for_unknown_and_scales_otherwise() {
        assert_eq!(working_set_estimate(0, 2.0, 16 * MB), 16 * MB);
        assert_eq!(
            working_set_estimate(100 * MB, 2.0, 16 * MB),
            16 * MB + 200 * MB
        );
    }

    #[test]
    fn plan_batch_assigns_even_thread_slices_per_wave() {
        // Budget 6: three 30MB jobs pack into one wave (6/3 = 2 threads each); the 200MB job is over
        // the 100MB ceiling against them, so it runs alone next with the whole budget.
        let limits = limits(8, 6, 100 * MB);
        let jobs = [
            JobDemand::new(30 * MB, 1),
            JobDemand::new(30 * MB, 1),
            JobDemand::new(30 * MB, 1),
            JobDemand::new(200 * MB, 1),
        ];
        let plan = plan_batch(&jobs, &limits);
        assert_eq!(plan.waves.len(), 2);
        assert_eq!(plan.waves[0].jobs, vec![0, 1, 2]);
        assert_eq!(plan.waves[0].threads_per_job, 2);
        assert_eq!(plan.waves[1].jobs, vec![3]);
        assert_eq!(plan.waves[1].threads_per_job, 6);
    }
}
