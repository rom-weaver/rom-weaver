//! rom-weaver-bundle.json-driven `patch apply`: detection, selection, and merging of bundle
//! defaults into a plain [`PatchApplyCommand`]. Precedence is decided by field
//! shape - an explicit CLI value (`Some`/non-empty) always wins over the
//! bundle, which wins over built-in defaults.

use rom_weaver_core::ValidationCodeError;

use super::bundle_load::{LoadedBundleSource, is_stream_codec_format_name};
use super::bundle_parse::{
    bundle_bytes_are_valid, bundle_file_name_codec, is_bundle_json_candidate, parse_bundle_bytes,
};
use super::identify_command::{IdentifyDatabaseSet, IdentifyStatus};
use super::patch_filename_checksum::FilenameRequirements;
use super::*;

/// What a bundle contributed beyond the merged command fields: expected
/// input-ROM requirements enforced after the CLI checksum flags parse, and
/// the expected checksums of the final output for this selection.
pub(super) struct BundleApplyResolution {
    /// Effective shared rule for the resolved bundle. Version 1 forces auto;
    /// version 2 supplies `patchBasis`; an explicit CLI shared rule wins.
    pub patch_basis: PatchBasisMode,
    /// `(source label, requirements)`, merged in order after CLI flags.
    pub checks: Vec<(String, FilenameRequirements)>,
    /// Advisory file-name expectation for a ROM supplied separately from the
    /// bundle. Compared after auto-extraction resolves the logical ROM leaf.
    pub expected_rom_name: Option<String>,
    /// `(source label, requirements)` for the final output: the last selected
    /// patch's `outputChecks`, or the bundle's `output.checks` when the
    /// selection ends the full chain.
    pub output_checks: Option<(String, FilenameRequirements)>,
    /// Per selected patch (apply order): declared basis and mid-chain
    /// declared checks, consumed by the apply chain loop.
    pub step_verifications: Vec<patch_plan::PatchStepVerification>,
    /// Concrete selected inputs, index-aligned with the resolved bundle patch
    /// list. Omitted inputs retain the legacy sequential execution path.
    pub step_inputs: Vec<Option<BundlePatchInput>>,
    /// Cumulative selected execution lanes, index-aligned with step inputs.
    pub step_targets: Vec<Option<BundlePatchInput>>,
    /// Stable producer IDs for concrete patch-output inputs.
    pub step_ids: Vec<Option<String>>,
    /// Bundle-authored ROM member selector. It applies only while resolving
    /// the ROM source; patch archives keep the caller's selections.
    pub rom_member: Option<String>,
    /// The bundle's cheat entries, resolved once the input ROM is known.
    #[cfg(not(target_arch = "wasm32"))]
    pub cheats: Vec<BundleCheatEntry>,
}

enum BundleApplySource {
    /// `--bundle <path>`; the positional input stays the ROM.
    Explicit(PathBuf),
    /// The positional input IS the bundle (`rom-weaver-bundle.json[.codec]`).
    InputIsBundle,
    /// The positional input is an archive carrying a root `rom-weaver-bundle.json`.
    InputArchive(Box<LoadedBundleSource>),
}

struct BundleApplySourceContext {
    mode: BundleApplySourceKind,
    loaded: Box<LoadedBundleSource>,
    archive_source: PathBuf,
    bundle_dir: PathBuf,
    bundle_base_url: Option<String>,
}

struct ResolveBundleApplyEntryInputs<'a> {
    url: Option<&'a str>,
    path: Option<&'a str>,
    loaded: &'a LoadedBundleSource,
    archive_source: &'a Path,
    bundle_dir: &'a Path,
    bundle_base_url: Option<&'a str>,
    extract_root: &'a mut Option<PathBuf>,
    context: &'a OperationContext,
    entry_label: &'a str,
}

impl CliApp {
    /// Route a `patch apply` through its bundle when one is present. Mutates
    /// `args` into a fully-resolved plain command (input/patches/output merged)
    /// and returns the leftover bundle contribution.
    /// Extracted archive members land in `context`'s temp namespace - the
    /// caller must keep that context alive until the apply completes.
    pub(super) fn resolve_bundle_apply(
        &self,
        args: &mut PatchApplyCommand,
        context: &OperationContext,
    ) -> Result<Option<BundleApplyResolution>> {
        let Some(source) = self.detect_bundle_apply_source(args)? else {
            return Ok(None);
        };
        let source = self.load_bundle_apply_source(source, args, context)?;
        let bundle = parse_bundle_bytes(&source.loaded.bytes)?;
        let patch_basis = args.default_patch_basis.unwrap_or_else(|| {
            if bundle.version == 1 {
                PatchBasisMode::Auto
            } else {
                bundle.patch_basis.unwrap_or(PatchBasisMode::Auto)
            }
        });
        let expected_rom_name = matches!(source.mode, BundleApplySourceKind::Explicit)
            .then(|| {
                bundle
                    .rom
                    .as_ref()?
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
            })
            .flatten();
        let rom_member = bundle.rom.as_ref().and_then(|rom| rom.member.clone());
        for warning in &source.loaded.warnings {
            warn!(bundle = %source.archive_source.display(), "{warning}");
        }
        trace!(
            bundle = %source.archive_source.display(),
            kind = ?source.loaded.kind,
            patches = bundle.patches.len(),
            cheats = bundle.cheats.len(),
            has_rom = bundle.rom.is_some(),
            explicit_patches = args.patches.len(),
            "resolving bundle-driven patch apply"
        );

        // Lazily-created root for archive-member extraction, inside the
        // caller-owned temp namespace.
        let mut extract_root: Option<PathBuf> = None;
        let mut checks: Vec<(String, FilenameRequirements)> = Vec::new();

        self.merge_bundle_apply_rom(
            args,
            &bundle,
            &source,
            &mut extract_root,
            context,
            &mut checks,
        )?;

        // Explicit --patch flags replace the bundle patch list wholesale;
        // the bundle still contributes rom checks and output defaults.
        let mut output_checks: Option<(String, FilenameRequirements)> = None;
        let mut step_verifications: Vec<patch_plan::PatchStepVerification> = Vec::new();
        let mut step_inputs: Vec<Option<BundlePatchInput>> = Vec::new();
        let mut step_targets: Vec<Option<BundlePatchInput>> = Vec::new();
        let mut step_ids: Vec<Option<String>> = Vec::new();
        if args.patches.is_empty() {
            let selected =
                self.select_bundle_patches(&bundle, &args.with_patches, &args.without_patches)?;
            let selected_set: BTreeSet<usize> = selected.iter().copied().collect();
            // A cheats-only bundle legitimately selects no patch - unless the
            // caller dropped the cheats too, leaving nothing to run.
            if selected.is_empty() && (bundle.cheats.is_empty() || args.without_cheats) {
                return Err(RomWeaverError::Validation(
                    "no bundle patches selected (all are optional or disabled); pass --with <glob> to include some"
                        .to_string(),
                ));
            }
            let selected_ids: BTreeMap<&str, usize> = selected
                .iter()
                .enumerate()
                .filter_map(|(position, index)| {
                    bundle.patches[*index]
                        .id
                        .as_deref()
                        .map(|id| (id, position))
                })
                .collect();
            for (position, index) in selected.iter().enumerate() {
                for (selector_name, selector) in [
                    ("input", bundle.patches[*index].input.as_ref()),
                    ("target", bundle.patches[*index].target.as_ref()),
                ] {
                    let Some(BundlePatchInput::Patch {
                        patch: producer, ..
                    }) = selector
                    else {
                        continue;
                    };
                    if selected_ids
                        .get(producer.as_str())
                        .is_none_or(|producer_position| *producer_position >= position)
                    {
                        return Err(RomWeaverError::ValidationCode(
                            ValidationCodeError::new(match selector_name {
                                "input" => "bundle.patch.input.patch.unavailable",
                                "target" => "bundle.patch.target.patch.unavailable",
                                _ => unreachable!("only input and target selectors are checked"),
                            })
                            .with_message(
                                "patch selector references an earlier patch that is not selected",
                            )
                            .with_field("entry", format!("patches[{index}]"))
                            .with_field("patch", producer.clone()),
                        ));
                    }
                }
            }
            let mut header_modes = Vec::with_capacity(selected.len());
            for (position, index) in selected.iter().enumerate() {
                let entry = &bundle.patches[*index];
                let entry_label = format!("patches[{index}]");
                let resolved = self
                    .resolve_bundle_apply_entry(ResolveBundleApplyEntryInputs {
                        url: entry.url.as_deref(),
                        path: entry.path.as_deref(),
                        loaded: &source.loaded,
                        archive_source: &source.archive_source,
                        bundle_dir: &source.bundle_dir,
                        bundle_base_url: source.bundle_base_url.as_deref(),
                        extract_root: &mut extract_root,
                        context,
                        entry_label: &entry_label,
                    })?
                    .expect("patch entries always carry a source");
                // Only the FIRST applied patch's input state describes the
                // supplied ROM; without its own inputChecks it relies on
                // rom.checks (already merged). Later patches' inputChecks are
                // mid-chain states, validated by construction of the chain.
                let input_checks = resolve_bundle_checks(
                    &bundle,
                    entry.input_checks.as_ref(),
                    entry.input_checks_ref.as_deref(),
                )?;
                let input_is_root_rom = entry.target.is_none()
                    && match entry.input.as_ref() {
                        None => true,
                        Some(BundlePatchInput::Rom { member, .. }) => {
                            member == &bundle.rom.as_ref().and_then(|rom| rom.member.clone())
                        }
                        Some(BundlePatchInput::Patch { .. }) => false,
                    };
                if position == 0
                    && input_is_root_rom
                    && let Some(entry_checks) = &input_checks
                {
                    checks.push((
                        format!("bundle {entry_label}.inputChecks"),
                        FilenameRequirements {
                            checksums: entry_checks.checksums.clone(),
                            size: entry_checks.size,
                        },
                    ));
                }
                // A skipped chain step is detectable when both sides declare
                // their state: warn instead of failing so intentionally
                // reordered/partial selections still run.
                if position > 0
                    && let Some(previous_output) = selected
                        .get(position - 1)
                        .map(|previous| &bundle.patches[*previous])
                        .map(|previous| {
                            resolve_bundle_checks(
                                &bundle,
                                previous.output_checks.as_ref(),
                                previous.output_checks_ref.as_deref(),
                            )
                        })
                        .transpose()?
                        .flatten()
                    && let Some(entry_input) = resolve_bundle_checks(
                        &bundle,
                        entry.input_checks.as_ref(),
                        entry.input_checks_ref.as_deref(),
                    )?
                    && !bundle_checks_agree(&previous_output, &entry_input)
                {
                    warn!(
                        entry = %entry_label,
                        "bundle chain mismatch: this patch's inputChecks differ from the previous selected patch's outputChecks"
                    );
                }
                header_modes.push(entry.header.unwrap_or_default());
                // A declared state gates only when every earlier entry in its
                // own execution lane is selected. Other ROM/member lanes do
                // not change these bytes.
                let is_chain_prefix = (0..=*index)
                    .filter(|candidate| bundle.patches[*candidate].target == entry.target)
                    .all(|candidate| selected_set.contains(&candidate));
                let entry_basis = entry.basis.map(|basis| match basis {
                    PatchInputBasis::Base => PatchBasisMode::Base,
                    PatchInputBasis::Previous => PatchBasisMode::Previous,
                });
                let bundle_basis = (bundle.version != 1)
                    .then_some(bundle.patch_basis)
                    .flatten();
                let effective_basis = args
                    .default_patch_basis
                    .or(entry_basis)
                    .or(bundle_basis)
                    .unwrap_or(PatchBasisMode::Auto);
                let output_checks = resolve_bundle_checks(
                    &bundle,
                    entry.output_checks.as_ref(),
                    entry.output_checks_ref.as_deref(),
                )?;
                step_verifications.push(patch_plan::PatchStepVerification {
                    execution: None,
                    base_variant: None,
                    base_representation: None,
                    basis: effective_basis.declared(),
                    basis_source: effective_basis
                        .declared()
                        .map(|_| PatchBasisSource::Declared),
                    declared_input: input_checks
                        .as_ref()
                        .map(patch_plan::PlanState::from_bundle_checks),
                    declared_output: output_checks
                        .as_ref()
                        .map(patch_plan::PlanState::from_bundle_checks),
                    is_chain_prefix,
                    lane_source_input: false,
                });
                step_inputs.push(entry.input.clone());
                step_targets.push(entry.target.clone());
                step_ids.push(entry.id.clone());
                trace!(
                    patch = %resolved.display(),
                    optional = entry.optional,
                    header = ?entry.header,
                    basis = ?effective_basis,
                    is_chain_prefix,
                    "selected bundle patch"
                );
                args.patches.push(resolved);
            }
            fill_member_lane_checks(
                &bundle,
                &step_targets,
                &step_inputs,
                &mut step_verifications,
            )?;
            output_checks =
                resolve_selected_bundle_output_check(&bundle, &selected, &selected_set)?;
            // Only pin per-patch header modes when the bundle sets any;
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
                "explicit --patch flags replace the bundle patch list"
            );
        }

        if let Some(output) = &bundle.output {
            if args.output.is_none()
                && let Some(name) = &output.name
            {
                args.output = Some(PathBuf::from(name));
            }
            if args.output_header.is_none() {
                args.output_header = output.header;
            }
        }

        Ok(Some(BundleApplyResolution {
            patch_basis,
            checks,
            expected_rom_name,
            output_checks,
            step_verifications,
            step_inputs,
            step_targets,
            step_ids,
            rom_member,
            // `--without-cheats` runs the patch chain alone.
            #[cfg(not(target_arch = "wasm32"))]
            cheats: if args.without_cheats {
                Vec::new()
            } else {
                bundle.cheats.clone()
            },
        }))
    }

    fn merge_bundle_apply_rom(
        &self,
        args: &mut PatchApplyCommand,
        bundle: &RomWeaverBundle,
        source: &BundleApplySourceContext,
        extract_root: &mut Option<PathBuf>,
        context: &OperationContext,
        checks: &mut Vec<(String, FilenameRequirements)>,
    ) -> Result<()> {
        let Some(rom) = &bundle.rom else {
            if matches!(source.mode, BundleApplySourceKind::InputIsBundle) {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("bundle.rom.missing").with_message(
                        "bundle defines no rom entry; pass the ROM as the apply input and the bundle via --bundle",
                    ),
                ));
            }
            return Ok(());
        };
        if let Some(rom_checks) =
            resolve_bundle_checks(bundle, rom.checks.as_ref(), rom.checks_ref.as_deref())?
        {
            checks.push((
                "bundle rom.checks".to_string(),
                FilenameRequirements {
                    checksums: rom_checks.checksums.clone(),
                    size: rom_checks.size,
                },
            ));
        }
        if matches!(source.mode, BundleApplySourceKind::Explicit) {
            trace!("bundle rom source ignored: the apply input supplies the ROM directly");
            return Ok(());
        }
        if rom.url.is_some() || rom.path.is_some() {
            if let Some(resolved) =
                self.resolve_bundle_apply_entry(ResolveBundleApplyEntryInputs {
                    url: rom.url.as_deref(),
                    path: rom.path.as_deref(),
                    loaded: &source.loaded,
                    archive_source: &source.archive_source,
                    bundle_dir: &source.bundle_dir,
                    bundle_base_url: source.bundle_base_url.as_deref(),
                    extract_root,
                    context,
                    entry_label: "rom",
                })?
            {
                args.input = resolved;
            }
            return Ok(());
        }

        let mut coded = ValidationCodeError::new("bundle.rom.missing").with_message(
            "bundle rom entry provides no source; pass the ROM as the apply input and the bundle via --bundle",
        );
        if let Some(name) = rom
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            coded.push_field("expected_name", name.to_owned());
        }
        if let Some(rom_checks) =
            resolve_bundle_checks(bundle, rom.checks.as_ref(), rom.checks_ref.as_deref())?
        {
            if !rom_checks.checksums.is_empty() {
                coded.push_field(
                    "expected_checksums",
                    format_bundle_checksums(&rom_checks.checksums),
                );
            }
            if let Some(size) = rom_checks.size {
                coded.push_field("expected_size", size);
            }
            describe_expected_state(&rom_checks.checksums, rom_checks.size, &mut coded);
        }
        Err(RomWeaverError::ValidationCode(coded))
    }

    fn load_bundle_apply_source(
        &self,
        source: BundleApplySource,
        args: &PatchApplyCommand,
        _context: &OperationContext,
    ) -> Result<BundleApplySourceContext> {
        let mode = match &source {
            BundleApplySource::Explicit(_) => BundleApplySourceKind::Explicit,
            BundleApplySource::InputIsBundle => BundleApplySourceKind::InputIsBundle,
            BundleApplySource::InputArchive(_) => BundleApplySourceKind::InputArchive,
        };
        let (loaded, archive_source, bundle_dir, bundle_base_url) = match source {
            BundleApplySource::Explicit(path) => {
                if let Some(url) = bundle_ref_as_url(&path) {
                    #[cfg(target_arch = "wasm32")]
                    {
                        return Err(bundle_url_unsupported("--bundle", url));
                    }
                    #[cfg(not(target_arch = "wasm32"))]
                    {
                        let base = super::bundle_download::bundle_url_base(url);
                        let local = self.download_bundle_url(url, "--bundle", _context)?;
                        let dir = parent_dir(&local);
                        (
                            Box::new(self.load_bundle_source(&local)?),
                            local,
                            dir,
                            Some(base),
                        )
                    }
                } else {
                    if !path.exists() {
                        return Err(RomWeaverError::Validation(format!(
                            "bundle path does not exist: `{}`",
                            path.display()
                        )));
                    }
                    let dir = parent_dir(&path);
                    (Box::new(self.load_bundle_source(&path)?), path, dir, None)
                }
            }
            BundleApplySource::InputIsBundle => {
                if !args.input.exists() {
                    return Err(RomWeaverError::Validation(format!(
                        "input path does not exist: `{}`",
                        args.input.display()
                    )));
                }
                let dir = parent_dir(&args.input);
                (
                    Box::new(self.load_bundle_source(&args.input)?),
                    args.input.clone(),
                    dir,
                    None,
                )
            }
            BundleApplySource::InputArchive(loaded) => {
                (loaded, args.input.clone(), parent_dir(&args.input), None)
            }
        };
        Ok(BundleApplySourceContext {
            mode,
            loaded,
            archive_source,
            bundle_dir,
            bundle_base_url,
        })
    }

    fn detect_bundle_apply_source(
        &self,
        args: &PatchApplyCommand,
    ) -> Result<Option<BundleApplySource>> {
        if let Some(bundle) = &args.bundle {
            return Ok(Some(BundleApplySource::Explicit(bundle.clone())));
        }
        let input_name = args
            .input
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if let Some(codec) = bundle_file_name_codec(input_name) {
            let recognized = match codec {
                None => true,
                Some(extension) => is_stream_codec_format_name(extension),
            };
            if recognized {
                return Ok(Some(BundleApplySource::InputIsBundle));
            }
        }
        // Archive / non-canonical-JSON auto-detection is guarded on "no
        // explicit --patch": a user patching an archive that happens to carry a
        // bundle (or naming a `.json` input) keeps today's behavior by naming
        // their patches.
        if !args.patches.is_empty() || !args.input.exists() {
            return Ok(None);
        }
        let Some(handler) = self.containers.probe(&args.input) else {
            // A plain, non-canonically-named `*.json` may still be a bundle:
            // content-probe it (a stray JSON simply fails to validate).
            if is_bundle_json_candidate(input_name)
                && let Ok(loaded) = self.load_bundle_source(&args.input)
                && bundle_bytes_are_valid(&loaded.bytes)
            {
                return Ok(Some(BundleApplySource::InputIsBundle));
            }
            return Ok(None);
        };
        if is_stream_codec_format_name(handler.descriptor().name) {
            return Ok(None);
        }
        match self.load_bundle_source(&args.input) {
            Ok(loaded) if loaded.kind == BundleSourceKind::Archive => {
                Ok(Some(BundleApplySource::InputArchive(Box::new(loaded))))
            }
            Ok(_) => Ok(None),
            Err(RomWeaverError::ValidationCode(coded)) if coded.code() == "bundle.missing" => {
                Ok(None)
            }
            // A malformed bundled bundle (compressed member, size cap) is a
            // real error the user meant us to read.
            Err(error @ RomWeaverError::ValidationCode(_)) => Err(error),
            // Listing failures fall through to the normal apply path, which
            // reports archive problems with better context.
            Err(error) => {
                trace!(
                    input = %args.input.display(),
                    %error,
                    "bundle auto-detection skipped: archive listing failed"
                );
                Ok(None)
            }
        }
    }

    /// Resolve one bundle entry to a local file. Returns `Ok(None)` only for
    /// an entry with neither url nor path (the caller decides whether that is
    /// legal). URL entries are not downloadable here yet.
    fn resolve_bundle_apply_entry(
        &self,
        inputs: ResolveBundleApplyEntryInputs<'_>,
    ) -> Result<Option<PathBuf>> {
        let ResolveBundleApplyEntryInputs {
            url,
            path,
            loaded,
            archive_source,
            bundle_dir,
            bundle_base_url,
            extract_root,
            context,
            entry_label,
        } = inputs;
        if let Some(url) = url.map(str::trim).filter(|value| !value.is_empty()) {
            #[cfg(target_arch = "wasm32")]
            {
                let _ = bundle_base_url;
                return Err(bundle_url_unsupported(entry_label, url));
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                let absolute = super::bundle_download::resolve_bundle_entry_url(
                    url,
                    bundle_base_url,
                    entry_label,
                )?;
                return Ok(Some(self.download_bundle_url(
                    &absolute,
                    entry_label,
                    context,
                )?));
            }
        }
        let Some(path) = path.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        if loaded.kind == BundleSourceKind::Archive {
            let format_name = loaded
                .archive_format
                .expect("archive kind always carries a format name");
            let Some(entry) = Self::find_bundle_archive_entry(&loaded.archive_entries, path) else {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("bundle.path.unresolved")
                        .with_message("bundle path entry matches no archive member")
                        .with_field("entry", entry_label.to_owned())
                        .with_field("path", path.to_owned()),
                ));
            };
            let root = match extract_root {
                Some(root) => root.clone(),
                None => {
                    let root = context.temp_paths().next_path("patch-apply-bundle", None);
                    fs::create_dir_all(&root)?;
                    *extract_root = Some(root.clone());
                    root
                }
            };
            let target =
                Self::extract_bundle_archive_member(archive_source, format_name, entry, &root)?;
            return Ok(Some(target));
        }
        let resolved = bundle_dir.join(path);
        if !resolved.is_file() {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.path.unresolved")
                    .with_message("bundle path entry matches no file next to the bundle")
                    .with_field("entry", entry_label.to_owned())
                    .with_field("path", path.to_owned()),
            ));
        }
        Ok(Some(resolved))
    }

    /// Decide which bundle patches apply this run, ordered by bundle
    /// index. Non-optional entries seed the selection; `--with`/`--without`
    /// override it; an interactive session may toggle every entry.
    pub(super) fn select_bundle_patches(
        &self,
        bundle: &RomWeaverBundle,
        with_patterns: &[String],
        without_patterns: &[String],
    ) -> Result<Vec<usize>> {
        let mut with_matcher =
            (!with_patterns.is_empty()).then(|| SelectionMatcher::new(with_patterns));
        let mut without_matcher =
            (!without_patterns.is_empty()).then(|| SelectionMatcher::new(without_patterns));
        let mut selected = Vec::new();
        for (index, entry) in bundle.patches.iter().enumerate() {
            let excluded = matches_bundle_entry(&mut without_matcher, entry);
            let included = matches_bundle_entry(&mut with_matcher, entry);
            let apply = !excluded && (!entry.optional || included);
            if apply {
                selected.push(index);
            }
        }

        // Interactive refinement only when the flags left room for it.
        if with_patterns.is_empty()
            && without_patterns.is_empty()
            && self.interactive_selection_enabled
        {
            let prompt_indices: Vec<usize> = (0..bundle.patches.len()).collect();
            if !prompt_indices.is_empty() {
                let candidates: Vec<PromptCandidate> = prompt_indices
                    .iter()
                    .map(|index| {
                        let entry = &bundle.patches[*index];
                        PromptCandidate {
                            value: bundle_entry_display_name(entry).to_owned(),
                            label: bundle_entry_prompt_label(entry),
                            size: None,
                        }
                    })
                    .collect();
                match self
                    .prompter
                    .select_many("Select bundle patches to apply", &candidates)
                {
                    SelectionList::Selected(picked) => {
                        let picked: BTreeSet<usize> = picked
                            .into_iter()
                            .filter_map(|position| prompt_indices.get(position).copied())
                            .collect();
                        selected = picked.into_iter().collect();
                    }
                    // Cancel (or an empty pick, which the protocol folds into
                    // Cancelled) keeps the non-interactive defaults.
                    // Deselecting everything is legitimate,
                    // so cancelling must not abort the run.
                    SelectionList::Cancelled => {
                        trace!("bundle patch prompt cancelled; applying default patches");
                    }
                }
            }
        }
        Ok(selected)
    }
}

fn resolve_bundle_checks(
    bundle: &RomWeaverBundle,
    inline: Option<&BundleChecks>,
    reference: Option<&str>,
) -> Result<Option<BundleChecks>> {
    if let Some(checks) = inline {
        return Ok(Some(checks.clone()));
    }
    let Some(reference) = reference else {
        return Ok(None);
    };
    bundle
        .check_states
        .iter()
        .find(|state| state.id == reference)
        .map(|state| state.checks.clone())
        .map(Some)
        .ok_or_else(|| {
            RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.checks.reference.unresolved")
                    .with_message("checks reference matches no bundle checkStates id")
                    .with_field("ref", reference.to_owned()),
            )
        })
}

/// Which resolution mode the bundle came from (mirrors
/// [`BundleApplySource`] after the source value has been consumed).
#[derive(Clone, Copy)]
enum BundleApplySourceKind {
    Explicit,
    InputIsBundle,
    InputArchive,
}

/// Render an `algorithm -> hex` map as a `algo=hex, algo=hex` display string
/// (error-field payloads shown to the user).
fn format_bundle_checksums(checksums: &BTreeMap<String, String>) -> String {
    checksums
        .iter()
        .map(|(algorithm, hex)| format!("{algorithm}={hex}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Whether two declared chain states agree on every checksum algorithm (and
/// size) they BOTH pin. Disjoint declarations cannot disagree.
fn bundle_checks_agree(left: &BundleChecks, right: &BundleChecks) -> bool {
    let checksums_agree = left.checksums.iter().all(|(algorithm, hex)| {
        right
            .checksums
            .get(algorithm)
            .is_none_or(|other| other.eq_ignore_ascii_case(hex))
    });
    let sizes_agree = match (left.size, right.size) {
        (Some(left_size), Some(right_size)) => left_size == right_size,
        _ => true,
    };
    checksums_agree && sizes_agree
}

fn resolve_selected_bundle_output_check(
    bundle: &RomWeaverBundle,
    selected: &[usize],
    selected_set: &BTreeSet<usize>,
) -> Result<Option<(String, FilenameRequirements)>> {
    let Some(last) = selected.last() else {
        return Ok(None);
    };
    let last_entry = &bundle.patches[*last];
    let is_chain_prefix = (0..=*last)
        .filter(|candidate| bundle.patches[*candidate].target == last_entry.target)
        .all(|candidate| selected_set.contains(&candidate));
    let last_output_checks = resolve_bundle_checks(
        bundle,
        last_entry.output_checks.as_ref(),
        last_entry.output_checks_ref.as_deref(),
    )?;
    let resolved = match last_output_checks {
        // Target-lane endpoint checks verify inside the apply loop against raw
        // lane bytes. They must not become a check on the command output.
        Some(checks) if is_chain_prefix && last_entry.target.is_none() => {
            Some((format!("bundle patches[{last}].outputChecks"), checks))
        }
        Some(_) if last_entry.target.is_some() && selected.len() == bundle.patches.len() => bundle
            .output
            .as_ref()
            .map(|output| {
                resolve_bundle_checks(bundle, output.checks.as_ref(), output.checks_ref.as_deref())
            })
            .transpose()?
            .flatten()
            .map(|checks| ("bundle output.checks".to_string(), checks)),
        Some(_) if last_entry.target.is_some() => None,
        Some(_) => {
            debug!(
                entry = *last,
                selected = selected.len(),
                "bundle outputChecks skipped: selection is not the chain prefix ending at this patch"
            );
            None
        }
        None if selected.len() == bundle.patches.len() => bundle
            .output
            .as_ref()
            .map(|output| {
                resolve_bundle_checks(bundle, output.checks.as_ref(), output.checks_ref.as_deref())
            })
            .transpose()?
            .flatten()
            .map(|checks| ("bundle output.checks".to_string(), checks)),
        None => None,
    };
    Ok(resolved.map(|(label, checks)| {
        (
            label,
            FilenameRequirements {
                checksums: checks.checksums,
                size: checks.size,
            },
        )
    }))
}

fn parent_dir(path: &Path) -> PathBuf {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(super) fn bundle_ref_as_url(path: &Path) -> Option<&str> {
    let value = path.to_str()?;
    (value.starts_with("http://") || value.starts_with("https://")).then_some(value)
}

#[cfg(target_arch = "wasm32")]
fn bundle_url_unsupported(entry_label: &str, url: &str) -> RomWeaverError {
    RomWeaverError::ValidationCode(
        ValidationCodeError::new("bundle.url.unsupported")
            .with_message("bundle url sources cannot be downloaded here; fetch the file and use a path entry instead")
            .with_field("entry", entry_label.to_owned())
            .with_field("url", url.to_owned()),
    )
}

fn bundle_entry_display_name(entry: &BundlePatchEntry) -> &str {
    if let Some(name) = entry
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return name;
    }
    bundle_entry_file_name(entry).unwrap_or("(unnamed patch)")
}

fn bundle_entry_file_name(entry: &BundlePatchEntry) -> Option<&str> {
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

fn bundle_entry_prompt_label(entry: &BundlePatchEntry) -> String {
    let mut label = bundle_entry_display_name(entry).to_string();
    if entry.optional {
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
        label.push_str(&format!(" - {description}"));
    }
    label
}

fn matches_bundle_entry(matcher: &mut Option<SelectionMatcher>, entry: &BundlePatchEntry) -> bool {
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
    bundle_entry_file_name(entry).is_some_and(|name| matcher.matches(name))
}

/// Look a declared state up in the local identify data and add what the
/// database knows to a failure that names it: the title, and the checksums
/// and size the declaration itself did not carry. Best effort - a missing,
/// unreadable, or ambiguous database leaves the declared fields standing
/// alone and never turns into a second failure.
///
/// A bare checksum routes to no platform, so this loads every installed pack.
/// Callers MUST reach it only from a terminal failure, never from a path that
/// goes on to do work.
pub(super) fn describe_expected_state(
    checksums: &BTreeMap<String, String>,
    size: Option<u64>,
    coded: &mut ValidationCodeError,
) {
    if checksums.is_empty() {
        return;
    }
    let Some(databases) = load_installed_identify_databases("expected-state lookup", || {
        IdentifyDatabaseSet::load(&[])
    }) else {
        return;
    };
    let checks = BundleChecks {
        checksums: checksums.clone(),
        size,
    };
    push_expected_state_fields(&checks, &databases, coded);
}

/// The identify packs `load` selects, or nothing when there is none or one
/// fails to load. A broken pack is logged, not raised: these lookups only
/// decorate a failure or add a check, and MUST NOT fail an apply on their own.
fn load_installed_identify_databases(
    purpose: &str,
    load: impl FnOnce() -> Result<Option<IdentifyDatabaseSet>>,
) -> Option<IdentifyDatabaseSet> {
    match load() {
        Ok(Some(databases)) => Some(databases),
        Ok(None) => {
            trace!(purpose, "skipped: no identify database is available");
            None
        }
        Err(error) => {
            debug!(purpose, %error, "skipped: the identify database failed to load");
            None
        }
    }
}

/// The one title a declared state resolves to, or nothing when the database
/// does not know it or cannot settle on one record.
fn lookup_expected_title(
    checks: &BundleChecks,
    databases: &IdentifyDatabaseSet,
) -> Option<super::identify_command::IdentifyTitleMatch> {
    let variants = vec![serde_json::json!({
        "id": "bundle-checks",
        "label": "Bundle checks",
        "checksums": checks.checksums,
    })];
    let Ok(lookup) = databases.resolve_variants(&variants, checks.size) else {
        trace!("expected-state lookup failed; reporting the declared checks only");
        return None;
    };
    if lookup.status != IdentifyStatus::Matched {
        trace!(status = ?lookup.status, "expected-state lookup did not settle on one title");
        return None;
    }
    lookup.matches.into_iter().next()
}

/// The lookup half of [`describe_expected_state`], split out so a test can
/// drive it with a pack of its own.
fn push_expected_state_fields(
    checks: &BundleChecks,
    databases: &IdentifyDatabaseSet,
    coded: &mut ValidationCodeError,
) {
    let Some(matched) = lookup_expected_title(checks, databases) else {
        return;
    };
    coded.push_field("expected_title", matched.name.clone());
    if !matched.platform.is_empty() {
        coded.push_field("expected_platform", matched.platform.clone());
    }
    for (field, value) in [
        ("expected_region", matched.region.as_deref()),
        ("expected_revision", matched.revision.as_deref()),
    ] {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            coded.push_field(field, value.to_owned());
        }
    }
    // Only one component can describe "the state"; a multi-track disc record
    // has no single expected file, so its extra checksums would be misleading.
    let [component] = matched.expected_components.as_slice() else {
        return;
    };
    let known: BTreeMap<&str, &str> = [
        ("crc32", component.crc32.as_deref()),
        ("md5", component.md5.as_deref()),
        ("sha1", component.sha1.as_deref()),
        ("sha256", component.sha256.as_deref()),
    ]
    .into_iter()
    .filter_map(|(algorithm, value)| value.map(|value| (algorithm, value)))
    .filter(|(algorithm, _)| !checks.checksums.contains_key(*algorithm))
    .collect();
    if !known.is_empty() {
        let rendered = known
            .iter()
            .map(|(algorithm, value)| format!("{algorithm}={value}"))
            .collect::<Vec<_>>()
            .join(", ");
        coded.push_field("database_checksums", rendered);
    }
    if checks.size.is_none() && component.size > 0 {
        coded.push_field("database_size", component.size);
    }
}

/// Give the first selected step of every ROM-member lane that declares no
/// input checks the checks the identify database holds for that member. The
/// bundle's rom checks name the title; a per-track record then describes
/// every other track of the disc. Best effort: no database, no single match,
/// a single-file record, or a member the record does not list leaves the step
/// as authored.
fn fill_member_lane_checks(
    bundle: &RomWeaverBundle,
    step_targets: &[Option<BundlePatchInput>],
    step_inputs: &[Option<BundlePatchInput>],
    step_verifications: &mut [patch_plan::PatchStepVerification],
) -> Result<()> {
    let mut seen_lanes: BTreeSet<Option<&BundlePatchInput>> = BTreeSet::new();
    let mut pending: Vec<(&str, usize)> = Vec::new();
    for (position, target) in step_targets.iter().enumerate() {
        if !seen_lanes.insert(target.as_ref()) {
            continue;
        }
        let Some(BundlePatchInput::Rom {
            member: Some(member),
            ..
        }) = target
        else {
            continue;
        };
        if step_inputs.get(position).is_some_and(Option::is_some)
            || step_verifications
                .get(position)
                .is_none_or(|step| step.declared_input.is_some())
        {
            continue;
        }
        pending.push((member.as_str(), position));
    }
    if pending.is_empty() {
        return Ok(());
    }
    let Some(rom) = &bundle.rom else {
        return Ok(());
    };
    let Some(rom_checks) =
        resolve_bundle_checks(bundle, rom.checks.as_ref(), rom.checks_ref.as_deref())?
    else {
        return Ok(());
    };
    if rom_checks.checksums.is_empty() {
        return Ok(());
    }
    // Only a per-track pack can hold a multi-track record, and loading every
    // installed pack here would tax every disc apply.
    let Some(databases) = load_installed_identify_databases(
        "member lane check fill",
        IdentifyDatabaseSet::load_track_packs,
    ) else {
        return Ok(());
    };
    fill_member_lane_checks_from(&rom_checks, &databases, &pending, step_verifications);
    Ok(())
}

/// The database half of [`fill_member_lane_checks`], split out so a test can
/// drive it with a pack of its own.
fn fill_member_lane_checks_from(
    rom_checks: &BundleChecks,
    databases: &IdentifyDatabaseSet,
    pending: &[(&str, usize)],
    step_verifications: &mut [patch_plan::PatchStepVerification],
) {
    let Some(matched) = lookup_expected_title(rom_checks, databases) else {
        return;
    };
    if matched.expected_components.len() < 2 {
        trace!(
            title = %matched.name,
            "member lane check fill skipped: the matched record is not a multi-track disc"
        );
        return;
    }
    for (member, position) in pending {
        let Some(component) = member_component(&matched.expected_components, member) else {
            debug!(
                member,
                title = %matched.name,
                "member lane check fill skipped: the record lists no such track"
            );
            continue;
        };
        let Some(state) = component_plan_state(component) else {
            continue;
        };
        debug!(
            member,
            title = %matched.name,
            checksums = state.checksums.len(),
            "filled the ROM member lane's input checks from the identify database"
        );
        let step = &mut step_verifications[*position];
        step.declared_input = Some(state);
        step.lane_source_input = true;
    }
}

/// The record component a bundle member names: by file name first, then by
/// track number, so a renamed track file still finds its record.
fn member_component<'a>(
    components: &'a [super::identify_command::IdentifyComponent],
    member: &str,
) -> Option<&'a super::identify_command::IdentifyComponent> {
    let wanted = member_file_name(member);
    let by_name = components.iter().find(|component| {
        component
            .filename
            .as_deref()
            .map(member_file_name)
            .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
    });
    if by_name.is_some() {
        return by_name;
    }
    let track = member_track_number(wanted)?;
    components
        .iter()
        .find(|component| component.track == Some(track))
}

fn member_file_name(member: &str) -> &str {
    member.rsplit(['/', '\\']).next().unwrap_or(member)
}

/// The N after the first `track` word in a name, case-insensitive, with any
/// spacing before the digits: `track01.bin`, `Game (Track 2).bin`.
fn member_track_number(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    let after = &lower[lower.find("track")? + "track".len()..];
    let digits: String = after
        .trim_start_matches(|character: char| {
            character == ' ' || character == '_' || character == '-'
        })
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// The bundle-verifiable part of a record component: the algorithms a bundle
/// check may carry, plus the size.
fn component_plan_state(
    component: &super::identify_command::IdentifyComponent,
) -> Option<patch_plan::PlanState> {
    let checksums: BTreeMap<String, String> = [
        ("crc32", component.crc32.as_deref()),
        ("md5", component.md5.as_deref()),
        ("sha1", component.sha1.as_deref()),
    ]
    .into_iter()
    .filter_map(|(algorithm, value)| value.map(|value| (algorithm.to_owned(), value.to_owned())))
    .collect();
    if checksums.is_empty() {
        return None;
    }
    Some(patch_plan::PlanState {
        checksums,
        size: (component.size > 0).then_some(component.size),
    })
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use assert_fs::TempDir;
    use rom_weaver_checksum::identify_catalog::IdentifySource;
    use rom_weaver_checksum::identify_pack_types::{
        PackComponent, PackComponentRole, PackGame, UpstreamSource,
    };
    use std::collections::BTreeMap;

    /// A one-title pack whose record knows more than any single check does.
    fn test_pack(temp: &std::path::Path) -> PathBuf {
        let game = PackGame {
            name: "Hello World (USA)".to_string(),
            alternate_names: Vec::new(),
            platform: "Test System".to_string(),
            source: IdentifySource::Libretro,
            upstream_source: UpstreamSource::Libretro,
            provenance: Vec::new(),
            legacy_variant: false,
            dump_tags: Vec::new(),
            game_id: None,
            region: Some("USA".to_string()),
            language: None,
            disc_number: None,
            revision: Some("Rev 1".to_string()),
            parent: None,
            components: vec![PackComponent {
                role: PackComponentRole::PrimaryPayload,
                ordinal: 0,
                hash_scope: "full_file".to_string(),
                filename: None,
                size: 5,
                crc32: Some("3610a686".to_string()),
                md5: Some("5d41402abc4b2a76b9719d911017c592".to_string()),
                sha1: Some("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d".to_string()),
                sha256: None,
                required: true,
                discriminating: true,
                track: None,
                session: None,
            }],
        };
        let bytes = rom_weaver_checksum::identify_pack_v1::encode(
            "Test System",
            IdentifySource::Libretro,
            "full_file",
            &serde_json::json!([]),
            vec![game],
        )
        .expect("RWFP1 pack");
        let path = temp.join("test.pack");
        fs::write(&path, bytes).expect("write pack");
        path
    }

    fn fields(coded: &ValidationCodeError) -> String {
        format!("{coded}")
    }

    #[test]
    fn expected_rom_fields_add_the_title_and_the_missing_checksums() {
        let temp = TempDir::new().expect("temp dir");
        let databases = IdentifyDatabaseSet::load(&[test_pack(temp.path())])
            .expect("load")
            .expect("packs");
        let checks = BundleChecks {
            checksums: BTreeMap::from([("crc32".to_string(), "3610a686".to_string())]),
            size: Some(5),
        };
        let mut coded = ValidationCodeError::new("bundle.rom.missing");

        push_expected_state_fields(&checks, &databases, &mut coded);

        let rendered = fields(&coded);
        assert!(rendered.contains("Hello World (USA)"), "{rendered}");
        assert!(rendered.contains("Test System"), "{rendered}");
        assert!(rendered.contains("USA"), "{rendered}");
        assert!(rendered.contains("Rev 1"), "{rendered}");
        // The check already carried crc32 and the size, so only what it lacked
        // is reported as coming from the database.
        assert!(
            rendered.contains("md5=5d41402abc4b2a76b9719d911017c592"),
            "{rendered}"
        );
        assert!(!rendered.contains("crc32=3610a686"), "{rendered}");
        assert!(!rendered.contains("database_size"), "{rendered}");
    }

    fn component(
        track: u32,
        filename: &str,
        crc32: &str,
    ) -> super::super::identify_command::IdentifyComponent {
        super::super::identify_command::IdentifyComponent {
            role: rom_weaver_core::ComponentRole::DataTrack,
            ordinal: track - 1,
            size: 2352,
            hash_scope: Some("track_file".to_string()),
            filename: Some(filename.to_string()),
            crc32: Some(crc32.to_string()),
            md5: None,
            sha1: None,
            sha256: None,
            track: Some(track),
        }
    }

    #[test]
    fn member_component_matches_by_file_name_then_by_track_number() {
        let components = vec![
            component(1, "Game (USA) (Track 1).bin", "11111111"),
            component(2, "Game (USA) (Track 2).bin", "22222222"),
        ];
        let by_name = member_component(&components, "discs\\game (usa) (track 2).bin");
        assert_eq!(by_name.and_then(|c| c.crc32.as_deref()), Some("22222222"));
        let by_track = member_component(&components, "track02.bin");
        assert_eq!(by_track.and_then(|c| c.crc32.as_deref()), Some("22222222"));
        assert!(member_component(&components, "track03.bin").is_none());
        assert!(member_component(&components, "disc.cue").is_none());
    }

    #[test]
    fn member_track_number_reads_common_spellings() {
        assert_eq!(member_track_number("track01.bin"), Some(1));
        assert_eq!(member_track_number("Game (Track 12).bin"), Some(12));
        assert_eq!(member_track_number("Track_3.raw"), Some(3));
        assert_eq!(member_track_number("data.bin"), None);
        assert_eq!(member_track_number("soundtrack.bin"), None);
    }

    #[test]
    fn component_plan_state_keeps_only_bundle_algorithms() {
        let mut component = component(1, "a.bin", "11111111");
        component.sha256 = Some("ff".to_string());
        let state = component_plan_state(&component).expect("state");
        assert_eq!(state.checksums.keys().collect::<Vec<_>>(), vec!["crc32"]);
        assert_eq!(state.size, Some(2352));
        component.crc32 = None;
        assert!(component_plan_state(&component).is_none());
    }

    #[test]
    fn expected_rom_fields_stay_silent_when_nothing_matches() {
        let temp = TempDir::new().expect("temp dir");
        let databases = IdentifyDatabaseSet::load(&[test_pack(temp.path())])
            .expect("load")
            .expect("packs");
        let checks = BundleChecks {
            checksums: BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]),
            size: Some(5),
        };
        let mut coded = ValidationCodeError::new("bundle.rom.missing");

        push_expected_state_fields(&checks, &databases, &mut coded);

        assert!(!fields(&coded).contains("expected_title"));
    }
}
