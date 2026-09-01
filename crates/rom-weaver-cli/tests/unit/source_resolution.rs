use std::sync::atomic::{AtomicU32, Ordering};

use rom_weaver_core::{NoninteractivePrompter, NoopProgressSink, Selection, SelectionList};

use super::*;

/// Monotonic suffix so parallel tests in this file never share a scratch dir.
static SCRATCH_COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch_dir(label: &str) -> PathBuf {
    let unique = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "rw-source-resolution-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// Answers every prompt with a fixed index, or cancels when none is set.
struct FixedPrompter {
    index: Option<usize>,
}

impl SelectionPrompter for FixedPrompter {
    fn select(&self, _heading: &str, _candidates: &[PromptCandidate]) -> Selection {
        match self.index {
            Some(index) => Selection::Selected(index),
            None => Selection::Cancelled,
        }
    }

    fn select_many(&self, _heading: &str, _candidates: &[PromptCandidate]) -> SelectionList {
        match self.index {
            Some(index) => SelectionList::Selected(vec![index]),
            None => SelectionList::Cancelled,
        }
    }

    fn confirm(&self, _heading: &str, _details: &[String]) -> bool {
        false
    }
}

fn noninteractive_app() -> CliApp {
    CliApp::new(
        Arc::new(NoopProgressSink),
        Arc::new(NoninteractivePrompter),
        false,
        false,
        false,
    )
}

fn interactive_app(index: Option<usize>) -> CliApp {
    CliApp::new(
        Arc::new(NoopProgressSink),
        Arc::new(FixedPrompter { index }),
        false,
        true,
        false,
    )
}

fn candidate(name: &str, ignored: bool) -> ChecksumExtractCandidate {
    ChecksumExtractCandidate {
        source: PathBuf::from("/staged").join(name),
        display_name: name.to_string(),
        ignored,
    }
}

fn labels() -> AutoExtractResolutionLabels<'static> {
    AutoExtractResolutionLabels {
        command: "checksum",
        family: OperationFamily::Container,
        format: None,
        source_label: "checksum input",
        temp_prefix: "rw-test-auto-extract",
    }
}

fn options(
    kind_filter: ArchiveEntryKindFilter,
    mode: AutoExtractMode,
) -> AutoExtractResolutionOptions {
    AutoExtractResolutionOptions {
        no_extract: false,
        no_ignore: false,
        kind_filter,
        mode,
        stop_on_single_payload_codec: false,
    }
}

fn no_filter() -> ArchiveEntryKindFilter {
    ArchiveEntryKindFilter::new(false, false)
}

/// Pack `inputs` into `output` with the registry's zip handler, the same route
/// `bundle create --bundle` uses.
fn make_zip(app: &CliApp, output: &Path, inputs: &[PathBuf], context: &OperationContext) {
    let handler = app
        .containers
        .find_creatable_by_name("zip")
        .expect("zip handler");
    handler
        .create(
            &ContainerCreateRequest {
                inputs: inputs.to_vec(),
                output: output.to_path_buf(),
                format: "zip".to_string(),
                codec: None,
                level: None,
                parent: None,
            },
            context,
        )
        .expect("zip create");
}

#[test]
fn no_extract_returns_the_source_untouched() {
    let app = noninteractive_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let resolved = app
        .resolve_source_with_auto_extract(
            Path::new("/games/archive.zip"),
            &[],
            &context,
            labels(),
            AutoExtractResolutionFlags {
                no_extract: true,
                no_ignore: false,
                kind_filter: no_filter(),
                stop_on_single_payload_codec: false,
            },
        )
        .expect("no-extract short circuits");
    assert_eq!(resolved.source, PathBuf::from("/games/archive.zip"));
    assert_eq!(resolved.extracted_archives, 0);
    assert!(resolved.cleanup_paths.is_empty());
}

#[test]
fn a_source_no_handler_matches_is_returned_as_is() {
    let dir = scratch_dir("no-handler");
    let rom = dir.join("game.nes");
    fs::write(&rom, [0x00_u8; 16]).expect("rom");
    let app = noninteractive_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let resolved = app
        .resolve_source_with_auto_extract(
            &rom,
            &[],
            &context,
            labels(),
            AutoExtractResolutionFlags {
                no_extract: false,
                no_ignore: false,
                kind_filter: no_filter(),
                stop_on_single_payload_codec: false,
            },
        )
        .expect("plain file resolves to itself");
    assert_eq!(resolved.source, rom);
    assert_eq!(resolved.extracted_archives, 0);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_archive_resolves_to_its_single_extracted_payload() {
    let dir = scratch_dir("single-archive");
    let rom = dir.join("game.nes");
    fs::write(&rom, [0x11_u8; 32]).expect("rom");
    let app = noninteractive_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let archive = dir.join("games.zip");
    make_zip(&app, &archive, &[rom], &context);

    let resolved = app
        .resolve_source_with_auto_extract(
            &archive,
            &[],
            &context,
            labels(),
            AutoExtractResolutionFlags {
                no_extract: false,
                no_ignore: false,
                kind_filter: no_filter(),
                stop_on_single_payload_codec: false,
            },
        )
        .expect("archive resolves");
    assert_eq!(resolved.extracted_archives, 1);
    assert_eq!(
        resolved.source.file_name().and_then(|name| name.to_str()),
        Some("game.nes")
    );
    assert_eq!(fs::read(&resolved.source).expect("payload"), [0x11_u8; 32]);
    assert_eq!(resolved.cleanup_paths.len(), 1);
    CliApp::cleanup_temp_paths(&resolved.cleanup_paths);
    assert!(resolved.cleanup_paths.iter().all(|path| !path.exists()));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn nested_archives_are_unwrapped_until_a_plain_payload_is_reached() {
    let dir = scratch_dir("nested-archives");
    let rom = dir.join("game.nes");
    fs::write(&rom, [0x22_u8; 8]).expect("rom");
    let app = noninteractive_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let inner = dir.join("inner.zip");
    make_zip(&app, &inner, &[rom], &context);
    let outer = dir.join("outer.zip");
    make_zip(&app, &outer, &[inner], &context);

    let resolved = app
        .resolve_source_with_auto_extract(
            &outer,
            &[],
            &context,
            labels(),
            AutoExtractResolutionFlags {
                no_extract: false,
                no_ignore: false,
                kind_filter: no_filter(),
                stop_on_single_payload_codec: false,
            },
        )
        .expect("nested archives resolve");
    assert_eq!(resolved.extracted_archives, 2);
    assert_eq!(
        resolved.source.file_name().and_then(|name| name.to_str()),
        Some("game.nes")
    );
    CliApp::cleanup_temp_paths(&resolved.cleanup_paths);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn single_step_mode_stops_after_one_extraction() {
    let dir = scratch_dir("single-step");
    let rom = dir.join("game.nes");
    fs::write(&rom, [0x33_u8; 8]).expect("rom");
    let app = noninteractive_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let inner = dir.join("inner.zip");
    make_zip(&app, &inner, &[rom], &context);
    let outer = dir.join("outer.zip");
    make_zip(&app, &outer, &[inner], &context);

    let resolved = app
        .resolve_source_with_auto_extract_with_mode(
            &outer,
            &[],
            &context,
            labels(),
            options(no_filter(), AutoExtractMode::SingleStep),
        )
        .expect("single-step resolves");
    assert_eq!(resolved.extracted_archives, 1);
    assert_eq!(
        resolved.source.file_name().and_then(|name| name.to_str()),
        Some("inner.zip"),
        "single-step stops at the first extracted layer"
    );
    CliApp::cleanup_temp_paths(&resolved.cleanup_paths);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn nesting_deeper_than_the_depth_limit_is_refused() {
    let dir = scratch_dir("depth-limit");
    let app = noninteractive_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let rom = dir.join("game.nes");
    fs::write(&rom, [0x44_u8; 4]).expect("rom");

    // One layer past MAX_NESTED_EXTRACT_DEPTH, each wrapping exactly one entry
    // so every layer resolves unambiguously up to the refusal.
    let mut current = rom;
    for level in 0..=MAX_NESTED_EXTRACT_DEPTH {
        let layer_dir = dir.join(format!("layer{level}"));
        fs::create_dir_all(&layer_dir).expect("layer dir");
        let archive = layer_dir.join("layer.zip");
        make_zip(&app, &archive, &[current], &context);
        current = archive;
    }

    let error = app
        .resolve_source_with_auto_extract(
            &current,
            &[],
            &context,
            labels(),
            AutoExtractResolutionFlags {
                no_extract: false,
                no_ignore: false,
                kind_filter: no_filter(),
                stop_on_single_payload_codec: false,
            },
        )
        .expect_err("depth limit");
    assert!(
        error
            .to_string()
            .contains(&format!("exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH}")),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_kind_filter_that_matches_nothing_lists_the_rejected_candidates() {
    let error = CliApp::filter_kind_auto_extract_candidates(
        Path::new("/games/archive.zip"),
        vec![candidate("notes.txt", false), candidate("cover.png", false)],
        "checksum input",
        ArchiveEntryKindFilter::new(true, false),
    )
    .expect_err("nothing matches --filter rom");
    let message = error.to_string();
    assert!(message.contains("--filter rom"), "{message}");
    assert!(
        message.contains("`notes.txt`, `cover.png`"),
        "the rejected candidates are listed: {message}"
    );
}

#[test]
fn a_disabled_kind_filter_keeps_every_candidate() {
    let candidates = vec![candidate("notes.txt", false), candidate("game.nes", false)];
    let kept = CliApp::filter_kind_auto_extract_candidates(
        Path::new("/games/archive.zip"),
        candidates.clone(),
        "checksum input",
        no_filter(),
    )
    .expect("a disabled filter keeps everything");
    assert_eq!(kept.len(), candidates.len());
}

#[test]
fn a_kind_filter_prefers_payloads_over_the_container_fallback() {
    let kept = CliApp::filter_kind_auto_extract_candidates(
        Path::new("/games/archive.zip"),
        vec![
            candidate("game.nes", false),
            candidate("inner.zip", false),
            candidate("notes.txt", false),
        ],
        "checksum input",
        ArchiveEntryKindFilter::new(true, false),
    )
    .expect("rom payload matches");
    let names: Vec<&str> = kept
        .iter()
        .map(|candidate| candidate.display_name.as_str())
        .collect();
    assert_eq!(names, vec!["game.nes"]);
}

#[test]
fn a_kind_filter_falls_back_to_nested_containers_when_no_payload_matches() {
    let kept = CliApp::filter_kind_auto_extract_candidates(
        Path::new("/games/archive.zip"),
        vec![candidate("inner.zip", false), candidate("notes.txt", false)],
        "checksum input",
        ArchiveEntryKindFilter::new(true, false),
    )
    .expect("container fallback matches");
    let names: Vec<&str> = kept
        .iter()
        .map(|candidate| candidate.display_name.as_str())
        .collect();
    assert_eq!(names, vec!["inner.zip"]);
}

#[test]
fn no_ignore_keeps_the_ignored_candidates_in_play() {
    let app = noninteractive_app();
    let (kept, selected) = app
        .filter_ignored_auto_extract_candidates(
            Path::new("/games/archive.zip"),
            vec![candidate(".DS_Store", true), candidate("game.nes", false)],
            "checksum input",
            true,
        )
        .expect("--no-ignore passes everything through");
    assert_eq!(kept.len(), 2);
    assert!(!selected, "nothing was interactively selected");
}

#[test]
fn ignored_candidates_are_dropped_when_a_real_one_survives() {
    let app = noninteractive_app();
    let (kept, selected) = app
        .filter_ignored_auto_extract_candidates(
            Path::new("/games/archive.zip"),
            vec![candidate(".DS_Store", true), candidate("game.nes", false)],
            "checksum input",
            false,
        )
        .expect("ignore filters apply");
    assert_eq!(
        kept.iter()
            .map(|candidate| candidate.display_name.as_str())
            .collect::<Vec<_>>(),
        vec!["game.nes"]
    );
    assert!(!selected);
}

#[test]
fn an_all_ignored_set_without_a_prompt_names_the_escape_flags() {
    let app = noninteractive_app();
    let error = app
        .filter_ignored_auto_extract_candidates(
            Path::new("/games/archive.zip"),
            vec![candidate(".DS_Store", true)],
            "checksum input",
            false,
        )
        .expect_err("everything was ignored");
    let message = error.to_string();
    assert!(message.contains("--no-ignore"), "{message}");
    assert!(message.contains("--select <pattern>"), "{message}");
}

#[test]
fn an_all_ignored_set_can_be_resolved_by_the_prompt() {
    let app = interactive_app(Some(1));
    let (kept, selected) = app
        .filter_ignored_auto_extract_candidates(
            Path::new("/games/archive.zip"),
            vec![candidate("._first", true), candidate(".DS_Store", true)],
            "checksum input",
            false,
        )
        .expect("the prompt picks one ignored candidate");
    assert_eq!(
        kept.iter()
            .map(|candidate| candidate.display_name.as_str())
            .collect::<Vec<_>>(),
        vec![".DS_Store"]
    );
    assert!(
        selected,
        "an interactively picked candidate skips the kind filter"
    );
}

#[test]
fn cancelling_the_ignored_prompt_fails_the_resolution() {
    let app = interactive_app(None);
    let error = app
        .filter_ignored_auto_extract_candidates(
            Path::new("/games/archive.zip"),
            vec![candidate(".DS_Store", true)],
            "checksum input",
            false,
        )
        .expect_err("cancelled prompt");
    assert!(
        error
            .to_string()
            .contains("interactive selection was cancelled"),
        "{error}"
    );
}

#[test]
fn a_single_candidate_needs_no_prompt() {
    let app = noninteractive_app();
    let selected = app
        .select_auto_extract_candidate(
            Path::new("/games/archive.zip"),
            vec![candidate("game.nes", false)],
            "checksum input",
        )
        .expect("one candidate resolves");
    assert_eq!(selected.display_name, "game.nes");
}

#[test]
fn ambiguous_candidates_without_a_prompt_ask_for_select() {
    let app = noninteractive_app();
    let error = app
        .select_auto_extract_candidate(
            Path::new("/games/archive.zip"),
            vec![candidate("one.nes", false), candidate("two.nes", false)],
            "checksum input",
        )
        .expect_err("ambiguous candidates");
    let message = error.to_string();
    assert!(message.contains("`one.nes`, `two.nes`"), "{message}");
    assert!(message.contains("Pass --select <pattern>"), "{message}");
}

#[test]
fn ambiguous_candidates_are_settled_by_the_prompt() {
    let app = interactive_app(Some(1));
    let selected = app
        .select_auto_extract_candidate(
            Path::new("/games/archive.zip"),
            vec![candidate("one.nes", false), candidate("two.nes", false)],
            "checksum input",
        )
        .expect("the prompt picks one");
    assert_eq!(selected.display_name, "two.nes");
}

#[test]
fn cancelling_the_ambiguous_prompt_fails_the_resolution() {
    let app = interactive_app(None);
    let error = app
        .select_auto_extract_candidate(
            Path::new("/games/archive.zip"),
            vec![candidate("one.nes", false), candidate("two.nes", false)],
            "checksum input",
        )
        .expect_err("cancelled prompt");
    assert!(
        error
            .to_string()
            .contains("interactive selection was cancelled"),
        "{error}"
    );
}

#[test]
fn an_extraction_that_produced_nothing_is_reported() {
    let dir = scratch_dir("empty-extract");
    let out_dir = dir.join("staged");
    fs::create_dir_all(&out_dir).expect("staging dir");
    let app = noninteractive_app();
    let error = app
        .resolve_auto_extract_candidate(
            Path::new("/games/archive.zip"),
            &out_dir,
            labels(),
            options(no_filter(), AutoExtractMode::Recursive),
        )
        .expect_err("no files were produced");
    assert!(
        error
            .to_string()
            .contains("payload extraction produced no files"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn resolving_a_candidate_applies_the_ignore_then_kind_filters() {
    let dir = scratch_dir("candidate-filters");
    let out_dir = dir.join("staged");
    fs::create_dir_all(&out_dir).expect("staging dir");
    fs::write(out_dir.join(".DS_Store"), b"ignored").expect("ignored file");
    fs::write(out_dir.join("notes.txt"), b"text").expect("text file");
    fs::write(out_dir.join("game.nes"), [0x55_u8; 4]).expect("rom file");
    let app = noninteractive_app();

    let selected = app
        .resolve_auto_extract_candidate(
            Path::new("/games/archive.zip"),
            &out_dir,
            labels(),
            options(
                ArchiveEntryKindFilter::new(true, false),
                AutoExtractMode::Recursive,
            ),
        )
        .expect("the rom is the only survivor");
    assert_eq!(selected.display_name, "game.nes");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn cleanup_removes_directories_and_files_and_ignores_what_is_gone() {
    let dir = scratch_dir("cleanup");
    let nested = dir.join("staged/deeper");
    fs::create_dir_all(&nested).expect("nested dir");
    let file = nested.join("payload.bin");
    fs::write(&file, b"payload").expect("payload");
    let loose = dir.join("loose.bin");
    fs::write(&loose, b"loose").expect("loose");
    let absent = dir.join("absent.bin");

    CliApp::cleanup_temp_paths(&[dir.join("staged"), loose.clone(), absent.clone()]);

    assert!(!dir.join("staged").exists());
    assert!(!loose.exists());
    assert!(!absent.exists());
    assert!(dir.exists(), "only the named paths are removed");
    fs::remove_dir_all(&dir).ok();
}
