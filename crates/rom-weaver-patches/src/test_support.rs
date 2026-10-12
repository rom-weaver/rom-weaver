use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rom_weaver_core::{
    CancellationToken, NoopProgressSink, OperationContext, OperationReport, PatchApplyRequest,
    PatchChecksumValidation, PatchCreateRequest, PatchHandler, ThreadBudget,
};

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

/// The normalized `details.patch.endpoints` array of a parse/describe report.
pub(crate) fn report_endpoints(
    report: &rom_weaver_core::OperationReport,
) -> Vec<serde_json::Value> {
    report
        .details
        .as_ref()
        .expect("report details")
        .get("patch")
        .and_then(|patch| patch.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .cloned()
        .expect("details.patch.endpoints")
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
    // Patch-apply unit tests exercise the parallel streaming path (thread budgets, ordered writes,
    // overlap fallback). Production now applies in memory by default (covered end-to-end by
    // cli_smoke), so force the streaming path here to keep that coverage. A test that wants the
    // in-memory path can override via `with_patch_apply_in_memory_limit`.
    OperationContext::new(
        ThreadBudget::Fixed(threads),
        temp_root,
        Arc::new(NoopProgressSink),
        CancellationToken::new(),
    )
    .with_patch_apply_in_memory_limit(0)
}

/// One `PatchHandler::create` -> `apply` round-trip exercised by the per-format
/// unit tests. Captures the shared skeleton (write `source`/`target` fixtures,
/// `create` the patch, `apply` it, and assert the applied output equals
/// `target`) while leaving each test's unique extra assertions (thread-execution
/// checks, patch-byte inspection) to the caller via the returned create report.
pub(crate) struct RoundTripCase<'a> {
    /// Original input bytes written to `source.bin`.
    pub source: &'a [u8],
    /// Modified bytes written to `target.bin` and expected after apply.
    pub target: &'a [u8],
    /// `--format` value passed to `PatchCreateRequest`.
    pub format: &'a str,
    /// Extension for the generated patch file (e.g. `"ups"`, `"bdf"`).
    pub patch_extension: &'a str,
    /// Thread budget used when creating the patch.
    pub create_threads: usize,
    /// Thread budget used when applying the patch.
    pub apply_threads: usize,
    /// When `true`, re-apply the patch to the freshly produced output and
    /// assert the result equals `source` (symmetric formats only).
    pub reverse: bool,
    /// Optional assertion over the freshly created patch bytes (e.g. magic).
    pub patch_assert: Option<fn(&[u8])>,
    /// When `true`, build operation contexts rooted at the temp dir itself
    /// (`test_context_with_threads_in_root`) rather than a `temp` subdir.
    pub in_root: bool,
    /// Optional patch-checksum-validation override applied to the `apply`
    /// (and reverse-apply) contexts only. `None` keeps the context default.
    pub apply_checksum_validation: Option<PatchChecksumValidation>,
}

impl<'a> RoundTripCase<'a> {
    /// A round-trip with the common defaults: `create_threads = 8`,
    /// `apply_threads = 4`, no reverse apply. Callers tweak fields as needed.
    pub(crate) fn new(source: &'a [u8], target: &'a [u8], format: &'a str) -> Self {
        Self {
            source,
            target,
            format,
            patch_extension: "patch",
            create_threads: 8,
            apply_threads: 4,
            reverse: false,
            patch_assert: None,
            in_root: false,
            apply_checksum_validation: None,
        }
    }
}

/// Run a `create` -> `apply` round-trip for `handler` and assert the applied
/// output is byte-identical to `case.target` (and, when `case.reverse`, that a
/// re-apply reproduces `case.source`). Returns the `create` report so callers
/// can layer their own assertions (thread execution, emitted patch bytes).
pub(crate) fn assert_round_trip(
    handler: &dyn PatchHandler,
    case: &RoundTripCase<'_>,
) -> OperationReport {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child(&format!("update.{}", case.patch_extension));
    let output_path = temp.child("output.bin");

    fs::write(&source_path, case.source).expect("source fixture");
    fs::write(&target_path, case.target).expect("target fixture");

    let make_context = |threads: usize| {
        if case.in_root {
            test_context_with_threads_in_root(&temp, threads)
        } else {
            test_context_with_threads(&temp, threads)
        }
    };
    let apply_context = |threads: usize| {
        let context = make_context(threads);
        match case.apply_checksum_validation {
            Some(validation) => context.with_patch_checksum_validation(validation),
            None => context,
        }
    };

    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: case.format.to_string(),
            },
            &make_context(case.create_threads),
        )
        .expect("create");

    if let Some(check) = case.patch_assert {
        check(&fs::read(&patch_path).expect("patch bytes"));
    }

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &apply_context(case.apply_threads),
        )
        .expect("apply");

    assert_eq!(fs::read(&output_path).expect("output"), case.target);

    if case.reverse {
        let reverse_output = temp.child("reverse.bin");
        handler
            .apply(
                &PatchApplyRequest {
                    input: output_path,
                    patches: vec![patch_path],
                    output: reverse_output.clone(),
                },
                &apply_context(case.apply_threads),
            )
            .expect("reverse apply");
        assert_eq!(
            fs::read(&reverse_output).expect("reverse output"),
            case.source
        );
    }

    create_report
}
