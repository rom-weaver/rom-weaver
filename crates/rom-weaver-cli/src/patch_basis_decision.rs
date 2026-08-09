//! Choosing which bytes a checksumless patch applies to.
//!
//! `--patch-header auto` normally decides on checksum proof: BPS, UPS and RUP
//! embed a source CRC32, so the CLI hashes the raw and headerless bytes and
//! takes the match. IPS embeds nothing, and before this path the ambiguity
//! ended the decision - the header was kept, which is wrong whenever the author
//! worked from headerless bytes.
//!
//! Two fallbacks run in order, both reached only after checksum proof turns out
//! to be unavailable:
//!
//! 1. [`CliApp::structural_basis_decision`] scores record geometry
//!    (`rom_weaver_patches::basis_probe`). No apply, no hashing.
//! 2. [`CliApp::basis_tiebreak_by_rom_header`] applies the patch each way and
//!    asks which output still parses as the console ROM the input was. A
//!    wrongly based patch scatters records across the internal ROM header and
//!    the platform stops recognising its own ROM.
//!
//! Neither fallback guesses. When both are unconvinced the caller keeps its
//! existing conservative behaviour.

use super::*;

use std::cmp::Ordering;

use rom_weaver_core::{NoopProgressSink, PatchHandler};
use rom_weaver_patches::basis_probe::{PatchBasis, decide_basis, probe_patch_basis};

/// Input size above which the tiebreaker's two speculative applies stop being
/// worth their wall-clock. Plain IPS cannot address past 16 MiB at all; this
/// only bounds a pathological IPS32.
const MAX_TIEBREAK_INPUT_BYTES: u64 = 64 * 1024 * 1024;

impl CliApp {
    /// Decide whether to strip the header before applying a patch that carries
    /// no source checksum. `Some(true)` strips, `Some(false)` keeps, and `None`
    /// means no rule fired and the caller should keep its own default.
    pub(super) fn structural_strip_decision(
        &self,
        input: &Path,
        patch: &Path,
        header: KnownRomHeaderMatch,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<bool> {
        let basis = self.structural_basis_decision(input, patch, header, context, temp_paths)?;
        Some(basis == PatchBasis::Headerless)
    }

    fn structural_basis_decision(
        &self,
        input: &Path,
        patch: &Path,
        header: KnownRomHeaderMatch,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<PatchBasis> {
        let header_len = header.stripped_bytes()?;
        // Only copier padding supports the header-write rule. Format headers
        // (iNES and friends) are ROM data an author may legitimately edit.
        let header_is_copier_junk = !header.header.retained_on_output();
        let probe = match probe_patch_basis(patch, input, header_len as u64, header_is_copier_junk)
        {
            Ok(Some(probe)) => probe,
            Ok(None) => {
                trace!(
                    patch = %patch.display(),
                    "auto header: patch carries no probeable record geometry"
                );
                return None;
            }
            Err(error) => {
                trace!(%error, patch = %patch.display(), "auto header: basis probe failed");
                return None;
            }
        };

        let decision = decide_basis(&probe);
        if let Some(basis) = decision.basis() {
            debug!(
                patch = %patch.display(),
                basis = basis.label(),
                reason = decision.reason(),
                "auto header: structural evidence chose the apply basis"
            );
            return Some(basis);
        }
        trace!(
            patch = %patch.display(),
            reason = decision.reason(),
            "auto header: record geometry inconclusive; trying the ROM-header tiebreaker"
        );
        self.basis_tiebreak_by_rom_header(input, patch, context, temp_paths)
    }

    /// Apply the patch both ways and keep the basis whose output still looks
    /// like the console ROM the input was.
    ///
    /// A patch applied against the wrong bytes writes every record at the wrong
    /// place, which usually lands on the internal ROM header and breaks the
    /// structure the platform's own routine looks for. The comparison is
    /// against the *input's* recognised platforms, so a ROM that never had a
    /// valid checksum still works as its own baseline.
    fn basis_tiebreak_by_rom_header(
        &self,
        input: &Path,
        patch: &Path,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<PatchBasis> {
        let input_len = probe_step("stat input", fs::metadata(input))?.len();
        if input_len > MAX_TIEBREAK_INPUT_BYTES {
            debug!(
                input = %input.display(),
                input_len,
                limit = MAX_TIEBREAK_INPUT_BYTES,
                "auto header: input too large for the ROM-header tiebreaker; keeping the header"
            );
            return None;
        }
        let Some(handler) = self.patches.probe(patch) else {
            trace!(
                patch = %patch.display(),
                "auto header: no handler claims the patch; tiebreaker cannot apply it"
            );
            return None;
        };

        let scratch = basis_temp_path(context, "basis-scratch", temp_paths);
        let baseline = probe_step(
            "validate input checksums",
            Self::validate_checksum_file(input, Some(input), &scratch),
        )?;
        let baseline_profiles = matched_profiles(&baseline);
        if baseline_profiles.is_empty() {
            trace!(
                input = %input.display(),
                "auto header: no platform recognises the input; tiebreaker has no baseline"
            );
            return None;
        }

        let headerless_input = basis_temp_path(context, "basis-headerless", temp_paths);
        probe_step(
            "strip header",
            Self::strip_header_to_temp(input, &headerless_input),
        )?;

        let raw_score = Self::score_basis_apply(
            BasisApplyScore {
                handler: handler.as_ref(),
                patch,
                apply_input: input,
                hint: input,
                baseline: &baseline_profiles,
                label: PatchBasis::Raw.label(),
            },
            context,
            temp_paths,
        )?;
        let headerless_score = Self::score_basis_apply(
            BasisApplyScore {
                handler: handler.as_ref(),
                patch,
                apply_input: &headerless_input,
                hint: input,
                baseline: &baseline_profiles,
                label: PatchBasis::Headerless.label(),
            },
            context,
            temp_paths,
        )?;

        let chosen = match raw_score.cmp(&headerless_score) {
            Ordering::Greater => PatchBasis::Raw,
            Ordering::Less => PatchBasis::Headerless,
            Ordering::Equal => {
                debug!(
                    patch = %patch.display(),
                    raw = ?raw_score,
                    headerless = ?headerless_score,
                    "auto header: both bases score alike after applying; keeping the header"
                );
                return None;
            }
        };
        debug!(
            patch = %patch.display(),
            basis = chosen.label(),
            raw = ?raw_score,
            headerless = ?headerless_score,
            "auto header: ROM-header tiebreaker chose the apply basis"
        );
        Some(chosen)
    }

    /// Apply `patch` to one candidate and score how well the result still
    /// matches the platforms the unpatched input matched.
    fn score_basis_apply(
        inputs: BasisApplyScore<'_>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<BasisScore> {
        let BasisApplyScore {
            handler,
            patch,
            apply_input,
            hint,
            baseline,
            label,
        } = inputs;
        let output = basis_temp_path(context, &format!("basis-{label}-output"), temp_paths);
        let request = PatchApplyRequest {
            input: apply_input.to_path_buf(),
            patches: vec![patch.to_path_buf()],
            output: output.clone(),
        };
        // A speculative apply must never fail on an endpoint check or emit
        // progress: it is a probe, not the user's operation.
        let probe_context = context
            .clone()
            .with_progress_sink(Arc::new(NoopProgressSink))
            .with_patch_check_scopes(PatchCheckScopes {
                patch_integrity: false,
                source: false,
                target: false,
            });
        if let Err(error) = handler.apply(&request, &probe_context) {
            trace!(%error, basis = label, "auto header: speculative apply failed");
            return None;
        }
        let scratch = basis_temp_path(context, &format!("basis-{label}-scratch"), temp_paths);
        let outcome = probe_step(
            "validate applied output",
            Self::validate_checksum_file(&output, Some(hint), &scratch),
        )?;
        let matched = matched_profiles(&outcome);
        let score = BasisScore {
            retained: baseline
                .iter()
                .filter(|profile| matched.contains(profile))
                .count(),
            checksum_valid: outcome
                .matched_without_changes
                .iter()
                .filter(|profile| baseline.contains(profile))
                .count(),
        };
        trace!(
            basis = label,
            ?score,
            "auto header: scored a speculative apply"
        );
        Some(score)
    }
}

/// Everything one speculative apply needs. Grouped so the call sites read as
/// named fields rather than six positional paths.
struct BasisApplyScore<'a> {
    handler: &'a dyn PatchHandler,
    patch: &'a Path,
    apply_input: &'a Path,
    hint: &'a Path,
    baseline: &'a [&'static str],
    label: &'static str,
}

/// How well one candidate's output held up. Field order is the comparison
/// order: keeping the platform matters more than the checksum being current,
/// because most ROM hacks never fix the checksum they invalidate.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct BasisScore {
    retained: usize,
    checksum_valid: usize,
}

fn basis_temp_path(
    context: &OperationContext,
    stem: &str,
    temp_paths: &mut Vec<PathBuf>,
) -> PathBuf {
    let path = context
        .temp_paths()
        .next_path(&format!("patch-apply-{stem}"), Some("bin"));
    // The allocator only names a path. The basis decision runs before the apply
    // pipeline has built the temp root, so nothing else has created it yet.
    if let Some(parent) = path.parent()
        && let Err(error) = fs::create_dir_all(parent)
    {
        trace!(
            %error,
            parent = %parent.display(),
            "auto header: could not create the probe temp directory"
        );
    }
    temp_paths.push(path.clone());
    path
}

/// Log why a probe step gave up.
///
/// Every bail in this module means "keep the caller's default", which looks
/// identical to a confident decision from the outside. A silent one is
/// undebuggable, so each gets a reason.
fn probe_step<T, E: std::fmt::Display>(step: &str, result: std::result::Result<T, E>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) => {
            trace!(%error, step, "auto header: basis tiebreaker gave up");
            None
        }
    }
}

/// Every platform that recognised the ROM, whether or not its checksum was
/// already correct.
fn matched_profiles(outcome: &HeaderRepairOutcome) -> Vec<&'static str> {
    let mut profiles = outcome.matched_without_changes.clone();
    profiles.extend(outcome.repaired_profiles.iter().copied());
    profiles.sort_unstable();
    profiles.dedup();
    profiles
}
