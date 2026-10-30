//! Every integration test of this crate in one binary, so a test build links the
//! dependency graph once. Cargo.toml sets `autotests = false`: declare new
//! `tests/*.rs` files here; `mise run quality-architecture` reports any that are not.

mod behavior_properties;
mod bsp_interactive;
mod ups_endpoints;
