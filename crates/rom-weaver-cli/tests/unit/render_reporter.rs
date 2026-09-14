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
    let mut deciles = HashMap::new();
    let event = running_event("preparing zip archive", None);
    assert_eq!(
        plain_progress_line(&mut deciles, "create".into(), &event, None),
        Some("preparing zip archive".to_string())
    );
    assert_eq!(
        plain_progress_line(&mut deciles, "create".into(), &event, None),
        None
    );
    assert_eq!(
        plain_progress_line(&mut deciles, "create".into(), &event, Some(10.0)),
        Some(" 10% preparing zip archive".to_string())
    );
}

#[test]
fn forced_plain_progress_limits_each_stage_to_deciles() {
    let mut deciles = HashMap::new();
    let event = running_event("compressing archive", None);
    let lines = (0..=1000)
        .filter_map(|value| {
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
    let mut deciles = HashMap::new();
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
