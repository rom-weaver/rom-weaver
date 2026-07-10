use rom_weaver_core::ValidationCodeError;

use super::*;

/// Base file name that marks a file as a rom-weaver manifest.
pub(crate) const MANIFEST_BASE_FILE_NAME: &str = "rw.json";

/// Split a manifest-shaped file name. Returns `None` when the name is not
/// manifest-shaped, `Some(None)` for a plain `rw.json`, and `Some(Some(ext))`
/// for `rw.json.<ext>`. The caller decides whether `ext` is a supported
/// stream-codec extension (that check needs the container registry).
pub(crate) fn manifest_file_name_codec(file_name: &str) -> Option<Option<&str>> {
    let base = MANIFEST_BASE_FILE_NAME.as_bytes();
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

pub(crate) fn manifest_validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

/// Parse and validate manifest JSON bytes. Checksum maps come back normalized
/// (lowercase hex, `0x` prefixes stripped) so downstream comparisons never
/// re-normalize.
pub(crate) fn parse_manifest_bytes(bytes: &[u8]) -> Result<RomWeaverManifest> {
    let mut manifest: RomWeaverManifest = serde_json::from_slice(bytes).map_err(|error| {
        RomWeaverError::ValidationCode(
            ValidationCodeError::new("manifest.parse")
                .with_message("manifest JSON is invalid")
                .with_field("detail", error.to_string()),
        )
    })?;
    validate_manifest(&mut manifest)?;
    trace!(
        version = manifest.version,
        patches = manifest.patches.len(),
        has_rom = manifest.rom.is_some(),
        has_output = manifest.output.is_some(),
        "parsed manifest"
    );
    Ok(manifest)
}

fn validate_manifest(manifest: &mut RomWeaverManifest) -> Result<()> {
    if manifest.version != MANIFEST_VERSION {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("manifest.version.unsupported")
                .with_message("unsupported manifest version")
                .with_field("found", manifest.version)
                .with_field("supported", MANIFEST_VERSION),
        ));
    }
    if manifest.patches.is_empty() {
        return Err(manifest_validation(
            "manifest.patches.empty",
            "manifest defines no patches",
        ));
    }
    if let Some(rom) = &mut manifest.rom {
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
    for (index, patch) in manifest.patches.iter_mut().enumerate() {
        let entry = format!("patches[{index}]");
        validate_source_ref(&patch.url, &patch.path, &entry)?;
        validate_relative_path(&patch.path, &entry)?;
        if let Some(checks) = &mut patch.checks {
            normalize_checksum_map(&mut checks.checksums, &format!("{entry}.checks"))?;
        }
        normalize_checksum_map(&mut patch.integrity, &format!("{entry}.integrity"))?;
    }
    if let Some(output) = &manifest.output
        && matches!(output.compress, Some(ManifestCompress::Disabled(true)))
    {
        return Err(manifest_validation(
            "manifest.compress.invalid",
            "manifest output.compress must be false or a compression settings object",
        ));
    }
    Ok(())
}

/// Exactly one of `url` / `path` must carry a non-empty value.
fn validate_source_ref(url: &Option<String>, path: &Option<String>, entry: &str) -> Result<()> {
    validate_source_conflict(url, path, entry)?;
    if !(has_source_value(url) || has_source_value(path)) {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("manifest.source.missing")
                .with_message("manifest entry provides neither url nor path")
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
            ValidationCodeError::new("manifest.source.conflict")
                .with_message("manifest entry provides both url and path")
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

/// Manifest `path` values are relative references (archive members / files
/// next to the manifest) and must never escape that scope.
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
            ValidationCodeError::new("manifest.path.invalid")
                .with_message("manifest path entries must be relative and must not traverse upward")
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
    let normalized = CliApp::parse_patch_apply_checksum_values(&values, "manifest checksum")
        .map_err(|error| {
            let detail = match error {
                RomWeaverError::Validation(message) => message,
                other => other.to_string(),
            };
            RomWeaverError::ValidationCode(
                ValidationCodeError::new("manifest.checks.invalid")
                    .with_message("manifest checksum values are invalid")
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
        validation_code(parse_manifest_bytes(json.as_bytes()).expect_err("expected parse failure"))
    }

    #[test]
    fn parses_minimal_manifest() {
        let manifest = parse_manifest_bytes(
            br#"{ "version": 1, "patches": [ { "path": "patches/x.bps" } ] }"#,
        )
        .expect("minimal manifest parses");
        assert_eq!(manifest.version, MANIFEST_VERSION);
        assert_eq!(manifest.patches.len(), 1);
        assert_eq!(manifest.patches[0].status, ManifestPatchStatus::Default);
        assert_eq!(manifest.patches[0].header, None);
        assert!(manifest.rom.is_none() && manifest.output.is_none());
    }

    #[test]
    fn parses_statuses_and_labels() {
        let manifest = parse_manifest_bytes(
            br#"{ "version": 1, "patches": [
                { "path": "a.ips", "status": "required", "label": "stable" },
                { "path": "b.ips", "status": "optional" },
                { "path": "c.ips", "status": "disabled" }
            ] }"#,
        )
        .expect("statuses parse");
        assert_eq!(manifest.patches[0].status, ManifestPatchStatus::Required);
        assert_eq!(manifest.patches[0].label.as_deref(), Some("stable"));
        assert_eq!(manifest.patches[1].status, ManifestPatchStatus::Optional);
        assert_eq!(manifest.patches[2].status, ManifestPatchStatus::Disabled);
    }

    #[test]
    fn rejects_missing_version_as_parse_error() {
        assert_eq!(
            parse_err(r#"{ "patches": [ { "path": "x.ips" } ] }"#),
            "manifest.parse"
        );
    }

    #[test]
    fn rejects_unsupported_version() {
        assert_eq!(
            parse_err(r#"{ "version": 2, "patches": [ { "path": "x.ips" } ] }"#),
            "manifest.version.unsupported"
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patchez": [], "patches": [ { "path": "x.ips" } ] }"#),
            "manifest.parse"
        );
        assert_eq!(
            parse_err(
                r#"{ "version": 1, "patches": [ { "path": "x.ips", "descriptin": "typo" } ] }"#
            ),
            "manifest.parse"
        );
    }

    #[test]
    fn rejects_unknown_status_as_parse_error() {
        assert_eq!(
            parse_err(
                r#"{ "version": 1, "patches": [ { "path": "x.ips", "status": "sometimes" } ] }"#
            ),
            "manifest.parse"
        );
    }

    #[test]
    fn rejects_empty_patches() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [] }"#),
            "manifest.patches.empty"
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
            "manifest.source.conflict"
        );
    }

    #[test]
    fn rejects_missing_source_and_treats_blank_as_missing() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [ { "name": "x" } ] }"#),
            "manifest.source.missing"
        );
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [ { "url": "  " } ] }"#),
            "manifest.source.missing"
        );
    }

    #[test]
    fn accepts_sourceless_rom_with_checks() {
        let manifest = parse_manifest_bytes(
            br#"{ "version": 1,
                  "rom": { "name": "game.sfc", "checks": { "checksums": { "crc32": "aabbccdd" } } },
                  "patches": [ { "path": "x.ips" } ] }"#,
        )
        .expect("sourceless rom parses");
        let rom = manifest.rom.expect("rom");
        assert!(rom.url.is_none() && rom.path.is_none());
        assert!(rom.checks.is_some());
    }

    #[test]
    fn normalizes_checks_and_integrity_hex() {
        let manifest = parse_manifest_bytes(
            br#"{ "version": 1,
                  "rom": { "path": "rom.sfc", "checks": { "checksums": { "CRC32": "0xAABBCCDD" }, "size": 524288 } },
                  "patches": [ { "path": "x.ips", "integrity": { "crc32": "0XDEADBEEF" } } ] }"#,
        )
        .expect("checks parse");
        let rom_checks = manifest.rom.expect("rom").checks.expect("checks");
        assert_eq!(
            rom_checks.checksums.get("crc32").map(String::as_str),
            Some("aabbccdd")
        );
        assert_eq!(rom_checks.size, Some(524288));
        assert_eq!(
            manifest.patches[0]
                .integrity
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
                     "patches": [ { "path": "x.ips", "checks": { "checksums": { "crc32": "abcd" } } } ] }"#
            ),
            "manifest.checks.invalid"
        );
        // Unsupported algorithm.
        assert_eq!(
            parse_err(
                r#"{ "version": 1,
                     "patches": [ { "path": "x.ips", "checks": { "checksums": { "crc99": "aabbccdd" } } } ] }"#
            ),
            "manifest.checks.invalid"
        );
    }

    #[test]
    fn parses_output_compress_variants() {
        let disabled = parse_manifest_bytes(
            br#"{ "version": 1, "patches": [ { "path": "x.ips" } ],
                  "output": { "compress": false } }"#,
        )
        .expect("compress false parses");
        assert_eq!(
            disabled.output.expect("output").compress,
            Some(ManifestCompress::Disabled(false))
        );

        let settings = parse_manifest_bytes(
            br#"{ "version": 1, "patches": [ { "path": "x.ips" } ],
                  "output": { "name": "out.sfc", "header": "keep",
                              "compress": { "format": "zip", "codecs": ["deflate:9"], "level": "max" } } }"#,
        )
        .expect("compress settings parse");
        let output = settings.output.expect("output");
        assert_eq!(output.name.as_deref(), Some("out.sfc"));
        assert_eq!(output.header, Some(PatchApplyOutputHeaderMode::Keep));
        let Some(ManifestCompress::Settings(compress)) = output.compress else {
            panic!("expected compress settings");
        };
        assert_eq!(compress.format.as_deref(), Some("zip"));
        assert_eq!(compress.codecs, vec!["deflate:9".to_string()]);
        assert_eq!(compress.level, Some(CompressionLevelProfile::Max));
    }

    #[test]
    fn rejects_compress_true() {
        assert_eq!(
            parse_err(
                r#"{ "version": 1, "patches": [ { "path": "x.ips" } ],
                     "output": { "compress": true } }"#
            ),
            "manifest.compress.invalid"
        );
    }

    #[test]
    fn round_trips_serialized_manifest() {
        let manifest = RomWeaverManifest {
            version: MANIFEST_VERSION,
            name: Some("Example Pack".to_owned()),
            description: None,
            rom: Some(ManifestRom {
                name: Some("Game (USA).sfc".to_owned()),
                url: Some("https://example.test/game.sfc".to_owned()),
                path: None,
                checks: Some(ManifestChecks {
                    checksums: BTreeMap::from([("crc32".to_owned(), "aabbccdd".to_owned())]),
                    size: Some(1_048_576),
                }),
            }),
            patches: vec![ManifestPatchEntry {
                name: Some("Main hack".to_owned()),
                description: Some("The main event".to_owned()),
                status: ManifestPatchStatus::Required,
                label: Some("stable".to_owned()),
                url: None,
                path: Some("patches/main.bps".to_owned()),
                checks: None,
                integrity: BTreeMap::from([("crc32".to_owned(), "deadbeef".to_owned())]),
                header: Some(PatchApplyHeaderMode::Strip),
            }],
            output: Some(ManifestOutput {
                name: Some("out.sfc".to_owned()),
                header: Some(PatchApplyOutputHeaderMode::Auto),
                compress: Some(ManifestCompress::Settings(ManifestCompressSettings {
                    format: Some("zip".to_owned()),
                    codecs: Vec::new(),
                    level: Some(CompressionLevelProfile::Max),
                })),
            }),
        };
        let json = serde_json::to_vec_pretty(&manifest).expect("manifest serializes");
        let parsed = parse_manifest_bytes(&json).expect("serialized manifest parses");
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn serialized_manifest_omits_empty_fields() {
        let manifest =
            parse_manifest_bytes(br#"{ "version": 1, "patches": [ { "path": "x.ips" } ] }"#)
                .expect("minimal manifest parses");
        let json = serde_json::to_string(&manifest).expect("manifest serializes");
        assert!(
            !json.contains("\"name\""),
            "unset options must be omitted: {json}"
        );
        assert!(
            !json.contains("\"integrity\""),
            "empty maps must be omitted: {json}"
        );
    }

    #[test]
    fn recognizes_manifest_file_names() {
        assert_eq!(manifest_file_name_codec("rw.json"), Some(None));
        assert_eq!(manifest_file_name_codec("RW.JSON"), Some(None));
        assert_eq!(manifest_file_name_codec("rw.json.gz"), Some(Some("gz")));
        assert_eq!(manifest_file_name_codec("rw.json.zst"), Some(Some("zst")));
        assert_eq!(manifest_file_name_codec("rw.json."), None);
        assert_eq!(manifest_file_name_codec("rw.json.tar.gz"), None);
        assert_eq!(manifest_file_name_codec("notrw.json"), None);
        assert_eq!(manifest_file_name_codec("rw.jsonx"), None);
        assert_eq!(manifest_file_name_codec("manifest.json"), None);
    }
}
