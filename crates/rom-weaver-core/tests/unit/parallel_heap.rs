use super::parallel_heap_reserve;

const MIB: usize = 1024 * 1024;

#[test]
fn parallel_heap_reserve_covers_each_worker_stack_and_scratch_plus_a_margin() {
    assert_eq!(parallel_heap_reserve(0), 32 * MIB);
    assert_eq!(parallel_heap_reserve(1), 36 * MIB);
    // 16 workers measured ~40 MiB of in-section growth for CD FLAC CHD create in Chromium.
    assert_eq!(parallel_heap_reserve(16), 96 * MIB);
}

#[test]
fn parallel_heap_reserve_saturates_instead_of_overflowing() {
    assert_eq!(parallel_heap_reserve(usize::MAX), usize::MAX);
}

#[cfg(not(target_family = "wasm"))]
#[test]
fn reserve_parallel_heap_is_a_no_op_off_wasm() {
    use super::{reserve_parallel_heap, wasm_heap_pages};

    reserve_parallel_heap(usize::MAX);
    assert_eq!(wasm_heap_pages(), None);
}

#[test]
fn reserve_block_reports_a_refused_reservation_instead_of_aborting() {
    use super::reserve_block;

    assert!(reserve_block(MIB));
    assert!(!reserve_block(usize::MAX));
}

#[test]
fn reserve_with_fallback_halves_until_a_block_is_granted() {
    use super::reserve_with_fallback;

    let mut asked = Vec::new();
    let granted = reserve_with_fallback(256 * MIB, 32 * MIB, |size| {
        asked.push(size);
        size <= 70 * MIB
    });
    assert_eq!(granted, Some(64 * MIB));
    assert_eq!(asked, [256 * MIB, 128 * MIB, 64 * MIB]);
}

#[test]
fn reserve_with_fallback_stops_at_the_floor() {
    use super::reserve_with_fallback;

    let mut asked = Vec::new();
    let granted = reserve_with_fallback(100 * MIB, 32 * MIB, |size| {
        asked.push(size);
        false
    });
    assert_eq!(granted, None);
    assert_eq!(asked, [100 * MIB, 50 * MIB, 32 * MIB]);
    // A request already at or below the floor is tried once.
    assert_eq!(reserve_with_fallback(MIB, 32 * MIB, |_| false), None);
}
