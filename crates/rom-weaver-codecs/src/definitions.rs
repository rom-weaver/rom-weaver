#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CanonicalCodec {
    Store,
    Deflate,
    Zstd,
    Lz4,
    Brotli,
    Ppmd,
    Lzma,
    Lzma2,
    Bzip2,
    Huffman,
}

impl CanonicalCodec {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Store => "store",
            Self::Deflate => "deflate",
            Self::Zstd => "zstd",
            Self::Lz4 => "lz4",
            Self::Brotli => "brotli",
            Self::Ppmd => "ppmd",
            Self::Lzma => "lzma",
            Self::Lzma2 => "lzma2",
            Self::Bzip2 => "bzip2",
            Self::Huffman => "huffman",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestedCodec {
    Unspecified,
    Known(CanonicalCodec),
    Unknown(String),
}

pub fn parse_requested_codec(codec: Option<&str>) -> RequestedCodec {
    match codec {
        None => RequestedCodec::Unspecified,
        Some(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "store" | "none" | "uncompressed" => RequestedCodec::Known(CanonicalCodec::Store),
                "deflate" | "zlib" | "gzip" | "gz" => {
                    RequestedCodec::Known(CanonicalCodec::Deflate)
                }
                "zstd" | "zst" | "zstandard" => RequestedCodec::Known(CanonicalCodec::Zstd),
                "lz4" => RequestedCodec::Known(CanonicalCodec::Lz4),
                "brotli" | "br" => RequestedCodec::Known(CanonicalCodec::Brotli),
                "ppmd" => RequestedCodec::Known(CanonicalCodec::Ppmd),
                "lzma" => RequestedCodec::Known(CanonicalCodec::Lzma),
                "lzma2" | "xz" => RequestedCodec::Known(CanonicalCodec::Lzma2),
                "bzip2" | "bz2" => RequestedCodec::Known(CanonicalCodec::Bzip2),
                "huffman" | "huff" => RequestedCodec::Known(CanonicalCodec::Huffman),
                _ => RequestedCodec::Unknown(normalized),
            }
        }
    }
}

pub fn normalize_codec_label(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let split_at = trimmed
        .char_indices()
        .find(|(_, ch)| !(ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_'))
        .map(|(index, _)| index)
        .unwrap_or(trimmed.len());
    let (head, tail) = trimmed.split_at(split_at);

    match parse_requested_codec(Some(head)) {
        RequestedCodec::Known(codec) => format!("{}{}", codec.name(), tail),
        RequestedCodec::Unspecified | RequestedCodec::Unknown(_) => trimmed.to_ascii_lowercase(),
    }
}
