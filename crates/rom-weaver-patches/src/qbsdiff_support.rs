use rom_weaver_core::ThreadCapability;

const QBSDIFF_MIN_PARALLEL_TARGET_BYTES: usize = 256 * 1024;

pub(crate) fn qbsdiff_thread_capability(target_len: usize) -> ThreadCapability {
    if target_len > QBSDIFF_MIN_PARALLEL_TARGET_BYTES {
        ThreadCapability::parallel(None)
    } else {
        ThreadCapability::single_threaded()
    }
}
