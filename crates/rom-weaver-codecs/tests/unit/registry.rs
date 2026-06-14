use super::{CanonicalCodec, RequestedCodec, normalize_codec_label, parse_requested_codec};

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
        parse_requested_codec(Some("lz4")),
        RequestedCodec::Known(CanonicalCodec::Lz4)
    );
    assert_eq!(
        parse_requested_codec(Some("br")),
        RequestedCodec::Known(CanonicalCodec::Brotli)
    );
    assert_eq!(
        parse_requested_codec(Some("ppmd")),
        RequestedCodec::Known(CanonicalCodec::Ppmd)
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
    assert_eq!(normalize_codec_label("BR q=11"), "brotli q=11");
    assert_eq!(normalize_codec_label("mystery-codec"), "mystery-codec");
}
