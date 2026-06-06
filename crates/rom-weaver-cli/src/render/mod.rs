//! Human-facing rendering for the native CLI. The app emits a structured `ProgressEvent` stream;
//! these modules turn that stream into a live progress bar plus a rich terminal summary (`Rich`) or
//! plain piped output (`Simple`). `--json` bypasses all of this and prints the raw event stream.

mod commands;
mod prompt;
mod reporter;

pub use prompt::StdinPrompter;
pub use reporter::HumanReporter;

use owo_colors::OwoColorize;

/// The webapp's brand accent (`--rw-accent`, `#d9690f`) — a saturated orange that reads on both
/// light and dark backgrounds — used to color labels.
const ACCENT: (u8, u8, u8) = (0xD9, 0x69, 0x0F);

/// How human output is rendered. Chosen by the CLI from whether stdout is a terminal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanStyle {
    /// Terminal: colorized aligned text and a live in-place progress bar.
    Rich,
    /// Piped/redirected: the same aligned layout, plain (no color, no bar).
    Simple,
}

/// A styled output target. Renders headings, key/value blocks, and aligned columns according to
/// [`HumanStyle`], and carries whether color is enabled (Rich + no `NO_COLOR`). Layout is identical
/// in both styles; only color and the progress bar differ.
pub struct Surface {
    style: HumanStyle,
    color: bool,
}

impl Surface {
    pub fn new(style: HumanStyle) -> Self {
        let color = matches!(style, HumanStyle::Rich) && std::env::var_os("NO_COLOR").is_none();
        Self { style, color }
    }

    pub fn style(&self) -> HumanStyle {
        self.style
    }

    /// A plain line (used for label-only summaries).
    pub fn line(&self, text: &str) {
        println!("{text}");
    }

    /// A dimmed contextual note.
    pub fn note(&self, text: &str) {
        if self.color {
            println!("{}", text.dimmed());
            return;
        }
        println!("{text}");
    }

    /// An error line (red in Rich), written to stderr.
    pub fn error(&self, text: &str) {
        if self.color {
            eprintln!("{}", text.red().bold());
            return;
        }
        eprintln!("{text}");
    }

    /// A warning line (yellow in Rich), written to stderr.
    pub fn warn(&self, text: &str) {
        if self.color {
            eprintln!("{}", text.yellow());
            return;
        }
        eprintln!("{text}");
    }

    /// A cancellation line (dimmed in Rich), written to stderr.
    pub fn cancelled(&self, text: &str) {
        if self.color {
            eprintln!("{}", text.dimmed());
            return;
        }
        eprintln!("{text}");
    }

    /// Render aligned `label  value` lines. The label is accented (cyan) in Rich; padding is
    /// computed from the plain label width so color codes never skew alignment.
    pub fn key_values(&self, pairs: &[(String, String)]) {
        if pairs.is_empty() {
            return;
        }
        let width = pairs
            .iter()
            .map(|(key, _)| key.chars().count())
            .max()
            .unwrap_or(0);
        for (key, value) in pairs {
            let pad = " ".repeat(width.saturating_sub(key.chars().count()));
            if self.color {
                println!(
                    "{}{pad}  {value}",
                    key.truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
                );
            } else {
                println!("{key}{pad}  {value}");
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
        let column_count = rows.iter().map(|row| row.len()).max().unwrap_or(0);
        let mut widths = vec![0usize; column_count];
        for row in rows {
            for (index, cell) in row.iter().enumerate() {
                widths[index] = widths[index].max(cell.chars().count());
            }
        }
        for row in rows {
            let mut line = String::new();
            for (index, cell) in row.iter().enumerate() {
                let is_last = index + 1 == row.len();
                if self.color && index > 0 {
                    line.push_str(&cell.dimmed().to_string());
                } else {
                    line.push_str(cell);
                }
                if !is_last {
                    let pad = widths[index].saturating_sub(cell.chars().count()) + 2;
                    line.push_str(&" ".repeat(pad));
                }
            }
            println!("{}", line.trim_end());
        }
    }
}

/// Format a byte count using decimal units (e.g. `1.5 MB`).
pub fn humanize_bytes(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}
