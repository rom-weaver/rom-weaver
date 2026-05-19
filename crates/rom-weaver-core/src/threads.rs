use std::{fmt, str::FromStr, sync::Arc};

use rayon::ThreadPool;
use serde::{Deserialize, Serialize};
use tracing::trace;

use crate::{Result, RomWeaverError};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMode {
    Auto,
    Fixed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadBudget {
    Auto,
    Fixed(usize),
}

impl Default for ThreadBudget {
    fn default() -> Self {
        Self::Auto
    }
}

impl ThreadBudget {
    pub fn mode(self) -> ThreadMode {
        match self {
            Self::Auto => ThreadMode::Auto,
            Self::Fixed(_) => ThreadMode::Fixed,
        }
    }

    pub fn requested_threads(self) -> usize {
        match self {
            Self::Auto => std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(4),
            Self::Fixed(count) => count.max(1),
        }
    }
}

impl fmt::Display for ThreadBudget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Auto => formatter.write_str("auto"),
            Self::Fixed(count) => write!(formatter, "{count}"),
        }
    }
}

impl FromStr for ThreadBudget {
    type Err = RomWeaverError;

    fn from_str(value: &str) -> Result<Self> {
        if value.eq_ignore_ascii_case("auto") {
            return Ok(Self::Auto);
        }

        let parsed = value.parse::<usize>().map_err(|_| {
            RomWeaverError::Validation(format!(
                "invalid thread budget `{value}`; use `auto` or a positive integer"
            ))
        })?;
        if parsed == 0 {
            return Err(RomWeaverError::Validation(
                "thread budget must be greater than zero".into(),
            ));
        }
        Ok(Self::Fixed(parsed))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ThreadCapability {
    SingleThreaded,
    Parallel { max_threads: Option<usize> },
}

impl ThreadCapability {
    pub fn single_threaded() -> Self {
        Self::SingleThreaded
    }

    pub fn parallel(max_threads: Option<usize>) -> Self {
        Self::Parallel { max_threads }
    }

    pub fn negotiate(&self, budget: ThreadBudget) -> ThreadExecution {
        let requested_threads = budget.requested_threads();
        let execution = match self {
            Self::SingleThreaded => ThreadExecution {
                requested_threads,
                effective_threads: 1,
                thread_mode: budget.mode(),
                used_parallelism: false,
                thread_fallback: false,
                thread_fallback_reason: None,
            },
            Self::Parallel { max_threads } => {
                let effective_threads = max_threads
                    .map(|limit| requested_threads.min(limit.max(1)))
                    .unwrap_or(requested_threads)
                    .max(1);
                ThreadExecution {
                    requested_threads,
                    effective_threads,
                    thread_mode: budget.mode(),
                    used_parallelism: effective_threads > 1,
                    thread_fallback: false,
                    thread_fallback_reason: None,
                }
            }
        };
        trace!(
            capability = ?self,
            budget = %budget,
            requested_threads = execution.requested_threads,
            effective_threads = execution.effective_threads,
            thread_mode = ?execution.thread_mode,
            used_parallelism = execution.used_parallelism,
            threads_enabled = execution.used_parallelism,
            "thread execution negotiated"
        );
        if execution.used_parallelism {
            trace!(
                capability = ?self,
                budget = %budget,
                requested_threads = execution.requested_threads,
                effective_threads = execution.effective_threads,
                "parallel threads enabled"
            );
        } else {
            trace!(
                capability = ?self,
                budget = %budget,
                requested_threads = execution.requested_threads,
                effective_threads = execution.effective_threads,
                "parallel threads disabled"
            );
        }
        execution
    }

    pub fn supports_execution(&self, execution: &ThreadExecution) -> bool {
        if execution.requested_threads == 0 || execution.effective_threads == 0 {
            return false;
        }
        if execution.used_parallelism != (execution.effective_threads > 1) {
            return false;
        }
        match self {
            Self::SingleThreaded => execution.effective_threads == 1,
            Self::Parallel { max_threads } => max_threads
                .map(|limit| execution.effective_threads <= limit.max(1))
                .unwrap_or(true),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadExecution {
    pub requested_threads: usize,
    pub effective_threads: usize,
    pub thread_mode: ThreadMode,
    pub used_parallelism: bool,
    pub thread_fallback: bool,
    pub thread_fallback_reason: Option<String>,
}

impl ThreadExecution {
    pub fn apply_pool_fallback(&mut self, reason: impl Into<String>) {
        self.effective_threads = 1;
        self.used_parallelism = false;
        self.thread_fallback = true;
        self.thread_fallback_reason = Some(reason.into());
    }
}

#[derive(Clone)]
pub struct SharedThreadPool {
    size: usize,
    backend: ThreadPoolBackend,
}

#[derive(Clone)]
enum ThreadPoolBackend {
    Rayon(Arc<ThreadPool>),
    Inline,
}

impl SharedThreadPool {
    fn inline(size: usize) -> Self {
        Self {
            size: size.max(1),
            backend: ThreadPoolBackend::Inline,
        }
    }

    pub fn with_size(size: usize) -> Result<Self> {
        let size = size.max(1);
        if let Some(reason) = Self::forced_build_failure_reason(size) {
            return Err(RomWeaverError::ThreadPoolBuild(reason));
        }
        trace!(size, "building shared thread pool");
        let inner = rayon::ThreadPoolBuilder::new()
            .num_threads(size)
            .build()
            .map_err(|error| RomWeaverError::ThreadPoolBuild(error.to_string()))?;
        Ok(Self {
            size,
            backend: ThreadPoolBackend::Rayon(Arc::new(inner)),
        })
    }

    pub fn with_execution(execution: &ThreadExecution) -> Result<Self> {
        trace!(
            requested_threads = execution.requested_threads,
            effective_threads = execution.effective_threads,
            thread_mode = ?execution.thread_mode,
            used_parallelism = execution.used_parallelism,
            "building thread pool from execution plan"
        );
        if !execution.used_parallelism {
            trace!(
                requested_threads = execution.requested_threads,
                effective_threads = execution.effective_threads,
                thread_mode = ?execution.thread_mode,
                "using inline single-thread execution pool"
            );
            return Ok(Self::inline(execution.effective_threads));
        }
        Self::with_size(execution.effective_threads)
    }

    pub fn with_execution_fallback(execution: ThreadExecution) -> Result<(ThreadExecution, Self)> {
        Self::with_execution_fallback_with_builder(execution, Self::with_execution)
    }

    fn with_execution_fallback_with_builder(
        mut execution: ThreadExecution,
        mut builder: impl FnMut(&ThreadExecution) -> Result<Self>,
    ) -> Result<(ThreadExecution, Self)> {
        match builder(&execution) {
            Ok(pool) => Ok((execution, pool)),
            Err(RomWeaverError::ThreadPoolBuild(reason)) if execution.used_parallelism => {
                trace!(
                    requested_threads = execution.requested_threads,
                    effective_threads = execution.effective_threads,
                    thread_mode = ?execution.thread_mode,
                    fallback_reason = %reason,
                    "multi-thread pool build failed; retrying with single-thread fallback"
                );
                execution.apply_pool_fallback(reason.clone());
                trace!(
                    requested_threads = execution.requested_threads,
                    effective_threads = execution.effective_threads,
                    thread_mode = ?execution.thread_mode,
                    used_parallelism = execution.used_parallelism,
                    threads_enabled = execution.used_parallelism,
                    thread_fallback = execution.thread_fallback,
                    thread_fallback_reason = ?execution.thread_fallback_reason,
                    "parallel threads disabled after thread pool fallback"
                );
                let pool = match builder(&execution) {
                    Ok(pool) => pool,
                    Err(RomWeaverError::ThreadPoolBuild(single_reason)) => {
                        return Err(RomWeaverError::ThreadPoolBuild(format!(
                            "multi-thread pool build failed: {reason}; single-thread fallback failed: {single_reason}"
                        )));
                    }
                    Err(error) => return Err(error),
                };
                Ok((execution, pool))
            }
            Err(error) => Err(error),
        }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn install<R: Send>(&self, operation: impl FnOnce() -> R + Send) -> R {
        match &self.backend {
            ThreadPoolBackend::Rayon(inner) => inner.install(operation),
            ThreadPoolBackend::Inline => operation(),
        }
    }

    fn forced_build_failure_reason(size: usize) -> Option<String> {
        if !cfg!(debug_assertions) {
            return None;
        }

        let raw = std::env::var("ROM_WEAVER_TEST_THREAD_POOL_FAIL").ok()?;
        let mode = raw.trim().to_ascii_lowercase();
        let should_fail = match mode.as_str() {
            "all" => true,
            "multi" => size > 1,
            "single" => size == 1,
            _ => false,
        };
        should_fail.then(|| format!("forced thread pool build failure ({mode})"))
    }
}

#[cfg(test)]
mod tests {
    use super::{SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode};
    use crate::RomWeaverError;

    static ENV_VAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct ScopedEnvVar {
        key: &'static str,
        original: Option<String>,
    }

    impl ScopedEnvVar {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            // SAFETY: test-only helper scopes environment mutation to a single process.
            unsafe { std::env::set_var(key, value) };
            Self { key, original }
        }
    }

    impl Drop for ScopedEnvVar {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                // SAFETY: test-only helper restores the previous value.
                unsafe { std::env::set_var(self.key, value) };
            } else {
                // SAFETY: test-only helper restores the previous state.
                unsafe { std::env::remove_var(self.key) };
            }
        }
    }

    #[test]
    fn auto_budget_resolves_to_a_positive_thread_count() {
        assert!(ThreadBudget::Auto.requested_threads() >= 1);
        assert_eq!(ThreadBudget::Auto.mode(), ThreadMode::Auto);
    }

    #[test]
    fn fixed_budget_parses_and_round_trips() {
        let budget: ThreadBudget = "3".parse().expect("budget");
        assert_eq!(budget, ThreadBudget::Fixed(3));
        assert_eq!(budget.to_string(), "3");
    }

    #[test]
    fn single_threaded_capability_falls_back_cleanly() {
        let execution = ThreadCapability::single_threaded().negotiate(ThreadBudget::Fixed(8));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert!(!execution.thread_fallback);
        assert!(execution.thread_fallback_reason.is_none());
    }

    #[test]
    fn parallel_capability_caps_effective_threads() {
        let execution = ThreadCapability::parallel(Some(4)).negotiate(ThreadBudget::Fixed(8));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 4);
        assert!(execution.used_parallelism);
        assert!(!execution.thread_fallback);
        assert!(execution.thread_fallback_reason.is_none());
    }

    #[test]
    fn supports_execution_accepts_single_threaded_reports() {
        let execution = ThreadExecution {
            requested_threads: 8,
            effective_threads: 1,
            thread_mode: ThreadMode::Fixed,
            used_parallelism: false,
            thread_fallback: false,
            thread_fallback_reason: None,
        };
        assert!(ThreadCapability::single_threaded().supports_execution(&execution));
    }

    #[test]
    fn supports_execution_rejects_parallel_report_for_single_thread_capability() {
        let execution = ThreadExecution {
            requested_threads: 8,
            effective_threads: 2,
            thread_mode: ThreadMode::Fixed,
            used_parallelism: true,
            thread_fallback: false,
            thread_fallback_reason: None,
        };
        assert!(!ThreadCapability::single_threaded().supports_execution(&execution));
    }

    #[test]
    fn supports_execution_accepts_parallel_fallback_to_single_thread() {
        let execution = ThreadExecution {
            requested_threads: 8,
            effective_threads: 1,
            thread_mode: ThreadMode::Fixed,
            used_parallelism: false,
            thread_fallback: false,
            thread_fallback_reason: None,
        };
        assert!(ThreadCapability::parallel(None).supports_execution(&execution));
    }

    #[test]
    fn supports_execution_rejects_effective_threads_above_cap() {
        let execution = ThreadExecution {
            requested_threads: 8,
            effective_threads: 5,
            thread_mode: ThreadMode::Fixed,
            used_parallelism: true,
            thread_fallback: false,
            thread_fallback_reason: None,
        };
        assert!(!ThreadCapability::parallel(Some(4)).supports_execution(&execution));
    }

    #[test]
    fn supports_execution_rejects_inconsistent_parallelism_flag() {
        let execution = ThreadExecution {
            requested_threads: 4,
            effective_threads: 1,
            thread_mode: ThreadMode::Fixed,
            used_parallelism: true,
            thread_fallback: false,
            thread_fallback_reason: None,
        };
        assert!(!ThreadCapability::parallel(None).supports_execution(&execution));
    }

    #[test]
    fn pool_build_falls_back_to_single_thread_when_parallel_build_fails() {
        let mut attempts = 0usize;
        let planned = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(8));
        let (execution, pool) =
            SharedThreadPool::with_execution_fallback_with_builder(planned, |execution| {
                attempts += 1;
                if attempts == 1 {
                    return Err(RomWeaverError::ThreadPoolBuild(
                        "operation not supported on this platform".to_string(),
                    ));
                }
                SharedThreadPool::with_size(execution.effective_threads)
            })
            .expect("fallback succeeds");

        assert_eq!(attempts, 2);
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert!(execution.thread_fallback);
        assert_eq!(
            execution.thread_fallback_reason.as_deref(),
            Some("operation not supported on this platform")
        );
        assert_eq!(pool.size(), 1);
    }

    #[test]
    fn pool_build_hard_fails_when_single_thread_fallback_also_fails() {
        let planned = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(8));
        let result =
            SharedThreadPool::with_execution_fallback_with_builder(planned, |_execution| {
                Err(RomWeaverError::ThreadPoolBuild(
                    "operation not supported on this platform".to_string(),
                ))
            });
        assert!(result.is_err(), "fallback should fail");
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("expected thread pool build error"),
        };

        let RomWeaverError::ThreadPoolBuild(message) = error else {
            panic!("expected thread pool build error");
        };
        assert!(message.contains("multi-thread pool build failed"));
        assert!(message.contains("single-thread fallback failed"));
    }

    #[test]
    fn pool_build_does_not_retry_when_execution_is_already_single_threaded() {
        let mut attempts = 0usize;
        let planned = ThreadCapability::single_threaded().negotiate(ThreadBudget::Fixed(8));
        let result =
            SharedThreadPool::with_execution_fallback_with_builder(planned, |_execution| {
                attempts += 1;
                Err(RomWeaverError::ThreadPoolBuild(
                    "single thread pool unavailable".to_string(),
                ))
            });
        assert!(
            result.is_err(),
            "single-thread plan should not succeed when build fails"
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("expected thread pool build error"),
        };

        assert_eq!(attempts, 1);
        let RomWeaverError::ThreadPoolBuild(message) = error else {
            panic!("expected thread pool build error");
        };
        assert_eq!(message, "single thread pool unavailable");
    }

    #[test]
    fn test_force_mode_fails_multi_only() {
        let _env_lock = ENV_VAR_LOCK.lock().expect("env var lock");
        let _guard = ScopedEnvVar::set("ROM_WEAVER_TEST_THREAD_POOL_FAIL", "multi");
        assert!(
            SharedThreadPool::with_size(4).is_err(),
            "multi mode should fail multi-thread pools"
        );
        assert!(
            SharedThreadPool::with_size(1).is_ok(),
            "multi mode should allow single-thread pools"
        );
    }

    #[test]
    fn with_execution_uses_inline_path_for_effective_single_thread() {
        let _env_lock = ENV_VAR_LOCK.lock().expect("env var lock");
        let _guard = ScopedEnvVar::set("ROM_WEAVER_TEST_THREAD_POOL_FAIL", "single");
        let execution = ThreadCapability::parallel(Some(1)).negotiate(ThreadBudget::Fixed(8));
        let pool = SharedThreadPool::with_execution(&execution)
            .expect("single-thread execution should bypass rayon pool builds");
        assert_eq!(pool.size(), 1);
        assert_eq!(pool.install(|| 7usize), 7);
    }

    #[test]
    fn fallback_to_single_thread_uses_inline_path_after_parallel_build_failure() {
        let _env_lock = ENV_VAR_LOCK.lock().expect("env var lock");
        let _guard = ScopedEnvVar::set("ROM_WEAVER_TEST_THREAD_POOL_FAIL", "all");
        let planned = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(8));
        let (execution, pool) =
            SharedThreadPool::with_execution_fallback(planned).expect("fallback should succeed");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert!(execution.thread_fallback);
        assert!(
            execution
                .thread_fallback_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("forced thread pool build failure")),
            "fallback reason should include the build error"
        );
        assert_eq!(pool.size(), 1);
        assert_eq!(pool.install(|| 3usize), 3);
    }
}
