use std::{env, fs, path::Path};

fn main() {
    minify_save_schemas();
    println!("cargo:rustc-check-cfg=cfg(rom_weaver_wasi_threads)");
    println!("cargo:rerun-if-env-changed=ROM_WEAVER_WASI_THREADS");

    let target = env::var("TARGET").unwrap_or_default();
    let forced = env::var("ROM_WEAVER_WASI_THREADS")
        .ok()
        .is_some_and(|value| value == "1");
    if target == "wasm32-wasip1-threads" || forced {
        println!("cargo:rustc-cfg=rom_weaver_wasi_threads");
    }
}

/// Embeds the built-in save schema packs without their indentation. The
/// packs stay pretty-printed in the repository for review.
fn minify_save_schemas() {
    let source = Path::new("data/save-schemas");
    println!("cargo:rerun-if-changed={}", source.display());
    let output = Path::new(&env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("save-schemas");
    fs::create_dir_all(&output).expect("create the minified save schema directory");
    for entry in fs::read_dir(source).expect("read the built-in save schema directory") {
        let path = entry.expect("read a built-in save schema entry").path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        let json = fs::read(&path).expect("read a built-in save schema pack");
        let name = path.file_name().expect("schema packs have file names");
        fs::write(output.join(name), strip_json_whitespace(&json))
            .expect("write a minified save schema pack");
    }
}

/// Removes insignificant JSON whitespace; string contents stay byte-identical.
fn strip_json_whitespace(json: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(json.len());
    let mut in_string = false;
    let mut escaped = false;
    for &byte in json {
        if in_string {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else if !byte.is_ascii_whitespace() {
            in_string = byte == b'"';
            output.push(byte);
        }
    }
    output
}
