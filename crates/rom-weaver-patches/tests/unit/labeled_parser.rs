use std::io::Cursor;

use super::LabeledFileParser;

fn parser(bytes: Vec<u8>) -> LabeledFileParser<Cursor<Vec<u8>>> {
    let len = bytes.len() as u64;
    LabeledFileParser::new(Cursor::new(bytes), len, "TEST", "u64")
}

#[test]
fn fixed_width_reads_consume_the_stream_in_order() {
    let mut parser = parser(vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);

    assert_eq!(parser.read_u8("byte").expect("u8"), 0x01);
    assert_eq!(parser.read_u16_le("half").expect("u16"), 0x0302);
    assert_eq!(parser.read_u32_le("word le").expect("u32 le"), 0x0706_0504);
    assert_eq!(parser.remaining(), 2);
    assert_eq!(
        parser.read_exact(2, "tail").expect("tail"),
        vec![0x08, 0x09]
    );
    assert_eq!(parser.remaining(), 0);
}

#[test]
fn big_endian_words_read_from_the_same_cursor() {
    let mut parser = parser(vec![0xDE, 0xAD, 0xBE, 0xEF]);

    assert_eq!(parser.read_u32_be("word be").expect("u32 be"), 0xDEAD_BEEF);
}

#[test]
fn a_read_past_the_declared_length_names_the_format_and_the_field() {
    let mut parser = parser(vec![0x01, 0x02]);

    let error = parser
        .read_u32_le("record header")
        .expect_err("reading past the end should fail");
    assert_eq!(
        error.to_string(),
        "validation failed: TEST patch ended unexpectedly while reading record header"
    );
    // The failed read consumes nothing, so the cursor is still where it was.
    assert_eq!(parser.remaining(), 2);
}
