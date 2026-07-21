//! Up-front readability and writability probes for user-supplied paths.
//!
//! Permission failures are cheap to detect and expensive to hit late: a denied
//! output directory discovered after a multi-gigabyte compress wastes the whole
//! run. These probes run during command validation, and every failure they
//! produce is a [`RomWeaverError::IoPath`], so the message names the operation,
//! the path, and - for access denials - the ownership mismatch behind it.

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

use rom_weaver_core::{IoOp, OperationFamily, OperationReport, RomWeaverError, ThreadExecution};
use tracing::trace;

use super::CliApp;

/// Why a path failed its access probe. `Missing` is separated out because
/// callers word "does not exist" differently from an access denial.
pub(super) enum PathAccessError {
    Missing,
    Denied(RomWeaverError),
}

/// Confirm `path` exists and can actually be read. Directories are probed with a
/// listing, files with an open-for-read; both are the same syscalls the command
/// itself would make moments later.
pub(super) fn check_readable(path: &Path) -> Result<(), PathAccessError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        // A path whose parent directory refuses traversal is not missing, and
        // saying so would send the user looking for the wrong problem.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(PathAccessError::Missing);
        }
        Err(error) => {
            return Err(denied(IoOp::Inspect, path, error));
        }
    };

    if !PROBE_ENABLED {
        return Ok(());
    }

    let (op, probe) = if metadata.is_dir() {
        (IoOp::ReadDir, fs::read_dir(path).map(|_| ()))
    } else {
        (IoOp::Open, File::open(path).map(|_| ()))
    };
    probe.map_err(|error| denied(op, path, error))
}

/// Confirm files can be created inside `directory`, creating the directory
/// itself when it is missing. "Missing" is never an outcome here - it is either
/// created or the failure to create it is the error.
pub(super) fn check_writable_dir(directory: &Path) -> Result<(), RomWeaverError> {
    if !directory.exists()
        && let Err(error) = fs::create_dir_all(directory)
    {
        return Err(denied_error(IoOp::CreateDir, directory, error));
    }

    if !PROBE_ENABLED {
        return Ok(());
    }

    // A mode check would have to reimplement the kernel's ACL, supplementary
    // group, and read-only-mount rules. Creating and removing a file asks the
    // kernel the question directly.
    let probe = directory.join(PROBE_FILE_NAME);
    let created = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map(|_| ());
    match created {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            trace!(directory = %directory.display(), "output directory is writable");
            Ok(())
        }
        // A probe left behind by a run that died mid-check. Removing it proves
        // exactly what creating it would have - unlinking needs write on the
        // directory - and clears the litter from the user's output.
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            fs::remove_file(&probe).map_err(|error| denied_error(IoOp::Write, directory, error))
        }
        Err(error) => Err(denied_error(IoOp::Write, directory, error)),
    }
}

fn denied(op: IoOp, path: &Path, error: io::Error) -> PathAccessError {
    PathAccessError::Denied(denied_error(op, path, error))
}

fn denied_error(op: IoOp, path: &Path, error: io::Error) -> RomWeaverError {
    trace!(
        path = %path.display(),
        kind = ?error.kind(),
        "path access probe failed"
    );
    RomWeaverError::io_path(op, path, error)
}

const PROBE_FILE_NAME: &str = ".rom-weaver-write-probe";

// The browser build reaches the filesystem through the OPFS proxy, where a file
// may hold only one handle at a time and permissions do not exist. Probing there
// would risk the real open for no information, so only `metadata` runs.
const PROBE_ENABLED: bool = cfg!(not(target_arch = "wasm32"));

impl CliApp {
    /// Preflight a user-supplied input: it must exist *and* be readable. Probing
    /// up front turns a mid-run `Permission denied (os error 13)` - possibly
    /// gigabytes into a job - into one validation failure that names the path and
    /// the identity that was refused.
    pub(super) fn require_readable_path(
        &self,
        _command: &str,
        family: OperationFamily,
        format: Option<String>,
        path: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        let failure = |label: String| {
            Some(OperationReport::failed(
                family,
                format.clone(),
                "validate",
                label,
                thread_execution,
            ))
        };
        match check_readable(path) {
            Ok(()) => None,
            Err(PathAccessError::Missing) => {
                failure(format!("input path does not exist: `{}`", path.display()))
            }
            Err(PathAccessError::Denied(error)) => failure(error.to_string()),
        }
    }

    /// Preflight the destination a command is about to write into, creating it
    /// when missing. Checking before the work starts means a read-only output
    /// directory costs a validation error rather than an entire compress.
    pub(super) fn require_writable_output_dir(
        &self,
        _command: &str,
        family: OperationFamily,
        format: Option<String>,
        directory: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        // An empty destination means "alongside the input", which the command
        // resolves later against a directory we have already probed.
        if directory.as_os_str().is_empty() {
            return None;
        }
        check_writable_dir(directory).err().map(|error| {
            OperationReport::failed(
                family,
                format,
                "validate",
                error.to_string(),
                thread_execution,
            )
        })
    }

    /// [`Self::require_writable_output_dir`] for a command whose `--output` names
    /// a file: the directory that has to accept it is the file's parent.
    pub(super) fn require_writable_output_parent(
        &self,
        command: &str,
        family: OperationFamily,
        format: Option<String>,
        output: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        let parent = output.parent()?;
        self.require_writable_output_dir(command, family, format, parent, thread_execution)
    }
}

#[cfg(test)]
#[path = "../tests/unit/path_access.rs"]
mod tests;
