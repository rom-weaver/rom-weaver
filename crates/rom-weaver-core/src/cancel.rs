use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use crate::{Result, RomWeaverError};

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    inner: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(RomWeaverError::Cancelled)
        } else {
            Ok(())
        }
    }
}
