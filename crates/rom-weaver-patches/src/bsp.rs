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
};

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
        let input_len = usize::try_from(fs::metadata(&request.input)?.len()).map_err(|_| {
            RomWeaverError::Validation("BSP input exceeded addressable memory".into())
        })?;
        let patch_len = usize::try_from(fs::metadata(patch_path)?.len()).map_err(|_| {
            RomWeaverError::Validation("BSP patch exceeded addressable memory".into())
        })?;
        let (execution, pool) =
            context.build_pool(bsp_apply_thread_capability(input_len, patch_len))?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let staged_output_path = context.temp_paths().next_path(
            "bsp-apply-staged-output",
            request.output.extension().and_then(|value| value.to_str()),
        );
        if let Some(parent) = staged_output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&request.input, &staged_output_path)?;

        let apply_result = apply_bsp_patch_path(
            patch_path,
            &staged_output_path,
            execution.used_parallelism.then_some(&pool),
        );
        let result = (|| -> Result<u64> {
            let written = apply_result?;
            fs::copy(&staged_output_path, &request.output)?;
            Ok(written)
        })();
        let _ = fs::remove_file(&staged_output_path);
        let written = result?;
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
            "BSP patch creation is not implemented; use an upstream BSP compiler".into(),
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
    let chunk_count = work_bytes.div_ceil(BSP_THREAD_WORK_CHUNK_BYTES);
    ThreadCapability::parallel(Some(chunk_count.max(1)))
}

fn build_bsp_parse_label(format_name: &str, patch_len: u64) -> String {
    format!(
        "parsed {format_name} patch script ({patch_len} byte(s)); semantic validation occurs during apply"
    )
}

#[cfg(test)]
#[path = "../tests/unit/bsp.rs"]
mod tests;
