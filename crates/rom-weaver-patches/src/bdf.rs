use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::Path,
};

use memmap2::{Mmap, MmapOptions};
use qbsdiff::{Bsdiff, Bspatch};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

use crate::qbsdiff_support::{qbsdiff_parallel_scheme, qbsdiff_thread_capability};

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
            Some(100.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch_bytes = fs::read(patch_path)?;
        let patcher = Bspatch::new(&patch_bytes)?;
        let input = map_file_read_only(&request.input)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        patcher.apply(input.as_ref(), &mut output)?;
        output.flush()?;
        let written = fs::metadata(&request.output)?.len();

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch and wrote {} byte(s)",
                self.descriptor.name, written
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let source = map_file_read_only(&request.original)?;
        if source.len() > qbsdiff::bsdiff::MAX_LENGTH {
            return Err(RomWeaverError::Validation(format!(
                "BSDIFF40 source exceeds maximum supported size of {} byte(s)",
                qbsdiff::bsdiff::MAX_LENGTH
            )));
        }
        let target = map_file_read_only(&request.modified)?;
        let (execution, pool) = context.build_pool(qbsdiff_thread_capability(target.len()))?;
        let parallel_scheme = qbsdiff_parallel_scheme(target.len());

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let patch_file = File::create(&request.output)?;
        let mut patch = BufWriter::new(patch_file);
        pool.install(|| {
            Bsdiff::new(source.as_ref(), target.as_ref())
                .parallel_scheme(parallel_scheme)
                .compare(&mut patch)
        })?;
        patch.flush()?;
        let patch_len = fs::metadata(&request.output)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch ({} byte(s))",
                self.descriptor.name, patch_len
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: true,
            threaded_scan: false,
            threaded_diff: true,
            threaded_output: false,
        }
    }
}

fn map_file_read_only(path: &Path) -> Result<Mmap> {
    let file = File::open(path)?;
    // SAFETY: This mapping is read-only and the file handle lives through map creation.
    let map = unsafe { MmapOptions::new().map(&file)? };
    Ok(map)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::BdfPatchHandler;
    use crate::{
        BDF_BSDIFF40,
        test_support::{TestDir, test_context_with_threads},
    };

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

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let source_path = temp.child("source-large.bin");
        let target_path = temp.child("target-large.bin");
        let patch_single = temp.child("single-thread.bdf");
        let patch_parallel = temp.child("parallel-thread.bdf");

        let source = build_large_fixture_bytes();
        let mut target = source.clone();
        for index in (0..target.len()).step_by(4096) {
            target[index] = target[index].wrapping_add(17);
        }
        fs::write(&source_path, &source).expect("fixture");
        fs::write(&target_path, &target).expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_single.clone(),
                    format: "bdf".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single-thread create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path,
                    modified: target_path,
                    output: patch_parallel.clone(),
                    format: "bdf".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel create");

        let single_execution = single_report
            .thread_execution
            .expect("single-thread execution");
        assert_eq!(single_execution.effective_threads, 1);
        assert!(!single_execution.used_parallelism);
        let parallel_execution = parallel_report
            .thread_execution
            .expect("parallel-thread execution");
        assert_eq!(parallel_execution.requested_threads, 8);
        assert_eq!(parallel_execution.effective_threads, 8);
        assert!(parallel_execution.used_parallelism);

        let single_patch = fs::read(&patch_single).expect("single-thread patch");
        let parallel_patch = fs::read(&patch_parallel).expect("parallel-thread patch");
        assert_eq!(single_patch, parallel_patch);
    }
    fn build_large_fixture_bytes() -> Vec<u8> {
        let mut bytes = vec![0u8; 512 * 1024];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        bytes
    }
}
