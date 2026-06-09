//! [`StdinPrompter`]: the interactive [`SelectionPrompter`] for a real terminal. Renders prompts to
//! stderr and reads choices from stdin; the parsing rules are shared with the app via core.

use std::io::{self, Write};

use rom_weaver_core::{
    ParsedSelectionInput, ParsedSelectionListInput, PromptCandidate, Selection, SelectionList,
    SelectionPrompter, parse_selection_input, parse_selection_list_input,
};

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
        eprintln!("{heading}");
        for (index, candidate) in candidates.iter().enumerate() {
            eprintln!("  {}. {}", index + 1, candidate.label);
        }
        eprintln!(
            "Enter a number between 1 and {}, or `q` to cancel.",
            candidates.len()
        );

        loop {
            eprint!("selection> ");
            let _ = io::stderr().flush();
            let mut input = String::new();
            match io::stdin().read_line(&mut input) {
                Ok(0) | Err(_) => return Selection::Cancelled,
                Ok(_) => {}
            }
            let trimmed = input.trim();
            match parse_selection_input(trimmed, candidates.len()) {
                ParsedSelectionInput::Cancelled => return Selection::Cancelled,
                ParsedSelectionInput::Selected(index) => return Selection::Selected(index),
                ParsedSelectionInput::Invalid => eprintln!(
                    "invalid selection `{trimmed}`. Enter 1..{} or `q`.",
                    candidates.len()
                ),
            }
        }
    }

    fn select_many(&self, heading: &str, candidates: &[PromptCandidate]) -> SelectionList {
        if candidates.is_empty() {
            return SelectionList::Cancelled;
        }
        eprintln!("{heading}");
        for (index, candidate) in candidates.iter().enumerate() {
            eprintln!("  {}. {}", index + 1, candidate.label);
        }
        eprintln!(
            "Enter numbers or ranges between 1 and {} (for example `1,3-4`), or `q` to cancel.",
            candidates.len()
        );

        loop {
            eprint!("selection> ");
            let _ = io::stderr().flush();
            let mut input = String::new();
            match io::stdin().read_line(&mut input) {
                Ok(0) | Err(_) => return SelectionList::Cancelled,
                Ok(_) => {}
            }
            let trimmed = input.trim();
            match parse_selection_list_input(trimmed, candidates.len()) {
                ParsedSelectionListInput::Cancelled => return SelectionList::Cancelled,
                ParsedSelectionListInput::Selected(indexes) => {
                    return SelectionList::Selected(indexes);
                }
                ParsedSelectionListInput::Invalid => eprintln!(
                    "invalid selection `{trimmed}`. Enter 1..{}, comma-separated values, ranges, or `q`.",
                    candidates.len()
                ),
            }
        }
    }

    fn confirm(&self, heading: &str, details: &[String]) -> bool {
        eprintln!("{heading}");
        for line in details.iter().take(10) {
            eprintln!("  - {line}");
        }
        if details.len() > 10 {
            eprintln!("  ... and {} more", details.len() - 10);
        }

        loop {
            eprint!("Continue? [y/N] ");
            let _ = io::stderr().flush();
            let mut input = String::new();
            match io::stdin().read_line(&mut input) {
                Ok(0) | Err(_) => return false,
                Ok(_) => {}
            }
            match input.trim().to_ascii_lowercase().as_str() {
                "y" | "yes" => return true,
                "" | "n" | "no" => return false,
                _ => eprintln!("Please answer `y` or `n`."),
            }
        }
    }
}
