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
    let expected = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .max(1);
    assert_eq!(ThreadBudget::Auto.requested_threads(), expected);
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
    let result = SharedThreadPool::with_execution_fallback_with_builder(planned, |_execution| {
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
    let result = SharedThreadPool::with_execution_fallback_with_builder(planned, |_execution| {
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

#[test]
fn physical_memory_is_either_unavailable_or_a_plausible_page_multiple() {
    // The query is best-effort: `None` is a valid answer on hosts that cannot
    // report it, but a reported value must be usable as a parallelism bound.
    if let Some(bytes) = super::physical_memory_bytes() {
        assert!(bytes >= 1024 * 1024, "implausible physical memory: {bytes}");
    }
}

#[test]
fn thread_budget_displays_and_parses_both_forms() {
    assert_eq!(ThreadBudget::Auto.to_string(), "auto");
    assert_eq!(ThreadBudget::Fixed(4).to_string(), "4");

    for value in ["auto", "AUTO", "Auto"] {
        assert_eq!(
            value.parse::<ThreadBudget>().expect("auto parses"),
            ThreadBudget::Auto
        );
    }
    assert_eq!(
        "6".parse::<ThreadBudget>().expect("fixed parses"),
        ThreadBudget::Fixed(6)
    );
}

#[test]
fn thread_budget_rejects_values_that_are_neither_auto_nor_positive() {
    for value in ["", "two", "-1", "1.5", "auto "] {
        let error = value
            .parse::<ThreadBudget>()
            .map(|_| ())
            .expect_err("`{value}` must not parse");
        assert_eq!(
            error.to_string(),
            format!(
                "validation failed: invalid thread budget `{value}`; use `auto` or a positive integer"
            )
        );
    }

    let error = "0"
        .parse::<ThreadBudget>()
        .map(|_| ())
        .expect_err("zero must not parse");
    assert_eq!(
        error.to_string(),
        "validation failed: thread budget must be greater than zero"
    );
}

#[test]
fn thread_budget_serializes_as_a_string_or_a_number() {
    assert_eq!(
        serde_json::to_string(&ThreadBudget::Auto).expect("serialize auto"),
        "\"auto\""
    );
    assert_eq!(
        serde_json::to_string(&ThreadBudget::Fixed(8)).expect("serialize fixed"),
        "8"
    );
    // A zero never leaves the type, even if one is constructed directly.
    assert_eq!(
        serde_json::to_string(&ThreadBudget::Fixed(0)).expect("serialize zero"),
        "1"
    );
}

#[test]
fn thread_budget_deserializes_from_strings_and_integers() {
    for (json, expected) in [
        ("\"auto\"", ThreadBudget::Auto),
        ("\"3\"", ThreadBudget::Fixed(3)),
        ("5", ThreadBudget::Fixed(5)),
    ] {
        let parsed = serde_json::from_str::<ThreadBudget>(json)
            .unwrap_or_else(|error| panic!("`{json}`: {error}"));
        assert_eq!(parsed, expected, "{json}");
    }
}

#[test]
fn thread_budget_deserialization_rejects_non_positive_and_wrong_types() {
    for json in ["0", "-1", "\"0\"", "\"nope\"", "true", "null"] {
        let error = serde_json::from_str::<ThreadBudget>(json)
            .map(|_| ())
            .expect_err("`{json}` must not deserialize");
        assert!(!error.to_string().is_empty(), "{json}");
    }
    // The expectation string is what serde puts in a type-mismatch message.
    let error = serde_json::from_str::<ThreadBudget>("true")
        .map(|_| ())
        .expect_err("a bool is not a thread budget");
    assert!(
        error.to_string().contains("`auto` or a positive integer"),
        "{error}"
    );
}

#[test]
fn thread_budget_deserializes_a_signed_integer_from_a_non_json_format() {
    use serde::{Deserialize as _, de::value::I64Deserializer};

    // serde_json emits every non-negative integer as a u64, so `visit_i64`'s
    // conversion arm is only reachable from a format that hands over an i64.
    type Deserializer = I64Deserializer<serde::de::value::Error>;
    assert_eq!(
        ThreadBudget::deserialize(Deserializer::new(4)).expect("positive i64"),
        ThreadBudget::Fixed(4)
    );
    for value in [0i64, -1] {
        let error = ThreadBudget::deserialize(Deserializer::new(value))
            .map(|_| ())
            .expect_err("a non-positive i64 must be refused");
        assert_eq!(error.to_string(), "thread budget must be greater than zero");
    }
}

#[test]
fn supports_execution_rejects_a_zero_thread_report() {
    let capability = ThreadCapability::parallel(None);
    let zero_requested = ThreadExecution {
        requested_threads: 0,
        effective_threads: 1,
        thread_mode: ThreadMode::Fixed,
        used_parallelism: false,
        thread_fallback: false,
        thread_fallback_reason: None,
    };
    assert!(!capability.supports_execution(&zero_requested));

    let zero_effective = ThreadExecution {
        requested_threads: 4,
        effective_threads: 0,
        ..zero_requested.clone()
    };
    assert!(!capability.supports_execution(&zero_effective));
}

#[test]
fn force_serial_downgrades_without_claiming_a_fallback() {
    let mut execution = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(8));
    let requested = execution.requested_threads;
    execution.force_serial();

    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
    // A deliberate downgrade is not a pool failure, so it must not be reported
    // as one.
    assert!(!execution.thread_fallback);
    assert_eq!(execution.thread_fallback_reason, None);
    assert_eq!(execution.requested_threads, requested);

    let mut fallback = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(8));
    fallback.apply_pool_fallback("pool refused");
    assert!(fallback.thread_fallback);
    assert_eq!(
        fallback.thread_fallback_reason.as_deref(),
        Some("pool refused")
    );
}

#[test]
fn forced_build_failure_mode_selects_by_pool_size() {
    let _guard = ScopedFailMode::set("single");
    // `single` fails only the one-thread build, so a multi-thread pool still
    // comes up.
    assert!(SharedThreadPool::with_size(2).is_ok());
    assert!(matches!(
        SharedThreadPool::with_size(1),
        Err(RomWeaverError::ThreadPoolBuild(_))
    ));
}

#[test]
fn an_unrecognized_forced_failure_mode_fails_nothing() {
    let _guard = ScopedFailMode::set("bogus");
    assert!(SharedThreadPool::with_size(1).is_ok());
    assert!(SharedThreadPool::with_size(4).is_ok());
}

#[test]
fn pool_fallback_propagates_a_non_pool_build_error_from_the_retry() {
    // The retry builder can fail for a reason that is not a pool-build failure;
    // that error must reach the caller unchanged rather than being folded into
    // the combined thread-pool message.
    let execution = ThreadCapability::parallel(None).negotiate(ThreadBudget::Fixed(4));
    let mut calls = 0usize;
    let error = SharedThreadPool::with_execution_fallback_with_builder(execution, |_| {
        calls += 1;
        if calls == 1 {
            return Err(RomWeaverError::ThreadPoolBuild("no threads".into()));
        }
        Err(RomWeaverError::Validation("unrelated failure".into()))
    })
    .map(|_| ())
    .expect_err("the retry error must surface");

    assert_eq!(calls, 2);
    assert_eq!(error.to_string(), "validation failed: unrelated failure");
}
