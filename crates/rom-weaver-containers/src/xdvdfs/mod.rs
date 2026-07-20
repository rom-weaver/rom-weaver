//! Vendored copy of the `xdvdfs` crate (MIT, see `LICENSE` beside this file)
//! from the 0.8.3 crates.io release by antangelo <https://github.com/antangelo/xdvdfs>.
//!
//! Inlined rather than depended on because upstream's published `write` feature
//! forces `wax` - and with it `nom`, `regex`, `pori`, `const_format`, and
//! `itertools` - into the graph. Upstream `main` already makes that optional
//! behind a `remap` feature but has cut no release since 0.8.3 (2024-11-13).
//! Carrying it as a separate workspace crate instead would mean publishing a
//! renamed fork of someone else's crate to crates.io, because `cargo publish`
//! requires every path dependency of a published crate to exist on the registry.
//!
//! To drop this once upstream releases: delete this directory, add `xdvdfs`
//! with `default-features = false, features = ["std", "read", "write", "sync"]`
//! to the workspace dependencies, and replace the `pub mod xdvdfs;` declaration
//! in `lib.rs` with `pub use ::xdvdfs;`. Call sites in this crate,
//! `rom-weaver-app`, and `cli_smoke` keep the same paths either way.
//!
//! Local changes against the 0.8.3 release, kept deliberately small:
//! - `#![no_std]` dropped, since crate-level attributes cannot apply to a
//!   module. `extern crate alloc;` moved to this crate's root so the source's
//!   `use alloc::*` imports still resolve.
//! - `#[cfg(feature = ...)]` gates resolved to the feature set this workspace
//!   pinned - `std`, `read`, `write`, `sync` on; `logging`, `checksum`,
//!   `ciso_support`, `wax` off - because those cfgs would otherwise resolve
//!   against `rom-weaver-containers`' own features. Code behind the disabled
//!   features is deleted rather than left gated.
//! - `crate::` paths rewritten to `crate::xdvdfs::`.
//! - Clippy lifetime-elision fixes for this workspace's `-D warnings` gate.

// Upstream gates these on its `logging` feature, which this workspace left off,
// so they expand to nothing. Wiring them to `tracing` is a worthwhile follow-up
// but would be a behavior change rather than a move.
macro_rules! traceln {
    ($($x:expr),*) => {};
}

macro_rules! debugln {
    ($($x:expr),*) => {};
}

pub mod blockdev;
pub mod layout;
pub mod util;

pub mod read;

pub mod write;
