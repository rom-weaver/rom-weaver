use std::process::ExitCode;

#[cfg(target_arch = "wasm32")]
use std::io::{self, Read};

#[cfg(any(target_arch = "wasm32", test))]
use rom_weaver_app::RomWeaverRunRequest;
#[cfg(target_arch = "wasm32")]
use rom_weaver_app::run_request;

/// Machine-detectable stderr marker the panic hook prefixes onto aborting
/// shared-memory panics. The webapp does not currently grep this literal
/// (see `packages/rom-weaver-webapp/tests/unit/wasm-panic-marker.test.mjs`,
/// which pins its own copy of the string against this constant's value via
/// `crates/rom-weaver-cli/tests/unit/wasm_main.rs` - no source of truth is
/// shared across the Rust/JS boundary, so both sides must be updated
/// together if this ever changes).
#[cfg(any(target_arch = "wasm32", test))]
const WASM_PANIC_MARKER: &str = "[rom-weaver-panic]";

#[cfg(target_arch = "wasm32")]
fn main() -> ExitCode {
    install_panic_reporter();
    let request = match read_wasm_run_request() {
        Ok(request) => request,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(2);
        }
    };
    run_request(request, false)
}

/// Reports aborting shared-memory panics to the JS host with a machine-detectable stderr marker.
#[cfg(target_arch = "wasm32")]
fn install_panic_reporter() {
    use std::sync::Once;
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            eprintln!("{WASM_PANIC_MARKER} {info}");
        }));
    });
}

#[cfg(target_arch = "wasm32")]
fn read_wasm_run_request() -> std::result::Result<RomWeaverRunRequest, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read typed run request from stdin: {error}"))?;
    parse_wasm_run_request(&input)
}

/// The JSON-decode half of `read_wasm_run_request`, split out so it can be
/// unit-tested without needing to fake process stdin.
#[cfg(any(target_arch = "wasm32", test))]
fn parse_wasm_run_request(input: &str) -> std::result::Result<RomWeaverRunRequest, String> {
    if input.trim().is_empty() {
        return Err("missing typed run request on stdin".to_string());
    }
    serde_json::from_str(input).map_err(|error| format!("invalid typed run request JSON: {error}"))
}

#[cfg(test)]
#[path = "../tests/unit/wasm_main.rs"]
mod wasm_main_tests;

#[cfg(not(target_arch = "wasm32"))]
fn main() -> ExitCode {
    eprintln!("rom-weaver-app is the wasm app entrypoint; use the rom-weaver CLI on native hosts");
    ExitCode::from(2)
}
