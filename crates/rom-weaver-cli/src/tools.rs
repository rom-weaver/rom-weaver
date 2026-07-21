use super::*;

impl CliApp {
    pub(super) fn run_tools(&self, command: ToolsCommands) -> AppRunOutcome {
        match command {
            ToolsCommands::PpfUndo(args) => self.run_ppf_undo(args),
        }
    }

    fn run_ppf_undo(&self, args: PpfUndoCommand) -> AppRunOutcome {
        let command = "tools-ppf-undo";
        let execution = None;
        for (label, path) in [("ROM", &args.rom), ("PPF patch", &args.patch)] {
            if let Some(report) = self.require_readable_path(
                command,
                OperationFamily::Patch,
                Some("PPF".to_string()),
                path,
                execution.clone(),
            ) {
                return self.finish(command, report);
            }
            if path.is_dir() {
                return self.finish(
                    command,
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some("PPF".to_string()),
                        "validate",
                        format!("{label} path is a directory: `{}`", path.display()),
                        execution.clone(),
                    ),
                );
            }
        }

        let report = match rom_weaver_patches::undo_ppf(&args.rom, &args.patch, &args.output) {
            Ok(()) => OperationReport::succeeded(
                OperationFamily::Patch,
                Some("PPF".to_string()),
                "undo",
                format!("restored ROM written to `{}`", args.output.display()),
                Some(100.0),
                execution,
            ),
            Err(error) => OperationReport::failed(
                OperationFamily::Patch,
                Some("PPF".to_string()),
                "undo",
                error.to_string(),
                execution,
            ),
        };
        self.finish(command, report)
    }
}
