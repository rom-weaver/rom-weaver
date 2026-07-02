use std::collections::BTreeSet;

use crate::{Result, RomWeaverError};

#[derive(Clone, Debug)]
enum SelectionPatternKind {
    ExactOrPrefix,
    Wildcard(WildcardPattern),
}

#[derive(Clone, Debug)]
struct SelectionPattern {
    requested: String,
    kind: SelectionPatternKind,
}

impl SelectionPattern {
    fn new(requested: String) -> Self {
        if Self::contains_glob_syntax(&requested) {
            let wildcard = WildcardPattern::new(&requested);
            return Self {
                requested,
                kind: SelectionPatternKind::Wildcard(wildcard),
            };
        }
        Self {
            requested,
            kind: SelectionPatternKind::ExactOrPrefix,
        }
    }

    fn contains_glob_syntax(value: &str) -> bool {
        value
            .bytes()
            .any(|byte| matches!(byte, b'*' | b'?' | b'[' | b'{' | b']' | b'}'))
    }

    fn matches(&self, entry_name: &str) -> bool {
        if entry_name == self.requested || entry_name.starts_with(&format!("{}/", self.requested)) {
            return true;
        }
        match &self.kind {
            SelectionPatternKind::ExactOrPrefix => false,
            SelectionPatternKind::Wildcard(pattern) => pattern.matches(entry_name),
        }
    }
}

#[derive(Clone, Debug)]
struct WildcardPattern {
    segments: Vec<PathPatternSegment>,
}

#[derive(Clone, Debug)]
enum PathPatternSegment {
    AnyDepth,
    OneSegment(String),
}

impl WildcardPattern {
    fn new(pattern: &str) -> Self {
        let segments = pattern
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                if segment == "**" {
                    PathPatternSegment::AnyDepth
                } else {
                    PathPatternSegment::OneSegment(segment.to_string())
                }
            })
            .collect::<Vec<_>>();
        Self { segments }
    }

    fn matches(&self, entry_name: &str) -> bool {
        let path_segments = entry_name
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        Self::matches_path_segments(&self.segments, &path_segments)
    }

    fn matches_path_segments(
        pattern_segments: &[PathPatternSegment],
        path_segments: &[&str],
    ) -> bool {
        match pattern_segments.split_first() {
            None => path_segments.is_empty(),
            Some((PathPatternSegment::AnyDepth, remaining)) => {
                if Self::matches_path_segments(remaining, path_segments) {
                    return true;
                }
                if let Some((_, tail)) = path_segments.split_first() {
                    return Self::matches_path_segments(pattern_segments, tail);
                }
                false
            }
            Some((PathPatternSegment::OneSegment(pattern), remaining)) => {
                let Some((segment, tail)) = path_segments.split_first() else {
                    return false;
                };
                if !matches_wildcard_segment(pattern, segment) {
                    return false;
                }
                Self::matches_path_segments(remaining, tail)
            }
        }
    }
}

fn matches_wildcard_segment(pattern: &str, candidate: &str) -> bool {
    let pattern_chars = pattern.chars().collect::<Vec<_>>();
    let candidate_chars = candidate.chars().collect::<Vec<_>>();
    matches_wildcard_segment_inner(&pattern_chars, &candidate_chars)
}

/// Greedy two-pointer wildcard match with a single backtrack anchor on the most
/// recent `*` group. Runs in O(pattern * candidate) time and O(1) extra space, so an
/// adversarial multi-star archive entry name cannot drive it into the exponential
/// recursion the previous implementation allowed. `?`, literals, and `[...]` classes
/// each consume exactly one candidate char, so the standard wildcard greedy algorithm
/// keeps the original matching semantics intact.
fn matches_wildcard_segment_inner(pattern: &[char], candidate: &[char]) -> bool {
    let mut pattern_index = 0usize;
    let mut candidate_index = 0usize;
    // Backtrack anchor: pattern index just past the most recent `*` group, plus the
    // candidate index that star is currently credited with having consumed.
    let mut star_pattern_index: Option<usize> = None;
    let mut star_candidate_index = 0usize;

    while candidate_index < candidate.len() {
        if pattern_index < pattern.len() && pattern[pattern_index] != '*' {
            let (matched, next_pattern_index) =
                match_single_token(pattern, pattern_index, candidate[candidate_index]);
            if matched {
                pattern_index = next_pattern_index;
                candidate_index += 1;
                continue;
            }
        }
        if pattern_index < pattern.len() && pattern[pattern_index] == '*' {
            while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
                pattern_index += 1;
            }
            star_pattern_index = Some(pattern_index);
            star_candidate_index = candidate_index;
            continue;
        }
        let Some(anchor) = star_pattern_index else {
            return false;
        };
        // Let the most recent `*` swallow one more candidate char and retry from there.
        star_candidate_index += 1;
        candidate_index = star_candidate_index;
        pattern_index = anchor;
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

/// Matches the single non-`*` pattern token starting at `pattern_index` against one
/// candidate char, returning whether it matched and the pattern index just past the
/// token. `?` matches any char, `[...]` matches a character class (an unterminated `[`
/// is treated as a literal `[`), and anything else matches an exact char.
fn match_single_token(pattern: &[char], pattern_index: usize, value: char) -> (bool, usize) {
    match pattern[pattern_index] {
        '?' => (true, pattern_index + 1),
        '[' => match find_character_class_end(pattern, pattern_index + 1) {
            Some(class_end) => (
                character_class_matches(&pattern[pattern_index + 1..class_end], value),
                class_end + 1,
            ),
            None => (value == '[', pattern_index + 1),
        },
        expected => (value == expected, pattern_index + 1),
    }
}

fn find_character_class_end(pattern: &[char], class_start: usize) -> Option<usize> {
    let mut index = class_start;
    while index < pattern.len() {
        if pattern[index] == ']' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn character_class_matches(class: &[char], value: char) -> bool {
    if class.is_empty() {
        return false;
    }

    let mut index = 0usize;
    let mut negated = false;
    if matches!(class.first(), Some('!') | Some('^')) {
        negated = true;
        index = 1;
    }

    let mut matched = false;
    while index < class.len() {
        let current = class[index];
        if index + 2 < class.len() && class[index + 1] == '-' {
            let range_end = class[index + 2];
            if current <= value && value <= range_end {
                matched = true;
            }
            index += 3;
            continue;
        }

        if current == value {
            matched = true;
        }
        index += 1;
    }

    if negated { !matched } else { matched }
}

#[derive(Debug, Default)]
pub struct SelectionMatcher {
    requested: Vec<SelectionPattern>,
    matched: BTreeSet<String>,
}

impl SelectionMatcher {
    pub fn new(requested: &[String]) -> Self {
        let requested = requested
            .iter()
            .map(|value| normalize_archive_name(value))
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(SelectionPattern::new)
            .collect::<Vec<_>>();
        Self {
            requested,
            matched: BTreeSet::new(),
        }
    }

    pub fn matches(&mut self, entry_name: &str) -> bool {
        if self.requested.is_empty() {
            return true;
        }
        let entry_name = normalize_archive_name(entry_name);
        if entry_name.is_empty() {
            return false;
        }
        // Credit *every* pattern this entry satisfies, not just the first: overlapping
        // selections (e.g. `*.bin` and `track01.bin`) must each be marked matched, or
        // `ensure_all_matched` would abort the extract claiming a selection was unused.
        let mut any_matched = false;
        for requested in &self.requested {
            if requested.matches(&entry_name) {
                self.matched.insert(requested.requested.clone());
                any_matched = true;
            }
        }
        any_matched
    }

    pub fn ensure_all_matched(&self) -> Result<()> {
        let missing = self
            .requested
            .iter()
            .filter_map(|requested| {
                (!self.matched.contains(&requested.requested))
                    .then_some(requested.requested.clone())
            })
            .collect::<Vec<_>>();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(RomWeaverError::Validation(format!(
                "requested selections were not found: {}",
                missing.join(", ")
            )))
        }
    }
}

pub fn normalize_archive_name(name: &str) -> String {
    name.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{SelectionMatcher, normalize_archive_name};

    #[test]
    fn normalizes_archive_paths() {
        assert_eq!(
            normalize_archive_name(" ./content\\disc.bin/ "),
            "content/disc.bin"
        );
    }

    #[test]
    fn selection_matcher_preserves_exact_and_prefix_matches() {
        let mut selections =
            SelectionMatcher::new(&["content".to_string(), "disc.iso".to_string()]);
        assert!(selections.matches("content/track01.bin"));
        assert!(selections.matches("disc.iso"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn selection_matcher_preserves_bracketed_exact_matches() {
        let mut selections = SelectionMatcher::new(&["bundle/game [Hack].bps".to_string()]);
        assert!(selections.matches("bundle/game [Hack].bps"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn selection_matcher_supports_glob_patterns() {
        let mut selections =
            SelectionMatcher::new(&["content/**/*.bin".to_string(), "cover.???".to_string()]);
        assert!(selections.matches("content/disc.bin"));
        assert!(selections.matches("content/tracks/track01.bin"));
        assert!(selections.matches("cover.png"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn selection_matcher_reports_missing_matches() {
        let mut selections = SelectionMatcher::new(&["*.cue".to_string()]);
        assert!(!selections.matches("disc.bin"));
        let error = selections
            .ensure_all_matched()
            .expect_err("missing selection");
        assert!(
            error
                .to_string()
                .contains("requested selections were not found: *.cue")
        );
    }

    #[test]
    fn selection_matcher_credits_all_overlapping_patterns() {
        // A single entry that satisfies both an exact name and a wildcard must credit
        // *both* selections, or ensure_all_matched would wrongly abort the extract.
        let mut selections =
            SelectionMatcher::new(&["*.bin".to_string(), "track01.bin".to_string()]);
        assert!(selections.matches("track01.bin"));
        assert!(
            selections.ensure_all_matched().is_ok(),
            "both overlapping selections should be marked matched"
        );
    }

    #[test]
    fn selection_matcher_credits_overlapping_glob_and_prefix() {
        let mut selections =
            SelectionMatcher::new(&["content/**/*.bin".to_string(), "content".to_string()]);
        assert!(selections.matches("content/tracks/track01.bin"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn glob_matcher_handles_multi_star_and_classes() {
        let mut selections = SelectionMatcher::new(&[
            "a*b*c".to_string(),
            "cover.[0-9][0-9][0-9]".to_string(),
            "weird[name".to_string(),
        ]);
        // Multi-star with interleaved literals.
        assert!(selections.matches("axxbyyc"));
        // Adjacent character classes.
        assert!(selections.matches("cover.123"));
        // Unterminated `[` falls back to a literal bracket.
        assert!(selections.matches("weird[name"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn glob_matcher_rejects_non_matches() {
        let mut selections = SelectionMatcher::new(&["a*b*c".to_string()]);
        assert!(!selections.matches("axxbyyd"));
        assert!(!selections.matches("ab"));
        assert!(selections.ensure_all_matched().is_err());
    }

    #[test]
    fn glob_matcher_does_not_blow_up_on_adversarial_stars() {
        // The previous recursive matcher was exponential on long multi-star patterns
        // against a non-matching candidate; the greedy matcher returns promptly.
        let pattern = "*".repeat(40);
        let mut selections = SelectionMatcher::new(&[format!("{pattern}z")]);
        let candidate = "a".repeat(64);
        assert!(!selections.matches(&candidate));
    }
}
