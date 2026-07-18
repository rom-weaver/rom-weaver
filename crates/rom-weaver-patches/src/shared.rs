pub(crate) mod checksum_io;
pub(crate) mod endpoints;
pub(crate) mod labeled_parser;
pub(crate) mod labels;
pub(crate) mod runs;
pub(crate) mod threading;

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
    use super::civil_from_days;

    #[test]
    fn civil_date_tracks_the_unix_epoch() {
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }
}
