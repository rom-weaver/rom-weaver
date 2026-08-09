use super::*;
pub(super) fn render_label(
    algorithms: &[Algorithm],
    results: &BTreeMap<String, String>,
    range: &ResolvedRange,
) -> String {
    let mut parts = Vec::with_capacity(algorithms.len() + 1);
    if range.explicit {
        parts.push(format!("range={}..{}", range.start, range.end()));
    }
    for algorithm in algorithms {
        if let Some(value) = results.get(algorithm.name()) {
            parts.push(format!("{}={value}", algorithm.name()));
        }
    }
    parts.join(" ")
}

pub(super) fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub fn supported_algorithms() -> &'static [&'static str] {
    SUPPORTED_ALGORITHMS
}

/// The one rejection message for an unknown checksum algorithm. Every caller
/// routes through this so the list of valid names cannot drift between sites.
pub fn unsupported_checksum_algorithm_message(value: &str) -> String {
    let mut names = SUPPORTED_ALGORITHMS.to_vec();
    let last = names.pop().unwrap_or_default();
    format!(
        "unsupported checksum algorithm `{value}`; expected {}, or {last}",
        names.join(", ")
    )
}

pub fn unsupported_checksum_algorithm(value: &str) -> RomWeaverError {
    RomWeaverError::Validation(unsupported_checksum_algorithm_message(value))
}
