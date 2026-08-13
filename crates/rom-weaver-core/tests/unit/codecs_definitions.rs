use super::*;

#[test]
fn canonical_codec_names_cover_every_codec_and_parse_edge_aliases() {
    let codecs = [
        (CanonicalCodec::Store, "store"),
        (CanonicalCodec::Deflate, "deflate"),
        (CanonicalCodec::Zstd, "zstd"),
        (CanonicalCodec::Lz4, "lz4"),
        (CanonicalCodec::Brotli, "brotli"),
        (CanonicalCodec::Ppmd, "ppmd"),
        (CanonicalCodec::Lzma, "lzma"),
        (CanonicalCodec::Lzma2, "lzma2"),
        (CanonicalCodec::Bzip2, "bzip2"),
        (CanonicalCodec::Huffman, "huffman"),
    ];
    for (codec, name) in codecs {
        assert_eq!(codec.name(), name);
    }

    assert_eq!(parse_requested_codec(None), RequestedCodec::Unspecified);
    assert_eq!(
        parse_requested_codec(Some(" none ")),
        RequestedCodec::Known(CanonicalCodec::Store)
    );
    assert_eq!(
        parse_requested_codec(Some("uncompressed")),
        RequestedCodec::Known(CanonicalCodec::Store)
    );
    assert_eq!(
        parse_requested_codec(Some("bz2")),
        RequestedCodec::Known(CanonicalCodec::Bzip2)
    );
    assert_eq!(
        parse_requested_codec(Some("xz")),
        RequestedCodec::Known(CanonicalCodec::Lzma2)
    );
    assert_eq!(
        parse_requested_codec(Some("lzma")),
        RequestedCodec::Known(CanonicalCodec::Lzma)
    );
    assert_eq!(normalize_codec_label(""), "");
}
