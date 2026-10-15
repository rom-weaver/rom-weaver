use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf};

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, message.into())
}

fn relative_path(value: &str) -> io::Result<&Path> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains(['\\', ':'])
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(invalid(format!("unsafe patch queue path: {value}")));
    }
    Ok(path)
}

fn safe_join(root: &Path, value: &str) -> io::Result<PathBuf> {
    let mut result = root.to_path_buf();
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(invalid(format!(
            "symlink patch queue root: {}",
            root.display()
        )));
    }
    for part in relative_path(value)?.components() {
        result.push(part);
        match fs::symlink_metadata(&result) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid(format!(
                    "symlink patch queue path: {}",
                    result.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

fn patch_path<'a>(name: Option<&'a [u8]>, prefix: &str) -> io::Result<Option<&'a str>> {
    let name = std::str::from_utf8(name.ok_or_else(|| invalid("missing patch filename"))?)
        .map_err(|error| invalid(error.to_string()))?;
    if name == "/dev/null" {
        return Ok(None);
    }
    let relative = name
        .strip_prefix(prefix)
        .ok_or_else(|| invalid(format!("missing {prefix} patch prefix: {name}")))?;
    relative_path(relative)?;
    Ok(Some(relative))
}

pub fn apply_patch(root: &Path, contents: &[u8]) -> io::Result<()> {
    let mut starts = Vec::new();
    let mut offset = 0;
    for line in contents.split_inclusive(|byte| *byte == b'\n') {
        if line.starts_with(b"diff --git ") {
            starts.push(offset);
        }
        offset += line.len();
    }
    if starts.first() != Some(&0) {
        return Err(invalid("patch MUST begin with a diff --git header"));
    }
    starts.push(contents.len());
    for pair in starts.windows(2) {
        let section = &contents[pair[0]..pair[1]];
        let patch =
            diffy::Patch::from_bytes(section).map_err(|error| invalid(error.to_string()))?;
        let original = patch_path(patch.original(), "a/")?;
        let modified = patch_path(patch.modified(), "b/")?;
        let name = match (original, modified) {
            (Some(old), Some(new)) if old == new => old,
            (Some(old), None) => old,
            (None, Some(new)) => new,
            _ => {
                return Err(invalid(
                    "patch renames and missing filenames are unsupported",
                ));
            }
        };
        if patch.hunks().is_empty() {
            return Err(invalid(format!("patch has no hunks: {name}")));
        }
        let path = safe_join(root, name)?;
        let input = if original.is_some() {
            fs::read(&path)?
        } else {
            if path.try_exists()? {
                return Err(invalid(format!(
                    "patch creation target already exists: {name}"
                )));
            }
            Vec::new()
        };
        let output = diffy::apply_bytes(&input, &patch)
            .map_err(|error| invalid(format!("cannot apply patch to {name}: {error}")))?;
        if modified.is_none() {
            if !output.is_empty() {
                return Err(invalid(format!("deletion patch leaves content: {name}")));
            }
            fs::remove_file(path)?;
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, output)?;
        }
    }
    Ok(())
}

fn field<'a>(entry: &'a serde_json::Value, name: &str) -> io::Result<&'a str> {
    entry[name]
        .as_str()
        .ok_or_else(|| invalid(format!("missing patch queue string: {name}")))
}

pub fn apply_queue(
    crate_root: &Path,
    dependency: &str,
    staged: &Path,
    stages: &[&str],
) -> io::Result<()> {
    relative_path(dependency)?;
    let queue = safe_join(crate_root, &format!("vendor-patches/{dependency}"))?;
    let manifest_path = safe_join(&queue, "manifest.json")?;
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(manifest_path)?)?;
    if manifest["version"] != 1
        || manifest["name"] != dependency
        || manifest["materialized"] != false
    {
        return Err(invalid(
            "unsupported C patch queue manifest identity/version/materialization",
        ));
    }
    let patches = manifest["patches"]
        .as_array()
        .ok_or_else(|| invalid("missing patches array"))?;
    for patch in patches {
        let stage = field(patch, "stage")?;
        if !["source", "integration", "build", "wasm", "arm64"].contains(&stage) {
            return Err(invalid(format!("unknown patch stage: {stage}")));
        }
        let file = safe_join(&queue, field(patch, "file")?)?;
        println!("cargo:rerun-if-changed={}", file.display());
        if stages.contains(&stage) {
            apply_patch(staged, &fs::read(&file)?)
                .map_err(|error| invalid(format!("{}: {error}", file.display())))?;
        }
    }
    Ok(())
}

pub fn apply_adapters(crate_root: &Path, dependency: &str, staged: &Path) -> io::Result<()> {
    relative_path(dependency)?;
    let manifest_path = safe_join(
        crate_root,
        &format!("vendor-patches/{dependency}/manifest.json"),
    )?;
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(manifest_path)?)?;
    let Some(adapters) = manifest.get("adapters") else {
        return Ok(());
    };
    for adapter in adapters
        .as_array()
        .ok_or_else(|| invalid("invalid adapters array"))?
    {
        let source = safe_join(crate_root, field(adapter, "file")?)?;
        let target = safe_join(staged, field(adapter, "target")?)?;
        println!("cargo:rerun-if-changed={}", source.display());
        let data = fs::read(source)?;
        match field(adapter, "mode")? {
            "copy" => {
                fs::write(target, data)?;
            }
            "append" => {
                let mut content = fs::read(&target)?;
                content.push(b'\n');
                content.extend(data);
                fs::write(target, content)?;
            }
            mode => return Err(invalid(format!("unknown adapter mode: {mode}"))),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn scratch() -> PathBuf {
        let root =
            PathBuf::from(option_env!("C_PATCH_CRATE_ROOT").unwrap_or(env!("CARGO_MANIFEST_DIR")))
                .join("../../.cache/agents/scratch/dependency-patch-queues/queue-tests")
                .join(format!(
                    "{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn copy_tree(source: &Path, target: &Path) {
        fs::create_dir_all(target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target.join(entry.file_name()));
            } else {
                fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
            }
        }
    }

    #[test]
    fn multiline_multiple_files_add_and_delete() {
        let root = scratch();
        fs::write(root.join("old"), "first\nsecond\nthird\n").unwrap();
        fs::write(root.join("gone"), "remove\n").unwrap();
        apply_patch(&root, b"diff --git a/old b/old\n--- a/old\n+++ b/old\n@@ -1,3 +1,3 @@\n first\n-second\n+changed\n third\ndiff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+added\n+again\ndiff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove\n").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("old")).unwrap(),
            "first\nchanged\nthird\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("new")).unwrap(),
            "added\nagain\n"
        );
        assert!(!root.join("gone").exists());
    }

    #[test]
    fn incompatible_context_fails_without_modifying_target() {
        let root = scratch();
        fs::write(root.join("file"), "unexpected\n").unwrap();
        let error = apply_patch(
            &root,
            b"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-expected\n+changed\n",
        )
        .unwrap_err();
        assert!(error.to_string().contains("cannot apply patch"));
        assert_eq!(
            fs::read_to_string(root.join("file")).unwrap(),
            "unexpected\n"
        );
    }

    #[test]
    fn unsafe_paths_are_rejected() {
        let root = scratch();
        for name in [
            "../escape",
            "/absolute",
            "dir/../../escape",
            "C:/windows",
            "dir\\escape",
        ] {
            let patch = format!(
                "diff --git a/{name} b/{name}\n--- /dev/null\n+++ b/{name}\n@@ -0,0 +1 @@\n+unsafe\n"
            );
            assert!(apply_patch(&root, patch.as_bytes()).is_err(), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_parent_is_rejected() {
        let root = scratch();
        let outside = scratch();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(apply_patch(&root, b"diff --git a/link/file b/link/file\n--- /dev/null\n+++ b/link/file\n@@ -0,0 +1 @@\n+unsafe\n").is_err());
        assert!(!outside.join("file").exists());
    }

    #[test]
    fn manifest_patch_and_adapter_paths_are_confined() {
        let root = scratch();
        let queue = root.join("vendor-patches/test");
        fs::create_dir_all(&queue).unwrap();
        let manifest = serde_json::json!({
            "version": 1, "name": "test", "materialized": false,
            "patches": [{ "file": "../../escape.patch", "stage": "build" }]
        });
        fs::write(queue.join("manifest.json"), manifest.to_string()).unwrap();
        assert!(
            apply_queue(&root, "test", &root, &["build"])
                .unwrap_err()
                .to_string()
                .contains("unsafe")
        );
        let manifest = serde_json::json!({
            "adapters": [{ "file": "../escape.c", "target": "target.c", "mode": "copy" }]
        });
        fs::write(queue.join("manifest.json"), manifest.to_string()).unwrap();
        assert!(
            apply_adapters(&root, "test", &root)
                .unwrap_err()
                .to_string()
                .contains("unsafe")
        );
    }

    #[test]
    fn actual_queues_replay_and_select_platform_stages() {
        let crate_root =
            Path::new(option_env!("C_PATCH_CRATE_ROOT").unwrap_or(env!("CARGO_MANIFEST_DIR")));
        let root = scratch();
        let archive = root.join("archive");
        copy_tree(&crate_root.join("libarchive/vendor/libarchive"), &archive);
        apply_queue(
            crate_root,
            "libarchive",
            &archive,
            &["source", "integration", "build"],
        )
        .unwrap();
        apply_adapters(crate_root, "libarchive", &archive).unwrap();
        let writer = archive.join("libarchive/archive_write_set_format_7zip.c");
        assert!(
            fs::read_to_string(&writer)
                .unwrap()
                .contains("zip->opt_threads = 1;")
        );
        assert!(
            fs::read_to_string(archive.join("libarchive/archive_read_support_format_7zip.c"))
                .unwrap()
                .contains("rom_weaver_7zip_entry_solid_block")
        );
        assert!(
            archive
                .join("libarchive/archive_write_set_format_wasm_shim.c")
                .is_file()
        );
        assert!(
            !fs::read_to_string(archive.join("libarchive/CMakeLists.txt"))
                .unwrap()
                .contains("add_subdirectory(test)")
        );
        apply_queue(crate_root, "libarchive", &archive, &["wasm"]).unwrap();
        assert!(
            fs::read_to_string(&writer)
                .unwrap()
                .contains("zip->opt_threads = 0;")
        );
        assert!(apply_queue(crate_root, "libarchive", &archive, &["build"]).is_err());
        let sdk = root.join("sdk");
        copy_tree(&crate_root.join("lzma-sdk/vendor"), &sdk);
        let arm_original = fs::read(sdk.join("Asm/arm64/LzmaDecOpt.S")).unwrap();
        apply_queue(crate_root, "lzma-sdk", &sdk, &["build"]).unwrap();
        assert_eq!(
            fs::read(sdk.join("Asm/arm64/LzmaDecOpt.S")).unwrap(),
            arm_original
        );
        assert_ne!(
            fs::read(sdk.join("C/LzmaDec.c")).unwrap(),
            fs::read(crate_root.join("lzma-sdk/vendor/C/LzmaDec.c")).unwrap()
        );
        apply_queue(crate_root, "lzma-sdk", &sdk, &["arm64"]).unwrap();
        assert_ne!(
            fs::read(sdk.join("Asm/arm64/LzmaDecOpt.S")).unwrap(),
            arm_original
        );
    }
}
