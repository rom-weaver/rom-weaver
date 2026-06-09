const BYTE_UNIT_BASE: f64 = 1000.0;
const BYTE_UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];

fn format_human_decimal(value: f64) -> String {
    let mut text = format!("{value:.2}");
    while text.ends_with('0') && !text.ends_with(".0") {
        text.pop();
    }
    text
}

/// Format a byte count using decimal byte units for human-facing output.
pub fn format_human_bytes(bytes: u64) -> String {
    if bytes < BYTE_UNIT_BASE as u64 {
        return format!("{bytes} B");
    }

    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= BYTE_UNIT_BASE && unit < BYTE_UNITS.len() - 1 {
        value /= BYTE_UNIT_BASE;
        unit += 1;
    }
    format!("{} {}", format_human_decimal(value), BYTE_UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::format_human_bytes;

    #[test]
    fn formats_decimal_byte_units_with_two_digit_granularity() {
        assert_eq!(format_human_bytes(999), "999 B");
        assert_eq!(format_human_bytes(1000), "1.0 KB");
        assert_eq!(format_human_bytes(1_500_000), "1.5 MB");
        assert_eq!(format_human_bytes(12_345_678), "12.35 MB");
        assert_eq!(format_human_bytes(1_558_821_365), "1.56 GB");
        assert_eq!(format_human_bytes(2_500_000_000), "2.5 GB");
    }
}
