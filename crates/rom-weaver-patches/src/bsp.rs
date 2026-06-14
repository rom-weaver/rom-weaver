use std::{fs, path::Path};
#[cfg(test)]
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchCreateRequest, PatchHandler, Result, RomWeaverError, SharedThreadPool, ThreadCapability,
    UnsupportedOp,
};
use tracing::{debug, trace};

use crate::shared::threading::parallel_chunked_capability;

#[cfg(test)]
const BSP_VM_SOURCE: &str = include_str!("bsp_vm_runtime.js");
const BSP_THREAD_WORK_CHUNK_BYTES: usize = 1024 * 1024;
#[cfg(test)]
static BSP_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct BspPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl BspPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    /* jscpd:ignore-start */
    fn parse_report(&self, patch_path: &Path) -> Result<OperationReport> {
        crate::patch_parse_report_with(self.descriptor, || {
            let patch_len = fs::metadata(patch_path)?.len();
            Ok(build_bsp_parse_label(self.descriptor.name, patch_len))
        })
    }

    fn apply_report(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        debug!(
            format = self.descriptor.name,
            patch = %patch_path.display(),
            "bsp patch apply start"
        );
        let input_len = usize::try_from(fs::metadata(&request.input)?.len()).map_err(|_| {
            RomWeaverError::Validation("BSP input exceeded addressable memory".into())
        })?;
        let patch_len = usize::try_from(fs::metadata(patch_path)?.len()).map_err(|_| {
            RomWeaverError::Validation("BSP patch exceeded addressable memory".into())
        })?;
        let (execution, pool) =
            context.build_pool(bsp_apply_thread_capability(input_len, patch_len))?;
        trace!(
            format = self.descriptor.name,
            input_len,
            patch_len,
            parallel = execution.used_parallelism,
            threads = execution.effective_threads,
            "bsp apply thread plan (VM edits output in place)"
        );

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        // The BSP VM edits its target file in place. Seed the output with the
        // input and run the script directly against it, rather than working on a
        // separate staged file and copying the result over. A logical rename is
        // NOT free on OPFS (the bytes are still persisted under the output name
        // on flush), so the old stage-then-copy path paid a full extra 128 MiB+
        // copy in the browser. Working directly on the output removes it.
        //
        // `input == output` would let `fs::copy` truncate the source before
        // reading it, so apply in place in that case and never delete it on
        // failure. Otherwise the partial output is removed so callers never see a
        // half-applied file (the VM can exit non-zero mid-run).
        let in_place = request.input == request.output;
        trace!(
            format = self.descriptor.name,
            in_place, "bsp apply output seeding decision"
        );
        if !in_place {
            fs::copy(&request.input, &request.output)?;
        }
        let apply_result = apply_bsp_patch_path(
            patch_path,
            &request.output,
            execution.used_parallelism.then_some(&pool),
        );
        let written = match apply_result {
            Ok(written) => written,
            Err(error) => {
                if !in_place {
                    let _ = fs::remove_file(&request.output);
                }
                return Err(error);
            }
        };
        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch script and wrote {} byte(s)",
                self.descriptor.name, written
            ),
            Some(execution),
        ))
    }
    /* jscpd:ignore-end */
}

impl PatchHandler for BspPatchHandler {
    /* jscpd:ignore-start */
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        self.parse_report(patch_path)
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.apply_report(request, context)
    }
    /* jscpd:ignore-end */

    fn create(
        &self,
        _request: &PatchCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Unsupported(
            UnsupportedOp::PatchCreateNotImplemented {
                format: "BSP",
                alternative: "an upstream BSP compiler",
            },
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: true,
        }
    }
}

#[cfg(test)]
fn apply_bsp_patch_bytes(
    patch_bytes: &[u8],
    input_bytes: Vec<u8>,
    pool: Option<&SharedThreadPool>,
) -> Result<Vec<u8>> {
    let temp_path = bsp_temp_path();
    if let Some(parent) = temp_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let write_result = (|| -> Result<Vec<u8>> {
        fs::write(&temp_path, &input_bytes)?;
        apply_bsp_patch_file(patch_bytes, &temp_path, pool)?;
        Ok(fs::read(&temp_path)?)
    })();
    let _ = fs::remove_file(&temp_path);
    write_result
}

#[cfg(test)]
fn apply_bsp_patch_file(
    patch_bytes: &[u8],
    input_path: &Path,
    pool: Option<&SharedThreadPool>,
) -> Result<u64> {
    crate::bsp_native_vm::apply_bsp_patch_file_native(patch_bytes, input_path, pool)
}

fn apply_bsp_patch_path(
    patch_path: &Path,
    input_path: &Path,
    pool: Option<&SharedThreadPool>,
) -> Result<u64> {
    crate::bsp_native_vm::apply_bsp_patch_file_native_from_path(patch_path, input_path, pool)
}

#[cfg(test)]
fn bsp_temp_path() -> PathBuf {
    let counter = BSP_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "rom-weaver-bsp-test-{}-{nanos}-{counter}.bin",
        std::process::id()
    ))
}

fn bsp_apply_thread_capability(input_len: usize, patch_len: usize) -> ThreadCapability {
    let work_bytes = input_len.max(patch_len).max(1);
    parallel_chunked_capability(work_bytes as u64, BSP_THREAD_WORK_CHUNK_BYTES as u64)
}

fn build_bsp_parse_label(format_name: &str, patch_len: u64) -> String {
    format!(
        "parsed {format_name} patch script ({patch_len} byte(s)); semantic validation occurs during apply"
    )
}

#[cfg(test)]
#[path = "../tests/unit/bsp.rs"]
mod tests;
