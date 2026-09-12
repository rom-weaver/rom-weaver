/// A suggestion MUST have a normalized Damerau-Levenshtein score above this
/// threshold; counting a transposition as one edit admits `cdh` for `chd`.
const SUGGESTION_THRESHOLD: f64 = 0.5;

/// The registered name that most closely resembles `requested`, if any is
/// close enough to be a probable typo. Each candidate is `(spelling, name)`
/// so an alias can match while the canonical name is what gets suggested.
/// Comparison is ASCII case-insensitive; the returned name is as registered.
pub fn closest_name<'a>(
    requested: &str,
    candidates: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Option<&'a str> {
    let requested = requested.trim().to_ascii_lowercase();
    if requested.is_empty() {
        return None;
    }
    let mut best: Option<(f64, &'a str)> = None;
    for (spelling, name) in candidates {
        let score =
            strsim::normalized_damerau_levenshtein(&requested, &spelling.to_ascii_lowercase());
        if score > SUGGESTION_THRESHOLD && best.is_none_or(|(best_score, _)| score > best_score) {
            best = Some((score, name));
        }
    }
    best.map(|(_, name)| name)
}

/// The `; did you mean ...?` tail appended to a "not registered" message, or
/// an empty string when no registered name is close enough to suggest.
pub fn did_you_mean_suffix<'a>(
    requested: &str,
    candidates: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> String {
    match closest_name(requested, candidates) {
        Some(name) => format!("; did you mean `{name}`?"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{closest_name, did_you_mean_suffix};

    const FORMATS: [(&str, &str); 6] = [
        ("zip", "zip"),
        ("7z", "7z"),
        ("7zip", "7z"),
        ("chd", "chd"),
        ("rvz", "rvz"),
        ("z3ds", "z3ds"),
    ];

    #[test]
    fn suggests_the_closest_registered_name() {
        assert_eq!(closest_name("cdh", FORMATS), Some("chd"));
        assert_eq!(closest_name("zpi", FORMATS), Some("zip"));
        assert_eq!(closest_name("RVZ ", FORMATS), Some("rvz"));
        assert_eq!(closest_name("z3d", FORMATS), Some("z3ds"));
    }

    #[test]
    fn suggests_the_canonical_name_for_an_alias_typo() {
        assert_eq!(closest_name("7zpi", FORMATS), Some("7z"));
    }

    #[test]
    fn stays_silent_when_nothing_is_close() {
        assert_eq!(closest_name("iso", FORMATS), None);
        assert_eq!(closest_name("not-a-format", FORMATS), None);
        assert_eq!(closest_name("", FORMATS), None);
        assert_eq!(did_you_mean_suffix("iso", FORMATS), "");
    }

    #[test]
    fn formats_the_suffix() {
        assert_eq!(did_you_mean_suffix("cdh", FORMATS), "; did you mean `chd`?");
    }
}
