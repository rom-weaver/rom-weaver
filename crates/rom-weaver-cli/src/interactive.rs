//! `apply --tui`: a light `dialoguer` wizard that collects per-patch bundle
//! metadata seeded from the apply args, then hands back a `bundle create`
//! command. The apply itself still runs through the normal path; this only
//! authors the accompanying `rom-weaver-bundle.json`.

use std::path::PathBuf;

use dialoguer::{Confirm, Input};
use rom_weaver_app::{BundleCreateCommand, BundleCreatePatchSpec, PatchApplyCommand};

/// The default bundle file name written by the wizard.
const DEFAULT_BUNDLE_NAME: &str = "rom-weaver-bundle.json";

/// Walk each `--patch` collecting name/version/author/optional, plus an output
/// name, and build the `bundle create` command that mirrors the apply. Prompts
/// draw on stderr (the caller has already confirmed a terminal). Returns a
/// human-readable message on error/cancel.
pub fn run_bundle_tui(apply: &PatchApplyCommand) -> Result<BundleCreateCommand, String> {
    if apply.patches.is_empty() {
        return Err(
            "--tui needs explicit --patch files (re-opening a bundle input is not supported yet); pass --patch <file> ..."
                .to_string(),
        );
    }

    eprintln!(
        "Authoring rom-weaver-bundle.json for {} patch(es) applied to {}",
        apply.patches.len(),
        apply.input.display()
    );

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
        eprintln!("\nPatch {}/{}  {file}", index + 1, total);
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
        patch_specs.push(BundleCreatePatchSpec {
            path: path.clone(),
            name: non_empty(name),
            version: non_empty(version),
            author: non_empty(author),
            optional: optional.then_some(true),
            ..BundleCreatePatchSpec::default()
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

    Ok(BundleCreateCommand {
        rom: Some(apply.input.clone()),
        output: PathBuf::from(DEFAULT_BUNDLE_NAME),
        output_name: non_empty(output_name),
        threads: apply.threads,
        patch_specs,
        ..BundleCreateCommand::default()
    })
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}
