use std::sync::Arc;

use rom_weaver_core::{
    CodecBackend, CodecCapabilities, CodecDescriptor, CodecOperationRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, Result, ThreadCapability,
};

const STORE: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "store",
    aliases: &[],
    extensions: &[],
};
const DEFLATE: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "deflate",
    aliases: &["zlib"],
    extensions: &[],
};
const ZSTD: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "zstd",
    aliases: &[],
    extensions: &[],
};
const LZMA2: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "lzma2",
    aliases: &["xz"],
    extensions: &[],
};
const BZIP2: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "bzip2",
    aliases: &["bz2"],
    extensions: &[],
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CanonicalCodec {
    Store,
    Deflate,
    Zstd,
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

pub struct CodecRegistry {
    backends: Vec<Arc<dyn CodecBackend>>,
}

impl Default for CodecRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CodecRegistry {
    pub fn new() -> Self {
        Self {
            backends: vec![
                Arc::new(StaticCodecBackend::new(&STORE)),
                Arc::new(StaticCodecBackend::new(&DEFLATE)),
                Arc::new(StaticCodecBackend::new(&ZSTD)),
                Arc::new(StaticCodecBackend::new(&LZMA2)),
                Arc::new(StaticCodecBackend::new(&BZIP2)),
            ],
        }
    }

    pub fn backends(&self) -> &[Arc<dyn CodecBackend>] {
        &self.backends
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn CodecBackend>> {
        self.backends
            .iter()
            .find(|backend| backend.descriptor().matches_name(name))
            .cloned()
    }
}

struct StaticCodecBackend {
    descriptor: &'static CodecDescriptor,
}

impl StaticCodecBackend {
    const fn new(descriptor: &'static CodecDescriptor) -> Self {
        Self { descriptor }
    }

    fn unsupported_label(&self, operation: &str) -> String {
        format!(
            "{operation} is not implemented yet for {}",
            self.descriptor.name
        )
    }
}

impl CodecBackend for StaticCodecBackend {
    fn descriptor(&self) -> &'static CodecDescriptor {
        self.descriptor
    }

    fn encode(
        &self,
        _request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "encode",
            self.unsupported_label("encode"),
            Some(execution),
        ))
    }

    fn decode(
        &self,
        _request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "decode",
            self.unsupported_label("decode"),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> CodecCapabilities {
        CodecCapabilities {
            encode: false,
            decode: false,
            threads: ThreadCapability::single_threaded(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CanonicalCodec, CodecRegistry, RequestedCodec, normalize_codec_label, parse_requested_codec,
    };

    #[test]
    fn registry_contains_planned_backends() {
        let registry = CodecRegistry::new();
        let names = registry
            .backends()
            .iter()
            .map(|backend| backend.descriptor().name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["store", "deflate", "zstd", "lzma2", "bzip2"]);
    }

    #[test]
    fn parses_shared_codec_aliases() {
        assert_eq!(
            parse_requested_codec(Some("xz")),
            RequestedCodec::Known(CanonicalCodec::Lzma2)
        );
        assert_eq!(
            parse_requested_codec(Some("gzip")),
            RequestedCodec::Known(CanonicalCodec::Deflate)
        );
        assert_eq!(
            parse_requested_codec(Some("zst")),
            RequestedCodec::Known(CanonicalCodec::Zstd)
        );
        assert_eq!(
            parse_requested_codec(Some("huff")),
            RequestedCodec::Known(CanonicalCodec::Huffman)
        );
    }

    #[test]
    fn unknown_codec_is_preserved() {
        assert_eq!(
            parse_requested_codec(Some("foo-codec")),
            RequestedCodec::Unknown("foo-codec".to_string())
        );
    }

    #[test]
    fn normalizes_codec_labels_for_reporting() {
        assert_eq!(normalize_codec_label("LZMA2 (6)"), "lzma2 (6)");
        assert_eq!(normalize_codec_label("xz(9)"), "lzma2(9)");
        assert_eq!(normalize_codec_label("Zstandard level=3"), "zstd level=3");
        assert_eq!(normalize_codec_label("mystery-codec"), "mystery-codec");
    }
}
