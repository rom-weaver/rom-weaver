//! Thread-local `tracing` subscriber for tests.
//!
//! The `tracing` macros skip their field expressions entirely when no subscriber
//! is installed, so instrumentation only runs - and can only be asserted on -
//! with one in place. Tracing is this project's primary tool for debugging
//! wasm/browser runs (see AGENTS.md), so a pipeline that stops emitting a stage
//! is a real regression.
//!
//! Included from several test modules with `#[path]`; each gets its own copy.

use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct TraceCapture {
    events: Arc<Mutex<Vec<String>>>,
}

impl TraceCapture {
    pub fn rendered(&self) -> Vec<String> {
        self.events.lock().expect("trace lock").clone()
    }

    /// Runs `body` with this capture installed as the thread-local subscriber.
    pub fn record<R>(&self, body: impl FnOnce() -> R) -> R {
        let _guard = tracing::subscriber::set_default(self.clone());
        body()
    }

    pub fn missing<'a>(&self, needles: &[&'a str]) -> Vec<&'a str> {
        let rendered = self.rendered();
        needles
            .iter()
            .copied()
            .filter(|needle| !rendered.iter().any(|line| line.contains(needle)))
            .collect()
    }

    #[track_caller]
    pub fn assert_contains_all(&self, needles: &[&str]) {
        let missing = self.missing(needles);
        assert!(
            missing.is_empty(),
            "missing trace breadcrumbs {missing:?} in {:#?}",
            self.rendered()
        );
    }
}

#[derive(Default)]
struct FieldText(String);

impl tracing::field::Visit for FieldText {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!(" {}={value:?}", field.name()));
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0.push_str(&format!(" {}={value}", field.name()));
    }
}

impl tracing::Subscriber for TraceCapture {
    fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut text = FieldText::default();
        event.record(&mut text);
        self.events.lock().expect("trace lock").push(text.0);
    }

    fn enter(&self, _span: &tracing::span::Id) {}

    fn exit(&self, _span: &tracing::span::Id) {}
}
