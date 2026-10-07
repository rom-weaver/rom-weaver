use rom_weaver_containers::nod::read::{DiscOptions, DiscReader};
use std::io::Cursor;

#[test]
fn zero_gcz_block_size_returns_validation_error_without_panicking() {
    let mut header = [0u8; 32];
    header[..4].copy_from_slice(&[0x01, 0xC0, 0x0B, 0xB1]);
    let outcome = std::panic::catch_unwind(|| {
        DiscReader::new_from_cloneable_read(Cursor::new(header), &DiscOptions::default())
    });
    assert!(
        matches!(outcome, Ok(Err(_))),
        "zero GCZ block size must return a validation error without panicking"
    );
}
