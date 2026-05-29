use std::process::ExitCode;

#[cfg(target_arch = "wasm32")]
use std::io::{self, Read};

#[cfg(target_arch = "wasm32")]
use rom_weaver_app::{RomWeaverRunRequest, run_request};

#[cfg(target_arch = "wasm32")]
fn main() -> ExitCode {
    let request = match read_wasm_run_request() {
        Ok(request) => request,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(2);
        }
    };
    run_request(request, false)
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
