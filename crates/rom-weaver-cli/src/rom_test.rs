use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clap::Args;
use rom_weaver_core::{
    IoOp, IoResultExt, NoninteractivePrompter, NoopProgressSink, OperationContext, Result,
    RomWeaverError, ThreadBudget, process_cancellation_token,
};
use serde_json::{Value, json};
use tracing::{debug, trace};

use crate::{
    CliApp,
    emulator_runtime::{EmulatorCore, EmulatorRuntime},
};

#[path = "rom_test/input.rs"]
mod input;

const MAX_CAPTURE_BYTES: u64 = 64 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Args)]
pub(crate) struct TestCommand {
    /// ROM or archive to test.
    pub(crate) input: PathBuf,
    /// Emulated frames before RetroArch captures the screenshot and exits.
    #[arg(long, default_value_t = 600, value_parser = clap::value_parser!(u32).range(1..=10_000_000))]
    pub(crate) frames: u32,
    /// Maximum emulator process runtime in seconds, after input preparation.
    #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u64).range(1..=3_600))]
    pub(crate) timeout: u64,
    /// Save the captured frame at this path.
    #[arg(long)]
    pub(crate) screenshot: Option<PathBuf>,
    /// Use an installed emulator runtime from this directory.
    #[arg(long)]
    pub(crate) runtime_dir: Option<PathBuf>,
    /// Select an installed core by ID; otherwise choose from the ROM extension.
    #[arg(long)]
    pub(crate) core: Option<String>,
    /// Copy BIOS and core assets from this directory into the isolated test workspace.
    #[arg(long)]
    pub(crate) system_dir: Option<PathBuf>,
    /// Pick one file from an archive by exact name, prefix, or glob.
    #[arg(long)]
    pub(crate) select: Option<String>,
}

pub(crate) fn run(command: &TestCommand, dry_run: bool) -> Result<Value> {
    if dry_run {
        return Ok(json!({
            "dry_run": true,
            "input": command.input,
            "message": "dry run: would smoke-test the ROM; nothing written",
            "requested_frames": command.frames,
            "timeout_seconds": command.timeout,
            "screenshot": command.screenshot,
            "runtime_dir": command.runtime_dir,
            "core": command.core,
            "system_dir": command.system_dir,
            "select": command.select,
            "status": "planned",
            "writes": command.screenshot.iter().collect::<Vec<_>>(),
        }));
    }
    if let Some(output) = command.screenshot.as_deref() {
        ensure_output_absent(output)?;
    }

    let runtime = crate::emulator_runtime::resolve(command.runtime_dir.as_deref())?;
    let workspace = Workspace::create()?;
    let context = OperationContext::new(
        ThreadBudget::Auto,
        workspace.path.join("extract"),
        Arc::new(NoopProgressSink),
        process_cancellation_token(),
    );
    let app = CliApp::new(
        Arc::new(NoopProgressSink),
        Arc::new(NoninteractivePrompter),
        false,
        false,
        false,
    );
    let selections = command.select.iter().cloned().collect::<Vec<_>>();
    let extensions = runtime
        .cores
        .iter()
        .flat_map(|core| core.extensions.iter().cloned())
        .collect();
    let resolved =
        app.resolve_emulator_source(&command.input, &selections, &context, &extensions)?;
    let core = select_core(&runtime, &resolved.source, command.core.as_deref())?;
    if core.id == "fceumm" && input::extension(&resolved.source) == "nes" {
        validate_nes(&resolved.source)?;
    }
    let rom = input::stage_rom(&resolved.source, &workspace.path.join("content"))?;
    input::stage_system(
        &runtime,
        core,
        command.system_dir.as_deref(),
        &workspace.path.join("system"),
    )?;
    let options = workspace.path.join("core-options.cfg");
    let settings = core
        .options
        .iter()
        .map(|(key, value)| format!("{key} = \"{value}\"\n"))
        .collect::<String>();
    fs::write(&options, settings).io_op(IoOp::Write, &options)?;

    let captured = workspace.path.join("captured.png");
    let config = workspace.path.join("retroarch.cfg");
    write_config(&config)?;
    let started = Instant::now();
    let process = execute(
        &runtime,
        core,
        &rom,
        &captured,
        &config,
        &workspace.path,
        command,
    )?;
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    if !process.status.success() {
        return Err(RomWeaverError::Validation(format!(
            "RetroArch exited with {} (stdout: {}; stderr: {})",
            exit_label(process.status),
            display_capture(&process.stdout),
            display_capture(&process.stderr),
        )));
    }
    validate_png(&captured)?;
    let sha256 = sha256_file(&captured)?;
    let screenshot = if let Some(output) = command.screenshot.as_deref() {
        publish_no_clobber(&captured, output)?;
        Some(output.to_path_buf())
    } else {
        None
    };

    for cleanup in resolved.cleanup_paths.iter().rev() {
        let _ = fs::remove_dir_all(cleanup);
        let _ = fs::remove_file(cleanup);
    }
    Ok(json!({
        "message": format!("smoke-tested {} frame(s) with {}", command.frames, core.id),
        "requested_frames": command.frames,
        "timeout_seconds": command.timeout,
        "status": "smoke-tested",
        "platform": core.platform,
        "core": core.id,
        "retroarch_revision": runtime.retroarch_revision,
        "core_revision": core.revision,
        "screenshot": screenshot,
        "screenshot_sha256": sha256,
        "elapsed_ms": elapsed_ms,
        "stdout": String::from_utf8_lossy(&process.stdout),
        "stderr": String::from_utf8_lossy(&process.stderr),
    }))
}

fn select_core<'a>(
    runtime: &'a EmulatorRuntime,
    rom: &Path,
    requested: Option<&str>,
) -> Result<&'a EmulatorCore> {
    if let Some(id) = requested {
        return runtime.cores.iter().find(|core| core.id == id).ok_or_else(|| RomWeaverError::Validation(format!(
            "core `{id}` is not installed; run `rom-weaver emulator info` to list installed cores"
        )));
    }
    let extension = input::extension(rom);
    let candidates = runtime
        .cores
        .iter()
        .filter(|core| core.extensions.contains(&extension))
        .collect::<Vec<_>>();
    if candidates.len() == 1 {
        return Ok(candidates[0]);
    }
    let ids = if candidates.is_empty() {
        runtime.cores.iter().collect::<Vec<_>>()
    } else {
        candidates
    };
    Err(RomWeaverError::Validation(format!(
        "cannot choose one core for `{}`; pass --core with one of: {}",
        rom.display(),
        ids.iter()
            .map(|core| core.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn execute(
    runtime: &EmulatorRuntime,
    core: &EmulatorCore,
    rom: &Path,
    screenshot: &Path,
    config: &Path,
    workspace: &Path,
    options: &TestCommand,
) -> Result<ProcessOutput> {
    let retroarch = &runtime.retroarch;
    let frames = options.frames;
    let timeout = Duration::from_secs(options.timeout);
    trace!(retroarch = %retroarch.display(), rom = %rom.display(), frames, "starting emulator smoke test");
    let home = workspace.join("home");
    let cache = workspace.join("cache");
    let config_home = workspace.join("config");
    let data = workspace.join("data");
    for path in [&home, &cache, &config_home, &data] {
        fs::create_dir_all(path).io_op(IoOp::CreateDir, path)?;
    }
    let mut command = Command::new(retroarch);
    command
        .arg("--verbose")
        .arg("--config")
        .arg(config)
        .arg("-L")
        .arg(&core.path)
        .arg(format!("--max-frames={frames}"))
        .arg("--max-frames-ss")
        .arg(format!("--max-frames-ss-path={}", screenshot.display()))
        .arg("--sram-mode=noload-nosave")
        .arg(rom)
        .current_dir(workspace)
        .env_clear()
        .env("HOME", &home)
        .env("XDG_CACHE_HOME", &cache)
        .env("XDG_CONFIG_HOME", &config_home)
        .env("XDG_DATA_HOME", &data)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut process = RunningEmulator {
        child: command.spawn().io_op(IoOp::Open, retroarch)?,
        stopped: false,
    };
    let stdout = process.child.stdout.take().expect("piped stdout");
    let stderr = process.child.stderr.take().expect("piped stderr");
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let started = Instant::now();
    let cancellation = process_cancellation_token();
    let status = loop {
        if let Some(status) = process.child.try_wait().map_err(RomWeaverError::Io)? {
            break status;
        }
        if cancellation.is_cancelled() {
            process.stop();
            return Err(RomWeaverError::Cancelled);
        }
        if started.elapsed() >= timeout {
            process.stop();
            let stdout = stdout_reader.join().unwrap_or_default();
            let stderr = stderr_reader.join().unwrap_or_default();
            return Err(RomWeaverError::Validation(format!(
                "RetroArch timed out after {} seconds (stdout: {}; stderr: {})",
                timeout.as_secs(),
                display_capture(&stdout),
                display_capture(&stderr),
            )));
        }
        thread::sleep(Duration::from_millis(10));
    };
    // Descendants MUST close inherited pipes before the readers are joined.
    process.stop();
    Ok(ProcessOutput {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

fn read_bounded(mut reader: impl Read) -> Vec<u8> {
    let mut captured = Vec::new();
    let _ = reader
        .by_ref()
        .take(MAX_CAPTURE_BYTES)
        .read_to_end(&mut captured);
    let _ = std::io::copy(&mut reader, &mut std::io::sink());
    captured
}

struct RunningEmulator {
    child: Child,
    stopped: bool,
}

impl RunningEmulator {
    fn stop(&mut self) {
        if !self.stopped {
            self.stopped = true;
            kill_and_reap(&mut self.child);
        }
    }
}

impl Drop for RunningEmulator {
    fn drop(&mut self) {
        self.stop();
    }
}

fn kill_and_reap(child: &mut Child) {
    #[cfg(unix)]
    {
        // The child owns this process group, which also contains inherited pipes.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn validate_nes(path: &Path) -> Result<()> {
    let mut header = [0_u8; 16];
    File::open(path)
        .io_op(IoOp::Open, path)?
        .read_exact(&mut header)
        .io_op(IoOp::Open, path)?;
    if &header[..4] != b"NES\x1a" {
        return Err(RomWeaverError::Validation(format!(
            "`{}` is not an iNES or NES 2.0 ROM",
            path.display()
        )));
    }
    Ok(())
}

fn validate_png(path: &Path) -> Result<()> {
    let bytes = fs::read(path).io_op(IoOp::Open, path)?;
    let valid = bytes.len() >= 33
        && bytes.starts_with(PNG_SIGNATURE)
        && &bytes[12..16] == b"IHDR"
        && bytes.windows(4).any(|chunk| chunk == b"IEND");
    if !valid {
        return Err(RomWeaverError::Validation(format!(
            "RetroArch did not create a valid PNG screenshot at `{}`",
            path.display()
        )));
    }
    Ok(())
}

fn write_config(path: &Path) -> Result<()> {
    File::create(path)
        .io_op(IoOp::Create, path)?
        .write_all(
            br#"video_driver = "null"
audio_driver = "null"
input_driver = "null"
network_cmd_enable = "false"
network_remote_enable = "false"
config_save_on_exit = "false"
core_options_path = "./core-options.cfg"
system_directory = "./system"
savefile_directory = "./saves"
savestate_directory = "./states"
video_vsync = "false"
audio_enable = "false"
history_list_enable = "false"
autosave_interval = "0"
block_sram_overwrite = "true"
auto_overrides_enable = "false"
auto_remaps_enable = "false"
video_shader_enable = "false"
run_ahead_enabled = "false"
rewind_enable = "false"
ups_pref = "false"
bps_pref = "false"
ips_pref = "false"
"#,
        )
        .io_op(IoOp::Write, path)
}

fn ensure_output_absent(path: &Path) -> Result<()> {
    if path.exists() {
        return Err(RomWeaverError::Validation(format!(
            "refusing to overwrite existing screenshot `{}`",
            path.display()
        )));
    }
    Ok(())
}

fn publish_no_clobber(source: &Path, output: &Path) -> Result<()> {
    ensure_output_absent(output)?;
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).io_op(IoOp::CreateDir, parent)?;
    let mut input = File::open(source).io_op(IoOp::Open, source)?;
    let mut target = File::options()
        .write(true)
        .create_new(true)
        .open(output)
        .io_op(IoOp::Create, output)?;
    rom_weaver_core::register_in_progress_output(output);
    if let Err(error) = std::io::copy(&mut input, &mut target).io_op(IoOp::Write, output) {
        let _ = fs::remove_file(output);
        return Err(error);
    }
    if let Err(error) = target.sync_all().io_op(IoOp::Write, output) {
        let _ = fs::remove_file(output);
        return Err(error);
    }
    rom_weaver_core::complete_in_progress_output(output);
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut stream = rom_weaver_checksum::StreamingChecksum::new(&["sha256".to_string()])?
        .ok_or_else(|| RomWeaverError::Validation("sha256 is unavailable".to_string()))?;
    let mut file = File::open(path).io_op(IoOp::Open, path)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).io_op(IoOp::Open, path)?;
        if count == 0 {
            break;
        }
        stream.update(&buffer[..count])?;
    }
    stream
        .finalize()?
        .remove("sha256")
        .ok_or_else(|| RomWeaverError::Validation("sha256 result is missing".to_string()))
}

fn exit_label(status: ExitStatus) -> String {
    status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "a signal".to_string())
}

fn display_capture(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.is_empty() {
        "<empty>".to_string()
    } else {
        text.trim().to_string()
    }
}

struct Workspace {
    path: PathBuf,
}

impl Workspace {
    fn create() -> Result<Self> {
        let root = cache_root()?.join("rom-weaver").join("test");
        fs::create_dir_all(&root).io_op(IoOp::CreateDir, &root)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = root.join(format!("{}-{nonce}", std::process::id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).io_op(IoOp::CreateDir, &path)?;
        let path = fs::canonicalize(&path).io_op(IoOp::Inspect, &path)?;
        debug!(workspace = %path.display(), "created emulator test workspace");
        Ok(Self { path })
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.path) {
            debug!(path = %self.path.display(), %error, "could not remove emulator test workspace");
        }
    }
}

fn cache_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| {
        RomWeaverError::Validation(
            "HOME or XDG_CACHE_HOME is required for emulator test scratch files".to_string(),
        )
    })?;
    Ok(PathBuf::from(home).join(".cache"))
}
