use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;

use crate::{
    ArchiveEntryKindFilter, FormatOperationKind, OperationContext, OperationFamily,
    OperationStatus, Result, RomWeaverError, SelectionMatcher, ThreadCapability, ThreadExecution,
    UnsupportedOp,
};
use tracing::trace;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormatDescriptor {
    pub family: OperationFamily,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub extensions: &'static [&'static str],
}

impl FormatDescriptor {
    pub fn matches_name(&self, candidate: &str) -> bool {
        let candidate = candidate.trim();
        self.name.eq_ignore_ascii_case(candidate)
            || self
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(candidate))
    }

    pub fn matches_path(&self, path: &Path) -> bool {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let Some(file_name) = file_name else {
            return false;
        };
        self.extensions
            .iter()
            .any(|extension| file_name.ends_with(&extension.to_ascii_lowercase()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeConfidence {
    Extension,
    Signature,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OperationReport {
    pub family: OperationFamily,
    pub format: Option<String>,
    pub stage: String,
    pub label: String,
    pub details: Option<Value>,
    pub percent: Option<f32>,
    pub thread_execution: Option<ThreadExecution>,
    pub status: OperationStatus,
}

impl OperationReport {
    fn with_status(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
        status: OperationStatus,
    ) -> Self {
        Self {
            family,
            format,
            stage: stage.into(),
            label: label.into(),
            details: None,
            percent,
            thread_execution,
            status,
        }
    }

    pub fn unsupported(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        Self::with_status(
            family,
            format,
            stage,
            label,
            None,
            thread_execution,
            OperationStatus::Unsupported,
        )
    }

    pub fn failed(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        let mut report = Self::unsupported(family, format, stage, label, thread_execution);
        report.status = OperationStatus::Failed;
        report
    }

    pub fn succeeded(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        Self::with_status(
            family,
            format,
            stage,
            label,
            percent,
            thread_execution,
            OperationStatus::Succeeded,
        )
    }

    pub fn into_event(self, command: impl Into<String>) -> crate::ProgressEvent {
        let thread_execution = self.thread_execution.as_ref();
        // Terminal failures carry a typed error kind derived once here, from the
        // single point every command finalizes through (`CliApp::finish`), so the
        // webapp keys off the generated `RomWeaverErrorKind` instead of pattern
        // matching `label`. Messages wrapped in extra context classify to `None`
        // and fall back to JS-side inference, exactly as before.
        let error_kind = match self.status {
            OperationStatus::Failed => crate::RomWeaverErrorKind::classify_message(&self.label),
            _ => None,
        };
        crate::ProgressEvent {
            command: command.into(),
            family: self.family,
            format: self.format,
            stage: self.stage,
            label: self.label,
            details: self.details,
            percent: self.percent,
            elapsed_ms: None,
            error_kind,
            status: self.status,
            ..crate::ProgressEvent::from_thread_execution(thread_execution)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerProbeRequest {
    pub source: PathBuf,
    /// For container `list`, request split CUE + per-track BIN entries instead of a single BIN.
    /// Only CHD CD listing honors this; other containers ignore it. Probe ignores it entirely.
    pub split_bin: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerListEntry {
    pub path: String,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerExtractRequest {
    pub source: PathBuf,
    pub selections: Vec<String>,
    pub kind_filter: ArchiveEntryKindFilter,
    pub out_dir: PathBuf,
    pub split_bin: bool,
    pub ignore_common_files: bool,
    pub overwrite: bool,
    /// Parent CHD for a differential (parented) CHD source. Only meaningful to the CHD handler,
    /// which fails if the source declares a parent linkage and this is `None`. Top-level and
    /// nested non-parented sources leave this `None`. Do NOT use this to flag run-local provenance -
    /// that is `containing_archive` (conflating the two made nested CHDs try to open their
    /// containing archive as a parent CHD).
    pub parent: Option<PathBuf>,
    /// The containing archive this source was extracted from, when it is a nested-archive
    /// intermediate written during this run (top-level inputs leave this `None`). Handlers use
    /// `containing_archive.is_some()` to know the source is run-local: in the browser only the main
    /// runner thread can open such a file, so a parallel extract must read it on the main thread and
    /// hand the bytes to workers (a top-level input is already synced to workers).
    pub containing_archive: Option<PathBuf>,
}

impl ContainerExtractRequest {
    /// Validate the single-output extract case: record the lone `output_name`
    /// against the requested selections, require that every selection matched it,
    /// and apply the kind filter. Shared by the seekable single-file extract
    /// handlers (cso/z3ds/xiso/nod/chd), which all emit exactly one output and
    /// previously inlined this same selection + kind-filter preamble.
    pub fn ensure_single_output_selected(&self, output_name: &str) -> Result<()> {
        let mut selections = SelectionMatcher::new(&self.selections);
        selections.matches(output_name);
        selections.ensure_all_matched()?;
        if !self
            .kind_filter
            .matches_payload_or_container_name(output_name)
        {
            return Err(RomWeaverError::Validation(format!(
                "no extract entries from `{}` matched {}",
                self.source.display(),
                self.kind_filter.flag_label()
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerCreateRequest {
    pub inputs: Vec<PathBuf>,
    pub output: PathBuf,
    pub format: String,
    pub codec: Option<String>,
    pub level: Option<i32>,
    pub parent: Option<PathBuf>,
}

/// Where a container create handler should read one input from, when the bytes
/// are not (or not yet) the file the request would otherwise open.
#[derive(Clone)]
pub enum CreateInputSource {
    /// Read the input from this path on disk.
    Path(PathBuf),
    /// Read the input from these in-memory bytes instead of any path.
    Bytes(Arc<[u8]>),
}

/// Redirect one resolved create input to alternate bytes without restaging the
/// rest. Disc-image create handlers (CHD) use this to read every untouched
/// track in place from the original disc while sourcing only the freshly
/// produced track from a temp file or memory - avoiding a whole-disc scratch
/// copy. `original_path` matches the on-disk path the handler would otherwise
/// open for that input (e.g. a track resolved relative to the disc sheet).
#[derive(Clone)]
pub struct CreateInputOverride {
    pub original_path: PathBuf,
    pub source: CreateInputSource,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchApplyRequest {
    pub input: PathBuf,
    pub patches: Vec<PathBuf>,
    pub output: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchValidateRequest {
    pub input: PathBuf,
    pub patches: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchCreateRequest {
    pub original: PathBuf,
    pub modified: PathBuf,
    pub output: PathBuf,
    pub format: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChecksumRequest {
    pub source: PathBuf,
    pub algorithms: Vec<String>,
    pub start: Option<u64>,
    pub length: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerCapabilities {
    pub probe_details: bool,
    pub extract: bool,
    pub create: bool,
    pub extract_threads: ThreadCapability,
    pub create_threads: ThreadCapability,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchCapabilities {
    pub parse: bool,
    pub apply: bool,
    pub create: bool,
    pub threaded_scan: bool,
    pub threaded_diff: bool,
    pub threaded_output: bool,
}

/// Whether a registered container may run `create`/`create_dry_run_size`. For
/// extract-only formats the wrapper returns a uniform extract-only error instead
/// of dispatching to the inner handler.
pub enum CreateSupport {
    Supported,
    ExtractOnly { supported_create_formats: String },
}

/// Static, per-handler metadata folded into the single container wrapper.
///
/// Containers register through exactly ONE wrapper (matching patches/codecs):
/// keeping capabilities + the create gate as data here - rather than in a second
/// hand-forwarding wrapper - is what prevents a newly added
/// `ContainerHandlerOperations` method from silently resolving to its trait
/// default in a layer someone forgot to update.
pub struct ContainerHandlerRegistration {
    pub descriptor: &'static FormatDescriptor,
    pub capabilities: ContainerCapabilities,
    pub is_single_payload_disc_image: bool,
    pub create_support: CreateSupport,
}

pub fn traced_container_handler(
    handler: Arc<dyn ContainerHandlerOperations>,
    registration: ContainerHandlerRegistration,
) -> Arc<dyn ContainerHandler> {
    Arc::new(TracingContainerHandler {
        inner: handler,
        registration,
    })
}

pub fn traced_patch_handler(handler: Arc<dyn PatchHandler>) -> Arc<dyn PatchHandler> {
    Arc::new(TracingPatchHandler { inner: handler })
}

pub trait ContainerHandlerOperations: Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;
    fn probe(&self, source: &Path) -> ProbeConfidence {
        let _ = source;
        ProbeConfidence::Extension
    }
    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        let _ = (request, context);
        Err(RomWeaverError::Unsupported(
            UnsupportedOp::FormatOperation {
                format: self.descriptor().name.to_string(),
                operation: FormatOperationKind::ListEntries,
            },
        ))
    }
    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        Ok(self
            .list_entries(request, context)?
            .into_iter()
            .map(|path| ContainerListEntry { path, size: None })
            .collect())
    }
    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    /// Create like [`Self::create`], but redirect specific resolved inputs to
    /// alternate bytes via `overrides`. The default ignores `overrides` and
    /// delegates to [`Self::create`]; only disc-image handlers that can read
    /// individual inputs in place honor it. See [`CreateInputOverride`].
    fn create_with_input_overrides(
        &self,
        request: &ContainerCreateRequest,
        overrides: &[CreateInputOverride],
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = overrides;
        self.create(request, context)
    }
    fn create_dry_run_size(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<u64> {
        let _ = (request, context);
        Err(RomWeaverError::Unsupported(
            UnsupportedOp::FormatOperation {
                format: self.descriptor().name.to_string(),
                operation: FormatOperationKind::CreateDryRunSize,
            },
        ))
    }
}

pub trait ContainerHandler: ContainerHandlerOperations {
    fn capabilities(&self) -> ContainerCapabilities;
    /// True for disc/ROM image codec containers (CHD, RVZ, Z3DS, CSO, PBP, GCZ,
    /// WIA, WBFS, TGC, NFS, XISO). Probe treats these as terminal and reports
    /// their container info instead of decompressing to the inner payload.
    fn is_single_payload_disc_image(&self) -> bool {
        false
    }
}

pub trait PatchHandler: Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;
    /// Fixed leading magic of a valid patch file, for the web UI's lightweight
    /// header validation. `None` when the format has no single leading signature
    /// the UI validates against.
    fn header_magic(&self) -> Option<&'static [u8]> {
        None
    }
    fn probe(&self, patch_path: &Path) -> ProbeConfidence {
        let _ = patch_path;
        ProbeConfidence::Extension
    }
    fn parse(&self, patch_path: &Path, context: &OperationContext) -> Result<OperationReport>;
    /// Lightweight metadata probe for the `ingest` "describe" path: returns the same report shape as
    /// [`parse`] (format + embedded source/target size/checksums under `details.patch`) but a handler
    /// MAY override it to skip a full structural scan when the requirements live in a fixed
    /// header/footer. The default falls back to `parse`, so formats with no cheaper path keep
    /// identical behavior. Like `parse`, returning `Ok` confirms the patch is structurally valid.
    fn describe_metadata(
        &self,
        patch_path: &Path,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.parse(patch_path, context)
    }
    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn validate(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    /// Opt-in validation for formats whose decoder or VM must execute to prove
    /// that a patch applies. Most handlers should implement a cheaper native
    /// validator instead.
    fn validate_via_apply(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let output = context
            .temp_paths()
            .next_path("patch-validate-dry-run-output", Some("bin"));
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }

        let apply_request = PatchApplyRequest {
            input: request.input.clone(),
            patches: request.patches.clone(),
            output: output.clone(),
        };
        let apply_result = self.apply(&apply_request, context);
        let _ = fs::remove_file(&output);

        let apply_report = apply_result?;
        if apply_report.status != OperationStatus::Succeeded {
            return Ok(OperationReport {
                stage: "validate".to_string(),
                ..apply_report
            });
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor().name.to_string()),
            "validate",
            format!(
                "validated {} patch via dry-run apply",
                self.descriptor().name
            ),
            Some(100.0),
            apply_report.thread_execution,
        ))
    }
    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn capabilities(&self) -> PatchCapabilities;
}

struct TracingContainerHandler {
    inner: Arc<dyn ContainerHandlerOperations>,
    registration: ContainerHandlerRegistration,
}

impl ContainerHandlerOperations for TracingContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.registration.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        let descriptor = self.registration.descriptor;
        // No "start" line: probe is fast and called once per registered handler during format
        // detection, so the start/complete pair doubles trace volume without breadcrumb value.
        let confidence = self.inner.probe(source);
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %source.display(),
            confidence = ?confidence,
            "container probe complete"
        );
        confidence
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.registration.descriptor;
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %request.source.display(),
            "container probe details start"
        );
        let result = self.inner.probe_details(request, context);
        trace_operation_result("probe", descriptor, &result);
        result
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        let descriptor = self.registration.descriptor;
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %request.source.display(),
            "container list start"
        );
        let result = self.inner.list_entries(request, context);
        match &result {
            Ok(entries) => {
                trace!(
                    family = ?descriptor.family,
                    format = descriptor.name,
                    entry_count = entries.len(),
                    "container list complete"
                );
            }
            Err(error) => {
                trace!(
                    family = ?descriptor.family,
                    format = descriptor.name,
                    error = %error,
                    "container list failed"
                );
            }
        }
        result
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        let descriptor = self.registration.descriptor;
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %request.source.display(),
            "container list records start"
        );
        let result = self.inner.list_entry_records(request, context);
        match &result {
            Ok(entries) => {
                trace!(
                    family = ?descriptor.family,
                    format = descriptor.name,
                    entry_count = entries.len(),
                    "container list records complete"
                );
            }
            Err(error) => {
                trace!(
                    family = ?descriptor.family,
                    format = descriptor.name,
                    error = %error,
                    "container list records failed"
                );
            }
        }
        result
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.registration.descriptor;
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %request.source.display(),
            out_dir = %request.out_dir.display(),
            selections = request.selections.len(),
            parent = ?request.parent.as_ref().map(|path| path.display().to_string()),
            containing_archive = ?request.containing_archive.as_ref().map(|path| path.display().to_string()),
            "container extract start"
        );
        let result = self.inner.extract(request, context);
        trace_operation_result("extract", descriptor, &result);
        result
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.registration.descriptor;
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            output = %request.output.display(),
            input_count = request.inputs.len(),
            requested_format = %request.format,
            codec = ?request.codec,
            level = ?request.level,
            parent = ?request.parent.as_ref().map(|path| path.display().to_string()),
            "container create start"
        );
        let result = match &self.registration.create_support {
            CreateSupport::Supported => self.inner.create(request, context),
            CreateSupport::ExtractOnly {
                supported_create_formats,
            } => Err(RomWeaverError::Unsupported(
                UnsupportedOp::ExtractOnlyCreate {
                    format: request.format.clone(),
                    supported_create_formats: supported_create_formats.clone(),
                },
            )),
        };
        trace_operation_result("create", descriptor, &result);
        result
    }

    fn create_with_input_overrides(
        &self,
        request: &ContainerCreateRequest,
        overrides: &[CreateInputOverride],
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.registration.descriptor;
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            output = %request.output.display(),
            input_count = request.inputs.len(),
            override_count = overrides.len(),
            "container create (input overrides) start"
        );
        let result = match &self.registration.create_support {
            CreateSupport::Supported => self
                .inner
                .create_with_input_overrides(request, overrides, context),
            CreateSupport::ExtractOnly {
                supported_create_formats,
            } => Err(RomWeaverError::Unsupported(
                UnsupportedOp::ExtractOnlyCreate {
                    format: request.format.clone(),
                    supported_create_formats: supported_create_formats.clone(),
                },
            )),
        };
        trace_operation_result("create", descriptor, &result);
        result
    }

    fn create_dry_run_size(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<u64> {
        match &self.registration.create_support {
            CreateSupport::Supported => self.inner.create_dry_run_size(request, context),
            CreateSupport::ExtractOnly {
                supported_create_formats,
            } => Err(RomWeaverError::Unsupported(
                UnsupportedOp::ExtractOnlyCreate {
                    format: request.format.clone(),
                    supported_create_formats: supported_create_formats.clone(),
                },
            )),
        }
    }
}

impl ContainerHandler for TracingContainerHandler {
    fn capabilities(&self) -> ContainerCapabilities {
        self.registration.capabilities.clone()
    }

    fn is_single_payload_disc_image(&self) -> bool {
        self.registration.is_single_payload_disc_image
    }
}

struct TracingPatchHandler {
    inner: Arc<dyn PatchHandler>,
}

impl PatchHandler for TracingPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.inner.descriptor()
    }

    fn header_magic(&self) -> Option<&'static [u8]> {
        self.inner.header_magic()
    }

    fn probe(&self, patch_path: &Path) -> ProbeConfidence {
        let descriptor = self.inner.descriptor();
        // No "start" line: see TracingContainerHandler::probe - fast, per-handler, high-frequency.
        let confidence = self.inner.probe(patch_path);
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            patch = %patch_path.display(),
            confidence = ?confidence,
            "patch probe complete"
        );
        confidence
    }

    fn parse(&self, patch_path: &Path, context: &OperationContext) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            patch = %patch_path.display(),
            "patch parse start"
        );
        let result = self.inner.parse(patch_path, context);
        trace_operation_result("parse", descriptor, &result);
        result
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            input = %request.input.display(),
            output = %request.output.display(),
            patch_count = request.patches.len(),
            "patch apply start"
        );
        let result = self.inner.apply(request, context);
        trace_operation_result("apply", descriptor, &result);
        result
    }

    fn validate(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            input = %request.input.display(),
            patch_count = request.patches.len(),
            "patch validate start"
        );
        let result = self.inner.validate(request, context);
        trace_operation_result("validate", descriptor, &result);
        result
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            original = %request.original.display(),
            modified = %request.modified.display(),
            output = %request.output.display(),
            requested_format = %request.format,
            "patch create start"
        );
        let result = self.inner.create(request, context);
        trace_operation_result("create", descriptor, &result);
        result
    }

    fn capabilities(&self) -> PatchCapabilities {
        self.inner.capabilities()
    }
}

fn trace_operation_result(
    stage: &str,
    descriptor: &FormatDescriptor,
    result: &Result<OperationReport>,
) {
    match result {
        Ok(report) => {
            trace!(
                family = ?descriptor.family,
                format = descriptor.name,
                stage,
                status = ?report.status,
                percent = ?report.percent,
                label = %report.label,
                "operation complete"
            );
        }
        Err(error) => {
            trace!(
                family = ?descriptor.family,
                format = descriptor.name,
                stage,
                error = %error,
                "operation failed"
            );
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/registry.rs"]
mod tests;
