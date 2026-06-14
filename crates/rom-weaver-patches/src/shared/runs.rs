//! Adjacent-run coalescing shared by the byte-diff create paths.
//!
//! The per-chunk scanners emit runs of consecutive changed output bytes;
//! merging the per-chunk run vectors fuses runs that abut across a chunk
//! boundary. The merge loop was previously duplicated byte-for-byte across the
//! IPS, APS-N64, and MOD/PMSR create paths (only the run type and its payload
//! field name differed).

use rom_weaver_core::Result;

/// A run of changed output bytes that can be fused with an immediately
/// following run. Implementors expose their start offset, their exclusive end
/// offset (fallibly, since it can overflow `u64`), and an append that absorbs
/// the next run's payload.
pub(crate) trait AdjacentRun: Sized {
    fn start(&self) -> u64;
    fn end(&self) -> Result<u64>;
    fn append(&mut self, next: Self);
}

/// Concatenates the per-chunk run vectors in order, fusing each run into the
/// previous one when it begins exactly where the previous run ends. Identical
/// to the per-format loops it replaces, so create output is unchanged.
pub(crate) fn merge_adjacent_runs<R: AdjacentRun>(chunk_runs: Vec<Vec<R>>) -> Result<Vec<R>> {
    let mut merged = Vec::<R>::new();
    for runs in chunk_runs {
        for run in runs {
            if let Some(last) = merged.last_mut()
                && last.end()? == run.start()
            {
                last.append(run);
                continue;
            }
            merged.push(run);
        }
    }
    Ok(merged)
}
