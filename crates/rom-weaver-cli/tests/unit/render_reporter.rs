use super::*;

fn running_event(label: &str, percent: Option<f32>) -> ProgressEvent {
    ProgressEvent {
        command: "compress".to_string(),
        stage: "create".to_string(),
        label: label.to_string(),
        percent,
        status: OperationStatus::Running,
        ..ProgressEvent::from_thread_execution(None)
    }
}

#[test]
fn forced_plain_progress_shows_work_without_a_percentage_once() {
    let mut deciles: HashMap<String, PlainProgress> = HashMap::new();
    let event = running_event("preparing zip archive", None);
    assert_eq!(
        plain_progress_line(&mut deciles, "create".into(), &event, None),
        Some("preparing zip archive".to_string())
    );
    assert_eq!(
        plain_progress_line(&mut deciles, "create".into(), &event, None),
        None
    );
    deciles.get_mut("create").unwrap().printed_at -= Duration::from_secs(1);
    assert_eq!(
        plain_progress_line(&mut deciles, "create".into(), &event, Some(10.0)),
        Some(" 10% preparing zip archive".to_string())
    );
}

#[test]
fn forced_plain_progress_limits_each_stage_to_deciles() {
    let mut deciles: HashMap<String, PlainProgress> = HashMap::new();
    let event = running_event("compressing archive", None);
    let lines = (0..=1000)
        .filter_map(|value| {
            for previous in deciles.values_mut() {
                previous.printed_at -= Duration::from_secs(1);
            }
            plain_progress_line(
                &mut deciles,
                "create".into(),
                &event,
                Some(value as f32 / 10.0),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 11);
    assert_eq!(lines.first().unwrap(), "  0% compressing archive");
    assert_eq!(lines.last().unwrap(), "100% compressing archive");
    assert!(plain_progress_line(&mut deciles, "create".into(), &event, Some(50.0)).is_none());
}

#[test]
fn forced_plain_progress_escapes_control_characters_in_labels() {
    let mut deciles: HashMap<String, PlainProgress> = HashMap::new();
    let event = running_event("extracting game\r\n\x1b[2J", None);
    assert_eq!(
        plain_progress_line(&mut deciles, "extract".into(), &event, None),
        Some("extracting game\\r\\n\\u{1b}[2J".to_string())
    );
}

#[test]
fn quiet_suppresses_even_forced_progress() {
    let reporter = HumanReporter::new(HumanStyle::Simple, Some(false), true);
    reporter.emit(running_event("compressing archive", Some(50.0)));
    assert!(reporter.lock().is_none());
    assert!(reporter.simple_deciles.lock().unwrap().is_empty());
}

#[test]
fn terminal_event_resets_plain_progress_for_the_next_operation() {
    let mut reporter = HumanReporter::new(HumanStyle::Simple, Some(false), false);
    reporter.progress_is_terminal = false;
    reporter.emit(running_event("compressing first archive", Some(100.0)));
    assert!(!reporter.simple_deciles.lock().unwrap().is_empty());
    reporter.finish_progress();
    assert!(reporter.simple_deciles.lock().unwrap().is_empty());
    reporter.emit(running_event("compressing second archive", Some(0.0)));
    assert!(!reporter.simple_deciles.lock().unwrap().is_empty());
}

#[test]
fn fast_plain_progress_emits_initial_and_final_updates_only() {
    let mut deciles = HashMap::new();
    let event = running_event("compressing archive", None);
    let lines = (0..=100)
        .filter_map(|value| {
            plain_progress_line(&mut deciles, "create".into(), &event, Some(value as f32))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        lines,
        vec!["  0% compressing archive", "100% compressing archive"]
    );
}

fn written_event(command: &str, path: &str) -> ProgressEvent {
    ProgressEvent {
        command: command.to_string(),
        status: OperationStatus::Succeeded,
        format: Some("zip".to_string()),
        details: Some(serde_json::json!({
            "emitted_files": [{ "path": path, "size_bytes": 1500 }],
        })),
        ..ProgressEvent::from_thread_execution(None)
    }
}

fn confirmation_reporter(path: &str, terminal: bool, quiet: bool) -> HumanReporter {
    let mut reporter = HumanReporter::with_selection(
        HumanStyle::Simple,
        Some(false),
        quiet,
        false,
        commands::OutputSelection::with_explicit_output(path),
    );
    reporter.progress_is_terminal = terminal;
    reporter
}

#[test]
fn explicit_output_is_confirmed_only_on_an_interactive_stderr() {
    let event = written_event("compress", "game.zip");
    assert_eq!(
        confirmation_reporter("game.zip", true, false).output_confirmation_lines(&event),
        ["compress: wrote game.zip (1.5 KB, zip)"]
    );
    assert!(
        confirmation_reporter("game.zip", false, false)
            .output_confirmation_lines(&event)
            .is_empty()
    );
    assert!(
        confirmation_reporter("game.zip", true, true)
            .output_confirmation_lines(&event)
            .is_empty()
    );
}

#[test]
fn output_confirmation_skips_stdout_other_commands_and_generated_names() {
    let reporter = confirmation_reporter("game.zip", true, false);
    assert!(
        reporter
            .output_confirmation_lines(&written_event("extract", "game.zip"))
            .is_empty()
    );
    assert!(
        reporter
            .output_confirmation_lines(&written_event("compress", "other.zip"))
            .is_empty()
    );
    assert!(
        confirmation_reporter("-", true, false)
            .output_confirmation_lines(&written_event("compress", "-"))
            .is_empty()
    );
}

#[test]
fn human_errors_drop_only_the_standard_validation_prefix() {
    assert_eq!(
        human_error_text("validation failed: bad input"),
        "bad input"
    );
    assert_eq!(
        human_error_text("i/o error: disk full"),
        "i/o error: disk full"
    );
    assert_eq!(
        human_error_text("x: validation failed: kept"),
        "x: validation failed: kept"
    );
}

#[test]
fn confirmation_names_the_codec_not_the_patch_format() {
    let reporter = confirmation_reporter("game.zip", true, false);
    let mut applied = written_event("patch-apply", "game.zip");
    applied.format = Some("IPS".to_string());
    assert_eq!(
        reporter.output_confirmation_lines(&applied),
        ["patch-apply: wrote game.zip (1.5 KB)"]
    );
    let mut packed = written_event("compress", "game.zip");
    packed.details = Some(serde_json::json!({
        "emitted_files": [{ "path": "game.zip", "size_bytes": 1500 }],
        "compression": { "codec": "deflate" },
    }));
    assert_eq!(
        reporter.output_confirmation_lines(&packed),
        ["compress: wrote game.zip (1.5 KB, deflate)"]
    );
}

#[test]
fn trim_confirmation_names_the_written_format_not_the_rom_kind() {
    let reporter = confirmation_reporter("game.7z", true, false);
    let mut trimmed = written_event("trim", "game.7z");
    trimmed.format = Some("nds".to_string());
    assert_eq!(
        reporter.output_confirmation_lines(&trimmed),
        ["trim: wrote game.7z (1.5 KB)"]
    );
    trimmed.details = Some(serde_json::json!({
        "emitted_files": [{ "path": "game.7z", "size_bytes": 1500 }],
        "output_format": "7z",
    }));
    assert_eq!(
        reporter.output_confirmation_lines(&trimmed),
        ["trim: wrote game.7z (1.5 KB, 7z)"]
    );
}

#[test]
fn every_explicit_file_output_command_confirms_its_write() {
    let reporter = confirmation_reporter("out.bin", true, false);
    for command in [
        "playlist",
        "bundle-create",
        "save-create",
        "save-set",
        "tools-ppf-undo",
    ] {
        assert_eq!(
            reporter.output_confirmation_lines(&written_event(command, "out.bin")),
            [format!("{command}: wrote out.bin (1.5 KB)")],
            "{command}"
        );
    }
}
