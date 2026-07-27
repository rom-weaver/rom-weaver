use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const WASM_PATCH_ROOT: &str = "libarchive/patches/wasm";
const LZMA_SDK_WASM_PATCH_ROOT: &str = "lzma-sdk/patches/wasm";
const VENDORED_LIBARCHIVE: &str = "libarchive/vendor/libarchive";
const VENDORED_LZMA_SDK: &str = "lzma-sdk/vendor/C";
// rom-weaver's own opaque wrapper over the SDK. libarchive ships its own
// IByteIn/IByteOut typedefs (archive_ppmd_private.h), so the SDK headers can
// never be included from libarchive itself - only this glue sees them.
const LZMA_SDK_GLUE: &str = "lzma-sdk/glue";
const LZMA_SDK_GLUE_SOURCES: &[&str] = &["rom_weaver_lzma_sdk.c"];
const WRAPPER_HEADER: &str = "libarchive/wrapper.h";

// 7-Zip's own LZMA SDK, compiled into the 7z read/write paths so they match
// 7zz's coder speed instead of liblzma's. Single-threaded units first, then the
// SDK's thread/mt-coder layer (dropped entirely when Z7_ST is on).
const LZMA_SDK_CORE_SOURCES: &[&str] = &[
    // SeqInStream_ReadMax, which MtCoder/MtDec call.
    "7zStream.c",
    "CpuArch.c",
    "LzFind.c",
    "LzFindOpt.c",
    "Lzma2Dec.c",
    "Lzma2Enc.c",
    "LzmaDec.c",
    "LzmaEnc.c",
];
const LZMA_SDK_THREADED_SOURCES: &[&str] = &["LzFindMt.c", "MtCoder.c", "MtDec.c", "Threads.c"];
// The hand-written LZMA decode loop. Same bitstream as the C fallback and what
// 7zz itself runs; measured ~26% off a 1 GiB LZMA1 extract on arm64. Without it
// the SDK's C decoder is no faster than liblzma's, so this is the whole extract
// win.
//
// arm64 is GNU-as syntax and clang assembles it directly. x86-64 is MASM syntax
// and needs a MASM-compatible assembler at build time; `lzma_sdk_x86_asm_object`
// probes for one and the build silently falls back to the C loop when there is
// none. See docs/development/vendor-code.md for the per-platform matrix.
const VENDORED_LZMA_SDK_ASM: &str = "lzma-sdk/vendor/Asm";
const LZMA_SDK_ARM64_ASM_SOURCES: &[&str] = &["arm64/LzmaDecOpt.S"];
const LZMA_SDK_X86_ASM_SOURCE: &str = "x86/LzmaDecOpt.asm";
// Probed in order. jwasm is first because it is the one that builds from source
// on any host in seconds (Sybase Open Watcom licence, plain C), which is what
// the Docker/CI images install. asmc is upstream's own default and ships a
// prebuilt static Linux binary; uasm is the third MASM-compatible option; ml64
// is MASM proper and is simply already there on a Windows box with MSVC.
const LZMA_SDK_X86_ASSEMBLERS: &[&str] = &["jwasm", "asmc", "asmc64", "uasm", "ml64"];
// Explicit override: an absolute path (or bare command name) to use instead of
// probing. ROM_WEAVER_UASM is accepted as an alias for the same thing.
const LZMA_SDK_ASM_ENV: &[&str] = &["ROM_WEAVER_LZMA_ASM", "ROM_WEAVER_UASM"];
// Every directory whose CMakeLists.txt adds a `test` subdirectory that
// scripts/vendor-libarchive.mjs prunes.
const TEST_SUBDIRECTORY_OWNERS: &[&str] = &["libarchive", "cat", "cpio", "tar", "unzip"];
const WASM_PATCH_FILES: &[&str] = &[
    "archive_write_set_format_wasm_shim.c",
    "archive_util_tempdir.original.txt",
    "archive_util_tempdir.replacement.txt",
    "cmakelists_drop_entries.txt",
];
const LZMA_SDK_WASM_PATCH_FILES: &[&str] = &[
    "lzma-dec-copy-match.original.txt",
    "lzma-dec-copy-match.replacement.txt",
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
    "archive_write_set_bytes_in_last_block",
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
    let lzma_sdk_dir = manifest_dir.join(VENDORED_LZMA_SDK);
    let lzma_glue_dir = manifest_dir.join(LZMA_SDK_GLUE);
    let lzma_asm_dir = manifest_dir.join(VENDORED_LZMA_SDK_ASM);
    println!("cargo:rerun-if-changed={}", lzma_sdk_dir.display());
    println!("cargo:rerun-if-changed={}", lzma_glue_dir.display());
    println!("cargo:rerun-if-changed={}", lzma_asm_dir.display());

    build_libarchive(&source_dir, &lzma_glue_dir, target_sysroot.as_deref());
    // After libarchive: the 7z reader/writer objects inside libarchive.a
    // reference these symbols, and single-pass static linkers only resolve
    // backwards through the link line.
    build_lzma_sdk(
        &manifest_dir,
        &lzma_sdk_dir,
        &lzma_glue_dir,
        &lzma_asm_dir,
        &out_dir,
    );
    generate_bindings(&source_dir, target_sysroot.as_deref());
}

/// Whether the SDK's thread layer - and with it the multithreaded LZMA2
/// *encoder* - is compiled in at all.
///
/// Off for every wasm target, which is why `rom-weaver-app.wasm` encodes 7z
/// with liblzma. The SDK encoder is a blocking one-shot, so the glue drives it
/// from a thread of its own, and the SDK then spawns its match-finder and block
/// threads *from that thread*. Those nested spawns do not survive the browser's
/// WASI thread pool: a run that asked for one thread gets a zero-sized pool and
/// every spawn is EAGAIN, and even with a large pool the nested spawn's start
/// ack times out (measured: `SZ_ERROR_THREAD` carrying errno 6). liblzma's
/// encoder spawns its workers from the main thread instead, so it keeps
/// working, and it is genuinely parallel there - which the SDK encoder would
/// not be if it were forced single-threaded to fit.
///
/// The *decoder* is unaffected and stays on the SDK everywhere: LzmaDec and
/// Lzma2Dec have no threads.
fn lzma_sdk_threads_enabled() -> bool {
    !is_wasm32_target()
}

fn lzma_sdk_arm64_asm_enabled() -> bool {
    !is_wasm32_target()
        && env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("windows")
        && env::var("CARGO_CFG_TARGET_ARCH").ok().as_deref() == Some("aarch64")
}

fn is_x86_64_target() -> bool {
    !is_wasm32_target() && env::var("CARGO_CFG_TARGET_ARCH").ok().as_deref() == Some("x86_64")
}

/// How the target OS wants the SDK's x86-64 assembly packaged, as flags for a
/// MASM-compatible assembler. `None` means no assembler this build knows about
/// can emit the target's object format.
///
/// Mach-O is the gap: jwasm has no Mach-O writer at all, asmc only builds on an
/// x86 host, and uasm carries a `macho64.c` but does not compile on a modern
/// Unix host. So `x86_64-apple-darwin` keeps the C decode loop rather than
/// growing a bespoke object-format shim for it.
fn lzma_sdk_x86_asm_format() -> Option<Vec<String>> {
    match env::var("CARGO_CFG_TARGET_OS").ok().as_deref()? {
        // ABI_LINUX switches 7zAsm.asm to the SysV register order; every
        // SysV-ABI ELF platform wants it, not just Linux.
        "linux" | "android" | "freebsd" | "netbsd" | "openbsd" | "dragonfly" => {
            Some(vec!["-elf64".to_string(), "-DABI_LINUX".to_string()])
        }
        "windows" => Some(vec!["-win64".to_string()]),
        _ => None,
    }
}

fn lzma_sdk_asm_candidates() -> Vec<String> {
    let mut candidates: Vec<String> = LZMA_SDK_ASM_ENV
        .iter()
        .filter_map(|name| {
            println!("cargo:rerun-if-env-changed={name}");
            env::var(name).ok()
        })
        .filter(|value| !value.trim().is_empty())
        .collect();
    if candidates.is_empty() {
        candidates.extend(
            LZMA_SDK_X86_ASSEMBLERS
                .iter()
                .map(|name| (*name).to_string()),
        );
    }
    candidates
}

/// Assemble the SDK's x86-64 decode loop, returning the object to fold into the
/// static library. Every failure path returns `None` after a `cargo:warning`:
/// the assembler is an optimisation, and a machine without one must still get a
/// working build.
fn lzma_sdk_x86_asm_object(asm_dir: &Path, out_dir: &Path) -> Option<PathBuf> {
    let format_flags = match lzma_sdk_x86_asm_format() {
        Some(flags) => flags,
        None => {
            println!(
                "cargo:warning=lzma-sdk: no MASM-compatible assembler emits this target's \
object format, so 7z decode uses the portable C loop (slower than 7zz). See \
docs/development/vendor-code.md."
            );
            return None;
        }
    };

    let source = asm_dir.join(LZMA_SDK_X86_ASM_SOURCE);
    if !source.is_file() {
        println!(
            "cargo:warning=lzma-sdk: {} is missing; 7z decode uses the portable C loop.",
            source.display()
        );
        return None;
    }
    let include_dir = source.parent()?.to_path_buf();
    let object = out_dir.join("lzma_sdk_LzmaDecOpt.o");

    let mut attempted = Vec::new();
    for candidate in lzma_sdk_asm_candidates() {
        // ml64 is MASM proper: MSVC switch syntax, and it has no -elf64 to
        // offer, so it is only ever a Windows answer.
        let is_ml64 = Path::new(&candidate)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| stem.eq_ignore_ascii_case("ml64"))
            .unwrap_or(false);
        let mut command = std::process::Command::new(&candidate);
        if is_ml64 {
            if !format_flags.iter().any(|flag| flag == "-win64") {
                continue;
            }
            command
                .arg("/c")
                .arg(format!("/I{}", include_dir.display()))
                .arg(format!("/Fo{}", object.display()));
        } else {
            // No banner-suppression flag: each assembler spells it
            // differently, and the output is captured either way.
            command
                .arg("-c")
                .args(&format_flags)
                .arg(format!("-I{}", include_dir.display()))
                .arg(format!("-Fo{}", object.display()));
        }
        command.arg(&source);

        let _ = fs::remove_file(&object);
        match command.output() {
            // A missing assembler is the common case, not an error worth
            // reporting per candidate. glibc's posix_spawn reports a failed
            // exec as a child that exited 127 rather than as a spawn error, so
            // that has to count as "not found" too.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(output) if output.status.code() == Some(127) => continue,
            Err(error) => attempted.push(format!("{candidate}: {error}")),
            Ok(output) if output.status.success() && object.is_file() => {
                println!(
                    "cargo:warning=lzma-sdk: assembled the x86-64 LZMA decode loop with {candidate}."
                );
                return Some(object);
            }
            Ok(output) => attempted.push(format!(
                "{candidate}: exited {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr)
                    .trim()
                    .replace('\n', "; ")
            )),
        }
    }

    let detail = if attempted.is_empty() {
        format!(
            "none of {} were found on PATH",
            LZMA_SDK_X86_ASSEMBLERS.join(", ")
        )
    } else {
        attempted.join(" | ")
    };
    println!(
        "cargo:warning=lzma-sdk: no usable MASM-compatible assembler ({detail}), so 7z decode \
uses the portable C loop (slower than 7zz). Install jwasm or set ROM_WEAVER_LZMA_ASM."
    );
    None
}

fn lzma_sdk_wasm_patch_path(manifest_dir: &Path, relative_path: &str) -> PathBuf {
    manifest_dir
        .join(LZMA_SDK_WASM_PATCH_ROOT)
        .join(relative_path)
}

fn prepare_lzma_sdk_wasm_decoder(
    manifest_dir: &Path,
    source_dir: &Path,
    out_dir: &Path,
) -> PathBuf {
    let staged = out_dir.join("lzma-sdk-wasm-LzmaDec.c");
    fs::copy(source_dir.join("LzmaDec.c"), &staged)
        .expect("failed to stage the LZMA SDK decoder for wasm");
    replace_file_fragment(
        &staged,
        &lzma_sdk_wasm_patch_path(manifest_dir, "lzma-dec-copy-match.original.txt"),
        &lzma_sdk_wasm_patch_path(manifest_dir, "lzma-dec-copy-match.replacement.txt"),
        "LZMA SDK wasm distance-1 match copy",
    )
    .expect("failed to patch the LZMA SDK decoder for wasm");
    staged
}

fn build_lzma_sdk(
    manifest_dir: &Path,
    source_dir: &Path,
    glue_dir: &Path,
    asm_dir: &Path,
    out_dir: &Path,
) {
    let mut build = cc::Build::new();
    build
        .include(source_dir)
        .include(glue_dir)
        // Vendored third-party coders that are never stepped through, and the
        // whole point of the swap is coder throughput - a debug-profile build
        // of these makes the test suite unusably slow.
        .opt_level(3)
        .warnings(false)
        .extra_warnings(false);

    // The native assembly fills distance-1 matches a word at a time. The staged
    // wasm source uses memset for the same case, which clang lowers to
    // memory.fill; the vendored SDK snapshot stays byte-for-byte upstream.
    let wasm_decoder = is_wasm32_target()
        .then(|| prepare_lzma_sdk_wasm_decoder(manifest_dir, source_dir, out_dir));
    for source in LZMA_SDK_CORE_SOURCES {
        if *source == "LzmaDec.c"
            && let Some(path) = &wasm_decoder
        {
            build.file(path);
            continue;
        }
        build.file(source_dir.join(source));
    }
    for source in LZMA_SDK_GLUE_SOURCES {
        build.file(glue_dir.join(source));
    }

    if lzma_sdk_threads_enabled() {
        for source in LZMA_SDK_THREADED_SOURCES {
            build.file(source_dir.join(source));
        }
    } else {
        // Z7_ST compiles the SDK's whole mt layer - and the glue's encoder
        // bridge with it - out of the build. wasm32-wasip1 has no threads at
        // all, and wasm32-wasip1-threads cannot nest them (see
        // lzma_sdk_threads_enabled).
        build.define("Z7_ST", None);
    }

    if is_wasm32_target() {
        // wasi-libc has no sched_setaffinity, and the SDK's CPU probe reaches
        // for <cpuid.h>/<sys/auxv.h> that the sysroot does not ship.
        build.define("Z7_AFFINITY_DISABLE", None);
    }

    if lzma_sdk_arm64_asm_enabled() {
        build.define("Z7_LZMA_DEC_OPT", None);
        build.include(asm_dir.join("arm64"));
        for source in LZMA_SDK_ARM64_ASM_SOURCES {
            build.file(asm_dir.join(source));
        }
    } else if is_x86_64_target()
        && let Some(object) =
            lzma_sdk_x86_asm_object(asm_dir, &PathBuf::from(env::var("OUT_DIR").unwrap()))
    {
        // Assembled ahead of cc's own invocation because it is MASM syntax that
        // no C compiler driver understands; the object just joins the archive.
        build.define("Z7_LZMA_DEC_OPT", None);
        build.object(object);
    }

    build.compile("lzma_sdk");
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
    for patch_file in LZMA_SDK_WASM_PATCH_FILES {
        println!(
            "cargo:rerun-if-changed={}",
            lzma_sdk_wasm_patch_path(manifest_dir, patch_file).display()
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
    let normalize_line_endings = |fragment: String| {
        let fragment = fragment.replace("\r\n", "\n");
        if content.contains("\r\n") {
            fragment.replace('\n', "\r\n")
        } else {
            fragment
        }
    };
    let original = normalize_line_endings(fs::read_to_string(original_fragment_path)?);
    let replacement = normalize_line_endings(fs::read_to_string(replacement_fragment_path)?);

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

fn build_libarchive(libarchive_dir: &Path, lzma_glue_dir: &Path, target_sysroot: Option<&Path>) {
    // The 7z reader/writer compile against the glue header only - never the SDK
    // headers - and gate every SDK code path on this define, so a source tree
    // without the vendor drop still builds on liblzma alone.
    // Z7_ST never reaches here: it changes no public SDK header, only which
    // translation units build_lzma_sdk compiles.
    let mut sdk_flags = vec![
        "-DROM_WEAVER_LZMA_SDK=1".to_string(),
        format!("-I{}", lzma_glue_dir.display()),
    ];
    if lzma_sdk_threads_enabled() {
        sdk_flags.push("-DROM_WEAVER_LZMA_SDK_MT=1".to_string());
    }
    let mut cmake_config = cmake::Config::new(libarchive_dir);
    for flag in &sdk_flags {
        cmake_config.cflag(flag);
    }
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
        let mut target_flags = wasm_cmake_flags(&target);
        // An explicit -DCMAKE_C_FLAGS wins over the CFLAGS env var cmake-rs
        // derives from cflag(), so the SDK flags have to be folded in here too.
        target_flags.extend(sdk_flags.iter().cloned());
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
