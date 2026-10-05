#[cfg(kani)]
#[kani::proof]
#[kani::unwind(3)]
fn full_range_single_chunk() {
    // The single-chunk assumption MUST constrain allocation, not integer width.
    // Length and chunk size retain the full u64 range; this checks ceil arithmetic.
    let length: u64 = kani::any();
    let chunk_size: u64 = kani::any();
    kani::assume(chunk_size > 0 && chunk_size >= length);
    let chunks = rom_weaver_core::ChunkPlanner::new(chunk_size)
        .unwrap()
        .plan(length);
    if length == 0 {
        assert!(chunks.is_empty());
    } else {
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].index, 0);
        assert_eq!(chunks[0].offset, 0);
        assert_eq!(chunks[0].len, length);
    }
}
