//! Interactive selection seam shared by the app and its front-ends.
//!
//! The app drives the selection/confirmation control flow but does not own terminal IO. A
//! [`SelectionPrompter`] is injected so the CLI can render and read prompts while headless callers
//! (wasm, `--json`, non-tty) use the [`NoninteractivePrompter`], which never blocks on input.

/// One selectable entry presented to the user. `value` is the machine value returned to the app;
/// `label` is the human-facing text shown by the prompter.
#[derive(Clone, Debug)]
pub struct PromptCandidate {
    pub value: String,
    pub label: String,
}

/// The resolved outcome of a list selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Selection {
    Selected(usize),
    Cancelled,
}

/// The result of parsing one line of raw selection input against a candidate count.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParsedSelectionInput {
    Cancelled,
    Selected(usize),
    Invalid,
}

/// Parse a single line of selection input. Accepts `q`/`quit`/`exit` (case-insensitive) as cancel
/// and a 1-based index within `1..=candidate_count`; anything else is [`ParsedSelectionInput::Invalid`].
pub fn parse_selection_input(input: &str, candidate_count: usize) -> ParsedSelectionInput {
    let trimmed = input.trim();
    if trimmed.eq_ignore_ascii_case("q")
        || trimmed.eq_ignore_ascii_case("quit")
        || trimmed.eq_ignore_ascii_case("exit")
    {
        return ParsedSelectionInput::Cancelled;
    }
    if let Ok(parsed) = trimmed.parse::<usize>()
        && (1..=candidate_count).contains(&parsed)
    {
        return ParsedSelectionInput::Selected(parsed - 1);
    }
    ParsedSelectionInput::Invalid
}

/// Injected terminal-IO seam for the app's two interactive moments: picking one of several
/// candidates, and confirming a destructive action.
pub trait SelectionPrompter: Send + Sync {
    /// Prompt the user to choose one of `candidates`. Returns [`Selection::Cancelled`] when the
    /// user declines or when no interactive input is available.
    fn select(&self, heading: &str, candidates: &[PromptCandidate]) -> Selection;

    /// Prompt the user for a yes/no confirmation. `details` are extra context lines describing what
    /// the action affects. Returns `false` when the user declines or input is unavailable.
    fn confirm(&self, heading: &str, details: &[String]) -> bool;
}

/// Prompter for headless callers (wasm, `--json`, non-tty). Reproduces the historical
/// `interactive_selection_enabled == false` behavior: never block, always decline.
#[derive(Debug, Default)]
pub struct NoninteractivePrompter;

impl SelectionPrompter for NoninteractivePrompter {
    fn select(&self, _heading: &str, _candidates: &[PromptCandidate]) -> Selection {
        Selection::Cancelled
    }

    fn confirm(&self, _heading: &str, _details: &[String]) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{ParsedSelectionInput, parse_selection_input};

    #[test]
    fn accepts_valid_indexes() {
        assert_eq!(
            parse_selection_input("1", 3),
            ParsedSelectionInput::Selected(0)
        );
        assert_eq!(
            parse_selection_input("3", 3),
            ParsedSelectionInput::Selected(2)
        );
    }

    #[test]
    fn handles_cancel_and_invalid_values() {
        assert_eq!(
            parse_selection_input("q", 4),
            ParsedSelectionInput::Cancelled
        );
        assert_eq!(
            parse_selection_input("  quit ", 4),
            ParsedSelectionInput::Cancelled
        );
        assert_eq!(parse_selection_input("0", 4), ParsedSelectionInput::Invalid);
        assert_eq!(parse_selection_input("5", 4), ParsedSelectionInput::Invalid);
        assert_eq!(
            parse_selection_input("abc", 4),
            ParsedSelectionInput::Invalid
        );
    }
}
