//! Human progress uses stderr, independently of the stdout summary style.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use indicatif::{ProgressBar, ProgressStyle};
use rom_weaver_core::{OperationStatus, ProgressEvent, ProgressSink, process_cancellation_token};

use super::{
    HumanStyle, Surface, commands, display_text, terminal_supports_progress, write_stderr,
};

static VISIBLE_PROGRESS: Mutex<Option<ProgressBar>> = Mutex::new(None);

struct ActiveBar {
    key: String,
    determinate: bool,
    bar: ProgressBar,
}

pub struct HumanReporter {
    surface: Surface,
    active: Mutex<Option<ActiveBar>>,
    simple_deciles: Mutex<HashMap<String, Option<u8>>>,
    progress_is_terminal: bool,
    quiet: bool,
}

impl HumanReporter {
    pub fn new(style: HumanStyle, color_override: Option<bool>, quiet: bool) -> Self {
        if let Some(color) = color_override {
            dialoguer::console::set_colors_enabled_stderr(color);
        }
        Self {
            surface: Surface::new(style, color_override),
            active: Mutex::new(None),
            simple_deciles: Mutex::new(HashMap::new()),
            progress_is_terminal: terminal_supports_progress(),
            quiet,
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

    fn render_terminal(&self, event: &ProgressEvent) {
        if process_cancellation_token().is_cancelled() {
            self.surface.cancelled("cancelled");
            return;
        }
        match event.status {
            OperationStatus::Succeeded if commands::quiet_suppresses_success(self.quiet, event) => {
            }
            OperationStatus::Succeeded => commands::render_success(&self.surface, event),
            OperationStatus::Failed => self.surface.error(&format!("error: {}", event.label)),
            OperationStatus::Unsupported if event.command == "save-identify" => {
                for (index, line) in event.label.lines().enumerate() {
                    if index == 0 {
                        self.surface.warn(&format!("unsupported: {line}"));
                    } else {
                        self.surface.warn(line);
                    }
                }
            }
            OperationStatus::Unsupported => {
                self.surface.warn(&format!("unsupported: {}", event.label))
            }
            OperationStatus::Cancelled => self
                .surface
                .cancelled(&format!("cancelled: {}", event.label)),
            OperationStatus::Pending | OperationStatus::Running => {}
        }
    }
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
                self.finish_progress();
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
    deciles: &mut HashMap<String, Option<u8>>,
    key: String,
    event: &ProgressEvent,
    percent: Option<f32>,
) -> Option<String> {
    let decile = percent.map(|value| value as u8 / 10);
    if deciles
        .get(&key)
        .is_some_and(|previous| decile <= *previous)
    {
        return None;
    }
    deciles.insert(key, decile);
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
