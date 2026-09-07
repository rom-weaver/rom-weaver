//! Shared dry-run planning for commands that do not have a command-specific
//! planner. Plans read only the input metadata needed to reject obvious bad
//! requests. They never create output directories, temp files, or downloads.

use super::*;

impl CliApp {
    /// Return a terminal plan for commands whose normal path can mutate data.
    /// `compress`, `trim`, and the ordinary `patch apply` path keep their
    /// existing detailed planners.
    pub(super) fn plan_dry_run(&self, command: &Commands) -> Option<AppRunOutcome> {
        match command {
            Commands::Compress(_) | Commands::Trim(_) => None,
            Commands::Patch(PatchCommands::Apply(args)) if Self::plain_patch_plan(args) => None,
            Commands::Patch(PatchCommands::Apply(args)) => {
                Some(self.plan_patch_apply_dry_run(args))
            }
            Commands::Probe(args) => Some(self.plan_read_only_input("probe", &args.input)),
            Commands::Checksum(args) => Some(self.plan_read_only_input("checksum", &args.input)),
            Commands::Patch(PatchCommands::Validate(args)) => {
                Some(self.plan_patch_validate_dry_run(args))
            }
            Commands::Extract(args) => Some(self.plan_extract_dry_run(args)),
            Commands::Ingest(args) => Some(self.plan_ingest_dry_run(args)),
            Commands::Patch(PatchCommands::Create(args)) => {
                Some(self.plan_patch_create_dry_run(args))
            }
            Commands::Bundle(BundleCommands::Create(args)) => {
                Some(self.plan_bundle_create_dry_run(args))
            }
            Commands::Bundle(BundleCommands::Parse(args)) => {
                Some(self.plan_bundle_parse_dry_run(args))
            }
            Commands::Tools(ToolsCommands::PpfUndo(args)) => Some(self.plan_ppf_undo_dry_run(args)),
            Commands::Setup(args) => Some(self.plan_setup_dry_run(args)),
            Commands::Identify(args) => Some(self.plan_identify_dry_run(args)),
            _ => Some(self.read_only_dry_run(Self::command_name(command))),
        }
    }

    /// A plain apply already resolves its complete output/compression plan
    /// without network or persistent writes. More indirect forms are planned
    /// here before bundle loading can download or extract a member.
    fn plain_patch_plan(args: &PatchApplyCommand) -> bool {
        args.bundle.is_none()
            && (!args.patches.is_empty() || !args.codes.is_empty())
            && args.emit_bundle.is_none()
            && !args.tui
            && !args.patches.iter().any(|path| {
                path.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("dcp"))
            })
    }

    pub(super) fn plan_patch_apply_dry_run(&self, args: &PatchApplyCommand) -> AppRunOutcome {
        let command = "patch-apply";
        if let Some(outcome) = self.plan_readable(command, OperationFamily::Patch, &args.input) {
            return outcome;
        }
        for patch in &args.patches {
            if let Some(outcome) = self.plan_readable(command, OperationFamily::Patch, patch) {
                return outcome;
            }
        }
        let mut downloads = Vec::new();
        if let Some(bundle) = &args.bundle {
            if let Some(url) = super::bundle_apply::bundle_ref_as_url(bundle) {
                downloads.push(url.to_string());
            } else if let Some(outcome) =
                self.plan_readable(command, OperationFamily::Patch, bundle)
            {
                return outcome;
            }
        }
        let mut writes = args
            .output
            .as_ref()
            .map(|path| vec![path.display().to_string()])
            .unwrap_or_default();
        if let Some(bundle) = &args.emit_bundle {
            writes.push(bundle.display().to_string());
        }
        self.plan_succeeded_with_downloads(
            command,
            OperationFamily::Patch,
            "dry run: would resolve the patch bundle or source; nothing written",
            writes,
            downloads,
            vec![
                "bundle contents, archive members, and remote sources are not resolved during dry run"
                    .to_string(),
            ],
        )
    }

    fn plan_extract_dry_run(&self, args: &ExtractCommand) -> AppRunOutcome {
        let command = "extract";
        if let Some(outcome) = self.plan_readable(command, OperationFamily::Container, &args.input)
        {
            return outcome;
        }
        self.plan_succeeded(
            command,
            OperationFamily::Container,
            "dry run: would extract matching entries; nothing written",
            vec![args.output.display().to_string()],
            vec![
                "archive entries and output-directory access are not validated during dry run"
                    .to_string(),
            ],
        )
    }

    fn plan_ingest_dry_run(&self, args: &IngestCommand) -> AppRunOutcome {
        let command = "ingest";
        if let Some(outcome) = self.plan_readable(command, OperationFamily::Command, &args.input) {
            return outcome;
        }
        for database in &args.database {
            if let Some(outcome) = self.plan_readable(command, OperationFamily::Command, database) {
                return outcome;
            }
        }
        self.plan_succeeded(
            command,
            OperationFamily::Command,
            "dry run: would classify, extract, and identify assets; nothing written",
            vec![args.output.display().to_string()],
            vec!["archive entries, checksums, and output-directory access are not validated during dry run".to_string()],
        )
    }

    fn plan_patch_create_dry_run(&self, args: &PatchCreateCommand) -> AppRunOutcome {
        let command = "patch-create";
        if let Some(outcome) = self.plan_readable(command, OperationFamily::Patch, &args.original) {
            return outcome;
        }
        if let Some(modified) = &args.modified
            && let Some(outcome) = self.plan_readable(command, OperationFamily::Patch, modified)
        {
            return outcome;
        }
        if args.modified.is_some() && !args.codes.is_empty() {
            return self.plan_failed(
                command,
                OperationFamily::Patch,
                "--modified cannot be combined with --code",
            );
        }
        if !args.plan && args.output.is_none() {
            return self.plan_failed(
                command,
                OperationFamily::Patch,
                "patch create requires --output unless --plan is used",
            );
        }
        let writes = args
            .output
            .as_ref()
            .map(|path| vec![path.display().to_string()])
            .unwrap_or_default();
        self.plan_succeeded(
            command,
            OperationFamily::Patch,
            "dry run: would create a patch; nothing written",
            writes,
            vec!["patch format, checksums, and output-parent access are not validated during dry run".to_string()],
        )
    }

    fn plan_bundle_create_dry_run(&self, args: &BundleCreateCommand) -> AppRunOutcome {
        let command = "bundle-create";
        if let Some(rom) = &args.rom
            && let Some(outcome) = self.plan_readable(command, OperationFamily::Command, rom)
        {
            return outcome;
        }
        for patch in &args.patch {
            if let Some(outcome) = self.plan_readable(command, OperationFamily::Command, patch) {
                return outcome;
            }
        }
        if let Some(bundle_rom) = &args.bundle_rom
            && let Some(outcome) = self.plan_readable(command, OperationFamily::Command, bundle_rom)
        {
            return outcome;
        }
        let mut writes = vec![args.output.display().to_string()];
        if let Some(bundle) = &args.bundle {
            writes.push(bundle.display().to_string());
        }
        self.plan_succeeded(
            command,
            OperationFamily::Command,
            "dry run: would create a bundle; nothing written",
            writes,
            vec!["bundle metadata, checksums, and output-parent access are not validated during dry run".to_string()],
        )
    }

    fn plan_bundle_parse_dry_run(&self, args: &BundleParseCommand) -> AppRunOutcome {
        let command = "bundle-parse";
        if let Some(outcome) = self.plan_readable(command, OperationFamily::Command, &args.input) {
            return outcome;
        }
        let extracts = args.output.is_some() && !args.no_extract;
        self.plan_succeeded(
            command,
            OperationFamily::Command,
            if extracts {
                "dry run: would parse the bundle and extract selected members; nothing written"
            } else {
                "dry run: bundle parse only reads; no changes planned"
            },
            if extracts {
                args.output
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect()
            } else {
                Vec::new()
            },
            vec![
                "bundle entries and output-directory access are not validated during dry run"
                    .to_string(),
            ],
        )
    }

    fn plan_ppf_undo_dry_run(&self, args: &PpfUndoCommand) -> AppRunOutcome {
        let command = "tools-ppf-undo";
        for path in [&args.rom, &args.patch] {
            if let Some(outcome) = self.plan_readable(command, OperationFamily::Patch, path) {
                return outcome;
            }
        }
        self.plan_succeeded(
            command,
            OperationFamily::Patch,
            "dry run: would restore the ROM from PPF undo data; nothing written",
            vec![args.output.display().to_string()],
            vec![
                "PPF undo data and output-parent access are not validated during dry run"
                    .to_string(),
            ],
        )
    }

    fn plan_setup_dry_run(&self, args: &SetupCommand) -> AppRunOutcome {
        let output = args
            .database_dir
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "default identify database directory".to_string());
        self.plan_succeeded_with_downloads(
            "setup",
            OperationFamily::Command,
            "dry run: would install the identify database; nothing written or downloaded",
            vec![output],
            vec!["identify database release assets".to_string()],
            vec!["installed database state is not inspected during dry run".to_string()],
        )
    }

    fn plan_identify_dry_run(&self, args: &IdentifyCommand) -> AppRunOutcome {
        let Some(IdentifySubcommands::Database(command)) = &args.subcommand else {
            return args
                .input
                .as_ref()
                .map(|input| self.plan_read_only_input("identify", input))
                .unwrap_or_else(|| self.read_only_dry_run("identify"));
        };
        match command {
            IdentifyDatabaseCommands::List(_)
            | IdentifyDatabaseCommands::Status(_)
            | IdentifyDatabaseCommands::Path(_) => self.read_only_dry_run("identify-database"),
            IdentifyDatabaseCommands::Remove(args) => self.plan_succeeded(
                "identify-database",
                OperationFamily::Command,
                "dry run: would remove the installed identify pack; nothing written",
                vec![
                    args.database_dir
                        .as_ref()
                        .map(|path| path.display().to_string())
                        .unwrap_or_else(|| "default identify database directory".to_string()),
                ],
                vec![
                    "the requested system and installed pack are not validated during dry run"
                        .to_string(),
                ],
            ),
            IdentifyDatabaseCommands::ImportRedump(args) => {
                if let Some(outcome) =
                    self.plan_readable("identify-database", OperationFamily::Command, &args.input)
                {
                    return outcome;
                }
                self.database_import_plan(
                    args.database_dir.as_ref(),
                    "import local Redump data",
                    None,
                )
            }
            IdentifyDatabaseCommands::InstallAll(args) => self.database_import_plan(
                args.database_dir.as_ref(),
                "install bundled identify packs",
                None,
            ),
            IdentifyDatabaseCommands::InstallGroup(args) => {
                if let Some(from) = &args.from
                    && let Some(outcome) =
                        self.plan_readable("identify-database", OperationFamily::Command, from)
                {
                    return outcome;
                }
                self.database_import_plan(
                    args.database_dir.as_ref(),
                    "install the identify pack group",
                    args.from
                        .is_none()
                        .then(|| "identify pack group archive".to_string()),
                )
            }
            IdentifyDatabaseCommands::Install(args) => {
                if let Some(from) = &args.from
                    && let Some(outcome) =
                        self.plan_readable("identify-database", OperationFamily::Command, from)
                {
                    return outcome;
                }
                self.database_import_plan(
                    args.database_dir.as_ref(),
                    "install Redump identify packs",
                    args.from.is_none().then(|| "Redump DAT files".to_string()),
                )
            }
            IdentifyDatabaseCommands::Update(args) => {
                if let Some(from) = &args.from
                    && let Some(outcome) =
                        self.plan_readable("identify-database", OperationFamily::Command, from)
                {
                    return outcome;
                }
                self.database_import_plan(
                    args.database_dir.as_ref(),
                    "update Redump identify packs",
                    args.from.is_none().then(|| "Redump DAT files".to_string()),
                )
            }
        }
    }

    fn database_import_plan(
        &self,
        database_dir: Option<&PathBuf>,
        action: &str,
        download: Option<String>,
    ) -> AppRunOutcome {
        self.plan_succeeded_with_downloads(
            "identify-database",
            OperationFamily::Command,
            &format!("dry run: would {action}; nothing written or downloaded"),
            vec![
                database_dir
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "default identify database directory".to_string()),
            ],
            download.into_iter().collect(),
            vec![
                "database contents and remote Redump data are not inspected during dry run"
                    .to_string(),
            ],
        )
    }

    fn read_only_dry_run(&self, command: &str) -> AppRunOutcome {
        self.plan_succeeded(
            command,
            OperationFamily::Command,
            &format!("dry run: {command} only reads; no changes planned"),
            Vec::new(),
            Vec::new(),
        )
    }

    fn plan_read_only_input(&self, command: &str, input: &Path) -> AppRunOutcome {
        if let Some(outcome) = self.plan_readable(command, OperationFamily::Command, input) {
            return outcome;
        }
        self.read_only_dry_run(command)
    }

    fn plan_patch_validate_dry_run(&self, args: &PatchValidateCommand) -> AppRunOutcome {
        let command = "patch-validate";
        if let Some(outcome) = self.plan_readable(command, OperationFamily::Patch, &args.input) {
            return outcome;
        }
        for patch in &args.patches {
            if let Some(outcome) = self.plan_readable(command, OperationFamily::Patch, patch) {
                return outcome;
            }
        }
        self.read_only_dry_run(command)
    }

    fn plan_readable(
        &self,
        command: &str,
        family: OperationFamily,
        path: &Path,
    ) -> Option<AppRunOutcome> {
        if path.as_os_str() == "-" {
            return None;
        }
        self.require_readable_path(command, family, None, path, None)
            .map(|report| self.finish(command, report))
    }

    fn plan_failed(&self, command: &str, family: OperationFamily, label: &str) -> AppRunOutcome {
        self.finish(
            command,
            OperationReport::failed(family, None, "validate", label.to_string(), None),
        )
    }

    fn plan_succeeded(
        &self,
        command: &str,
        family: OperationFamily,
        label: &str,
        writes: Vec<String>,
        notes: Vec<String>,
    ) -> AppRunOutcome {
        self.plan_succeeded_with_downloads(command, family, label, writes, Vec::new(), notes)
    }

    fn plan_succeeded_with_downloads(
        &self,
        command: &str,
        family: OperationFamily,
        label: &str,
        writes: Vec<String>,
        downloads: Vec<String>,
        notes: Vec<String>,
    ) -> AppRunOutcome {
        let mut report =
            OperationReport::succeeded(family, None, "plan", label.to_string(), Some(100.0), None);
        let read_only = matches!(
            command,
            "probe"
                | "checksum"
                | "identify"
                | "patch-validate"
                | "bundle-schema"
                | "formats"
                | "completions"
                | "man"
                | "plan-extract-batch"
        ) || (command == "bundle-parse" && writes.is_empty());
        report.details = Some(json!({
            "dry_run": true,
            "command": command,
            "writes": writes,
            "downloads": downloads,
            "read_only": read_only,
            "outputs_unknown": !read_only && writes.is_empty(),
            "notes": notes,
        }));
        self.finish(command, report)
    }
}
