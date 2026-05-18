use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rom_weaver_core::{CancellationToken, NoopProgressSink, OperationContext, ThreadBudget};

static NEXT_TEST_DIR_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TestDir {
    path: PathBuf,
}

impl TestDir {
    pub(crate) fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let sequence = NEXT_TEST_DIR_ID.fetch_add(1, Ordering::Relaxed);
        let path = env::temp_dir().join(format!(
            "rom-weaver-patches-tests-{}-{timestamp}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir_all(&path).expect("temp dir");
        Self { path }
    }

    pub(crate) fn child(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub(crate) fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
    test_context_with_threads_named(temp, threads, "temp")
}

pub(crate) fn test_context_with_threads_named(
    temp: &TestDir,
    threads: usize,
    temp_name: &str,
) -> OperationContext {
    build_context(temp.child(temp_name), threads)
}

pub(crate) fn test_context_with_threads_in_root(
    temp: &TestDir,
    threads: usize,
) -> OperationContext {
    build_context(temp.path().to_path_buf(), threads)
}

fn build_context(temp_root: PathBuf, threads: usize) -> OperationContext {
    OperationContext::new(
        ThreadBudget::Fixed(threads),
        temp_root,
        Arc::new(NoopProgressSink),
        CancellationToken::new(),
    )
}
