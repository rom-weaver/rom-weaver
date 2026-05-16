use std::{fs, io::Cursor, path::Path};

use qbsdiff::{Bsdiff, Bspatch, ParallelScheme};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

pub struct BdfPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl BdfPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for BdfPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch_bytes = fs::read(patch_path)?;
        let patcher = Bspatch::new(&patch_bytes)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch targeting {} byte(s)",
                self.descriptor.name,
                patcher.hint_target_size()
            ),
            Some(1.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.patches.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} apply expects exactly one patch file",
                self.descriptor.name
            )));
        }

        let patch_bytes = fs::read(&request.patches[0])?;
        let patcher = Bspatch::new(&patch_bytes)?;
        let input = fs::read(&request.input)?;

        let output_capacity = usize::try_from(patcher.hint_target_size()).map_err(|_| {
            RomWeaverError::Validation("BSDIFF40 output size exceeded addressable memory".into())
        })?;
        let mut output = Vec::with_capacity(output_capacity);
        patcher.apply(&input, Cursor::new(&mut output))?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &output)?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch and wrote {} byte(s)",
                self.descriptor.name,
                output.len()
            ),
            Some(1.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let source = fs::read(&request.original)?;
        if source.len() > qbsdiff::bsdiff::MAX_LENGTH {
            return Err(RomWeaverError::Validation(format!(
                "BSDIFF40 source exceeds maximum supported size of {} byte(s)",
                qbsdiff::bsdiff::MAX_LENGTH
            )));
        }
        let target = fs::read(&request.modified)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut patch = Vec::new();
        Bsdiff::new(&source, &target)
            .parallel_scheme(ParallelScheme::Never)
            .compare(Cursor::new(&mut patch))?;
        fs::write(&request.output, &patch)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch ({} byte(s))",
                self.descriptor.name,
                patch.len()
            ),
            Some(1.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: true,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::PathBuf,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, NoopProgressSink, OperationContext, PatchApplyRequest,
        PatchCreateRequest, PatchHandler, ThreadBudget,
    };

    use super::BdfPatchHandler;
    use crate::BDF_BSDIFF40;

    static NEXT_TEST_DIR_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos();
            let sequence = NEXT_TEST_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "rom-weaver-bdf-tests-{}-{timestamp}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir_all(&path).expect("temp dir");
            Self { path }
        }

        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parse_rejects_invalid_patch_header() {
        let temp = TestDir::new();
        let patch_path = temp.child("broken.bdf");
        fs::write(&patch_path, b"not-a-valid-patch").expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        let error = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect_err("parse should fail");
        assert!(error.to_string().contains("not a valid patch"));
    }

    #[test]
    fn create_and_apply_round_trip() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.bdf");
        let output_path = temp.child("output.bin");

        let source = b"The quick brown fox jumps over the lazy dog.";
        let target = b"The quick brown cat jumps over two lazy dogs!";
        fs::write(&source_path, source).expect("fixture");
        fs::write(&target_path, target).expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        let create_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "BDF/BSDIFF40".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");

        let execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        let patch_bytes = fs::read(&patch_path).expect("patch");
        assert_eq!(&patch_bytes[..8], b"BSDIFF40");

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), target);
    }

    #[test]
    fn apply_rejects_multiple_patch_files() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.bdf");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abc").expect("fixture");
        fs::write(&target_path, b"abZ").expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path,
                    output: patch_path.clone(),
                    format: "BDF/BSDIFF40".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path.clone(), patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("apply should fail");

        assert!(error.to_string().contains("expects exactly one patch file"));
    }

    fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            temp.child("temp"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }
}
