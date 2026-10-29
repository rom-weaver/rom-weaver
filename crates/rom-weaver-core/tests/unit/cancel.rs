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

    // A new directory goes after the outputs inside it, but only once it is empty.
    let created = temp.path().join("created");
    let kept = temp.path().join("kept");
    for dir in [&created, &kept] {
        register_in_progress_output(dir);
        fs::create_dir(dir).expect("create output directory");
        let inner = dir.join("inner.bin");
        fs::write(&inner, b"inner").expect("write inner output");
        register_in_progress_output(&inner);
    }
    fs::write(kept.join("other.bin"), b"other").expect("write unregistered file");
    remove_in_progress_outputs();
    assert!(!created.exists());
    assert!(kept.join("other.bin").exists());
    assert!(!kept.join("inner.bin").exists());

    let preserved = temp.path().join("preserved.bin");
    fs::write(&preserved, b"preserved").expect("write preserved output");
    register_in_progress_output(&preserved);
    clear_in_progress_outputs();
    remove_in_progress_outputs();
    assert!(preserved.exists());

    clear_in_progress_outputs();
}

#[test]
fn or_cancelled_reports_failures_after_a_cancel_as_cancelled() {
    let token = CancellationToken::new();
    let failure = || -> Result<()> { Err(RomWeaverError::Validation("cancelled".to_string())) };
    assert!(matches!(token.or_cancelled(Ok(1)), Ok(1)));
    assert!(matches!(
        token.or_cancelled(failure()),
        Err(RomWeaverError::Validation(_))
    ));

    token.cancel();
    assert!(matches!(token.or_cancelled(Ok(1)), Ok(1)));
    assert!(matches!(
        token.or_cancelled(failure()),
        Err(RomWeaverError::Cancelled)
    ));
}

// quality-reason: Native threads and subprocesses exercise the terminal cleanup gate that WASM bypasses.
#[cfg(not(target_arch = "wasm32"))]
mod live_temp_lifecycle {
    use std::{
        process::{Command, Stdio},
        sync::{Arc, mpsc},
        thread,
        time::Duration,
    };

    use super::*;

    const DEADLINE: Duration = Duration::from_secs(10);

    #[test]
    fn cleanup_waits_for_parallel_creators_and_removes_their_registered_entries() {
        let temp = TempDir::new("parallel-live-temp");
        let registry = Arc::new(LiveTempDirs::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let mut releases = Vec::new();
        let mut creators = Vec::new();
        for index in 0..2 {
            let path = temp.path().join(format!("creator-{index}"));
            let registry = registry.clone();
            let entered_tx = entered_tx.clone();
            let (release_tx, release_rx) = mpsc::channel();
            releases.push(release_tx);
            creators.push(thread::spawn(move || {
                registry
                    .with_creation(&CancellationToken::new(), || {
                        fs::create_dir(&path)?;
                        registry.register(&path);
                        fs::write(path.join("partial.bin"), b"partial")?;
                        entered_tx.send(()).expect("announce active creator");
                        release_rx.recv_timeout(DEADLINE).expect("release creator");
                        Ok(())
                    })
                    .expect("create and register entry");
            }));
        }
        for _ in 0..2 {
            entered_rx
                .recv_timeout(DEADLINE)
                .expect("both creators MUST enter before either leaves");
        }
        assert!(registry.creation.try_write().is_err());

        let (started_tx, started_rx) = mpsc::channel();
        let (removed_tx, removed_rx) = mpsc::channel();
        let cleanup_registry = registry.clone();
        let cleanup = thread::spawn(move || {
            started_tx.send(()).expect("announce cleanup");
            cleanup_registry.remove();
            removed_tx.send(()).expect("announce completed cleanup");
        });
        started_rx.recv_timeout(DEADLINE).expect("cleanup starts");
        let while_creators_active = removed_rx.recv_timeout(Duration::from_millis(100));
        for release in releases {
            release.send(()).expect("allow creator to finish");
        }
        assert!(matches!(
            while_creators_active,
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        removed_rx
            .recv_timeout(DEADLINE)
            .expect("cleanup completes after creators leave");
        for creator in creators {
            creator.join().expect("creator thread");
        }
        cleanup.join().expect("cleanup thread");
        assert!(!temp.path().join("creator-0").exists());
        assert!(!temp.path().join("creator-1").exists());
    }

    #[test]
    fn create_register_and_unregister_transaction_preserves_completed_and_neighbor_paths() {
        let temp = TempDir::new("completed-live-temp");
        let root = temp.path().to_path_buf();
        let (done_tx, done_rx) = mpsc::channel();
        let creator = thread::spawn(move || {
            let registry = LiveTempDirs::default();
            registry
                .with_creation(&CancellationToken::new(), || {
                    let completed = root.join("completed.bin");
                    fs::write(&completed, b"complete")?;
                    registry.register(&completed);
                    registry.unregister(&completed);
                    fs::write(root.join("neighbor.bin"), b"neighbor")?;
                    let partial = root.join("partial");
                    fs::create_dir(&partial)?;
                    registry.register(&partial);
                    fs::write(partial.join("nested.bin"), b"partial")?;
                    Ok(())
                })
                .expect("registration MUST NOT deadlock inside creation callback");
            registry.remove();
            done_tx.send(()).expect("announce transaction completion");
        });
        done_rx
            .recv_timeout(DEADLINE)
            .expect("create/register/unregister transaction completes");
        creator.join().expect("transaction thread");
        assert_eq!(
            fs::read(temp.path().join("completed.bin")).expect("read completed output"),
            b"complete"
        );
        assert_eq!(
            fs::read(temp.path().join("neighbor.bin")).expect("read neighbor"),
            b"neighbor"
        );
        assert!(!temp.path().join("partial").exists());
    }

    #[test]
    fn terminal_cleanup_rejects_late_creators_and_removes_late_registrations() {
        let temp = TempDir::new("closed-live-temp");
        let registry = LiveTempDirs::default();
        registry.remove();
        let ran = AtomicBool::new(false);
        assert!(matches!(
            registry.with_creation(&CancellationToken::new(), || {
                ran.store(true, Ordering::SeqCst);
                Ok(())
            }),
            Err(RomWeaverError::Cancelled)
        ));
        assert!(!ran.load(Ordering::SeqCst));
        let late_file = temp.path().join("late.bin");
        fs::write(&late_file, b"late").expect("create late file");
        registry.register(&late_file);
        assert!(!late_file.exists());
        let late_dir = temp.path().join("late-dir");
        fs::create_dir(&late_dir).expect("create late directory");
        fs::write(late_dir.join("nested.bin"), b"late").expect("create late nested file");
        registry.register(&late_dir);
        assert!(!late_dir.exists());
        registry.remove();
    }

    #[test]
    fn cancelled_token_rejects_creation_without_running_callback() {
        let registry = LiveTempDirs::default();
        let token = CancellationToken::new();
        token.cancel();
        let ran = AtomicBool::new(false);
        assert!(matches!(
            registry.with_creation(&token, || {
                ran.store(true, Ordering::SeqCst);
                Ok(())
            }),
            Err(RomWeaverError::Cancelled)
        ));
        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(
            registry
                .with_creation(&CancellationToken::new(), || Ok(42))
                .expect("local cancellation MUST NOT close registry"),
            42
        );
    }

    #[test]
    fn public_wrappers_close_only_subprocess_registry() {
        const CHILD: &str = "ROM_WEAVER_LIVE_TEMP_LIFECYCLE_CHILD";
        const VERIFIED: &str = "LIVE_TEMP_PUBLIC_WRAPPERS_VERIFIED";
        if std::env::var_os(CHILD).as_deref() == Some(std::ffi::OsStr::new("1")) {
            let (done_tx, done_rx) = mpsc::channel();
            let worker = thread::spawn(move || {
                let temp = TempDir::new("public-live-temp");
                let partial = temp.path().join("partial");
                let completed = temp.path().join("completed.bin");
                let neighbor = temp.path().join("neighbor.bin");
                with_output_creation(&CancellationToken::new(), || {
                    fs::create_dir(&partial)?;
                    register_live_temp_dir(&partial);
                    fs::write(partial.join("partial.bin"), b"partial")?;
                    fs::write(&completed, b"complete")?;
                    register_live_temp_dir(&completed);
                    unregister_live_temp_dir(&completed);
                    fs::write(&neighbor, b"neighbor")?;
                    Ok(())
                })
                .expect("public create/register/unregister transaction");
                remove_live_temp_dirs();
                assert!(!partial.exists());
                assert_eq!(
                    fs::read(&completed).expect("read completed public output"),
                    b"complete"
                );
                assert_eq!(
                    fs::read(&neighbor).expect("read public neighbor"),
                    b"neighbor"
                );
                assert!(matches!(
                    with_output_creation::<()>(&CancellationToken::new(), || {
                        panic!("closed public registry MUST reject callback")
                    }),
                    Err(RomWeaverError::Cancelled)
                ));
                let late = temp.path().join("late.bin");
                fs::write(&late, b"late").expect("create late public entry");
                register_live_temp_dir(&late);
                assert!(!late.exists());
                done_tx
                    .send(())
                    .expect("announce public wrapper completion");
            });
            done_rx
                .recv_timeout(DEADLINE)
                .expect("public wrappers complete");
            worker.join().expect("public wrapper worker");
            println!("{VERIFIED}");
            return;
        }

        with_output_creation(&CancellationToken::new(), || Ok(()))
            .expect("parent registry starts open");
        let isolated = TempDir::new("public-live-temp-environment");
        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "cancel::tests::live_temp_lifecycle::public_wrappers_close_only_subprocess_registry",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("HOME", isolated.path())
            .env("XDG_CONFIG_HOME", isolated.path().join("config"))
            .env("XDG_CACHE_HOME", isolated.path().join("cache"))
            .env("XDG_DATA_HOME", isolated.path().join("data"))
            .env("XDG_STATE_HOME", isolated.path().join("state"))
            .stdin(Stdio::null())
            .output()
            .expect("run isolated public wrapper test");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "stdout: {stdout}\nstderr: {stderr}"
        );
        assert!(stdout.contains(VERIFIED), "{stdout}");
        assert!(stdout.contains("1 passed; 0 failed"), "{stdout}");
        with_output_creation(&CancellationToken::new(), || Ok(()))
            .expect("child cleanup MUST NOT close parent registry");
    }
}
