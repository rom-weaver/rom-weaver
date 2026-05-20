#[cfg(test)]
mod tests {
    use super::{CliApp, CompressionLevelProfile, ParsedSelectionInput, RunCommandOptions};

    #[test]
    fn progress_defaults_follow_tty_and_json_mode() {
        assert!(RunCommandOptions::resolve_emit_progress_events(
            false, false, false, true
        ));
        assert!(!RunCommandOptions::resolve_emit_progress_events(
            false, false, false, false
        ));
        assert!(RunCommandOptions::resolve_emit_progress_events(
            true, false, false, false
        ));
    }

    #[test]
    fn progress_flags_override_defaults() {
        assert!(RunCommandOptions::resolve_emit_progress_events(
            false, true, false, false
        ));
        assert!(!RunCommandOptions::resolve_emit_progress_events(
            true, false, true, true
        ));
    }

    #[test]
    fn parse_selection_input_accepts_valid_indexes() {
        assert_eq!(
            CliApp::parse_selection_input("1", 3),
            ParsedSelectionInput::Selected(0)
        );
        assert_eq!(
            CliApp::parse_selection_input("3", 3),
            ParsedSelectionInput::Selected(2)
        );
    }

    #[test]
    fn parse_selection_input_handles_cancel_and_invalid_values() {
        assert_eq!(
            CliApp::parse_selection_input("q", 4),
            ParsedSelectionInput::Cancelled
        );
        assert_eq!(
            CliApp::parse_selection_input("  quit ", 4),
            ParsedSelectionInput::Cancelled
        );
        assert_eq!(
            CliApp::parse_selection_input("0", 4),
            ParsedSelectionInput::Invalid
        );
        assert_eq!(
            CliApp::parse_selection_input("5", 4),
            ParsedSelectionInput::Invalid
        );
        assert_eq!(
            CliApp::parse_selection_input("abc", 4),
            ParsedSelectionInput::Invalid
        );
    }

    #[test]
    fn selection_error_detection_matches_known_selection_failures() {
        assert!(CliApp::is_selection_resolution_error(
            "validation failed: requested selections were not found: missing.iso"
        ));
        assert!(CliApp::is_selection_resolution_error(
            "validation failed: requested selections resolved to no extractable cd outputs"
        ));
        assert!(CliApp::is_selection_resolution_error(
            "validation failed: gcz extract does not support --select yet"
        ));
        assert!(!CliApp::is_selection_resolution_error(
            "validation failed: no registered handler matched `sample.bin`"
        ));
    }

    #[test]
    fn compression_profile_defaults_to_max_levels() {
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zip",
                None,
                None,
                CompressionLevelProfile::Max,
            ),
            Some(9)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zst",
                None,
                None,
                CompressionLevelProfile::Max,
            ),
            Some(22)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "chd-dvd",
                None,
                None,
                CompressionLevelProfile::Max,
            ),
            Some(22)
        );
    }

    #[test]
    fn compression_profile_respects_codec_types() {
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zip",
                Some("store"),
                None,
                CompressionLevelProfile::Max,
            ),
            None
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "chd",
                Some("cdzs"),
                None,
                CompressionLevelProfile::VeryHigh,
            ),
            Some(21)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "chd",
                Some("cdlz"),
                None,
                CompressionLevelProfile::Max,
            ),
            Some(9)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zst",
                Some("zstd"),
                None,
                CompressionLevelProfile::Max,
            ),
            Some(22)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "chd",
                CliApp::primary_codec_name(Some("cdlz+cdzs+cdfl")),
                None,
                CompressionLevelProfile::Max,
            ),
            Some(9)
        );
    }

    #[test]
    fn compression_profile_prefers_explicit_codec_level() {
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "chd",
                Some("cdzs"),
                Some(15),
                CompressionLevelProfile::Max,
            ),
            Some(15)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zip",
                Some("store"),
                Some(3),
                CompressionLevelProfile::Max,
            ),
            Some(3)
        );
    }

    #[test]
    fn resolve_codec_level_supports_multi_codec_lists() {
        let (codec, level) = CliApp::resolve_codec_level(
            vec!["cdzs,cdzl".to_string(), "cdfl".to_string()],
            "--codec",
        )
        .expect("codec list should parse");
        assert_eq!(codec.as_deref(), Some("cdzs+cdzl+cdfl"));
        assert_eq!(level, None);
    }

    #[test]
    fn resolve_codec_level_supports_codec_level_syntax() {
        let (codec, level) = CliApp::resolve_codec_level(
            vec!["cdzs:19,cdzl".to_string(), "cdfl".to_string()],
            "--codec",
        )
        .expect("codec:level should parse");
        assert_eq!(codec.as_deref(), Some("cdzs+cdzl+cdfl"));
        assert_eq!(level, Some(19));
    }

    #[test]
    fn resolve_codec_level_rejects_invalid_level_values() {
        let error = CliApp::resolve_codec_level(vec!["cdzs:fast".to_string()], "--codec")
            .expect_err("invalid codec level should fail");
        assert!(error.to_string().contains("not a valid integer"));
    }

    #[test]
    fn resolve_codec_level_rejects_conflicting_levels() {
        let error = CliApp::resolve_codec_level(
            vec!["cdzs:19".to_string(), "cdzl:9".to_string()],
            "--codec",
        )
        .expect_err("conflicting codec levels should fail");
        assert!(error.to_string().contains("conflicting codec levels"));
    }
}
