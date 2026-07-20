use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use rom_weaver_core::{
    ArchiveEntryKindFilter, ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandler, ContainerHandlerOperations, ContainerListEntry, ContainerProbeRequest,
    FormatDescriptor, NoopProgressSink, OperationContext, OperationFamily, OperationReport,
    PromptCandidate, Result, RomWeaverError, Selection, SelectionList, SelectionPrompter,
    ThreadBudget, ThreadCapability,
};
use serde_json::json;

use super::expect_tokens::checksum_hex_len;
use super::selection_resolution::SelectionResolutionOptions;
use super::{
    CliApp, Commands, CompressCommand, CompressionLevelProfile, ExtractCommand, LogLevel,
    N64ByteOrder, N64ByteOrderTransform, ParsedSelectionInput, RomWeaverBundle, log_filter_spec,
};

#[test]
fn dependency_trace_keeps_application_logging_at_warning() {
    assert_eq!(
        log_filter_spec(None, true, None).as_deref(),
        Some("warn,nod=trace")
    );
}

#[test]
fn dependency_trace_augments_configured_filter() {
    assert_eq!(
        log_filter_spec(None, true, Some("rom_weaver_app=info".to_string())).as_deref(),
        Some("rom_weaver_app=info,nod=trace")
    );
}

#[test]
fn explicit_log_level_targets_application_crates() {
    assert_eq!(
        log_filter_spec(Some(LogLevel::Debug), false, None).as_deref(),
        Some(
            "rom_weaver_app=debug,rom_weaver_core=debug,rom_weaver_containers=debug,rom_weaver_patches=debug,rom_weaver_checksum=debug"
        )
    );
}

#[test]
fn explicit_off_log_level_still_allows_dependency_trace() {
    assert_eq!(
        log_filter_spec(Some(LogLevel::Off), true, None).as_deref(),
        Some("off,nod=trace")
    );
}

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
            context.single_thread_execution(),
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
            context.single_thread_execution(),
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
            context.single_thread_execution(),
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
fn extract_payload_selection_keeps_one_rom_from_several() {
    // Several loose ROMs are competing input candidates; the user keeps exactly ONE, so the
    // resolver is single-select and returns only the chosen ROM (the prompter is primed with two
    // indexes to prove only the first is honoured for a single-select ROM disambiguation).
    let app = test_app_with_prompt(vec![2, 0]);
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

    assert_eq!(selected, vec!["disc3.nes"]);
}

#[test]
fn extract_payload_selection_keeps_one_disc_from_two() {
    // Two complete discs (each a `.cue` + its `(Track N)` bins) are two logical ROMs. Keeping one
    // returns the WHOLE chosen disc - its sheet and every track - so it extracts together.
    let app = test_app_with_prompt(vec![1]);
    let context = app.context(ThreadBudget::Fixed(1));
    let handler = TestListHandler {
        entries: vec![
            ContainerListEntry {
                path: "Alpha.cue".to_string(),
                size: Some(1),
            },
            ContainerListEntry {
                path: "Alpha (Track 1).bin".to_string(),
                size: Some(10),
            },
            ContainerListEntry {
                path: "Beta.cue".to_string(),
                size: Some(1),
            },
            ContainerListEntry {
                path: "Beta (Track 1).bin".to_string(),
                size: Some(20),
            },
        ],
    };

    let selected = app
        .resolve_extract_payload_selections(
            &handler,
            Path::new("two-discs.test"),
            SelectionResolutionOptions {
                kind_filter: ArchiveEntryKindFilter::new(false, false),
                split_bin: false,
                ignore_common_files: true,
                source_label: "extract input",
            },
            &context,
        )
        .expect("selection");

    // Index 1 is the Beta disc; both its sheet and track come along.
    assert_eq!(selected, vec!["Beta.cue", "Beta (Track 1).bin"]);
}

#[test]
fn extract_payload_selection_prompts_for_disc_plus_loose_rom() {
    // A disc alongside a loose ROM is two logical ROMs even though only one carries a sheet; the
    // resolver prompts and keeps the chosen unit (here the whole disc).
    let app = test_app_with_prompt(vec![0]);
    let context = app.context(ThreadBudget::Fixed(1));
    let handler = TestListHandler {
        entries: vec![
            ContainerListEntry {
                path: "Game.cue".to_string(),
                size: Some(1),
            },
            ContainerListEntry {
                path: "Game (Track 1).bin".to_string(),
                size: Some(10),
            },
            ContainerListEntry {
                path: "Bonus.nes".to_string(),
                size: Some(5),
            },
        ],
    };

    let selected = app
        .resolve_extract_payload_selections(
            &handler,
            Path::new("disc-plus-rom.test"),
            SelectionResolutionOptions {
                kind_filter: ArchiveEntryKindFilter::new(false, false),
                split_bin: false,
                ignore_common_files: true,
                source_label: "extract input",
            },
            &context,
        )
        .expect("selection");

    assert_eq!(selected, vec!["Game.cue", "Game (Track 1).bin"]);
}

#[test]
fn extract_payload_selection_patch_filter_keeps_multiple() {
    // Patches are not ROMs: a `--filter patch` extract stays MULTI-select so several patches can be
    // pulled at once (the prompter's full index list is honoured).
    let app = test_app_with_prompt(vec![0, 2]);
    let context = app.context(ThreadBudget::Fixed(1));
    let handler = TestListHandler {
        entries: vec![
            ContainerListEntry {
                path: "first.bps".to_string(),
                size: Some(1),
            },
            ContainerListEntry {
                path: "second.bps".to_string(),
                size: Some(2),
            },
            ContainerListEntry {
                path: "third.bps".to_string(),
                size: Some(3),
            },
        ],
    };

    let selected = app
        .resolve_extract_payload_selections(
            &handler,
            Path::new("patches.test"),
            SelectionResolutionOptions {
                kind_filter: ArchiveEntryKindFilter::new(false, true),
                split_bin: false,
                ignore_common_files: true,
                source_label: "extract input",
            },
            &context,
        )
        .expect("selection");

    assert_eq!(selected, vec!["first.bps", "third.bps"]);
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
fn extract_payload_selection_collapses_multi_track_disc_without_prompting() {
    // A multi-track disc lists a `.cue` sheet plus several `.bin` tracks. Even though the
    // tracks would each be a payload candidate, the sheet collapses them into one logical
    // ROM, so no ambiguity prompt fires. The prompter is primed to pick a track to prove the
    // resolver never consults it.
    let app = test_app_with_prompt(vec![0]);
    let context = app.context(ThreadBudget::Fixed(1));
    let handler = TestListHandler {
        entries: vec![
            ContainerListEntry {
                path: "disc.cue".to_string(),
                size: Some(1),
            },
            ContainerListEntry {
                path: "track01.bin".to_string(),
                size: Some(20),
            },
            ContainerListEntry {
                path: "track02.bin".to_string(),
                size: Some(30),
            },
        ],
    };

    let selected = app
        .resolve_extract_payload_selections(
            &handler,
            Path::new("disc.test"),
            SelectionResolutionOptions {
                kind_filter: ArchiveEntryKindFilter::new(true, false),
                split_bin: false,
                ignore_common_files: true,
                source_label: "extract input",
            },
            &context,
        )
        .expect("selection");

    // Empty => extract the whole container (the single logical disc), no per-track prompt.
    assert!(selected.is_empty());
}

/// Compress `inputs` into a `zip` container at `output`, asserting the fixture build succeeds.
fn compress_zip_fixture(app: &CliApp, inputs: &[PathBuf], output: &Path) {
    let outcome = app.run(Commands::Compress(CompressCommand {
        input: inputs.to_vec(),
        format: Some("zip".to_string()),
        output: output.to_path_buf(),
        codec: Vec::new(),
        level: CompressionLevelProfile::Max,
        threads: ThreadBudget::Fixed(1),
    }));
    assert_eq!(
        outcome.exit_code, 0,
        "zip fixture compression should succeed"
    );
}

/// Recursively locate a file named `name` anywhere under `root`, panicking if it is absent.
fn find_emitted_file(root: &Path, name: &str) -> PathBuf {
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory).expect("read extracted directory") {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().and_then(|value| value.to_str()) == Some(name) {
                return path;
            }
        }
    }
    panic!("expected to find `{name}` under `{}`", root.display());
}

#[test]
fn nested_extract_auto_extracts_all_branches_without_prompting() {
    // The libarchive zip compress/extract paths are stack-heavy; run on a generous stack like the
    // real binary does, rather than the constrained default test-thread stack.
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(nested_extract_auto_extracts_all_branches_body)
        .expect("spawn nested extract test thread")
        .join()
        .expect("nested extract test thread");
}

fn nested_extract_auto_extracts_all_branches_body() {
    // A prompter that cancels every request: if any level prompts for a payload selection the
    // extraction fails, so a successful run proves nested descent never prompted.
    let app = test_app_with_prompt(Vec::new());

    let nonce = REPAIR_TEST_FILE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("rw-nested-branches-{}-{nonce}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create nested fixture dir");

    let alpha = dir.join("alpha.nes");
    let beta = dir.join("beta.nes");
    std::fs::write(&alpha, b"alpha payload").expect("alpha fixture");
    std::fs::write(&beta, b"beta payload").expect("beta fixture");

    // inner.zip exposes two ambiguous payload branches; previously this prompted while descending.
    let inner_zip = dir.join("inner.zip");
    compress_zip_fixture(&app, &[alpha, beta], &inner_zip);

    // outer.zip wraps the nested container so the descent reaches inner.zip's ambiguous branches.
    let outer_zip = dir.join("outer.zip");
    compress_zip_fixture(&app, &[inner_zip], &outer_zip);

    let out_dir = dir.join("extracted");
    let outcome = app.run(Commands::Extract(ExtractCommand {
        input: outer_zip,
        select: Vec::new(),
        filter: Vec::new(),
        output: out_dir.clone(),
        split_bin: false,
        no_ignore: false,
        no_nested_extract: false,
        force: false,
        checksum: Vec::new(),
        checksum_rom: Vec::new(),
        probe: false,
        threads: ThreadBudget::Fixed(1),
    }));

    assert_eq!(
        outcome.exit_code, 0,
        "nested extraction must auto-extract every branch instead of prompting"
    );

    let alpha_out = find_emitted_file(&out_dir, "alpha.nes");
    let beta_out = find_emitted_file(&out_dir, "beta.nes");
    assert_eq!(
        std::fs::read(&alpha_out).expect("alpha output"),
        b"alpha payload"
    );
    assert_eq!(
        std::fs::read(&beta_out).expect("beta output"),
        b"beta payload"
    );

    let _ = std::fs::remove_dir_all(dir);
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

static REPAIR_TEST_FILE_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn write_repair_test_file(name: &str, bytes: &[u8]) -> PathBuf {
    let nonce = REPAIR_TEST_FILE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("rw-repair-{}-{nonce}-{name}", std::process::id()));
    std::fs::write(&path, bytes).expect("write repair fixture");
    path
}

fn n64_byte_swapped(bytes: &[u8]) -> Vec<u8> {
    let mut swapped = bytes.to_vec();
    for word in swapped.chunks_exact_mut(4) {
        word.swap(0, 1);
        word.swap(2, 3);
    }
    swapped
}

fn n64_little_endian(bytes: &[u8]) -> Vec<u8> {
    let mut little_endian = bytes.to_vec();
    for word in little_endian.chunks_exact_mut(4) {
        word.reverse();
    }
    little_endian
}

#[test]
fn header_repair_normalizes_v64_input_to_z64() {
    let z64: [u8; 16] = [
        0x80, 0x37, 0x12, 0x40, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        0x0b,
    ];
    let v64 = n64_byte_swapped(&z64);

    let v64_path = write_repair_test_file("input.v64", &v64);
    let normalized_path = write_repair_test_file("normalized.z64", &[]);

    let detected = CliApp::normalize_n64_to_big_endian_to_temp(&v64_path, &normalized_path)
        .expect("normalize N64 byte order");

    assert_eq!(detected, Some(N64ByteOrder::ByteSwapped));
    assert_eq!(
        std::fs::read(&normalized_path).expect("read normalized output"),
        z64.to_vec()
    );

    let _ = std::fs::remove_file(v64_path);
    let _ = std::fs::remove_file(normalized_path);
}

#[test]
fn header_repair_normalizes_n64_input_to_z64() {
    let z64: [u8; 16] = [
        0x80, 0x37, 0x12, 0x40, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        0x0b,
    ];
    let n64 = n64_little_endian(&z64);

    let n64_path = write_repair_test_file("input.n64", &n64);
    let normalized_path = write_repair_test_file("normalized.z64", &[]);

    let detected = CliApp::normalize_n64_to_big_endian_to_temp(&n64_path, &normalized_path)
        .expect("normalize N64 byte order");

    assert_eq!(detected, Some(N64ByteOrder::LittleEndian));
    assert_eq!(
        std::fs::read(&normalized_path).expect("read normalized output"),
        z64.to_vec()
    );

    let _ = std::fs::remove_file(n64_path);
    let _ = std::fs::remove_file(normalized_path);
}

#[test]
fn header_repair_leaves_z64_input_in_place() {
    let z64: [u8; 8] = [0x80, 0x37, 0x12, 0x40, 0xde, 0xad, 0xbe, 0xef];

    let z64_path = write_repair_test_file("input.z64", &z64);
    let normalized_path = write_repair_test_file("normalized.z64", &[]);

    let detected = CliApp::normalize_n64_to_big_endian_to_temp(&z64_path, &normalized_path)
        .expect("normalize N64 byte order");

    assert_eq!(detected, None);
    assert_eq!(
        std::fs::read(&z64_path).expect("read z64 input"),
        z64.to_vec()
    );
    assert_eq!(
        std::fs::read(&normalized_path).expect("read untouched temp output"),
        Vec::<u8>::new()
    );

    let _ = std::fs::remove_file(z64_path);
    let _ = std::fs::remove_file(normalized_path);
}

#[test]
fn header_repair_finalize_restores_original_n64_order() {
    let z64: [u8; 16] = [
        0x80, 0x37, 0x12, 0x40, 0xde, 0xad, 0xbe, 0xef, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc,
        0xfe,
    ];
    let expected_v64 = n64_byte_swapped(&z64);

    let staged_path = write_repair_test_file("staged.z64", &z64);
    let output_path = write_repair_test_file("output.v64", &[]);

    CliApp::finalize_patch_apply_output(
        &staged_path,
        &output_path,
        false,
        None,
        false,
        false,
        None,
        Some(N64ByteOrderTransform {
            from: N64ByteOrder::BigEndian,
            to: N64ByteOrder::ByteSwapped,
        }),
    )
    .expect("restore N64 byte order");

    assert_eq!(
        std::fs::read(&output_path).expect("read restored output"),
        expected_v64
    );

    let _ = std::fs::remove_file(staged_path);
    let _ = std::fs::remove_file(output_path);
}

// Golden cases shared with the TypeScript conformance test
// (`sidecar-patch-resolution.browser.test.js`) so the native matcher and the browser's
// Ingest sidecar preflight can never drift on the RetroArch `<rom-stem>.<patch-ext>` convention.
#[test]
fn libretro_sidecar_matches_basename_stem_and_order() {
    let rom = "bundle/game.bin";
    let cases: [(&str, Option<u32>); 7] = [
        ("bundle/game.ips", Some(0)),         // stem match, no order suffix
        ("bundle/game.bin.ips1", Some(1)),    // full-name match + order 1
        ("bundle/game [Hack].ips2", Some(2)), // bracket label stripped, order 2
        ("bundle/game.bspatch3", Some(3)),    // different patch ext, order 3
        ("elsewhere/game.ips", None),         // wrong directory
        ("bundle/other.ips", None),           // wrong basename
        ("bundle/game.txt", None),            // not a patch extension
    ];
    for (patch, expected) in cases {
        assert_eq!(
            CliApp::entry_matches_libretro_sidecar(rom, patch),
            expected,
            "sidecar match for `{patch}`"
        );
    }
}

// --------------------------------------------------------------------------------------------
// patch-validate helper coverage. `parse_patch_apply_checksum_values`,
// `validate_patch_input_size`, `validate_patch_apply_expected_checksums`, and `checksum_hex_len`
// back the bundle check-token parser (`bundle_entry_checks` -> `--output-check` and the per-patch
// check flags) and have no other in-source tests. Each error case asserts the matched
// `RomWeaverError` variant plus the guard message so the intended branch is the one hit.
// --------------------------------------------------------------------------------------------

#[test]
fn parse_patch_apply_checksum_values_accepts_and_normalizes_valid_pairs() {
    let values = CliApp::parse_patch_apply_checksum_values(
        &[
            "CRC32=0xDEADBEEF".to_string(),
            "  md5 = D41D8CD98F00B204E9800998ECF8427E ".to_string(),
        ],
        "--output-check",
    )
    .expect("valid checksum pairs should parse");

    // Algorithm is lowercased, a `0x` prefix is stripped, the hex value is lowercased, and
    // surrounding whitespace is trimmed.
    assert_eq!(values.get("crc32").map(String::as_str), Some("deadbeef"));
    assert_eq!(
        values.get("md5").map(String::as_str),
        Some("d41d8cd98f00b204e9800998ecf8427e")
    );
}

#[test]
fn parse_patch_apply_checksum_values_deduplicates_matching_repeats() {
    let values = CliApp::parse_patch_apply_checksum_values(
        &["crc32=deadbeef".to_string(), "CRC32=DEADBEEF".to_string()],
        "--output-check",
    )
    .expect("identical repeats should dedupe");
    assert_eq!(values.len(), 1);
    assert_eq!(values.get("crc32").map(String::as_str), Some("deadbeef"));
}

#[test]
fn parse_patch_apply_checksum_values_rejects_malformed_inputs() {
    // (input, message fragment) pairs, each landing on a distinct guard.
    let cases = [
        (vec!["   ".to_string()], "cannot be empty"),
        (vec!["crc32deadbeef".to_string()], "expected ALGO=HEX"),
        (vec!["=deadbeef".to_string()], "algorithm is missing before"),
        (
            vec!["sha9=deadbeef".to_string()],
            "unsupported checksum algorithm",
        ),
        (vec!["crc32=".to_string()], "value is missing after"),
        (vec!["crc32=xyz12345".to_string()], "must be hexadecimal"),
        (vec!["crc32=dead".to_string()], "expects 8 hex characters"),
        (
            vec!["crc32=deadbeef".to_string(), "crc32=feedface".to_string()],
            "conflicting values",
        ),
    ];
    for (input, fragment) in cases {
        let error = CliApp::parse_patch_apply_checksum_values(&input, "--output-check")
            .expect_err("malformed checksum value should fail");
        assert!(
            matches!(error, RomWeaverError::Validation(ref message) if message.contains(fragment)),
            "input {input:?} expected `{fragment}`, got: {error:?}"
        );
    }
}

#[test]
fn checksum_hex_len_maps_supported_algorithms() {
    assert_eq!(checksum_hex_len("crc16"), Some(4));
    assert_eq!(checksum_hex_len("crc32"), Some(8));
    assert_eq!(checksum_hex_len("crc32c"), Some(8));
    assert_eq!(checksum_hex_len("adler32"), Some(8));
    assert_eq!(checksum_hex_len("md5"), Some(32));
    assert_eq!(checksum_hex_len("sha1"), Some(40));
    assert_eq!(checksum_hex_len("sha256"), Some(64));
    assert_eq!(checksum_hex_len("blake3"), Some(64));
    assert_eq!(checksum_hex_len("nope"), None);
}

#[test]
fn validate_patch_input_size_enforces_exact_and_minimum() {
    let path = write_repair_test_file("patch-validate-size.bin", &[0u8; 64]);

    // Exact-size match returns a descriptive label.
    let label = CliApp::validate_patch_input_size(&path, Some(64), None)
        .expect("matching size should pass");
    assert!(label.contains("size=64"), "label: {label}");

    // Exact-size mismatch is rejected.
    let error = CliApp::validate_patch_input_size(&path, Some(128), None)
        .expect_err("size mismatch should fail");
    assert!(
        matches!(error, RomWeaverError::Validation(ref message) if message.contains("input size mismatch")),
        "unexpected error: {error:?}"
    );

    // Below the minimum is rejected; at-or-above passes.
    let error = CliApp::validate_patch_input_size(&path, None, Some(65))
        .expect_err("below minimum should fail");
    assert!(
        matches!(error, RomWeaverError::Validation(ref message) if message.contains("below required minimum")),
        "unexpected error: {error:?}"
    );
    let label =
        CliApp::validate_patch_input_size(&path, None, Some(64)).expect("at minimum should pass");
    assert!(label.contains("min_size=64"), "label: {label}");

    let _ = std::fs::remove_file(path);
}

#[test]
fn validate_patch_apply_expected_checksums_uses_hints_for_match_and_mismatch() {
    use std::collections::BTreeMap;

    let app = test_app_with_prompt(Vec::new());
    let context = app.context(ThreadBudget::Fixed(1));
    // The hash hints stand in for cached input checksums, so the source bytes are never read by
    // the checksum engine for these algorithms. The file still must exist for the metadata path.
    let path = write_repair_test_file("patch-validate-checksum.bin", &[0xAB, 0xCD]);

    let mut expected = BTreeMap::new();
    expected.insert("crc32".to_string(), "deadbeef".to_string());
    let mut hints = BTreeMap::new();
    hints.insert("crc32".to_string(), "deadbeef".to_string());

    let label = CliApp::validate_patch_apply_expected_checksums(
        &path, &expected, &hints, "input", &context,
    )
    .expect("matching hint should pass");
    assert!(label.contains("crc32=deadbeef"), "label: {label}");

    // A hint that disagrees with the expected value trips the mismatch guard.
    let mut wrong_hints = BTreeMap::new();
    wrong_hints.insert("crc32".to_string(), "feedface".to_string());
    let error = CliApp::validate_patch_apply_expected_checksums(
        &path,
        &expected,
        &wrong_hints,
        "input",
        &context,
    )
    .expect_err("mismatching hint should fail");
    assert!(
        matches!(error, RomWeaverError::Validation(ref message) if message.contains("checksum mismatch for crc32")),
        "unexpected error: {error:?}"
    );

    // No expected checksums short-circuits to an empty label without touching the engine.
    let empty = BTreeMap::new();
    let label =
        CliApp::validate_patch_apply_expected_checksums(&path, &empty, &hints, "input", &context)
            .expect("no expected checksums should pass");
    assert!(label.is_empty(), "label should be empty, got: {label}");

    let _ = std::fs::remove_file(path);
}

fn bundle_for_selection() -> RomWeaverBundle {
    crate::bundle_parse::parse_bundle_bytes(
        br#"{ "version": 1, "patches": [
            { "path": "main.ips",     "name": "Main hack" },
            { "path": "balance.ips",  "name": "Rebalance" },
            { "path": "extra.ips",    "name": "Extra maps", "optional": true },
            { "path": "debug.ips",    "name": "Debug menu", "optional": true }
        ] }"#,
    )
    .expect("selection bundle parses")
}

fn noninteractive_app() -> CliApp {
    CliApp::new(
        Arc::new(NoopProgressSink),
        Arc::new(TestPrompter { selected: vec![] }),
        false,
        false,
    )
}

#[test]
fn bundle_selection_defaults_to_required_and_default() {
    let app = noninteractive_app();
    let selected = app
        .select_bundle_patches(&bundle_for_selection(), &[], &[])
        .expect("selection succeeds");
    assert_eq!(selected, vec![0, 1]);
}

#[test]
fn bundle_selection_with_includes_optional_and_disabled() {
    let app = noninteractive_app();
    let selected = app
        .select_bundle_patches(
            &bundle_for_selection(),
            &["extra*".to_string(), "debug.ips".to_string()],
            &[],
        )
        .expect("selection succeeds");
    assert_eq!(selected, vec![0, 1, 2, 3]);
}

#[test]
fn bundle_selection_without_excludes_default() {
    let app = noninteractive_app();
    let selected = app
        .select_bundle_patches(&bundle_for_selection(), &[], &["Rebalance".to_string()])
        .expect("selection succeeds");
    assert_eq!(selected, vec![0]);
}

#[test]
fn bundle_selection_without_can_disable_any_patch() {
    let app = noninteractive_app();
    let selected = app
        .select_bundle_patches(&bundle_for_selection(), &[], &["main*".to_string()])
        .expect("every patch is toggleable");
    assert_eq!(selected, vec![1]);
}

#[test]
fn bundle_selection_interactive_prompt_picks_subset() {
    // Every entry is offered. Picking position 1 selects only `balance`.
    let app = test_app_with_prompt(vec![1]);
    let selected = app
        .select_bundle_patches(&bundle_for_selection(), &[], &[])
        .expect("selection succeeds");
    assert_eq!(
        selected,
        vec![1],
        "interactive selection controls every patch"
    );
}

#[test]
fn bundle_selection_interactive_cancel_keeps_defaults() {
    // Cancel (or an empty pick - the protocol folds both into Cancelled) must
    // fall back to the boolean defaults rather than aborting the run.
    let app = test_app_with_prompt(vec![]);
    let selected = app
        .select_bundle_patches(&bundle_for_selection(), &[], &[])
        .expect("cancel does not abort");
    assert_eq!(selected, vec![0, 1]);
}

#[test]
fn bundle_selection_flags_suppress_prompt() {
    // An interactive session with --with flags must not prompt; the scripted
    // prompter would pick position 0 (balance) if consulted.
    let app = test_app_with_prompt(vec![0]);
    let selected = app
        .select_bundle_patches(&bundle_for_selection(), &["extra*".to_string()], &[])
        .expect("selection succeeds");
    assert_eq!(selected, vec![0, 1, 2]);
}
