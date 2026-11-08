//! Human progress uses stderr, independently of the stdout summary style.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use indicatif::{ProgressBar, ProgressStyle};
use rom_weaver_core::{
    OperationStatus, ProgressEvent, ProgressSink, RomWeaverErrorKind, process_cancellation_token,
};

use super::{
    HumanStyle, Surface, commands, display_text, terminal_supports_progress, write_stderr,
};

struct PlainProgress {
    decile: Option<u8>,
    printed_at: Instant,
}

static VISIBLE_PROGRESS: Mutex<Option<ProgressBar>> = Mutex::new(None);

struct ActiveBar {
    key: String,
    determinate: bool,
    bar: ProgressBar,
}

pub struct HumanReporter {
    surface: Surface,
    active: Mutex<Option<ActiveBar>>,
    simple_deciles: Mutex<HashMap<String, PlainProgress>>,
    progress_is_terminal: bool,
    quiet: bool,
    verbose: bool,
    selection: commands::OutputSelection,
}

impl HumanReporter {
    pub fn for_command(
        style: HumanStyle,
        color_override: Option<bool>,
        quiet: bool,
        verbose: bool,
        command: &crate::Commands,
    ) -> Self {
        Self::with_selection(
            style,
            color_override,
            quiet,
            verbose,
            commands::OutputSelection::for_command(command),
        )
    }

    #[cfg(test)]
    fn new(style: HumanStyle, color_override: Option<bool>, quiet: bool) -> Self {
        Self::with_selection(
            style,
            color_override,
            quiet,
            false,
            commands::OutputSelection::default(),
        )
    }

    fn with_selection(
        style: HumanStyle,
        color_override: Option<bool>,
        quiet: bool,
        verbose: bool,
        selection: commands::OutputSelection,
    ) -> Self {
        if let Some(color) = color_override {
            dialoguer::console::set_colors_enabled_stderr(color);
        }
        Self {
            surface: Surface::new(style, color_override),
            active: Mutex::new(None),
            simple_deciles: Mutex::new(HashMap::new()),
            progress_is_terminal: terminal_supports_progress(),
            quiet,
            verbose: verbose && !quiet,
            selection,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<ActiveBar>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn update_progress(&self, event: &ProgressEvent) {
        let format = event.format.as_deref().unwrap_or_default();
        let key = format!("{}|{format}|{}", event.command, event.stage);
        let percent = event
            .percent
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0));
        if !self.progress_is_terminal {
            let mut deciles = self
                .simple_deciles
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(line) = plain_progress_line(&mut deciles, key, event, percent) {
                write_stderr(format_args!("{line}\n"));
            }
            return;
        }

        let determinate = percent.is_some();
        let mut guard = self.lock();
        let needs_new = guard
            .as_ref()
            .map(|active| active.key != key || active.bar.is_finished())
            .unwrap_or(true);
        if needs_new {
            if let Some(previous) = guard.take() {
                previous.bar.finish_and_clear();
            }
            let bar = ProgressBar::new(100);
            bar.set_style(progress_bar_style(self.surface.stderr_color, determinate));
            bar.enable_steady_tick(Duration::from_millis(100));
            *VISIBLE_PROGRESS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bar.clone());
            *guard = Some(ActiveBar {
                key,
                determinate,
                bar,
            });
        }
        if let Some(active) = guard.as_mut() {
            if active.determinate != determinate {
                active
                    .bar
                    .set_style(progress_bar_style(self.surface.stderr_color, determinate));
                active.determinate = determinate;
            }
            if let Some(percent) = percent {
                active.bar.set_position(percent as u64);
            }
            active.bar.set_message(progress_label(event));
        }
    }

    fn finish_progress(&self) {
        if let Some(active) = self.lock().take() {
            active.bar.finish_and_clear();
            *VISIBLE_PROGRESS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
        self.simple_deciles
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// `-o/--output` writes leave stdout silent; on an interactive stderr, say what was written.
    fn output_confirmation_lines(&self, event: &ProgressEvent) -> Vec<String> {
        if self.progress_is_terminal && !self.quiet {
            commands::output_confirmation_lines(event, &self.selection)
        } else {
            Vec::new()
        }
    }

    fn render_terminal(&self, event: &ProgressEvent) {
        if process_cancellation_token().is_cancelled() {
            self.surface.cancelled("cancelled");
            return;
        }
        if let Some(warnings) = event
            .details
            .as_ref()
            .and_then(|details| details.get("warnings"))
            .and_then(serde_json::Value::as_array)
        {
            for warning in warnings.iter().filter_map(serde_json::Value::as_str) {
                self.surface.warn(&format!("warning: {warning}"));
            }
        }
        match event.status {
            OperationStatus::Succeeded => {
                if event.command != "setup" || !self.quiet || commands::is_dry_run(event) {
                    commands::render_success(&self.surface, event, &self.selection);
                }
                if self.verbose {
                    commands::render_verbose(&self.surface, event);
                } else {
                    let diagnostics = self.surface.diagnostics();
                    for line in self.output_confirmation_lines(event) {
                        diagnostics.line(&line);
                    }
                }
            }
            OperationStatus::Failed => self
                .surface
                .error(&format!("error: {}", human_error_text(&event.label))),
            OperationStatus::Unsupported if event.command == "save-identify" => {
                for (index, line) in event.label.lines().enumerate() {
                    if index == 0 {
                        self.surface.warn(&format!("unsupported: {line}"));
                    } else {
                        self.surface.warn(line);
                    }
                }
            }
            OperationStatus::Unsupported => self
                .surface
                .warn(&format!("unsupported: {}", human_error_text(&event.label))),
            OperationStatus::Cancelled => self
                .surface
                .cancelled(&format!("cancelled: {}", event.label)),
            OperationStatus::Pending | OperationStatus::Running => {}
        }
    }
}

/// Drop the standard `validation failed: ` prefix, which only repeats the `error:` label. The
/// event text keeps it because `classify_message` and JSON consumers match on it.
fn human_error_text(label: &str) -> &str {
    RomWeaverErrorKind::MESSAGE_PREFIXES
        .iter()
        .find(|(_, kind)| *kind == RomWeaverErrorKind::Validation)
        .and_then(|(prefix, _)| label.strip_prefix(prefix))
        .map_or(label, str::trim_start)
}

impl ProgressSink for HumanReporter {
    fn emit(&self, event: ProgressEvent) {
        match event.status {
            OperationStatus::Running => {
                if !self.quiet {
                    self.update_progress(&event);
                }
            }
            OperationStatus::Pending => {}
            _ => {
                let had_progress = self.lock().is_some()
                    || !self
                        .simple_deciles
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .is_empty();
                self.finish_progress();
                if had_progress && event.status == OperationStatus::Succeeded {
                    write_stderr(format_args!("{}: complete\n", display_text(&event.command)));
                }
                self.render_terminal(&event);
            }
        }
    }
}

impl Drop for HumanReporter {
    fn drop(&mut self) {
        self.finish_progress();
    }
}

pub(crate) fn clear_progress() {
    let bar = VISIBLE_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(bar) = bar {
        bar.finish_and_clear();
    }
}

/// Callers MUST keep the closure short; indicatif holds its draw lock while it runs.
pub(crate) fn with_progress_suspended<F: FnOnce() -> R, R>(f: F) -> R {
    let bar = VISIBLE_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    match bar {
        Some(bar) => bar.suspend(f),
        None => f(),
    }
}

fn progress_label(event: &ProgressEvent) -> String {
    let label = if event.label.trim().is_empty() {
        &event.stage
    } else {
        &event.label
    };
    display_text(label).into_owned()
}

fn plain_progress_line(
    deciles: &mut HashMap<String, PlainProgress>,
    key: String,
    event: &ProgressEvent,
    percent: Option<f32>,
) -> Option<String> {
    let decile = percent.map(|value| value as u8 / 10);
    let now = Instant::now();
    if deciles.get(&key).is_some_and(|previous| {
        decile <= previous.decile
            || (percent != Some(100.0)
                && now.duration_since(previous.printed_at) < Duration::from_secs(1))
    }) {
        return None;
    }
    deciles.insert(
        key,
        PlainProgress {
            decile,
            printed_at: now,
        },
    );
    let label = progress_label(event);
    Some(match percent {
        Some(percent) => format!("{percent:>3.0}% {label}"),
        None => label,
    })
}

fn progress_bar_style(color: bool, determinate: bool) -> ProgressStyle {
    let template = match (color, determinate) {
        (true, true) => "{wide_msg}  {percent:>3}%  {bar:20.166}  {elapsed_precise}",
        (false, true) => "{wide_msg}  {percent:>3}%  {bar:20}  {elapsed_precise}",
        (_, false) => "{spinner} {wide_msg}  {elapsed_precise}",
    };
    ProgressStyle::with_template(template)
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("██░")
}

#[cfg(test)]
#[path = "../../tests/unit/render_reporter.rs"]
mod tests;
