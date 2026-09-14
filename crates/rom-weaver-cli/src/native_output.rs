use std::{collections::HashMap, ffi::OsString, process::ExitCode, sync::Mutex};

use rom_weaver_core::{
    OperationFamily, OperationReport, OperationStatus, ProgressEvent, ProgressSink,
};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum OutputMode {
    #[default]
    Human,
    Json,
    JsonLines,
}

impl OutputMode {
    pub(crate) fn from_args(args: &[OsString]) -> Self {
        args.iter()
            .skip(1)
            .take_while(|arg| *arg != "--")
            .fold(Self::Human, |mode, arg| match arg.to_str() {
                Some("--json") => Self::Json,
                Some("--jsonl") => Self::JsonLines,
                _ => mode,
            })
    }

    pub(crate) fn is_json(self) -> bool {
        self != Self::Human
    }
}

type ProgressBuckets = HashMap<(String, String, Option<String>), Option<u8>>;

pub(crate) struct JsonReporter {
    mode: OutputMode,
    progress: bool,
    verbose: bool,
    reports: Mutex<Vec<ProgressEvent>>,
    progress_buckets: Mutex<ProgressBuckets>,
}

impl JsonReporter {
    pub(crate) fn new(mode: OutputMode, progress: bool, verbose: bool) -> Self {
        Self {
            mode,
            progress,
            verbose,
            reports: Mutex::new(Vec::new()),
            progress_buckets: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn finish(&self, status: ExitCode) -> ExitCode {
        if self.mode != OutputMode::Json {
            return status;
        }
        let reports = std::mem::take(
            &mut *self
                .reports
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        write_json(&document(reports, exit_code(status)));
        status
    }

    fn progress_changed(&self, event: &ProgressEvent) -> bool {
        let key = (
            event.command.clone(),
            event.stage.clone(),
            event.format.clone(),
        );
        let bucket = event
            .percent
            .filter(|percent| percent.is_finite())
            .map(|percent| (percent.clamp(0.0, 100.0) as u8) / 10);
        let mut buckets = self
            .progress_buckets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if buckets
            .get(&key)
            .is_some_and(|previous| *previous >= bucket)
        {
            return false;
        }
        buckets.insert(key, bucket);
        true
    }
}

impl ProgressSink for JsonReporter {
    fn emit(&self, event: ProgressEvent) {
        if matches!(
            event.status,
            OperationStatus::Pending | OperationStatus::Running
        ) {
            if self.progress {
                if self.mode == OutputMode::JsonLines {
                    write_json(&event);
                } else if self.progress_changed(&event) {
                    write_stderr_json(&event);
                }
            }
            return;
        }
        if let Some(warnings) = event
            .details
            .as_ref()
            .and_then(|details| details.get("warnings"))
            .and_then(Value::as_array)
        {
            for warning in warnings.iter().filter_map(Value::as_str) {
                diagnostic(true, "WARN", &event.command, warning);
            }
        }
        if self.verbose {
            write_stderr_json(&json!({
                "level": "INFO",
                "fields": {
                    "command": event.command,
                    "message": event.label,
                    "status": event.status,
                    "elapsed_ms": event.elapsed_ms,
                },
            }));
        }
        if self.mode == OutputMode::JsonLines {
            write_json(&event);
        } else {
            self.reports
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(event);
        }
    }
}

fn document(reports: Vec<ProgressEvent>, exit_code: u8) -> Value {
    let command = reports.last().map_or("cli", |event| event.command.as_str());
    let fallback = match exit_code {
        0 => result_event(command, "complete", "command completed", None),
        130 => error_event(
            command,
            "cancel",
            "operation.cancelled",
            "operation cancelled",
            130,
        ),
        code => error_event(
            command,
            "complete",
            "operation.failed",
            "command failed",
            code,
        ),
    };
    let selected = reports.iter().rev().find(|event| {
        event.status.exit_code() == exit_code
            || event
                .details
                .as_ref()
                .and_then(|details| details.get("error")?.get("exit_code")?.as_u64())
                == Some(u64::from(exit_code))
    });
    let event = selected.unwrap_or(&fallback);
    let mut value = json!(event);
    value["schema_version"] = json!(1);
    value["exit_code"] = json!(exit_code);
    value["error"] = report_error(event, exit_code);
    let mut warnings = Vec::new();
    for event in &reports {
        if let Some(items) = event
            .details
            .as_ref()
            .and_then(|details| details.get("warnings"))
            .and_then(Value::as_array)
        {
            for warning in items {
                if !warnings.contains(warning) {
                    warnings.push(warning.clone());
                }
            }
        }
    }
    value["warnings"] = json!(warnings);
    if reports.len() > 1 || (selected.is_none() && !reports.is_empty()) {
        value["reports"] = json!(reports);
    }
    value
}

fn report_error(event: &ProgressEvent, exit_code: u8) -> Value {
    if exit_code == 0 {
        return Value::Null;
    }
    if let Some(error) = event
        .details
        .as_ref()
        .and_then(|details| details.get("error"))
    {
        return error.clone();
    }
    let code = match event.status {
        OperationStatus::Unsupported => "operation.unsupported",
        OperationStatus::Cancelled => "operation.cancelled",
        _ => "operation.failed",
    };
    json!({ "code": code, "message": event.label, "exit_code": exit_code })
}

pub(crate) fn result_event(
    command: &str,
    stage: &str,
    label: &str,
    details: Option<Value>,
) -> ProgressEvent {
    let mut report = OperationReport::succeeded(
        OperationFamily::Command,
        None,
        stage,
        label,
        Some(100.0),
        None,
    );
    report.details = details;
    report.into_event(command)
}

pub(crate) fn error_event(
    command: &str,
    stage: &str,
    code: &str,
    message: &str,
    exit_code: u8,
) -> ProgressEvent {
    let mut report = OperationReport::failed(OperationFamily::Command, None, stage, message, None);
    if exit_code == 130 {
        report.status = OperationStatus::Cancelled;
    }
    report.details = Some(json!({
        "error": { "code": code, "message": message, "exit_code": exit_code },
    }));
    report.into_event(command)
}

pub(crate) fn print_event(mode: OutputMode, event: ProgressEvent, code: u8) -> ExitCode {
    if mode == OutputMode::Json {
        write_json(&document(vec![event], code));
    } else {
        write_json(&event);
    }
    ExitCode::from(code)
}

pub(crate) fn print_error(
    mode: OutputMode,
    command: &str,
    stage: &str,
    code: &str,
    message: &str,
    status: u8,
) -> ExitCode {
    if mode.is_json() {
        return print_event(
            mode,
            error_event(command, stage, code, message, status),
            status,
        );
    }
    crate::render::write_stderr(format_args!(
        "error: {}\n",
        crate::render::display_text(message)
    ));
    ExitCode::from(status)
}

pub(crate) fn print_argument_result(error: clap::Error, mode: OutputMode) -> ExitCode {
    let code = error.exit_code() as u8;
    if !mode.is_json() {
        if let Err(failure) = error.print()
            && code == 0
        {
            crate::stdout_output::record_error(failure);
        }
        return ExitCode::from(code);
    }
    let message = error.render().to_string();
    if code != 0 {
        return print_error(
            mode,
            "cli",
            "arguments",
            "cli.invalid_arguments",
            &message,
            code,
        );
    }
    if error.kind() == clap::error::ErrorKind::DisplayVersion {
        return print_event(
            mode,
            result_event(
                "version",
                "version",
                "version",
                Some(json!({
                    "name": "rom-weaver", "version": env!("CARGO_PKG_VERSION"),
                })),
            ),
            0,
        );
    }
    print_asset(mode, "help", "text", &message)
}

pub(crate) fn print_asset(
    mode: OutputMode,
    command: &str,
    format: &str,
    content: &str,
) -> ExitCode {
    if !mode.is_json() {
        crate::stdout_output::write(format_args!("{content}"));
        return ExitCode::SUCCESS;
    }
    print_event(
        mode,
        result_event(
            command,
            "generate",
            "generated content",
            Some(json!({
                "content": content, "content_format": format,
            })),
        ),
        0,
    )
}

pub(crate) fn diagnostic(json: bool, level: &str, command: &str, message: &str) {
    if json {
        write_stderr_json(
            &json!({ "level": level, "fields": { "command": command, "message": message } }),
        );
    } else {
        let prefix = if level == "WARN" { "warning" } else { command };
        crate::render::write_stderr(format_args!(
            "{prefix}: {}\n",
            crate::render::display_text(message)
        ));
    }
}

pub(crate) fn write_json(value: &impl serde::Serialize) {
    match serde_json::to_string(value) {
        Ok(value) => crate::stdout_output::write(format_args!("{value}\n")),
        Err(error) => diagnostic(
            true,
            "ERROR",
            "cli",
            &format!("cannot serialize output: {error}"),
        ),
    }
}

fn write_stderr_json(value: &impl serde::Serialize) {
    match serde_json::to_string(value) {
        Ok(value) => crate::render::write_stderr(format_args!("{value}\n")),
        Err(_) => crate::render::write_stderr(format_args!(
            "{{\"level\":\"ERROR\",\"fields\":{{\"message\":\"cannot serialize diagnostic\"}}}}\n"
        )),
    }
}

pub(crate) fn exit_code(status: ExitCode) -> u8 {
    if status == ExitCode::SUCCESS {
        return 0;
    }
    if status == ExitCode::from(2) {
        return 2;
    }
    if status == ExitCode::from(130) {
        return 130;
    }
    1
}

#[cfg(test)]
#[path = "../tests/unit/native_output.rs"]
mod tests;
