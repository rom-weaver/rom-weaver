use std::{io, path::PathBuf};

use thiserror::Error;

pub type Result<T> = std::result::Result<T, RomWeaverError>;

#[derive(Debug, Error)]
pub enum RomWeaverError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("unknown format for path `{path}`")]
    UnknownFormat { path: PathBuf },
    #[error("unsupported operation: {0}")]
    Unsupported(String),
    #[error("operation cancelled")]
    Cancelled,
    #[error("i/o error: {0}")]
    Io(#[from] io::Error),
    #[error("thread pool build failed: {0}")]
    ThreadPoolBuild(String),
}
