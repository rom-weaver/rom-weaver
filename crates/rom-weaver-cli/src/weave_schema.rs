use super::*;

/// Version of the public `rom-weaver-weave.json` weave schema this build
/// writes.
pub const WEAVE_VERSION: u32 = 2;

/// The JSON Schema for `rom-weaver-weave.json`, embedded from the copy shipped
/// with this crate. A workspace test below keeps it byte-for-byte aligned with
/// the canonical docs copy.
/// Editors can bind it via a `$schema` key (accepted on read) or the published
/// URL in its `$id`.
pub const WEAVE_JSON_SCHEMA: &str = include_str!("../rom-weaver-weave-v2.schema.json");
#[cfg(test)]
pub const WEAVE_JSON_SCHEMA_V1: &str = include_str!("../rom-weaver-weave-v1.schema.json");

/// Published, resolvable location of [`WEAVE_JSON_SCHEMA`] (matches its `$id`).
pub const WEAVE_JSON_SCHEMA_URL: &str = "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-weave-v2.schema.json";
#[cfg(not(target_arch = "wasm32"))]
pub const WEAVE_JSON_SCHEMA_V1_URL: &str = "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-weave-v1.schema.json";

/// A distributable ordered patch workflow with optional ROM, selection seed,
/// endpoint checks, sources, and output defaults. Sources are URLs or
/// weave-relative paths; CLI flags and webapp edits override defaults.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RomWeaverWeave {
    /// Optional JSON Schema reference so editors bind autocomplete/validation
    /// when a weave is hand-authored. A named field satisfies
    /// `deny_unknown_fields` (an unknown `$schema` key would otherwise fail
    /// parse); the value is preserved verbatim through `weave create --from`
    /// but never auto-injected by create (keeps emitted bytes stable). First
    /// field so it serializes at the top, the conventional position.
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, rename = "$schema"))]
    pub schema: Option<String>,
    pub version: u32,
    /// Shared input-basis declaration for the chain. Version 2 requires this
    /// value; version 1 omits it and retains automatic inference.
    #[serde(rename = "patchBasis", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub patch_basis: Option<PatchBasisMode>,
    /// Named checksum states. References preserve the authored relationship
    /// between states even when two states currently have equal digests.
    #[serde(default, rename = "checkStates", skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub check_states: Vec<WeaveCheckState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom: Option<WeaveRom>,
    /// Ordered: array order is the apply order.
    pub patches: Vec<WeavePatchEntry>,
    /// Cheat selections baked into the ROM after the patch chain, in selection
    /// order. Optional: a weave without it is a plain patch recipe.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub cheats: Vec<WeaveCheatEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<WeaveOutput>,
}

/// One cheat selection a weave reproduces. `id` names the record in the
/// local cheat database; `code` is the raw-code snapshot that lets a
/// ROM-bakeable entry still apply when the database is absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct WeaveCheatEntry {
    /// Cheat database record ID. An exact description is also accepted, so a
    /// hand-authored weave can name a cheat the way `cheat list` prints it.
    pub id: String,
    /// Which database the ID belongs to, for example `libretro-database`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub source: Option<String>,
    /// The database revision the selection was made against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub description: Option<String>,
    /// Raw code snapshot, so the entry still applies when the local cheat
    /// database is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub code: Option<String>,
    /// Explicit decoder for the raw code snapshot. This is required for code
    /// shapes that cannot identify their encryption scheme by themselves.
    #[serde(default, rename = "codeKind", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, rename = "codeKind"))]
    pub code_kind: Option<CheatKind>,
    /// An optional cheat is skipped (and named in the report) when it cannot
    /// be resolved; omitted/false makes an unresolvable entry fail the apply.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub optional: bool,
}

/// The input ROM a weave's patch chain applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct WeaveRom {
    /// Display / output-naming file name. For a separately supplied ROM, this
    /// is also an advisory expected basename (defaults to the source basename).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub name: Option<String>,
    /// Optional download URL. At most one of `url` and `path` MAY be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub url: Option<String>,
    /// Weave-relative path (archive member for bundled weaves).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub path: Option<String>,
    /// Exact archive member or disc track to use after resolving this ROM
    /// source. Omitted retains ordinary single-ROM auto-selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub member: Option<String>,
    /// Expected checksums/size of the ROM itself (also verifies downloads).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks: Option<WeaveChecks>,
    /// Named state carrying this ROM's expected checks. New writers use this
    /// instead of repeating a `checks` object on every consumer.
    #[serde(default, rename = "checksRef", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks_ref: Option<String>,
}

/// A named expected byte state shared by weave entries. Equality of the
/// contained checks does not merge states: only an explicit ID reference does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct WeaveCheckState {
    pub id: String,
    pub checks: WeaveChecks,
}

/// Which concrete bytes a patch executes against. This is distinct from
/// `basis`, which records what the patch author used for verification.
#[derive(Clone, Debug, Ord, PartialOrd, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(untagged, deny_unknown_fields)]
pub enum WeavePatchInput {
    Rom {
        rom: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript-types", ts(optional))]
        member: Option<String>,
    },
    Patch {
        patch: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript-types", ts(optional))]
        member: Option<String>,
    },
}

/// One step of the weave's ordered patch chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct WeavePatchEntry {
    /// Stable identity for this patch slot across source replacements.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub id: Option<String>,
    /// Author-controlled release version; distinct from the weave schema version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub version: Option<String>,
    /// Patch author credit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub description: Option<String>,
    /// An optional patch starts deselected; omitted/false means the patch is
    /// applied by default. Every patch remains toggleable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub optional: bool,
    /// Free-form maturity/display label (for example `stable`, `beta`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub label: Option<String>,
    /// Download URL. Exactly one of `url` and `path` MUST be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub url: Option<String>,
    /// Weave-relative path (archive member for bundled weaves).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub path: Option<String>,
    /// Fixed execution input for this patch. Omitted keeps the target lane's
    /// cumulative output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub input: Option<WeavePatchInput>,
    /// Cumulative execution lane for this patch. Omitted retains the legacy
    /// single sequential lane. A patch target seeds its lane from the named
    /// producer's output when the lane first runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub target: Option<WeavePatchInput>,
    /// Expected checksums and size of the authored input state for this step.
    /// These checks supplement the weave's ROM checks and embedded patch checks.
    #[serde(
        default,
        rename = "inputChecks",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub input_checks: Option<WeaveChecks>,
    /// Named authored input state. Mutually exclusive with inline
    /// `inputChecks`; it does not select execution bytes.
    #[serde(
        default,
        rename = "inputChecksRef",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub input_checks_ref: Option<String>,
    /// Expected checksums and size after the authored chain prefix ends at this step.
    #[serde(
        default,
        rename = "outputChecks",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_checks: Option<WeaveChecks>,
    /// Named authored output state. Mutually exclusive with inline
    /// `outputChecks`.
    #[serde(
        default,
        rename = "outputChecksRef",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_checks_ref: Option<String>,
    /// Per-patch header mode override (`auto` when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub header: Option<PatchApplyHeaderMode>,
    /// Per-step override of the shared `patchBasis` setting: `base` names the
    /// original ROM; `previous` names the preceding selected step's output.
    /// Base checks run before the chain; mid-chain base steps retain patch-file
    /// integrity checks but skip checks against the cumulative input and output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub basis: Option<PatchInputBasis>,
}

/// Expected checksums (algorithm -> lowercase hex) and/or exact byte size.
/// Mirrors the requirements parsed from patch file names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct WeaveChecks {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksums: BTreeMap<String, String>,
    /// Exact byte size. Emitted as a JSON `number` on the wasm wire, so
    /// override the default ts-rs `bigint` mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, type = "number | null"))]
    pub size: Option<u64>,
}

/// Default output settings; explicit CLI flags / webapp edits win over these.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct WeaveOutput {
    /// Default output file name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub header: Option<PatchApplyOutputHeaderMode>,
    /// Expected checksums/size of the final output once the full patch chain
    /// (every patch, in weave order) has been applied. A partial selection
    /// validates against its last patch's `outputChecks` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks: Option<WeaveChecks>,
    /// Named expected final-output state. Mutually exclusive with inline
    /// `checks`.
    #[serde(default, rename = "checksRef", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks_ref: Option<String>,
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    use std::path::Path;

    // The packaged crate cannot contain the repository's docs directory, so
    // compare against it only when running from the workspace checkout.
    #[test]
    fn embedded_schemas_match_canonical_docs_copies() {
        for (name, embedded) in [
            ("rom-weaver-weave-v1.schema.json", WEAVE_JSON_SCHEMA_V1),
            ("rom-weaver-weave-v2.schema.json", WEAVE_JSON_SCHEMA),
        ] {
            let docs_path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs")
                .join(name);
            if docs_path.exists() {
                let canonical =
                    std::fs::read_to_string(docs_path).expect("read canonical docs weave schema");
                assert_eq!(canonical, embedded);
            }
        }
    }

    // Drift guard for the hand-maintained JSON Schema: it must stay valid JSON,
    // its $id must match the published URL, and it must advertise every
    // top-level property the Rust type (de)serializes - including the optional
    // `$schema` editor-binding key.
    #[test]
    fn embedded_schema_is_valid_and_consistent() {
        let value: serde_json::Value =
            serde_json::from_str(WEAVE_JSON_SCHEMA).expect("embedded weave schema is valid JSON");
        assert_eq!(
            value.get("$id").and_then(serde_json::Value::as_str),
            Some(WEAVE_JSON_SCHEMA_URL),
            "schema $id must match WEAVE_JSON_SCHEMA_URL"
        );
        let properties = value
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .expect("schema declares top-level properties");
        for key in [
            "$schema",
            "version",
            "patchBasis",
            "checkStates",
            "rom",
            "patches",
            "cheats",
            "output",
        ] {
            assert!(
                properties.contains_key(key),
                "schema is missing top-level property `{key}`"
            );
        }
        assert_eq!(
            properties
                .get("version")
                .and_then(|version| version.get("const"))
                .and_then(serde_json::Value::as_u64),
            Some(WEAVE_VERSION.into()),
            "published weave schema must describe the writer's version"
        );
    }

    // The `$schema` key must be accepted on read despite deny_unknown_fields,
    // and round-trip verbatim (so `weave create --from` preserves it).
    #[test]
    fn parse_accepts_and_preserves_schema_key() {
        let json = format!(
            r#"{{ "$schema": "{WEAVE_JSON_SCHEMA_URL}", "version": {WEAVE_VERSION}, "patchBasis": "base", "patches": [ {{ "path": "a.ips" }} ] }}"#
        );
        let weave = crate::weave_parse::parse_weave_bytes(json.as_bytes())
            .expect("a weave carrying $schema parses");
        assert_eq!(weave.schema.as_deref(), Some(WEAVE_JSON_SCHEMA_URL));
        let reserialized = serde_json::to_string(&weave).expect("serializes");
        assert!(
            reserialized.contains("\"$schema\""),
            "$schema must round-trip through serialization"
        );
    }
}
