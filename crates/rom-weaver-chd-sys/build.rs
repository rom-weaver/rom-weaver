fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=native/rom_weaver_mame_chd.cpp");
    println!("cargo:rerun-if-changed=native/rom_weaver_mame_chdcodec.cpp");
    println!("cargo:rerun-if-changed=native/mame_compat");
    println!("cargo:rerun-if-changed=native/mame_upstream");

    let flac_include_dirs = flac_include_dirs();

    let mut lzma = cc::Build::new();
    lzma.file("native/mame_upstream/lzma/C/CpuArch.c");
    lzma.file("native/mame_upstream/lzma/C/LzFind.c");
    lzma.file("native/mame_upstream/lzma/C/LzmaDec.c");
    lzma.file("native/mame_upstream/lzma/C/LzmaEnc.c");
    lzma.include("native/mame_upstream/lzma/C");
    lzma.flag_if_supported("-std=c11");
    lzma.flag_if_supported("-Wno-sign-compare");
    lzma.flag_if_supported("-Wno-unused-parameter");
    lzma.define("Z7_ST", None);
    lzma.compile("rom_weaver_mame_lzma");

    let mut build = cc::Build::new();
    build.cpp(true);
    build.file("native/rom_weaver_mame_chd.cpp");
    build.file("native/rom_weaver_mame_chdcodec.cpp");
    build.file("native/mame_compat/avhuff.cpp");
    build.file("native/mame_compat/bitmap.cpp");
    build.file("native/mame_compat/flac.cpp");
    build.file("native/mame_compat/palette.cpp");
    build.file("native/mame_compat/rom_weaver_mame_cdrom.cpp");
    build.file("native/mame_compat/rom_weaver_mame_corefile.cpp");
    build.file("native/mame_compat/rom_weaver_mame_ioprocs.cpp");
    build.file("native/mame_compat/rom_weaver_mame_osdcore.cpp");
    build.file("native/mame_upstream/chd.cpp");
    build.file("native/mame_upstream/hashing.cpp");
    build.file("native/mame_upstream/huffman.cpp");
    build.file("native/mame_upstream/md5.cpp");
    build.include("native/mame_compat");
    build.include("native/mame_upstream");
    build.include("native/mame_upstream/lzma/C");
    for include in flac_include_dirs {
        build.include(include);
    }
    for include in zlib_include_dirs() {
        build.include(include);
    }
    for include in zstd_include_dirs() {
        build.include(include);
    }
    build.flag_if_supported("-std=c++17");
    build.flag_if_supported("-Wno-sign-compare");
    build.flag_if_supported("-Wno-unused-parameter");
    build.define("MAME_NOASM", None);
    build.define("ROM_WEAVER_MAME_CHD_HAVE_BACKEND", None);
    build.define("Z7_ST", None);
    build.compile("rom_weaver_mame_chd_bridge");
    println!(
        "cargo:rustc-env=ROM_WEAVER_MAME_CHD_BACKEND=embedded-zlib-zstd-lzma-huffman-flac-avhuff"
    );
}

fn zlib_include_dirs() -> Vec<String> {
    match std::env::var("DEP_Z_INCLUDE") {
        Ok(includes) => includes
            .split(';')
            .filter(|path| !path.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        Err(_) => {
            let target = std::env::var("TARGET").unwrap_or_default();
            if target.starts_with("wasm32") {
                panic!(
                    "missing DEP_Z_INCLUDE from libz-sys while building `{target}`; \
                     ensure libz-sys is an immediate dependency"
                );
            }
            Vec::new()
        }
    }
}

fn zstd_include_dirs() -> Vec<String> {
    let includes = std::env::var("DEP_ZSTD_INCLUDE").expect(
        "missing DEP_ZSTD_INCLUDE from zstd-sys; ensure zstd-sys is an immediate dependency",
    );
    includes
        .split(';')
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn flac_include_dirs() -> Vec<String> {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is always set"),
    );
    let workspace_root = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .expect("rom-weaver-chd-sys lives under workspace/crates/");
    let vendored_include = workspace_root.join("vendor/libflac-sys-0.3.4/flac/include");
    if !vendored_include.is_dir() {
        panic!(
            "missing FLAC include directory at `{}`",
            vendored_include.display()
        );
    }
    vec![vendored_include.to_string_lossy().into_owned()]
}
