use super::*;

/// Version of the public `rom-weaver-bundle.json` bundle schema this build
/// writes.
pub const BUNDLE_VERSION: u32 = 2;

/// The JSON Schema for `rom-weaver-bundle.json`, embedded from the copy shipped
/// with this crate. A workspace test below keeps it byte-for-byte aligned with
/// the canonical docs copy.
/// Editors can bind it via a `$schema` key (accepted on read) or the published
/// URL in its `$id`.
pub const BUNDLE_JSON_SCHEMA: &str = include_str!("../rom-weaver-bundle-v2.schema.json");
#[cfg(test)]
pub const BUNDLE_JSON_SCHEMA_V1: &str = include_str!("../rom-weaver-bundle-v1.schema.json");

/// Published, resolvable location of [`BUNDLE_JSON_SCHEMA`] (matches its `$id`).
pub const BUNDLE_JSON_SCHEMA_URL: &str = "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v2.schema.json";
#[cfg(not(target_arch = "wasm32"))]
pub const BUNDLE_JSON_SCHEMA_V1_URL: &str = "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json";

/// A distributable ordered patch workflow with optional ROM, selection seed,
/// endpoint checks, sources, and output defaults. Sources are URLs or
/// bundle-relative paths; CLI flags and webapp edits override defaults.
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
    /// Shared input-basis declaration for the chain. Version 2 requires this
    /// value; version 1 omits it and retains automatic inference.
    #[serde(rename = "patchBasis", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub patch_basis: Option<PatchBasisMode>,
    /// Named checksum states. References preserve the authored relationship
    /// between states even when two states currently have equal digests.
    #[serde(default, rename = "checkStates", skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub check_states: Vec<BundleCheckState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom: Option<BundleRom>,
    /// Ordered: array order is the apply order.
    pub patches: Vec<BundlePatchEntry>,
    /// Cheat selections baked into the ROM after the patch chain, in selection
    /// order. Optional: a bundle without it is a plain patch recipe.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub cheats: Vec<BundleCheatEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<BundleOutput>,
}

/// One cheat selection a bundle reproduces. `id` names the record in the
/// local cheat database; `code` is the raw-code snapshot that lets a
/// ROM-bakeable entry still apply when the database is absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct BundleCheatEntry {
    /// Cheat database record ID. An exact description is also accepted, so a
    /// hand-authored bundle can name a cheat the way `cheat list` prints it.
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
    /// An optional cheat is skipped (and named in the report) when it cannot
    /// be resolved; omitted/false makes an unresolvable entry fail the apply.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub optional: bool,
}

/// The input ROM a bundle's patch chain applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct BundleRom {
    /// Display / output-naming file name. For a separately supplied ROM, this
    /// is also an advisory expected basename (defaults to the source basename).
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
    /// Exact archive member or disc track to use after resolving this ROM
    /// source. Omitted retains ordinary single-ROM auto-selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub member: Option<String>,
    /// Expected checksums/size of the ROM itself (also verifies downloads).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks: Option<BundleChecks>,
    /// Named state carrying this ROM's expected checks. New writers use this
    /// instead of repeating a `checks` object on every consumer.
    #[serde(default, rename = "checksRef", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks_ref: Option<String>,
}

/// A named expected byte state shared by bundle entries. Equality of the
/// contained checks does not merge states: only an explicit ID reference does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct BundleCheckState {
    pub id: String,
    pub checks: BundleChecks,
}

/// Which concrete bytes a patch executes against. This is distinct from
/// `basis`, which records what the patch author used for verification.
#[derive(Clone, Debug, Ord, PartialOrd, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(untagged, deny_unknown_fields)]
pub enum BundlePatchInput {
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
    /// Download URL. Exactly one of `url` / `path` must be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub url: Option<String>,
    /// Bundle-relative path (archive member for bundled bundles).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub path: Option<String>,
    /// Fixed execution input for this patch. Omitted keeps the target lane's
    /// cumulative output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub input: Option<BundlePatchInput>,
    /// Cumulative execution lane for this patch. Omitted retains the legacy
    /// single sequential lane. A patch target seeds its lane from the named
    /// producer's output when the lane first runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub target: Option<BundlePatchInput>,
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
    /// Named authored input state. Mutually exclusive with inline
    /// `inputChecks`; it does not select execution bytes.
    #[serde(
        default,
        rename = "inputChecksRef",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub input_checks_ref: Option<String>,
    /// Expected checksums/size immediately after this patch is applied, ONLY
    /// when it differs from the bundle's final `output.checks`.
    #[serde(
        default,
        rename = "outputChecks",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_checks: Option<BundleChecks>,
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
    /// What this patch's input checks were authored against: `base` (the
    /// bundle's rom - verified once up front; its embedded checks are skipped
    /// when the patch runs mid-chain) or `previous` (the previous selected
    /// patch's output - the default). Omitted means previous/inferred.
    /// `basis: "base"` with omitted `inputChecks` is the canonical compact
    /// form - the entry relies on `rom.checks`; declaring it WITH
    /// `inputChecks` pins a specific variant. The escape hatch for
    /// checksumless formats (IPS) whose basis cannot be inferred.
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
            ("rom-weaver-bundle-v1.schema.json", BUNDLE_JSON_SCHEMA_V1),
            ("rom-weaver-bundle-v2.schema.json", BUNDLE_JSON_SCHEMA),
        ] {
            let docs_path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs")
                .join(name);
            if docs_path.exists() {
                let canonical =
                    std::fs::read_to_string(docs_path).expect("read canonical docs bundle schema");
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
            Some(BUNDLE_VERSION.into()),
            "published bundle schema must describe the writer's version"
        );
    }

    // The `$schema` key must be accepted on read despite deny_unknown_fields,
    // and round-trip verbatim (so `bundle create --from` preserves it).
    #[test]
    fn parse_accepts_and_preserves_schema_key() {
        let json = format!(
            r#"{{ "$schema": "{BUNDLE_JSON_SCHEMA_URL}", "version": {BUNDLE_VERSION}, "patchBasis": "base", "patches": [ {{ "path": "a.ips" }} ] }}"#
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
