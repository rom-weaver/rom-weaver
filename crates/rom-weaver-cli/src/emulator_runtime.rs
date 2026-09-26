use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use clap::{Args, Subcommand};
use flate2::read::GzDecoder;
use rom_weaver_core::{IoOp, IoResultExt, Result, RomWeaverError, TempPathAllocator};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const PLATFORM: &str = "linux-x64-gnu";
const ARCHIVE_NAME: &str = "rom-weaver-emulator-linux-x64-gnu.tar.gz";
const MAX_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Args)]
pub(crate) struct EmulatorCommand {
    #[command(subcommand)]
    command: EmulatorSubcommand,
}

#[derive(Debug, Subcommand)]
enum EmulatorSubcommand {
    /// Install the optional NES runtime for this release (Linux x64/glibc).
    Install(InstallCommand),
    /// Check the installed runtime and show its source revisions.
    Info {
        /// Use this runtime directory instead of the versioned user data directory.
        #[arg(long, value_name = "DIR")]
        runtime_dir: Option<PathBuf>,
    },
}

#[derive(Debug, Args)]
struct InstallCommand {
    /// Install a local runtime archive instead of downloading this release's pack.
    #[arg(long, value_name = "FILE", requires = "sha256")]
    archive: Option<PathBuf>,
    /// Expected SHA-256 of the local archive.
    #[arg(long, value_name = "HEX", requires = "archive")]
    sha256: Option<String>,
    /// Install in this directory instead of the versioned user data directory.
    #[arg(long, value_name = "DIR")]
    runtime_dir: Option<PathBuf>,
}

#[derive(Debug)]
pub(crate) struct EmulatorRuntime {
    pub(crate) root: PathBuf,
    pub(crate) retroarch: PathBuf,
    pub(crate) core: PathBuf,
    pub(crate) retroarch_revision: String,
    pub(crate) core_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    platform: String,
    retroarch: RuntimeFile,
    cores: Vec<CoreFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeFile {
    path: String,
    revision: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CoreFile {
    id: String,
    platform: String,
    path: String,
    revision: String,
    sha256: String,
}

fn invalid(message: impl Into<String>) -> RomWeaverError {
    RomWeaverError::Validation(message.into())
}

fn supported_host() -> Result<()> {
    if !cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu"
    )) {
        return Err(invalid(
            "native ROM testing currently requires the Linux x64/glibc CLI; use browser Test on this host",
        ));
    }
    Ok(())
}

fn runtime_directory(directory: Option<&Path>) -> Result<PathBuf> {
    if let Some(directory) = directory {
        return Ok(directory.to_path_buf());
    }
    let data = crate::identify_database::default_database_dir()?;
    Ok(data
        .parent()
        .expect("identify directory has a parent")
        .join("emulators")
        .join(env!("CARGO_PKG_VERSION"))
        .join(PLATFORM))
}

fn hex_digest(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)
        .io_op(IoOp::Open, path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .io_op(IoOp::Open, path)?;
    if bytes.len() as u64 > limit {
        return Err(invalid(format!(
            "{} exceeds the {limit} byte limit",
            path.display()
        )));
    }
    Ok(bytes)
}

fn checked_file(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(invalid("runtime file paths must be relative"));
        }
        path.push(component);
        let metadata = fs::symlink_metadata(&path).io_op(IoOp::Inspect, &path)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid(format!(
                "runtime path must not be a symlink: {}",
                path.display()
            )));
        }
    }
    if !path.is_file() {
        return Err(invalid(format!(
            "runtime file is missing: {}",
            path.display()
        )));
    }
    Ok(path)
}

fn verify_file(root: &Path, file: &RuntimeFile, expected_path: &str) -> Result<PathBuf> {
    if file.path != expected_path
        || !hex_digest(&file.revision, 40)
        || !hex_digest(&file.sha256, 64)
    {
        return Err(invalid(format!(
            "invalid runtime manifest entry for {expected_path}"
        )));
    }
    let path = checked_file(root, &file.path)?;
    let digest = sha256_hex(&read_bounded(&path, MAX_ARCHIVE_BYTES)?);
    if !digest.eq_ignore_ascii_case(&file.sha256) {
        return Err(invalid(format!(
            "runtime checksum mismatch: {}",
            path.display()
        )));
    }
    Ok(path)
}

pub(crate) fn resolve(directory: Option<&Path>) -> Result<EmulatorRuntime> {
    supported_host()?;
    let directory = runtime_directory(directory)?;
    if !directory.exists() {
        return Err(invalid(format!(
            "no emulator runtime at {}; run `rom-weaver emulator install` or pass --runtime-dir",
            directory.display()
        )));
    }
    let root = fs::canonicalize(&directory).io_op(IoOp::Inspect, &directory)?;
    let manifest_path = checked_file(&root, "manifest.json")?;
    let manifest: Manifest = serde_json::from_slice(&read_bounded(&manifest_path, 64 * 1024)?)
        .map_err(|error| invalid(format!("invalid runtime manifest: {error}")))?;
    if manifest.schema_version != 1 || manifest.platform != PLATFORM || manifest.cores.len() != 1 {
        return Err(invalid(
            "unsupported emulator runtime manifest; expected v1 Linux x64/glibc NES runtime",
        ));
    }
    let core = &manifest.cores[0];
    if core.id != "fceumm" || core.platform != "nes" {
        return Err(invalid("emulator runtime must contain the FCEUmm NES core"));
    }
    let retroarch = verify_file(&root, &manifest.retroarch, "bin/retroarch")?;
    let core_path = verify_file(
        &root,
        &RuntimeFile {
            path: core.path.clone(),
            revision: core.revision.clone(),
            sha256: core.sha256.clone(),
        },
        "cores/fceumm_libretro.so",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&retroarch)?.permissions().mode() & 0o111 == 0 {
            return Err(invalid(format!(
                "runtime is not executable: {}",
                retroarch.display()
            )));
        }
    }
    tracing::debug!(path = %root.display(), core = core.id, "verified emulator runtime");
    Ok(EmulatorRuntime {
        root,
        retroarch,
        core: core_path,
        retroarch_revision: manifest.retroarch.revision,
        core_revision: core.revision.clone(),
    })
}

fn download(url: &str, limit: u64) -> Result<Vec<u8>> {
    tracing::debug!(url, "downloading emulator runtime asset");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into();
    let mut response = agent.get(url).call().map_err(|error| {
        invalid(format!(
            "cannot download {url}: {error}; use --archive and --sha256 for offline installation"
        ))
    })?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .with_config()
        .limit(limit)
        .reader()
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn unpack(bytes: &[u8], destination: &Path) -> Result<()> {
    let mut archive =
        tar::Archive::new(GzDecoder::new(bytes).take(MAX_UNPACKED_BYTES + 1024 * 1024));
    let mut paths = HashSet::new();
    let mut size = 0_u64;
    for entry in archive.entries()? {
        rom_weaver_core::process_cancellation_token().check()?;
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let mut relative = PathBuf::new();
        if path.to_string_lossy().contains('\\') {
            return Err(invalid(
                "runtime archive paths must not contain backslashes",
            ));
        }
        for part in path.components() {
            match part {
                Component::CurDir => {}
                Component::Normal(name) => relative.push(name),
                _ => return Err(invalid("runtime archive contains an unsafe path")),
            }
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(invalid(
                "runtime archive may contain only regular files and directories",
            ));
        }
        if relative.as_os_str().is_empty() && kind.is_dir() {
            continue;
        }
        if relative.as_os_str().is_empty() || !paths.insert(relative.clone()) || paths.len() > 256 {
            return Err(invalid(
                "runtime archive contains duplicate or excessive entries",
            ));
        }
        size = size
            .checked_add(entry.size())
            .ok_or_else(|| invalid("runtime archive is too large"))?;
        if size > MAX_UNPACKED_BYTES {
            return Err(invalid("runtime archive exceeds the unpacked size limit"));
        }
        let path = destination.join(&relative);
        if kind.is_dir() {
            fs::create_dir_all(&path).io_op(IoOp::CreateDir, &path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).io_op(IoOp::CreateDir, parent)?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .io_op(IoOp::Create, &path)?;
        std::io::copy(&mut entry, &mut file).io_op(IoOp::Write, &path)?;
        file.flush().io_op(IoOp::Write, &path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if relative == Path::new("bin/retroarch") {
                0o755
            } else {
                0o644
            };
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
        }
    }
    Ok(())
}

fn install(args: &InstallCommand, dry_run: bool) -> Result<Value> {
    supported_host()?;
    let directory = runtime_directory(args.runtime_dir.as_deref())?;
    let url = format!(
        "https://github.com/rom-weaver/rom-weaver/releases/download/v{}/{ARCHIVE_NAME}",
        env!("CARGO_PKG_VERSION")
    );
    if let Some(digest) = &args.sha256
        && !hex_digest(digest, 64)
    {
        return Err(invalid("--sha256 requires exactly 64 hexadecimal digits"));
    }
    if dry_run {
        return Ok(
            json!({"message": format!("Would install the NES runtime in {}", directory.display()),
            "dry_run": true, "runtime_dir": directory, "writes": [directory],
            "downloads": if args.archive.is_none() { vec![url.clone(), format!("{url}.sha256")] } else { vec![] }}),
        );
    }
    if directory.try_exists()? {
        let runtime = resolve(Some(&directory))?;
        return Ok(runtime_report(
            &runtime,
            "Emulator runtime is already installed",
        ));
    }
    let (bytes, digest) = if let Some(path) = &args.archive {
        (
            read_bounded(path, MAX_ARCHIVE_BYTES)?,
            args.sha256
                .clone()
                .ok_or_else(|| invalid("--archive requires --sha256"))?,
        )
    } else {
        let checksum = download(&format!("{url}.sha256"), 1024)?;
        let checksum =
            std::str::from_utf8(&checksum).map_err(|_| invalid("runtime checksum is not UTF-8"))?;
        let mut fields = checksum.split_whitespace();
        let digest = fields.next().unwrap_or_default();
        if !hex_digest(digest, 64) || fields.next() != Some(ARCHIVE_NAME) || fields.next().is_some()
        {
            return Err(invalid("invalid runtime archive checksum file"));
        }
        (download(&url, MAX_ARCHIVE_BYTES)?, digest.to_owned())
    };
    if !sha256_hex(&bytes).eq_ignore_ascii_case(&digest) {
        return Err(invalid(
            "runtime archive SHA-256 does not match; nothing installed",
        ));
    }
    let parent = directory
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).io_op(IoOp::CreateDir, parent)?;
    let temporary = TempPathAllocator::new(parent.to_path_buf());
    let staging = temporary.next_path("emulator-runtime", None);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&staging).io_op(IoOp::CreateDir, &staging)?;
    unpack(&bytes, &staging)?;
    resolve(Some(&staging))?;
    rom_weaver_core::process_cancellation_token().check()?;
    if directory.try_exists()? {
        return Err(invalid(format!(
            "runtime destination already exists: {}",
            directory.display()
        )));
    }
    fs::rename(&staging, &directory).io_op(IoOp::Write, &directory)?;
    let runtime = resolve(Some(&directory))?;
    tracing::info!(path = %runtime.root.display(), "installed NES emulator runtime");
    Ok(runtime_report(
        &runtime,
        "Installed the NES emulator runtime",
    ))
}

fn runtime_report(runtime: &EmulatorRuntime, message: &str) -> Value {
    json!({"message": format!("{message}: {}", runtime.root.display()),
        "runtime_dir": runtime.root, "platform": PLATFORM, "core": "fceumm",
        "retroarch_revision": runtime.retroarch_revision, "core_revision": runtime.core_revision})
}

pub(crate) fn run(command: &EmulatorCommand, dry_run: bool) -> Result<Value> {
    match &command.command {
        EmulatorSubcommand::Install(args) => install(args, dry_run),
        EmulatorSubcommand::Info { runtime_dir } => {
            let runtime = resolve(runtime_dir.as_deref())?;
            Ok(runtime_report(
                &runtime,
                "Verified the NES emulator runtime",
            ))
        }
    }
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
#[path = "emulator_runtime/tests.rs"]
mod tests;
