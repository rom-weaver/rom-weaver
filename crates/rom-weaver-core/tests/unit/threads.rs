use super::{SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode};
use crate::RomWeaverError;

struct ScopedFailMode {
    original: Option<String>,
}

impl ScopedFailMode {
    fn set(value: &str) -> Self {
        let original = super::set_test_forced_build_failure_mode(Some(value));
        Self { original }
    }
}

impl Drop for ScopedFailMode {
    fn drop(&mut self) {
        super::restore_test_forced_build_failure_mode(self.original.take());
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
    let _guard = ScopedFailMode::set("multi");
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
    let _guard = ScopedFailMode::set("single");
    let execution = ThreadCapability::parallel(Some(1)).negotiate(ThreadBudget::Fixed(8));
    let pool = SharedThreadPool::with_execution(&execution)
        .expect("single-thread execution should bypass rayon pool builds");
    assert_eq!(pool.size(), 1);
    assert_eq!(pool.install(|| 7usize), 7);
}

#[test]
fn fallback_to_single_thread_uses_inline_path_after_parallel_build_failure() {
    let _guard = ScopedFailMode::set("all");
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
