use std::{env, path::PathBuf};

fn main() {
    let target = env::var("TARGET").expect("TARGET is not set");
    let pointer_width = env::var("CARGO_CFG_TARGET_POINTER_WIDTH")
        .expect("CARGO_CFG_TARGET_POINTER_WIDTH is not set")
        .parse::<u32>()
        .expect("invalid CARGO_CFG_TARGET_POINTER_WIDTH");

    let mut defines = vec![
        ("SECONDARY_DJW".to_string(), "1".to_string()),
        ("SECONDARY_FGK".to_string(), "1".to_string()),
        ("EXTERNAL_COMPRESSION".to_string(), "0".to_string()),
        ("XD3_USE_LARGEFILE64".to_string(), "1".to_string()),
        ("SHELL_TESTS".to_string(), "0".to_string()),
    ];
    if target.contains("windows") {
        defines.push(("XD3_WIN32".to_string(), "1".to_string()));
    }
    for name in [
        "size_t",
        "unsigned int",
        "unsigned long",
        "unsigned long long",
    ] {
        let define = format!("SIZEOF_{}", name.to_uppercase().replace(' ', "_"));
        defines.push((
            define,
            c_type_size_for_target(name, &target, pointer_width).to_string(),
        ));
    }

    let crate_root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let xdelta_source_root = crate_root.join("../../vendor/xdelta3-src");

    let mut builder = cc::Build::new();
    builder.include(&xdelta_source_root);
    for (key, val) in &defines {
        builder.define(key, Some(val.as_str()));
    }
    builder
        .file(xdelta_source_root.join("xdelta3.c"))
        .warnings(false)
        .compile("xdelta3");
}

fn c_type_size_for_target(name: &str, target: &str, pointer_width: u32) -> u32 {
    match name {
        "size_t" => pointer_width / 8,
        "unsigned int" => 4,
        "unsigned long" => {
            if target.contains("windows") {
                4
            } else {
                pointer_width / 8
            }
        }
        "unsigned long long" => 8,
        _ => panic!("unsupported C type size lookup: {name}"),
    }
}
