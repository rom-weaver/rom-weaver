use std::{collections::BTreeMap, fs};

use super::{crc32_path_cached, crc32_prefix, crc32_slice, read_footer, read_u32_le};
use crate::test_support::{TestDir, test_context_with_threads};

fn seeded(context: &rom_weaver_core::OperationContext, path: &std::path::Path, value: &str) {
    let mut checksums = BTreeMap::new();
    checksums.insert("crc32".to_string(), value.to_string());
    context.seed_checksums(path, &checksums);
}

#[test]
fn little_endian_u32_and_slice_crc32_match_their_inputs() {
    assert_eq!(read_u32_le(&[0x78, 0x56, 0x34, 0x12]), 0x1234_5678);
    assert_eq!(crc32_slice(b""), 0);
    assert_eq!(crc32_slice(b"123456789"), 0xCBF4_3926);
}

#[test]
fn a_cached_checksum_is_reused_instead_of_re_reading_the_file() {
    let temp = TestDir::new();
    let path = temp.child("cached.bin");
    fs::write(&path, b"123456789").expect("fixture");
    let context = test_context_with_threads(&temp, 1);

    // A value that is not the file's real CRC32 proves the seeded entry is used
    // rather than recomputed.
    seeded(&context, &path, "deadbeef");
    assert_eq!(
        crc32_path_cached(&path, &context).expect("cached crc32"),
        0xdead_beef
    );
}

#[test]
fn a_cached_checksum_that_is_not_hex_is_reported() {
    let temp = TestDir::new();
    let path = temp.child("bad-cache.bin");
    fs::write(&path, b"123456789").expect("fixture");
    let context = test_context_with_threads(&temp, 1);
    seeded(&context, &path, "not-hex");

    let error = crc32_path_cached(&path, &context).expect_err("a non-hex cache entry should fail");
    assert!(
        error.to_string().contains("invalid crc32"),
        "unexpected error: {error}"
    );
}

#[test]
fn an_uncached_checksum_is_computed_from_the_file() {
    let temp = TestDir::new();
    let path = temp.child("uncached.bin");
    fs::write(&path, b"123456789").expect("fixture");

    assert_eq!(
        crc32_path_cached(&path, &test_context_with_threads(&temp, 1)).expect("crc32"),
        0xCBF4_3926
    );
}

#[test]
fn a_prefix_crc32_covers_only_the_requested_bytes() {
    let temp = TestDir::new();
    let path = temp.child("prefix.bin");
    fs::write(&path, b"123456789trailing").expect("fixture");

    // A buffer smaller than the prefix forces more than one chunked read.
    assert_eq!(
        crc32_prefix(&path, 9, 4, "prefix overflow").expect("prefix crc32"),
        crc32_slice(b"123456789")
    );
    assert_eq!(
        crc32_prefix(&path, 0, 4, "prefix overflow").expect("empty prefix"),
        0
    );

    let error = crc32_prefix(&path, 64, 8, "prefix overflow")
        .expect_err("a prefix past the end of the file should fail");
    assert!(
        matches!(error, rom_weaver_core::RomWeaverError::Io(_)),
        "unexpected error: {error}"
    );
}

#[test]
fn a_footer_is_read_from_its_offset() {
    let temp = TestDir::new();
    let path = temp.child("footer.bin");
    fs::write(&path, b"headerFOOT").expect("fixture");

    assert_eq!(read_footer::<4>(&path, 6).expect("footer"), *b"FOOT");
    let error =
        read_footer::<8>(&path, 6).expect_err("a footer past the end of the file should fail");
    assert!(
        matches!(error, rom_weaver_core::RomWeaverError::Io(_)),
        "unexpected error: {error}"
    );
}
