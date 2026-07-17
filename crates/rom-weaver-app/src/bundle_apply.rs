//! rom-weaver-bundle.json-driven `patch apply`: detection, selection, and merging of bundle
//! defaults into a plain [`PatchApplyCommand`]. Precedence is decided by field
//! shape - an explicit CLI value (`Some`/non-empty) always wins over the
//! bundle, which wins over built-in defaults.

use rom_weaver_core::ValidationCodeError;

use super::bundle_load::{LoadedBundleSource, is_stream_codec_format_name};
use super::bundle_parse::{
    bundle_bytes_are_valid, bundle_file_name_codec, is_bundle_json_candidate, parse_bundle_bytes,
};
use super::patch_filename_checksum::FilenameRequirements;
use super::*;

/// What a bundle contributed beyond the merged command fields: expected
/// input-ROM requirements enforced after the CLI checksum flags parse, and
/// the expected checksums of the final output for this selection.
pub(super) struct BundleApplyResolution {
    /// `(source label, requirements)`, merged in order after CLI flags.
    pub checks: Vec<(String, FilenameRequirements)>,
    /// `(source label, requirements)` for the final output: the last selected
    /// patch's `outputChecks`, or the bundle's `output.checks` when the
    /// selection ends the full chain.
    pub output_checks: Option<(String, FilenameRequirements)>,
    /// Per selected patch (apply order): declared basis and mid-chain
    /// declared checks, consumed by the apply chain loop.
    pub step_verifications: Vec<patch_plan::PatchStepVerification>,
}

enum BundleApplySource {
    /// `--bundle <path>`; the positional input stays the ROM.
    Explicit(PathBuf),
    /// The positional input IS the bundle (`rom-weaver-bundle.json[.codec]`).
    InputIsBundle,
    /// The positional input is an archive carrying a root `rom-weaver-bundle.json`.
    InputArchive(Box<LoadedBundleSource>),
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
        let source_mode = match &source {
            BundleApplySource::Explicit(_) => BundleApplySourceKind::Explicit,
            BundleApplySource::InputIsBundle => BundleApplySourceKind::InputIsBundle,
            BundleApplySource::InputArchive(_) => BundleApplySourceKind::InputArchive,
        };

        // The base-url slot is only ever populated natively (URL bundles are
        // rejected on wasm), so the annotation keeps the wasm build inferable.
        let (loaded, archive_source, bundle_dir, bundle_base_url): (_, _, _, Option<String>) =
            match source {
                BundleApplySource::Explicit(path) => {
                    if let Some(url) = bundle_ref_as_url(&path) {
                        // Natively the bundle itself may be a URL; its base then
                        // anchors relative url entries. The browser prefetches
                        // instead, so wasm rejects URL bundles outright.
                        #[cfg(target_arch = "wasm32")]
                        {
                            return Err(bundle_url_unsupported("--bundle", url));
                        }
                        #[cfg(not(target_arch = "wasm32"))]
                        {
                            let base = super::bundle_download::bundle_url_base(url);
                            let local = self.download_bundle_url(url, "--bundle", context)?;
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
        let bundle = parse_bundle_bytes(&loaded.bytes)?;
        for warning in &loaded.warnings {
            warn!(bundle = %archive_source.display(), "{warning}");
        }
        trace!(
            bundle = %archive_source.display(),
            kind = ?loaded.kind,
            patches = bundle.patches.len(),
            has_rom = bundle.rom.is_some(),
            explicit_patches = args.patches.len(),
            "resolving bundle-driven patch apply"
        );

        // Lazily-created root for archive-member extraction, inside the
        // caller-owned temp namespace.
        let mut extract_root: Option<PathBuf> = None;
        let mut checks: Vec<(String, FilenameRequirements)> = Vec::new();

        if let Some(rom) = &bundle.rom {
            if let Some(rom_checks) = &rom.checks {
                checks.push((
                    "bundle rom.checks".to_string(),
                    FilenameRequirements {
                        checksums: rom_checks.checksums.clone(),
                        size: rom_checks.size,
                    },
                ));
            }
            match source_mode {
                // With --bundle the positional input is the ROM; the
                // bundle's own rom source is informational only.
                BundleApplySourceKind::Explicit => {
                    trace!("bundle rom source ignored: the apply input supplies the ROM directly");
                }
                _ => {
                    if rom.url.is_some() || rom.path.is_some() {
                        let resolved = self.resolve_bundle_apply_entry(
                            rom.url.as_deref(),
                            rom.path.as_deref(),
                            &loaded,
                            &archive_source,
                            &bundle_dir,
                            bundle_base_url.as_deref(),
                            &mut extract_root,
                            context,
                            "rom",
                        )?;
                        if let Some(resolved) = resolved {
                            args.input = resolved;
                        }
                    } else {
                        // A checks-only rom entry means the user supplies the
                        // ROM; the input we have IS the bundle (or its
                        // archive), so there is nothing to patch. Surface the
                        // expected ROM so the user knows what to supply.
                        let mut coded = ValidationCodeError::new("bundle.rom.missing")
                            .with_message(
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
                        if let Some(rom_checks) = &rom.checks {
                            if !rom_checks.checksums.is_empty() {
                                coded.push_field(
                                    "expected_checksums",
                                    format_bundle_checksums(&rom_checks.checksums),
                                );
                            }
                            if let Some(size) = rom_checks.size {
                                coded.push_field("expected_size", size);
                            }
                        }
                        return Err(RomWeaverError::ValidationCode(coded));
                    }
                }
            }
        } else if matches!(source_mode, BundleApplySourceKind::InputIsBundle) {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.rom.missing")
                    .with_message(
                        "bundle defines no rom entry; pass the ROM as the apply input and the bundle via --bundle",
                    ),
            ));
        }

        // Explicit --patch flags replace the bundle patch list wholesale;
        // the bundle still contributes rom checks and output defaults.
        let mut output_checks: Option<(String, FilenameRequirements)> = None;
        let mut step_verifications: Vec<patch_plan::PatchStepVerification> = Vec::new();
        if args.patches.is_empty() {
            let selected =
                self.select_bundle_patches(&bundle, &args.with_patches, &args.without_patches)?;
            if selected.is_empty() {
                return Err(RomWeaverError::Validation(
                    "no bundle patches selected (all are optional or disabled); pass --with <glob> to include some"
                        .to_string(),
                ));
            }
            let mut header_modes = Vec::with_capacity(selected.len());
            for (position, index) in selected.iter().enumerate() {
                let entry = &bundle.patches[*index];
                let entry_label = format!("patches[{index}]");
                let resolved = self
                    .resolve_bundle_apply_entry(
                        entry.url.as_deref(),
                        entry.path.as_deref(),
                        &loaded,
                        &archive_source,
                        &bundle_dir,
                        bundle_base_url.as_deref(),
                        &mut extract_root,
                        context,
                        &entry_label,
                    )?
                    .expect("patch entries always carry a source");
                // Only the FIRST applied patch's input state describes the
                // supplied ROM; without its own inputChecks it relies on
                // rom.checks (already merged). Later patches' inputChecks are
                // mid-chain states, validated by construction of the chain.
                if position == 0
                    && let Some(entry_checks) = &entry.input_checks
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
                        .and_then(|previous| bundle.patches[*previous].output_checks.as_ref())
                    && let Some(entry_input) = &entry.input_checks
                    && !bundle_checks_agree(previous_output, entry_input)
                {
                    warn!(
                        entry = %entry_label,
                        "bundle chain mismatch: this patch's inputChecks differ from the previous selected patch's outputChecks"
                    );
                }
                header_modes.push(entry.header.unwrap_or_default());
                // Position k consumes exactly the authored chain prefix when
                // every earlier bundle patch is selected too.
                let is_chain_prefix = *index == position;
                step_verifications.push(patch_plan::PatchStepVerification {
                    basis: entry.basis,
                    basis_source: entry.basis.map(|_| PatchBasisSource::Declared),
                    declared_input: entry
                        .input_checks
                        .as_ref()
                        .map(patch_plan::PlanState::from_bundle_checks),
                    declared_output: entry
                        .output_checks
                        .as_ref()
                        .map(patch_plan::PlanState::from_bundle_checks),
                    is_chain_prefix,
                });
                trace!(
                    patch = %resolved.display(),
                    optional = entry.optional,
                    header = ?entry.header,
                    basis = ?entry.basis,
                    is_chain_prefix,
                    "selected bundle patch"
                );
                args.patches.push(resolved);
            }
            // The last applied patch pins the expected output; a patch without
            // its own outputChecks ends the full chain, whose result is the
            // bundle's output.checks.
            if let Some(last) = selected.last() {
                let last_entry = &bundle.patches[*last];
                // An entry's outputChecks describe the state after applying the
                // chain UP TO it - every earlier patch included. `selected` is
                // ascending, so the selection is that prefix exactly when its
                // length reaches the entry's position.
                let is_chain_prefix = selected.len() == *last + 1;
                let (label, entry_checks) = match &last_entry.output_checks {
                    Some(entry_checks) if is_chain_prefix => (
                        format!("bundle patches[{last}].outputChecks"),
                        Some(entry_checks),
                    ),
                    // Skipping an earlier optional produces a different,
                    // legitimate result the recorded hash does not describe.
                    Some(_) => {
                        debug!(
                            entry = *last,
                            selected = selected.len(),
                            "bundle outputChecks skipped: selection is not the chain prefix ending at this patch"
                        );
                        (String::new(), None)
                    }
                    // output.checks describes the FULL chain: it only gates
                    // when every bundle patch is selected - a partial
                    // selection that happens to end on the final entry (some
                    // optionals skipped) produces a different, legitimate
                    // result.
                    None if selected.len() == bundle.patches.len() => (
                        "bundle output.checks".to_string(),
                        bundle
                            .output
                            .as_ref()
                            .and_then(|output| output.checks.as_ref()),
                    ),
                    // A partial chain without a declared endpoint has no
                    // recorded result to verify against.
                    None => (String::new(), None),
                };
                if let Some(entry_checks) = entry_checks {
                    output_checks = Some((
                        label,
                        FilenameRequirements {
                            checksums: entry_checks.checksums.clone(),
                            size: entry_checks.size,
                        },
                    ));
                }
            }
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
            checks,
            output_checks,
            step_verifications,
        }))
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
    #[expect(clippy::too_many_arguments)]
    fn resolve_bundle_apply_entry(
        &self,
        url: Option<&str>,
        path: Option<&str>,
        loaded: &LoadedBundleSource,
        archive_source: &Path,
        bundle_dir: &Path,
        bundle_base_url: Option<&str>,
        extract_root: &mut Option<PathBuf>,
        context: &OperationContext,
        entry_label: &str,
    ) -> Result<Option<PathBuf>> {
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

fn parent_dir(path: &Path) -> PathBuf {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn bundle_ref_as_url(path: &Path) -> Option<&str> {
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
