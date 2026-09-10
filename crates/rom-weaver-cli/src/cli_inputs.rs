//! Native-only positional `FILE` aliases for commands with `-i, --input`.

use std::path::PathBuf;

use clap::{
    Arg, ArgAction, ArgMatches, Command,
    builder::ArgPredicate,
    error::{Error, ErrorKind},
    parser::ValueSource,
};

use crate::Commands;

const FILE: &str = "file";
const PLACEHOLDER_INPUT: &str = ".";

pub(crate) fn decorate(command: Command) -> Command {
    command
        .mut_subcommand("probe", decorate_scalar)
        .mut_subcommand("extract", decorate_scalar)
        .mut_subcommand("checksum", decorate_scalar)
        .mut_subcommand("identify", decorate_identify)
        .mut_subcommand("compress", decorate_many)
        .mut_subcommand("trim", decorate_many)
}

pub(crate) fn resolve(command: &mut Commands, matches: &ArgMatches) -> Result<(), Error> {
    let Some((_, command_matches)) = matches.subcommand() else {
        return Ok(());
    };

    match command {
        Commands::Probe(args) => resolve_scalar(&mut args.input, command_matches),
        Commands::Extract(args) => resolve_scalar(&mut args.input, command_matches),
        Commands::Checksum(args) => resolve_scalar(&mut args.input, command_matches),
        Commands::Identify(args) => resolve_optional(&mut args.input, command_matches),
        Commands::Compress(args) => resolve_many(&mut args.input, command_matches),
        Commands::Trim(args) => resolve_many(&mut args.input, command_matches),
        _ => Ok(()),
    }
}

fn decorate_scalar(command: Command) -> Command {
    // Shared PathBuf fields need a value during clap derivation. Callers MUST
    // resolve the positional alias before dispatch so this placeholder is never used.
    command
        .mut_arg("input", |arg| {
            arg.required(false)
                .required_unless_present(FILE)
                .default_value_if(FILE, ArgPredicate::IsPresent, PLACEHOLDER_INPUT)
                .hide_default_value(true)
        })
        .arg(file_arg())
}

fn decorate_identify(command: Command) -> Command {
    command.arg(file_arg())
}

fn decorate_many(command: Command) -> Command {
    command
        .mut_arg("input", |arg| {
            arg.required(false).required_unless_present(FILE)
        })
        .arg(file_arg().action(ArgAction::Append).num_args(1..))
}

fn file_arg() -> Arg {
    Arg::new(FILE)
        .value_name("FILE")
        .index(1)
        .value_parser(clap::value_parser!(PathBuf))
        .help("File input; an alternative to -i, --input")
}

fn resolve_scalar(input: &mut PathBuf, matches: &ArgMatches) -> Result<(), Error> {
    let Some(file) = matches.get_one::<PathBuf>(FILE) else {
        return Ok(());
    };
    if matches.value_source("input") == Some(ValueSource::CommandLine) {
        return Err(conflicting_input_forms());
    }
    *input = file.clone();
    Ok(())
}

fn resolve_optional(input: &mut Option<PathBuf>, matches: &ArgMatches) -> Result<(), Error> {
    let Some(file) = matches.get_one::<PathBuf>(FILE) else {
        return Ok(());
    };
    if input.is_some() {
        return Err(conflicting_input_forms());
    }
    *input = Some(file.clone());
    Ok(())
}

fn resolve_many(input: &mut Vec<PathBuf>, matches: &ArgMatches) -> Result<(), Error> {
    let Some(files) = matches.get_many::<PathBuf>(FILE) else {
        return Ok(());
    };
    let file_indices = matches.indices_of(FILE).expect("FILE values have indices");
    let input_indices = matches.indices_of("input").into_iter().flatten();
    let mut ordered: Vec<(usize, PathBuf)> = input_indices
        .zip(std::mem::take(input))
        .chain(file_indices.zip(files.cloned()))
        .collect();
    ordered.sort_unstable_by_key(|(index, _)| *index);
    *input = ordered.into_iter().map(|(_, path)| path).collect();
    Ok(())
}

fn conflicting_input_forms() -> Error {
    Error::raw(
        ErrorKind::ArgumentConflict,
        "use either FILE or -i, --input, not both",
    )
}
