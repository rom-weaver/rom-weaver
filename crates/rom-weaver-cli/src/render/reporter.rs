//! [`HumanReporter`]: a [`ProgressSink`] that drives a live progress bar for running events and a
//! rich terminal summary for the final event.

use std::collections::HashMap;
use std::sync::Mutex;

use indicatif::{ProgressBar, ProgressStyle};
use rom_weaver_core::{OperationStatus, ProgressEvent, ProgressSink};

use super::{HumanStyle, Surface, commands};

/// The currently displayed progress bar plus the event key (`command|format|stage`) that owns it.
struct ActiveBar {
    key: String,
    bar: ProgressBar,
}

/// Renders the app's event stream for humans. Holds the live-bar / throttle state behind a `Mutex`
/// because [`ProgressSink::emit`] takes `&self`.
pub struct HumanReporter {
    surface: Surface,
    active: Mutex<Option<ActiveBar>>,
    /// Last printed decile (0..=10) per operation key, used to throttle Simple-mode progress lines.
    simple_deciles: Mutex<HashMap<String, u8>>,
}

impl HumanReporter {
    pub fn new(style: HumanStyle) -> Self {
        Self {
            surface: Surface::new(style),
            active: Mutex::new(None),
            simple_deciles: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<ActiveBar>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn update_progress(&self, event: &ProgressEvent) {
        let format = event.format.as_deref().unwrap_or("-");
        if let HumanStyle::Simple = self.surface.style() {
            // No in-place bar when piped. Emit at most one terse line per 10% so forced `--progress`
            // output stays readable (the app suppresses running events entirely otherwise).
            let Some(percent) = event.percent else {
                return;
            };
            let key = format!("{}|{format}|{}", event.command, event.stage);
            let decile = (percent.clamp(0.0, 100.0) as u8) / 10;
            let mut deciles = self
                .simple_deciles
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let should_print = deciles.get(&key).map(|&last| decile > last).unwrap_or(true);
            if should_print {
                deciles.insert(key, decile);
                eprintln!("{} {format} {percent:>3.0}% {}", event.command, event.stage);
            }
            return;
        }

        let key = format!("{}|{format}|{}", event.command, event.stage);
        let mut guard = self.lock();
        let needs_new = guard
            .as_ref()
            .map(|active| active.key != key)
            .unwrap_or(true);
        if needs_new {
            if let Some(previous) = guard.take() {
                previous.bar.finish_and_clear();
            }
            let bar = ProgressBar::new(100);
            bar.set_style(progress_bar_style());
            *guard = Some(ActiveBar { key, bar });
        }
        if let Some(active) = guard.as_ref() {
            if let Some(percent) = event.percent {
                active.bar.set_position(percent.clamp(0.0, 100.0) as u64);
            }
            active
                .bar
                .set_message(format!("{} {format} {}", event.command, event.stage));
        }
    }

    fn finish_progress(&self) {
        if let Some(active) = self.lock().take() {
            active.bar.finish_and_clear();
        }
    }

    fn render_terminal(&self, event: &ProgressEvent) {
        match event.status {
            OperationStatus::Succeeded => commands::render_success(&self.surface, event),
            OperationStatus::Failed => self.surface.error(&format!("error: {}", event.label)),
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
        if event.status == OperationStatus::Running {
            self.update_progress(&event);
            return;
        }
        self.finish_progress();
        self.render_terminal(&event);
    }
}

fn progress_bar_style() -> ProgressStyle {
    // A fixed, moderate bar width (not the full terminal) with no surrounding padding. The percent
    // sits before the bar so the terminal cursor - which rests at the end of the line - never lands
    // on it. The filled portion is the brand orange (256-color 166 ≈ #d75f00, the closest palette
    // match so it renders without truecolor support too).
    ProgressStyle::with_template("{msg}  {percent:>3}%  {bar:30.166}")
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("██░")
}
