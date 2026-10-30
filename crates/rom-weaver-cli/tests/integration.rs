//! Every integration test of this crate in one binary, so a test build links the
//! dependency graph once. Cargo.toml sets `autotests = false`: declare new
//! `tests/*.rs` files here; `mise run quality-architecture` reports any that are not.

mod cli_smoke;
mod dcp_metadata_regressions;
mod human_output;
mod json_output;
mod progress_percent_scale;
mod trace_logging;
mod unicode_extract;
