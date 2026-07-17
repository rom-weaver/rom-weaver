use std::process::ExitCode;

#[cfg(not(target_arch = "wasm32"))]
use std::io::{self, IsTerminal};
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;

#[cfg(not(target_arch = "wasm32"))]
use clap::{CommandFactory, FromArgMatches, Parser};
#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_app::{
    BundleCommands, Commands, JsonProgressSink, PatchCommands, RomWeaverRunOutputOptions,
    RunCommandOptions, run_command,
};
#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_core::{NoninteractivePrompter, ProgressSink, SelectionPrompter};

#[cfg(not(target_arch = "wasm32"))]
use crate::render::{HumanReporter, HumanStyle, StdinPrompter};

#[derive(Debug)]
#[cfg(not(target_arch = "wasm32"))]
#[cfg_attr(not(target_arch = "wasm32"), derive(Parser))]
#[cfg_attr(
    not(target_arch = "wasm32"),
    command(
        name = "rom-weaver",
        version,
        about = "Inspect, extract, checksum, compress, trim, and patch ROMs and disc images"
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
pub fn cli_command() -> clap::Command {
    Cli::command()
}

#[cfg(not(target_arch = "wasm32"))]
impl Cli {
    fn output_options(&self, interactive: bool) -> RomWeaverRunOutputOptions {
        RomWeaverRunOutputOptions {
            json: self.json,
            progress: progress_override(self.progress, self.no_progress),
            trace: self.trace,
            interactive_selection_enabled: interactive,
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
    // Two-step parse (matches + derive) instead of `Cli::parse()`: positional
    // `--patch-header` occurrences bind to the preceding `--patch`, and only the
    // raw `ArgMatches` argv indices preserve that interleave order.
    let matches = cli_command().get_matches();
    let mut cli = match Cli::from_arg_matches(&matches) {
        Ok(cli) => cli,
        Err(error) => error.exit(),
    };
    if let Commands::Patch(PatchCommands::Apply(command)) = &mut cli.command
        && let Some((_, patch_matches)) = matches.subcommand()
        && let Some((_, apply_matches)) = patch_matches.subcommand()
    {
        command.align_patch_header_modes(apply_matches);
        command.align_patch_basis(apply_matches);
    }
    if let Commands::Bundle(BundleCommands::Create(command)) = &mut cli.command
        && let Some((_, bundle_matches)) = matches.subcommand()
        && let Some((_, create_matches)) = bundle_matches.subcommand()
    {
        command.align_bundle_patch_metadata(create_matches);
    }
    if let Commands::Patch(PatchCommands::Validate(command)) = &mut cli.command
        && let Some((_, patch_matches)) = matches.subcommand()
        && let Some((_, validate_matches)) = patch_matches.subcommand()
    {
        command.align_plan_flags(validate_matches);
    }
    let stdout_is_tty = io::stdout().is_terminal();
    // Interactive prompting needs a terminal on both stdin (to read) and stderr (to draw), and is
    // meaningless when emitting JSON.
    let interactive = !cli.json && io::stdin().is_terminal() && io::stderr().is_terminal();
    let options = RunCommandOptions::from_output(cli.output_options(interactive), stdout_is_tty);

    // `--json` passes the event stream straight through; otherwise render for humans - richly when
    // stdout is a terminal, plainly when piped.
    let reporter: Arc<dyn ProgressSink> = if cli.json {
        Arc::new(JsonProgressSink)
    } else if stdout_is_tty {
        Arc::new(HumanReporter::new(HumanStyle::Rich))
    } else {
        Arc::new(HumanReporter::new(HumanStyle::Simple))
    };
    let prompter: Arc<dyn SelectionPrompter> = if interactive {
        Arc::new(StdinPrompter::new())
    } else {
        Arc::new(NoninteractivePrompter)
    };

    run_command(cli.command, options, reporter, prompter)
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
