use std::{
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{Result, RomWeaverError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChunk {
    pub index: u64,
    pub offset: u64,
    pub len: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkPlanner {
    chunk_size: NonZeroU64,
}

impl ChunkPlanner {
    pub fn new(chunk_size: u64) -> Result<Self> {
        let chunk_size = NonZeroU64::new(chunk_size).ok_or_else(|| {
            RomWeaverError::Validation("chunk size must be greater than zero".into())
        })?;
        Ok(Self { chunk_size })
    }

    pub fn chunk_size(&self) -> u64 {
        self.chunk_size.get()
    }

    pub fn plan(&self, file_len: u64) -> Vec<FileChunk> {
        if file_len == 0 {
            return Vec::new();
        }

        let chunk_size = self.chunk_size();
        let chunk_count = file_len.div_ceil(chunk_size);
        (0..chunk_count)
            .map(|index| {
                let offset = index * chunk_size;
                let remaining = file_len.saturating_sub(offset);
                let len = remaining.min(chunk_size);
                FileChunk { index, offset, len }
            })
            .collect()
    }
}

#[derive(Debug)]
pub struct TempPathAllocator {
    root: PathBuf,
    namespace: String,
    counter: AtomicU64,
}

impl TempPathAllocator {
    pub fn new(root: PathBuf) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let namespace = format!("rw-{}-{timestamp}", runtime_process_id());
        Self {
            root,
            namespace,
            counter: AtomicU64::new(0),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub fn next_path(&self, purpose: &str, extension: Option<&str>) -> PathBuf {
        let sequence = self.counter.fetch_add(1, Ordering::SeqCst);
        let label = purpose
            .chars()
            .map(|value| {
                if value.is_ascii_alphanumeric() || matches!(value, '-' | '_') {
                    value
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let mut file_name = format!("{label}-{sequence:08}");
        if let Some(extension) = extension {
            let extension = extension.trim_start_matches('.');
            if !extension.is_empty() {
                file_name.push('.');
                file_name.push_str(extension);
            }
        }
        self.root.join(&self.namespace).join(file_name)
    }
}

#[cfg(target_family = "wasm")]
fn runtime_process_id() -> u32 {
    1
}

#[cfg(not(target_family = "wasm"))]
fn runtime_process_id() -> u32 {
    std::process::id()
}

#[cfg(test)]
#[path = "../tests/unit/io.rs"]
mod tests;
