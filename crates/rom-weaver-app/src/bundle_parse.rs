use rom_weaver_core::ValidationCodeError;

use super::*;

/// Base file name that marks a file as a rom-weaver bundle.
pub(crate) const BUNDLE_BASE_FILE_NAME: &str = "rom-weaver-bundle.json";

/// Split a bundle-shaped file name. Returns `None` when the name is not
/// bundle-shaped, `Some(None)` for a plain `rom-weaver-bundle.json`, and `Some(Some(ext))`
/// for `rom-weaver-bundle.json.<ext>`. The caller decides whether `ext` is a supported
/// stream-codec extension (that check needs the container registry).
pub(crate) fn bundle_file_name_codec(file_name: &str) -> Option<Option<&str>> {
    let base = BUNDLE_BASE_FILE_NAME.as_bytes();
    let bytes = file_name.as_bytes();
    if bytes.eq_ignore_ascii_case(base) {
        return Some(None);
    }
    if bytes.len() > base.len() + 1
        && bytes[..base.len()].eq_ignore_ascii_case(base)
        && bytes[base.len()] == b'.'
    {
        // The prefix is pure ASCII, so this slice stays on UTF-8 boundaries.
        let extension = &file_name[base.len() + 1..];
        if !extension.is_empty() && !extension.contains('.') {
            return Some(Some(extension));
        }
    }
    None
}

pub(crate) fn bundle_validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

/// Parse and validate bundle JSON bytes. Checksum maps come back normalized
/// (lowercase hex, `0x` prefixes stripped) so downstream comparisons never
/// re-normalize.
pub(crate) fn parse_bundle_bytes(bytes: &[u8]) -> Result<RomWeaverBundle> {
    let mut bundle: RomWeaverBundle = serde_json::from_slice(bytes).map_err(|error| {
        RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.parse")
                .with_message("bundle JSON is invalid")
                .with_field("detail", error.to_string()),
        )
    })?;
    validate_bundle(&mut bundle)?;
    trace!(
        version = bundle.version,
        patches = bundle.patches.len(),
        has_rom = bundle.rom.is_some(),
        has_output = bundle.output.is_some(),
        "parsed bundle"
    );
    Ok(bundle)
}

fn validate_bundle(bundle: &mut RomWeaverBundle) -> Result<()> {
    if bundle.version != BUNDLE_VERSION {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.version.unsupported")
                .with_message("unsupported bundle version")
                .with_field("found", bundle.version)
                .with_field("supported", BUNDLE_VERSION),
        ));
    }
    if bundle.patches.is_empty() {
        return Err(bundle_validation(
            "bundle.patches.empty",
            "bundle defines no patches",
        ));
    }
    if let Some(rom) = &mut bundle.rom {
        // A rom entry may be sourceless (checks/name only): the user supplies
        // the ROM themselves and the checks validate it. Patches always need
        // a source. Blank sources normalize to absent so downstream
        // `is_some()` checks are trustworthy.
        validate_source_conflict(&rom.url, &rom.path, "rom")?;
        if !has_source_value(&rom.url) {
            rom.url = None;
        }
        if !has_source_value(&rom.path) {
            rom.path = None;
        }
        validate_relative_path(&rom.path, "rom")?;
        if let Some(checks) = &mut rom.checks {
            normalize_checksum_map(&mut checks.checksums, "rom.checks")?;
        }
    }
    for (index, patch) in bundle.patches.iter_mut().enumerate() {
        let entry = format!("patches[{index}]");
        validate_source_ref(&patch.url, &patch.path, &entry)?;
        validate_relative_path(&patch.path, &entry)?;
        if let Some(checks) = &mut patch.input_checks {
            normalize_checksum_map(&mut checks.checksums, &format!("{entry}.inputChecks"))?;
        }
        if let Some(checks) = &mut patch.output_checks {
            normalize_checksum_map(&mut checks.checksums, &format!("{entry}.outputChecks"))?;
        }
    }
    if let Some(output) = &mut bundle.output
        && let Some(checks) = &mut output.checks
    {
        normalize_checksum_map(&mut checks.checksums, "output.checks")?;
    }
    Ok(())
}

/// Exactly one of `url` / `path` must carry a non-empty value.
fn validate_source_ref(url: &Option<String>, path: &Option<String>, entry: &str) -> Result<()> {
    validate_source_conflict(url, path, entry)?;
    if !(has_source_value(url) || has_source_value(path)) {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.source.missing")
                .with_message("bundle entry provides neither url nor path")
                .with_field("entry", entry),
        ));
    }
    Ok(())
}

/// At most one of `url` / `path` may carry a non-empty value.
fn validate_source_conflict(
    url: &Option<String>,
    path: &Option<String>,
    entry: &str,
) -> Result<()> {
    if has_source_value(url) && has_source_value(path) {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.source.conflict")
                .with_message("bundle entry provides both url and path")
                .with_field("entry", entry),
        ));
    }
    Ok(())
}

pub(super) fn has_source_value(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}

/// Bundle `path` values are relative references (archive members / files
/// next to the bundle) and must never escape that scope.
fn validate_relative_path(path: &Option<String>, entry: &str) -> Result<()> {
    let Some(path) = path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let invalid = path.starts_with('/')
        || path.starts_with('\\')
        || path.contains(':')
        || path.split(['/', '\\']).any(|component| component == "..");
    if invalid {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.path.invalid")
                .with_message("bundle path entries must be relative and must not traverse upward")
                .with_field("entry", entry.to_owned())
                .with_field("path", path.to_owned()),
        ));
    }
    Ok(())
}

/// Validate and normalize an `algorithm -> hex` map by routing each pair
/// through the shared `--validate-with-checksum` parser, so algorithm support
/// and hex-length rules stay single-sourced.
fn normalize_checksum_map(checksums: &mut BTreeMap<String, String>, entry: &str) -> Result<()> {
    if checksums.is_empty() {
        return Ok(());
    }
    let values: Vec<String> = checksums
        .iter()
        .map(|(algorithm, hex)| format!("{algorithm}={hex}"))
        .collect();
    let normalized = CliApp::parse_patch_apply_checksum_values(&values, "bundle checksum")
        .map_err(|error| {
            let detail = match error {
                RomWeaverError::Validation(message) => message,
                other => other.to_string(),
            };
            RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.checks.invalid")
                    .with_message("bundle checksum values are invalid")
                    .with_field("entry", entry.to_owned())
                    .with_field("detail", detail),
            )
        })?;
    *checksums = normalized;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validation_code(error: RomWeaverError) -> &'static str {
        match error {
            RomWeaverError::ValidationCode(coded) => coded.code(),
            other => panic!("expected coded validation error, got: {other}"),
        }
    }

    fn parse_err(json: &str) -> &'static str {
        validation_code(parse_bundle_bytes(json.as_bytes()).expect_err("expected parse failure"))
    }

    #[test]
    fn parses_minimal_bundle() {
        let bundle =
            parse_bundle_bytes(br#"{ "version": 1, "patches": [ { "path": "patches/x.bps" } ] }"#)
                .expect("minimal bundle parses");
        assert_eq!(bundle.version, BUNDLE_VERSION);
        assert_eq!(bundle.patches.len(), 1);
        assert!(!bundle.patches[0].optional);
        assert_eq!(bundle.patches[0].header, None);
        assert!(bundle.rom.is_none() && bundle.output.is_none());
    }

    #[test]
    fn parses_optional_and_labels() {
        let bundle = parse_bundle_bytes(
            br#"{ "version": 1, "patches": [
                { "path": "a.ips", "label": "stable" },
                { "path": "b.ips", "optional": true }
            ] }"#,
        )
        .expect("optional parses");
        assert!(!bundle.patches[0].optional);
        assert_eq!(bundle.patches[0].label.as_deref(), Some("stable"));
        assert!(bundle.patches[1].optional);
    }

    #[test]
    fn rejects_missing_version_as_parse_error() {
        assert_eq!(
            parse_err(r#"{ "patches": [ { "path": "x.ips" } ] }"#),
            "bundle.parse"
        );
    }

    #[test]
    fn rejects_unsupported_version() {
        assert_eq!(
            parse_err(r#"{ "version": 2, "patches": [ { "path": "x.ips" } ] }"#),
            "bundle.version.unsupported"
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patchez": [], "patches": [ { "path": "x.ips" } ] }"#),
            "bundle.parse"
        );
        assert_eq!(
            parse_err(
                r#"{ "version": 1, "patches": [ { "path": "x.ips", "descriptin": "typo" } ] }"#
            ),
            "bundle.parse"
        );
    }

    #[test]
    fn rejects_unknown_status_as_parse_error() {
        assert_eq!(
            parse_err(
                r#"{ "version": 1, "patches": [ { "path": "x.ips", "status": "sometimes" } ] }"#
            ),
            "bundle.parse"
        );
    }

    #[test]
    fn rejects_empty_patches() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [] }"#),
            "bundle.patches.empty"
        );
    }

    #[test]
    fn rejects_url_and_path_conflict() {
        assert_eq!(
            parse_err(
                r#"{ "version": 1,
                     "rom": { "url": "https://example.test/rom.sfc", "path": "rom.sfc" },
                     "patches": [ { "path": "x.ips" } ] }"#
            ),
            "bundle.source.conflict"
        );
    }

    #[test]
    fn rejects_missing_source_and_treats_blank_as_missing() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [ { "name": "x" } ] }"#),
            "bundle.source.missing"
        );
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [ { "url": "  " } ] }"#),
            "bundle.source.missing"
        );
    }

    #[test]
    fn accepts_sourceless_rom_with_checks() {
        let bundle = parse_bundle_bytes(
            br#"{ "version": 1,
                  "rom": { "name": "game.sfc", "checks": { "checksums": { "crc32": "aabbccdd" } } },
                  "patches": [ { "path": "x.ips" } ] }"#,
        )
        .expect("sourceless rom parses");
        let rom = bundle.rom.expect("rom");
        assert!(rom.url.is_none() && rom.path.is_none());
        assert!(rom.checks.is_some());
    }

    #[test]
    fn normalizes_checks_hex() {
        let bundle = parse_bundle_bytes(
            br#"{ "version": 1,
                  "rom": { "path": "rom.sfc", "checks": { "checksums": { "CRC32": "0xAABBCCDD" }, "size": 524288 } },
                  "patches": [ { "path": "x.ips", "inputChecks": { "checksums": { "crc32": "0XDEADBEEF" } } } ] }"#,
        )
        .expect("checks parse");
        let rom_checks = bundle.rom.expect("rom").checks.expect("checks");
        assert_eq!(
            rom_checks.checksums.get("crc32").map(String::as_str),
            Some("aabbccdd")
        );
        assert_eq!(rom_checks.size, Some(524288));
        assert_eq!(
            bundle.patches[0]
                .input_checks
                .as_ref()
                .expect("inputChecks")
                .checksums
                .get("crc32")
                .map(String::as_str),
            Some("deadbeef")
        );
    }

    #[test]
    fn rejects_invalid_checks() {
        // Wrong hex length for the algorithm.
        assert_eq!(
            parse_err(
                r#"{ "version": 1,
                     "patches": [ { "path": "x.ips", "inputChecks": { "checksums": { "crc32": "abcd" } } } ] }"#
            ),
            "bundle.checks.invalid"
        );
        // Unsupported algorithm.
        assert_eq!(
            parse_err(
                r#"{ "version": 1,
                     "patches": [ { "path": "x.ips", "outputChecks": { "checksums": { "crc99": "aabbccdd" } } } ] }"#
            ),
            "bundle.checks.invalid"
        );
    }

    #[test]
    fn round_trips_serialized_bundle() {
        let bundle = RomWeaverBundle {
            version: BUNDLE_VERSION,
            rom: Some(BundleRom {
                name: Some("Game (USA).sfc".to_owned()),
                url: Some("https://example.test/game.sfc".to_owned()),
                path: None,
                checks: Some(BundleChecks {
                    checksums: BTreeMap::from([("crc32".to_owned(), "aabbccdd".to_owned())]),
                    size: Some(1_048_576),
                }),
            }),
            patches: vec![BundlePatchEntry {
                name: Some("Main hack".to_owned()),
                description: Some("The main event".to_owned()),
                optional: true,
                label: Some("stable".to_owned()),
                url: None,
                path: Some("patches/main.bps".to_owned()),
                input_checks: Some(BundleChecks {
                    checksums: BTreeMap::from([("crc32".to_owned(), "aabbccdd".to_owned())]),
                    size: None,
                }),
                output_checks: None,
                header: Some(PatchApplyHeaderMode::Strip),
            }],
            output: Some(BundleOutput {
                name: Some("out.sfc".to_owned()),
                header: Some(PatchApplyOutputHeaderMode::Auto),
                checks: Some(BundleChecks {
                    checksums: BTreeMap::from([(
                        "sha1".to_owned(),
                        "da39a3ee5e6b4b0d3255bfef95601890afd80709".to_owned(),
                    )]),
                    size: None,
                }),
            }),
        };
        let json = serde_json::to_vec_pretty(&bundle).expect("bundle serializes");
        let parsed = parse_bundle_bytes(&json).expect("serialized bundle parses");
        assert_eq!(parsed, bundle);
    }

    #[test]
    fn serialized_bundle_omits_empty_fields() {
        let bundle = parse_bundle_bytes(br#"{ "version": 1, "patches": [ { "path": "x.ips" } ] }"#)
            .expect("minimal bundle parses");
        let json = serde_json::to_string(&bundle).expect("bundle serializes");
        assert!(
            !json.contains("\"name\""),
            "unset options must be omitted: {json}"
        );
        assert!(
            !json.contains("\"optional\""),
            "non-optional patches must omit the flag: {json}"
        );
    }

    #[test]
    fn recognizes_bundle_file_names() {
        assert_eq!(bundle_file_name_codec("rom-weaver-bundle.json"), Some(None));
        assert_eq!(bundle_file_name_codec("ROM-WEAVER-BUNDLE.JSON"), Some(None));
        assert_eq!(
            bundle_file_name_codec("rom-weaver-bundle.json.gz"),
            Some(Some("gz"))
        );
        assert_eq!(
            bundle_file_name_codec("rom-weaver-bundle.json.zst"),
            Some(Some("zst"))
        );
        assert_eq!(bundle_file_name_codec("rom-weaver-bundle.json."), None);
        assert_eq!(
            bundle_file_name_codec("rom-weaver-bundle.json.tar.gz"),
            None
        );
        assert_eq!(bundle_file_name_codec("rw.json"), None);
        assert_eq!(bundle_file_name_codec("rom-weaver-bundle.jsonx"), None);
        assert_eq!(bundle_file_name_codec("bundle.json"), None);
    }
}
