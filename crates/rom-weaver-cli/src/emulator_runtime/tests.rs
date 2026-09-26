use super::*;
use flate2::{Compression, write::GzEncoder};

fn fixture() -> Vec<(&'static str, Vec<u8>)> {
    let runner = b"#!/bin/sh\nexit 0\n".to_vec();
    let core = b"fixture core".to_vec();
    let manifest = json!({
        "schemaVersion": 1, "platform": PLATFORM,
        "retroarch": { "path": "bin/retroarch", "revision": "a".repeat(40),
            "sha256": sha256_hex(&runner) },
        "cores": [{ "id": "fceumm", "platform": "nes", "path": "cores/fceumm_libretro.so",
            "revision": "b".repeat(40), "sha256": sha256_hex(&core) }],
    });
    vec![
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("bin/retroarch", runner),
        ("cores/fceumm_libretro.so", core),
    ]
}

fn archive(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = tar::Builder::new(encoder);
    for (path, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, path, bytes.as_slice())
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn options(root: &Path, bytes: &[u8]) -> InstallCommand {
    let source = root.join("runtime.tar.gz");
    fs::write(&source, bytes).unwrap();
    InstallCommand {
        archive: Some(source),
        sha256: Some(sha256_hex(bytes)),
        runtime_dir: Some(root.join("installed")),
    }
}

#[test]
fn offline_install_verifies_files_and_preserves_existing_runtime() {
    let temp = assert_fs::TempDir::new().unwrap();
    let args = options(temp.path(), &archive(&fixture()));
    let result = install(&args, false).unwrap();
    assert_eq!(result["core"], "fceumm");
    let runtime = resolve(args.runtime_dir.as_deref()).unwrap();
    assert_eq!(fs::read(&runtime.core).unwrap(), b"fixture core");
    assert_eq!(runtime.retroarch_revision, "a".repeat(40));
    fs::write(args.archive.as_ref().unwrap(), b"not an archive").unwrap();
    assert!(
        install(&args, false).unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("already installed")
    );
    assert_eq!(fs::read(&runtime.core).unwrap(), b"fixture core");
}

#[test]
fn bad_archive_hash_and_dry_run_leave_no_destination() {
    let temp = assert_fs::TempDir::new().unwrap();
    let mut args = options(temp.path(), &archive(&fixture()));
    args.sha256 = Some("0".repeat(64));
    assert!(
        install(&args, false)
            .unwrap_err()
            .to_string()
            .contains("SHA-256")
    );
    assert!(!args.runtime_dir.as_ref().unwrap().exists());
    args.archive = Some(temp.path().join("missing.tar.gz"));
    assert_eq!(install(&args, true).unwrap()["dry_run"], true);
    assert!(!args.runtime_dir.as_ref().unwrap().exists());
}

#[test]
fn changed_executable_and_symlinked_core_are_rejected() {
    let temp = assert_fs::TempDir::new().unwrap();
    let args = options(temp.path(), &archive(&fixture()));
    install(&args, false).unwrap();
    let runtime = resolve(args.runtime_dir.as_deref()).unwrap();
    fs::write(&runtime.retroarch, b"#!/bin/sh\necho changed\n").unwrap();
    assert!(
        resolve(args.runtime_dir.as_deref())
            .unwrap_err()
            .to_string()
            .contains("checksum mismatch")
    );
    fs::write(&runtime.retroarch, &fixture()[1].1).unwrap();
    fs::remove_file(&runtime.core).unwrap();
    std::os::unix::fs::symlink(&runtime.retroarch, &runtime.core).unwrap();
    assert!(
        resolve(args.runtime_dir.as_deref())
            .unwrap_err()
            .to_string()
            .contains("symlink")
    );
}

#[test]
fn bad_manifest_does_not_publish_staging_files() {
    let temp = assert_fs::TempDir::new().unwrap();
    let mut files = fixture();
    let mut manifest: Value = serde_json::from_slice(&files[0].1).unwrap();
    manifest["retroarch"]["path"] = json!("../outside");
    files[0].1 = serde_json::to_vec(&manifest).unwrap();
    let args = options(temp.path(), &archive(&files));
    assert!(install(&args, false).is_err());
    assert!(!args.runtime_dir.as_ref().unwrap().exists());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[test]
fn duplicate_archive_entries_are_rejected() {
    let temp = assert_fs::TempDir::new().unwrap();
    let mut files = fixture();
    files.push(("bin/retroarch", b"overwrite".to_vec()));
    let args = options(temp.path(), &archive(&files));
    assert!(
        install(&args, false)
            .unwrap_err()
            .to_string()
            .contains("duplicate")
    );
    assert!(!args.runtime_dir.as_ref().unwrap().exists());
}

#[test]
fn archive_traversal_links_and_large_entries_are_rejected() {
    for kind in ["traversal", "symlink", "oversized"] {
        let temp = assert_fs::TempDir::new().unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        header.set_size(0);
        header.set_path("bad").unwrap();
        match kind {
            "traversal" => {
                let name = b"../outside";
                header.as_mut_bytes()[..100].fill(0);
                header.as_mut_bytes()[..name.len()].copy_from_slice(name);
            }
            "symlink" => {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_link_name("../outside").unwrap();
            }
            "oversized" => header.set_size(MAX_UNPACKED_BYTES + 1),
            _ => unreachable!(),
        }
        header.set_cksum();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(header.as_bytes()).unwrap();
        encoder.write_all(&[0; 1024]).unwrap();
        let bytes = encoder.finish().unwrap();
        let args = options(temp.path(), &bytes);
        assert!(install(&args, false).is_err(), "{kind} must fail");
        assert!(!args.runtime_dir.as_ref().unwrap().exists());
        assert!(!temp.path().join("outside").exists());
    }
}

#[test]
fn existing_unrecognized_directory_is_preserved() {
    let temp = assert_fs::TempDir::new().unwrap();
    let args = options(temp.path(), &archive(&fixture()));
    let destination = args.runtime_dir.as_ref().unwrap();
    fs::create_dir(destination).unwrap();
    fs::write(destination.join("keep"), b"existing data").unwrap();
    assert!(install(&args, false).is_err());
    assert_eq!(
        fs::read(destination.join("keep")).unwrap(),
        b"existing data"
    );
}
