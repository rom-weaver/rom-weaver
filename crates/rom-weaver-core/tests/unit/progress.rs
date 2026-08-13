use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

use super::*;
use crate::{CancellationToken, OperationContext, RecordingProgressSink, ThreadBudget};

#[test]
fn byte_progress_suppresses_zero_duplicates_and_backwards_buckets() {
    let sink = Arc::new(RecordingProgressSink::default());
    let context = OperationContext::new(
        ThreadBudget::Fixed(1),
        std::env::temp_dir(),
        sink.clone(),
        CancellationToken::new(),
    );
    let emitted_progress_bucket = AtomicU8::new(0);
    let progress = ContainerByteProgress {
        command: "extract",
        format: "zip",
        stage: "extract",
        label: "payload",
        thread_execution: None,
        emitted_progress_bucket: &emitted_progress_bucket,
    };

    maybe_emit_container_byte_progress(&context, 0, 0, progress);
    maybe_emit_container_byte_progress(&context, 0, 100, progress);
    assert!(sink.snapshot().is_empty());

    maybe_emit_container_byte_progress(&context, 10, 100, progress);
    let events = sink.snapshot();
    assert_eq!(events.len(), 10);
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.percent, Some((index + 1) as f32));
    }

    maybe_emit_container_byte_progress(&context, 10, 100, progress);
    assert_eq!(sink.snapshot().len(), 10);

    maybe_emit_container_byte_progress(&context, 120, 100, progress);
    let events = sink.snapshot();
    assert_eq!(events.len(), 100);
    assert_eq!(emitted_progress_bucket.load(Ordering::Relaxed), 100);
    assert_eq!(events.last().and_then(|event| event.percent), Some(100.0));

    maybe_emit_container_byte_progress(&context, 90, 100, progress);
    assert_eq!(sink.snapshot().len(), 100);
}
