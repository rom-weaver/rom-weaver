//! Adjacent-run coalescing shared by the byte-diff create paths.
//!
//! Per-chunk scanners emit runs of consecutive changed output bytes. Merging
//! fuses runs that meet at a chunk boundary.

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

/// Concatenate per-chunk runs in order and fuse adjacent runs.
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
