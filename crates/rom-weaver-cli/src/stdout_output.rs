#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    fmt,
    io::{self, Write},
    process::ExitCode,
    sync::Mutex,
};

static OUTPUT_ERROR: Mutex<Option<io::Error>> = Mutex::new(None);

#[cfg(unix)]
static STDOUT_CLOSED_AT_START: AtomicBool = AtomicBool::new(false);

// The Rust runtime reopens a closed descriptor 1 as /dev/null before `main`,
// so every later write succeeds and loses its data. This constructor runs
// before the runtime and records the closed state first.
#[cfg(unix)]
extern "C" fn record_closed_stdout() {
    // SAFETY: F_GETFD only queries the descriptor table.
    let closed = unsafe { libc::fcntl(libc::STDOUT_FILENO, libc::F_GETFD) } == -1
        && io::Error::last_os_error().raw_os_error() == Some(libc::EBADF);
    STDOUT_CLOSED_AT_START.store(closed, Ordering::Relaxed);
}

#[cfg(unix)]
#[used]
#[cfg_attr(
    target_vendor = "apple",
    unsafe(link_section = "__DATA,__mod_init_func")
)]
#[cfg_attr(not(target_vendor = "apple"), unsafe(link_section = ".init_array"))]
static RECORD_CLOSED_STDOUT: extern "C" fn() = record_closed_stdout;

/// Fails with EBADF when the process started without a stdout descriptor.
/// Every stdout writer MUST call it first; the runtime's substitute
/// descriptor would otherwise accept the bytes.
#[cfg(unix)]
pub(crate) fn ensure_open() -> io::Result<()> {
    if STDOUT_CLOSED_AT_START.load(Ordering::Relaxed) {
        return Err(io::Error::from_raw_os_error(libc::EBADF));
    }
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn ensure_open() -> io::Result<()> {
    Ok(())
}

// Output errors MUST NOT unwind an operation that is writing a ROM. Preserve
// the first error for the CLI exit status and let the operation finish cleanup.
pub(crate) fn write(arguments: fmt::Arguments<'_>) {
    let mut error = OUTPUT_ERROR
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if error.is_some() {
        return;
    }
    let written = ensure_open().and_then(|()| {
        let mut stdout = io::stdout().lock();
        stdout.write_fmt(arguments).and_then(|()| stdout.flush())
    });
    if let Err(failure) = written {
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
