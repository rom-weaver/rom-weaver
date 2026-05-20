enum OutputMode {
    Json,
    Text,
}

struct StdoutReporter {
    mode: OutputMode,
}

impl StdoutReporter {
    fn json() -> Self {
        Self {
            mode: OutputMode::Json,
        }
    }

    fn text() -> Self {
        Self {
            mode: OutputMode::Text,
        }
    }
}

struct ProgressFilterReporter {
    inner: Arc<dyn ProgressSink>,
    allow_running: bool,
}

impl ProgressFilterReporter {
    fn suppress_running(inner: Arc<dyn ProgressSink>) -> Self {
        Self {
            inner,
            allow_running: false,
        }
    }
}

impl ProgressSink for ProgressFilterReporter {
    fn emit(&self, event: ProgressEvent) {
        if !self.allow_running && event.status == OperationStatus::Running {
            return;
        }
        self.inner.emit(event);
    }
}

impl ProgressSink for StdoutReporter {
    fn emit(&self, event: ProgressEvent) {
        match self.mode {
            OutputMode::Json => match serde_json::to_string(&event) {
                Ok(serialized) => println!("{serialized}"),
                Err(error) => eprintln!("failed to serialize CLI progress event: {error}"),
            },
            OutputMode::Text => {
                let format = event.format.as_deref().unwrap_or("-");
                let threads = match (
                    event.requested_threads,
                    event.effective_threads,
                    event.used_parallelism,
                    event.thread_mode,
                ) {
                    (
                        Some(requested),
                        Some(effective),
                        Some(used_parallelism),
                        Some(thread_mode),
                    ) => {
                        format!(
                            " requested_threads={requested} effective_threads={effective} thread_mode={thread_mode:?} used_parallelism={used_parallelism}"
                        )
                    }
                    _ => String::new(),
                };
                println!(
                    "[{}] family={:?} format={} stage={} status={:?} label={}{}",
                    event.command,
                    event.family,
                    format,
                    event.stage,
                    event.status,
                    event.label,
                    threads,
                );
            }
        }
    }
}

