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

/// The rom-weaver release version. Native builds always know it.
#[cfg(not(target_family = "wasm"))]
pub fn app_version() -> Option<&'static str> {
    Some(env!("CARGO_PKG_VERSION"))
}

/// The release version from `ROM_WEAVER_APP_VERSION`, or `None` if it is unset or invalid.
/// The build pins the crate version (`scripts/wasm/wasm-version-pin.mjs`), so a version-only
/// release keeps the module's bytes. Code in the module MUST NOT use `env!("CARGO_PKG_VERSION")`.
#[cfg(target_family = "wasm")]
pub fn app_version() -> Option<&'static str> {
    const APP_VERSION_ENV: &str = "ROM_WEAVER_APP_VERSION";
    // The value is written into patch headers, so it stays a short printable token.
    const MAX_APP_VERSION_BYTES: usize = 64;
    static APP_VERSION: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    APP_VERSION
        .get_or_init(|| {
            let value = std::env::var(APP_VERSION_ENV).ok()?;
            let valid = !value.is_empty()
                && value.len() <= MAX_APP_VERSION_BYTES
                && value.bytes().all(|byte| byte.is_ascii_graphic());
            if !valid {
                warn!(env = APP_VERSION_ENV, "ignoring invalid app version");
                return None;
            }
            Some(value)
        })
        .as_deref()
}
