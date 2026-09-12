//! [`StdinPrompter`]: the interactive [`SelectionPrompter`] for a real terminal. Renders prompts to
//! stderr and reads choices from stdin; the parsing rules are shared with the app via core.

use std::io::{self, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use rom_weaver_core::{
    ParsedSelectionInput, ParsedSelectionListInput, PromptCandidate, Selection, SelectionList,
    SelectionPrompter, parse_selection_input, parse_selection_list_input,
    process_cancellation_token,
};

use super::{clear_progress, display_text, write_stderr};

/// Reads interactive selections and confirmations from the terminal.
pub struct StdinPrompter;

impl StdinPrompter {
    pub fn new() -> Self {
        Self
    }
}

impl SelectionPrompter for StdinPrompter {
    fn select(&self, heading: &str, candidates: &[PromptCandidate]) -> Selection {
        if candidates.is_empty() {
            return Selection::Cancelled;
        }
        clear_progress();
        write_stderr(format_args!("{}\n", display_text(heading)));
        for (index, candidate) in candidates.iter().enumerate() {
            write_stderr(format_args!(
                "  {}. {}\n",
                index + 1,
                display_text(&candidate.label)
            ));
        }
        write_stderr(format_args!(
            "Enter a number between 1 and {}, or `q` to cancel.\n",
            candidates.len()
        ));

        loop {
            write_stderr(format_args!("selection> "));
            let _ = io::stderr().flush();
            let input = match read_prompt_input() {
                Ok(Some(input)) => input,
                Ok(None) | Err(_) => {
                    write_stderr(format_args!("\n"));
                    process_cancellation_token().cancel();
                    return Selection::Cancelled;
                }
            };
            let trimmed = input.trim();
            match parse_selection_input(trimmed, candidates.len()) {
                ParsedSelectionInput::Cancelled => {
                    process_cancellation_token().cancel();
                    return Selection::Cancelled;
                }
                ParsedSelectionInput::Selected(index) => return Selection::Selected(index),
                ParsedSelectionInput::Invalid => write_stderr(format_args!(
                    "invalid selection `{}`. Enter 1..{} or `q`.\n",
                    display_text(trimmed),
                    candidates.len()
                )),
            }
        }
    }

    fn select_many(&self, heading: &str, candidates: &[PromptCandidate]) -> SelectionList {
        if candidates.is_empty() {
            return SelectionList::Cancelled;
        }
        clear_progress();
        write_stderr(format_args!("{}\n", display_text(heading)));
        for (index, candidate) in candidates.iter().enumerate() {
            write_stderr(format_args!(
                "  {}. {}\n",
                index + 1,
                display_text(&candidate.label)
            ));
        }
        write_stderr(format_args!(
            "Enter numbers or ranges between 1 and {} (for example `1,3-4`), or `q` to cancel.\n",
            candidates.len()
        ));

        loop {
            write_stderr(format_args!("selection> "));
            let _ = io::stderr().flush();
            let input = match read_prompt_input() {
                Ok(Some(input)) => input,
                Ok(None) | Err(_) => {
                    write_stderr(format_args!("\n"));
                    process_cancellation_token().cancel();
                    return SelectionList::Cancelled;
                }
            };
            let trimmed = input.trim();
            match parse_selection_list_input(trimmed, candidates.len()) {
                ParsedSelectionListInput::Cancelled => {
                    process_cancellation_token().cancel();
                    return SelectionList::Cancelled;
                }
                ParsedSelectionListInput::Selected(indexes) => {
                    return SelectionList::Selected(indexes);
                }
                ParsedSelectionListInput::Invalid => write_stderr(format_args!(
                    "invalid selection `{}`. Enter 1..{}, comma-separated values, ranges, or `q`.\n",
                    display_text(trimmed),
                    candidates.len()
                )),
            }
        }
    }

    fn confirm(&self, heading: &str, details: &[String]) -> bool {
        clear_progress();
        write_stderr(format_args!("{}\n", display_text(heading)));
        for line in details.iter().take(10) {
            write_stderr(format_args!("  - {}\n", display_text(line)));
        }
        if details.len() > 10 {
            write_stderr(format_args!("  ... and {} more\n", details.len() - 10));
        }

        loop {
            write_stderr(format_args!("Continue? [y/N] "));
            let _ = io::stderr().flush();
            let input = match read_prompt_input() {
                Ok(Some(input)) => input,
                Ok(None) | Err(_) => {
                    write_stderr(format_args!("\n"));
                    process_cancellation_token().cancel();
                    return false;
                }
            };
            match input.trim().to_ascii_lowercase().as_str() {
                "y" | "yes" => return true,
                "" | "n" | "no" => return false,
                _ => write_stderr(format_args!("Please answer `y` or `n`.\n")),
            }
        }
    }
}

// The command thread MUST observe Ctrl-C while stdin blocks so it can clean up partial output.
fn read_prompt_input() -> io::Result<Option<String>> {
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::Builder::new()
        .name("rom-weaver-prompt".to_string())
        .spawn(move || {
            let mut input = String::new();
            let result = io::stdin()
                .read_line(&mut input)
                .map(|count| (count != 0).then_some(input));
            let _ = sender.send(result);
        })?;
    let cancellation = process_cancellation_token();
    loop {
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => {
                worker
                    .join()
                    .map_err(|_| io::Error::other("terminal input thread failed"))?;
                return result;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(io::Error::other(
                    "terminal input thread stopped without a result",
                ));
            }
        }
    }
}
