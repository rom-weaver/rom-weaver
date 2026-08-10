use super::*;

use std::collections::BTreeMap;

/// Expected hex length for a supported checksum algorithm, or `None` when the
/// algorithm is unknown.
pub(crate) fn checksum_hex_len(algorithm: &str) -> Option<usize> {
    match algorithm {
        "crc16" => Some(4),
        "crc32" | "crc32c" | "adler32" => Some(8),
        "md5" => Some(32),
        "sha1" => Some(40),
        "sha256" | "blake3" => Some(64),
        _ => None,
    }
}

/// A single parsed `--expect-in`/`--expect-out`/`--assume-in` token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExpectToken {
    /// `algo=hex` - a trusted or expected checksum value.
    Checksum { algo: String, hex: String },
    /// `size=N` - an exact byte-length expectation.
    Size(u64),
    /// `min-size=N` - a minimum byte-length expectation.
    MinSize(u64),
}

/// The folded expectations from a token list: checksum map plus optional
/// size / minimum-size gates. `checksums` is deduplicated and conflict-checked.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExpectSpec {
    pub checksums: BTreeMap<String, String>,
    pub size: Option<u64>,
    pub min_size: Option<u64>,
}

fn parse_size_value(kind: &str, raw: &str) -> std::result::Result<u64, String> {
    raw.trim()
        .parse::<u64>()
        .map_err(|_| format!("`{kind}={raw}` is invalid; expected a non-negative byte count"))
}

/// Parse and validate one raw token. Shared by the clap `value_parser`
/// (early errors) and the handler-side folding parser below.
pub fn parse_expect_token(raw: &str) -> std::result::Result<ExpectToken, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("token cannot be empty; expected ALGO=HEX, size=N, or min-size=N".to_string());
    }
    let (key_raw, value_raw) = trimmed.split_once('=').ok_or_else(|| {
        format!("`{trimmed}` is invalid; expected ALGO=HEX, size=N, or min-size=N")
    })?;
    let key = key_raw.trim().to_ascii_lowercase();
    let value = value_raw.trim();
    match key.as_str() {
        "size" => Ok(ExpectToken::Size(parse_size_value("size", value)?)),
        "min-size" | "min_size" => Ok(ExpectToken::MinSize(parse_size_value("min-size", value)?)),
        "" => Err(format!(
            "`{trimmed}` is invalid; checksum algorithm is missing before `=`"
        )),
        algo => {
            let hex = value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
                .unwrap_or(value)
                .to_ascii_lowercase();
            if hex.is_empty() {
                return Err(format!(
                    "`{trimmed}` is invalid; checksum value is missing after `=`"
                ));
            }
            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(format!(
                    "`{trimmed}` is invalid; checksum must be hexadecimal"
                ));
            }
            let Some(expected_len) = checksum_hex_len(algo) else {
                return Err(unsupported_checksum_algorithm_message(key_raw.trim()));
            };
            if hex.len() != expected_len {
                return Err(format!(
                    "`{trimmed}` is invalid; `{algo}` expects {expected_len} hex characters, got {}",
                    hex.len()
                ));
            }
            Ok(ExpectToken::Checksum {
                algo: algo.to_string(),
                hex,
            })
        }
    }
}

/// clap `value_parser` shim: validate a raw token and return it unchanged so
/// the raw string still round-trips to the handler for folding.
#[cfg(not(target_arch = "wasm32"))]
pub fn validate_expect_token(raw: &str) -> std::result::Result<String, String> {
    parse_expect_token(raw)?;
    Ok(raw.to_string())
}

/// Fold a token list into an [`ExpectSpec`]. When `allow_size` is false (the
/// `--expect-out` case), size/min-size tokens are rejected. Rejects duplicate
/// or conflicting values for the same algorithm and repeated size gates.
pub fn parse_expect_tokens(
    values: &[String],
    flag_name: &str,
    allow_size: bool,
) -> Result<ExpectSpec> {
    let mut spec = ExpectSpec::default();
    for raw in values {
        let token = parse_expect_token(raw).map_err(|message| {
            RomWeaverError::Validation(format!("{flag_name} value {message}"))
        })?;
        match token {
            ExpectToken::Checksum { algo, hex } => match spec.checksums.get(&algo) {
                Some(existing) if existing != &hex => {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} provides conflicting values for `{algo}`"
                    )));
                }
                Some(_) => {}
                None => {
                    spec.checksums.insert(algo, hex);
                }
            },
            ExpectToken::Size(size) => {
                if !allow_size {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} does not accept size expectations"
                    )));
                }
                if spec.size.is_some_and(|existing| existing != size) {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} provides conflicting size expectations"
                    )));
                }
                spec.size = Some(size);
            }
            ExpectToken::MinSize(min_size) => {
                if !allow_size {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} does not accept size expectations"
                    )));
                }
                if spec.min_size.is_some_and(|existing| existing != min_size) {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} provides conflicting minimum-size expectations"
                    )));
                }
                spec.min_size = Some(min_size);
            }
        }
    }
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_checksum_size_and_min_size_tokens() {
        assert_eq!(
            parse_expect_token("crc32=1234ABCD").unwrap(),
            ExpectToken::Checksum {
                algo: "crc32".to_string(),
                hex: "1234abcd".to_string(),
            }
        );
        assert_eq!(
            parse_expect_token("crc32=0x1234abcd").unwrap(),
            ExpectToken::Checksum {
                algo: "crc32".to_string(),
                hex: "1234abcd".to_string(),
            }
        );
        assert_eq!(
            parse_expect_token("size=1048576").unwrap(),
            ExpectToken::Size(1_048_576)
        );
        assert_eq!(
            parse_expect_token("min-size=512").unwrap(),
            ExpectToken::MinSize(512)
        );
        assert_eq!(
            parse_expect_token("min_size=512").unwrap(),
            ExpectToken::MinSize(512)
        );
    }

    #[test]
    fn rejects_malformed_tokens() {
        assert!(parse_expect_token("").is_err());
        assert!(parse_expect_token("crc32").is_err());
        assert!(parse_expect_token("=abcd").is_err());
        assert!(parse_expect_token("crc32=").is_err());
        assert!(parse_expect_token("crc32=zzzz").is_err());
        assert!(
            parse_expect_token("crc32=12ab").is_err(),
            "wrong hex length"
        );
        assert!(
            parse_expect_token("nope=1234abcd").is_err(),
            "unknown algorithm"
        );
        assert!(parse_expect_token("size=-1").is_err());
        assert!(parse_expect_token("size=abc").is_err());
    }

    #[test]
    fn folds_and_deduplicates_tokens() {
        let spec = parse_expect_tokens(
            &[
                "crc32=1234abcd".to_string(),
                "size=2048".to_string(),
                "min-size=1024".to_string(),
                "crc32=1234abcd".to_string(),
            ],
            "--expect-in",
            true,
        )
        .unwrap();
        assert_eq!(
            spec.checksums.get("crc32").map(String::as_str),
            Some("1234abcd")
        );
        assert_eq!(spec.size, Some(2048));
        assert_eq!(spec.min_size, Some(1024));
    }

    #[test]
    fn rejects_conflicts_and_disallowed_size() {
        assert!(
            parse_expect_tokens(
                &["crc32=1234abcd".to_string(), "crc32=deadbeef".to_string()],
                "--expect-in",
                true,
            )
            .is_err()
        );
        assert!(
            parse_expect_tokens(&["size=2048".to_string()], "--expect-out", false).is_err(),
            "--expect-out rejects size tokens"
        );
    }
}
