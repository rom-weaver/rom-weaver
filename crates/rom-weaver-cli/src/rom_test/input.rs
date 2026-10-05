use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use rom_weaver_core::{
    IoOp, IoResultExt, Result, RomWeaverError, detect_disc_sheet, parse_disc_sheet_refs_from_text,
    process_cancellation_token,
};

use crate::emulator_runtime::{EmulatorCore, EmulatorRuntime, safe_relative_path};

pub(super) fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn invalid(message: impl Into<String>) -> RomWeaverError {
    RomWeaverError::Validation(message.into())
}

pub(super) fn stage_rom(source: &Path, destination: &Path) -> Result<PathBuf> {
    let source = fs::canonicalize(source).io_op(IoOp::Inspect, source)?;
    let root = source
        .parent()
        .ok_or_else(|| invalid("ROM has no parent directory"))?;
    let name = source
        .file_name()
        .ok_or_else(|| invalid("ROM has no filename"))?;
    let mut staged = HashSet::new();
    stage_content_file(root, Path::new(name), destination, &mut staged, 0)?;
    Ok(destination.join(name))
}

fn stage_content_file(
    root: &Path,
    relative: &Path,
    destination: &Path,
    staged: &mut HashSet<PathBuf>,
    depth: usize,
) -> Result<()> {
    process_cancellation_token().check()?;
    if depth > 8 || staged.len() >= 1024 || !safe_relative_path(relative) {
        return Err(invalid(
            "disc references must be relative, stay inside the ROM directory, and have bounded nesting",
        ));
    }
    if !staged.insert(relative.to_path_buf()) {
        return Ok(());
    }
    let source = root.join(relative);
    let canonical = fs::canonicalize(&source).io_op(IoOp::Inspect, &source)?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(invalid(format!(
            "disc reference escapes its source directory: {}",
            relative.display()
        )));
    }
    let output = destination.join(relative);
    fs::create_dir_all(output.parent().expect("staged file has a parent"))?;
    if detect_disc_sheet(&source).is_none() && extension(&source) != "m3u" {
        fs::copy(&canonical, &output).io_op(IoOp::Write, &output)?;
        return Ok(());
    }
    if fs::metadata(&canonical)?.len() > 1024 * 1024 {
        return Err(invalid("disc sheet or playlist exceeds the 1 MiB limit"));
    }
    let text = fs::read_to_string(&canonical).io_op(IoOp::Open, &canonical)?;
    let references = if let Some(kind) = detect_disc_sheet(&source) {
        parse_disc_sheet_refs_from_text(kind, &text, &source.to_string_lossy())?
    } else {
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(str::to_owned)
            .collect()
    };
    if references.is_empty() {
        return Err(invalid("disc playlist contains no entries"));
    }
    for reference in references {
        let reference = Path::new(&reference);
        if !safe_relative_path(reference) {
            return Err(invalid(format!(
                "unsafe disc reference: {}",
                reference.display()
            )));
        }
        let nested = relative.parent().unwrap_or(Path::new("")).join(reference);
        stage_content_file(root, &nested, destination, staged, depth + 1)?;
    }
    fs::write(&output, text).io_op(IoOp::Write, &output)
}

pub(super) fn stage_system(
    runtime: &EmulatorRuntime,
    core: &EmulatorCore,
    supplied: Option<&Path>,
    destination: &Path,
) -> Result<()> {
    fs::create_dir_all(destination).io_op(IoOp::CreateDir, destination)?;
    for relative in &runtime.system_files {
        let target = destination.join(
            relative
                .strip_prefix("system")
                .map_err(|_| invalid("invalid runtime system asset"))?,
        );
        fs::create_dir_all(target.parent().expect("system asset has a parent"))?;
        fs::copy(runtime.root.join(relative), &target).io_op(IoOp::Write, &target)?;
    }
    if let Some(supplied) = supplied {
        let mut remaining_bytes = 512 * 1024 * 1024;
        let mut remaining_entries = 4096;
        copy_system_directory(
            supplied,
            destination,
            &mut remaining_bytes,
            &mut remaining_entries,
            0,
        )?;
    }
    let missing = core
        .firmware
        .iter()
        .filter(|path| !destination.join(path).is_file())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(invalid(format!(
            "core `{}` requires firmware: {}; supply --system-dir DIR",
            core.id,
            missing
                .iter()
                .map(|path| path.to_string_lossy())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(())
}

fn copy_system_directory(
    source: &Path,
    destination: &Path,
    remaining_bytes: &mut u64,
    remaining_entries: &mut usize,
    depth: usize,
) -> Result<()> {
    if depth > 16 || fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Err(invalid(
            "system directories must not contain links or exceed 16 directory levels",
        ));
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source).io_op(IoOp::ReadDir, source)? {
        process_cancellation_token().check()?;
        let entry = entry?;
        *remaining_entries = remaining_entries
            .checked_sub(1)
            .ok_or_else(|| invalid("system directory exceeds 4096 entries"))?;
        let metadata = entry.metadata()?;
        let output = destination.join(entry.file_name());
        if entry.file_type()?.is_symlink() {
            return Err(invalid(format!(
                "system asset must not be a symlink: {}",
                entry.path().display()
            )));
        }
        if metadata.is_dir() {
            copy_system_directory(
                &entry.path(),
                &output,
                remaining_bytes,
                remaining_entries,
                depth + 1,
            )?;
        } else if metadata.is_file() {
            *remaining_bytes = remaining_bytes
                .checked_sub(metadata.len())
                .ok_or_else(|| invalid("system files exceed the 512 MiB limit"))?;
            fs::copy(entry.path(), &output).io_op(IoOp::Write, &output)?;
        } else {
            return Err(invalid(
                "system assets must be regular files or directories",
            ));
        }
    }
    Ok(())
}
