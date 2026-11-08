use super::decode_yay0;

const NO_LIMIT: u64 = 1 << 20;

/// Hand-assembled from the Yay0Helper.decode layout.
///
/// Header: "Yay0", decoded length 8, link table at 17, chunk table at 19. Command byte 0xC0 is
/// bits 1,1,0. The chunk table holds literals 'A' and 'B'. The link 0x4001 is distance
/// (0x001 + 1) = 2 and length (4 + 2) = 6, so decoding gives "AB" then six bytes copied from two
/// back: "ABABABAB".
fn literal_then_link() -> Vec<u8> {
    let mut stream = b"Yay0".to_vec();
    stream.extend_from_slice(&8u32.to_be_bytes());
    stream.extend_from_slice(&17u32.to_be_bytes());
    stream.extend_from_slice(&19u32.to_be_bytes());
    stream.push(0xC0);
    stream.extend_from_slice(&[0x40, 0x01]);
    stream.extend_from_slice(b"AB");
    stream
}

/// Command byte 0x80 is bits 1,0: literal 'Z', then link 0x0000 with a zero length nibble. The
/// next chunk byte 0x02 gives length (2 + 18) = 20 at distance 1, so decoding gives 21 'Z'.
fn extended_length_link() -> Vec<u8> {
    let mut stream = b"Yay0".to_vec();
    stream.extend_from_slice(&21u32.to_be_bytes());
    stream.extend_from_slice(&17u32.to_be_bytes());
    stream.extend_from_slice(&19u32.to_be_bytes());
    stream.push(0x80);
    stream.extend_from_slice(&[0x00, 0x00]);
    stream.extend_from_slice(&[b'Z', 0x02]);
    stream
}

fn set_header_u32(stream: &mut [u8], offset: usize, value: u32) {
    stream[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

#[test]
fn decodes_a_literal_pair_followed_by_an_overlapping_link() {
    let decoded = decode_yay0(&literal_then_link(), NO_LIMIT).expect("decode");
    assert_eq!(decoded, b"ABABABAB");
}

#[test]
fn decodes_an_extended_length_link() {
    let decoded = decode_yay0(&extended_length_link(), NO_LIMIT).expect("decode");
    assert_eq!(decoded, vec![b'Z'; 21]);
}

#[test]
fn decodes_an_empty_output_without_reading_the_tables() {
    let mut stream = literal_then_link();
    set_header_u32(&mut stream, 4, 0);
    assert_eq!(decode_yay0(&stream, NO_LIMIT).expect("decode"), b"");
}

#[test]
fn rejects_inputs_that_are_not_a_complete_stream() {
    let valid = literal_then_link();
    let mut bad_magic = valid.clone();
    bad_magic[0] = b'X';
    let mut link_table_at_end = valid.clone();
    set_header_u32(&mut link_table_at_end, 8, 21);
    let mut header_only = valid[..16].to_vec();
    set_header_u32(&mut header_only, 8, 16);
    set_header_u32(&mut header_only, 12, 16);
    let cases: [(&str, Vec<u8>, &str); 7] = [
        ("empty", Vec::new(), "magic"),
        ("bad magic", bad_magic, "magic"),
        ("header cut short", valid[..15].to_vec(), "16 byte header"),
        (
            "tables beyond a cut stream",
            valid[..16].to_vec(),
            "table offset",
        ),
        ("missing command byte", header_only, "command bits"),
        ("link table at end", link_table_at_end, "link table"),
        ("missing last literal", valid[..20].to_vec(), "chunk table"),
    ];
    for (name, stream, expected) in cases {
        let error = decode_yay0(&stream, NO_LIMIT).expect_err(name).to_string();
        assert!(error.contains(expected), "{name}: {error}");
    }
}

#[test]
fn rejects_a_decoded_length_beyond_the_bound() {
    let valid = literal_then_link();

    // The caller's bound.
    let error = decode_yay0(&valid, 7)
        .expect_err("caller bound")
        .to_string();
    assert!(error.contains("declares 8 decoded byte(s)"), "{error}");

    // 21 stream bytes can expand to at most 21 * 88 = 1848 bytes, however large the caller's bound.
    let mut huge = valid.clone();
    set_header_u32(&mut huge, 4, 1849);
    let error = decode_yay0(&huge, u64::MAX)
        .expect_err("expansion bound")
        .to_string();
    assert!(error.contains("more than the 1848 byte limit"), "{error}");

    set_header_u32(&mut huge, 4, u32::MAX);
    assert!(decode_yay0(&huge, u64::MAX).is_err());
}

#[test]
fn accepts_a_decoded_length_exactly_at_the_bound() {
    let valid = literal_then_link();

    // The caller's bound is inclusive.
    assert_eq!(decode_yay0(&valid, 8).expect("decode"), b"ABABABAB");

    // 21 stream bytes allow 21 * 88 = 1848 decoded bytes. A declared length at that bound passes
    // the limit check; decoding then reads the chunk bytes "AB" as link 0x4142, 323 bytes back.
    let mut at_bound = valid;
    set_header_u32(&mut at_bound, 4, 1848);
    let error = decode_yay0(&at_bound, u64::MAX)
        .expect_err("link past the decoded output")
        .to_string();
    assert!(error.contains("reaches 323 byte(s) back"), "{error}");
}

#[test]
fn rejects_a_link_that_reaches_before_the_start_of_the_output() {
    // Command 0x00 starts with a link, but nothing has been decoded yet: link 0x2000 is
    // distance 1, length 4.
    let mut stream = b"Yay0".to_vec();
    stream.extend_from_slice(&4u32.to_be_bytes());
    stream.extend_from_slice(&17u32.to_be_bytes());
    stream.extend_from_slice(&19u32.to_be_bytes());
    stream.push(0x00);
    stream.extend_from_slice(&[0x20, 0x00]);
    let error = decode_yay0(&stream, NO_LIMIT)
        .expect_err("early link")
        .to_string();
    assert!(error.contains("before the start of the output"), "{error}");

    // 'AB' then distance 3 with only two bytes decoded.
    let mut stream = literal_then_link();
    stream[17..19].copy_from_slice(&[0x40, 0x02]);
    let error = decode_yay0(&stream, NO_LIMIT)
        .expect_err("far link")
        .to_string();
    assert!(error.contains("3 byte(s) back"), "{error}");
}

#[test]
fn rejects_a_link_that_copies_past_the_declared_length() {
    let mut stream = literal_then_link();
    set_header_u32(&mut stream, 4, 6);
    let error = decode_yay0(&stream, NO_LIMIT)
        .expect_err("overrun")
        .to_string();
    assert!(error.contains("past the declared 6 byte length"), "{error}");
}

#[test]
fn rejects_table_offsets_outside_the_stream() {
    let valid = literal_then_link();
    for (name, field, value) in [
        ("link past end", 8, 22),
        ("link far past end", 8, u32::MAX),
        ("link inside header", 8, 15),
        ("chunk past end", 12, 22),
        ("chunk far past end", 12, u32::MAX),
        ("chunk inside header", 12, 0),
    ] {
        let mut stream = valid.clone();
        set_header_u32(&mut stream, field, value);
        let error = decode_yay0(&stream, NO_LIMIT).expect_err(name).to_string();
        assert!(error.contains("table offset"), "{name}: {error}");
    }
}

#[test]
fn rejects_a_chunk_offset_at_the_end_when_a_literal_is_needed() {
    let mut stream = literal_then_link();
    set_header_u32(&mut stream, 12, 21);
    let error = decode_yay0(&stream, NO_LIMIT)
        .expect_err("chunk at end")
        .to_string();
    assert!(error.contains("chunk table"), "{error}");
}
