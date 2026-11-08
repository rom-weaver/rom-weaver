//! Directory settings read from the environment.

use std::{env, path::PathBuf};

use tracing::debug;

/// The directory named by `name`. An empty value counts as unset, so a stray
/// `export NAME=` falls through to the next source instead of meaning the cwd.
pub(crate) fn env_dir(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// `$XDG_DATA_HOME`. The XDG Base Directory spec says a relative value is invalid
/// and MUST be ignored, as an empty one is.
pub(crate) fn xdg_data_home() -> Option<PathBuf> {
    let dir = env_dir("XDG_DATA_HOME")?;
    if dir.is_absolute() {
        return Some(dir);
    }
    debug!(dir = %dir.display(), "ignoring relative XDG_DATA_HOME");
    None
}
