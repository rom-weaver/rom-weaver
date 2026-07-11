use std::process::ExitCode;

#[cfg(target_arch = "wasm32")]
use std::io::{self, Read};

#[cfg(target_arch = "wasm32")]
use rom_weaver_app::{RomWeaverRunRequest, run_request};

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

/// Under `wasm32-wasip1-threads` every worker shares one linear memory, so a panic (which
/// aborts with `panic = "abort"`) tears down the whole instance and otherwise surfaces to the
/// JS host as an opaque dead worker. Install a global hook - it applies to every spawned
/// thread - that emits a single marked line to stderr (which the host collects) so the failure
/// is diagnosable and machine-detectable. This does not recover the instance; per-thread
/// recovery would require `panic = "unwind"` and a `catch_unwind` boundary.
#[cfg(target_arch = "wasm32")]
fn install_panic_reporter() {
    use std::sync::Once;
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            eprintln!("[rom-weaver-panic] {info}");
        }));
    });
}

#[cfg(target_arch = "wasm32")]
fn read_wasm_run_request() -> std::result::Result<RomWeaverRunRequest, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read typed run request from stdin: {error}"))?;
    if input.trim().is_empty() {
        return Err("missing typed run request on stdin".to_string());
    }
    serde_json::from_str(&input).map_err(|error| format!("invalid typed run request JSON: {error}"))
}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> ExitCode {
    eprintln!("rom-weaver-app is the wasm app entrypoint; use the rom-weaver CLI on native hosts");
    ExitCode::from(2)
}
