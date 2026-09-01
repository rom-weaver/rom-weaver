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

// --- Cue / gdi sheet parsing ------------------------------------------------

/// Per-test scratch directory. The label keeps parallel tests from sharing a
/// path; the caller removes the tree when the test ends.
fn scratch_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rw-chd-disc-extract-{}-{label}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write fixture file");
    path
}

/// `frames` raw 2352-byte CD frames with a per-frame marker byte so track
/// offsets are distinguishable in round-trip assertions.
fn raw_frames(frames: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; frames * 2352];
    for (index, chunk) in bytes.chunks_mut(2352).enumerate() {
        chunk[0] = (index % 251) as u8;
    }
    bytes
}

#[test]
fn parse_cue_file_resolves_track_offsets_and_applies_cd_padding() {
    let dir = scratch_dir("cue-basic");
    write_file(&dir, "game.bin", &raw_frames(15));
    let cue = write_file(
        &dir,
        "game.cue",
        concat!(
            "REM GENRE Action\n",
            "TITLE \"Some Game\"\n",
            "PERFORMER \"Nobody\"\n",
            "CATALOG 0000000000000\n",
            "FILE \"game.bin\" BINARY\n",
            "  TRACK 01 MODE1/2352\n",
            "    INDEX 01 00:00:00\n",
            "  TRACK 02 AUDIO\n",
            "    ISRC ABCDE0000000\n",
            "    INDEX 01 00:00:10\n",
        )
        .as_bytes(),
    );

    let handler = ChdContainerHandler;
    let layout = handler.parse_cue_file(&cue).expect("parse cue");
    assert_eq!(layout.kind, DiscKind::CdRom);
    assert_eq!(layout.tracks.len(), 2);

    let first = &layout.tracks[0];
    assert_eq!(first.number, 1);
    assert_eq!(first.mode, DiscTrackMode::Mode1Raw);
    assert_eq!(first.file_offset_bytes, 0);
    // 10 data frames rounded up to the 4-frame CD boundary.
    assert_eq!((first.frames, first.pad_frames), (12, 2));
    assert!(first.swap_audio_on_read, "BINARY cue files store audio LE");

    let second = &layout.tracks[1];
    assert_eq!(second.number, 2);
    assert_eq!(second.mode, DiscTrackMode::Audio);
    assert_eq!(second.file_offset_bytes, 10 * 2352);
    assert_eq!((second.frames, second.pad_frames), (8, 3));
    assert_eq!(second.pregap_frames, 0);
    assert!(!second.pregap_has_data);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_cue_file_reads_motorola_files_without_audio_swapping() {
    let dir = scratch_dir("cue-motorola");
    write_file(&dir, "game.bin", &raw_frames(4));
    let cue = write_file(
        &dir,
        "game.cue",
        b"FILE \"game.bin\" MOTOROLA\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n",
    );

    let layout = ChdContainerHandler.parse_cue_file(&cue).expect("parse cue");
    assert!(
        !layout.tracks[0].swap_audio_on_read,
        "MOTOROLA cue files already store audio big-endian"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_cue_file_keeps_pregap_and_postgap_directives() {
    let dir = scratch_dir("cue-gaps");
    write_file(&dir, "game.bin", &raw_frames(15));
    let cue = write_file(
        &dir,
        "game.cue",
        concat!(
            "FILE \"game.bin\" BINARY\n",
            "  TRACK 01 MODE1/2352\n",
            "    INDEX 01 00:00:00\n",
            "  TRACK 02 AUDIO\n",
            "    PREGAP 00:00:02\n",
            "    INDEX 01 00:00:10\n",
            "    POSTGAP 00:00:03\n",
        )
        .as_bytes(),
    );

    let layout = ChdContainerHandler.parse_cue_file(&cue).expect("parse cue");
    let second = &layout.tracks[1];
    assert_eq!(second.pregap_frames, 2);
    assert_eq!(second.postgap_frames, 3);
    assert!(
        !second.pregap_has_data,
        "a PREGAP directive declares silence, not stored frames"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_cue_file_treats_index_00_as_a_pregap_with_data() {
    let dir = scratch_dir("cue-index00");
    write_file(&dir, "game.bin", &raw_frames(12));
    let cue = write_file(
        &dir,
        "game.cue",
        concat!(
            "FILE \"game.bin\" BINARY\n",
            "  TRACK 01 MODE1/2352\n",
            "    INDEX 01 00:00:00\n",
            "  TRACK 02 AUDIO\n",
            "    INDEX 00 00:00:08\n",
            "    INDEX 01 00:00:10\n",
        )
        .as_bytes(),
    );

    let layout = ChdContainerHandler.parse_cue_file(&cue).expect("parse cue");
    // Track 1 ends where track 2's INDEX 00 begins, not at its INDEX 01.
    assert_eq!(layout.tracks[0].frames, 8);
    let second = &layout.tracks[1];
    assert_eq!(second.file_offset_bytes, 8 * 2352);
    assert_eq!(second.pregap_frames, 2);
    assert!(second.pregap_has_data);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_cue_file_accepts_a_wave_audio_track() {
    let dir = scratch_dir("cue-wave");
    write_file(&dir, "game.bin", &raw_frames(4));
    write_file(&dir, "track02.wav", &pcm_wave_bytes(3));
    let cue = write_file(
        &dir,
        "game.cue",
        concat!(
            "FILE \"game.bin\" BINARY\n",
            "  TRACK 01 MODE1/2352\n",
            "    INDEX 01 00:00:00\n",
            "FILE \"track02.wav\" WAVE\n",
            "  TRACK 02 AUDIO\n",
            "    INDEX 01 00:00:00\n",
        )
        .as_bytes(),
    );

    let layout = ChdContainerHandler.parse_cue_file(&cue).expect("parse cue");
    let second = &layout.tracks[1];
    assert_eq!(second.mode, DiscTrackMode::Audio);
    // The WAVE data chunk starts after the 12-byte RIFF header, the 24-byte
    // fmt chunk, and the 8-byte data chunk header.
    assert_eq!(second.file_offset_bytes, 44);
    assert_eq!(second.frames, 4, "3 data frames padded to the CD boundary");
    assert_eq!(second.pad_frames, 1);

    let _ = fs::remove_dir_all(&dir);
}

/// A minimal 44.1 kHz 16-bit stereo PCM WAVE file holding `frames` CD frames.
fn pcm_wave_bytes(frames: usize) -> Vec<u8> {
    let data_len = frames * 2352;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&2_u16.to_le_bytes()); // stereo
    bytes.extend_from_slice(&44_100_u32.to_le_bytes());
    bytes.extend_from_slice(&176_400_u32.to_le_bytes());
    bytes.extend_from_slice(&4_u16.to_le_bytes()); // block align
    bytes.extend_from_slice(&16_u16.to_le_bytes()); // bits per sample
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
    bytes.resize(bytes.len() + data_len, 0);
    bytes
}

#[test]
fn parse_cue_file_rejects_a_wave_file_backing_a_data_track() {
    let dir = scratch_dir("cue-wave-data");
    write_file(&dir, "track01.wav", &pcm_wave_bytes(2));
    let cue = write_file(
        &dir,
        "game.cue",
        b"FILE \"track01.wav\" WAVE\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    );

    let err = ChdContainerHandler
        .parse_cue_file(&cue)
        .expect_err("a WAVE file cannot back a data track");
    assert!(
        err.to_string().contains("WAVE file for non-audio track"),
        "unexpected error: {err}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_cue_file_rejects_malformed_sheets() {
    let dir = scratch_dir("cue-errors");
    write_file(&dir, "game.bin", &raw_frames(4));
    write_file(&dir, "odd.bin", &[0_u8; 2353]);
    let handler = ChdContainerHandler;
    let cue = dir.join("game.cue");

    let cases: [(&str, &str); 18] = [
        ("FILE\n", "invalid FILE entry"),
        ("FILE \"game.bin\"\n", "missing FILE type"),
        (
            "FILE \"game.bin\" AIFF\n",
            "accepts BINARY, MOTOROLA, and WAVE files",
        ),
        (
            "  TRACK 01 MODE1/2352\n",
            "TRACK entry appeared before FILE",
        ),
        ("FILE \"game.bin\" BINARY\n  TRACK\n", "invalid TRACK entry"),
        (
            "FILE \"game.bin\" BINARY\n  TRACK 01\n",
            "missing TRACK type",
        ),
        (
            "FILE \"game.bin\" BINARY\n  TRACK xx MODE1/2352\n",
            "invalid TRACK number `xx`",
        ),
        (
            "FILE \"game.bin\" BINARY\n  TRACK 01 MODE9\n",
            "unsupported disc track type",
        ),
        (
            "FILE \"game.bin\" BINARY\n    INDEX 01 00:00:00\n",
            "INDEX entry appeared before TRACK",
        ),
        (
            "FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX\n",
            "invalid INDEX entry",
        ),
        (
            "FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01\n",
            "missing INDEX time",
        ),
        (
            "FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 02 00:00:00\n",
            "accepts INDEX 00 and INDEX 01",
        ),
        (
            "FILE \"game.bin\" BINARY\n    PREGAP 00:00:02\n",
            "PREGAP entry appeared before TRACK",
        ),
        (
            "FILE \"game.bin\" BINARY\n    POSTGAP 00:00:02\n",
            "POSTGAP entry appeared before TRACK",
        ),
        ("WOMBAT 1\n", "unsupported directive `WOMBAT`"),
        ("REM nothing at all\n\n", "did not define any tracks"),
        (
            "FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n",
            "is missing INDEX 01",
        ),
        (
            concat!(
                "FILE \"game.bin\" BINARY\n",
                "  TRACK 01 MODE1/2352\n",
                "    PREGAP 00:00:01\n",
                "    INDEX 00 00:00:00\n",
                "    INDEX 01 00:00:01\n",
            ),
            "uses both INDEX 00 and PREGAP",
        ),
    ];

    for (body, expected) in cases {
        fs::write(&cue, body).expect("write cue");
        let err = match handler.parse_cue_file(&cue) {
            Ok(_) => panic!("expected an error for cue body {body:?}"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains(expected),
            "cue body {body:?} produced {err}"
        );
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_cue_file_rejects_inconsistent_track_geometry() {
    let dir = scratch_dir("cue-geometry");
    write_file(&dir, "game.bin", &raw_frames(4));
    write_file(&dir, "odd.bin", &[0_u8; 2353]);
    let handler = ChdContainerHandler;
    let cue = dir.join("game.cue");

    let cases: [(&str, &str); 4] = [
        (
            "FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:10\n",
            "starts past the end of",
        ),
        (
            concat!(
                "FILE \"game.bin\" BINARY\n",
                "  TRACK 01 MODE1/2352\n",
                "    INDEX 01 00:00:00\n",
                "  TRACK 02 MODE1/2048\n",
                "    INDEX 01 00:00:01\n",
            ),
            "across tracks with different sector sizes",
        ),
        (
            concat!(
                "FILE \"game.bin\" BINARY\n",
                "  TRACK 01 MODE1/2352\n",
                "    INDEX 01 00:00:02\n",
                "  TRACK 02 MODE1/2352\n",
                "    INDEX 01 00:00:00\n",
            ),
            "descending frame offsets",
        ),
        (
            "FILE \"odd.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
            "is not divisible by 2352 bytes",
        ),
    ];

    for (body, expected) in cases {
        fs::write(&cue, body).expect("write cue");
        let err = match handler.parse_cue_file(&cue) {
            Ok(_) => panic!("expected an error for cue body {body:?}"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains(expected),
            "cue body {body:?} produced {err}"
        );
    }

    let _ = fs::remove_dir_all(&dir);
}

// --- Disc-input auto-detection ---------------------------------------------

#[test]
fn parse_disc_input_synthesizes_a_gd_rom_from_high_density_markers() {
    let dir = scratch_dir("cue-high-density");
    write_file(&dir, "game.bin", &raw_frames(15));
    let cue = write_file(
        &dir,
        "game.cue",
        concat!(
            "FILE \"game.bin\" BINARY\n",
            "  TRACK 01 MODE1/2352\n",
            "    INDEX 01 00:00:00\n",
            "REM HIGH-DENSITY AREA\n",
            "  TRACK 02 MODE1/2352\n",
            "    INDEX 01 00:00:10\n",
        )
        .as_bytes(),
    );

    let layout = ChdContainerHandler
        .parse_disc_input(&cue)
        .expect("parse disc input");
    assert_eq!(layout.kind, DiscKind::GdRom);
    // The high-density area is anchored at LBA 45000, so track 1's gap to it
    // becomes padding rather than stored frames.
    assert_eq!(layout.tracks[0].pad_frames, 45000 - 10);
    assert_eq!(layout.tracks[0].frames, 45000);
    assert_eq!(layout.tracks[1].frames, 5);
    assert_eq!(layout.tracks[1].pad_frames, 0);
    assert_eq!(layout.tracks[1].pregap_frames, 0);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_disc_input_falls_back_to_cd_rom_without_markers() {
    let dir = scratch_dir("cue-plain-disc-input");
    write_file(&dir, "game.bin", &raw_frames(10));
    let cue = write_file(
        &dir,
        "game.cue",
        b"FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    );

    let layout = ChdContainerHandler
        .parse_disc_input(&cue)
        .expect("parse disc input");
    assert_eq!(layout.kind, DiscKind::CdRom);
    assert_eq!(layout.tracks[0].frames, 12);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_disc_input_prefers_a_sibling_gdi_over_the_cue() {
    let dir = scratch_dir("cue-sibling-gdi");
    write_file(&dir, "game.bin", &raw_frames(10));
    write_file(&dir, "track01.bin", &raw_frames(4));
    write_file(&dir, "game.gdi", b"1\n1 0 4 2352 \"track01.bin\" 0\n");
    let cue = write_file(
        &dir,
        "game.cue",
        b"FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    );

    let layout = ChdContainerHandler
        .parse_disc_input(&cue)
        .expect("parse disc input");
    assert_eq!(layout.kind, DiscKind::GdRom);
    assert_eq!(layout.tracks.len(), 1);
    assert_eq!(
        layout.tracks[0].file_path,
        dir.join("track01.bin"),
        "the sibling .gdi's own track file is authoritative"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_disc_input_ignores_a_gdi_next_to_a_non_cue_sheet() {
    let dir = scratch_dir("cue-non-cue-extension");
    write_file(&dir, "game.bin", &raw_frames(10));
    write_file(&dir, "track01.bin", &raw_frames(4));
    write_file(&dir, "game.gdi", b"1\n1 0 4 2352 \"track01.bin\" 0\n");
    // A sheet whose extension is not `.cue` never looks for a sibling `.gdi`.
    let sheet = write_file(
        &dir,
        "game.txt",
        b"FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    );

    let layout = ChdContainerHandler
        .parse_disc_input(&sheet)
        .expect("parse disc input");
    assert_eq!(layout.kind, DiscKind::CdRom);

    let _ = fs::remove_dir_all(&dir);
}

// --- gdi sheet parsing ------------------------------------------------------

#[test]
fn parse_gdi_file_resolves_physical_offsets_into_pad_frames() {
    let dir = scratch_dir("gdi-basic");
    write_file(&dir, "track01.bin", &raw_frames(4));
    write_file(&dir, "track02.raw", &raw_frames(2));
    write_file(&dir, "track03.bin", &raw_frames(4));
    let gdi = write_file(
        &dir,
        "game.gdi",
        concat!(
            "3\n",
            "1 0 4 2352 \"track01.bin\" 0\n",
            "2 10 0 2352 \"track02.raw\" 0\n",
            "3 45000 4 2352 \"track03.bin\" 0\n",
        )
        .as_bytes(),
    );

    let layout = ChdContainerHandler.parse_gdi_file(&gdi).expect("parse gdi");
    assert_eq!(layout.kind, DiscKind::GdRom);
    assert_eq!(layout.tracks.len(), 3);

    assert_eq!(layout.tracks[0].mode, DiscTrackMode::Mode1Raw);
    assert!(!layout.tracks[0].swap_audio_on_read);
    assert_eq!(
        (layout.tracks[0].frames, layout.tracks[0].pad_frames),
        (10, 6)
    );

    assert_eq!(layout.tracks[1].mode, DiscTrackMode::Audio);
    assert!(layout.tracks[1].swap_audio_on_read);
    assert_eq!(
        (layout.tracks[1].frames, layout.tracks[1].pad_frames),
        (45000 - 10, 45000 - 12)
    );

    assert_eq!(layout.tracks[2].frames, 4);
    assert_eq!(layout.tracks[2].pad_frames, 0, "the last track never pads");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_gdi_file_accepts_cooked_sectors_and_a_file_offset() {
    let dir = scratch_dir("gdi-cooked");
    // 2048-byte sectors with a 2048-byte prefix skipped by the file offset.
    write_file(&dir, "track01.bin", &[0_u8; 2048 * 4]);
    let gdi = write_file(&dir, "game.gdi", b"1\n1 0 4 2048 \"track01.bin\" 2048\n");

    let layout = ChdContainerHandler.parse_gdi_file(&gdi).expect("parse gdi");
    assert_eq!(layout.tracks[0].mode, DiscTrackMode::Mode1);
    assert_eq!(layout.tracks[0].file_offset_bytes, 2048);
    assert_eq!(layout.tracks[0].frames, 3);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_gdi_file_sorts_out_of_order_track_entries() {
    let dir = scratch_dir("gdi-sorted");
    write_file(&dir, "track01.bin", &raw_frames(4));
    write_file(&dir, "track02.bin", &raw_frames(4));
    let gdi = write_file(
        &dir,
        "game.gdi",
        b"2\n2 4 4 2352 \"track02.bin\" 0\n1 0 4 2352 \"track01.bin\" 0\n",
    );

    let layout = ChdContainerHandler.parse_gdi_file(&gdi).expect("parse gdi");
    assert_eq!(
        layout.tracks.iter().map(|t| t.number).collect::<Vec<_>>(),
        vec![1, 2]
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_gdi_file_rejects_malformed_sheets() {
    let dir = scratch_dir("gdi-errors");
    write_file(&dir, "track01.bin", &raw_frames(4));
    write_file(&dir, "odd.bin", &[0_u8; 2353]);
    let handler = ChdContainerHandler;
    let gdi = dir.join("game.gdi");

    let cases: [(&str, &str); 16] = [
        ("abc\n", "invalid track count header"),
        ("0\n", "does not define any tracks"),
        ("\n   \n", "missing its track count header"),
        ("1\n\"unterminated\n", "invalid gdi track entry"),
        ("1\n1\n", "missing its physical offset"),
        ("1\n1 0\n", "missing its track type"),
        ("1\n1 0 4\n", "missing its sector size"),
        ("1\n1 0 4 2352\n", "missing its filename"),
        ("1\n1 0 4 2352 \"track01.bin\"\n", "missing its file offset"),
        (
            "1\nx 0 4 2352 \"track01.bin\" 0\n",
            "invalid track number `x`",
        ),
        (
            "1\n1 x 4 2352 \"track01.bin\" 0\n",
            "invalid physical offset `x`",
        ),
        (
            "1\n1 0 x 2352 \"track01.bin\" 0\n",
            "invalid track type `x`",
        ),
        ("1\n1 0 4 x \"track01.bin\" 0\n", "invalid sector size `x`"),
        (
            "1\n1 0 4 2352 \"track01.bin\" x\n",
            "invalid file offset `x`",
        ),
        (
            "1\n1 0 7 1234 \"track01.bin\" 0\n",
            "unsupported track type/sector-size pair `7/1234`",
        ),
        (
            "1\n1 0 4 2352 \"odd.bin\" 0\n",
            "is not divisible by 2352 bytes",
        ),
    ];

    for (body, expected) in cases {
        fs::write(&gdi, body).expect("write gdi");
        let err = match handler.parse_gdi_file(&gdi) {
            Ok(_) => panic!("expected an error for gdi body {body:?}"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains(expected),
            "gdi body {body:?} produced {err}"
        );
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_gdi_file_rejects_inconsistent_track_tables() {
    let dir = scratch_dir("gdi-tables");
    write_file(&dir, "track01.bin", &raw_frames(4));
    write_file(&dir, "track02.bin", &raw_frames(4));
    let handler = ChdContainerHandler;
    let gdi = dir.join("game.gdi");

    let cases: [(&str, &str); 4] = [
        (
            "1\n1 0 4 2352 \"track01.bin\" 99999\n",
            "starts past the end of",
        ),
        (
            "2\n1 0 4 2352 \"track01.bin\" 0\n",
            "declared 2 tracks but defined 1",
        ),
        (
            concat!(
                "2\n",
                "1 0 4 2352 \"track01.bin\" 0\n",
                "3 4 4 2352 \"track02.bin\" 0\n",
            ),
            "is missing track 2",
        ),
        (
            concat!(
                "2\n",
                "1 0 4 2352 \"track01.bin\" 0\n",
                "2 2 4 2352 \"track02.bin\" 0\n",
            ),
            "overlaps the next track",
        ),
    ];

    for (body, expected) in cases {
        fs::write(&gdi, body).expect("write gdi");
        let err = match handler.parse_gdi_file(&gdi) {
            Ok(_) => panic!("expected an error for gdi body {body:?}"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains(expected),
            "gdi body {body:?} produced {err}"
        );
    }

    let _ = fs::remove_dir_all(&dir);
}
