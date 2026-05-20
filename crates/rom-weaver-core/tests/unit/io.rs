use std::collections::HashSet;

use super::{ChunkPlanner, TempPathAllocator};

#[test]
fn chunk_planner_splits_ranges() {
    let planner = ChunkPlanner::new(4).expect("planner");
    let chunks = planner.plan(10);
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0].offset, 0);
    assert_eq!(chunks[0].len, 4);
    assert_eq!(chunks[1].offset, 4);
    assert_eq!(chunks[1].len, 4);
    assert_eq!(chunks[2].offset, 8);
    assert_eq!(chunks[2].len, 2);
}

#[test]
fn temp_paths_are_unique() {
    let allocator = TempPathAllocator::new(std::env::temp_dir().join("rom-weaver-tests"));
    let paths = (0..16)
        .map(|_| allocator.next_path("checksum stage", Some("tmp")))
        .collect::<Vec<_>>();
    let unique = paths.iter().collect::<HashSet<_>>();
    assert_eq!(paths.len(), unique.len());
    assert!(
        paths
            .iter()
            .all(|path| path.to_string_lossy().contains("checksum-stage"))
    );
}
