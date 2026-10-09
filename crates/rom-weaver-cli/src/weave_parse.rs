use rom_weaver_core::ValidationCodeError;

use super::*;

/// Base file name that marks a file as a rom-weaver weave.
pub(crate) const WEAVE_BASE_FILE_NAME: &str = "rom-weaver-weave.json";

/// Split a weave-shaped file name. Returns `None` when the name is not
/// weave-shaped, `Some(None)` for a plain `rom-weaver-weave.json`, and `Some(Some(ext))`
/// for `rom-weaver-weave.json.<ext>`. The caller decides whether `ext` is a supported
/// stream-codec extension (that check needs the container registry).
pub(crate) fn weave_file_name_codec(file_name: &str) -> Option<Option<&str>> {
    let bytes = file_name.as_bytes();
    for base_name in [WEAVE_BASE_FILE_NAME, "rom-weaver-bundle.json"] {
        let base = base_name.as_bytes();
        if bytes.eq_ignore_ascii_case(base) {
            return Some(None);
        }
        if bytes.len() > base.len() + 1
            && bytes[..base.len()].eq_ignore_ascii_case(base)
            && bytes[base.len()] == b'.'
        {
            let extension = &file_name[base.len() + 1..];
            if !extension.is_empty() && !extension.contains('.') {
                return Some(Some(extension));
            }
        }
    }
    None
}

/// True when a file base name is a plausible weave index to content-probe:
/// any uncompressed `*.json`. Detection is name-agnostic beyond this cheap
/// narrowing - the real gate is a successful parse+validate of the bytes, so a
/// stray `config.json` costs one parse attempt and is then skipped. The
/// canonical `rom-weaver-weave.json` is handled separately as a trusted
/// fast-path (see `weave_file_name_codec`); this only widens the fallback net.
pub(crate) fn is_weave_json_candidate(base_name: &str) -> bool {
    let bytes = base_name.as_bytes();
    bytes.len() > 5 && base_name[base_name.len() - 5..].eq_ignore_ascii_case(".json")
}

/// Whether raw bytes parse and validate as a weave. Used to content-probe
/// non-canonically-named JSON candidates before treating them as weaves.
pub(crate) fn weave_bytes_are_valid(bytes: &[u8]) -> bool {
    parse_weave_bytes(bytes).is_ok()
}

pub(crate) fn weave_validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

/// Parse and validate weave JSON bytes. Checksum maps come back normalized
/// (lowercase hex, `0x` prefixes stripped) so downstream comparisons never
/// re-normalize.
pub(crate) fn parse_weave_bytes(bytes: &[u8]) -> Result<RomWeaverWeave> {
    let mut weave: RomWeaverWeave = serde_json::from_slice(bytes).map_err(|error| {
        RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.parse")
                .with_message("weave JSON is invalid")
                .with_field("detail", error.to_string()),
        )
    })?;
    validate_weave(&mut weave)?;
    trace!(
        version = weave.version,
        patches = weave.patches.len(),
        cheats = weave.cheats.len(),
        has_rom = weave.rom.is_some(),
        has_output = weave.output.is_some(),
        "parsed weave"
    );
    Ok(weave)
}

fn validate_weave(weave: &mut RomWeaverWeave) -> Result<()> {
    if !matches!(weave.version, 1 | WEAVE_VERSION) {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.version.unsupported")
                .with_message("unsupported weave version")
                .with_field("found", weave.version)
                .with_field("supported", WEAVE_VERSION),
        ));
    }
    match weave.version {
        1 if weave.patch_basis.is_some() => {
            return Err(weave_validation(
                "bundle.patch_basis.unsupported",
                "version 1 weaves cannot declare patchBasis",
            ));
        }
        WEAVE_VERSION if weave.patch_basis.is_none() => {
            return Err(weave_validation(
                "bundle.patch_basis.missing",
                "version 2 weaves must declare patchBasis",
            ));
        }
        _ => {}
    }
    if weave.patches.is_empty() && weave.cheats.is_empty() {
        return Err(weave_validation(
            "bundle.patches.empty",
            "weave defines no patches and no cheats",
        ));
    }
    let mut check_states = BTreeSet::new();
    for (index, state) in weave.check_states.iter_mut().enumerate() {
        let id = state.id.trim();
        if id.is_empty() {
            return Err(weave_validation(
                "bundle.check_state.id.empty",
                "weave checkStates entries need a non-empty id",
            ));
        }
        if !check_states.insert(id.to_owned()) {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.check_state.id.duplicate")
                    .with_message("weave checkStates IDs must be unique")
                    .with_field("id", id.to_owned()),
            ));
        }
        state.id = id.to_owned();
        normalize_checksum_map(
            &mut state.checks.checksums,
            &format!("checkStates[{index}].checks"),
        )?;
        if state.checks.checksums.is_empty() && state.checks.size.is_none() {
            return Err(weave_validation(
                "bundle.check_state.checks.empty",
                "weave checkStates entries need checksums or a size",
            ));
        }
    }
    if let Some(rom) = &mut weave.rom {
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
        validate_check_reference(&rom.checks, &rom.checks_ref, &check_states, "rom.checksRef")?;
        normalize_member(&mut rom.member, "rom.member")?;
    }
    let mut patch_ids = BTreeSet::new();
    for patch in &mut weave.patches {
        let id = patch.id.take().map(|id| id.trim().to_owned());
        patch.id = id.filter(|id| !id.is_empty());
        if let Some(id) = patch.id.as_deref()
            && !patch_ids.insert(id.to_owned())
        {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.patch.id.duplicate")
                    .with_message("weave patch IDs must be unique when target references use them")
                    .with_field("id", id.to_owned()),
            ));
        }
    }
    let mut prior_patch_ids = BTreeSet::new();
    for (index, patch) in weave.patches.iter_mut().enumerate() {
        let entry = format!("patches[{index}]");
        validate_source_ref(&patch.url, &patch.path, &entry)?;
        validate_relative_path(&patch.path, &entry)?;
        if let Some(checks) = &mut patch.input_checks {
            normalize_checksum_map(&mut checks.checksums, &format!("{entry}.inputChecks"))?;
        }
        if let Some(checks) = &mut patch.output_checks {
            normalize_checksum_map(&mut checks.checksums, &format!("{entry}.outputChecks"))?;
        }
        validate_check_reference(
            &patch.input_checks,
            &patch.input_checks_ref,
            &check_states,
            &format!("{entry}.inputChecksRef"),
        )?;
        validate_check_reference(
            &patch.output_checks,
            &patch.output_checks_ref,
            &check_states,
            &format!("{entry}.outputChecksRef"),
        )?;
        for (selector_name, selector) in
            [("input", &mut patch.input), ("target", &mut patch.target)]
        {
            let Some(input) = selector else {
                continue;
            };
            match input {
                WeavePatchInput::Rom { rom, member } => {
                    if !*rom {
                        return Err(weave_validation(
                            if selector_name == "input" {
                                "bundle.patch.input.rom.invalid"
                            } else {
                                "bundle.patch.target.rom.invalid"
                            },
                            "patch input or target rom must be true",
                        ));
                    }
                    normalize_member(member, &format!("{entry}.{selector_name}.member"))?;
                }
                WeavePatchInput::Patch {
                    patch: producer,
                    member,
                } => {
                    let producer_id = producer.trim().to_owned();
                    if producer_id.is_empty() || !prior_patch_ids.contains(&producer_id) {
                        return Err(RomWeaverError::ValidationCode(
                            ValidationCodeError::new(if selector_name == "input" {
                                "bundle.patch.input.patch.unresolved"
                            } else {
                                "bundle.patch.target.patch.unresolved"
                            })
                            .with_message(
                                "patch selector must reference an earlier patch with a stable id",
                            )
                            .with_field("entry", entry)
                            .with_field("patch", producer_id),
                        ));
                    }
                    *producer = producer_id;
                    normalize_member(member, &format!("{entry}.{selector_name}.member"))?;
                }
            }
        }
        if let Some(id) = patch
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            prior_patch_ids.insert(id.to_owned());
        }
    }
    for (index, cheat) in weave.cheats.iter().enumerate() {
        if cheat.id.trim().is_empty() {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.cheat.id.missing")
                    .with_message("weave cheat entry has an empty id")
                    .with_field("entry", format!("cheats[{index}]")),
            ));
        }
    }
    if let Some(output) = &mut weave.output {
        if let Some(checks) = &mut output.checks {
            normalize_checksum_map(&mut checks.checksums, "output.checks")?;
        }
        validate_check_reference(
            &output.checks,
            &output.checks_ref,
            &check_states,
            "output.checksRef",
        )?;
    }
    Ok(())
}

fn validate_check_reference(
    inline: &Option<WeaveChecks>,
    reference: &Option<String>,
    states: &BTreeSet<String>,
    entry: &str,
) -> Result<()> {
    let Some(reference) = reference else {
        return Ok(());
    };
    let reference = reference.trim();
    if inline.is_some() {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.checks.reference.conflict")
                .with_message("a checks reference cannot also carry inline checks")
                .with_field("entry", entry.to_owned()),
        ));
    }
    if reference.is_empty() || !states.contains(reference) {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.checks.reference.unresolved")
                .with_message("checks reference matches no weave checkStates id")
                .with_field("entry", entry.to_owned())
                .with_field("ref", reference.to_owned()),
        ));
    }
    Ok(())
}

fn normalize_member(member: &mut Option<String>, entry: &str) -> Result<()> {
    if let Some(value) = member {
        *value = normalized_member_path(value, entry)?;
    }
    Ok(())
}

pub(super) fn normalized_member_path(value: &str, entry: &str) -> Result<String> {
    let value = value.trim().replace('\\', "/");
    if value.is_empty()
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
        || value.contains('\0')
        || value.split('/').any(|part| part == "..")
        || value.split('/').all(|part| part.is_empty() || part == ".")
    {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.member.invalid")
                .with_message("weave member selectors must be non-empty relative paths")
                .with_field("entry", entry.to_owned()),
        ));
    }
    Ok(value
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/"))
}

/// Exactly one of `url` / `path` must carry a non-empty value.
fn validate_source_ref(url: &Option<String>, path: &Option<String>, entry: &str) -> Result<()> {
    validate_source_conflict(url, path, entry)?;
    if !(has_source_value(url) || has_source_value(path)) {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.source.missing")
                .with_message("weave entry provides neither url nor path")
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
                .with_message("weave entry provides both url and path")
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

/// Weave `path` values are relative references (archive members / files
/// next to the weave) and must never escape that scope.
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
                .with_message("weave path entries must be relative and must not traverse upward")
                .with_field("entry", entry.to_owned())
                .with_field("path", path.to_owned()),
        ));
    }
    Ok(())
}

/// Validate and normalize an `algorithm -> hex` map by routing each pair
/// through the shared `--expect-in` parser, so algorithm support
/// and hex-length rules stay single-sourced.
fn normalize_checksum_map(checksums: &mut BTreeMap<String, String>, entry: &str) -> Result<()> {
    if checksums.is_empty() {
        return Ok(());
    }
    let values: Vec<String> = checksums
        .iter()
        .map(|(algorithm, hex)| format!("{algorithm}={hex}"))
        .collect();
    let normalized =
        CliApp::parse_patch_apply_checksum_values(&values, "weave checksum").map_err(|error| {
            let detail = match error {
                RomWeaverError::Validation(message) => message,
                other => other.to_string(),
            };
            RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.checks.invalid")
                    .with_message("weave checksum values are invalid")
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
    use crate::weave_schema::WeaveCheatEntry;

    fn validation_code(error: RomWeaverError) -> String {
        match error {
            RomWeaverError::ValidationCode(coded) => coded.code().to_owned(),
            other => panic!("expected coded validation error, got: {other}"),
        }
    }

    fn parse_err(json: &str) -> String {
        validation_code(parse_weave_bytes(json.as_bytes()).expect_err("expected parse failure"))
    }

    #[test]
    fn parses_minimal_weave() {
        let weave =
            parse_weave_bytes(br#"{ "version": 1, "patches": [ { "path": "patches/x.bps" } ] }"#)
                .expect("minimal weave parses");
        assert_eq!(weave.version, 1);
        assert_eq!(weave.patches.len(), 1);
        assert!(!weave.patches[0].optional);
        assert_eq!(weave.patches[0].header, None);
        assert_eq!(weave.patches[0].basis, None);
        assert!(weave.rom.is_none() && weave.output.is_none());
    }

    #[test]
    fn parses_v1_version_with_basis() {
        let weave = parse_weave_bytes(
            br#"{ "version": 1, "patches": [
                { "path": "a.ips", "basis": "base" },
                { "path": "b.ips", "basis": "previous" },
                { "path": "c.ips" }
            ] }"#,
        )
        .expect("v1 weave parses");
        assert_eq!(weave.version, 1);
        assert_eq!(weave.patches[0].basis, Some(PatchInputBasis::Base));
        assert_eq!(weave.patches[1].basis, Some(PatchInputBasis::Previous));
        assert_eq!(weave.patches[2].basis, None);
    }

    #[test]
    fn parses_v1_patch_slot_metadata() {
        let weave = parse_weave_bytes(
            br#"{ "version": 1, "patches": [ { "id": "main", "version": "1.4.0", "author": "Weaver", "path": "main.bps" } ] }"#,
        )
        .expect("v1 weave parses");
        assert_eq!(weave.version, 1);
        assert_eq!(weave.patches[0].id.as_deref(), Some("main"));
        assert_eq!(weave.patches[0].version.as_deref(), Some("1.4.0"));
        assert_eq!(weave.patches[0].author.as_deref(), Some("Weaver"));
    }

    #[test]
    fn parses_v2_shared_patch_basis() {
        let weave = parse_weave_bytes(
            br#"{ "version": 2, "patchBasis": "previous", "patches": [ { "path": "a.ips" } ] }"#,
        )
        .expect("v2 weave parses");
        assert_eq!(weave.version, WEAVE_VERSION);
        assert_eq!(weave.patch_basis, Some(PatchBasisMode::Previous));
    }

    #[test]
    fn parses_explicit_execution_targets_and_shared_check_states() {
        let weave = parse_weave_bytes(
            br#"{
                "version": 2,
                "patchBasis": "base",
                "checkStates": [
                    { "id": "rom", "checks": { "checksums": { "crc32": "aabbccdd" } } },
                    { "id": "patch:translation:output", "checks": { "size": 8 } }
                ],
                "rom": { "path": "game.zip", "member": "disc/track01.bin", "checksRef": "rom" },
                "patches": [
                    { "id": "translation", "path": "translation.ips", "input": { "rom": true, "member": "disc/track01.bin" }, "outputChecksRef": "patch:translation:output" },
                    { "id": "fix", "path": "fix.ips", "input": { "patch": "translation" }, "inputChecksRef": "patch:translation:output" }
                ],
                "output": { "checksRef": "patch:translation:output" }
            }"#,
        )
        .expect("weave parses");
        assert_eq!(weave.check_states.len(), 2);
        assert_eq!(
            weave.rom.and_then(|rom| rom.member).as_deref(),
            Some("disc/track01.bin")
        );
        assert!(matches!(
            weave.patches[1].input,
            Some(WeavePatchInput::Patch { ref patch, member: None }) if patch == "translation"
        ));
        assert_eq!(
            weave.patches[1].input_checks_ref.as_deref(),
            Some("patch:translation:output")
        );
    }

    #[test]
    fn rejects_later_execution_producer() {
        assert_eq!(
            parse_err(
                r#"{ "version": 2, "patchBasis": "previous", "patches": [
                    { "id": "fix", "path": "fix.ips", "input": { "patch": "translation" } },
                    { "id": "translation", "path": "translation.ips" }
                ] }"#
            ),
            "bundle.patch.input.patch.unresolved"
        );
    }

    #[test]
    fn rejects_patch_basis_on_v1_and_missing_patch_basis_on_v2() {
        assert_eq!(
            parse_err(
                r#"{ "version": 1, "patchBasis": "base", "patches": [ { "path": "x.ips" } ] }"#
            ),
            "bundle.patch_basis.unsupported"
        );
        assert_eq!(
            parse_err(r#"{ "version": 2, "patches": [ { "path": "x.ips" } ] }"#),
            "bundle.patch_basis.missing"
        );
    }

    #[test]
    fn basis_round_trips_and_omits_previous_default() {
        let weave = parse_weave_bytes(
            br#"{ "version": 1, "patches": [ { "path": "a.ips", "basis": "base" } ] }"#,
        )
        .expect("v1 weave parses");
        let rendered = serde_json::to_string(&weave).expect("serializes");
        assert!(rendered.contains(r#""basis":"base""#));
        let reparsed = parse_weave_bytes(rendered.as_bytes()).expect("round trip");
        assert_eq!(reparsed.patches[0].basis, Some(PatchInputBasis::Base));
    }

    #[test]
    fn rejects_invalid_basis_value() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [ { "path": "x.ips", "basis": "root" } ] }"#),
            "bundle.parse"
        );
    }

    #[test]
    fn parses_optional_and_labels() {
        let weave = parse_weave_bytes(
            br#"{ "version": 1, "patches": [
                { "path": "a.ips", "label": "stable" },
                { "path": "b.ips", "optional": true }
            ] }"#,
        )
        .expect("optional parses");
        assert!(!weave.patches[0].optional);
        assert_eq!(weave.patches[0].label.as_deref(), Some("stable"));
        assert!(weave.patches[1].optional);
    }

    #[test]
    fn parses_cheats_with_defaults() {
        let weave = parse_weave_bytes(
            br#"{ "version": 1, "patches": [ { "path": "a.ips" } ], "cheats": [
                { "id": "cheat_rom" },
                { "id": "cheat_two", "optional": true,
                  "source": "libretro-database", "revision": "abc123",
                  "description": "High score", "code": "0025:63" }
            ] }"#,
        )
        .expect("a weave carrying cheats parses");
        assert_eq!(weave.cheats.len(), 2);
        assert!(!weave.cheats[0].optional);
        assert!(weave.cheats[0].code.is_none());
        assert!(weave.cheats[1].optional);
        assert_eq!(weave.cheats[1].source.as_deref(), Some("libretro-database"));
        assert_eq!(weave.cheats[1].revision.as_deref(), Some("abc123"));
        assert_eq!(weave.cheats[1].code.as_deref(), Some("0025:63"));
    }

    // A weave without `cheats` keeps the empty default, and re-serializing it
    // must not introduce the key: older readers reject unknown fields.
    #[test]
    fn omits_empty_cheats_on_serialization() {
        let weave = parse_weave_bytes(br#"{ "version": 1, "patches": [ { "path": "a.ips" } ] }"#)
            .expect("weave parses");
        assert!(weave.cheats.is_empty());
        let rendered = serde_json::to_string(&weave).expect("serializes");
        assert!(!rendered.contains("cheats"), "{rendered}");
    }

    #[test]
    fn accepts_a_cheats_only_weave_but_not_an_empty_one() {
        let weave =
            parse_weave_bytes(br#"{ "version": 1, "patches": [], "cheats": [ { "id": "c" } ] }"#)
                .expect("a cheats-only weave parses");
        assert!(weave.patches.is_empty());
        assert_eq!(weave.cheats.len(), 1);
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [], "cheats": [] }"#),
            "bundle.patches.empty"
        );
    }

    #[test]
    fn rejects_cheat_entries_that_name_nothing() {
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [], "cheats": [ { "id": " " } ] }"#),
            "bundle.cheat.id.missing"
        );
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [], "cheats": [ {} ] }"#),
            "bundle.parse"
        );
        assert_eq!(
            parse_err(r#"{ "version": 1, "patches": [], "cheats": [ { "id": "c", "who": 1 } ] }"#),
            "bundle.parse"
        );
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
        for version in [3, 4] {
            assert_eq!(
                parse_err(&format!(
                    r#"{{ "version": {version}, "patches": [ {{ "path": "x.ips" }} ] }}"#
                )),
                "bundle.version.unsupported"
            );
        }
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
        let weave = parse_weave_bytes(
            br#"{ "version": 1,
                  "rom": { "name": "game.sfc", "checks": { "checksums": { "crc32": "aabbccdd" } } },
                  "patches": [ { "path": "x.ips" } ] }"#,
        )
        .expect("sourceless rom parses");
        let rom = weave.rom.expect("rom");
        assert!(rom.url.is_none() && rom.path.is_none());
        assert!(rom.checks.is_some());
    }

    #[test]
    fn normalizes_checks_hex() {
        let weave = parse_weave_bytes(
            br#"{ "version": 1,
                  "rom": { "path": "rom.sfc", "checks": { "checksums": { "CRC32": "0xAABBCCDD" }, "size": 524288 } },
                  "patches": [ { "path": "x.ips", "inputChecks": { "checksums": { "crc32": "0XDEADBEEF" } } } ] }"#,
        )
        .expect("checks parse");
        let rom_checks = weave.rom.expect("rom").checks.expect("checks");
        assert_eq!(
            rom_checks.checksums.get("crc32").map(String::as_str),
            Some("aabbccdd")
        );
        assert_eq!(rom_checks.size, Some(524288));
        assert_eq!(
            weave.patches[0]
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
    fn round_trips_serialized_weave() {
        let weave = RomWeaverWeave {
            schema: None,
            version: WEAVE_VERSION,
            patch_basis: Some(PatchBasisMode::Base),
            check_states: Vec::new(),
            rom: Some(WeaveRom {
                name: Some("Game (USA).sfc".to_owned()),
                url: Some("https://example.test/game.sfc".to_owned()),
                path: None,
                member: None,
                checks: Some(WeaveChecks {
                    checksums: BTreeMap::from([("crc32".to_owned(), "aabbccdd".to_owned())]),
                    size: Some(1_048_576),
                }),
                checks_ref: None,
            }),
            patches: vec![WeavePatchEntry {
                id: Some("main".to_owned()),
                version: Some("1.0.0".to_owned()),
                author: Some("Weaver".to_owned()),
                name: Some("Main hack".to_owned()),
                description: Some("The main event".to_owned()),
                optional: true,
                label: Some("stable".to_owned()),
                url: None,
                path: Some("patches/main.bps".to_owned()),
                input: None,
                target: None,
                input_checks: Some(WeaveChecks {
                    checksums: BTreeMap::from([("crc32".to_owned(), "aabbccdd".to_owned())]),
                    size: None,
                }),
                input_checks_ref: None,
                output_checks: None,
                output_checks_ref: None,
                header: Some(PatchApplyHeaderMode::Strip),
                basis: Some(PatchInputBasis::Base),
            }],
            cheats: vec![WeaveCheatEntry {
                id: "cheat_rom".to_owned(),
                source: Some("libretro-database".to_owned()),
                revision: Some("abc123".to_owned()),
                description: Some("Infinite lives".to_owned()),
                code: Some("AKE-LVS".to_owned()),
                code_kind: None,
                optional: true,
            }],
            output: Some(WeaveOutput {
                name: Some("out.sfc".to_owned()),
                header: Some(PatchApplyOutputHeaderMode::Auto),
                checks: Some(WeaveChecks {
                    checksums: BTreeMap::from([(
                        "sha1".to_owned(),
                        "da39a3ee5e6b4b0d3255bfef95601890afd80709".to_owned(),
                    )]),
                    size: None,
                }),
                checks_ref: None,
            }),
        };
        let json = serde_json::to_vec_pretty(&weave).expect("weave serializes");
        let parsed = parse_weave_bytes(&json).expect("serialized weave parses");
        assert_eq!(parsed, weave);
    }

    #[test]
    fn serialized_weave_omits_empty_fields() {
        let weave = parse_weave_bytes(br#"{ "version": 1, "patches": [ { "path": "x.ips" } ] }"#)
            .expect("minimal weave parses");
        let json = serde_json::to_string(&weave).expect("weave serializes");
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
    fn recognizes_weave_file_names() {
        for name in ["rom-weaver-bundle.json", "ROM-WEAVER-BUNDLE.JSON"] {
            assert_eq!(weave_file_name_codec(name), Some(None));
        }
        for name in ["rom-weaver-bundle.json.gz", "ROM-WEAVER-BUNDLE.JSON.GZ"] {
            assert_eq!(
                weave_file_name_codec(name),
                Some(Some(&name[name.len() - 2..]))
            );
        }
        assert_eq!(weave_file_name_codec("rom-weaver-weave.json"), Some(None));
        assert_eq!(weave_file_name_codec("ROM-WEAVER-WEAVE.JSON"), Some(None));
        assert_eq!(
            weave_file_name_codec("rom-weaver-weave.json.gz"),
            Some(Some("gz"))
        );
        assert_eq!(
            weave_file_name_codec("rom-weaver-weave.json.zst"),
            Some(Some("zst"))
        );
        assert_eq!(weave_file_name_codec("rom-weaver-weave.json."), None);
        assert_eq!(weave_file_name_codec("rom-weaver-weave.json.tar.gz"), None);
        assert_eq!(weave_file_name_codec("rw.json"), None);
        assert_eq!(weave_file_name_codec("rom-weaver-weave.jsonx"), None);
        assert_eq!(weave_file_name_codec("weave.json"), None);
    }

    #[test]
    fn recognizes_json_probe_candidates() {
        assert!(is_weave_json_candidate("rw.json"));
        assert!(is_weave_json_candidate("weave.json"));
        assert!(is_weave_json_candidate("ANYTHING.JSON"));
        assert!(is_weave_json_candidate("rom-weaver-weave.json"));
        assert!(!is_weave_json_candidate(".json"));
        assert!(!is_weave_json_candidate("notes.txt"));
        assert!(!is_weave_json_candidate("rw.json.gz"));
        assert!(!is_weave_json_candidate("patch.ips"));
    }

    #[test]
    fn probes_weave_bytes_validity() {
        assert!(weave_bytes_are_valid(
            br#"{ "version": 1, "patches": [ { "path": "x.ips" } ] }"#
        ));
        // A well-formed JSON object that is not a weave must be rejected.
        assert!(!weave_bytes_are_valid(br#"{ "hello": "world" }"#));
        // Wrong schema version is not a weave we accept.
        assert!(!weave_bytes_are_valid(
            br#"{ "version": 999, "patches": [] }"#
        ));
        assert!(!weave_bytes_are_valid(b"not json at all"));
    }
}
