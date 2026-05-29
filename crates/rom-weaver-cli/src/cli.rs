use std::process::ExitCode;

#[cfg(not(target_arch = "wasm32"))]
use std::io::{self, IsTerminal};

#[cfg(not(target_arch = "wasm32"))]
use clap::Parser;
#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_app::{Commands, RomWeaverRunOutputOptions, RomWeaverRunRequest, run_request};

#[derive(Debug)]
#[cfg(not(target_arch = "wasm32"))]
#[cfg_attr(not(target_arch = "wasm32"), derive(Parser))]
#[cfg_attr(
    not(target_arch = "wasm32"),
    command(
        name = "rom-weaver",
        version,
        about = "Native CLI groundwork for ROM inspection, extraction, checksums, compression, trimming, and patching."
    )
)]
struct Cli {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help = "Emit progress and terminal status as JSON lines"
        )
    )]
    json: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            conflicts_with = "no_progress",
            help = "Force running progress events on"
        )
    )]
    progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-progress",
            global = true,
            conflicts_with = "progress",
            help = "Disable running progress events"
        )
    )]
    no_progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help = "Enable trace logs (also enabled by ROM_WEAVER_LOG or RUST_LOG)"
        )
    )]
    trace: bool,
    #[cfg_attr(not(target_arch = "wasm32"), command(subcommand))]
    command: Commands,
}

#[cfg(not(target_arch = "wasm32"))]
impl Cli {
    fn into_run_request(self) -> RomWeaverRunRequest {
        let output = RomWeaverRunOutputOptions {
            json: self.json,
            progress: progress_override(self.progress, self.no_progress),
            trace: self.trace,
            interactive_selection_enabled: !self.json
                && io::stdin().is_terminal()
                && io::stderr().is_terminal(),
        };
        RomWeaverRunRequest {
            command: self.command,
            output,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn progress_override(progress: bool, no_progress: bool) -> Option<bool> {
    if no_progress {
        return Some(false);
    }
    if progress {
        return Some(true);
    }
    None
}

#[cfg(not(target_arch = "wasm32"))]
pub fn main_entry() -> ExitCode {
    let request = Cli::parse().into_run_request();
    run_request(request, io::stdout().is_terminal())
}

#[cfg(target_arch = "wasm32")]
pub fn main_entry() -> ExitCode {
    eprintln!("rom-weaver-cli is native-only; build rom-weaver-app for wasm");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::progress_override;
    use rom_weaver_app::{RomWeaverRunOutputOptions, RunCommandOptions};

    fn output(json: bool, progress: Option<bool>) -> RomWeaverRunOutputOptions {
        RomWeaverRunOutputOptions {
            json,
            progress,
            trace: false,
            interactive_selection_enabled: false,
        }
    }

    #[test]
    fn progress_defaults_follow_tty_and_json_mode() {
        assert!(RunCommandOptions::from_output(output(false, None), true).emit_progress_events);
        assert!(!RunCommandOptions::from_output(output(false, None), false).emit_progress_events);
        assert!(RunCommandOptions::from_output(output(true, None), false).emit_progress_events);
    }

    #[test]
    fn progress_flags_override_defaults() {
        assert!(
            RunCommandOptions::from_output(output(false, Some(true)), false).emit_progress_events
        );
        assert!(
            !RunCommandOptions::from_output(output(true, Some(false)), true).emit_progress_events
        );
    }

    #[test]
    fn progress_flags_map_to_request_progress_override() {
        assert_eq!(progress_override(false, false), None);
        assert_eq!(progress_override(true, false), Some(true));
        assert_eq!(progress_override(false, true), Some(false));
    }
}
