use super::*;

#[derive(Default)]
struct CapturingProgressSink(Mutex<Option<ProgressEvent>>);

impl ProgressSink for CapturingProgressSink {
    fn emit(&self, event: ProgressEvent) {
        *self.0.lock().unwrap() = Some(event);
    }
}

#[test]
fn report_error_preserves_failed_kind_and_keeps_cancelled_events_untyped() {
    let captured = Arc::new(CapturingProgressSink::default());
    let reporter: Arc<dyn ProgressSink> = captured.clone();

    report_error(
        &reporter,
        true,
        "compress",
        "cli.stream",
        &RomWeaverError::Io(io::Error::other("stream failed")),
        1,
    );
    let event = captured.0.lock().unwrap().clone().unwrap();
    assert_eq!(event.status, OperationStatus::Failed);
    assert_eq!(
        event.error_kind,
        Some(rom_weaver_core::RomWeaverErrorKind::Io)
    );
    assert_eq!(event.label, "i/o error: stream failed");

    report_error(
        &reporter,
        true,
        "compress",
        "cli.stream",
        &RomWeaverError::Cancelled,
        130,
    );
    let event = captured.0.lock().unwrap().clone().unwrap();
    assert_eq!(event.status, OperationStatus::Cancelled);
    assert_eq!(event.error_kind, None);
}
