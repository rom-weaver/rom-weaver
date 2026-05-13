use std::{path::Path, path::PathBuf, sync::Arc};

use crate::{
    CancellationToken, ProgressEvent, ProgressSink, Result, SharedThreadPool, TempPathAllocator,
    ThreadBudget, ThreadCapability, ThreadExecution,
};

#[derive(Clone)]
pub struct OperationContext {
    thread_budget: ThreadBudget,
    temp_paths: Arc<TempPathAllocator>,
    progress: Arc<dyn ProgressSink>,
    cancel: CancellationToken,
}

impl OperationContext {
    pub fn new(
        thread_budget: ThreadBudget,
        temp_root: PathBuf,
        progress: Arc<dyn ProgressSink>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            thread_budget,
            temp_paths: Arc::new(TempPathAllocator::new(temp_root)),
            progress,
            cancel,
        }
    }

    pub fn thread_budget(&self) -> ThreadBudget {
        self.thread_budget
    }

    pub fn temp_root(&self) -> &Path {
        self.temp_paths.root()
    }

    pub fn temp_paths(&self) -> &TempPathAllocator {
        self.temp_paths.as_ref()
    }

    pub fn cancel(&self) -> &CancellationToken {
        &self.cancel
    }

    pub fn emit(&self, event: ProgressEvent) {
        self.progress.emit(event);
    }

    pub fn plan_threads(&self, capability: ThreadCapability) -> ThreadExecution {
        capability.negotiate(self.thread_budget)
    }

    pub fn build_pool(
        &self,
        capability: ThreadCapability,
    ) -> Result<(ThreadExecution, SharedThreadPool)> {
        let execution = self.plan_threads(capability);
        let pool = SharedThreadPool::with_execution(&execution)?;
        Ok((execution, pool))
    }
}
