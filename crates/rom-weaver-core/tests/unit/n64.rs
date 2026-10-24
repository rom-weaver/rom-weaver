use super::*;

#[test]
fn ids_and_magics_are_distinct_per_order() {
    assert_eq!(N64ByteOrder::BigEndian.id(), "big-endian");
    assert_eq!(N64ByteOrder::LittleEndian.id(), "little-endian");
    assert_eq!(N64ByteOrder::ByteSwapped.id(), "byte-swapped");
    assert_eq!(N64ByteOrder::BigEndian.magic(), N64_BIG_ENDIAN_MAGIC);
    assert_eq!(N64ByteOrder::LittleEndian.magic(), N64_LITTLE_ENDIAN_MAGIC);
    assert_eq!(N64ByteOrder::ByteSwapped.magic(), N64_BYTE_SWAPPED_MAGIC);
    assert_eq!(N64_BIG_ENDIAN_MAGIC, [0x80, 0x37, 0x12, 0x40]);
    assert_eq!(N64_LITTLE_ENDIAN_MAGIC, [0x40, 0x12, 0x37, 0x80]);
    assert_eq!(N64_BYTE_SWAPPED_MAGIC, [0x37, 0x80, 0x40, 0x12]);
}

#[test]
fn detect_matches_each_magic_with_trailing_bytes() {
    for order in N64ByteOrder::ALL {
        assert_eq!(N64ByteOrder::detect(&order.magic()), Some(order));
        let mut longer = order.magic().to_vec();
        longer.extend_from_slice(&[1, 2, 3, 4, 5]);
        assert_eq!(N64ByteOrder::detect(&longer), Some(order));
    }
}

#[test]
fn detect_rejects_short_and_unknown_prefixes() {
    assert_eq!(N64ByteOrder::detect(&[]), None);
    assert_eq!(N64ByteOrder::detect(&[0x80, 0x37, 0x12]), None);
    assert_eq!(N64ByteOrder::detect(&[0, 0, 0, 0]), None);
    assert_eq!(N64ByteOrder::detect(&[0x80, 0x37, 0x12, 0x41]), None);
}

#[test]
fn transform_word_converts_each_order_to_big_endian() {
    for order in N64ByteOrder::ALL {
        let mut word = order.magic();
        order.transform_word(&mut word);
        assert_eq!(word, N64_BIG_ENDIAN_MAGIC, "{order:?}");
    }
    let mut word = [1, 2, 3, 4];
    N64ByteOrder::LittleEndian.transform_word(&mut word);
    assert_eq!(word, [4, 3, 2, 1]);
    let mut word = [1, 2, 3, 4];
    N64ByteOrder::ByteSwapped.transform_word(&mut word);
    assert_eq!(word, [2, 1, 4, 3]);
    let mut word = [1, 2, 3, 4];
    N64ByteOrder::BigEndian.transform_word(&mut word);
    assert_eq!(word, [1, 2, 3, 4]);
}

#[test]
fn word_helpers_normalize_and_round_trip() {
    assert_eq!(
        N64ByteOrder::BigEndian.word_normalized([1, 2, 3, 4]),
        0x0102_0304
    );
    assert_eq!(
        N64ByteOrder::LittleEndian.word_normalized([1, 2, 3, 4]),
        0x0403_0201
    );
    assert_eq!(
        N64ByteOrder::ByteSwapped.word_normalized([1, 2, 3, 4]),
        0x0201_0403
    );
    assert_eq!(
        N64ByteOrder::BigEndian.word_original_order(0x0102_0304),
        [1, 2, 3, 4]
    );
    assert_eq!(
        N64ByteOrder::LittleEndian.word_original_order(0x0102_0304),
        [4, 3, 2, 1]
    );
    assert_eq!(
        N64ByteOrder::ByteSwapped.word_original_order(0x0102_0304),
        [2, 1, 4, 3]
    );
    for order in N64ByteOrder::ALL {
        let value = 0xDEAD_BEEF;
        assert_eq!(
            order.word_normalized(order.word_original_order(value)),
            value
        );
    }
}
