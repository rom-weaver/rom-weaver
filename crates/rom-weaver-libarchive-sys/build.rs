use std::env;
use std::fs;
use std::path::{Path, PathBuf};

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

    let source_dir = if is_wasm_target() {
        prepare_wasm_source_tree(&libarchive_dir, &out_dir)
    } else {
        libarchive_dir
    };

    build_libarchive(&source_dir);
    generate_bindings(&source_dir);
}

fn is_wasm_target() -> bool {
    env::var("CARGO_CFG_TARGET_FAMILY")
        .ok()
        .map(|family| family.split(',').any(|value| value == "wasm"))
        .unwrap_or(false)
}

fn is_wasm_threads_target() -> bool {
    env::var("TARGET")
        .ok()
        .map(|target| target == "wasm32-wasip1-threads")
        .unwrap_or(false)
}

fn prepare_wasm_source_tree(libarchive_dir: &Path, out_dir: &Path) -> PathBuf {
    let staged = out_dir.join("libarchive-wasm-src");
    if staged.exists() {
        fs::remove_dir_all(&staged).expect("failed to clear staged wasm libarchive source tree");
    }
    copy_dir_recursive(libarchive_dir, &staged)
        .expect("failed to stage libarchive source tree for wasm");
    patch_cmakelists_for_wasm(&staged.join("libarchive/CMakeLists.txt"))
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

fn patch_cmakelists_for_wasm(cmakelists_path: &Path) -> std::io::Result<()> {
    let drop_entries = [
        "archive_read_disk_entry_from_file.c",
        "archive_read_disk_posix.c",
        "archive_read_disk_private.h",
        "archive_read_disk_set_standard_lookup.c",
        "archive_read_support_filter_program.c",
        "archive_write_disk_posix.c",
        "archive_write_disk_private.h",
        "archive_write_disk_set_standard_lookup.c",
        "archive_write_add_filter_program.c",
        "archive_write_set_format.c",
        "archive_write_set_format_by_name.c",
        "archive_write_set_format_filter_by_ext.c",
        "archive_write_set_format_iso9660.c",
        "filter_fork_posix.c",
        "filter_fork.h",
    ];
    let content = fs::read_to_string(cmakelists_path)?;
    let filtered = content
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !drop_entries.iter().any(|entry| trimmed == *entry)
        })
        .collect::<Vec<_>>()
        .join("\n");
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
    let wasm_target = is_wasm_target();
    let mut bindgen_builder = bindgen::builder()
        .header("wrapper.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .allowlist_function("archive_.*")
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

    if !wasm_target {
        bindgen_builder = bindgen_builder.raw_line("use libc::{stat, FILE};");
    }

    if !wasm_target && let Ok(target) = env::var("TARGET") {
        bindgen_builder = bindgen_builder.clang_arg(format!("--target={target}"));
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
