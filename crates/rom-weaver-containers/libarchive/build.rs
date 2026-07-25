use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const WASM_PATCH_ROOT: &str = "libarchive/patches/wasm";
const VENDORED_LIBARCHIVE: &str = "libarchive/vendor/libarchive";
const WRAPPER_HEADER: &str = "libarchive/wrapper.h";
// Every directory whose CMakeLists.txt adds a `test` subdirectory that
// scripts/vendor-libarchive.mjs prunes.
const TEST_SUBDIRECTORY_OWNERS: &[&str] = &["libarchive", "cat", "cpio", "tar", "unzip"];
const WASM_PATCH_FILES: &[&str] = &[
    "archive_write_set_format_wasm_shim.c",
    "archive_util_tempdir.original.txt",
    "archive_util_tempdir.replacement.txt",
    "cmakelists_drop_entries.txt",
];

const WASM_BINDGEN_READ_FUNCTIONS: &[&str] = &[
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
    "archive_entry_filetype",
    "archive_entry_pathname",
    "archive_entry_pathname_utf8",
    "archive_entry_size",
    "archive_entry_size_is_set",
];

const WASM_BINDGEN_WRITE_FUNCTIONS: &[&str] = &[
    "archive_write_new",
    "archive_write_set_format_7zip",
    "archive_write_set_format_zip",
    "archive_write_add_filter_none",
    "archive_write_set_format_7zip_progress_callback",
    "archive_write_set_format_7zip_size_hint",
    "archive_write_open",
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
    "archive_entry_set_filetype",
    "archive_entry_set_pathname",
    "archive_entry_set_perm",
    "archive_entry_set_size",
];

const WASM_BINDGEN_WRITE_EXTRA_FUNCTIONS: &[&str] = &[
    "archive_write_set_format_pax_restricted",
    "archive_write_set_format_raw",
    "archive_write_add_filter_gzip",
    "archive_write_add_filter_bzip2",
    "archive_write_add_filter_xz",
    "archive_write_add_filter_zstd",
];

const WRITE_ALWAYS_DROP_ENTRIES: &[&str] = &[
    "archive_write_add_filter.c",
    "archive_write_add_filter_program.c",
    "archive_write_disk_posix.c",
    "archive_write_disk_private.h",
    "archive_write_disk_set_standard_lookup.c",
    "archive_write_disk_windows.c",
    "archive_write_open_file.c",
    "archive_write_open_memory.c",
    "archive_write_set_format.c",
    "archive_write_set_format_by_name.c",
    "archive_write_set_format_filter_by_ext.c",
    "archive_write_set_format_iso9660.c",
];

const WRITE_CORE_DROP_ENTRIES: &[&str] = &[
    "archive_write.c",
    "archive_write_add_filter_none.c",
    "archive_write_open_fd.c",
    "archive_write_open_filename.c",
    "archive_write_private.h",
    "archive_write_set_format_7zip.c",
    "archive_write_set_format_private.h",
    "archive_write_set_format_wasm_shim.c",
    "archive_write_set_format_zip.c",
    "archive_write_set_options.c",
    "archive_write_set_passphrase.c",
];

const WRITE_EXTRA_DROP_ENTRIES: &[&str] = &[
    "archive_write_add_filter_b64encode.c",
    "archive_write_add_filter_by_name.c",
    "archive_write_add_filter_bzip2.c",
    "archive_write_add_filter_compress.c",
    "archive_write_add_filter_grzip.c",
    "archive_write_add_filter_gzip.c",
    "archive_write_add_filter_lrzip.c",
    "archive_write_add_filter_lz4.c",
    "archive_write_add_filter_lzop.c",
    "archive_write_add_filter_uuencode.c",
    "archive_write_add_filter_xz.c",
    "archive_write_add_filter_zstd.c",
    "archive_write_set_format_ar.c",
    "archive_write_set_format_cpio.c",
    "archive_write_set_format_cpio_binary.c",
    "archive_write_set_format_cpio_newc.c",
    "archive_write_set_format_cpio_odc.c",
    "archive_write_set_format_gnutar.c",
    "archive_write_set_format_mtree.c",
    "archive_write_set_format_pax.c",
    "archive_write_set_format_raw.c",
    "archive_write_set_format_shar.c",
    "archive_write_set_format_ustar.c",
    "archive_write_set_format_v7tar.c",
    "archive_write_set_format_warc.c",
    "archive_write_set_format_xar.c",
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

pub fn build() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let libarchive_dir = manifest_dir.join(VENDORED_LIBARCHIVE);

    println!("cargo:rerun-if-changed={}", libarchive_dir.display());
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_LIBARCHIVE_WRITE_EXTRA");
    emit_wasm_patch_rerun_if_changed(&manifest_dir);

    let source_dir = prepare_source_tree(&manifest_dir, &libarchive_dir, &out_dir);
    let target_sysroot = target_compiler_sysroot();

    build_libarchive(&source_dir, target_sysroot.as_deref());
    generate_bindings(&source_dir, target_sysroot.as_deref());
}

fn target_compiler_sysroot() -> Option<PathBuf> {
    if env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() != Some("musl") {
        return None;
    }

    let compiler = cc::Build::new().get_compiler();
    let output = compiler.to_command().arg("--print-sysroot").output().ok()?;
    if !output.status.success() {
        return None;
    }

    let sysroot = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    sysroot.is_dir().then_some(sysroot)
}

fn is_wasm32_target() -> bool {
    env::var("CARGO_CFG_TARGET_ARCH")
        .ok()
        .map(|arch| arch == "wasm32")
        .unwrap_or(false)
}

fn feature_enabled(name: &str) -> bool {
    let key = name.replace('-', "_").to_ascii_uppercase();
    env::var(format!("CARGO_FEATURE_{key}")).is_ok()
}

fn write_archives_enabled() -> bool {
    true
}

fn write_extra_enabled() -> bool {
    feature_enabled("libarchive-write-extra")
}

fn is_wasm_threads_target() -> bool {
    env::var("TARGET")
        .ok()
        .map(|target| target == "wasm32-wasip1-threads")
        .unwrap_or(false)
}

fn wasm_cmake_flags(target: &str) -> Vec<String> {
    let mut flags = vec![
        "-ffunction-sections".to_string(),
        "-fdata-sections".to_string(),
        format!("--target={target}"),
        "-msimd128".to_string(),
        "-O3".to_string(),
        "-flto=thin".to_string(),
        "-w".to_string(),
    ];
    if target == "wasm32-wasip1-threads" {
        flags.push("-matomics".to_string());
        flags.push("-mbulk-memory".to_string());
    }
    if let Ok(sysroot) = env::var("WASI_SYSROOT")
        && !sysroot.trim().is_empty()
    {
        flags.push(format!("--sysroot={sysroot}"));
    }
    flags
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

fn prepare_source_tree(manifest_dir: &Path, libarchive_dir: &Path, out_dir: &Path) -> PathBuf {
    let wasm_target = is_wasm32_target();
    let staged = out_dir.join(if wasm_target {
        "libarchive-wasm-src"
    } else {
        "libarchive-src"
    });
    if staged.exists() {
        fs::remove_dir_all(&staged).expect("failed to clear staged libarchive source tree");
    }
    if !libarchive_dir.join("CMakeLists.txt").is_file() {
        panic!(
            "vendored libarchive source is missing from {}; refresh it with scripts/vendor-libarchive.mjs",
            libarchive_dir.display()
        );
    }
    // Every step below rewrites sources in place, so they all run against this
    // staged copy; the vendored tree stays a verbatim snapshot of the fork.
    copy_dir_recursive(libarchive_dir, &staged).expect("failed to stage libarchive source tree");
    drop_test_subdirectories(&staged).expect("failed to drop libarchive test subdirectories");
    let write_archives = write_archives_enabled();
    let write_extra = write_extra_enabled();
    if write_archives {
        add_wasm_archive_write_format_shim(manifest_dir, &staged.join("libarchive"))
            .expect("failed to add libarchive format shim");
    }
    if wasm_target {
        patch_archive_util_tempdir_for_wasm(
            manifest_dir,
            &staged.join("libarchive/archive_util.c"),
        )
        .expect("failed to patch libarchive temporary directory fallback for wasm");
    }
    if wasm_target && write_archives {
        patch_archive_write_set_format_7zip_for_wasm(
            &staged.join("libarchive/archive_write_set_format_7zip.c"),
        )
        .expect("failed to patch libarchive 7zip defaults for wasm");
    }
    patch_cmakelists(
        manifest_dir,
        &staged.join("libarchive/CMakeLists.txt"),
        wasm_target,
        write_archives,
        write_extra,
    )
    .expect("failed to patch libarchive CMakeLists.txt");
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

fn patch_archive_write_set_format_7zip_for_wasm(sevenz_path: &Path) -> std::io::Result<()> {
    let content = fs::read_to_string(sevenz_path)?;
    let patched_threads = content.replace("zip->opt_threads = 1;", "zip->opt_threads = 0;");
    if patched_threads == content {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "libarchive 7zip default thread assignment was not found in {}",
                sevenz_path.display()
            ),
        ));
    }

    let patched_workers = patched_threads.replace(
        "ZSTD_CCtx_setParameter(strm, ZSTD_c_nbWorkers, threads);",
        "if (threads > 1)\n\t\tZSTD_CCtx_setParameter(strm, ZSTD_c_nbWorkers, threads);",
    );
    if patched_workers == patched_threads {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "libarchive 7zip zstd worker assignment was not found in {}",
                sevenz_path.display()
            ),
        ));
    }

    fs::write(sevenz_path, patched_workers)?;
    Ok(())
}

// Upstream adds each `test` subdirectory unconditionally and lets the test tree
// itself check ENABLE_TEST, so a source tree pruned of test data fails to
// configure even with tests off. Drop the calls in the staged copy rather than
// in the vendored tree, which stays a verbatim snapshot of the fork.
fn drop_test_subdirectories(staged: &Path) -> std::io::Result<()> {
    for component in TEST_SUBDIRECTORY_OWNERS {
        let cmakelists_path = staged.join(component).join("CMakeLists.txt");
        if !cmakelists_path.is_file() {
            continue;
        }
        let content = fs::read_to_string(&cmakelists_path)?;
        let mut patched = String::with_capacity(content.len());
        let mut dropped = false;
        for line in content.lines() {
            if line.trim().eq_ignore_ascii_case("add_subdirectory(test)") {
                dropped = true;
                continue;
            }
            patched.push_str(line);
            patched.push('\n');
        }
        if !dropped {
            panic!(
                "expected an add_subdirectory(test) call in {}; the vendored libarchive layout changed",
                cmakelists_path.display()
            );
        }
        fs::write(&cmakelists_path, patched)?;
    }
    Ok(())
}

fn patch_cmakelists(
    manifest_dir: &Path,
    cmakelists_path: &Path,
    wasm_target: bool,
    write_archives: bool,
    write_extra: bool,
) -> std::io::Result<()> {
    let mut drop_entries = HashSet::new();
    if wasm_target {
        let drop_entries_path = wasm_patch_path(manifest_dir, "cmakelists_drop_entries.txt");
        drop_entries.extend(
            fs::read_to_string(drop_entries_path)?
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .map(ToOwned::to_owned),
        );
    }
    drop_entries.extend(
        WRITE_ALWAYS_DROP_ENTRIES
            .iter()
            .map(|entry| (*entry).to_owned()),
    );
    if !write_archives {
        drop_entries.extend(
            WRITE_CORE_DROP_ENTRIES
                .iter()
                .map(|entry| (*entry).to_owned()),
        );
    }
    if !write_extra {
        drop_entries.extend(
            WRITE_EXTRA_DROP_ENTRIES
                .iter()
                .map(|entry| (*entry).to_owned()),
        );
    }

    let content = fs::read_to_string(cmakelists_path)?;
    let mut lines = Vec::new();
    let mut shim_inserted = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if should_drop_cmakelists_line(trimmed, &drop_entries) {
            continue;
        }
        lines.push(line);
        if write_archives && !shim_inserted && trimmed == "archive_write_set_format_private.h" {
            lines.push("  archive_write_set_format_wasm_shim.c");
            shim_inserted = true;
        }
    }
    let filtered = lines.join("\n");
    fs::write(cmakelists_path, format!("{filtered}\n"))?;
    Ok(())
}

fn should_drop_cmakelists_line(trimmed: &str, drop_entries: &HashSet<String>) -> bool {
    if drop_entries.contains(trimmed) {
        return true;
    }
    trimmed.starts_with("LIST(APPEND libarchive_SOURCES ")
        && drop_entries.iter().any(|entry| trimmed.contains(entry))
}

fn build_libarchive(libarchive_dir: &Path, target_sysroot: Option<&Path>) {
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

    if let Some(sysroot) = target_sysroot {
        cmake_config.define("ICONV_INCLUDE_DIR", sysroot.join("include"));
    }

    if is_wasm32_target() {
        let target = env::var("TARGET").unwrap_or_else(|_| "wasm32-wasip1".to_string());
        let target_flags = wasm_cmake_flags(&target);
        let joined = target_flags.join(" ");
        cmake_config
            .define("CMAKE_C_COMPILER_TARGET", target.as_str())
            .define("CMAKE_CXX_COMPILER_TARGET", target.as_str())
            .define("CMAKE_ASM_COMPILER_TARGET", target.as_str())
            .define("CMAKE_C_FLAGS", joined.as_str())
            .define("CMAKE_CXX_FLAGS", joined.as_str())
            .define("CMAKE_ASM_FLAGS", joined.as_str())
            // CMake's cross-compile probe can miss this symbol on WASI even
            // when zstd is linked and usable via current headers.
            .define("HAVE_ZSTD_compressStream", "1");
    }

    if is_wasm_threads_target() {
        cmake_config
            .no_default_flags(true)
            // The libarchive CMake probe for lzma_stream_encoder_mt is a
            // cross-compile try-compile that currently fails for WASI threads,
            // even though liblzma-sys is built with its parallel API enabled.
            // Force the detected define so xz filters can use liblzma MT.
            .define("HAVE_LZMA_STREAM_ENCODER_MT", "1");
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

    // The cmake target is `archive_static`, but upstream renames its output to
    // plain `archive` whenever BUILD_SHARED_LIBS is off (which this build
    // always sets), on Windows included - so the artifact is archive.lib /
    // libarchive.a everywhere and the link name is unconditional.
    println!("cargo:rustc-link-lib=static=archive");

    if env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows" {
        println!("cargo:rustc-link-lib=User32");
        println!("cargo:rustc-link-lib=Crypt32");
    }
}

fn generate_bindings(libarchive_dir: &Path, target_sysroot: Option<&Path>) {
    println!("cargo:rerun-if-changed={WRAPPER_HEADER}");
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
        .header(WRAPPER_HEADER)
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
        let write_archives = write_archives_enabled();
        let write_extra = write_extra_enabled();
        for function in WASM_BINDGEN_READ_FUNCTIONS {
            bindgen_builder = bindgen_builder.allowlist_function(function);
        }
        if write_archives {
            for function in WASM_BINDGEN_WRITE_FUNCTIONS {
                bindgen_builder = bindgen_builder.allowlist_function(function);
            }
        }
        if write_extra {
            for function in WASM_BINDGEN_WRITE_EXTRA_FUNCTIONS {
                bindgen_builder = bindgen_builder.allowlist_function(function);
            }
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

    if let Some(sysroot) = target_sysroot {
        bindgen_builder = bindgen_builder.clang_arg(format!("--sysroot={}", sysroot.display()));
    }

    // WASI-only: the sysroot must not reach a host build. .mise.toml exports
    // WASI_SYSROOT for every task, so an unguarded --sysroot points the host
    // bindgen at the WASI tree and it fails on missing headers like sys/stat.h.
    if wasm_target
        && let Ok(sysroot) = env::var("WASI_SYSROOT")
        && !sysroot.trim().is_empty()
    {
        bindgen_builder = bindgen_builder.clang_arg(format!("--sysroot={sysroot}"));
        // wasi-sdk >= 25 scopes headers per triple (include/<triple>/sys/stat.h)
        // and ships no flat include/sys. bindgen parses with --target=<host>
        // above, so clang derives <sysroot>/include and finds nothing; name the
        // triple directory explicitly. Linux fails outright without this; macOS
        // hides it by falling back to the host SDK headers.
        if let Ok(target) = env::var("TARGET") {
            let triple_include = PathBuf::from(&sysroot).join("include").join(&target);
            if triple_include.is_dir() {
                bindgen_builder =
                    bindgen_builder.clang_arg(format!("-I{}", triple_include.display()));
            }
        }
    }

    let bindings = bindgen_builder
        .generate()
        .expect("failed to generate bindings");
    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("failed to write bindings");
}
