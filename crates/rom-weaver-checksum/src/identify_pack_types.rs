use crate::identify_catalog::IdentifySource;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PackComponentRole {
    PrimaryPayload,
    DataTrack,
    AudioTrack,
    ArcadeRom,
    Partition,
    ContentFile,
    DiskSide,
    ChildDisc,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpstreamSource {
    Libretro,
    Redump,
    NoIntro,
    Tosec,
    Mame,
    Fbneo,
    OpenGood,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct PackProvenance {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}
fn default_hash_scope() -> String {
    "full_file".into()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackComponent {
    pub role: PackComponentRole,
    pub ordinal: u32,
    #[serde(default = "default_hash_scope")]
    pub hash_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crc32: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub required: bool,
    pub discriminating: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackGame {
    pub name: String,
    pub platform: String,
    pub source: IdentifySource,
    pub upstream_source: UpstreamSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provenance: Vec<PackProvenance>,
    #[serde(default)]
    pub legacy_variant: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dump_tags: Vec<String>,
    /// Other names the same dump is known by. A merge keeps one record per
    /// hash and one canonical name, so the name the other source used (a
    /// GoodTools name with its revision tag, say) survives only here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternate_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub components: Vec<PackComponent>,
}
