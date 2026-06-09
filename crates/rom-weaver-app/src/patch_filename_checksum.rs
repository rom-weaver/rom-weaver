use super::*;

/// Patch input requirements recovered from a patch file name.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct FilenameRequirements {
    /// Expected input checksums keyed by algorithm (lowercase hex values).
    pub checksums: BTreeMap<String, String>,
    /// Expected exact input size in bytes, when the name encodes one.
    pub size: Option<u64>,
}

/// Accumulates parsed requirements while tracking conflicts. A value seen with
/// two differing definitions is marked ambiguous (`None`) and dropped, so an
/// inconsistent name never drives validation.
#[derive(Default)]
struct RequirementAccumulator {
    checksums: BTreeMap<String, Option<String>>,
    size: Option<Option<u64>>,
}

impl RequirementAccumulator {
    fn record_checksum(&mut self, algorithm: String, hex: String) {
        match self.checksums.get(&algorithm) {
            Some(Some(existing)) if existing == &hex => {}
            Some(Some(_)) => {
                self.checksums.insert(algorithm, None);
            }
            Some(None) => {}
            None => {
                self.checksums.insert(algorithm, Some(hex));
            }
        }
    }

    fn record_size(&mut self, value: u64) {
        match self.size {
            Some(Some(existing)) if existing == value => {}
            Some(Some(_)) => self.size = Some(None),
            Some(None) => {}
            None => self.size = Some(Some(value)),
        }
    }

    fn finish(self) -> FilenameRequirements {
        FilenameRequirements {
            checksums: self
                .checksums
                .into_iter()
                .filter_map(|(algorithm, value)| value.map(|hex| (algorithm, hex)))
                .collect(),
            size: self.size.flatten(),
        }
    }
}

/// Map a bare (unlabelled) hex run length to the algorithm it unambiguously
/// represents. Bare detection is intentionally conservative: only lengths with a
/// single dominant convention are inferred, and only when bracketed (see
/// [`collect_enclosed_bare_checksums`]).
fn inferred_algorithm_for_hex_len(hex_len: usize) -> Option<&'static str> {
    match hex_len {
        8 => Some("crc32"),
        32 => Some("md5"),
        40 => Some("sha1"),
        _ => None,
    }
}

/// Collect `<algo>:<hex>`, `<algo>=<hex>`, `bytes:<n>` and `size:<n>` tokens that
/// carry an explicit label. Labelled tokens may be surrounded by any delimiters.
fn collect_labeled(file_name: &str, bytes: &[u8], accumulator: &mut RequirementAccumulator) {
    let mut index = 0;
    while index < bytes.len() {
        let separator = bytes[index];
        if separator != b':' && separator != b'=' {
            index += 1;
            continue;
        }
        // Read the label word immediately preceding the separator. Only ASCII
        // alphanumeric bytes are traversed, so the slice stays on UTF-8
        // boundaries even when the name contains multibyte characters.
        let mut label_start = index;
        while label_start > 0 && bytes[label_start - 1].is_ascii_alphanumeric() {
            label_start -= 1;
        }
        let label = file_name[label_start..index].to_ascii_lowercase();

        if let Some(expected_hex_len) = CliApp::checksum_hex_len(&label) {
            let mut hex_end = index + 1;
            while hex_end < bytes.len() && bytes[hex_end].is_ascii_hexdigit() {
                hex_end += 1;
            }
            let hex = file_name[index + 1..hex_end].to_ascii_lowercase();
            if hex.len() == expected_hex_len {
                accumulator.record_checksum(label, hex);
                index = hex_end;
                continue;
            }
        } else if label == "bytes" || label == "size" {
            let mut digits_end = index + 1;
            while digits_end < bytes.len() && bytes[digits_end].is_ascii_digit() {
                digits_end += 1;
            }
            if digits_end > index + 1
                && let Ok(value) = file_name[index + 1..digits_end].parse::<u64>()
            {
                accumulator.record_size(value);
                index = digits_end;
                continue;
            }
        }
        index += 1;
    }
}

/// Collect bare hex runs that are bracket-enclosed (`[..]`, `(..)` or `{..}`),
/// e.g. `Game [1a2b3c4d].ips`. Enclosure is required to avoid misreading
/// incidental file-name text (dates, version strings) as a checksum.
fn collect_enclosed_bare_checksums(
    file_name: &str,
    bytes: &[u8],
    accumulator: &mut RequirementAccumulator,
) {
    let mut index = 0;
    while index < bytes.len() {
        let closing = match bytes[index] {
            b'[' => b']',
            b'(' => b')',
            b'{' => b'}',
            _ => {
                index += 1;
                continue;
            }
        };
        let mut run_end = index + 1;
        while run_end < bytes.len() && bytes[run_end].is_ascii_hexdigit() {
            run_end += 1;
        }
        if run_end > index + 1 && run_end < bytes.len() && bytes[run_end] == closing {
            let hex = file_name[index + 1..run_end].to_ascii_lowercase();
            if let Some(algorithm) = inferred_algorithm_for_hex_len(hex.len()) {
                accumulator.record_checksum(algorithm.to_string(), hex);
            }
            index = run_end + 1;
            continue;
        }
        index += 1;
    }
}

/// Parse patch input requirements from a patch file name.
///
/// Recognises labelled checksum tokens (`<algo>:<hex>` / `<algo>=<hex>`) for any
/// supported algorithm surrounded by any delimiters, bracket-enclosed bare hex
/// tokens (`[<hex>]`, `(<hex>)`, `{<hex>}`) inferred by length (crc32, md5,
/// sha1), and a labelled size token (`bytes:<n>` / `size:<n>`). Tokens with a
/// recognised algorithm but an incorrect value length are ignored, and any
/// requirement defined inconsistently more than once is dropped.
pub(super) fn parse_filename_requirements(file_name: &str) -> FilenameRequirements {
    let bytes = file_name.as_bytes();
    let mut accumulator = RequirementAccumulator::default();
    collect_labeled(file_name, bytes, &mut accumulator);
    collect_enclosed_bare_checksums(file_name, bytes, &mut accumulator);
    accumulator.finish()
}

/// Insert a checksum requirement token (`[<algo>:<hex>]`) into `output`'s file
/// name, immediately before its extension, for example `out.ips` ->
/// `out [crc32:1a2b3c4d].ips`. Returns the path unchanged when it has no usable
/// file name or already encodes a requirement for that algorithm.
pub(super) fn embed_checksum_in_filename(output: &Path, algorithm: &str, hex: &str) -> PathBuf {
    let algorithm = algorithm.to_ascii_lowercase();
    let hex = hex.to_ascii_lowercase();
    let Some(file_name) = output.file_name().and_then(|name| name.to_str()) else {
        return output.to_path_buf();
    };
    if parse_filename_requirements(file_name)
        .checksums
        .contains_key(&algorithm)
    {
        return output.to_path_buf();
    }
    let token = format!("[{algorithm}:{hex}]");
    let extension = output.extension().and_then(|extension| extension.to_str());
    let stem = output.file_stem().and_then(|stem| stem.to_str());
    let new_name = match (stem, extension) {
        (Some(stem), Some(extension)) => format!("{stem} {token}.{extension}"),
        _ => format!("{file_name} {token}"),
    };
    output.with_file_name(new_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bracketed_labeled_crc32_token() {
        let parsed = parse_filename_requirements("MyHack [crc32:1a2b3c4d].ips");
        assert_eq!(
            parsed.checksums.get("crc32").map(String::as_str),
            Some("1a2b3c4d")
        );
        assert_eq!(parsed.size, None);
    }

    #[test]
    fn parses_equals_separator_and_lowercases_value() {
        let parsed = parse_filename_requirements("hack (crc32=AABBCCDD).bps");
        assert_eq!(
            parsed.checksums.get("crc32").map(String::as_str),
            Some("aabbccdd")
        );
    }

    #[test]
    fn parses_labeled_sha1_and_md5() {
        let sha1 = "0123456789abcdef0123456789abcdef01234567";
        let md5 = "0123456789abcdef0123456789abcdef";
        let parsed = parse_filename_requirements(&format!("rom [sha1:{sha1}] md5:{md5}.ips"));
        assert_eq!(parsed.checksums.get("sha1").map(String::as_str), Some(sha1));
        assert_eq!(parsed.checksums.get("md5").map(String::as_str), Some(md5));
    }

    #[test]
    fn parses_labeled_size_tokens() {
        assert_eq!(
            parse_filename_requirements("rom [size:524288].ips").size,
            Some(524288)
        );
        assert_eq!(
            parse_filename_requirements("rom (bytes=1048576).bps").size,
            Some(1048576)
        );
    }

    #[test]
    fn infers_bare_enclosed_checksums_by_length() {
        let parsed = parse_filename_requirements("Game [1a2b3c4d].ips");
        assert_eq!(
            parsed.checksums.get("crc32").map(String::as_str),
            Some("1a2b3c4d")
        );

        let md5 = "0123456789abcdef0123456789abcdef";
        let parsed = parse_filename_requirements(&format!("Game ({md5}).ips"));
        assert_eq!(parsed.checksums.get("md5").map(String::as_str), Some(md5));
    }

    #[test]
    fn ignores_bare_hex_without_enclosure() {
        // A bare 8-digit run that is not bracket-enclosed (e.g. a date) must not
        // be misread as a crc32.
        let parsed = parse_filename_requirements("MyHack 20231015.ips");
        assert!(parsed.checksums.is_empty() && parsed.size.is_none());
    }

    #[test]
    fn rejects_wrong_length_labeled_hex() {
        let parsed = parse_filename_requirements("hack [crc32:1a2b3c].ips");
        assert!(parsed.checksums.is_empty());
    }

    #[test]
    fn rejects_unknown_algorithm_word() {
        let parsed = parse_filename_requirements("notcrc32:1a2b3c4d.ips");
        assert!(parsed.checksums.is_empty());
    }

    #[test]
    fn drops_conflicting_duplicate_algorithm() {
        let parsed = parse_filename_requirements("hack [crc32:11111111][crc32:22222222].ips");
        assert!(parsed.checksums.is_empty());
    }

    #[test]
    fn keeps_repeated_identical_algorithm() {
        let parsed = parse_filename_requirements("hack [crc32:11111111] crc32:11111111.ips");
        assert_eq!(
            parsed.checksums.get("crc32").map(String::as_str),
            Some("11111111")
        );
    }

    #[test]
    fn drops_conflicting_size() {
        let parsed = parse_filename_requirements("hack [size:10] (bytes:20).ips");
        assert_eq!(parsed.size, None);
    }

    #[test]
    fn embeds_token_before_extension() {
        let embedded = embed_checksum_in_filename(Path::new("/tmp/out.ips"), "crc32", "1A2B3C4D");
        assert_eq!(embedded, Path::new("/tmp/out [crc32:1a2b3c4d].ips"));
    }

    #[test]
    fn embeds_token_when_no_extension() {
        let embedded = embed_checksum_in_filename(Path::new("/tmp/out"), "crc32", "1a2b3c4d");
        assert_eq!(embedded, Path::new("/tmp/out [crc32:1a2b3c4d]"));
    }

    #[test]
    fn embed_is_idempotent_for_same_algorithm() {
        let once = embed_checksum_in_filename(Path::new("/tmp/out.ips"), "crc32", "1a2b3c4d");
        let twice = embed_checksum_in_filename(&once, "crc32", "1a2b3c4d");
        assert_eq!(once, twice);
    }

    #[test]
    fn embed_round_trips_through_parser() {
        let embedded = embed_checksum_in_filename(Path::new("out.bdf"), "crc32", "deadbeef");
        let name = embedded
            .file_name()
            .and_then(|name| name.to_str())
            .expect("name");
        let parsed = parse_filename_requirements(name);
        assert_eq!(
            parsed.checksums.get("crc32").map(String::as_str),
            Some("deadbeef")
        );
    }
}
