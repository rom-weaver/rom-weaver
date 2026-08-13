use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

use super::*;

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir();
        for _ in 0..100 {
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = base.join(format!(
                "rom-weaver-{label}-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create temporary directory: {error}"),
            }
        }
        panic!("find a unique temporary directory");
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn local_cancellation_and_output_cleanup_have_expected_lifecycles() {
    clear_in_progress_outputs();

    let token = CancellationToken::new();
    let clone = token.clone();
    assert!(!token.is_cancelled());
    assert!(token.check().is_ok());
    token.cancel();
    assert!(token.is_cancelled());
    assert!(clone.is_cancelled());
    assert!(matches!(token.check(), Err(RomWeaverError::Cancelled)));

    if cfg!(target_arch = "wasm32") {
        clear_in_progress_outputs();
        return;
    }

    let temp = TempDir::new("cancel");
    let complete = temp.path().join("complete.bin");
    let partial = temp.path().join("partial.bin");
    fs::write(&complete, b"complete").expect("write completed output");
    fs::write(&partial, b"partial").expect("write partial output");
    register_in_progress_output(&complete);
    register_in_progress_output(&partial);
    complete_in_progress_output(&complete);
    remove_in_progress_outputs();
    assert!(complete.exists());
    assert!(!partial.exists());

    let preserved = temp.path().join("preserved.bin");
    fs::write(&preserved, b"preserved").expect("write preserved output");
    register_in_progress_output(&preserved);
    clear_in_progress_outputs();
    remove_in_progress_outputs();
    assert!(preserved.exists());

    clear_in_progress_outputs();
}
