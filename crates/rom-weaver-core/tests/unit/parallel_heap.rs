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
