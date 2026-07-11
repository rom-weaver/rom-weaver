use super::*;

/// Version of the `rw.json` manifest schema this build reads and writes.
pub const MANIFEST_VERSION: u32 = 1;

/// A distributable patching workflow definition (`rw.json`): ordered patches
/// with an optional/required selection seed and expected input/output ROM
/// checks, optionally the ROM itself, and default output settings. Every
/// entry's source is either a download URL or a path relative to the manifest
/// (an archive member when the manifest ships inside an archive). The rom
/// entry's `checks` describe the chain's input; `output.checks` describe the
/// final output; a patch only carries its own `inputChecks`/`outputChecks`
/// when they differ from those endpoints (mid-chain steps). Defaults defined
/// here are overridable by explicit CLI flags / webapp edits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RomWeaverManifest {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom: Option<ManifestRom>,
    /// Ordered: array order is the apply order.
    pub patches: Vec<ManifestPatchEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<ManifestOutput>,
}

/// The input ROM a manifest's patch chain applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct ManifestRom {
    /// Display / output-naming file name (defaults to the source's base name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub name: Option<String>,
    /// Download URL. Exactly one of `url` / `path` must be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub url: Option<String>,
    /// Manifest-relative path (archive member for bundled manifests).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub path: Option<String>,
    /// Expected checksums/size of the ROM itself (also verifies downloads).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks: Option<ManifestChecks>,
}

/// One step of the manifest's ordered patch chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct ManifestPatchEntry {
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
    /// Manifest-relative path (archive member for bundled manifests).
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
    pub input_checks: Option<ManifestChecks>,
    /// Expected checksums/size immediately after this patch is applied, ONLY
    /// when it differs from the manifest's final `output.checks`.
    #[serde(
        default,
        rename = "outputChecks",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_checks: Option<ManifestChecks>,
    /// Per-patch header mode override (`auto` when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub header: Option<PatchApplyHeaderMode>,
}

/// Expected checksums (algorithm -> lowercase hex) and/or exact byte size.
/// Mirrors the requirements parsed from patch file names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct ManifestChecks {
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
pub struct ManifestOutput {
    /// Default output file name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub header: Option<PatchApplyOutputHeaderMode>,
    /// Expected checksums/size of the final output once the full patch chain
    /// (every patch, in manifest order) has been applied. A partial selection
    /// validates against its last patch's `outputChecks` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub checks: Option<ManifestChecks>,
}
