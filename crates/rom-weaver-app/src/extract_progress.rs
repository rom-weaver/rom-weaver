use super::*;

pub(super) struct ExtractStepEvent<'a> {
    pub(super) format: &'a str,
    pub(super) depth: usize,
    pub(super) source: &'a Path,
    pub(super) out_dir: &'a Path,
    pub(super) step_status: &'a str,
    pub(super) outputs: &'a [Value],
    pub(super) thread_execution: Option<ThreadExecution>,
}

impl CliApp {
    /// Emits a structured per-level extract "step" event so the UI can render each descended level
    /// (its source, format, and output names + sizes) as a discrete extraction while still ending
    /// the whole command with a single terminal finish. The event status stays `Running` because
    /// the host treats `succeeded`/`failed` as the command terminal; the per-level lifecycle is
    /// carried in `details.extract_step.status` instead.
    pub(super) fn emit_extract_step(&self, event: ExtractStepEvent<'_>) {
        if !self.emit_progress_events {
            return;
        }
        let ExtractStepEvent {
            format,
            depth,
            source,
            out_dir,
            step_status,
            outputs,
            thread_execution,
        } = event;
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        let output_summaries = outputs
            .iter()
            .filter_map(|value| {
                let map = value.as_object()?;
                let mut entry = Map::new();
                for key in ["file_name", "size_bytes", "kind"] {
                    if let Some(field) = map.get(key) {
                        entry.insert(key.to_string(), field.clone());
                    }
                }
                Some(Value::Object(entry))
            })
            .collect::<Vec<_>>();
        let mut step = Map::new();
        step.insert("depth".to_string(), json!(depth));
        step.insert(
            "source".to_string(),
            json!(source.to_string_lossy().replace('\\', "/")),
        );
        step.insert("source_name".to_string(), json!(source_name));
        // The directory this level extracted into. The UI relativizes each level's source (and the
        // final leaf) against the longest matching `out_dir` to show the path *inside* its immediate
        // parent archive, rather than the accumulated full nested path.
        step.insert(
            "out_dir".to_string(),
            json!(out_dir.to_string_lossy().replace('\\', "/")),
        );
        step.insert("format".to_string(), json!(format));
        step.insert("status".to_string(), json!(step_status));
        step.insert("outputs".to_string(), Value::Array(output_summaries));
        let mut details = Map::new();
        details.insert("extract_step".to_string(), Value::Object(step));
        let label = if step_status == "running" {
            format!("extracting `{}`", source.display())
        } else {
            format!("extracted `{}`", source.display())
        };
        trace!(
            format,
            depth,
            source = %source.display(),
            step_status,
            output_count = outputs.len(),
            "emitting extract step event"
        );
        let thread_execution = thread_execution.as_ref();
        self.reporter.emit(ProgressEvent {
            command: "extract".to_string(),
            family: OperationFamily::Container,
            format: Some(format.to_string()),
            stage: "extract-step".to_string(),
            label,
            details: Some(Value::Object(details)),
            percent: None,
            elapsed_ms: None,
            status: OperationStatus::Running,
            ..ProgressEvent::from_thread_execution(thread_execution)
        });
    }
}
