use std::{
    process::ExitCode,
    sync::{Arc, Mutex},
};

use rom_weaver_core::{
    OperationFamily, OperationStatus, ProgressEvent, ProgressSink, SelectionPrompter,
};

use crate::{ChecksumCommand, Commands, RunCommandOptions, run_command_outcome, stdout_output};

pub(crate) fn run(
    command: ChecksumCommand,
    options: RunCommandOptions,
    human: Arc<dyn ProgressSink>,
    prompter: Arc<dyn SelectionPrompter>,
) -> ExitCode {
    let Some(algorithm) = command.algo.first().map(|value| value.to_ascii_lowercase()) else {
        eprintln!("error: --digest requires exactly one --algo value");
        return ExitCode::from(2);
    };
    if command.algo.len() != 1 {
        eprintln!("error: --digest requires exactly one --algo value");
        return ExitCode::from(2);
    }

    let terminal = Arc::new(Mutex::new(None));
    let reporter: Arc<dyn ProgressSink> = Arc::new(DigestProgressSink {
        human,
        terminal: Arc::clone(&terminal),
    });
    let outcome = run_command_outcome(Commands::Checksum(command), options, reporter, prompter);
    if outcome.exit_code != 0 {
        return ExitCode::from(outcome.exit_code);
    }

    let terminal = terminal.lock().unwrap_or_else(|error| error.into_inner());
    let digest = terminal
        .as_ref()
        .and_then(|event| event.details.as_ref())
        .and_then(|details| details.get("checksums"))
        .and_then(|checksums| checksums.get(&algorithm))
        .and_then(serde_json::Value::as_str);
    let Some(digest) = digest else {
        eprintln!("error: checksum succeeded but did not return `{algorithm}`");
        return ExitCode::FAILURE;
    };

    stdout_output::write(format_args!("{}\n", digest.to_ascii_lowercase()));
    ExitCode::SUCCESS
}

struct DigestProgressSink {
    human: Arc<dyn ProgressSink>,
    terminal: Arc<Mutex<Option<ProgressEvent>>>,
}

impl ProgressSink for DigestProgressSink {
    fn emit(&self, event: ProgressEvent) {
        if event.status == OperationStatus::Succeeded {
            if event.command == "checksum" && event.family == OperationFamily::Checksum {
                let mut terminal = self
                    .terminal
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                *terminal = Some(event);
            }
            return;
        }
        self.human.emit(event);
    }
}
