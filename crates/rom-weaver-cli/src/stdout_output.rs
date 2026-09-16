use std::{
    fmt,
    io::{self, Write},
    process::ExitCode,
    sync::Mutex,
};

static OUTPUT_ERROR: Mutex<Option<io::Error>> = Mutex::new(None);

// Output errors MUST NOT unwind an operation that is writing a ROM. Preserve
// the first error for the CLI exit status and let the operation finish cleanup.
pub(crate) fn write(arguments: fmt::Arguments<'_>) {
    let mut error = OUTPUT_ERROR
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if error.is_some() {
        return;
    }
    let mut stdout = io::stdout().lock();
    if let Err(failure) = stdout.write_fmt(arguments).and_then(|()| stdout.flush()) {
        *error = Some(failure);
    }
}

pub(crate) fn record_error(failure: io::Error) {
    let mut error = OUTPUT_ERROR
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if error.is_none() {
        *error = Some(failure);
    }
}

pub(crate) fn finish(status: ExitCode, json: bool) -> ExitCode {
    let error = OUTPUT_ERROR
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(error) = error.as_ref() else {
        return status;
    };
    if error.kind() == io::ErrorKind::BrokenPipe {
        return status;
    }
    crate::native_output::diagnostic(
        json,
        "ERROR",
        "cli",
        &format!("cannot write stdout: {error}"),
    );
    if status == ExitCode::SUCCESS {
        return ExitCode::FAILURE;
    }
    status
}
