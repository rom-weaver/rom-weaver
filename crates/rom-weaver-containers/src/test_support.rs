//! Test-only helpers shared by the unit suites.

use std::{
    fs,
    ops::Deref,
    path::{Path, PathBuf},
};

/// A scratch file or directory path removed when the guard drops, so it is cleaned up after a
/// passing test, a failed assertion, and a panic. Nothing is created here; tests create what
/// they need, and an explicit removal inside the test stays harmless.
pub(crate) struct TempPath(PathBuf);

impl TempPath {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self(path)
    }
}

impl Deref for TempPath {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempPath {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = fs::remove_dir_all(&self.0);
        } else {
            let _ = fs::remove_file(&self.0);
        }
    }
}
