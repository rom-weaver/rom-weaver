//! Every integration test of this crate in one binary, so a test build links the
//! dependency graph once. Cargo.toml sets `autotests = false`: declare new
//! `tests/*.rs` files here; `mise run quality-architecture` reports any that are not.

mod disc_sheet_regressions;
mod no_full_buffer_guard;
mod save_generation;
