//! rw.json-driven `patch apply`: detection, selection, and merging of manifest
//! defaults into a plain [`PatchApplyCommand`]. Precedence is decided by field
//! shape — an explicit CLI value (`Some`/non-empty) always wins over the
//! manifest, which wins over built-in defaults.

use rom_weaver_core::ValidationCodeError;

use super::manifest_load::{LoadedManifestSource, is_stream_codec_format_name};
use super::manifest_parse::{manifest_file_name_codec, parse_manifest_bytes};
use super::patch_filename_checksum::FilenameRequirements;
use super::*;

/// What a manifest contributed beyond the merged command fields: expected
/// input-ROM requirements enforced after the CLI checksum flags parse.
pub(super) struct ManifestApplyResolution {
    /// `(source label, requirements)`, merged in order after CLI flags.
    pub checks: Vec<(String, FilenameRequirements)>,
}

enum ManifestApplySource {
    /// `--manifest <path>`; the positional input stays the ROM.
    Explicit(PathBuf),
    /// The positional input IS the manifest (`rw.json[.codec]`).
    InputIsManifest,
    /// The positional input is an archive carrying a root `rw.json`.
    InputArchive(Box<LoadedManifestSource>),
}

impl CliApp {
    /// Route a `patch apply` through its manifest when one is present. Mutates
    /// `args` into a fully-resolved plain command (input/patches/output/
    /// compression merged) and returns the leftover manifest contribution.
    /// Extracted archive members land in `context`'s temp namespace — the
    /// caller must keep that context alive until the apply completes.
    pub(super) fn resolve_manifest_apply(
        &self,
        args: &mut PatchApplyCommand,
        context: &OperationContext,
    ) -> Result<Option<ManifestApplyResolution>> {
        let Some(source) = self.detect_manifest_apply_source(args)? else {
            return Ok(None);
        };
        let source_mode = match &source {
            ManifestApplySource::Explicit(_) => ManifestApplySourceKind::Explicit,
            ManifestApplySource::InputIsManifest => ManifestApplySourceKind::InputIsManifest,
            ManifestApplySource::InputArchive(_) => ManifestApplySourceKind::InputArchive,
        };

        // The base-url slot is only ever populated natively (URL manifests are
        // rejected on wasm), so the annotation keeps the wasm build inferable.
        let (loaded, archive_source, manifest_dir, manifest_base_url): (_, _, _, Option<String>) =
            match source {
                ManifestApplySource::Explicit(path) => {
                    if let Some(url) = manifest_ref_as_url(&path) {
                        // Natively the manifest itself may be a URL; its base then
                        // anchors relative url entries. The browser prefetches
                        // instead, so wasm rejects URL manifests outright.
                        #[cfg(target_arch = "wasm32")]
                        {
                            return Err(manifest_url_unsupported("--manifest", url));
                        }
                        #[cfg(not(target_arch = "wasm32"))]
                        {
                            let base = super::manifest_download::manifest_url_base(url);
                            let local = self.download_manifest_url(url, "--manifest", context)?;
                            let dir = parent_dir(&local);
                            (
                                Box::new(self.load_manifest_source(&local)?),
                                local,
                                dir,
                                Some(base),
                            )
                        }
                    } else {
                        if !path.exists() {
                            return Err(RomWeaverError::Validation(format!(
                                "manifest path does not exist: `{}`",
                                path.display()
                            )));
                        }
                        let dir = parent_dir(&path);
                        (Box::new(self.load_manifest_source(&path)?), path, dir, None)
                    }
                }
                ManifestApplySource::InputIsManifest => {
                    if !args.input.exists() {
                        return Err(RomWeaverError::Validation(format!(
                            "input path does not exist: `{}`",
                            args.input.display()
                        )));
                    }
                    let dir = parent_dir(&args.input);
                    (
                        Box::new(self.load_manifest_source(&args.input)?),
                        args.input.clone(),
                        dir,
                        None,
                    )
                }
                ManifestApplySource::InputArchive(loaded) => {
                    (loaded, args.input.clone(), parent_dir(&args.input), None)
                }
            };
        let manifest = parse_manifest_bytes(&loaded.bytes)?;
        for warning in &loaded.warnings {
            warn!(manifest = %archive_source.display(), "{warning}");
        }
        trace!(
            manifest = %archive_source.display(),
            kind = ?loaded.kind,
            patches = manifest.patches.len(),
            has_rom = manifest.rom.is_some(),
            explicit_patches = args.patches.len(),
            "resolving manifest-driven patch apply"
        );

        // Lazily-created root for archive-member extraction, inside the
        // caller-owned temp namespace.
        let mut extract_root: Option<PathBuf> = None;
        let mut checks: Vec<(String, FilenameRequirements)> = Vec::new();

        if let Some(rom) = &manifest.rom {
            if let Some(rom_checks) = &rom.checks {
                checks.push((
                    "manifest rom.checks".to_string(),
                    FilenameRequirements {
                        checksums: rom_checks.checksums.clone(),
                        size: rom_checks.size,
                    },
                ));
            }
            match source_mode {
                // With --manifest the positional input is the ROM; the
                // manifest's own rom source is informational only.
                ManifestApplySourceKind::Explicit => {
                    trace!(
                        "manifest rom source ignored: the apply input supplies the ROM directly"
                    );
                }
                _ => {
                    if rom.url.is_some() || rom.path.is_some() {
                        let resolved = self.resolve_manifest_apply_entry(
                            rom.url.as_deref(),
                            rom.path.as_deref(),
                            &loaded,
                            &archive_source,
                            &manifest_dir,
                            manifest_base_url.as_deref(),
                            &mut extract_root,
                            context,
                            "rom",
                        )?;
                        if let Some(resolved) = resolved {
                            args.input = resolved;
                        }
                    }
                }
            }
        } else if matches!(source_mode, ManifestApplySourceKind::InputIsManifest) {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("manifest.rom.missing")
                    .with_message(
                        "manifest defines no rom entry; pass the ROM as the apply input and the manifest via --manifest",
                    ),
            ));
        }

        // Explicit --patch flags replace the manifest patch list wholesale;
        // the manifest still contributes rom checks and output defaults.
        if args.patches.is_empty() {
            let selected =
                self.select_manifest_patches(&manifest, &args.with_patches, &args.without_patches)?;
            if selected.is_empty() {
                return Err(RomWeaverError::Validation(
                    "no manifest patches selected (all are optional or disabled); pass --with <glob> to include some"
                        .to_string(),
                ));
            }
            let mut header_modes = Vec::with_capacity(selected.len());
            for index in &selected {
                let entry = &manifest.patches[*index];
                let entry_label = format!("patches[{index}]");
                let resolved = self
                    .resolve_manifest_apply_entry(
                        entry.url.as_deref(),
                        entry.path.as_deref(),
                        &loaded,
                        &archive_source,
                        &manifest_dir,
                        manifest_base_url.as_deref(),
                        &mut extract_root,
                        context,
                        &entry_label,
                    )?
                    .expect("patch entries always carry a source");
                self.verify_manifest_integrity(&resolved, &entry.integrity, context, &entry_label)?;
                if let Some(entry_checks) = &entry.checks {
                    checks.push((
                        format!("manifest {entry_label}.checks"),
                        FilenameRequirements {
                            checksums: entry_checks.checksums.clone(),
                            size: entry_checks.size,
                        },
                    ));
                }
                header_modes.push(entry.header.unwrap_or_default());
                trace!(
                    patch = %resolved.display(),
                    status = ?entry.status,
                    header = ?entry.header,
                    "selected manifest patch"
                );
                args.patches.push(resolved);
            }
            // Only pin per-patch header modes when the manifest sets any;
            // otherwise the all-auto default (empty list) applies. Explicit
            // --patch-header flags win untouched.
            if args.patch_header.is_empty()
                && header_modes
                    .iter()
                    .any(|mode| *mode != PatchApplyHeaderMode::Auto)
            {
                args.patch_header = header_modes;
            }
        } else {
            trace!(
                explicit_patches = args.patches.len(),
                "explicit --patch flags replace the manifest patch list"
            );
        }

        if let Some(output) = &manifest.output {
            if args.output.is_none()
                && let Some(name) = &output.name
            {
                args.output = Some(PathBuf::from(name));
            }
            if args.output_header.is_none() {
                args.output_header = output.header;
            }
            match &output.compress {
                // Validation rejected `true`, so `Disabled` means
                // `compress: false`; any explicit compression flag overrides it.
                Some(ManifestCompress::Disabled(_))
                    if !args.no_compress
                        && args.compress_format.is_none()
                        && args.compress_codec.is_empty()
                        && args.compress_level.is_none() =>
                {
                    args.no_compress = true;
                }
                Some(ManifestCompress::Settings(settings)) if !args.no_compress => {
                    if args.compress_format.is_none() {
                        args.compress_format = settings.format.clone();
                    }
                    if args.compress_codec.is_empty() {
                        args.compress_codec = settings.codecs.clone();
                    }
                    if args.compress_level.is_none() {
                        args.compress_level = settings.level;
                    }
                }
                _ => {}
            }
        }

        Ok(Some(ManifestApplyResolution { checks }))
    }

    fn detect_manifest_apply_source(
        &self,
        args: &PatchApplyCommand,
    ) -> Result<Option<ManifestApplySource>> {
        if let Some(manifest) = &args.manifest {
            return Ok(Some(ManifestApplySource::Explicit(manifest.clone())));
        }
        let input_name = args
            .input
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if let Some(codec) = manifest_file_name_codec(input_name) {
            let recognized = match codec {
                None => true,
                Some(extension) => is_stream_codec_format_name(extension),
            };
            if recognized {
                return Ok(Some(ManifestApplySource::InputIsManifest));
            }
        }
        // Archive auto-detection is guarded on "no explicit --patch": a user
        // patching an archive that happens to carry rw.json keeps today's
        // behavior by naming their patches.
        if !args.patches.is_empty() || !args.input.exists() {
            return Ok(None);
        }
        let Some(handler) = self.containers.probe(&args.input) else {
            return Ok(None);
        };
        if is_stream_codec_format_name(handler.descriptor().name) {
            return Ok(None);
        }
        match self.load_manifest_source(&args.input) {
            Ok(loaded) if loaded.kind == ManifestSourceKind::Archive => {
                Ok(Some(ManifestApplySource::InputArchive(Box::new(loaded))))
            }
            Ok(_) => Ok(None),
            Err(RomWeaverError::ValidationCode(coded)) if coded.code() == "manifest.missing" => {
                Ok(None)
            }
            // A malformed bundled manifest (compressed member, size cap) is a
            // real error the user meant us to read.
            Err(error @ RomWeaverError::ValidationCode(_)) => Err(error),
            // Listing failures fall through to the normal apply path, which
            // reports archive problems with better context.
            Err(error) => {
                trace!(
                    input = %args.input.display(),
                    %error,
                    "manifest auto-detection skipped: archive listing failed"
                );
                Ok(None)
            }
        }
    }

    /// Resolve one manifest entry to a local file. Returns `Ok(None)` only for
    /// an entry with neither url nor path (the caller decides whether that is
    /// legal). URL entries are not downloadable here yet.
    #[allow(clippy::too_many_arguments)]
    fn resolve_manifest_apply_entry(
        &self,
        url: Option<&str>,
        path: Option<&str>,
        loaded: &LoadedManifestSource,
        archive_source: &Path,
        manifest_dir: &Path,
        manifest_base_url: Option<&str>,
        extract_root: &mut Option<PathBuf>,
        context: &OperationContext,
        entry_label: &str,
    ) -> Result<Option<PathBuf>> {
        if let Some(url) = url.map(str::trim).filter(|value| !value.is_empty()) {
            #[cfg(target_arch = "wasm32")]
            {
                let _ = manifest_base_url;
                return Err(manifest_url_unsupported(entry_label, url));
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                let absolute = super::manifest_download::resolve_manifest_entry_url(
                    url,
                    manifest_base_url,
                    entry_label,
                )?;
                return Ok(Some(self.download_manifest_url(
                    &absolute,
                    entry_label,
                    context,
                )?));
            }
        }
        let Some(path) = path.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        if loaded.kind == ManifestSourceKind::Archive {
            let format_name = loaded
                .archive_format
                .expect("archive kind always carries a format name");
            let Some(entry) = Self::find_manifest_archive_entry(&loaded.archive_entries, path)
            else {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("manifest.path.unresolved")
                        .with_message("manifest path entry matches no archive member")
                        .with_field("entry", entry_label.to_owned())
                        .with_field("path", path.to_owned()),
                ));
            };
            let root = match extract_root {
                Some(root) => root.clone(),
                None => {
                    let root = context.temp_paths().next_path("patch-apply-manifest", None);
                    fs::create_dir_all(&root)?;
                    *extract_root = Some(root.clone());
                    root
                }
            };
            let target =
                Self::extract_manifest_archive_member(archive_source, format_name, entry, &root)?;
            return Ok(Some(target));
        }
        let resolved = manifest_dir.join(path);
        if !resolved.is_file() {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("manifest.path.unresolved")
                    .with_message("manifest path entry matches no file next to the manifest")
                    .with_field("entry", entry_label.to_owned())
                    .with_field("path", path.to_owned()),
            ));
        }
        Ok(Some(resolved))
    }

    /// Verify a resolved patch file against the manifest's `integrity`
    /// checksums (checksums of the patch file itself).
    fn verify_manifest_integrity(
        &self,
        file: &Path,
        integrity: &BTreeMap<String, String>,
        context: &OperationContext,
        entry_label: &str,
    ) -> Result<()> {
        if integrity.is_empty() {
            return Ok(());
        }
        let algorithms: Vec<&str> = integrity.keys().map(String::as_str).collect();
        let actual = checksum_file_values(file, &algorithms, context)?;
        for (algorithm, expected) in integrity {
            let Some(found) = actual.get(algorithm) else {
                continue;
            };
            if !found.eq_ignore_ascii_case(expected) {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("manifest.integrity.mismatch")
                        .with_message("manifest patch integrity checksum mismatch")
                        .with_field("entry", entry_label.to_owned())
                        .with_field("algorithm", algorithm.clone())
                        .with_field("expected", expected.clone())
                        .with_field("actual", found.clone()),
                ));
            }
        }
        trace!(
            file = %file.display(),
            algorithms = integrity.len(),
            "manifest patch integrity verified"
        );
        Ok(())
    }

    /// Decide which manifest patches apply this run, ordered by manifest
    /// index. Statuses drive the default; `--with`/`--without` override;
    /// an interactive session prompts for the default/optional set when no
    /// override flags were given (Cancel keeps required + default).
    pub(super) fn select_manifest_patches(
        &self,
        manifest: &RomWeaverManifest,
        with_patterns: &[String],
        without_patterns: &[String],
    ) -> Result<Vec<usize>> {
        let mut with_matcher =
            (!with_patterns.is_empty()).then(|| SelectionMatcher::new(with_patterns));
        let mut without_matcher =
            (!without_patterns.is_empty()).then(|| SelectionMatcher::new(without_patterns));
        let mut selected = Vec::new();
        for (index, entry) in manifest.patches.iter().enumerate() {
            let excluded = matches_manifest_entry(&mut without_matcher, entry);
            let included = matches_manifest_entry(&mut with_matcher, entry);
            let apply = match entry.status {
                ManifestPatchStatus::Required => {
                    if excluded {
                        return Err(RomWeaverError::ValidationCode(
                            ValidationCodeError::new("manifest.status.required-excluded")
                                .with_message("--without matched a required manifest patch")
                                .with_field("entry", format!("patches[{index}]"))
                                .with_field("name", manifest_entry_display_name(entry).to_owned()),
                        ));
                    }
                    true
                }
                ManifestPatchStatus::Default => !excluded,
                ManifestPatchStatus::Optional | ManifestPatchStatus::Disabled => included,
            };
            if apply {
                selected.push(index);
            }
        }

        // Interactive refinement only when the flags left room for it.
        if with_patterns.is_empty()
            && without_patterns.is_empty()
            && self.interactive_selection_enabled
        {
            let prompt_indices: Vec<usize> = manifest
                .patches
                .iter()
                .enumerate()
                .filter(|(_, entry)| {
                    matches!(
                        entry.status,
                        ManifestPatchStatus::Default | ManifestPatchStatus::Optional
                    )
                })
                .map(|(index, _)| index)
                .collect();
            if !prompt_indices.is_empty() {
                let candidates: Vec<PromptCandidate> = prompt_indices
                    .iter()
                    .map(|index| {
                        let entry = &manifest.patches[*index];
                        PromptCandidate {
                            value: manifest_entry_display_name(entry).to_owned(),
                            label: manifest_entry_prompt_label(entry),
                            size: None,
                        }
                    })
                    .collect();
                match self
                    .prompter
                    .select_many("Select manifest patches to apply", &candidates)
                {
                    SelectionList::Selected(picked) => {
                        let picked: BTreeSet<usize> = picked
                            .into_iter()
                            .filter_map(|position| prompt_indices.get(position).copied())
                            .collect();
                        selected = manifest
                            .patches
                            .iter()
                            .enumerate()
                            .filter(|(index, entry)| match entry.status {
                                ManifestPatchStatus::Required => true,
                                ManifestPatchStatus::Default | ManifestPatchStatus::Optional => {
                                    picked.contains(index)
                                }
                                ManifestPatchStatus::Disabled => false,
                            })
                            .map(|(index, _)| index)
                            .collect();
                    }
                    // Cancel (or an empty pick, which the protocol folds into
                    // Cancelled) keeps the non-interactive default: required +
                    // default. Deselecting everything optional is legitimate,
                    // so cancelling must not abort the run.
                    SelectionList::Cancelled => {
                        trace!(
                            "manifest patch prompt cancelled; applying required + default patches"
                        );
                    }
                }
            }
        }
        Ok(selected)
    }
}

/// Which resolution mode the manifest came from (mirrors
/// [`ManifestApplySource`] after the source value has been consumed).
#[derive(Clone, Copy)]
enum ManifestApplySourceKind {
    Explicit,
    InputIsManifest,
    InputArchive,
}

fn parent_dir(path: &Path) -> PathBuf {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn manifest_ref_as_url(path: &Path) -> Option<&str> {
    let value = path.to_str()?;
    (value.starts_with("http://") || value.starts_with("https://")).then_some(value)
}

#[cfg(target_arch = "wasm32")]
fn manifest_url_unsupported(entry_label: &str, url: &str) -> RomWeaverError {
    RomWeaverError::ValidationCode(
        ValidationCodeError::new("manifest.url.unsupported")
            .with_message("manifest url sources cannot be downloaded here; fetch the file and use a path entry instead")
            .with_field("entry", entry_label.to_owned())
            .with_field("url", url.to_owned()),
    )
}

fn manifest_entry_display_name(entry: &ManifestPatchEntry) -> &str {
    if let Some(name) = entry
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return name;
    }
    manifest_entry_file_name(entry).unwrap_or("(unnamed patch)")
}

fn manifest_entry_file_name(entry: &ManifestPatchEntry) -> Option<&str> {
    let source = entry
        .path
        .as_deref()
        .or(entry.url.as_deref())?
        .trim_end_matches(['/', '\\']);
    source
        .rsplit(['/', '\\'])
        .next()
        .map(|name| name.split(['?', '#']).next().unwrap_or(name))
        .filter(|name| !name.is_empty())
}

fn manifest_entry_prompt_label(entry: &ManifestPatchEntry) -> String {
    let mut label = manifest_entry_display_name(entry).to_string();
    if entry.status == ManifestPatchStatus::Optional {
        label.push_str(" [optional]");
    }
    if let Some(tag) = entry
        .label
        .as_deref()
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
    {
        label.push_str(&format!(" [{tag}]"));
    }
    if let Some(description) = entry
        .description
        .as_deref()
        .map(str::trim)
        .filter(|description| !description.is_empty())
    {
        label.push_str(&format!(" — {description}"));
    }
    label
}

fn matches_manifest_entry(
    matcher: &mut Option<SelectionMatcher>,
    entry: &ManifestPatchEntry,
) -> bool {
    let Some(matcher) = matcher.as_mut() else {
        return false;
    };
    if let Some(name) = entry
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        && matcher.matches(name)
    {
        return true;
    }
    manifest_entry_file_name(entry).is_some_and(|name| matcher.matches(name))
}
