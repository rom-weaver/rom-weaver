use super::*;

const PBP_MAGIC: [u8; 4] = [0x00, b'P', b'B', b'P'];
const PBP_HEADER_LEN: usize = 0x28;

fn pbp_header(len: usize, psar_offset: u32) -> Vec<u8> {
    let mut header = vec![0u8; len];
    header[..4].copy_from_slice(&PBP_MAGIC);
    if len >= PBP_HEADER_LEN {
        header[0x24..0x28].copy_from_slice(&psar_offset.to_le_bytes());
    }
    header
}

#[test]
fn pbp_header_of_exact_minimum_length_is_read() {
    let header = pbp_header(PBP_HEADER_LEN, 0x28);
    assert!(pbp_has_empty_psar(&header, 0x28));
    assert!(!pbp_has_empty_psar(&header, 0x29));
}

#[test]
fn truncated_pbp_header_is_rejected_without_panicking() {
    for len in PBP_MAGIC.len()..PBP_HEADER_LEN {
        let header = pbp_header(len, 0);
        assert!(!pbp_has_empty_psar(&header, 0), "prefix length {len}");
    }
}

#[test]
fn non_pbp_header_of_full_length_is_rejected() {
    let mut header = pbp_header(PBP_HEADER_LEN, 0x28);
    header[1] = b'X';
    assert!(!pbp_has_empty_psar(&header, 0x28));
}
