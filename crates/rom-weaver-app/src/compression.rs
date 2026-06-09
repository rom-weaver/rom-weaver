use super::*;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(ValueEnum))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "kebab-case"))]
pub enum CompressionLevelProfile {
    Min,
    #[cfg_attr(not(target_arch = "wasm32"), value(name = "very-low"))]
    VeryLow,
    Low,
    Medium,
    High,
    #[cfg_attr(not(target_arch = "wasm32"), value(name = "very-high"))]
    VeryHigh,
    #[default]
    Max,
}

impl CompressionLevelProfile {
    pub(crate) const fn standard_level(self) -> i32 {
        match self {
            Self::Min => 0,
            Self::VeryLow => 2,
            Self::Low => 3,
            Self::Medium => 5,
            Self::High => 7,
            Self::VeryHigh => 8,
            Self::Max => 9,
        }
    }

    pub(crate) const fn zstd_level(self) -> i32 {
        match self {
            Self::Min => -7,
            Self::VeryLow => 4,
            Self::Low => 7,
            Self::Medium => 11,
            Self::High => 15,
            Self::VeryHigh => 19,
            Self::Max => 22,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompressionProfileMetadata {
    pub name: &'static str,
    pub label: &'static str,
    pub standard_level: i32,
    pub zstd_level: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompressionCodecLevelMetadata {
    pub min: i32,
    pub max: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompressionCodecMetadata {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub level: Option<CompressionCodecLevelMetadata>,
    pub profile_kind: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompressionCodecFieldMetadata {
    pub name: &'static str,
    pub codecs: &'static [&'static str],
    pub default_codec: Option<&'static str>,
    pub default_codecs: Option<&'static str>,
    pub allow_multiple: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompressionDefaultsMetadata {
    pub chd_create_cd_codecs: &'static str,
    pub chd_create_dvd_codecs: &'static str,
    pub rvz_block_size: u64,
    pub rvz_codec: &'static str,
    pub rvz_compression_level: i32,
    pub seven_zip_codec: &'static str,
    pub zip_codec: &'static str,
    pub z3ds_codec: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompressionMetadata {
    pub profiles: &'static [CompressionProfileMetadata],
    pub codecs: &'static [CompressionCodecMetadata],
    pub codec_fields: &'static [CompressionCodecFieldMetadata],
    pub defaults: CompressionDefaultsMetadata,
}

const COMPRESSION_PROFILES: &[CompressionProfileMetadata] = &[
    CompressionProfileMetadata {
        name: "min",
        label: "Min",
        standard_level: CompressionLevelProfile::Min.standard_level(),
        zstd_level: CompressionLevelProfile::Min.zstd_level(),
    },
    CompressionProfileMetadata {
        name: "very-low",
        label: "Very Low",
        standard_level: CompressionLevelProfile::VeryLow.standard_level(),
        zstd_level: CompressionLevelProfile::VeryLow.zstd_level(),
    },
    CompressionProfileMetadata {
        name: "low",
        label: "Low",
        standard_level: CompressionLevelProfile::Low.standard_level(),
        zstd_level: CompressionLevelProfile::Low.zstd_level(),
    },
    CompressionProfileMetadata {
        name: "medium",
        label: "Medium",
        standard_level: CompressionLevelProfile::Medium.standard_level(),
        zstd_level: CompressionLevelProfile::Medium.zstd_level(),
    },
    CompressionProfileMetadata {
        name: "high",
        label: "High",
        standard_level: CompressionLevelProfile::High.standard_level(),
        zstd_level: CompressionLevelProfile::High.zstd_level(),
    },
    CompressionProfileMetadata {
        name: "very-high",
        label: "Very High",
        standard_level: CompressionLevelProfile::VeryHigh.standard_level(),
        zstd_level: CompressionLevelProfile::VeryHigh.zstd_level(),
    },
    CompressionProfileMetadata {
        name: "max",
        label: "Max",
        standard_level: CompressionLevelProfile::Max.standard_level(),
        zstd_level: CompressionLevelProfile::Max.zstd_level(),
    },
];

const COMPRESSION_CODECS: &[CompressionCodecMetadata] = &[
    CompressionCodecMetadata {
        name: "store",
        aliases: &[],
        level: None,
        profile_kind: "none",
    },
    CompressionCodecMetadata {
        name: "deflate",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 9 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "zstd",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: -7, max: 22 }),
        profile_kind: "zstd",
    },
    CompressionCodecMetadata {
        name: "lzma",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 9 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "lzma2",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 9 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "zlib",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 9 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "huff",
        aliases: &["huffman"],
        level: None,
        profile_kind: "none",
    },
    CompressionCodecMetadata {
        name: "flac",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 8 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "cdzs",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: -7, max: 22 }),
        profile_kind: "zstd",
    },
    CompressionCodecMetadata {
        name: "cdlz",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 9 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "cdzl",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 9 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "cdfl",
        aliases: &[],
        level: Some(CompressionCodecLevelMetadata { min: 0, max: 8 }),
        profile_kind: "standard",
    },
    CompressionCodecMetadata {
        name: "avhuff",
        aliases: &["avhu"],
        level: None,
        profile_kind: "none",
    },
];

const COMPRESSION_CODEC_FIELDS: &[CompressionCodecFieldMetadata] = &[
    CompressionCodecFieldMetadata {
        name: "chdCreateCdCodecs",
        codecs: &["cdzs", "cdlz", "cdzl", "cdfl"],
        default_codec: None,
        default_codecs: Some("cdlz,cdzl,cdfl"),
        allow_multiple: true,
    },
    CompressionCodecFieldMetadata {
        name: "chdCreateDvdCodecs",
        codecs: &["zstd", "lzma", "zlib", "huff", "flac"],
        default_codec: None,
        default_codecs: Some("lzma,zlib,huff,flac"),
        allow_multiple: true,
    },
    CompressionCodecFieldMetadata {
        name: "rvzCodec",
        codecs: &["zstd"],
        default_codec: Some("zstd"),
        default_codecs: None,
        allow_multiple: false,
    },
    CompressionCodecFieldMetadata {
        name: "sevenZipCodec",
        codecs: &["lzma2"],
        default_codec: Some("lzma2"),
        default_codecs: None,
        allow_multiple: false,
    },
    CompressionCodecFieldMetadata {
        name: "zipCodec",
        codecs: &["deflate", "store", "zstd"],
        default_codec: Some("deflate"),
        default_codecs: None,
        allow_multiple: false,
    },
];

const COMPRESSION_DEFAULTS: CompressionDefaultsMetadata = CompressionDefaultsMetadata {
    chd_create_cd_codecs: "cdlz,cdzl,cdfl",
    chd_create_dvd_codecs: "lzma,zlib,huff,flac",
    rvz_block_size: 131_072,
    rvz_codec: "zstd",
    rvz_compression_level: 19,
    seven_zip_codec: "lzma2",
    zip_codec: "deflate",
    z3ds_codec: "zstd",
};

pub fn compression_metadata() -> CompressionMetadata {
    CompressionMetadata {
        profiles: COMPRESSION_PROFILES,
        codecs: COMPRESSION_CODECS,
        codec_fields: COMPRESSION_CODEC_FIELDS,
        defaults: COMPRESSION_DEFAULTS,
    }
}
