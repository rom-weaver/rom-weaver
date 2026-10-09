use super::*;

impl CliApp {
    #[cfg(any(not(target_arch = "wasm32"), test))]
    pub(super) fn new(
        reporter: Arc<dyn ProgressSink>,
        prompter: Arc<dyn SelectionPrompter>,
        emit_progress_events: bool,
        interactive_selection_enabled: bool,
        assume_yes: bool,
    ) -> Self {
        Self::new_with_dry_run(
            reporter,
            prompter,
            emit_progress_events,
            interactive_selection_enabled,
            assume_yes,
            false,
        )
    }

    pub(super) fn new_with_dry_run(
        reporter: Arc<dyn ProgressSink>,
        prompter: Arc<dyn SelectionPrompter>,
        emit_progress_events: bool,
        interactive_selection_enabled: bool,
        assume_yes: bool,
        dry_run: bool,
    ) -> Self {
        Self {
            reporter,
            prompter,
            emit_progress_events,
            interactive_selection_enabled,
            assume_yes,
            dry_run,
            containers: ContainerRegistry::new(),
            patches: PatchRegistry::new(),
            checksum: NativeChecksumEngine,
        }
    }

    pub(super) fn run(&self, command: Commands) -> AppRunOutcome {
        let command_name = Self::command_name(&command);
        trace!(command = command_name, "dispatching CLI command");
        if self.dry_run
            && let Some(outcome) = self.plan_dry_run(&command)
        {
            return outcome;
        }
        match command {
            Commands::Probe(args) => self.run_probe(args),
            Commands::Extract(args) => self.run_extract(args),
            Commands::Checksum(args) => self.run_checksum(args),
            Commands::Identify(args) => self.run_identify(*args),
            Commands::Setup(args) => self.run_setup(args),
            Commands::Ingest(args) => self.run_ingest(args),
            Commands::Cheat(args) => self.run_cheat(*args),
            Commands::Compress(mut args) => {
                args.dry_run |= self.dry_run;
                self.run_compress(args)
            }
            Commands::Trim(mut args) => {
                args.dry_run |= self.dry_run;
                self.run_trim(args)
            }
            Commands::Patch(command) => match command {
                PatchCommands::Apply(mut args) => {
                    args.dry_run |= self.dry_run;
                    self.run_patch_apply(*args)
                }
                PatchCommands::Validate(args) => self.run_patch_validate(*args),
                PatchCommands::Create(args) => self.run_patch_create(*args),
            },
            Commands::Weave(command) => match command {
                WeaveCommands::Create(args) => self.run_weave_create(*args),
                WeaveCommands::Parse(args) => self.run_weave_parse(args),
                WeaveCommands::Schema => self.run_weave_schema(),
            },
            Commands::Save(SaveCommands::Set(mut args)) => {
                args.dry_run |= self.dry_run;
                self.run_save_set(args)
            }
            Commands::Save(SaveCommands::Create(mut args)) => {
                args.dry_run |= self.dry_run;
                self.run_save(SaveCommands::Create(args))
            }
            Commands::Save(command) => self.run_save(command),
            Commands::Tools(command) => self.run_tools(command),
            Commands::PlanExtractBatch(args) => self.run_plan_extract_batch(args),
        }
    }

    pub(super) fn command_name(command: &Commands) -> &'static str {
        match command {
            Commands::Probe(_) => "probe",
            Commands::Extract(_) => "extract",
            Commands::Checksum(_) => "checksum",
            Commands::Identify(_) => "identify",
            Commands::Setup(_) => "setup",
            Commands::Ingest(_) => "ingest",
            Commands::Cheat(_) => "cheat",
            Commands::Compress(_) => "compress",
            Commands::Trim(_) => "trim",
            Commands::Patch(PatchCommands::Apply(_)) => "patch-apply",
            Commands::Patch(PatchCommands::Validate(_)) => "patch-validate",
            Commands::Patch(PatchCommands::Create(_)) => "patch-create",
            Commands::Weave(WeaveCommands::Create(_)) => "weave-create",
            Commands::Weave(WeaveCommands::Parse(_)) => "weave-parse",
            Commands::Weave(WeaveCommands::Schema) => "weave-schema",
            Commands::Save(SaveCommands::Identify(_)) => "save-identify",
            Commands::Save(SaveCommands::ListGames(_)) => "save-list-games",
            Commands::Save(SaveCommands::Create(_)) => "save-create",
            Commands::Save(SaveCommands::Inspect(_)) => "save-inspect",
            Commands::Save(SaveCommands::Get(_)) => "save-get",
            Commands::Save(SaveCommands::Set(_)) => "save-set",
            Commands::Save(SaveCommands::ExportSchema(_)) => "save-export-schema",
            Commands::Tools(ToolsCommands::PpfUndo(_)) => "tools-ppf-undo",
            Commands::PlanExtractBatch(_) => "plan-extract-batch",
        }
    }
}
