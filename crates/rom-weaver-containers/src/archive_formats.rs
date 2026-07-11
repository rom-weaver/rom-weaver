//! Canonical archive-format detection table.
//!
//! The web UI routes a dropped file synchronously - before staging it into
//! libarchive - to decide whether it is an archive and, if so, which archive
//! type it is (so it can pick the right extraction path and naming). That
//! routing needs magic-byte signatures and the full universe of extensions our
//! bundled libarchive can open (squashfs/qcow/wim/xar/dmg/vmdk/ext4/… - formats
//! with no dedicated [`crate::ContainerRegistry`] handler). Those facts are a
//! property of the Rust/libarchive build, so they live here and are mirrored to
//! TypeScript via typegen (`ROM_WEAVER_ARCHIVE_FORMATS`) rather than being
//! hand-maintained a second time in the browser.
//!
//! The matcher logic stays in TS (it runs per-entry in synchronous worker
//! decompression loops where a wasm round-trip is infeasible); only the data is
//! canonical here.

/// A magic-byte signature and the archive type it resolves to. Matched in table
/// order, first hit wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchiveMagicSignature {
    /// Leading bytes to compare.
    pub bytes: &'static [u8],
    /// Byte offset the signature begins at (tar's `ustar` lives at 257).
    pub offset: usize,
    /// Archive-type label this signature resolves to.
    pub archive_type: &'static str,
}

/// A single-extension alias mapping (e.g. `tgz` → `tar.gz`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchiveExtensionAlias {
    pub extension: &'static str,
    pub archive_type: &'static str,
}

/// The canonical archive-detection data surfaced to the web UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchiveFormatMetadata {
    /// Magic signatures, in match order.
    pub magic_signatures: &'static [ArchiveMagicSignature],
    /// Single-extension → archive-type aliases.
    pub extension_aliases: &'static [ArchiveExtensionAlias],
    /// Multipart (`tar.*`) extension → archive-type aliases.
    pub multipart_extension_aliases: &'static [ArchiveExtensionAlias],
    /// Recognized multipart (`tar.*`) suffixes (longest-suffix match wins).
    pub multipart_extensions: &'static [&'static str],
    /// Full set of extensions treated as archives (the libarchive universe).
    pub supported_extensions: &'static [&'static str],
}

const fn magic(bytes: &'static [u8], archive_type: &'static str) -> ArchiveMagicSignature {
    ArchiveMagicSignature {
        bytes,
        offset: 0,
        archive_type,
    }
}

const fn magic_at(
    bytes: &'static [u8],
    offset: usize,
    archive_type: &'static str,
) -> ArchiveMagicSignature {
    ArchiveMagicSignature {
        bytes,
        offset,
        archive_type,
    }
}

const fn alias(extension: &'static str, archive_type: &'static str) -> ArchiveExtensionAlias {
    ArchiveExtensionAlias {
        extension,
        archive_type,
    }
}

const MAGIC_SIGNATURES: &[ArchiveMagicSignature] = &[
    magic(&[0x50, 0x4b, 0x03, 0x04], "zip"),
    magic(&[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], "7z"),
    magic(&[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], "rar"),
    magic(&[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], "rar"),
    magic_at(&[0x75, 0x73, 0x74, 0x61, 0x72], 257, "tar"),
    magic(&[0x60, 0xea], "arj"),
    magic(&[0x1f, 0x8b], "gz"),
    magic(&[0x42, 0x5a, 0x68], "bz2"),
    magic(&[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], "xz"),
    magic(&[0x28, 0xb5, 0x2f, 0xfd], "zst"),
    magic(&[0x5d, 0x00, 0x00], "lzma"),
    magic(&[0x04, 0x22, 0x4d, 0x18], "lz4"),
    magic(&[0x05, 0x22, 0x4d, 0x18], "lz5"),
    magic(&[0x06, 0x22, 0x4d, 0x18], "lizard"),
    magic(&[0x4c, 0x5a, 0x49, 0x50], "lz"),
    magic(&[0x1f, 0x9d], "z"),
    magic(&[0x1f, 0xa0], "z"),
    magic(&[0x4d, 0x53, 0x43, 0x46], "cab"),
    magic(&[0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a], "ar"),
    magic(&[0x30, 0x37, 0x30, 0x37, 0x30], "cpio"),
    magic(&[0xc7, 0x71], "cpio"),
    magic(&[0x71, 0xc7], "cpio"),
    magic(
        &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
        "compound",
    ),
    magic(&[0x49, 0x54, 0x53, 0x46, 0x03, 0x00, 0x00, 0x00], "chm"),
    magic(&[0x51, 0x46, 0x49, 0xfb], "qcow"),
    magic(&[0xed, 0xab, 0xee, 0xdb], "rpm"),
    magic(&[0x68, 0x73, 0x71, 0x73], "squashfs"),
    magic(&[0x73, 0x71, 0x73, 0x68], "squashfs"),
    magic(&[0x73, 0x68, 0x73, 0x71], "squashfs"),
    magic(&[0x71, 0x73, 0x68, 0x73], "squashfs"),
    magic(&[0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00], "wim"),
    magic(&[0x78, 0x61, 0x72, 0x21, 0x00], "xar"),
];

const EXTENSION_ALIASES: &[ArchiveExtensionAlias] = &[
    alias("a", "ar"),
    alias("brotli", "br"),
    alias("bzip2", "bz2"),
    alias("chi", "chm"),
    alias("chq", "chm"),
    alias("gzip", "gz"),
    alias("lib", "ar"),
    alias("liz", "lizard"),
    alias("lzip", "lz"),
    alias("ova", "tar"),
    alias("pkg", "xar"),
    alias("r00", "rar"),
    alias("taz", "tar.gz"),
    alias("tbr", "tar.br"),
    alias("tbz", "tar.bz2"),
    alias("tbz2", "tar.bz2"),
    alias("tgz", "tar.gz"),
    alias("tliz", "tar.lizard"),
    alias("tlz", "tar.lzma"),
    alias("tlz4", "tar.lz4"),
    alias("tlz5", "tar.lz5"),
    alias("tpz", "tar.gz"),
    alias("txz", "tar.xz"),
    alias("tzst", "tar.zst"),
    alias("tzstd", "tar.zst"),
    alias("xip", "xar"),
    alias("z01", "zip"),
    alias("zstd", "zst"),
];

const MULTIPART_EXTENSION_ALIASES: &[ArchiveExtensionAlias] = &[
    alias("tar.brotli", "tar.br"),
    alias("tar.lzip", "tar.lz"),
    alias("tar.zstd", "tar.zst"),
];

const MULTIPART_EXTENSIONS: &[&str] = &[
    "tar.gz",
    "tar.bz2",
    "tar.xz",
    "tar.lzma",
    "tar.zst",
    "tar.br",
    "tar.lz",
    "tar.lz4",
    "tar.lz5",
    "tar.lizard",
];

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "001",
    "7z",
    "a",
    "aaf",
    "apfs",
    "apk",
    "apm",
    "appx",
    "ar",
    "arj",
    "avhdx",
    "b64",
    "br",
    "brotli",
    "bz2",
    "bzip2",
    "cab",
    "chi",
    "chm",
    "chq",
    "chw",
    "cpio",
    "cramfs",
    "deb",
    "dmg",
    "doc",
    "docx",
    "epub",
    "esd",
    "ext",
    "ext2",
    "ext3",
    "ext4",
    "fat",
    "gpt",
    "gz",
    "gzip",
    "hfs",
    "hfsx",
    "hxi",
    "hxq",
    "hxr",
    "hxs",
    "hxw",
    "ihex",
    "ipa",
    "jar",
    "lha",
    "lib",
    "lit",
    "liz",
    "lzh",
    "lizard",
    "lpimg",
    "lz",
    "lz4",
    "lz5",
    "lzip",
    "lzma",
    "lzma86",
    "mbr",
    "msi",
    "mslz",
    "msp",
    "msm",
    "mub",
    "nsis",
    "ntfs",
    "ods",
    "odt",
    "ova",
    "pmd",
    "ppkg",
    "ppt",
    "pkg",
    "qcow",
    "qcow2",
    "qcow2c",
    "r00",
    "rar",
    "rpm",
    "scap",
    "sfs",
    "simg",
    "squashfs",
    "swm",
    "tar",
    "tar.br",
    "tar.brotli",
    "tar.bz2",
    "tar.gz",
    "tar.lizard",
    "tar.lz",
    "tar.lz4",
    "tar.lz5",
    "tar.lzip",
    "tar.lzma",
    "tar.xz",
    "tar.zst",
    "tar.zstd",
    "taz",
    "tbz",
    "tbz2",
    "tbr",
    "te",
    "tgz",
    "tliz",
    "tlz",
    "tlz4",
    "tlz5",
    "tpz",
    "txz",
    "tzst",
    "tzstd",
    "udf",
    "udeb",
    "uefi",
    "uefif",
    "vdi",
    "vhd",
    "vhdx",
    "vmdk",
    "wim",
    "xar",
    "xip",
    "xls",
    "xlsx",
    "xpi",
    "xz",
    "z",
    "z01",
    "zip",
    "zipx",
    "zst",
    "zstd",
];

/// The canonical archive-detection table mirrored to the web UI via typegen.
pub fn archive_format_metadata() -> ArchiveFormatMetadata {
    ArchiveFormatMetadata {
        magic_signatures: MAGIC_SIGNATURES,
        extension_aliases: EXTENSION_ALIASES,
        multipart_extension_aliases: MULTIPART_EXTENSION_ALIASES,
        multipart_extensions: MULTIPART_EXTENSIONS,
        supported_extensions: SUPPORTED_EXTENSIONS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every magic signature must carry bytes and resolve to an archive type so
    /// the browser's byte probe can never match an empty/anonymous entry.
    #[test]
    fn magic_signatures_are_well_formed() {
        for signature in archive_format_metadata().magic_signatures {
            assert!(
                !signature.bytes.is_empty(),
                "magic signature for `{}` has no bytes",
                signature.archive_type,
            );
            assert!(
                !signature.archive_type.is_empty(),
                "magic signature {:02x?} has no archive type",
                signature.bytes,
            );
        }
    }

    /// Every extension referenced by an alias or multipart list must also appear
    /// in the supported set, so a routed file is never rejected downstream.
    #[test]
    fn aliases_and_multiparts_are_supported() {
        let metadata = archive_format_metadata();
        let supported: std::collections::HashSet<&str> =
            metadata.supported_extensions.iter().copied().collect();
        for alias in metadata.extension_aliases {
            assert!(
                supported.contains(alias.extension),
                "alias extension `{}` missing from supported set",
                alias.extension,
            );
        }
        for multipart in metadata.multipart_extensions {
            assert!(
                supported.contains(multipart),
                "multipart extension `{multipart}` missing from supported set",
            );
        }
    }
}
