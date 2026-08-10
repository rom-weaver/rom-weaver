use std::process::ExitCode;

#[cfg(not(target_arch = "wasm32"))]
use std::io::{self, IsTerminal};
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;

#[cfg(not(target_arch = "wasm32"))]
use clap::{ArgAction, CommandFactory, FromArgMatches, Parser, Subcommand};
#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_app::{
    BundleCommands, Commands, JsonProgressSink, LogLevel, PATCH_APPLY_AFTER_HELP,
    PATCH_APPLY_LONG_ABOUT, PatchApplyCommand, PatchCommands, RomWeaverRunOutputOptions,
    RunCommandOptions, run_command, run_command_outcome,
};
#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_core::{
    NoninteractivePrompter, ProgressSink, SelectionPrompter, clear_in_progress_outputs,
    process_cancellation_token, remove_in_progress_outputs,
};

#[cfg(not(target_arch = "wasm32"))]
use crate::formats_command::print_formats;
#[cfg(not(target_arch = "wasm32"))]
use crate::render::{HumanReporter, HumanStyle, StdinPrompter};

/// Heading the global flags are listed under. Every subcommand inherits the
/// globals, so without a heading they interleave with that command's own
/// options and make the list hard to scan.
#[cfg(not(target_arch = "wasm32"))]
const GLOBAL_HELP_HEADING: &str = "Global options";

#[cfg(not(target_arch = "wasm32"))]
const CLI_LONG_ABOUT: &str = "\
Inspect, extract, checksum, compress, trim, and patch ROMs and disc images.

rom-weaver reads compressed input directly, so you rarely have to unpack a file
first. Point --input at an archive or single-payload compressed format; the ROM
inside it is found for you. Pass --no-extract to work on the raw bytes instead.

Everything runs on your machine. Nothing is uploaded.";

#[cfg(not(target_arch = "wasm32"))]
const CLI_AFTER_HELP: &str = "\
Examples:
  # What is this file?
  rom-weaver probe --input game.iso

  # Apply a patch, writing a plain ROM
  rom-weaver patch apply --input game.sfc --patch hack.bps \\
    --output hacked.sfc --no-compress

  # Two patches in order; the .zip extension compresses the result
  rom-weaver patch apply --input game.sfc \\
    --patch base.ips --patch fixes.ups --output hacked.zip

  # Hash a ROM, including one inside an archive
  rom-weaver checksum --input game.zip --algo crc32,sha1

  # Shrink a disc image; the .cue brings its tracks along
  rom-weaver compress --input game.cue --output game.chd

Full guide: https://rom-weaver.com/docs/cli";

#[derive(Debug)]
#[cfg(not(target_arch = "wasm32"))]
#[cfg_attr(not(target_arch = "wasm32"), derive(Parser))]
#[cfg_attr(
    not(target_arch = "wasm32"),
    command(
        name = "rom-weaver",
        version,
        about = "Inspect, extract, checksum, compress, trim, and patch ROMs and disc images",
        long_about = CLI_LONG_ABOUT,
        after_help = CLI_AFTER_HELP,
        // A bare `rom-weaver` has nothing to do, so show the full help instead
        // of the one-line usage error.
        arg_required_else_help = true,
    )
)]
struct Cli {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help_heading = GLOBAL_HELP_HEADING,
            help = "Print one JSON object per line instead of human-readable output"
        )
    )]
    json: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            conflicts_with = "no_progress",
            help_heading = GLOBAL_HELP_HEADING,
            help = "Show progress even when output is piped to a file or another program"
        )
    )]
    progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-progress",
            global = true,
            conflicts_with = "progress",
            help_heading = GLOBAL_HELP_HEADING,
            help = "Hide progress"
        )
    )]
    no_progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            value_enum,
            conflicts_with_all = ["verbose", "quiet"],
            help_heading = GLOBAL_HELP_HEADING,
            help = "How much rom-weaver logs to stderr. Separate from the normal output [default: off]"
        )
    )]
    log_level: Option<LogLevel>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'v',
            long,
            global = true,
            action = ArgAction::Count,
            conflicts_with_all = ["log_level", "quiet"],
            help_heading = GLOBAL_HELP_HEADING,
            help = "Log more: -v for info, -vv for debug, -vvv for trace"
        )
    )]
    verbose: u8,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'q',
            long,
            global = true,
            conflicts_with_all = ["log_level", "verbose"],
            help_heading = GLOBAL_HELP_HEADING,
            help = "Log errors only"
        )
    )]
    quiet: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help_heading = GLOBAL_HELP_HEADING,
            help = "Also log trace output from bundled libraries (for bug reports)"
        )
    )]
    dep_trace: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            conflicts_with = "no_color",
            help_heading = GLOBAL_HELP_HEADING,
            help = "Keep colors even when output is piped"
        )
    )]
    color: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-color",
            global = true,
            conflicts_with = "color",
            help_heading = GLOBAL_HELP_HEADING,
            help = "Turn colors off"
        )
    )]
    no_color: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'y',
            long = "yes",
            global = true,
            help_heading = GLOBAL_HELP_HEADING,
            help = "Answer yes to every confirmation instead of asking. Does not choose between candidates"
        )
    )]
    yes: bool,
    #[cfg_attr(not(target_arch = "wasm32"), command(subcommand))]
    command: CliCommand,
}

/// The top-level command set. `App` flattens the shared [`Commands`] enum (the
/// one exported to TypeScript) so every ROM subcommand stays at the top level,
/// while `Completions` is a native-only CLI concern that never enters the
/// shared enum or the generated TS types.
#[derive(Debug)]
#[cfg(not(target_arch = "wasm32"))]
#[cfg_attr(not(target_arch = "wasm32"), derive(Subcommand))]
enum CliCommand {
    #[command(flatten)]
    App(Commands),
    /// Top-level spelling of `patch apply`. Normalized away in [`main_entry`]
    /// before dispatch, so it never reaches the shared `Commands` enum.
    #[command(
        about = "Apply one or more patches to a ROM, in order (same as `patch apply`)",
        long_about = PATCH_APPLY_LONG_ABOUT,
        after_help = PATCH_APPLY_AFTER_HELP,
    )]
    Weave(Box<PatchApplyCommand>),
    #[command(
        about = "Print a tab-completion script for your shell",
        long_about = "\
Print a tab-completion script for your shell to stdout.

Save it where your shell looks for completions, then start a new shell:

  rom-weaver completions bash > /etc/bash_completion.d/rom-weaver
  rom-weaver completions zsh  > ~/.zfunc/_rom-weaver
  rom-weaver completions fish > ~/.config/fish/completions/rom-weaver.fish"
    )]
    Completions {
        #[arg(value_name = "SHELL", help = "Shell to print completions for")]
        shell: clap_complete::Shell,
    },
    #[command(
        about = "List the formats, codecs, and checksum algorithms this build supports",
        long_about = "\
List what this build supports, read straight from its registries: container
formats (and whether each can be created, extracted, or both), patch formats,
the codecs each container format accepts, and the checksum algorithms.

Pass --json for the machine-readable form."
    )]
    Formats,
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
            log_level: log_level_override(self.log_level, self.verbose, self.quiet),
            dep_trace: self.dep_trace,
            interactive_selection_enabled: interactive,
            assume_yes: self.yes,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn log_level_override(log_level: Option<LogLevel>, verbose: u8, quiet: bool) -> Option<LogLevel> {
    if log_level.is_some() {
        return log_level;
    }
    if quiet {
        return Some(LogLevel::Error);
    }
    match verbose {
        0 => None,
        1 => Some(LogLevel::Info),
        2 => Some(LogLevel::Debug),
        _ => Some(LogLevel::Trace),
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

/// Resolve the `--color`/`--no-color` pair into an explicit override, or `None`
/// to fall back to the `NO_COLOR`-env / tty default in [`Surface`]. Flag beats
/// env: `--color` forces color even with `NO_COLOR` set.
#[cfg(not(target_arch = "wasm32"))]
fn color_override(color: bool, no_color: bool) -> Option<bool> {
    if no_color {
        return Some(false);
    }
    if color {
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
    // `completions` is a native-only concern: emit the script and exit before
    // any command runs. `cli_command()` rebuilds the same clap tree the parse
    // used, so the generated script covers every real subcommand.
    if let CliCommand::Completions { shell } = &cli.command {
        let shell = *shell;
        let mut command = cli_command();
        clap_complete::generate(shell, &mut command, "rom-weaver", &mut io::stdout());
        return ExitCode::SUCCESS;
    }
    if let CliCommand::Formats = &cli.command {
        print_formats(cli.json);
        return ExitCode::SUCCESS;
    }
    // `bundle schema` prints the raw JSON Schema to stdout (redirect it to a
    // file / point an editor at it), before any command runs.
    if let CliCommand::App(Commands::Bundle(BundleCommands::Schema)) = &cli.command {
        print!("{}", rom_weaver_app::BUNDLE_JSON_SCHEMA);
        return ExitCode::SUCCESS;
    }
    // `weave` is a top-level spelling of `patch apply`; fold it into the shared
    // enum so everything downstream sees exactly one command shape.
    cli.command = match cli.command {
        CliCommand::Weave(command) => {
            CliCommand::App(Commands::Patch(PatchCommands::Apply(command)))
        }
        other => other,
    };
    if let CliCommand::App(Commands::Patch(PatchCommands::Apply(command))) = &mut cli.command
        && let Some(apply_matches) = match matches.subcommand() {
            // Top-level `weave` puts the apply args one level shallower than `patch apply`.
            Some(("weave", apply_matches)) => Some(apply_matches),
            Some((_, patch_matches)) => patch_matches.subcommand().map(|(_, args)| args),
            None => None,
        }
    {
        command.align_patch_header_modes(apply_matches);
        command.align_patch_basis(apply_matches);
    }
    if let CliCommand::App(Commands::Bundle(BundleCommands::Create(command))) = &mut cli.command
        && let Some((_, bundle_matches)) = matches.subcommand()
        && let Some((_, create_matches)) = bundle_matches.subcommand()
    {
        command.align_bundle_patch_metadata(create_matches);
    }
    if let CliCommand::App(Commands::Patch(PatchCommands::Validate(command))) = &mut cli.command
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
    let color = color_override(cli.color, cli.no_color);
    let reporter: Arc<dyn ProgressSink> = if cli.json {
        Arc::new(JsonProgressSink)
    } else if stdout_is_tty {
        Arc::new(HumanReporter::new(HumanStyle::Rich, color, cli.quiet))
    } else {
        Arc::new(HumanReporter::new(HumanStyle::Simple, color, cli.quiet))
    };
    let prompter: Arc<dyn SelectionPrompter> = if interactive {
        Arc::new(StdinPrompter::new())
    } else {
        Arc::new(NoninteractivePrompter)
    };

    let CliCommand::App(command) = cli.command else {
        unreachable!("completions handled and returned above");
    };
    // `apply --tui` runs an interactive metadata wizard, then applies AND writes
    // the bundle. It needs a terminal; scripted runs use `bundle create` /
    // `apply --emit-bundle`.
    let is_apply_tui =
        matches!(&command, Commands::Patch(PatchCommands::Apply(apply)) if apply.tui);
    if is_apply_tui {
        if !interactive {
            eprintln!(
                "--tui needs an interactive terminal; use `bundle create` or `apply --emit-bundle` for scripted runs"
            );
            return ExitCode::from(2);
        }
        install_cancel_handler();
        return finish_run(run_apply_tui(command, options, reporter, prompter));
    }
    install_cancel_handler();
    finish_run(run_command(command, options, reporter, prompter))
}

/// Trip the process cancellation token on Ctrl-C so running work unwinds and
/// the partial output is cleaned up. A second Ctrl-C means the operation is not
/// unwinding, so leave immediately after removing what was written.
#[cfg(not(target_arch = "wasm32"))]
fn install_cancel_handler() {
    use std::sync::atomic::{AtomicBool, Ordering};

    static SIGNALLED: AtomicBool = AtomicBool::new(false);
    let token = process_cancellation_token();
    let result = ctrlc::set_handler(move || {
        if SIGNALLED.swap(true, Ordering::SeqCst) {
            remove_in_progress_outputs();
            eprintln!("cancelled");
            std::process::exit(130);
        }
        token.cancel();
        eprintln!("cancelling; press Ctrl-C again to stop immediately");
    });
    if let Err(error) = result {
        // Not fatal: without a handler Ctrl-C keeps its default behaviour.
        eprintln!("warning: could not install the Ctrl-C handler ({error})");
    }
}

/// Map the run's exit code, cleaning up partial output when it was cancelled.
#[cfg(not(target_arch = "wasm32"))]
fn finish_run(exit_code: ExitCode) -> ExitCode {
    if process_cancellation_token().is_cancelled() {
        remove_in_progress_outputs();
        return ExitCode::from(130);
    }
    clear_in_progress_outputs();
    exit_code
}

/// Drive `apply --tui`: collect bundle metadata interactively, run the apply,
/// then (on success) write the authored bundle.
#[cfg(not(target_arch = "wasm32"))]
fn run_apply_tui(
    command: Commands,
    options: RunCommandOptions,
    reporter: Arc<dyn ProgressSink>,
    prompter: Arc<dyn SelectionPrompter>,
) -> ExitCode {
    let Commands::Patch(PatchCommands::Apply(mut apply)) = command else {
        unreachable!("run_apply_tui is only called for apply commands");
    };
    let bundle_command = match crate::interactive::run_bundle_tui(&apply) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    // Run the apply itself without the tui/emit hooks, then author the bundle.
    apply.tui = false;
    apply.emit_bundle = None;
    let apply_outcome = run_command_outcome(
        Commands::Patch(PatchCommands::Apply(apply)),
        options,
        Arc::clone(&reporter),
        Arc::clone(&prompter),
    );
    if apply_outcome.exit_code != 0 {
        return ExitCode::from(apply_outcome.exit_code);
    }
    let create_outcome = run_command_outcome(
        Commands::Bundle(BundleCommands::Create(Box::new(bundle_command))),
        options,
        reporter,
        prompter,
    );
    ExitCode::from(create_outcome.exit_code)
}

#[cfg(target_arch = "wasm32")]
pub fn main_entry() -> ExitCode {
    eprintln!("rom-weaver-cli is native-only; build rom-weaver-app for wasm");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::{Cli, cli_command, color_override, progress_override};
    use clap::FromArgMatches;
    use rom_weaver_app::{LogLevel, RomWeaverRunOutputOptions, RunCommandOptions};

    #[test]
    fn command_tree_has_no_flag_collisions() {
        cli_command().debug_assert();
    }

    #[test]
    fn color_flags_map_to_override() {
        assert_eq!(color_override(false, false), None);
        assert_eq!(color_override(true, false), Some(true));
        assert_eq!(color_override(false, true), Some(false));
    }

    #[test]
    fn inspect_is_accepted_as_probe_alias() {
        assert!(
            cli_command()
                .try_get_matches_from(["rom-weaver", "inspect", "--input", "a.nes"])
                .is_ok()
        );
    }

    /// `weave` is accepted as a spelling of `patch apply` on the CLI (both
    /// top-level and under `patch`) and on the JSON wire the wasm layer uses.
    #[test]
    fn weave_is_accepted_everywhere() {
        for argv in [
            ["rom-weaver", "weave", "--input", "a.nes"].as_slice(),
            ["rom-weaver", "patch", "weave", "--input", "a.nes"].as_slice(),
        ] {
            assert!(
                cli_command().try_get_matches_from(argv).is_ok(),
                "{argv:?} parses"
            );
        }

        let weave: rom_weaver_app::PatchCommands =
            serde_json::from_str(r#"{"type":"weave","args":{"input":"a.nes"}}"#)
                .expect("weave tag deserializes");
        assert!(matches!(weave, rom_weaver_app::PatchCommands::Apply(_)));
        // Serialization stays canonical, so the generated TS union is unaffected.
        assert!(
            serde_json::to_string(&weave)
                .expect("serialize")
                .contains(r#""type":"apply""#)
        );
    }

    #[test]
    fn patch_apply_compression_aliases_are_accepted() {
        for flag in ["--raw", "--format", "--codec", "--level"] {
            let mut argv = vec![
                "rom-weaver",
                "patch",
                "apply",
                "--input",
                "game.sfc",
                "--patch",
                "update.bps",
                "--output",
                "patched.sfc",
            ];
            argv.push(flag);
            if flag != "--raw" {
                argv.push(if flag == "--format" {
                    "zip"
                } else if flag == "--codec" {
                    "deflate"
                } else {
                    "high"
                });
            }
            assert!(
                cli_command().try_get_matches_from(argv).is_ok(),
                "{flag} parses for patch apply"
            );
        }
    }

    #[test]
    fn patch_apply_help_is_task_grouped() {
        let mut command = cli_command();
        let patch = command.find_subcommand_mut("patch").expect("patch command");
        let apply = patch
            .find_subcommand_mut("apply")
            .expect("patch apply command");
        let help = apply.render_long_help().to_string();
        const EXPECTED_SECTIONS: &[(&str, &[&str])] = &[
            ("Options:", &["-h, --help"]),
            (
                "Basic:",
                &[
                    "-i, --input",
                    "--patch",
                    "-o, --output",
                    "--no-compress",
                    "--raw",
                    "--compress-format",
                    "--format",
                    "--compress-codec",
                    "--codec",
                    "--compress-level",
                    "--level",
                ],
            ),
            (
                "Archive/bundle:",
                &[
                    "-s, --select",
                    "--target",
                    "--filter",
                    "--no-extract",
                    "--no-ignore",
                    "--bundle",
                    "--with",
                    "--without",
                ],
            ),
            (
                "Compatibility:",
                &[
                    "--assume-in",
                    "--expect-in",
                    "--patch-header",
                    "--patch-basis",
                    "--output-header",
                    "--repair-checksum",
                    "--n64-byte-order",
                    "--ignore-checksum-validation",
                ],
            ),
            (
                "Diagnostics/authoring:",
                &[
                    "--expect-out",
                    "--code",
                    "--code-system",
                    "--code-kind",
                    "--emit-bundle",
                    "--tui",
                ],
            ),
            ("Performance:", &["-j, --threads"]),
        ];
        let mut previous = 0;
        for (index, (heading, flags)) in EXPECTED_SECTIONS.iter().enumerate() {
            let position = help
                .find(heading)
                .unwrap_or_else(|| panic!("help heading {heading:?} missing from:\n{help}"));
            assert!(position > previous, "help headings are out of order");
            previous = position;

            let end = EXPECTED_SECTIONS
                .get(index + 1)
                .and_then(|(next_heading, _)| help.find(next_heading))
                .or_else(|| help.find("Example:"))
                .expect("end of help section");
            let section = &help[position..end];
            for flag in *flags {
                assert!(
                    section.contains(flag),
                    "{flag} is missing from the {heading} help section"
                );
            }
        }

        let basic_start = help.find("Basic:").expect("basic heading");
        let basic_end = help.find("Archive/bundle:").expect("archive heading");
        let basic = &help[basic_start..basic_end];
        let input = basic.find("-i, --input").expect("input in basic help");
        let patch = basic.find("--patch").expect("patch in basic help");
        let output = basic.find("-o, --output").expect("output in basic help");
        assert!(input < patch && patch < output, "basic task order");
        assert_eq!(help.matches("Example:").count(), 1);
        assert!(help.contains("rom-weaver patch apply -i game.sfc --patch hack.bps"));
    }

    #[test]
    fn completions_is_a_native_subcommand() {
        let matches = cli_command().try_get_matches_from(["rom-weaver", "completions", "fish"]);
        assert!(matches.is_ok(), "completions <shell> parses");
    }

    fn output(json: bool, progress: Option<bool>) -> RomWeaverRunOutputOptions {
        RomWeaverRunOutputOptions {
            json,
            progress,
            log_level: None,
            dep_trace: false,
            interactive_selection_enabled: false,
            assume_yes: false,
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

    #[test]
    fn dependency_trace_is_a_global_flag() {
        let matches = cli_command().try_get_matches_from([
            "rom-weaver",
            "--dep-trace",
            "checksum",
            "--input",
            "input.bin",
            "--algo",
            "crc32",
        ]);
        assert!(matches.is_ok());
    }

    #[test]
    fn log_level_flags_are_global() {
        let matches = cli_command().try_get_matches_from([
            "rom-weaver",
            "--log-level",
            "debug",
            "checksum",
            "--input",
            "input.bin",
            "--algo",
            "crc32",
        ]);
        let cli = Cli::from_arg_matches(&matches.expect("valid args")).expect("parsed args");
        assert_eq!(cli.output_options(false).log_level, Some(LogLevel::Debug));
    }

    #[test]
    fn verbosity_short_flags_map_to_log_levels() {
        for (args, expected) in [
            (vec!["-v"], Some(LogLevel::Info)),
            (vec!["-vv"], Some(LogLevel::Debug)),
            (vec!["-vvv"], Some(LogLevel::Trace)),
            (vec!["--quiet"], Some(LogLevel::Error)),
            (vec![], None),
        ] {
            let mut argv = vec!["rom-weaver"];
            argv.extend(args);
            argv.extend(["checksum", "--input", "input.bin", "--algo", "crc32"]);
            let matches = cli_command()
                .try_get_matches_from(argv)
                .expect("valid args");
            let cli = Cli::from_arg_matches(&matches).expect("parsed args");
            assert_eq!(cli.output_options(false).log_level, expected);
        }
    }
}
