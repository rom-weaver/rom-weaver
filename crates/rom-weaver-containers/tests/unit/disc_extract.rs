//! Unit coverage for CHD disc-extraction track-layout math and mode
//! dispatch (`src/chd/disc_extract.rs`), which previously had zero direct
//! coverage -- `tests/unit/chd.rs` only exercises `handler_root.rs`.
//!
//! Focuses on pure helpers: the per-frame track router shared by the CD
//! single-bin/split-track/GD-ROM writers, sector-mode byte handling, and the
//! CD output-selection plan. None of these require a real CHD binary.

use rom_weaver_core::ArchiveEntryKindFilter;

use super::*;

/// Builds a `DiscTrack` with sane defaults; callers override only the fields
/// a given test cares about.
fn track(number: u32, mode: DiscTrackMode, frames: u32, pad_frames: u32) -> DiscTrack {
    DiscTrack {
        number,
        mode,
        file_path: PathBuf::from(format!("track{number}.bin")),
        memory_source: None,
        file_offset_bytes: 0,
        frames,
        pregap_frames: 0,
        postgap_frames: 0,
        pregap_has_data: false,
        has_subcode: false,
        pad_frames,
        swap_audio_on_read: false,
    }
}

fn extract_request(selections: Vec<&str>, split_bin: bool) -> ContainerExtractRequest {
    ContainerExtractRequest {
        source: PathBuf::from("game.chd"),
        selections: selections.into_iter().map(str::to_string).collect(),
        kind_filter: ArchiveEntryKindFilter::default(),
        out_dir: PathBuf::from("."),
        split_bin,
        ignore_common_files: false,
        overwrite: true,
        parent: None,
        containing_archive: None,
    }
}

// --- DiscFrameRouter: track offsets/sizes across multi-track layouts -------

#[test]
fn expected_frames_sums_and_saturates() {
    let tracks = [
        track(1, DiscTrackMode::Mode1, 100, 0),
        track(2, DiscTrackMode::Audio, 200, 0),
    ];
    assert_eq!(DiscFrameRouter::expected_frames(&tracks), 300);
    assert_eq!(DiscFrameRouter::expected_frames(&[]), 0);

    // Saturating add: two tracks each claiming u32::MAX frames must not wrap.
    let huge = [
        track(1, DiscTrackMode::Mode1, u32::MAX, 0),
        track(2, DiscTrackMode::Mode1, u32::MAX, 0),
    ];
    assert_eq!(
        DiscFrameRouter::expected_frames(&huge),
        u64::from(u32::MAX) * 2
    );
}

#[test]
fn route_frame_empty_track_list_is_immediately_finished() {
    let tracks: Vec<DiscTrack> = Vec::new();
    let mut router = DiscFrameRouter::new(&tracks);
    assert!(router.finished());
    assert_eq!(router.processed_frames(), 0);

    let frame = vec![0_u8; ChdContainerHandler::CD_FRAME_BYTES as usize];
    let mut emitted = 0;
    router
        .route_frame(&frame, |_, _, _| {
            emitted += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(emitted, 0, "no track to route into");
}

#[test]
fn route_frame_single_track_emits_trimmed_data_bytes() {
    // Mode1 trims each 2352-byte frame down to its 2048-byte data payload.
    let tracks = [track(1, DiscTrackMode::Mode1, 2, 0)];
    let mut router = DiscFrameRouter::new(&tracks);

    let mut frame = vec![0xAA_u8; ChdContainerHandler::CD_FRAME_BYTES as usize];
    frame[0] = 0x11;

    let mut seen = Vec::new();
    router
        .route_frame(&frame, |index, track, data| {
            seen.push((index, track.number, data.len(), data[0]));
            Ok(())
        })
        .unwrap();
    assert_eq!(seen, vec![(0, 1, 2048, 0x11)]);
    assert_eq!(router.processed_frames(), 1);
    assert!(!router.finished());

    router.route_frame(&frame, |_, _, _| Ok(())).unwrap();
    assert_eq!(router.processed_frames(), 2);
    assert!(router.finished(), "both data frames consumed");
}

#[test]
fn route_frame_pad_frames_are_silently_consumed() {
    // 3 data frames + 2 pad frames = 5 total; only the first 3 calls reach `emit`.
    let tracks = [track(1, DiscTrackMode::Mode1Raw, 5, 2)];
    let mut router = DiscFrameRouter::new(&tracks);
    let frame = vec![0_u8; ChdContainerHandler::CD_FRAME_BYTES as usize];

    let mut emit_count = 0;
    for _ in 0..5 {
        assert!(!router.finished());
        router
            .route_frame(&frame, |_, _, _| {
                emit_count += 1;
                Ok(())
            })
            .unwrap();
    }
    assert_eq!(emit_count, 3, "only data frames reach the emit callback");
    assert_eq!(router.processed_frames(), 5);
    assert!(router.finished());
}

#[test]
fn route_frame_advances_across_tracks_including_a_zero_frame_track() {
    let tracks = [
        track(1, DiscTrackMode::Mode1, 1, 0),
        // A degenerate zero-length track: nothing to consume, so the router
        // must skip straight past it without desyncing frame accounting.
        track(2, DiscTrackMode::Mode1, 0, 0),
        track(3, DiscTrackMode::Audio, 1, 0),
    ];
    let mut router = DiscFrameRouter::new(&tracks);
    let frame = vec![0_u8; ChdContainerHandler::CD_FRAME_BYTES as usize];

    let mut track_numbers = Vec::new();
    for _ in 0..2 {
        router
            .route_frame(&frame, |_, track, _| {
                track_numbers.push(track.number);
                Ok(())
            })
            .unwrap();
    }
    assert_eq!(track_numbers, vec![1, 3]);
    assert_eq!(router.processed_frames(), 2);
    assert!(router.finished());
}

#[test]
fn route_frame_is_a_no_op_once_finished() {
    let tracks = [track(1, DiscTrackMode::Mode1, 1, 0)];
    let mut router = DiscFrameRouter::new(&tracks);
    let frame = vec![0_u8; ChdContainerHandler::CD_FRAME_BYTES as usize];
    router.route_frame(&frame, |_, _, _| Ok(())).unwrap();
    assert!(router.finished());

    // Extra frames after the layout is exhausted (e.g. trailing CHD padding)
    // must not panic or re-invoke emit.
    let mut emitted_again = false;
    router
        .route_frame(&frame, |_, _, _| {
            emitted_again = true;
            Ok(())
        })
        .unwrap();
    assert!(!emitted_again);
    assert_eq!(router.processed_frames(), 1);
}

// --- Sector-mode data-byte handling ----------------------------------------

#[test]
fn data_bytes_matches_each_track_mode() {
    assert_eq!(DiscTrackMode::Mode1.data_bytes(), 2048);
    assert_eq!(DiscTrackMode::Mode2Form1.data_bytes(), 2048);
    assert_eq!(DiscTrackMode::Mode2.data_bytes(), 2336);
    assert_eq!(DiscTrackMode::Mode2FormMix.data_bytes(), 2336);
    assert_eq!(DiscTrackMode::Mode2Form2.data_bytes(), 2324);
    assert_eq!(DiscTrackMode::Mode1Raw.data_bytes(), 2352);
    assert_eq!(DiscTrackMode::Mode2Raw.data_bytes(), 2352);
    assert_eq!(DiscTrackMode::Audio.data_bytes(), 2352);
}

#[test]
fn cook_disc_frame_payload_swaps_only_audio_bytes() {
    let audio = track(1, DiscTrackMode::Audio, 1, 0);
    let data = [0x11_u8, 0x22, 0x33, 0x44];
    let cooked = cook_disc_frame_payload(&audio, &data);
    assert_eq!(cooked.as_ref(), &[0x22, 0x11, 0x44, 0x33]);
    assert!(matches!(cooked, std::borrow::Cow::Owned(_)));

    let data_track = track(1, DiscTrackMode::Mode1, 1, 0);
    let cooked = cook_disc_frame_payload(&data_track, &data);
    assert_eq!(cooked.as_ref(), &data);
    // Non-audio tracks pass through the original slice with no copy.
    assert!(matches!(cooked, std::borrow::Cow::Borrowed(_)));
}

#[test]
fn swap_audio_bytes_only_affects_audio_mode() {
    let mut buf = [0x11_u8, 0x22, 0x33, 0x44, 0x55];
    DiscTrackMode::Audio.swap_audio_bytes(&mut buf);
    // Trailing odd byte is left untouched by `chunks_exact_mut(2)`.
    assert_eq!(buf, [0x22, 0x11, 0x44, 0x33, 0x55]);

    let mut untouched = [0x11_u8, 0x22, 0x33, 0x44];
    DiscTrackMode::Mode1.swap_audio_bytes(&mut untouched);
    assert_eq!(untouched, [0x11, 0x22, 0x33, 0x44]);
}

// --- DiscLayout track-offset/size math --------------------------------------

#[test]
fn logical_bytes_sums_track_frame_sizes() {
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            track(1, DiscTrackMode::Mode1, 10, 0),
            track(2, DiscTrackMode::Audio, 20, 0),
        ],
    };
    assert_eq!(
        layout.logical_bytes().unwrap(),
        30 * u64::from(ChdContainerHandler::CD_FRAME_BYTES)
    );
}

#[test]
fn logical_bytes_succeeds_for_track_sizes_near_u32_max() {
    // Neither the per-track multiply nor the running-total add can actually
    // overflow u64 here: `u32::MAX as u64 * CD_FRAME_BYTES` is ~1.05e13, and
    // even summing several such tracks stays far below u64::MAX (~1.8e19) -
    // reaching that would take on the order of a million tracks, not a
    // realistic test fixture. This asserts the near-the-u32-boundary case
    // that `checked_mul`/`checked_add` guard against a false positive on,
    // not the overflow path itself (`logical_bytes` returns `Err` via
    // `checked_add`/`checked_mul`; it never saturates).
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![track(1, DiscTrackMode::Mode1, u32::MAX, 0)],
    };
    let two_huge_tracks = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            track(1, DiscTrackMode::Mode1, u32::MAX, 0),
            track(2, DiscTrackMode::Mode1, u32::MAX, 0),
        ],
    };
    assert!(layout.logical_bytes().is_ok());
    assert!(two_huge_tracks.logical_bytes().is_ok());
}

#[test]
fn apply_cd_track_padding_rounds_up_to_four_frame_boundary() {
    let mut layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            track(1, DiscTrackMode::Mode1, 10, 0), // 10 -> pad 2 -> 12
            track(2, DiscTrackMode::Audio, 12, 0), // already aligned -> pad 0
            track(3, DiscTrackMode::Mode1, 1, 0),  // 1 -> pad 3 -> 4
        ],
    };
    layout.apply_cd_track_padding();
    assert_eq!(
        (layout.tracks[0].frames, layout.tracks[0].pad_frames),
        (12, 2)
    );
    assert_eq!(
        (layout.tracks[1].frames, layout.tracks[1].pad_frames),
        (12, 0)
    );
    assert_eq!(
        (layout.tracks[2].frames, layout.tracks[2].pad_frames),
        (4, 3)
    );
}

#[test]
fn apply_cd_track_padding_is_a_no_op_for_gd_rom() {
    // GD-ROM layouts declare padding explicitly via the PAD field and must
    // not have this CD-only rounding applied on top.
    let mut layout = DiscLayout {
        kind: DiscKind::GdRom,
        tracks: vec![track(1, DiscTrackMode::Mode1, 10, 0)],
    };
    layout.apply_cd_track_padding();
    assert_eq!(layout.tracks[0].frames, 10);
    assert_eq!(layout.tracks[0].pad_frames, 0);
}

// --- CD selection plan: single-bin vs split-track mode dispatch -------------

#[test]
fn plan_cd_selection_uses_single_bin_when_modes_match_and_not_forced_split() {
    let handler = ChdContainerHandler;
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            track(1, DiscTrackMode::Mode1, 10, 0),
            track(2, DiscTrackMode::Mode1, 10, 0),
        ],
    };
    let request = extract_request(vec![], false);
    let plan = handler
        .plan_cd_selection(&layout, &request, "game")
        .unwrap();
    assert!(plan.single_bin);
    assert!(plan.write_single_bin);
    assert!(plan.split_track_names.is_empty());
}

#[test]
fn plan_cd_selection_splits_when_track_modes_differ() {
    let handler = ChdContainerHandler;
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            track(1, DiscTrackMode::Mode1, 10, 0),
            track(2, DiscTrackMode::Audio, 10, 0),
        ],
    };
    let request = extract_request(vec![], false);
    let plan = handler
        .plan_cd_selection(&layout, &request, "game")
        .unwrap();
    assert!(
        !plan.single_bin,
        "mixed track modes cannot share one .bin layout"
    );
    assert_eq!(
        plan.split_track_names,
        vec![
            handler.track_output_name("game", 1),
            handler.track_output_name("game", 2),
        ]
    );
    assert_eq!(plan.write_split_tracks, vec![true, true]);
}

#[test]
fn plan_cd_selection_honors_explicit_split_bin_request() {
    let handler = ChdContainerHandler;
    // Uniform track modes would normally use a single bin, but `split_bin`
    // forces per-track output.
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            track(1, DiscTrackMode::Mode1, 10, 0),
            track(2, DiscTrackMode::Mode1, 10, 0),
        ],
    };
    let request = extract_request(vec![], true);
    let plan = handler
        .plan_cd_selection(&layout, &request, "game")
        .unwrap();
    assert!(!plan.single_bin);
    assert_eq!(plan.split_track_names.len(), 2);
}

#[test]
fn plan_cd_selection_filters_to_a_specific_track_selection() {
    let handler = ChdContainerHandler;
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            track(1, DiscTrackMode::Mode1, 10, 0),
            track(2, DiscTrackMode::Audio, 10, 0),
        ],
    };
    let track_two_name = handler.track_output_name("game", 2);
    let request = extract_request(vec![track_two_name.as_str()], false);
    let plan = handler
        .plan_cd_selection(&layout, &request, "game")
        .unwrap();
    assert!(plan.selection_requested);
    assert!(!plan.write_cue, "the cue itself was not selected");
    assert_eq!(plan.write_split_tracks, vec![false, true]);
}

#[test]
fn plan_cd_selection_rejects_a_selection_matching_nothing() {
    let handler = ChdContainerHandler;
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![track(1, DiscTrackMode::Mode1, 10, 0)],
    };
    let request = extract_request(vec!["nonexistent-track.bin"], false);
    let err = match handler.plan_cd_selection(&layout, &request, "game") {
        Ok(_) => panic!("expected a selection-mismatch error"),
        Err(err) => err,
    };
    assert!(matches!(err, RomWeaverError::Validation(_)));
}

#[test]
fn track_output_name_formats_with_track_number() {
    let handler = ChdContainerHandler;
    assert_eq!(handler.track_output_name("Sonic", 3), "Sonic (Track 3).bin");
}
