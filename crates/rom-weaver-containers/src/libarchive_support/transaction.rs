use std::{
    ffi::OsString,
    fs::{self, DirBuilder, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[cfg(target_family = "wasm")]
use std::io::Read;
#[cfg(any(test, target_family = "wasm"))]
use std::time::SystemTime;

use rom_weaver_core::{Result, RomWeaverError};
use tracing::trace;

use super::LibarchiveExtractTask;
#[cfg(target_family = "wasm")]
use crate::constants::LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES;

#[cfg(windows)]
fn extract_path_metadata_is_link(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn extract_path_metadata_is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// Reject pre-existing links below the extraction root before directory creation or file writes can
/// follow them outside that root. The root itself may be a caller-selected symlink (for example a
/// platform temp-directory alias); only archive-controlled descendants are forbidden.
pub(super) fn ensure_extract_path_has_no_links(out_dir: &Path, output_path: &Path) -> Result<()> {
    let relative = output_path.strip_prefix(out_dir).map_err(|_| {
        RomWeaverError::Validation(format!(
            "archive output `{}` is outside extraction directory `{}`",
            output_path.display(),
            out_dir.display()
        ))
    })?;
    let mut current = out_dir.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if extract_path_metadata_is_link(&metadata) => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to extract through existing link `{}`",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(any(test, target_family = "wasm"))]
pub(super) fn normalize_confined_extract_root(out_dir: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in out_dir.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(RomWeaverError::Validation(format!(
                        "extraction directory `{}` escapes its confined filesystem root",
                        out_dir.display()
                    )));
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        normalized.push(".");
    }
    Ok(normalized)
}

#[cfg(target_family = "wasm")]
fn resolve_extract_root(out_dir: &Path) -> Result<PathBuf> {
    // Browser WASI paths are already confined to the preopened OPFS mount, whose shim does not
    // implement canonicalize/readlink. Lexical normalization is sufficient because parent escapes
    // are rejected and the mount does not expose symlinks.
    normalize_confined_extract_root(out_dir)
}

#[cfg(not(target_family = "wasm"))]
fn resolve_extract_root(out_dir: &Path) -> Result<PathBuf> {
    Ok(fs::canonicalize(out_dir)?)
}

static NEXT_EXTRACT_TRANSACTION_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(any(test, target_family = "wasm"))]
pub(super) fn wasm_extract_transaction_owner_id(now: SystemTime) -> String {
    let epoch_nanos = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("wasm-{epoch_nanos:x}")
}

#[cfg(target_family = "wasm")]
fn extract_transaction_owner_id() -> String {
    if let Ok(value) = std::env::var("ROM_WEAVER_OPFS_RUN_ID")
        && !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return value;
    }

    // WASI preview1 does not implement std::process::id(). A time-based module nonce prevents a
    // fresh worker from exhausting its create-new collision loop on staging directories left by a
    // killed predecessor. Unknown directories are never removed because another tab may own them.
    wasm_extract_transaction_owner_id(SystemTime::now())
}

#[cfg(not(target_family = "wasm"))]
fn extract_transaction_owner_id() -> String {
    std::process::id().to_string()
}

#[cfg(unix)]
fn create_private_extract_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = DirBuilder::new();
    builder.mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_extract_directory(path: &Path) -> std::io::Result<()> {
    DirBuilder::new().create(path)
}

#[cfg(not(target_family = "wasm"))]
fn copy_extract_file_create_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut source_file = File::open(source)?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copy_result = std::io::copy(&mut source_file, &mut destination_file)
        .and_then(|_| destination_file.flush());
    drop(destination_file);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

#[cfg(target_family = "wasm")]
fn copy_extract_file_create_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut source_file = File::open(source)?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copy_result = (|| {
        let mut buffer = vec![0_u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
        loop {
            let read = source_file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            destination_file.write_all(&buffer[..read])?;
        }
        destination_file.flush()
    })();
    drop(destination_file);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
pub(super) fn install_staged_no_overwrite_with<F>(
    staged_path: &Path,
    destination_path: &Path,
    hard_link: F,
) -> std::io::Result<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    match hard_link(staged_path, destination_path) {
        Ok(()) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::NotFound
            ) =>
        {
            return Err(error);
        }
        Err(_) => copy_extract_file_create_new(staged_path, destination_path)?,
    }
    // The installed file is complete. Transaction cleanup retries the staging removal, so failure
    // to remove its old name is not a reason to roll the destination back.
    let _ = fs::remove_file(staged_path);
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn install_staged_no_overwrite(staged_path: &Path, destination_path: &Path) -> std::io::Result<()> {
    install_staged_no_overwrite_with(staged_path, destination_path, |source, destination| {
        fs::hard_link(source, destination)
    })
}

#[cfg(target_family = "wasm")]
fn install_staged_no_overwrite(staged_path: &Path, destination_path: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(staged_path, destination_path)?;
    let _ = fs::remove_file(staged_path);
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn backup_extract_output(source: &Path, backup: &Path) -> std::io::Result<()> {
    fs::rename(source, backup)
}

#[cfg(target_family = "wasm")]
fn backup_extract_output(source: &Path, backup: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(source, backup)?;
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(backup);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn install_staged_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(target_family = "wasm")]
fn install_staged_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(source, destination)?;
    let _ = fs::remove_file(source);
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn restore_extract_backup(backup: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(backup, destination)
}

#[cfg(target_family = "wasm")]
fn restore_extract_backup(backup: &Path, destination: &Path) -> std::io::Result<()> {
    copy_extract_file_create_new(backup, destination)?;
    let _ = fs::remove_file(backup);
    Ok(())
}

#[derive(Debug)]
struct CommittedExtractOutput {
    destination_path: PathBuf,
    backup_path: Option<PathBuf>,
}

/// Stages every decoded archive member before publishing it. Existing outputs are first moved into
/// the private backup tree so an error (or panic) during a later install can restore them instead of
/// leaving truncated files.
pub(super) struct LibarchiveExtractTransaction<'a> {
    format_name: &'a str,
    overwrite: bool,
    root_path: PathBuf,
    staging_dir: PathBuf,
    staged_outputs_dir: PathBuf,
    backup_dir: PathBuf,
    committed_outputs: Vec<CommittedExtractOutput>,
    created_destination_dirs: Vec<PathBuf>,
    committed: bool,
    preserve_staging: bool,
}

impl<'a> LibarchiveExtractTransaction<'a> {
    pub(super) fn new(out_dir: &Path, overwrite: bool, format_name: &'a str) -> Result<Self> {
        // Resolve a caller-selected root symlink once. Every subsequent path is rooted at the same
        // physical directory, so retargeting that symlink cannot redirect an in-flight extract.
        let root_path = resolve_extract_root(out_dir)?;
        // Keep staging inside the output root so native rename/hard-link installs stay on one
        // filesystem, including when out_dir itself is a mount point. stage_tasks reserves this
        // hidden namespace so archive members cannot address the transaction's new/backup trees.
        let mut staging_dir = None;
        let owner_id = extract_transaction_owner_id();
        for _ in 0..100 {
            let sequence = NEXT_EXTRACT_TRANSACTION_ID.fetch_add(1, Ordering::Relaxed);
            let candidate = root_path.join(format!(".rom-weaver-extract-{owner_id}-{sequence}"));
            match create_private_extract_directory(&candidate) {
                Ok(()) => {
                    staging_dir = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        let staging_dir = staging_dir.ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{format_name} extract could not allocate a private staging directory"
            ))
        })?;
        let staged_outputs_dir = staging_dir.join("new");
        let backup_dir = staging_dir.join("old");
        if let Err(error) = create_private_extract_directory(&staged_outputs_dir)
            .and_then(|()| create_private_extract_directory(&backup_dir))
        {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(error.into());
        }
        Ok(Self {
            format_name,
            overwrite,
            root_path,
            staging_dir,
            staged_outputs_dir,
            backup_dir,
            committed_outputs: Vec::new(),
            created_destination_dirs: Vec::new(),
            committed: false,
            preserve_staging: false,
        })
    }

    pub(super) fn stage_tasks(
        &self,
        tasks: &[LibarchiveExtractTask],
    ) -> Result<Vec<LibarchiveExtractTask>> {
        tasks
            .iter()
            .cloned()
            .map(|mut task| -> Result<LibarchiveExtractTask> {
                let uses_reserved_namespace = task
                    .relative_path
                    .components()
                    .next()
                    .and_then(|component| match component {
                        std::path::Component::Normal(component) => component.to_str(),
                        _ => None,
                    })
                    .is_some_and(|component| {
                        component
                            .to_ascii_lowercase()
                            .starts_with(".rom-weaver-extract-")
                    });
                if uses_reserved_namespace {
                    return Err(RomWeaverError::Validation(format!(
                        "{} extract entry `{}` uses the reserved transaction namespace",
                        self.format_name, task.archive_name
                    )));
                }
                // Archive names that alias on a case-insensitive filesystem must still decode into
                // independent files. Preserve only the extension needed by checksum/identity logic;
                // the entry index supplies uniqueness without recreating the archive's directory
                // chain inside the private staging tree.
                let mut staging_name = OsString::from(task.index.to_string());
                if let Some(extension) = task.output_path.extension() {
                    staging_name.push(".");
                    staging_name.push(extension);
                }
                task.write_path = self.staged_outputs_dir.join(staging_name);
                Ok(task)
            })
            .collect()
    }

    #[cfg(test)]
    pub(super) fn staging_dir(&self) -> &Path {
        &self.staging_dir
    }

    fn ensure_destination_directory(&mut self, relative: &Path) -> Result<()> {
        let mut current = self.root_path.clone();
        for component in relative.components() {
            let std::path::Component::Normal(component) = component else {
                return Err(RomWeaverError::Validation(format!(
                    "{} extract produced invalid destination path `{}`",
                    self.format_name,
                    relative.display()
                )));
            };
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if extract_path_metadata_is_link(&metadata) => {
                    return Err(RomWeaverError::Validation(format!(
                        "refusing to extract through existing link `{}`",
                        current.display()
                    )));
                }
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(RomWeaverError::Validation(format!(
                        "refusing to replace non-directory extraction parent `{}`",
                        current.display()
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match fs::create_dir(&current) {
                        Ok(()) => self.created_destination_dirs.push(current.clone()),
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            let metadata = fs::symlink_metadata(&current)?;
                            if extract_path_metadata_is_link(&metadata) || !metadata.is_dir() {
                                return Err(RomWeaverError::Validation(format!(
                                    "refusing to extract through replaced parent `{}`",
                                    current.display()
                                )));
                            }
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn commit_file(&mut self, task: &LibarchiveExtractTask) -> Result<()> {
        let destination_path = self.root_path.join(&task.relative_path);
        let staged_path = &task.write_path;
        let parent = task.relative_path.parent().unwrap_or_else(|| Path::new(""));
        self.ensure_destination_directory(parent)?;
        // Revalidate at the mutation boundary rather than relying on the preflight performed before
        // decoding. Completed bytes remain private until this check succeeds.
        ensure_extract_path_has_no_links(&self.root_path, &destination_path)?;

        let backup_path = match fs::symlink_metadata(&destination_path) {
            Ok(metadata) if extract_path_metadata_is_link(&metadata) => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to overwrite existing link `{}`",
                    destination_path.display()
                )));
            }
            Ok(metadata) if metadata.is_file() && self.overwrite => {
                // Each archive entry gets its own backup. When several entries alias the same
                // destination, rollback walks these generations in reverse and restores the
                // original chain exactly.
                let backup_path = self.backup_dir.join(task.index.to_string());
                if let Some(parent) = backup_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                backup_extract_output(&destination_path, &backup_path)?;
                Some(backup_path)
            }
            Ok(metadata) if metadata.is_file() => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to overwrite existing output `{}`",
                    destination_path.display()
                )));
            }
            Ok(_) => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to replace non-file extraction output `{}`",
                    destination_path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        // Record a moved original before installing its replacement. If unwinding occurs between
        // those two filesystem operations, Drop can still put the original back.
        if backup_path.is_some() {
            self.committed_outputs.push(CommittedExtractOutput {
                destination_path: destination_path.clone(),
                backup_path: backup_path.clone(),
            });
        }

        ensure_extract_path_has_no_links(&self.root_path, &destination_path)?;
        let install_result = if self.overwrite || backup_path.is_some() {
            install_staged_overwrite(staged_path, &destination_path)
        } else {
            install_staged_no_overwrite(staged_path, &destination_path)
        };
        if let Err(error) = install_result {
            return Err(RomWeaverError::Validation(format!(
                "{} extract failed while installing `{}`: {error}",
                self.format_name,
                destination_path.display()
            )));
        }

        if backup_path.is_none() {
            self.committed_outputs.push(CommittedExtractOutput {
                destination_path,
                backup_path: None,
            });
        }
        Ok(())
    }

    fn rollback(&mut self) -> std::result::Result<(), String> {
        let mut errors = Vec::new();
        for output in self.committed_outputs.drain(..).rev() {
            if let Err(error) = fs::remove_file(&output.destination_path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                errors.push(format!(
                    "remove `{}`: {error}",
                    output.destination_path.display()
                ));
            }
            if let Some(backup_path) = output.backup_path
                && let Err(error) = restore_extract_backup(&backup_path, &output.destination_path)
            {
                errors.push(format!(
                    "restore `{}` from `{}`: {error}",
                    output.destination_path.display(),
                    backup_path.display()
                ));
            }
        }
        for path in self.created_destination_dirs.drain(..).rev() {
            if let Err(error) = fs::remove_dir(&path)
                && error.kind() != std::io::ErrorKind::NotFound
                && error.kind() != std::io::ErrorKind::DirectoryNotEmpty
            {
                errors.push(format!("remove directory `{}`: {error}", path.display()));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            self.preserve_staging = true;
            Err(errors.join("; "))
        }
    }

    pub(super) fn commit(&mut self, tasks: &[LibarchiveExtractTask]) -> Result<()> {
        let mut directories = tasks
            .iter()
            .filter(|task| task.is_dir)
            .map(|task| task.relative_path.clone())
            .collect::<Vec<_>>();
        directories.sort_by_key(|path| path.components().count());
        directories.dedup();
        for directory in directories {
            if let Err(error) = self.ensure_destination_directory(&directory) {
                let rollback_error = self.rollback().err();
                return Err(match rollback_error {
                    Some(rollback_error) => RomWeaverError::Validation(format!(
                        "{error}; rollback failed: {rollback_error}"
                    )),
                    None => error,
                });
            }
        }

        for task in tasks.iter().filter(|task| !task.is_dir) {
            if let Err(error) = self.commit_file(task) {
                let rollback_error = self.rollback().err();
                return Err(match rollback_error {
                    Some(rollback_error) => RomWeaverError::Validation(format!(
                        "{error}; rollback failed: {rollback_error}"
                    )),
                    None => error,
                });
            }
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for LibarchiveExtractTransaction<'_> {
    fn drop(&mut self) {
        if !self.committed
            && let Err(error) = self.rollback()
        {
            trace!(
                format = self.format_name,
                %error,
                "archive extract rollback was incomplete"
            );
        }
        if !self.preserve_staging {
            let _ = fs::remove_dir_all(&self.staging_dir);
        }
    }
}
