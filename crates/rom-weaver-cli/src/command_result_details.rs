use serde::Serialize;
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

use super::*;

/// The `details` of a command whose final report carries a typed result,
/// keyed by command. Typegen exports it, so the webapp finds each result by
/// a generated key and type instead of a string literal. A report sets only
/// its own command's fields.
#[derive(Debug, Default, Serialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct CommandResultDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ingest: Option<IngestResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub identify: Option<IdentifyResult>,
    #[serde(rename = "identifyTitles", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub identify_titles: Option<IdentifyTitleSearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub cheats: Option<CheatCommandResult>,
    /// `weave parse` output under its legacy name, carrying both `bundle`
    /// and `weave`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "typescript-types",
        ts(optional, type = "WeaveParseResult & BundleParseResult")
    )]
    pub bundle: Option<Value>,
    /// The same `weave parse` output as `bundle`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "typescript-types",
        ts(optional, type = "WeaveParseResult & BundleParseResult")
    )]
    pub weave: Option<Value>,
    /// `weave create` output under its legacy name, carrying both the
    /// `bundle` and `weave` field names.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "typescript-types",
        ts(optional, type = "WeaveCreateResult & BundleCreateResult")
    )]
    pub bundle_create: Option<Value>,
    /// The same `weave create` output as `bundle_create`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "typescript-types",
        ts(optional, type = "WeaveCreateResult & BundleCreateResult")
    )]
    pub weave_create: Option<Value>,
}

impl CommandResultDetails {
    /// The report `details` value. None of the result types can fail to
    /// serialize (every map is keyed by `String`).
    pub(crate) fn into_value(self) -> Value {
        json!(self)
    }
}
