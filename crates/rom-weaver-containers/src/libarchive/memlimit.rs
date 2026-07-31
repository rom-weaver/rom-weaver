//! Shared runtime memory ceiling for the vendored 7z reader's LZMA/LZMA2 decoders.
//!
//! Bare LZMA streams use the 7-Zip SDK; filtered chains use liblzma. The SDK
//! glue reserves from this pool while allocating, and staged libarchive source
//! reserves `lzma_raw_decoder_memusage()` before constructing its fallback.

use std::sync::{Mutex, Once};

use rom_weaver_core::{env_u64_opt, physical_memory_bytes};
use tracing::debug;

const MIB: u64 = 1024 * 1024;

#[cfg(target_family = "wasm")]
const FALLBACK_BUDGET_BYTES: u64 = 1024 * MIB;
#[cfg(not(target_family = "wasm"))]
const FALLBACK_BUDGET_BYTES: u64 = 2048 * MIB;

// A 64 MiB dictionary needs a little more for decoder probabilities and state.
const MIN_LIMIT_BYTES: u64 = 65 * MIB;
const BUDGET_SHARE_DIVISOR: u64 = 2;

struct DecoderMemoryPool {
    limit: u64,
    reserved: u64,
}

impl DecoderMemoryPool {
    const fn new() -> Self {
        Self {
            limit: 0,
            reserved: 0,
        }
    }

    fn reserve(&mut self, bytes: u64) -> bool {
        let Some(total) = self.reserved.checked_add(bytes) else {
            return false;
        };
        if self.limit != 0 && total > self.limit {
            return false;
        }
        self.reserved = total;
        true
    }

    fn release(&mut self, bytes: u64) {
        if let Some(remaining) = self.reserved.checked_sub(bytes) {
            self.reserved = remaining;
        }
    }
}

static DECODER_MEMORY_POOL: Mutex<DecoderMemoryPool> = Mutex::new(DecoderMemoryPool::new());

#[unsafe(no_mangle)]
pub extern "C" fn rw_lzma_dec_memlimit() -> u64 {
    DECODER_MEMORY_POOL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .limit
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_lzma_dec_reserve(bytes: u64) -> i32 {
    let mut pool = DECODER_MEMORY_POOL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    i32::from(pool.reserve(bytes))
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_lzma_dec_release(bytes: u64) {
    let mut pool = DECODER_MEMORY_POOL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pool.release(bytes);
}

fn limit_for_budget(budget: u64) -> u64 {
    (budget / BUDGET_SHARE_DIVISOR).max(MIN_LIMIT_BYTES)
}

fn lzma_decoder_memlimit_bytes() -> u64 {
    let budget = env_u64_opt("ROM_WEAVER_7Z_MEM_BUDGET_MB")
        .map(|mb| mb.saturating_mul(MIB))
        .or_else(|| {
            physical_memory_bytes().map(|ram| {
                if cfg!(target_family = "wasm") {
                    ram
                } else {
                    ram / 2
                }
            })
        })
        .unwrap_or(FALLBACK_BUDGET_BYTES);
    limit_for_budget(budget)
}

pub(crate) fn install_lzma_decoder_memlimit() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let limit = lzma_decoder_memlimit_bytes();
        DECODER_MEMORY_POOL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .limit = limit;
        debug!(
            limit_bytes = limit,
            "installing shared 7z lzma decoder memory limit"
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_includes_overhead_for_a_typical_dictionary() {
        assert_eq!(limit_for_budget(128 * MIB), 65 * MIB);
    }

    #[test]
    fn small_budget_rejects_the_format_maximum() {
        assert!(limit_for_budget(1024 * MIB) < 1536 * MIB);
    }

    #[test]
    fn reservations_share_one_limit() {
        let mut pool = DecoderMemoryPool {
            limit: 512 * MIB,
            reserved: 0,
        };

        assert!(pool.reserve(384 * MIB));
        assert!(!pool.reserve(384 * MIB));
        pool.release(384 * MIB);
        assert!(pool.reserve(384 * MIB));
    }
}
