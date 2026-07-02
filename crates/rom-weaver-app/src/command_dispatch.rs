use super::*;

impl CliApp {
    pub(super) fn new(
        reporter: Arc<dyn ProgressSink>,
        prompter: Arc<dyn SelectionPrompter>,
        emit_progress_events: bool,
        interactive_selection_enabled: bool,
    ) -> Self {
        Self {
            reporter,
            prompter,
            emit_progress_events,
            interactive_selection_enabled,
            containers: ContainerRegistry::new(),
            patches: PatchRegistry::new(),
            checksum: NativeChecksumEngine,
        }
    }

    pub(super) fn run(&self, command: Commands) -> AppRunOutcome {
        let command_name = Self::command_name(&command);
        trace!(command = command_name, "dispatching CLI command");
        match command {
            Commands::Probe(args) => self.run_probe(args),
            Commands::List(args) => self.run_list(args),
            Commands::Extract(args) => self.run_extract(args),
            Commands::Checksum(args) => self.run_checksum(args),
            Commands::Ingest(args) => self.run_ingest(args),
            Commands::Compress(args) => self.run_compress(args),
            Commands::Trim(args) => self.run_trim(args),
            Commands::Patch(command) => match command {
                PatchCommands::Apply(args) => self.run_patch_apply(*args),
                PatchCommands::Validate(args) => self.run_patch_validate(args),
                PatchCommands::CreateCandidates(args) => self.run_patch_create_candidates(args),
                PatchCommands::Create(args) => self.run_patch_create(*args),
            },
            Commands::PlanExtractBatch(args) => self.run_plan_extract_batch(args),
            Commands::MatchSidecars(args) => self.run_match_sidecars(args),
        }
    }

    pub(super) fn command_name(command: &Commands) -> &'static str {
        match command {
            Commands::Probe(_) => "probe",
            Commands::List(_) => "list",
            Commands::Extract(_) => "extract",
            Commands::Checksum(_) => "checksum",
            Commands::Ingest(_) => "ingest",
            Commands::Compress(_) => "compress",
            Commands::Trim(_) => "trim",
            Commands::Patch(PatchCommands::Apply(_)) => "patch-apply",
            Commands::Patch(PatchCommands::Validate(_)) => "patch-validate",
            Commands::Patch(PatchCommands::CreateCandidates(_)) => "patch-create-candidates",
            Commands::Patch(PatchCommands::Create(_)) => "patch-create",
            Commands::PlanExtractBatch(_) => "plan-extract-batch",
            Commands::MatchSidecars(_) => "match-sidecars",
        }
    }

    /// Note that `--split-bin` was ignored when listing a container that does not support it (only
    /// CHD CD listing honors split CUE + per-track BIN output).
    pub(super) fn attach_split_bin_list_note(
        mut report: OperationReport,
        handler: &dyn ContainerHandler,
        split_bin: bool,
    ) -> OperationReport {
        if split_bin && !handler.descriptor().matches_name("chd") {
            report.label = format!(
                "{}; ignored --split-bin for non-CHD input `{}`",
                report.label,
                handler.descriptor().name
            );
        }
        report
    }
}
