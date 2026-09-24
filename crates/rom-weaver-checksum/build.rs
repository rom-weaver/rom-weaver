use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt::Write;
use std::fs;
use std::path::PathBuf;

fn normalize_platform_name(name: &str) -> String {
    name.split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

fn generate_platform_aliases() {
    const SOURCE: &str = "src/platform-names.json";
    println!("cargo:rerun-if-changed={SOURCE}");
    let source = fs::read_to_string(SOURCE).expect("read shared platform names");
    let registry: serde_json::Value =
        serde_json::from_str(&source).expect("parse shared platform names");
    let entries = registry["aliases"]
        .as_object()
        .expect("shared platform aliases are an object");
    let mut aliases: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (name, values) in entries {
        let key = normalize_platform_name(name);
        let entry = aliases.entry(key).or_default();
        for value in values.as_array().expect("platform aliases are arrays") {
            entry.insert(
                value
                    .as_str()
                    .expect("platform aliases are strings")
                    .to_string(),
            );
        }
    }

    let mut output = String::from("const PLATFORM_ALIASES: &[(&str, &[&str])] = &[\n");
    for (name, values) in aliases {
        write!(output, "    ({name:?}, &[").expect("write platform aliases");
        for value in values {
            write!(output, "{value:?}, ").expect("write platform alias");
        }
        output.push_str("]),\n");
    }
    output.push_str("];\n");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    fs::write(out_dir.join("platform_aliases.rs"), output).expect("write platform aliases");
}

fn main() {
    generate_platform_aliases();
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
