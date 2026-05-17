use std::{fmt, str::FromStr, sync::Arc};

use rayon::ThreadPool;
use serde::{Deserialize, Serialize};

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
        match self {
            Self::SingleThreaded => ThreadExecution {
                requested_threads,
                effective_threads: 1,
                thread_mode: budget.mode(),
                used_parallelism: false,
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
                }
            }
        }
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
}

#[derive(Clone)]
pub struct SharedThreadPool {
    size: usize,
    inner: Arc<ThreadPool>,
}

impl SharedThreadPool {
    pub fn with_size(size: usize) -> Result<Self> {
        let size = size.max(1);
        let inner = rayon::ThreadPoolBuilder::new()
            .num_threads(size)
            .build()
            .map_err(|error| RomWeaverError::ThreadPoolBuild(error.to_string()))?;
        Ok(Self {
            size,
            inner: Arc::new(inner),
        })
    }

    pub fn with_execution(execution: &ThreadExecution) -> Result<Self> {
        Self::with_size(execution.effective_threads)
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn install<R: Send>(&self, operation: impl FnOnce() -> R + Send) -> R {
        self.inner.install(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::{ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode};

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
    }

    #[test]
    fn parallel_capability_caps_effective_threads() {
        let execution = ThreadCapability::parallel(Some(4)).negotiate(ThreadBudget::Fixed(8));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 4);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn supports_execution_accepts_single_threaded_reports() {
        let execution = ThreadExecution {
            requested_threads: 8,
            effective_threads: 1,
            thread_mode: ThreadMode::Fixed,
            used_parallelism: false,
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
        };
        assert!(!ThreadCapability::parallel(None).supports_execution(&execution));
    }
}
