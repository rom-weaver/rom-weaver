pub(crate) mod checked;
pub(crate) mod checksum_io;
pub(crate) mod endpoints;
pub(crate) mod labeled_parser;
pub(crate) mod labels;
pub(crate) mod runs;
pub(crate) mod threading;

/// Lower-case hex encoding of `bytes`.
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

/// Current UTC calendar date as `(year, month, day)`; clock errors before the epoch read as 1970-01-01.
pub(crate) fn utc_today() -> (i32, u32, u32) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0));
    civil_date_from_unix_secs(now.as_secs())
}

fn civil_date_from_unix_secs(secs: u64) -> (i32, u32, u32) {
    civil_from_days((secs / 86_400) as i64)
}

pub(crate) fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = (yoe + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (mp + if mp < 10 { 3 } else { -9 }) as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::{civil_date_from_unix_secs, civil_from_days, utc_today};

    #[test]
    fn unix_seconds_map_to_the_containing_utc_day() {
        assert_eq!(civil_date_from_unix_secs(0), (1970, 1, 1));
        assert_eq!(civil_date_from_unix_secs(86_399), (1970, 1, 1));
        assert_eq!(civil_date_from_unix_secs(86_400), (1970, 1, 2));
        assert_eq!(civil_date_from_unix_secs(1_700_000_000), (2023, 11, 14));
    }

    #[test]
    fn utc_today_reads_the_current_clock() {
        let (year, month, day) = utc_today();
        assert!(year >= 2024, "year {year}");
        assert!((1..=12).contains(&month));
        assert!((1..=31).contains(&day));
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expected = civil_date_from_unix_secs(secs);
        // Tolerate a midnight rollover between the two clock reads.
        assert!(expected == (year, month, day) || expected.2 != day);
    }

    #[test]
    fn civil_date_tracks_the_unix_epoch() {
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }
}
