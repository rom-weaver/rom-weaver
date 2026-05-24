use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const WASM_PATCH_ROOT: &str = "patches/wasm";
const WASM_PATCH_FILES: &[&str] = &[
    "archive_write_set_format_wasm_shim.c",
    "archive_util_tempdir.original.txt",
    "archive_util_tempdir.replacement.txt",
    "cmakelists_drop_entries.txt",
];

const WASM_BINDGEN_FUNCTIONS: &[&str] = &[
    "archive_free",
    "archive_errno",
    "archive_error_string",
    "archive_format",
    "archive_set_error",
    "archive_read_new",
    "archive_read_support_filter_bzip2",
    "archive_read_support_filter_compress",
    "archive_read_support_filter_gzip",
    "archive_read_support_filter_lzip",
    "archive_read_support_filter_lzma",
    "archive_read_support_filter_rpm",
    "archive_read_support_filter_uu",
    "archive_read_support_filter_xz",
    "archive_read_support_filter_zstd",
    "archive_read_support_format_7zip",
    "archive_read_support_format_ar",
    "archive_read_support_format_cab",
    "archive_read_support_format_cpio",
    "archive_read_support_format_empty",
    "archive_read_support_format_iso9660",
    "archive_read_support_format_lha",
    "archive_read_support_format_mtree",
    "archive_read_support_format_rar",
    "archive_read_support_format_rar5",
    "archive_read_support_format_raw",
    "archive_read_support_format_tar",
    "archive_read_support_format_warc",
    "archive_read_support_format_zip",
    "archive_read_set_seek_callback",
    "archive_read_open2",
    "archive_read_open_filename",
    "archive_read_next_header",
    "archive_read_data",
    "archive_seek_data",
    "archive_read_close",
    "archive_read_free",
    "archive_write_new",
    "archive_write_set_format_7zip",
    "archive_write_set_format_pax_restricted",
    "archive_write_set_format_raw",
    "archive_write_set_format_zip",
    "archive_write_add_filter_none",
    "archive_write_add_filter_gzip",
    "archive_write_add_filter_bzip2",
    "archive_write_add_filter_xz",
    "archive_write_add_filter_zstd",
    "archive_write_open_filename",
    "archive_write_header",
    "archive_write_data",
    "archive_write_finish_entry",
    "archive_write_close",
    "archive_write_free",
    "archive_write_set_format_option",
    "archive_write_set_filter_option",
    "archive_entry_free",
    "archive_entry_new",
    "archive_entry_filetype",
    "archive_entry_pathname",
    "archive_entry_pathname_utf8",
    "archive_entry_size",
    "archive_entry_size_is_set",
    "archive_entry_set_filetype",
    "archive_entry_set_pathname",
    "archive_entry_set_perm",
    "archive_entry_set_size",
];

fn lib_filename(lib_name: &str) -> String {
    if env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows" {
        format!("{lib_name}.lib")
    } else {
        format!("lib{lib_name}.a")
    }
}

fn lib_path<'a>(
    prefix_env_name: &'a str,
    path_components: impl IntoIterator<Item = &'a str>,
    lib_name: &'a str,
) -> String {
    use path_slash::PathBufExt as _;

    let mut path = PathBuf::from(env::var(prefix_env_name).unwrap());
    for component in path_components {
        path.push(component);
    }
    path.push(lib_filename(lib_name));

    path.to_slash()
        .expect("failed to convert path to slash style")
        .into_owned()
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let libarchive_dir = manifest_dir.join("../../vendor/libarchive");
    if !libarchive_dir.exists() {
        panic!(
            "libarchive submodule is missing at {}. Run `git submodule update --init --recursive vendor/libarchive`.",
            libarchive_dir.display()
        );
    }

    println!("cargo:rerun-if-changed={}", libarchive_dir.display());
    emit_wasm_patch_rerun_if_changed(&manifest_dir);

    let source_dir = if is_wasm32_target() {
        prepare_wasm_source_tree(&manifest_dir, &libarchive_dir, &out_dir)
    } else {
        libarchive_dir
    };

    build_libarchive(&source_dir);
    generate_bindings(&source_dir);
}

fn is_wasm32_target() -> bool {
    env::var("CARGO_CFG_TARGET_ARCH")
        .ok()
        .map(|arch| arch == "wasm32")
        .unwrap_or(false)
}

fn is_wasm_threads_target() -> bool {
    env::var("TARGET")
        .ok()
        .map(|target| target == "wasm32-wasip1-threads")
        .unwrap_or(false)
}

fn target_tool_env(tool: &str) -> Option<String> {
    let target = env::var("TARGET").ok()?;
    let target_key = target.replace('-', "_");
    env::var(format!("{tool}_{target_key}"))
        .ok()
        .or_else(|| env::var(tool).ok())
}

fn wasm_patch_path(manifest_dir: &Path, relative_path: &str) -> PathBuf {
    manifest_dir.join(WASM_PATCH_ROOT).join(relative_path)
}

fn emit_wasm_patch_rerun_if_changed(manifest_dir: &Path) {
    for patch_file in WASM_PATCH_FILES {
        println!(
            "cargo:rerun-if-changed={}",
            wasm_patch_path(manifest_dir, patch_file).display()
        );
    }
}

fn prepare_wasm_source_tree(manifest_dir: &Path, libarchive_dir: &Path, out_dir: &Path) -> PathBuf {
    let staged = out_dir.join("libarchive-wasm-src");
    if staged.exists() {
        fs::remove_dir_all(&staged).expect("failed to clear staged wasm libarchive source tree");
    }
    copy_dir_recursive(libarchive_dir, &staged)
        .expect("failed to stage libarchive source tree for wasm");
    add_wasm_archive_write_format_shim(manifest_dir, &staged.join("libarchive"))
        .expect("failed to add wasm libarchive format shim");
    patch_archive_util_tempdir_for_wasm(manifest_dir, &staged.join("libarchive/archive_util.c"))
        .expect("failed to patch libarchive temporary directory fallback for wasm");
    patch_cmakelists_for_wasm(manifest_dir, &staged.join("libarchive/CMakeLists.txt"))
        .expect("failed to patch libarchive CMakeLists.txt for wasm");
    staged
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let entry_path = entry.path();
        let target_path = destination.join(entry.file_name());
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            copy_dir_recursive(&entry_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&entry_path, &target_path)?;
        }
    }
    Ok(())
}

fn add_wasm_archive_write_format_shim(
    manifest_dir: &Path,
    libarchive_source_dir: &Path,
) -> std::io::Result<()> {
    let shim_source = fs::read_to_string(wasm_patch_path(
        manifest_dir,
        "archive_write_set_format_wasm_shim.c",
    ))?;
    fs::write(
        libarchive_source_dir.join("archive_write_set_format_wasm_shim.c"),
        shim_source,
    )?;
    Ok(())
}

fn replace_file_fragment(
    target_path: &Path,
    original_fragment_path: &Path,
    replacement_fragment_path: &Path,
    description: &str,
) -> std::io::Result<()> {
    let content = fs::read_to_string(target_path)?;
    let original = fs::read_to_string(original_fragment_path)?;
    let replacement = fs::read_to_string(replacement_fragment_path)?;

    if content.contains(&replacement) {
        return Ok(());
    }

    let patched = content.replace(&original, &replacement);
    if patched == content {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{description} was not found in {}", target_path.display()),
        ));
    }

    fs::write(target_path, patched)?;
    Ok(())
}

fn patch_archive_util_tempdir_for_wasm(
    manifest_dir: &Path,
    archive_util_path: &Path,
) -> std::io::Result<()> {
    replace_file_fragment(
        archive_util_path,
        &wasm_patch_path(manifest_dir, "archive_util_tempdir.original.txt"),
        &wasm_patch_path(manifest_dir, "archive_util_tempdir.replacement.txt"),
        "libarchive archive_util.c tempdir fallback block",
    )
}

fn patch_cmakelists_for_wasm(manifest_dir: &Path, cmakelists_path: &Path) -> std::io::Result<()> {
    let drop_entries_path = wasm_patch_path(manifest_dir, "cmakelists_drop_entries.txt");
    let drop_entries: HashSet<String> = fs::read_to_string(drop_entries_path)?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(ToOwned::to_owned)
        .collect();

    let content = fs::read_to_string(cmakelists_path)?;
    let mut lines = Vec::new();
    let mut shim_inserted = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if drop_entries.contains(trimmed) {
            continue;
        }
        lines.push(line);
        if !shim_inserted && trimmed == "archive_write_set_format_private.h" {
            lines.push("  archive_write_set_format_wasm_shim.c");
            shim_inserted = true;
        }
    }
    let filtered = lines.join("\n");
    fs::write(cmakelists_path, format!("{filtered}\n"))?;
    Ok(())
}

fn build_libarchive(libarchive_dir: &Path) {
    let mut cmake_config = cmake::Config::new(libarchive_dir);
    cmake_config
        .build_target("archive_static")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("CMAKE_POLICY_VERSION_MINIMUM", "3.5")
        .define("ENABLE_LIBXML2", "OFF")
        .define("ENABLE_LZO", "OFF")
        .define("ENABLE_PCREPOSIX", "OFF")
        .define("POSIX_REGEX_LIB", "NONE")
        .define("ENABLE_NETTLE", "OFF")
        .define("ENABLE_EXPAT", "OFF")
        .define("ENABLE_LIBGCC", "OFF")
        .define("ENABLE_LIBB2", "OFF")
        .define("ENABLE_TEST", "OFF")
        .define("ENABLE_TAR", "OFF")
        .define("ENABLE_CPIO", "OFF")
        .define("ENABLE_CAT", "OFF")
        .define("ENABLE_UNZIP", "OFF")
        .define("ENABLE_WERROR", "OFF");

    if is_wasm_threads_target() {
        let mut thread_flags = vec![
            "-ffunction-sections".to_string(),
            "-fdata-sections".to_string(),
            "--target=wasm32-wasip1-threads".to_string(),
            "-matomics".to_string(),
            "-mbulk-memory".to_string(),
            "-w".to_string(),
        ];
        if let Ok(sysroot) = env::var("WASI_SYSROOT")
            && !sysroot.trim().is_empty()
        {
            thread_flags.push(format!("--sysroot={sysroot}"));
        }
        let joined = thread_flags.join(" ");
        cmake_config
            .no_default_flags(true)
            .define("CMAKE_C_COMPILER_TARGET", "wasm32-wasip1-threads")
            .define("CMAKE_CXX_COMPILER_TARGET", "wasm32-wasip1-threads")
            .define("CMAKE_ASM_COMPILER_TARGET", "wasm32-wasip1-threads")
            .define("CMAKE_C_FLAGS", joined.as_str())
            .define("CMAKE_CXX_FLAGS", joined.as_str())
            .define("CMAKE_ASM_FLAGS", joined.as_str());
    }

    if is_wasm32_target() {
        if let Some(ar) = target_tool_env("AR") {
            cmake_config.define("CMAKE_AR", ar);
        }
        if let Some(ranlib) = target_tool_env("RANLIB") {
            cmake_config.define("CMAKE_RANLIB", ranlib);
        }
    }

    if env::var("DEP_OPENSSL_VERSION").is_ok() {
        cmake_config
            .define("ENABLE_OPENSSL", "ON")
            .define("CMAKE_REQUIRE_FIND_PACKAGE_OpenSSL", "TRUE")
            .define("OPENSSL_ROOT_DIR", env::var("DEP_OPENSSL_ROOT").unwrap());
    } else {
        cmake_config.define("ENABLE_OPENSSL", "OFF");
    }

    cmake_config
        .define("ENABLE_LZMA", "ON")
        .define("CMAKE_REQUIRE_FIND_PACKAGE_LibLZMA", "TRUE")
        .define("LIBLZMA_INCLUDE_DIR", env::var("DEP_LZMA_INCLUDE").unwrap())
        .define("LIBLZMA_LIBRARY", lib_path("DEP_LZMA_ROOT", [], "lzma"));

    cmake_config
        .define("ENABLE_LZ4", "ON")
        .define("CMAKE_REQUIRE_FIND_PACKAGE_lz4", "TRUE")
        .define("LZ4_INCLUDE_DIR", env::var("DEP_LZ4_INCLUDE").unwrap())
        .define("LZ4_LIBRARY", lib_path("DEP_LZ4_ROOT", [], "lz4"));

    cmake_config
        .define("ENABLE_ZSTD", "ON")
        .define("ZSTD_INCLUDE_DIR", env::var("DEP_ZSTD_INCLUDE").unwrap())
        .define("ZSTD_LIBRARY", lib_path("DEP_ZSTD_ROOT", [], "zstd"));

    cmake_config
        .define("ENABLE_BZip2", "ON")
        .define("CMAKE_REQUIRE_FIND_PACKAGE_BZip2", "TRUE")
        .define("BZIP2_INCLUDE_DIR", env::var("DEP_BZIP2_INCLUDE").unwrap())
        .define(
            "BZIP2_LIBRARIES",
            lib_path("DEP_BZIP2_ROOT", ["lib"], "bz2"),
        );

    cmake_config
        .define("ENABLE_ZLIB", "ON")
        .define("CMAKE_REQUIRE_FIND_PACKAGE_zlib", "TRUE")
        .define("ZLIB_INCLUDE_DIR", env::var("DEP_Z_INCLUDE").unwrap())
        .define("ZLIB_LIBRARY", lib_path("DEP_Z_ROOT", ["lib"], "z"));

    if env::var("CARGO_CFG_TARGET_ENV").unwrap() == "msvc" {
        cmake_config.generator("Ninja");
    }

    let cmake_out = cmake_config.build();
    let build_root = cmake_out.join("build");
    for candidate in [
        build_root.join("libarchive"),
        build_root.join("libarchive/Release"),
        build_root.join("libarchive/Debug"),
        cmake_out.join("lib"),
    ] {
        if candidate.exists() {
            println!("cargo:rustc-link-search=native={}", candidate.display());
        }
    }

    println!(
        "cargo:rustc-link-lib=static={}",
        if env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows" {
            "archive_static"
        } else {
            "archive"
        }
    );

    if env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows" {
        println!("cargo:rustc-link-lib=User32");
        println!("cargo:rustc-link-lib=Crypt32");
    }
}

fn generate_bindings(libarchive_dir: &Path) {
    println!("cargo:rerun-if-changed=wrapper.h");
    println!(
        "cargo:rerun-if-changed={}",
        libarchive_dir.join("libarchive/archive.h").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        libarchive_dir.join("libarchive/archive_entry.h").display()
    );

    let include_path = libarchive_dir.join("libarchive");
    let wasm_target = is_wasm32_target();
    let mut bindgen_builder = bindgen::builder()
        .header("wrapper.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .allowlist_var("ARCHIVE_.*")
        .allowlist_type("archive")
        .allowlist_type("archive_.*")
        .allowlist_type("archive_entry")
        .allowlist_type("la_.*")
        .blocklist_type("FILE")
        .blocklist_type("timespec")
        .blocklist_type("stat")
        .default_macro_constant_type(bindgen::MacroTypeVariation::Signed)
        .clang_args([
            "-I",
            include_path
                .to_str()
                .expect("libarchive include path should be valid UTF-8"),
        ]);

    if wasm_target {
        for function in WASM_BINDGEN_FUNCTIONS {
            bindgen_builder = bindgen_builder.allowlist_function(function);
        }
        bindgen_builder = bindgen_builder
            .blocklist_type("mode_t")
            .raw_line("pub type mode_t = libc::mode_t;");
        if let Ok(host) = env::var("HOST") {
            bindgen_builder = bindgen_builder.clang_arg(format!("--target={host}"));
        }
    } else {
        bindgen_builder = bindgen_builder
            .allowlist_function("archive_.*")
            .raw_line("use libc::{stat, FILE};");
        if let Ok(target) = env::var("TARGET") {
            bindgen_builder = bindgen_builder.clang_arg(format!("--target={target}"));
        }
    }

    if let Ok(sysroot) = env::var("WASI_SYSROOT")
        && !sysroot.trim().is_empty()
    {
        bindgen_builder = bindgen_builder.clang_arg(format!("--sysroot={sysroot}"));
    }

    let bindings = bindgen_builder
        .generate()
        .expect("failed to generate bindings");
    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("failed to write bindings");
}
