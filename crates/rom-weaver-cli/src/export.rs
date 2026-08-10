use super::*;

use crate::command_args::default_max_compression_level;
#[cfg(not(target_arch = "wasm32"))]
use crate::command_args::{
    CODEC_HELP, CODEC_LONG_HELP, FORMAT_HELP, FORMAT_LONG_HELP, THREADS_HELP,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ExportOptions {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long,
            value_name = "PATH",
            help = "Where to write the final output"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(short = 'f', long, help = FORMAT_HELP, long_help = FORMAT_LONG_HELP)
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, action = ArgAction::Append, value_delimiter = ',', help = CODEC_HELP, long_help = CODEC_LONG_HELP)
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codec: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, value_enum, help = "How hard to compress the final output")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub level: Option<CompressionLevelProfile>,
    /// Name the staged input should have inside a single-file archive.
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub entry_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ExportCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            required = true,
            value_name = "INPUT",
            help = "Staged file to export; repeat for each archive entry"
        )
    )]
    pub input: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long,
            value_name = "PATH",
            help = "Where to write the final output"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(short = 'f', long, help = FORMAT_HELP, long_help = FORMAT_LONG_HELP)
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, action = ArgAction::Append, value_delimiter = ',', help = CODEC_HELP, long_help = CODEC_LONG_HELP)
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codec: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, value_enum, default_value_t = CompressionLevelProfile::Max, help = "How hard to compress: min, very-low, low, medium, high, very-high, or max")
    )]
    #[serde(default = "default_max_compression_level")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub level: CompressionLevelProfile,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(short = 'j', long, default_value = "auto", value_name = "auto|N", help = THREADS_HELP)
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

/// Inputs for the shared final-output stage used by commands that produce a file and then
/// optionally package it into a container. The stage owns the container create report and the
/// temporary-file cleanup remains with the caller's operation context.
pub(super) struct ExportRequest {
    pub(super) command: &'static str,
    pub(super) family: OperationFamily,
    pub(super) stage: &'static str,
    pub(super) output_kind: &'static str,
    pub(super) inputs: Vec<PathBuf>,
    pub(super) output: PathBuf,
    pub(super) format: Option<String>,
    pub(super) codec: Vec<String>,
    pub(super) explicit_level: Option<i32>,
    pub(super) level: Option<CompressionLevelProfile>,
    pub(super) overrides: Vec<CreateInputOverride>,
    pub(super) parent: Option<PathBuf>,
}

impl CliApp {
    pub(super) fn staged_export_path(
        context: &OperationContext,
        purpose: &str,
        entry_name: Option<&str>,
        fallback_extension: &str,
    ) -> Result<PathBuf> {
        let entry_dir = context.temp_paths().next_path(purpose, None);
        fs::create_dir_all(&entry_dir)?;
        let file_name = entry_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(Path::new)
            .filter(|path| path.components().count() == 1 && path.file_name().is_some())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| {
                PathBuf::from(format!(
                    "{purpose}.{}",
                    fallback_extension.trim_start_matches('.')
                ))
            });
        Ok(entry_dir.join(file_name))
    }

    pub(super) fn run_export(&self, args: ExportCommand) -> AppRunOutcome {
        let context = self.context(args.threads);
        let report = self.export(
            ExportRequest {
                command: "export",
                family: OperationFamily::Container,
                stage: "compress",
                output_kind: "output",
                inputs: args.input,
                output: args.output,
                format: args.format,
                codec: args.codec,
                explicit_level: None,
                level: Some(args.level),
                overrides: Vec::new(),
                parent: None,
            },
            &context,
        );
        self.finish("export", report)
    }

    pub(super) fn export(
        &self,
        request: ExportRequest,
        context: &OperationContext,
    ) -> OperationReport {
        let ExportRequest {
            command,
            family,
            stage,
            output_kind,
            inputs,
            output,
            format,
            codec,
            explicit_level: request_explicit_level,
            level: level_profile,
            overrides,
            parent,
        } = request;
        let requested_format = match format {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return OperationReport::failed(
                        family,
                        None,
                        "validate",
                        "--format cannot be empty",
                        context.single_thread_execution(),
                    );
                }
                Some(trimmed.to_string())
            }
            None => None,
        };
        let probe_threads = context.single_thread_execution();
        let fail = |format: Option<String>, stage: &str, message: String| {
            OperationReport::failed(family, format, stage, message, probe_threads.clone())
        };
        for input in &inputs {
            if let Some(report) = self.require_readable_path(
                command,
                family,
                requested_format.clone(),
                input,
                probe_threads.clone(),
            ) {
                return report;
            }
        }
        if let Some(report) = self.require_writable_output_parent(
            command,
            family,
            requested_format.clone(),
            &output,
            probe_threads.clone(),
        ) {
            return report;
        }
        let resolution = match self.resolve_container_output_format(
            requested_format.as_deref(),
            &output,
            "--format",
            "",
        ) {
            Ok(resolution) => resolution,
            Err(error) => return fail(requested_format, "validate", error.to_string()),
        };
        let resolved_format = resolution.format;
        if let Some(warning) = resolution.warning.as_deref() {
            warn!(
                command,
                format = %resolved_format,
                output = %output.display(),
                "{warning}"
            );
        }
        let (codec, codec_explicit_level) = match Self::resolve_codec_level(codec, "--codec") {
            Ok(value) => value,
            Err(error) => return fail(Some(resolved_format), "validate", error.to_string()),
        };
        let level = request_explicit_level.or(codec_explicit_level).or_else(|| {
            Self::resolve_compression_level_for_profile(
                &resolved_format,
                Self::primary_codec_name(codec.as_deref()),
                None,
                level_profile.unwrap_or_default(),
            )
        });
        let Some(handler) = self.containers.find_by_name(&resolved_format) else {
            return fail(
                Some(resolved_format),
                "probe",
                "requested output format is not registered".to_string(),
            );
        };
        let capabilities = handler.capabilities();
        if !capabilities.probe_details && !capabilities.extract && !capabilities.create {
            return fail(
                Some(resolved_format),
                "probe",
                "requested output format is not registered".to_string(),
            );
        }
        if !capabilities.create {
            return fail(
                Some(handler.descriptor().name.to_string()),
                "validate",
                extract_only_create_validation_message(handler.descriptor().name),
            );
        }
        let create_threads = Some(context.plan_threads(capabilities.create_threads.clone()));
        self.emit_running(
            OperationLabel {
                command,
                family,
                format: Some(handler.descriptor().name),
            },
            stage,
            format!(
                "creating {} {output_kind} from {} input(s)",
                handler.descriptor().name,
                inputs.len()
            ),
            Some(0.0),
            create_threads.clone(),
        );
        let expected_output = output.clone();
        let report = handler
            .create_with_input_overrides(
                &ContainerCreateRequest {
                    inputs,
                    output,
                    format: resolved_format.clone(),
                    codec,
                    level,
                    parent,
                },
                &overrides,
                context,
            )
            .unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    stage,
                    error.to_string(),
                    context.single_thread_execution(),
                )
            });
        let mut report = report;
        if report.status == OperationStatus::Succeeded {
            report.family = family;
            report.format = Some(handler.descriptor().name.to_string());
            report.stage = stage.to_string();
            if let Some(warning) = resolution.warning.as_deref() {
                report.label = format!("{}; warning: {warning}", report.label);
            }
            self.emit_running(
                OperationLabel {
                    command,
                    family,
                    format: Some(handler.descriptor().name),
                },
                stage,
                format!("finalizing `{}` {output_kind}", handler.descriptor().name),
                if handler.descriptor().name == "rvz" {
                    Some(99.0)
                } else {
                    None
                },
                report.thread_execution.clone(),
            );
            report = Self::attach_emitted_files_details(
                report,
                vec![expected_output],
                Some(output_kind),
            );
        }
        report
    }
}
