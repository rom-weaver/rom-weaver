fn render_label(
    algorithms: &[Algorithm],
    results: &BTreeMap<String, String>,
    range: &ResolvedRange,
    cached_count: usize,
) -> String {
    let mut parts = Vec::with_capacity(algorithms.len() + 2);
    if range.explicit {
        parts.push(format!("range={}..{}", range.start, range.end()));
    }
    for algorithm in algorithms {
        if let Some(value) = results.get(algorithm.name()) {
            parts.push(format!("{}={value}", algorithm.name()));
        }
    }
    if cached_count == algorithms.len() {
        parts.push("cache=hit".to_string());
    } else if cached_count > 0 {
        parts.push(format!(
            "cache=partial({cached_count}/{})",
            algorithms.len()
        ));
    }
    parts.join(" ")
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub fn supported_algorithms() -> &'static [&'static str] {
    SUPPORTED_ALGORITHMS
}

