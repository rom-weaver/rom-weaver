use std::{collections::HashSet, fs::OpenOptions};

use super::*;
use rom_weaver_core::{
    SaveDetectionInput, SaveDocument, SaveEdit, SaveField, SaveGameIdentity, SaveRecognition,
    SaveRecognitionOutcome, SaveValue, apply_save_edits, detect_save, parse_save,
};

const SAVE_DETAILS_KEY: &str = "save_editor";
const MAX_SAVE_INPUT_SIZE: u64 = 128 * 1024 * 1024;

impl CliApp {
    pub(super) fn run_save(&self, command: SaveCommands) -> AppRunOutcome {
        match command {
            SaveCommands::Identify(args) => self.run_save_identify(args),
            SaveCommands::Inspect(args) => self.run_save_inspect(args),
            SaveCommands::Get(args) => self.run_save_get(args),
            SaveCommands::Set(args) => self.run_save_set(args),
            SaveCommands::ExportSchema(args) => self.run_save_export_schema(args),
        }
    }

    fn run_save_identify(&self, args: SaveIdentifyCommand) -> AppRunOutcome {
        let command = "save-identify";
        let input = match self.load_save_input(command, &args.input, args.game, args.rom_sha1) {
            Ok(input) => input,
            Err(report) => return self.finish(command, *report),
        };
        let recognition = detect_save(&input);
        let document = recognized_identity(&recognition)
            .and_then(|identity| parse_save(&input, identity).ok());
        // Report the raw save size, not the outer file size, when the save is
        // inside a wrapper such as a GameShark SP export.
        let save_size = rom_weaver_core::unwrap_save_container(&input.bytes)
            .map_or(input.bytes.len(), |(_, inner)| inner.len());
        let details = json!({
            SAVE_DETAILS_KEY: {
                "save_size": save_size,
                "potential_format": potential_save_format(save_size),
                "recognition": recognition,
                "document": document,
            }
        });
        let (status, label) = match &recognition.outcome {
            SaveRecognitionOutcome::Recognized { candidate } => (
                OperationStatus::Succeeded,
                format!("Game: {}", candidate.identity.name),
            ),
            SaveRecognitionOutcome::Ambiguous { candidates } => (
                OperationStatus::Succeeded,
                format!(
                    "Recognition: Ambiguous ({} compatible games)",
                    candidates.len()
                ),
            ),
            SaveRecognitionOutcome::Unsupported { .. } => (
                OperationStatus::Unsupported,
                format!("Recognition: Unsupported\nSave size: {save_size} bytes"),
            ),
        };
        self.finish(
            command,
            save_report(status, "identify", label, Some(details)),
        )
    }

    fn run_save_inspect(&self, args: SaveInspectCommand) -> AppRunOutcome {
        let command = "save-inspect";
        let input = match self.load_save_input(command, &args.input, args.game, args.rom_sha1) {
            Ok(input) => input,
            Err(report) => return self.finish(command, *report),
        };
        let (recognition, identity) = match detect_for_edit(&input) {
            Ok(result) => result,
            Err(failure) => {
                let (recognition, message) = *failure;
                return self.finish(
                    command,
                    save_report(
                        OperationStatus::Failed,
                        "recognize",
                        message,
                        Some(json!({ SAVE_DETAILS_KEY: { "recognition": recognition } })),
                    ),
                );
            }
        };
        match parse_save(&input, &identity) {
            Ok(document) => self.finish(
                command,
                save_report(
                    OperationStatus::Succeeded,
                    "inspect",
                    format!("{} save is valid", identity.name),
                    Some(json!({ SAVE_DETAILS_KEY: {
                        "recognition": recognition,
                        "document": document,
                    }})),
                ),
            ),
            Err(error) => self.finish(command, save_error_report("validate", error)),
        }
    }

    fn run_save_get(&self, args: SaveGetCommand) -> AppRunOutcome {
        let command = "save-get";
        let input = match self.load_save_input(command, &args.input, args.game, args.rom_sha1) {
            Ok(input) => input,
            Err(report) => return self.finish(command, *report),
        };
        let (recognition, identity) = match detect_for_edit(&input) {
            Ok(result) => result,
            Err(failure) => {
                let (recognition, message) = *failure;
                return self.finish(
                    command,
                    save_report(
                        OperationStatus::Failed,
                        "recognize",
                        message,
                        Some(json!({ SAVE_DETAILS_KEY: { "recognition": recognition } })),
                    ),
                );
            }
        };
        let document = match parse_save(&input, &identity) {
            Ok(document) => document,
            Err(error) => return self.finish(command, save_error_report("validate", error)),
        };
        let Some(field) = document.fields.iter().find(|field| field.id == args.field) else {
            return self.finish(
                command,
                save_error_report(
                    "get",
                    RomWeaverError::ValidationCode(
                        ValidationCodeError::new("save_field_invalid")
                            .with_message("the save field ID is invalid")
                            .with_field("field", args.field),
                    ),
                ),
            );
        };
        self.finish(
            command,
            save_report(
                OperationStatus::Succeeded,
                "get",
                save_value_text(&field.value),
                Some(json!({ SAVE_DETAILS_KEY: {
                    "recognition": recognition,
                    "field": field,
                }})),
            ),
        )
    }

    fn run_save_set(&self, args: SaveSetCommand) -> AppRunOutcome {
        let command = "save-set";
        let input = match self.load_save_input(command, &args.input, args.game, args.rom_sha1) {
            Ok(input) => input,
            Err(report) => return self.finish(command, *report),
        };
        let (recognition, identity) = match detect_for_edit(&input) {
            Ok(result) => result,
            Err(failure) => {
                let (recognition, message) = *failure;
                return self.finish(
                    command,
                    save_report(
                        OperationStatus::Failed,
                        "recognize",
                        message,
                        Some(json!({ SAVE_DETAILS_KEY: { "recognition": recognition } })),
                    ),
                );
            }
        };
        let document = match parse_save(&input, &identity) {
            Ok(document) => document,
            Err(error) => return self.finish(command, save_error_report("validate", error)),
        };
        let edits = match parse_save_assignments(&document, &args.assignments) {
            Ok(edits) => edits,
            Err(error) => return self.finish(command, save_error_report("validate", error)),
        };
        let mut result = match apply_save_edits(&input, &identity, &edits, args.dry_run) {
            Ok(result) => result,
            Err(error) => return self.finish(command, save_error_report("edit", error)),
        };

        let mut output = None;
        if !args.dry_run && result.preview.changed {
            let Some(bytes) = result.bytes.take() else {
                return self.finish(
                    command,
                    save_error_report(
                        "serialize",
                        RomWeaverError::ValidationCode(
                            ValidationCodeError::new("save_serialization_failed")
                                .with_message("the save editor returned no output bytes"),
                        ),
                    ),
                );
            };
            let output_path = match resolve_save_output(&args.input, args.output.as_deref()) {
                Ok(path) => path,
                Err(error) => return self.finish(command, save_error_report("output", error)),
            };
            if paths_refer_to_same_file(&args.input, &output_path) {
                return self.finish(
                    command,
                    save_error_report(
                        "output",
                        RomWeaverError::ValidationCode(
                            ValidationCodeError::new("save_output_is_source")
                                .with_message("the edited save output must differ from the source"),
                        ),
                    ),
                );
            }
            if let Err(error) = write_save_output(&output_path, &bytes, args.force) {
                return self.finish(command, save_error_report("write", error));
            }
            output = Some(output_path);
        }

        let report_result = result;
        let mut report = save_report(
            OperationStatus::Succeeded,
            if args.dry_run { "preview" } else { "set" },
            if args.dry_run {
                "Save edit preview is valid".to_string()
            } else if report_result.preview.changed {
                "Edited save is valid".to_string()
            } else {
                "The requested values already match the save".to_string()
            },
            Some(json!({ SAVE_DETAILS_KEY: {
                "recognition": recognition,
                "result": report_result,
                "output": output,
            }})),
        );
        if let Some(path) = output {
            report = Self::attach_emitted_files_details(report, vec![path], Some("game-save"));
        }
        self.finish(command, report)
    }

    fn run_save_export_schema(&self, args: SaveExportSchemaCommand) -> AppRunOutcome {
        let command = "save-export-schema";
        let Some(path) = args.input else {
            return self.finish(
                command,
                save_error_report(
                    "validate",
                    RomWeaverError::Validation(
                        "export-schema needs a save file so the handler can validate its layout"
                            .to_string(),
                    ),
                ),
            );
        };
        let input = match self.load_save_input(command, &path, args.game, args.rom_sha1) {
            Ok(input) => input,
            Err(report) => return self.finish(command, *report),
        };
        let (recognition, identity) = match detect_for_edit(&input) {
            Ok(result) => result,
            Err(failure) => {
                let (recognition, message) = *failure;
                return self.finish(
                    command,
                    save_report(
                        OperationStatus::Failed,
                        "recognize",
                        message,
                        Some(json!({ SAVE_DETAILS_KEY: { "recognition": recognition } })),
                    ),
                );
            }
        };
        match parse_save(&input, &identity) {
            Ok(document) => self.finish(
                command,
                save_report(
                    OperationStatus::Succeeded,
                    "schema",
                    format!("{} save field schema", identity.name),
                    Some(json!({ SAVE_DETAILS_KEY: {
                        "recognition": recognition,
                        "schema": {
                            "game": document.identity,
                            "fields": document.fields,
                        },
                    }})),
                ),
            ),
            Err(error) => self.finish(command, save_error_report("validate", error)),
        }
    }

    fn load_save_input(
        &self,
        command: &str,
        path: &Path,
        selected_game: Option<String>,
        rom_sha1: Option<String>,
    ) -> std::result::Result<SaveDetectionInput, Box<OperationReport>> {
        if let Some(report) =
            self.require_readable_path(command, OperationFamily::Save, None, path, None)
        {
            return Err(Box::new(report));
        }
        process_cancellation_token()
            .check()
            .map_err(|error| Box::new(save_error_report("read", error)))?;
        let metadata = fs::metadata(path).map_err(|error| {
            Box::new(save_error_report(
                "read",
                RomWeaverError::io_path(rom_weaver_core::IoOp::Open, path, error),
            ))
        })?;
        if metadata.len() > MAX_SAVE_INPUT_SIZE {
            return Err(Box::new(save_error_report(
                "validate",
                RomWeaverError::ValidationCode(
                    ValidationCodeError::new("save_size_limit")
                        .with_message("the save file is larger than 128 MiB")
                        .with_field("save_size", metadata.len()),
                ),
            )));
        }
        let bytes = fs::read(path).map_err(|error| {
            Box::new(save_error_report(
                "read",
                RomWeaverError::io_path(rom_weaver_core::IoOp::Open, path, error),
            ))
        })?;
        process_cancellation_token()
            .check()
            .map_err(|error| Box::new(save_error_report("read", error)))?;
        trace!(path = %path.display(), save_size = bytes.len(), "loaded save editor input");
        let rom_sha1 = match rom_sha1 {
            Some(value)
                if value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
            {
                Some(value.to_ascii_lowercase())
            }
            Some(value) => {
                return Err(Box::new(save_error_report(
                    "validate",
                    RomWeaverError::ValidationCode(
                        ValidationCodeError::new("save_rom_sha1_invalid")
                            .with_message("the ROM SHA-1 must contain 40 hexadecimal characters")
                            .with_field("rom_sha1", value),
                    ),
                )));
            }
            None => None,
        };
        Ok(SaveDetectionInput {
            bytes,
            selected_game,
            rom_sha1,
        })
    }
}

fn detect_for_edit(
    input: &SaveDetectionInput,
) -> std::result::Result<(SaveRecognition, SaveGameIdentity), Box<(SaveRecognition, String)>> {
    let recognition = detect_save(input);
    match &recognition.outcome {
        SaveRecognitionOutcome::Recognized { candidate } => {
            let identity = candidate.identity.clone();
            Ok((recognition, identity))
        }
        SaveRecognitionOutcome::Ambiguous { candidates } => Err(Box::new((
            recognition.clone(),
            format!(
                "validation failed: save recognition is ambiguous; select one of: {}",
                candidates
                    .iter()
                    .map(|candidate| candidate.identity.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ))),
        SaveRecognitionOutcome::Unsupported { .. } => Err(Box::new((
            recognition.clone(),
            "unsupported operation: ROMWeaver has no editor for this save".to_string(),
        ))),
    }
}

fn recognized_identity(recognition: &SaveRecognition) -> Option<&SaveGameIdentity> {
    match &recognition.outcome {
        SaveRecognitionOutcome::Recognized { candidate } => Some(&candidate.identity),
        SaveRecognitionOutcome::Ambiguous { .. } | SaveRecognitionOutcome::Unsupported { .. } => {
            None
        }
    }
}

fn parse_save_assignments(
    document: &SaveDocument,
    assignments: &[String],
) -> Result<Vec<SaveEdit>> {
    let mut fields = HashSet::new();
    assignments
        .iter()
        .map(|assignment| {
            let (field_id, raw_value) = assignment.split_once('=').ok_or_else(|| {
                RomWeaverError::ValidationCode(
                    ValidationCodeError::new("save_assignment_invalid")
                        .with_message("a save assignment must use FIELD=VALUE")
                        .with_field("assignment", assignment.as_str()),
                )
            })?;
            if field_id.is_empty() || !fields.insert(field_id.to_string()) {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("save_edit_conflict")
                        .with_message("a save field can appear only once per edit")
                        .with_field("field", field_id),
                ));
            }
            let field = document
                .fields
                .iter()
                .find(|field| field.id == field_id)
                .ok_or_else(|| {
                    RomWeaverError::ValidationCode(
                        ValidationCodeError::new("save_field_invalid")
                            .with_message("the save field ID is invalid")
                            .with_field("field", field_id),
                    )
                })?;
            Ok(SaveEdit {
                field: field_id.to_string(),
                value: parse_save_value(field, raw_value)?,
            })
        })
        .collect()
}

fn parse_save_value(field: &SaveField, raw: &str) -> Result<SaveValue> {
    match &field.value {
        SaveValue::Text(_) => Ok(SaveValue::Text(raw.to_string())),
        SaveValue::U32(_) => raw.parse::<u32>().map(SaveValue::U32).map_err(|_| {
            RomWeaverError::ValidationCode(
                ValidationCodeError::new("save_value_type_invalid")
                    .with_message("the save field needs an unsigned integer")
                    .with_field("field", field.id.as_str())
                    .with_field("value", raw),
            )
        }),
        SaveValue::I32(_) => raw.parse::<i32>().map(SaveValue::I32).map_err(|_| {
            RomWeaverError::ValidationCode(
                ValidationCodeError::new("save_value_type_invalid")
                    .with_message("the save field needs a signed integer")
                    .with_field("field", field.id.as_str())
                    .with_field("value", raw),
            )
        }),
        SaveValue::Bool(_) => match raw.to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Ok(SaveValue::Bool(true)),
            "false" | "no" | "0" => Ok(SaveValue::Bool(false)),
            _ => Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("save_value_type_invalid")
                    .with_message("the save field needs true or false")
                    .with_field("field", field.id.as_str())
                    .with_field("value", raw),
            )),
        },
        SaveValue::Enum(_) => field
            .constraints
            .choices
            .iter()
            .find(|choice| choice.eq_ignore_ascii_case(raw))
            .cloned()
            .map(SaveValue::Enum)
            .ok_or_else(|| {
                RomWeaverError::ValidationCode(
                    ValidationCodeError::new("save_enum_invalid")
                        .with_message("the save enum value is invalid")
                        .with_field("field", field.id.as_str())
                        .with_field("value", raw),
                )
            }),
        SaveValue::List(_) | SaveValue::Table(_) | SaveValue::Object(_) => {
            Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("save_value_type_invalid")
                    .with_message("this structured save field cannot use FIELD=VALUE syntax")
                    .with_field("field", field.id.as_str()),
            ))
        }
    }
}

fn save_report(
    status: OperationStatus,
    stage: &str,
    label: String,
    details: Option<Value>,
) -> OperationReport {
    let mut report = match status {
        OperationStatus::Succeeded => OperationReport::succeeded(
            OperationFamily::Save,
            Some("game-save".to_string()),
            stage,
            label,
            Some(100.0),
            None,
        ),
        OperationStatus::Unsupported => OperationReport::unsupported(
            OperationFamily::Save,
            Some("game-save".to_string()),
            stage,
            label,
            None,
        ),
        _ => OperationReport::failed(
            OperationFamily::Save,
            Some("game-save".to_string()),
            stage,
            label,
            None,
        ),
    };
    report.details = details;
    report
}

fn save_error_report(stage: &str, error: RomWeaverError) -> OperationReport {
    let structured = match &error {
        RomWeaverError::ValidationCode(error) => json!({
            "code": error.code(),
            "fields": error.fields().iter().map(|field| json!({
                "key": field.key,
                "value": field.value.to_string(),
            })).collect::<Vec<_>>(),
        }),
        RomWeaverError::Cancelled => json!({ "code": "save_cancelled", "fields": [] }),
        RomWeaverError::Unsupported(_) => {
            json!({ "code": "save_unsupported", "fields": [] })
        }
        RomWeaverError::Io(_) | RomWeaverError::IoPath { .. } => {
            json!({ "code": "save_io_failed", "fields": [] })
        }
        RomWeaverError::Validation(_) => {
            json!({ "code": "save_validation_failed", "fields": [] })
        }
        RomWeaverError::UnknownFormat { .. } => {
            json!({ "code": "save_format_unknown", "fields": [] })
        }
        RomWeaverError::ThreadPoolBuild(_) => {
            json!({ "code": "save_thread_pool_failed", "fields": [] })
        }
    };
    save_report(
        OperationStatus::Failed,
        stage,
        error.to_string(),
        Some(json!({ SAVE_DETAILS_KEY: { "error": structured } })),
    )
}

fn save_value_text(value: &SaveValue) -> String {
    match value {
        SaveValue::Text(value) | SaveValue::Enum(value) => value.clone(),
        SaveValue::U32(value) => value.to_string(),
        SaveValue::I32(value) => value.to_string(),
        SaveValue::Bool(value) => value.to_string(),
        SaveValue::List(value) => serde_json::to_string(value).unwrap_or_else(|_| "[]".into()),
        SaveValue::Table(value) => serde_json::to_string(value).unwrap_or_else(|_| "[]".into()),
        SaveValue::Object(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".into()),
    }
}

fn potential_save_format(size: usize) -> Option<&'static str> {
    match size {
        131_072 => Some("Flash 128 KiB"),
        65_536 => Some("64 KiB persistent save"),
        32_768 => Some("32 KiB persistent save"),
        8_192 => Some("8 KiB persistent save"),
        _ => None,
    }
}

fn resolve_save_output(input: &Path, requested: Option<&Path>) -> Result<PathBuf> {
    if let Some(requested) = requested {
        return Ok(requested.to_path_buf());
    }
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("save");
    let extension = input.extension().and_then(|value| value.to_str());
    for suffix in 0u32..=u32::MAX {
        let middle = if suffix == 0 {
            "-edited".to_string()
        } else {
            format!("-edited-{suffix}")
        };
        let name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}{middle}.{extension}"),
            _ => format!("{stem}{middle}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(RomWeaverError::Validation(
        "could not find an unused edited save output path".to_string(),
    ))
}

fn paths_refer_to_same_file(input: &Path, output: &Path) -> bool {
    if input == output {
        return true;
    }
    match (fs::canonicalize(input), fs::canonicalize(output)) {
        (Ok(input), Ok(output)) => input == output,
        _ => false,
    }
}

#[cfg(target_arch = "wasm32")]
fn write_save_output(path: &Path, bytes: &[u8], force: bool) -> Result<()> {
    ensure_output_available(path, force)?;
    process_cancellation_token().check()?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|error| RomWeaverError::io_path(rom_weaver_core::IoOp::Create, path, error))?;
    file.write_all(bytes)
        .map_err(|error| RomWeaverError::io_path(rom_weaver_core::IoOp::Write, path, error))?;
    file.sync_all()
        .map_err(|error| RomWeaverError::io_path(rom_weaver_core::IoOp::Write, path, error))?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn write_save_output(path: &Path, bytes: &[u8], force: bool) -> Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| {
            RomWeaverError::io_path(rom_weaver_core::IoOp::CreateDir, parent, error)
        })?;
    }
    ensure_output_available(path, force)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("edited-save");
    let staged = (0u32..=u32::MAX)
        .map(|suffix| parent.join(format!(".{name}.rom-weaver-{suffix}.tmp")))
        .find(|candidate| !candidate.exists())
        .ok_or_else(|| {
            RomWeaverError::Validation("could not reserve a staged save output path".into())
        })?;
    rom_weaver_core::register_in_progress_output(&staged);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .map_err(|error| {
                RomWeaverError::io_path(rom_weaver_core::IoOp::Create, &staged, error)
            })?;
        file.write_all(bytes).map_err(|error| {
            RomWeaverError::io_path(rom_weaver_core::IoOp::Write, &staged, error)
        })?;
        file.sync_all().map_err(|error| {
            RomWeaverError::io_path(rom_weaver_core::IoOp::Write, &staged, error)
        })?;
        drop(file);
        process_cancellation_token().check()?;
        let install = if force {
            fs::rename(&staged, path)
        } else {
            CliApp::install_staged_no_overwrite_with(&staged, path, |source, destination| {
                fs::hard_link(source, destination)
            })
            .inspect(|()| {
                if let Err(error) = fs::remove_file(&staged)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    warn!(path = %staged.display(), %error, "could not remove installed save staging file");
                }
            })
        };
        match install {
            Ok(()) => Ok(()),
            Err(_error) if force && path.exists() => {
                let backup = (0u32..=u32::MAX)
                    .map(|suffix| parent.join(format!(".{name}.rom-weaver-backup-{suffix}.tmp")))
                    .find(|candidate| !candidate.exists())
                    .ok_or_else(|| {
                        RomWeaverError::Validation(
                            "could not reserve a save output backup path".into(),
                        )
                    })?;
                fs::rename(path, &backup).map_err(|backup_error| {
                    RomWeaverError::io_path(rom_weaver_core::IoOp::Write, path, backup_error)
                })?;
                if let Err(install_error) = fs::rename(&staged, path) {
                    let _ = fs::rename(&backup, path);
                    return Err(RomWeaverError::io_path(
                        rom_weaver_core::IoOp::Write,
                        path,
                        install_error,
                    ));
                }
                fs::remove_file(&backup).map_err(|cleanup_error| {
                    RomWeaverError::io_path(rom_weaver_core::IoOp::Write, &backup, cleanup_error)
                })
            }
            Err(error) => Err(RomWeaverError::io_path(
                rom_weaver_core::IoOp::Write,
                path,
                error,
            )),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    rom_weaver_core::complete_in_progress_output(&staged);
    if result.is_err() {
        rom_weaver_core::complete_in_progress_output(path);
    }
    result?;
    rom_weaver_core::complete_in_progress_output(path);
    Ok(())
}
