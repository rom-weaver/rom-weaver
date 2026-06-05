use std::{fmt, str::FromStr, sync::Arc};

use rayon::ThreadPool;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use tracing::trace;
#[cfg(feature = "typescript-types")]
use ts_rs::{Config, TS};

use crate::{Result, RomWeaverError};

/// Fallback parallelism when the host CPU count is unavailable (notably wasm, where
/// `available_parallelism` is not meaningful) or cannot be queried.
const DEFAULT_THREAD_COUNT: usize = 4;
const DEFAULT_RAYON_STACK_SIZE_BYTES: usize = 8 * 1024 * 1024;

/// Upper bound on negotiated parallel threads under wasm. The JS host serves `thread-spawn`
/// from a bounded WASI thread-worker pool; requesting more rayon workers than the pool can
/// provide makes spawn return `EAGAIN` and the pool build fail (or block on a worker that
/// never starts). Keep aligned with the JS-side thread-pool cap.
#[cfg(target_family = "wasm")]
const MAX_WASI_THREAD_COUNT: usize = 256;

/// Clamps a negotiated thread count to the platform ceiling. Native hosts spawn OS threads
/// directly and need no cap; wasm hosts are bounded by the JS WASI thread-worker pool.
fn clamp_platform_thread_count(count: usize) -> usize {
    #[cfg(target_family = "wasm")]
    {
        count.min(MAX_WASI_THREAD_COUNT)
    }
    #[cfg(not(target_family = "wasm"))]
    {
        count
    }
}

/// Resolves the thread count for `ThreadBudget::Auto`: the host's available parallelism on
/// native targets, falling back to [`DEFAULT_THREAD_COUNT`] on wasm or when the query fails.
fn auto_thread_count() -> usize {
    #[cfg(target_family = "wasm")]
    {
        DEFAULT_THREAD_COUNT
    }
    #[cfg(not(target_family = "wasm"))]
    {
        std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(DEFAULT_THREAD_COUNT)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum ThreadMode {
    Auto,
    Fixed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ThreadBudget {
    #[default]
    Auto,
    Fixed(usize),
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
            Self::Auto => auto_thread_count(),
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

impl Serialize for ThreadBudget {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Auto => serializer.serialize_str("auto"),
            Self::Fixed(count) => serializer.serialize_u64((*count).max(1) as u64),
        }
    }
}

impl<'de> Deserialize<'de> for ThreadBudget {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ThreadBudgetVisitor;

        impl<'de> de::Visitor<'de> for ThreadBudgetVisitor {
            type Value = ThreadBudget;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("`auto` or a positive integer")
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: de::Error,
            {
                value.parse::<ThreadBudget>().map_err(E::custom)
            }

            fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E>
            where
                E: de::Error,
            {
                usize::try_from(value)
                    .ok()
                    .filter(|count| *count > 0)
                    .map(ThreadBudget::Fixed)
                    .ok_or_else(|| E::custom("thread budget must be greater than zero"))
            }

            fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E>
            where
                E: de::Error,
            {
                u64::try_from(value)
                    .map_err(|_| E::custom("thread budget must be greater than zero"))
                    .and_then(|value| self.visit_u64(value))
            }
        }

        deserializer.deserialize_any(ThreadBudgetVisitor)
    }
}

#[cfg(feature = "typescript-types")]
impl TS for ThreadBudget {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &Config) -> String {
        "ThreadBudget".to_string()
    }

    fn inline(_: &Config) -> String {
        "\"auto\" | number".to_string()
    }

    fn decl(cfg: &Config) -> String {
        format!("type {} = {};", Self::name(cfg), Self::inline(cfg))
    }

    fn decl_concrete(cfg: &Config) -> String {
        Self::decl(cfg)
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
        #[cfg(all(target_family = "wasm", not(rom_weaver_wasi_threads)))]
        {
            let _ = max_threads;
            return Self::SingleThreaded;
        }

        #[cfg(not(all(target_family = "wasm", not(rom_weaver_wasi_threads))))]
        Self::Parallel { max_threads }
    }

    pub fn negotiate(&self, budget: ThreadBudget) -> ThreadExecution {
        let requested_threads = budget.requested_threads();
        let effective_budget_threads = clamp_platform_thread_count(requested_threads);
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
                    .map(|limit| effective_budget_threads.min(limit.max(1)))
                    .unwrap_or(effective_budget_threads)
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
#[cfg_attr(feature = "typescript-types", derive(TS))]
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
            .stack_size(DEFAULT_RAYON_STACK_SIZE_BYTES)
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

        let raw = forced_build_failure_mode()?;
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

fn forced_build_failure_mode() -> Option<String> {
    #[cfg(test)]
    if let Some(mode) = test_forced_build_failure_mode() {
        return Some(mode);
    }

    std::env::var("ROM_WEAVER_TEST_THREAD_POOL_FAIL").ok()
}

#[cfg(test)]
thread_local! {
    static TEST_FORCED_BUILD_FAILURE_MODE: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_forced_build_failure_mode() -> Option<String> {
    TEST_FORCED_BUILD_FAILURE_MODE.with(|state| state.borrow().clone())
}

#[cfg(test)]
fn set_test_forced_build_failure_mode(value: Option<&str>) -> Option<String> {
    TEST_FORCED_BUILD_FAILURE_MODE.with(|state| {
        let mut state = state.borrow_mut();
        let previous = state.clone();
        *state = value.map(|entry| entry.to_string());
        previous
    })
}

#[cfg(test)]
fn restore_test_forced_build_failure_mode(previous: Option<String>) {
    TEST_FORCED_BUILD_FAILURE_MODE.with(|state| {
        *state.borrow_mut() = previous;
    });
}

#[cfg(test)]
#[path = "../tests/unit/threads.rs"]
mod tests;
