use std::fs;

use assert_fs::prelude::*;

use super::{PathAccessError, check_readable, check_writable_dir};

/// Root ignores the permission bits these tests set, so the denial cases would
/// spuriously pass. Skip them there rather than assert something untrue.
#[cfg(unix)]
fn running_as_root() -> bool {
    rom_weaver_core::effective_ids().is_some_and(|(uid, _)| uid == 0)
}

#[test]
fn readable_file_passes() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let file = temp.child("rom.bin");
    file.write_binary(b"data").expect("write rom");
    assert!(check_readable(file.path()).is_ok());
}

#[test]
fn readable_directory_passes() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    assert!(check_readable(temp.path()).is_ok());
}

#[test]
fn missing_path_is_reported_as_missing() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let missing = temp.child("nope.bin");
    assert!(matches!(
        check_readable(missing.path()),
        Err(PathAccessError::Missing)
    ));
}

#[cfg(unix)]
#[test]
fn unreadable_file_is_denied_with_the_path_in_the_message() {
    use std::os::unix::fs::PermissionsExt;

    if running_as_root() {
        return;
    }
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let file = temp.child("locked.bin");
    file.write_binary(b"data").expect("write rom");
    fs::set_permissions(file.path(), fs::Permissions::from_mode(0o000)).expect("chmod");

    let Err(PathAccessError::Denied(error)) = check_readable(file.path()) else {
        panic!("an unreadable file must be denied, not accepted");
    };
    let message = error.to_string();
    assert!(
        message.starts_with("i/o error: cannot open `"),
        "message must name the operation: {message}"
    );
    assert!(
        message.contains(&file.path().display().to_string()),
        "message must name the path: {message}"
    );
    assert!(
        message.contains("this process runs as"),
        "a denial must explain which identity was refused: {message}"
    );
    assert_eq!(error.permission_denied_path(), Some(file.path()));
}

#[cfg(unix)]
#[test]
fn a_file_inside_an_untraversable_directory_is_denied_not_missing() {
    use std::os::unix::fs::PermissionsExt;

    if running_as_root() {
        return;
    }
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let locked = temp.child("locked-dir");
    locked.create_dir_all().expect("create dir");
    let inner = locked.child("rom.bin");
    inner.write_binary(b"data").expect("write rom");
    fs::set_permissions(locked.path(), fs::Permissions::from_mode(0o000)).expect("chmod");

    let outcome = check_readable(inner.path());
    // Restore before asserting so the temp dir can always clean itself up.
    fs::set_permissions(locked.path(), fs::Permissions::from_mode(0o755)).expect("restore");
    assert!(
        matches!(outcome, Err(PathAccessError::Denied(_))),
        "a traversal denial must not be reported as a missing path"
    );
}

#[test]
fn writable_dir_passes_and_leaves_no_probe_behind() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    assert!(check_writable_dir(temp.path()).is_ok());
    let leftovers: Vec<_> = fs::read_dir(temp.path())
        .expect("read dir")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    assert!(
        leftovers.is_empty(),
        "probe file was left behind: {leftovers:?}"
    );
}

#[test]
fn a_leftover_probe_is_cleaned_up_and_still_proves_writability() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let leftover = temp.child(".rom-weaver-write-probe");
    leftover.write_binary(b"").expect("leftover probe");

    assert!(check_writable_dir(temp.path()).is_ok());
    assert!(
        !leftover.path().exists(),
        "the leftover probe must not survive the check"
    );
}

#[test]
fn missing_output_dir_is_created() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let nested = temp.path().join("out").join("deeper");
    assert!(check_writable_dir(&nested).is_ok());
    assert!(nested.is_dir(), "the output directory must be created");
}

#[cfg(unix)]
#[test]
fn read_only_output_dir_is_denied() {
    use std::os::unix::fs::PermissionsExt;

    if running_as_root() {
        return;
    }
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let output = temp.child("out");
    output.create_dir_all().expect("create dir");
    fs::set_permissions(output.path(), fs::Permissions::from_mode(0o555)).expect("chmod");

    let outcome = check_writable_dir(output.path());
    fs::set_permissions(output.path(), fs::Permissions::from_mode(0o755)).expect("restore");

    let error = outcome.expect_err("a read-only directory must be denied");
    let message = error.to_string();
    assert!(
        message.contains("cannot write to `"),
        "message must name the operation: {message}"
    );
    assert_eq!(error.permission_denied_path(), Some(output.path()));
}
