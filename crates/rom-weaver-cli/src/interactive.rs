//! `apply --tui`: a light `dialoguer` wizard that collects per-patch weave
//! metadata seeded from the apply args, then hands back a `weave create`
//! command. The apply itself still runs through the normal path; this only
//! authors the accompanying `rom-weaver-weave.json`.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

use dialoguer::{Confirm, Input};
use rom_weaver_app::{PatchApplyCommand, WeaveCreateCommand, WeaveCreatePatchSpec};

/// The default weave file name written by the wizard.
const DEFAULT_WEAVE_NAME: &str = "rom-weaver-weave.json";

/// Walk each `--patch` collecting name/version/author/optional, plus an output
/// name, and build the `weave create` command that mirrors the apply. Prompts
/// draw on stderr (the caller has already confirmed a terminal). Returns a
/// human-readable message on error/cancel.
pub fn run_weave_tui(apply: &PatchApplyCommand) -> Result<WeaveCreateCommand, String> {
    if apply.patches.is_empty() {
        return Err(
            "--tui needs explicit --patch files (re-opening a weave input is not supported yet); pass --patch <file> ..."
                .to_string(),
        );
    }
    if apply.bundle.is_some() || crate::weave_apply::is_canonical_weave_input(&apply.input) {
        return Err("--tui cannot re-open a weave; rerun without --tui".to_string());
    }
    if !apply.codes.is_empty()
        || !apply.cheat_selection.cheats.is_empty()
        || !apply.cheat_records.is_empty()
    {
        return Err("--tui cannot record cheat settings; rerun without --tui".to_string());
    }
    let recipe = Path::new(DEFAULT_WEAVE_NAME);
    let recipe_identity = prospective_path(recipe, 40);
    if recipe_identity.is_none() {
        return Err(format!(
            "--tui recipe destination cannot be resolved safely; repair `{DEFAULT_WEAVE_NAME}` or choose another working directory"
        ));
    }
    if let Some(path) = std::iter::once(&apply.input)
        .chain(&apply.patches)
        .chain(&apply.output)
        .find(|path| {
            crate::path_access::paths_refer_to_same_file(recipe, path)
                || matches!(
                    (recipe_identity.as_ref(), prospective_path(path, 40)),
                    (Some(recipe), Some(path)) if recipe == &path
                )
        })
    {
        return Err(format!(
            "--tui recipe `{DEFAULT_WEAVE_NAME}` and `{}` resolve to the same file; choose a different --output path or working directory",
            path.display()
        ));
    }

    crate::render::write_stderr(format_args!(
        "Authoring rom-weaver-weave.json for {} patch(es) applied to {}\n",
        apply.patches.len(),
        crate::render::display_text(&apply.input.to_string_lossy())
    ));

    let total = apply.patches.len();
    let mut patch_specs = Vec::with_capacity(total);
    for (index, path) in apply.patches.iter().enumerate() {
        let file = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("patch");
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or(file);
        crate::render::write_stderr(format_args!(
            "\nPatch {}/{}  {}\n",
            index + 1,
            total,
            crate::render::display_text(file)
        ));
        let name: String = Input::new()
            .with_prompt("  name")
            .default(stem.to_owned())
            .interact_text()
            .map_err(|error| error.to_string())?;
        let version: String = Input::new()
            .with_prompt("  version")
            .allow_empty(true)
            .default(String::new())
            .interact_text()
            .map_err(|error| error.to_string())?;
        let author: String = Input::new()
            .with_prompt("  author")
            .allow_empty(true)
            .default(String::new())
            .interact_text()
            .map_err(|error| error.to_string())?;
        let optional = Confirm::new()
            .with_prompt("  optional (starts deselected)?")
            .default(false)
            .interact()
            .map_err(|error| error.to_string())?;
        patch_specs.push(WeaveCreatePatchSpec {
            path: path.clone(),
            name: non_empty(name),
            version: non_empty(version),
            author: non_empty(author),
            optional: optional.then_some(true),
            ..WeaveCreatePatchSpec::default()
        });
    }

    let default_output = apply
        .input
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned();
    let output_name: String = Input::new()
        .with_prompt("\nOutput file name")
        .allow_empty(true)
        .default(default_output)
        .interact_text()
        .map_err(|error| error.to_string())?;

    Ok(WeaveCreateCommand {
        rom: Some(apply.input.clone()),
        output: PathBuf::from(DEFAULT_WEAVE_NAME),
        output_name: non_empty(output_name),
        output_header: apply.output_header,
        threads: apply.threads,
        force: apply.force,
        patch_specs,
        ..WeaveCreateCommand::default()
    })
}

// Check physical paths after inferred names and compression extensions settle.
// Display/report paths MUST NOT be used: they can lose native filename bytes.
pub(crate) fn protect_recipe_paths(
    mut report: rom_weaver_core::OperationReport,
    paths: &[PathBuf],
) -> rom_weaver_core::OperationReport {
    use rom_weaver_core::{OperationStatus, RomWeaverErrorKind};

    if report.status != OperationStatus::Succeeded {
        return report;
    }
    let collision = paths.iter().find(|path| {
        crate::path_access::paths_refer_to_same_file(Path::new(DEFAULT_WEAVE_NAME), path)
    });
    if let Some(path) = collision {
        report.status = OperationStatus::Failed;
        report.label = format!(
            "patch apply succeeded, but the TUI recipe would overwrite `{}`; choose a different --output path or working directory; the patched output was kept",
            path.display()
        );
        report = report.with_error_kind(RomWeaverErrorKind::Validation);
    }
    report
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

// Only missing paths MAY be resolved prospectively; other I/O errors MUST fail
// closed. Dangling-link traversal MUST be bounded because links may form cycles.
fn prospective_path(path: &Path, links_left: u8) -> Option<PathBuf> {
    match fs::canonicalize(path) {
        Ok(canonical) => return Some(canonical),
        Err(error) if error.kind() != io::ErrorKind::NotFound => return None,
        Err(_) => {}
    }
    let absolute = std::path::absolute(path).ok()?;
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            component => {
                resolved.push(component.as_os_str());
                match fs::canonicalize(&resolved) {
                    Ok(canonical) => resolved = canonical,
                    Err(error) if error.kind() != io::ErrorKind::NotFound => return None,
                    Err(_) => {
                        if let Ok(target) = fs::read_link(&resolved) {
                            let target = resolved.parent()?.join(target);
                            resolved = prospective_path(&target, links_left.checked_sub(1)?)?;
                        }
                    }
                }
            }
        }
    }
    Some(resolved)
}
