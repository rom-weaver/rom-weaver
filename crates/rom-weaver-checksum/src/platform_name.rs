//! The platform-name key every alias table matches on. `build.rs` includes this
//! file too, so the generated alias table and runtime lookups share one
//! normalizer. Keep it free of crate imports.

/// Normalize a platform name for alias matching: lowercase, collapse every
/// non-alphanumeric run to one space, trim.
pub fn normalize_platform_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_space = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_space = true;
        }
    }
    out
}
