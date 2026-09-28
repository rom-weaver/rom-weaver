use std::env;

fn main() {
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
