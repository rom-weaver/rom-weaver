use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use rom_weaver_core::{
    ArchiveEntryKindFilter, ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandler, ContainerHandlerOperations, ContainerListEntry, ContainerProbeRequest,
    FormatDescriptor, NoopProgressSink, OperationContext, OperationFamily, OperationReport,
    PromptCandidate, Result, Selection, SelectionList, SelectionPrompter, ThreadBudget,
    ThreadCapability,
};
use serde_json::json;

use super::selection_resolution::SelectionResolutionOptions;
use super::{CliApp, CompressionLevelProfile, ParsedSelectionInput};

static TEST_CONTAINER_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "test-container",
    aliases: &[],
    extensions: &[".test"],
};

struct TestListHandler {
    entries: Vec<ContainerListEntry>,
}

impl ContainerHandlerOperations for TestListHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &TEST_CONTAINER_DESCRIPTOR
    }

    fn probe_details(
        &self,
        _request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor().name.to_string()),
            "probe",
            "test probe",
            Some(100.0),
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        ))
    }

    fn list_entry_records(
        &self,
        _request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        Ok(self.entries.clone())
    }

    fn extract(
        &self,
        _request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor().name.to_string()),
            "extract",
            "test extract",
            Some(100.0),
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(OperationReport::unsupported(
            OperationFamily::Container,
            Some(self.descriptor().name.to_string()),
            "create",
            "test create unsupported",
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        ))
    }
}

impl ContainerHandler for TestListHandler {
    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            probe_details: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

struct TestPrompter {
    selected: Vec<usize>,
}

impl SelectionPrompter for TestPrompter {
    fn select(&self, _heading: &str, _candidates: &[PromptCandidate]) -> Selection {
        self.selected
            .first()
            .copied()
            .map(Selection::Selected)
            .unwrap_or(Selection::Cancelled)
    }

    fn select_many(&self, _heading: &str, _candidates: &[PromptCandidate]) -> SelectionList {
        if self.selected.is_empty() {
            SelectionList::Cancelled
        } else {
            SelectionList::Selected(self.selected.clone())
        }
    }

    fn confirm(&self, _heading: &str, _details: &[String]) -> bool {
        false
    }
}

fn test_app_with_prompt(selected: Vec<usize>) -> CliApp {
    CliApp::new(
        Arc::new(NoopProgressSink),
        Arc::new(TestPrompter { selected }),
        false,
        true,
    )
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
fn extract_payload_selection_accepts_multiple_prompt_indexes() {
    let app = test_app_with_prompt(vec![0, 2]);
    let context = app.context(ThreadBudget::Fixed(1));
    let handler = TestListHandler {
        entries: vec![
            ContainerListEntry {
                path: "disc1.nes".to_string(),
                size: Some(1),
            },
            ContainerListEntry {
                path: "disc2.nes".to_string(),
                size: Some(2),
            },
            ContainerListEntry {
                path: "disc3.nes".to_string(),
                size: Some(3),
            },
        ],
    };

    let selected = app
        .resolve_extract_payload_selections(
            &handler,
            Path::new("bundle.test"),
            SelectionResolutionOptions {
                kind_filter: ArchiveEntryKindFilter::new(false, false),
                split_bin: false,
                ignore_common_files: true,
                source_label: "extract input",
            },
            &context,
        )
        .expect("selection");

    assert_eq!(selected, vec!["disc1.nes", "disc3.nes"]);
}

#[test]
fn extract_payload_selection_keeps_single_logical_payload_whole() {
    let app = test_app_with_prompt(vec![0]);
    let context = app.context(ThreadBudget::Fixed(1));
    let handler = TestListHandler {
        entries: vec![ContainerListEntry {
            path: "only-disc.cue".to_string(),
            size: Some(10),
        }],
    };

    let selected = app
        .resolve_extract_payload_selections(
            &handler,
            Path::new("single.test"),
            SelectionResolutionOptions {
                kind_filter: ArchiveEntryKindFilter::new(false, false),
                split_bin: false,
                ignore_common_files: true,
                source_label: "extract input",
            },
            &context,
        )
        .expect("selection");

    assert!(selected.is_empty());
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
            CompressionLevelProfile::Min,
        ),
        Some(-7)
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
        Some(9)
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
            CompressionLevelProfile::Min,
        ),
        Some(-7)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("cdzs"),
            None,
            CompressionLevelProfile::VeryHigh,
        ),
        Some(19)
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
            "chd",
            Some("cdfl"),
            None,
            CompressionLevelProfile::Max,
        ),
        Some(9)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("flac"),
            None,
            CompressionLevelProfile::VeryHigh,
        ),
        Some(8)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zst",
            Some("zstd"),
            None,
            CompressionLevelProfile::Min,
        ),
        Some(-7)
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
fn z3ds_compressed_extension_mapping_covers_known_source_types() {
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.cia")),
        Some(".zcia")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.cci")),
        Some(".zcci")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.cxi")),
        Some(".zcxi")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.app")),
        Some(".zcxi")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.3ds")),
        Some(".z3ds")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.3dsx")),
        Some(".z3dsx")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.bin")),
        None
    );
}

#[test]
fn z3ds_extension_append_uses_hint_when_output_has_no_extension() {
    let extensions = [".z3ds", ".zcci", ".zcxi", ".zcia", ".z3dsx"];
    let cases = [
        ("source.cia", "patched.zcia"),
        ("source.cci", "patched.zcci"),
        ("source.cxi", "patched.zcxi"),
        ("source.3dsx", "patched.z3dsx"),
        ("source.3ds", "patched.z3ds"),
    ];

    for (source, expected) in cases {
        let (output_path, appended) = CliApp::append_output_extension_if_missing(
            Path::new("patched"),
            &extensions,
            Some(Path::new(source)),
        );
        assert!(appended);
        assert_eq!(output_path, PathBuf::from(expected));
    }
}

#[test]
fn emitted_rom_extensions_cover_3ds_family_inputs() {
    for extension in [".3ds", ".3dsx", ".app", ".cci", ".cia", ".cxi"] {
        assert!(
            super::output_details::EMITTED_ROM_EXTENSIONS.contains(&extension),
            "missing {extension}"
        );
    }
}

#[test]
fn empty_changed_file_scan_preserves_handler_emitted_details() {
    let details = json!({
        "emitted_files": [
            {
                "checksums": { "sha1": "0123456789abcdef0123456789abcdef01234567" },
                "file_name": "Crash-QOL.bps",
                "path": "/work/Crash-QOL.bps",
                "size_bytes": 406
            }
        ]
    });

    assert_eq!(
        CliApp::emitted_file_detail_paths(Some(&details)),
        vec![PathBuf::from("/work/Crash-QOL.bps")]
    );

    let emitted = CliApp::build_or_existing_emitted_file_detail_values(Some(&details), &[], None);
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0]["file_name"], "Crash-QOL.bps");
    assert_eq!(emitted[0]["size_bytes"], 406);
    assert_eq!(
        emitted[0]["checksums"]["sha1"],
        "0123456789abcdef0123456789abcdef01234567"
    );
}

#[test]
fn nested_probe_skips_known_leaf_outputs_only_when_kind_filtered() {
    let no_filter = ArchiveEntryKindFilter::new(false, false);
    let rom_filter = ArchiveEntryKindFilter::new(true, false);

    assert!(CliApp::should_probe_nested_candidate(
        Path::new("disc.iso"),
        no_filter
    ));
    assert!(!CliApp::should_probe_nested_candidate(
        Path::new("disc.iso"),
        rom_filter
    ));
    assert!(!CliApp::should_probe_nested_candidate(
        Path::new("track.bin"),
        rom_filter
    ));
    assert!(CliApp::should_probe_nested_candidate(
        Path::new("inner.zip"),
        rom_filter
    ));
    assert!(CliApp::should_probe_nested_candidate(
        Path::new("inner.rvz"),
        rom_filter
    ));
    assert!(CliApp::should_probe_nested_candidate(
        Path::new("payload.unknown"),
        rom_filter
    ));
}

#[test]
fn patch_apply_archive_entry_name_preserves_source_extension() {
    assert_eq!(
        CliApp::patch_apply_archive_entry_file_name(Path::new("patched"), Path::new("source.gba")),
        std::ffi::OsString::from("patched.gba")
    );
    assert_eq!(
        CliApp::patch_apply_archive_entry_file_name(
            Path::new("patched.gba.7z"),
            Path::new("source.gba")
        ),
        std::ffi::OsString::from("patched.gba")
    );
    assert_eq!(
        CliApp::patch_apply_archive_entry_file_name(
            Path::new("patched.7z"),
            Path::new("source.gba")
        ),
        std::ffi::OsString::from("patched.gba")
    );
}

#[test]
fn resolve_codec_level_supports_multi_codec_lists() {
    let (codec, level) =
        CliApp::resolve_codec_level(vec!["cdzs,cdzl".to_string(), "cdfl".to_string()], "--codec")
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

    let (codec, level) = CliApp::resolve_codec_level(vec!["cdzs:-7,cdzl".to_string()], "--codec")
        .expect("negative codec:level should parse");
    assert_eq!(codec.as_deref(), Some("cdzs+cdzl"));
    assert_eq!(level, Some(-7));
}

#[test]
fn resolve_codec_level_rejects_invalid_level_values() {
    let error = CliApp::resolve_codec_level(vec!["cdzs:fast".to_string()], "--codec")
        .expect_err("invalid codec level should fail");
    assert!(error.to_string().contains("not a valid integer"));
}

#[test]
fn resolve_codec_level_rejects_conflicting_levels() {
    let error =
        CliApp::resolve_codec_level(vec!["cdzs:19".to_string(), "cdzl:9".to_string()], "--codec")
            .expect_err("conflicting codec levels should fail");
    assert!(error.to_string().contains("conflicting codec levels"));
}
