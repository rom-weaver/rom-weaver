#[cfg(not(target_arch = "wasm32"))]
include!(concat!(env!("OUT_DIR"), "/identify_builtin_packs.rs"));
