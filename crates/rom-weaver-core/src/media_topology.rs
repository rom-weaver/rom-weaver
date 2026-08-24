//! Neutral media-topology data types shared by identify producers and
//! consumers. Container decoding and database lookup live elsewhere; this
//! module only names the shapes they exchange.

use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

/// The physical or logical medium a set of hashed payloads came from.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    /// A single opaque payload with no further structure.
    Blob,
    Cartridge,
    Card,
    Floppy,
    Tape,
    OpticalDisc,
    MultiDiscSet,
    ArcadeSet,
    Package,
    MultiFileSet,
}

/// What one component contributes to its medium.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum ComponentRole {
    PrimaryPayload,
    DataTrack,
    AudioTrack,
    Partition,
    ContentFile,
    ArcadeRom,
    DiskSide,
    ChildDisc,
}

/// Stable index of a component within one [`MediaTopology`].
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ComponentId(pub u32);

/// One hashed payload inside a medium (a track, a partition, a file, ...).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct MediaComponent {
    pub id: ComponentId,
    pub role: ComponentRole,
    /// Position among siblings of the same medium, starting at 0.
    pub ordinal: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub filename: Option<String>,
    /// Decoded payload size in bytes; 0 when the size is unknown.
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub track: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub session: Option<u32>,
}

/// The decoded shape of one input: its medium kind plus every component.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct MediaTopology {
    pub kind: MediaKind,
    /// Container format name the payload was decoded from, when any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub container: Option<String>,
    /// Optical-disc session count, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub sessions: Option<u32>,
    pub components: Vec<MediaComponent>,
}

/// How sure a detector is about a platform candidate.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum DetectionConfidence {
    Certain,
    Strong,
    Weak,
}

/// The concrete observation a platform candidate rests on.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum DetectionEvidence {
    HeaderMagic,
    SystemAreaMagic,
    Iso9660Entry(String),
    ExecutableName(String),
    DiscSerial(String),
    ContainerMetadata,
    ExtensionHint,
    DatabaseRouter,
    UserOverride,
}

/// One possible platform for an input, with the evidence behind it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct PlatformCandidate {
    /// Canonical identify platform name.
    pub platform: String,
    pub confidence: DetectionConfidence,
    pub evidence: DetectionEvidence,
}
