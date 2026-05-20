use std::{fs, path::Path};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchCreateRequest, PatchHandler, Result, RomWeaverError, SharedThreadPool, ThreadCapability,
};

#[cfg(test)]
const BSP_VM_SOURCE: &str = include_str!("bsp_vm_runtime.js");
const BSP_THREAD_WORK_CHUNK_BYTES: usize = 1024 * 1024;

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
        let patch_bytes = crate::map_file_read_only_with_fallback(patch_path)?;
        let input_bytes = fs::read(&request.input)?;
        let (execution, pool) = context.build_pool(bsp_apply_thread_capability(
            input_bytes.len(),
            patch_bytes.len(),
        ))?;

        let output_bytes = apply_bsp_patch_bytes(
            patch_bytes.as_slice(),
            input_bytes,
            execution.used_parallelism.then_some(&pool),
        )?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &output_bytes)?;

        let written = output_bytes.len();
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

fn apply_bsp_patch_bytes(
    patch_bytes: &[u8],
    input_bytes: Vec<u8>,
    pool: Option<&SharedThreadPool>,
) -> Result<Vec<u8>> {
    crate::bsp_native_vm::apply_bsp_patch_bytes_native(patch_bytes, input_bytes, pool)
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
