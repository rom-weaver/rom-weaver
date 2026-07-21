use std::path::Path;

use super::access_advice;

#[cfg(unix)]
#[test]
fn advice_reports_the_mode_and_owner_of_an_existing_path() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let advice = access_advice(temp.path()).expect("unix advice");
    assert!(
        advice.contains(&format!("`{}` is mode", temp.path().display())),
        "advice must name the path and its mode: {advice}"
    );
    assert!(
        advice.contains("this process runs as"),
        "advice must name the running identity: {advice}"
    );
}

#[cfg(unix)]
#[test]
fn advice_falls_back_to_the_nearest_existing_ancestor() {
    // A denial while creating an output names the directory that refused it, not
    // the file that was never created.
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let missing = temp.path().join("no-such-dir").join("output.bin");
    let advice = access_advice(&missing).expect("unix advice");
    assert!(
        advice.contains(&format!("`{}` is mode", temp.path().display())),
        "advice must fall back to the existing ancestor: {advice}"
    );
}

#[cfg(unix)]
#[test]
fn advice_survives_a_path_with_no_existing_ancestor() {
    // Still useful: the identity line does not depend on the path resolving.
    let advice =
        access_advice(Path::new("relative-path-that-does-not-exist")).expect("unix advice");
    assert!(advice.contains("this process runs as"), "{advice}");
}
