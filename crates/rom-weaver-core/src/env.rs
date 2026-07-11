//! Centralized parsing for `ROM_WEAVER_*` runtime environment knobs.
//!
//! Runtime knobs go through these helpers so an unparseable value is logged -
//! a silent parse-fail-to-default hides typos in benchmark/debug runs - and
//! truthiness is consistent across the workspace. Build-script (`build.rs`) and
//! some test-only knobs cannot depend on this crate and parse inline.

use tracing::warn;

/// Read an unsigned-integer knob, or `None` when unset. An unparseable value
/// logs a warning and is treated as unset.
pub fn env_u64_opt(name: &str) -> Option<u64> {
    let raw = std::env::var(name).ok()?;
    let trimmed = raw.trim();
    match trimmed.parse::<u64>() {
        Ok(value) => Some(value),
        Err(error) => {
            warn!(
                env = name,
                value = trimmed,
                %error,
                "ignoring unparseable u64 env value; using default"
            );
            None
        }
    }
}

/// Read an unsigned-integer knob, falling back to `default` when unset or
/// unparseable (the unparseable case logs a warning).
pub fn env_u64(name: &str, default: u64) -> u64 {
    env_u64_opt(name).unwrap_or(default)
}
