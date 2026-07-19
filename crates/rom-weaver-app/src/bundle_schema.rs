use super::*;

/// Version of the `rom-weaver-bundle.json` bundle schema this build writes.
/// Version 2 added the per-patch `basis` field; version 3 added stable
/// patch identities and the author-controlled `version`/`author` fields.
/// Readers accept
/// [`BUNDLE_MIN_VERSION`]..=[`BUNDLE_VERSION`].
pub const BUNDLE_VERSION: u32 = 3;
/// Oldest bundle schema version this build still reads.
pub const BUNDLE_MIN_VERSION: u32 = 1;

/// The JSON Schema for `rom-weaver-bundle.json`, embedded from the copy shipped
/// with this crate. A workspace test below keeps it byte-for-byte aligned with
/// the canonical docs copy.
/// Editors can bind it via a `$schema` key (accepted on read) or the published
/// URL in its `$id`.
pub const BUNDLE_JSON_SCHEMA: &str = include_str!("../rom-weaver-bundle.schema.json");

/// Published, resolvable location of [`BUNDLE_JSON_SCHEMA`] (matches its `$id`).
pub const BUNDLE_JSON_SCHEMA_URL: &str = "https://rom-weaver.com/rom-weaver-bundle.schema.json";

/// A distributable patching workflow definition (`rom-weaver-bundle.json`): ordered patches
/// with an optional/required selection seed and expected input/output ROM
/// checks, optionally the ROM itself, and default output settings. Every
/// entry's source is either a download URL or a path relative to the bundle
/// (an archive member when the bundle ships inside an archive). The rom
/// entry's `checks` describe the chain's input; `output.checks` describe the
/// final output; a patch only carries its own `inputChecks`/`outputChecks`
/// when they differ from those endpoints (mid-chain steps). Defaults defined
/// here are overridable by explicit CLI flags / webapp edits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RomWeaverBundle {
    /// Optional JSON Schema reference so editors bind autocomplete/validation
    /// when a bundle is hand-authored. A named field satisfies
    /// `deny_unknown_fields` (an unknown `$schema` key would otherwise fail
    /// parse); the value is preserved verbatim through `bundle create --from`
    /// but never auto-injected by create (keeps emitted bytes stable). First
    /// field so it serializes at the top, the conventional position.
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, rename = "$schema"))]
    pub schema: Option<String>,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom: Option<BundleRom>,
    /// Ordered: array order is the apply order.
    pub patches: Vec<BundlePatchEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<BundleOutput>,
}

/// The input ROM a bundle's patch chain applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct BundleRom {
    /// Display / output-naming file name (defaults to the source's base name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub name: Option<String>,
    /// Download URL. Exactly one of `url` / `path` must be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub url: Option<String>,
    /// Bundle-relative path (archive member for bundled bundles).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub path: Option<String>,
    /// Expected checksums/size of the ROM itself (also verifies downloads).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks: Option<BundleChecks>,
}

/// One step of the bundle's ordered patch chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct BundlePatchEntry {
    /// Stable identity for this patch slot across source replacements.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub id: Option<String>,
    /// Author-controlled release version; distinct from the bundle schema version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub version: Option<String>,
    /// Patch author credit. (v3)
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
    /// Download URL. Exactly one of `url` / `path` must be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub url: Option<String>,
    /// Bundle-relative path (archive member for bundled bundles).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub path: Option<String>,
    /// Expected checksums/size of the ROM state this patch applies to, ONLY
    /// when it differs from `rom.checks` (a mid-chain step). Absent means the
    /// patch relies on the rom's own checks.
    #[serde(
        default,
        rename = "inputChecks",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub input_checks: Option<BundleChecks>,
    /// Expected checksums/size immediately after this patch is applied, ONLY
    /// when it differs from the bundle's final `output.checks`.
    #[serde(
        default,
        rename = "outputChecks",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_checks: Option<BundleChecks>,
    /// Per-patch header mode override (`auto` when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub header: Option<PatchApplyHeaderMode>,
    /// What this patch's input checks were authored against: `base` (the
    /// bundle's rom - verified once up front; its embedded checks are skipped
    /// when the patch runs mid-chain) or `previous` (the previous selected
    /// patch's output - the default). Omitted means previous/inferred.
    /// `basis: "base"` with omitted `inputChecks` is the canonical compact
    /// form - the entry relies on `rom.checks`; declaring it WITH
    /// `inputChecks` pins a specific variant. The escape hatch for
    /// checksumless formats (IPS) whose basis cannot be inferred. (v2)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub basis: Option<PatchInputBasis>,
}

/// Expected checksums (algorithm -> lowercase hex) and/or exact byte size.
/// Mirrors the requirements parsed from patch file names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct BundleChecks {
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
pub struct BundleOutput {
    /// Default output file name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub header: Option<PatchApplyOutputHeaderMode>,
    /// Expected checksums/size of the final output once the full patch chain
    /// (every patch, in bundle order) has been applied. A partial selection
    /// validates against its last patch's `outputChecks` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks: Option<BundleChecks>,
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    use std::path::Path;

    // The packaged crate cannot contain the repository's docs directory, so
    // compare against it only when running from the workspace checkout.
    #[test]
    fn embedded_schema_matches_canonical_docs_copy() {
        let docs_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/rom-weaver-bundle.schema.json");
        if docs_path.exists() {
            let canonical =
                std::fs::read_to_string(docs_path).expect("read canonical docs bundle schema");
            assert_eq!(canonical, BUNDLE_JSON_SCHEMA);
        }
    }

    // Drift guard for the hand-maintained JSON Schema: it must stay valid JSON,
    // its $id must match the published URL, and it must advertise every
    // top-level property the Rust type (de)serializes - including the optional
    // `$schema` editor-binding key.
    #[test]
    fn embedded_schema_is_valid_and_consistent() {
        let value: serde_json::Value =
            serde_json::from_str(BUNDLE_JSON_SCHEMA).expect("embedded bundle schema is valid JSON");
        assert_eq!(
            value.get("$id").and_then(serde_json::Value::as_str),
            Some(BUNDLE_JSON_SCHEMA_URL),
            "schema $id must match BUNDLE_JSON_SCHEMA_URL"
        );
        let properties = value
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .expect("schema declares top-level properties");
        for key in ["$schema", "version", "rom", "patches", "output"] {
            assert!(
                properties.contains_key(key),
                "schema is missing top-level property `{key}`"
            );
        }
    }

    // The `$schema` key must be accepted on read despite deny_unknown_fields,
    // and round-trip verbatim (so `bundle create --from` preserves it).
    #[test]
    fn parse_accepts_and_preserves_schema_key() {
        let json = format!(
            r#"{{ "$schema": "{BUNDLE_JSON_SCHEMA_URL}", "version": {BUNDLE_VERSION}, "patches": [ {{ "path": "a.ips" }} ] }}"#
        );
        let bundle = crate::bundle_parse::parse_bundle_bytes(json.as_bytes())
            .expect("a bundle carrying $schema parses");
        assert_eq!(bundle.schema.as_deref(), Some(BUNDLE_JSON_SCHEMA_URL));
        let reserialized = serde_json::to_string(&bundle).expect("serializes");
        assert!(
            reserialized.contains("\"$schema\""),
            "$schema must round-trip through serialization"
        );
    }
}
