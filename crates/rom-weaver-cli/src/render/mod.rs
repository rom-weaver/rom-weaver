//! Human-facing rendering for the native CLI. The app emits a structured `ProgressEvent` stream;
//! these modules turn that stream into a live progress bar plus a rich terminal summary (`Rich`) or
//! plain piped output (`Simple`). `--json` bypasses all of this and prints the raw event stream.

mod commands;
mod prompt;
mod reporter;

pub(crate) use commands::format_elapsed_ms;
pub use prompt::StdinPrompter;
pub use reporter::HumanReporter;
pub(crate) use reporter::{clear_progress, with_progress_suspended};

use std::borrow::Cow;
use std::io::{IsTerminal, Write};

use dialoguer::console::measure_text_width;
use owo_colors::OwoColorize;
use rom_weaver_core::format_human_bytes;

/// The webapp's brand accent (`--rw-accent`, `#d9690f`) - a saturated orange that reads on both
/// light and dark backgrounds - used to color labels.
const ACCENT: (u8, u8, u8) = (0xD9, 0x69, 0x0F);

/// The summary style follows stdout. Progress and diagnostics follow stderr.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanStyle {
    /// Terminal: colorized aligned text.
    Rich,
    /// Piped/redirected: the same aligned layout without automatic color.
    Simple,
}

/// A styled output target. Renders headings, key/value blocks, and aligned columns according to
/// [`HumanStyle`], with a separate color setting. Both styles use the same
/// summary layout; only Rich has an in-place progress bar.
/// Human summaries go to stdout; diagnostics use stderr's color capability.
pub struct Surface {
    color: bool,
    stderr_color: bool,
}

impl Surface {
    pub fn new(style: HumanStyle, color_override: Option<bool>) -> Self {
        let automatic_color = !std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty())
            && !dumb_terminal();
        Self {
            color: color_override.unwrap_or(automatic_color && matches!(style, HumanStyle::Rich)),
            stderr_color: color_override
                .unwrap_or(automatic_color && std::io::stderr().is_terminal()),
        }
    }

    /// A plain line (used for label-only summaries).
    pub fn line(&self, text: &str) {
        let text = display_text(text);
        crate::stdout_output::write(format_args!("{text}\n"));
    }

    /// A dimmed contextual note.
    pub fn note(&self, text: &str) {
        let text = display_text(text);
        if self.color {
            crate::stdout_output::write(format_args!("{}\n", text.dimmed()));
            return;
        }
        crate::stdout_output::write(format_args!("{text}\n"));
    }

    /// An error line on stderr, red when color is enabled.
    pub fn error(&self, text: &str) {
        let text = display_text(text);
        if self.stderr_color {
            write_stderr(format_args!("{}\n", text.red().bold()));
            return;
        }
        write_stderr(format_args!("{text}\n"));
    }

    /// A warning line on stderr, yellow when color is enabled.
    pub fn warn(&self, text: &str) {
        let text = display_text(text);
        if self.stderr_color {
            write_stderr(format_args!("{}\n", text.yellow()));
            return;
        }
        write_stderr(format_args!("{text}\n"));
    }

    /// A cancellation line on stderr, dimmed when color is enabled.
    pub fn cancelled(&self, text: &str) {
        let text = display_text(text);
        if self.stderr_color {
            write_stderr(format_args!("{}\n", text.dimmed()));
            return;
        }
        write_stderr(format_args!("{text}\n"));
    }

    /// Render aligned `label  value` lines with an orange label when color is enabled.
    /// Padding uses terminal cell widths, including wide and combining characters.
    pub fn key_values(&self, pairs: &[(String, String)]) {
        if pairs.is_empty() {
            return;
        }
        let pairs = pairs
            .iter()
            .map(|(key, value)| (display_text(key), display_text(value)))
            .collect::<Vec<_>>();
        let width = pairs
            .iter()
            .map(|(key, _)| measure_text_width(key))
            .max()
            .unwrap_or(0);
        for (key, value) in pairs {
            let pad = " ".repeat(width.saturating_sub(measure_text_width(&key)));
            if self.color {
                crate::stdout_output::write(format_args!(
                    "{}{pad}  {value}\n",
                    key.truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
                ));
            } else {
                crate::stdout_output::write(format_args!("{key}{pad}  {value}\n"));
            }
        }
    }

    /// Render rows as aligned columns, no borders or header. Columns after the first are dimmed in
    /// Rich. Rows may be ragged; widths come from the plain text so color codes don't affect
    /// alignment.
    pub fn rows(&self, rows: &[Vec<String>]) {
        if rows.is_empty() {
            return;
        }
        let rows = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|cell| display_text(cell))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let column_count = rows.iter().map(|row| row.len()).max().unwrap_or(0);
        let mut widths = vec![0usize; column_count];
        for row in &rows {
            for (index, cell) in row.iter().enumerate() {
                widths[index] = widths[index].max(measure_text_width(cell));
            }
        }
        for row in &rows {
            let mut line = String::new();
            for (index, cell) in row.iter().enumerate() {
                let is_last = index + 1 == row.len();
                if self.color && index > 0 {
                    line.push_str(&cell.dimmed().to_string());
                } else {
                    line.push_str(cell);
                }
                if !is_last {
                    let pad = widths[index].saturating_sub(measure_text_width(cell)) + 2;
                    line.push_str(&" ".repeat(pad));
                }
            }
            crate::stdout_output::write(format_args!("{}\n", line.trim_end()));
        }
    }
}

/// Format a byte count using decimal units (e.g. `1.5 MB`).
pub fn humanize_bytes(bytes: u64) -> String {
    format_human_bytes(bytes)
}

pub(crate) fn write_stderr(arguments: std::fmt::Arguments<'_>) {
    with_progress_suspended(|| {
        let _ = std::io::stderr().lock().write_fmt(arguments);
    });
}

pub(crate) fn terminal_supports_progress() -> bool {
    std::io::stderr().is_terminal() && !dumb_terminal()
}

fn dumb_terminal() -> bool {
    std::env::var_os("TERM").is_some_and(|term| term == "dumb")
}

/// Untrusted labels MUST NOT inject terminal controls or split table rows.
pub(crate) fn display_text(text: &str) -> Cow<'_, str> {
    let unsafe_control = char::is_control;
    if !text.chars().any(unsafe_control) {
        return Cow::Borrowed(text);
    }
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if unsafe_control(character) {
            escaped.extend(character.escape_default());
        } else {
            escaped.push(character);
        }
    }
    Cow::Owned(escaped)
}

#[cfg(test)]
#[path = "../../tests/unit/render_surface.rs"]
mod tests;
