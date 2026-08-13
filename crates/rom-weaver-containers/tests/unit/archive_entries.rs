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
fn sanitize_archive_paths_normalizes_dots_and_rejects_unsafe_names() {
    assert_eq!(
        sanitize_archive_relative_path_from_str("dir/./file.bin").expect("normalized path"),
        PathBuf::from("dir/file.bin")
    );

    for unsafe_name in ["../escape.bin", "/absolute.bin", r"..\escape.bin", ".", ""] {
        let error = sanitize_archive_relative_path_from_str(unsafe_name)
            .expect_err("unsafe archive path must be rejected");
        assert!(matches!(error, RomWeaverError::Validation(_)));
    }
}

#[test]
fn collect_archive_inputs_handles_a_tiny_directory_tree() {
    let temp = TempDir::new("archive-entries");
    let input_root = temp.path().join("fixture");
    let nested = input_root.join("nested");
    fs::create_dir_all(&nested).expect("create nested fixture directory");
    fs::write(input_root.join("z.bin"), b"12").expect("write z fixture");
    fs::write(input_root.join("a.bin"), b"345").expect("write a fixture");
    fs::write(nested.join("nested.bin"), b"6").expect("write nested fixture");

    let entries =
        collect_archive_inputs(std::slice::from_ref(&input_root)).expect("collect archive inputs");
    let names = entries
        .iter()
        .map(|entry| entry.archive_name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "fixture",
            "fixture/a.bin",
            "fixture/nested",
            "fixture/nested/nested.bin",
            "fixture/z.bin",
        ]
    );
    assert!(entries[0].is_dir);
    assert!(entries[2].is_dir);
    assert_eq!(sum_input_file_bytes(&entries), 6);

    assert!(collect_archive_inputs(&[]).is_err());
}
