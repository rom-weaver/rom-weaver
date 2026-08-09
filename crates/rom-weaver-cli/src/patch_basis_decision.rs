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
    /// no source checksum. `None` means no rule fired and the caller should keep
    /// its own default.
    ///
    /// The returned note goes in the operation report. This decision changes
    /// output bytes on evidence rather than proof, so it must never be silent.
    pub(super) fn structural_strip_decision(
        &self,
        input: &Path,
        patch: &Path,
        header: KnownRomHeaderMatch,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(bool, String)> {
        let (basis, reason) =
            self.structural_basis_decision(input, patch, header, context, temp_paths)?;
        Some((
            basis == PatchBasis::Headerless,
            format!(
                "patch header basis inferred as {} ({reason})",
                basis.label()
            ),
        ))
    }

    fn structural_basis_decision(
        &self,
        input: &Path,
        patch: &Path,
        header: KnownRomHeaderMatch,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(PatchBasis, String)> {
        let header_len = header.stripped_bytes()?;
        // Only copier padding supports the header-write rule. Format headers
        // (iNES and friends) are ROM data an author may legitimately edit, and
        // so is an NSRT-signed SNES copier header - it holds real dump metadata,
        // which is why the output policy keeps it. Treating either as padding
        // would read a legitimate edit as proof of a headerless basis.
        let header_is_copier_junk = !header.header.retained_on_output()
            && !Self::header_bytes_have_nsrt_metadata(input, header_len);
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
            return Some((basis, decision.reason().to_string()));
        }
        trace!(
            patch = %patch.display(),
            reason = decision.reason(),
            "auto header: record geometry inconclusive; trying the ROM-header tiebreaker"
        );
        self.basis_tiebreak_by_rom_header(input, patch, header_len as u64, context, temp_paths)
    }

    /// Whether the input's own header bytes carry NSRT dump metadata. Read from
    /// the file rather than inferred from the header kind, because the NSRT
    /// signature is what separates a real metadata header from copier padding
    /// of the same kind and size. Unreadable bytes count as no metadata, which
    /// leaves the caller on the kind-level answer.
    fn header_bytes_have_nsrt_metadata(input: &Path, header_len: usize) -> bool {
        let Ok(mut file) = File::open(input) else {
            return false;
        };
        let mut header = vec![0_u8; header_len];
        if file.read_exact(&mut header).is_err() {
            return false;
        }
        header_has_nsrt_metadata(&header)
    }

    /// Apply the patch both ways and keep the basis whose output still looks
    /// like the console ROM the input was.
    ///
    /// A patch applied against the wrong bytes writes every record at the wrong
    /// place, which usually lands on the internal ROM header and breaks the
    /// structure the platform's own routine looks for. The comparison is
    /// against the *input's* recognised platforms, so a ROM that never had a
    /// valid checksum still works as its own baseline.
    ///
    /// Every side of the comparison - baseline and both candidates - is scored
    /// as headerless bytes of the same length. The platform routines pick their
    /// header offset from the file length (SNES reads a copier header only when
    /// `len % 1024 == 512`), so scoring a headered output against a headerless
    /// one compares file shapes rather than patch correctness.
    fn basis_tiebreak_by_rom_header(
        &self,
        input: &Path,
        patch: &Path,
        header_len: u64,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(PatchBasis, String)> {
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

        let headerless_input = basis_temp_path(context, "basis-headerless", temp_paths);
        probe_step(
            "strip header",
            Self::strip_header_to_temp(input, &headerless_input),
        )?;

        // The baseline is the headerless input, matching the shape both
        // candidates are scored in.
        let scratch = basis_temp_path(context, "basis-scratch", temp_paths);
        let baseline = probe_step(
            "validate input checksums",
            Self::validate_checksum_file(&headerless_input, Some(input), &scratch),
        )?;
        let baseline_profiles = matched_profiles(&baseline);
        if baseline_profiles.is_empty() {
            trace!(
                input = %input.display(),
                "auto header: no platform recognises the input; tiebreaker has no baseline"
            );
            return None;
        }

        let (raw_score, raw_len) = Self::score_basis_apply(
            BasisApplyScore {
                handler: handler.as_ref(),
                patch,
                apply_input: input,
                hint: input,
                baseline: &baseline_profiles,
                label: PatchBasis::Raw.label(),
                strip_bytes: header_len,
            },
            context,
            temp_paths,
        )?;
        let (headerless_score, headerless_len) = Self::score_basis_apply(
            BasisApplyScore {
                handler: handler.as_ref(),
                patch,
                apply_input: &headerless_input,
                hint: input,
                baseline: &baseline_profiles,
                label: PatchBasis::Headerless.label(),
                strip_bytes: 0,
            },
            context,
            temp_paths,
        )?;

        // Different lengths mean the platform routines saw different files, not
        // differently-patched ones. Nothing comparable survives that.
        if raw_len != headerless_len {
            debug!(
                patch = %patch.display(),
                raw_len,
                headerless_len,
                "auto header: candidate outputs differ in length; not comparable, keeping the header"
            );
            return None;
        }

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
        Some((
            chosen,
            "applying it the other way breaks the internal ROM header".to_string(),
        ))
    }

    /// Apply `patch` to one candidate and score how well the result still
    /// matches the platforms the unpatched input matched. Returns the score and
    /// the length of the bytes it scored, which the caller uses to confirm both
    /// candidates were comparable.
    fn score_basis_apply(
        inputs: BasisApplyScore<'_>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(BasisScore, u64)> {
        let BasisApplyScore {
            handler,
            patch,
            apply_input,
            hint,
            baseline,
            label,
            strip_bytes,
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
        // Score every candidate as headerless bytes so the platform routines
        // read the same file shape for each.
        let scored = if strip_bytes > 0 {
            let normalized =
                basis_temp_path(context, &format!("basis-{label}-normalized"), temp_paths);
            probe_step(
                "normalize output",
                copy_without_prefix(&output, &normalized, strip_bytes),
            )?;
            normalized
        } else {
            output
        };
        let scored_len = probe_step("stat scored output", fs::metadata(&scored))?.len();

        let scratch = basis_temp_path(context, &format!("basis-{label}-scratch"), temp_paths);
        let outcome = probe_step(
            "validate applied output",
            Self::validate_checksum_file(&scored, Some(hint), &scratch),
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
            scored_len,
            "auto header: scored a speculative apply"
        );
        Some((score, scored_len))
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
    /// Bytes to drop off the front of this candidate's output before scoring,
    /// so both candidates are read as headerless bytes.
    strip_bytes: u64,
}

/// Copy `source` minus its first `skip` bytes into `destination`.
fn copy_without_prefix(source: &Path, destination: &Path, skip: u64) -> Result<u64> {
    let mut reader = BufReader::new(File::open(source)?);
    reader.seek(SeekFrom::Start(skip))?;
    let mut writer = BufWriter::new(File::create(destination)?);
    let copied = std::io::copy(&mut reader, &mut writer)?;
    writer.flush()?;
    Ok(copied)
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
