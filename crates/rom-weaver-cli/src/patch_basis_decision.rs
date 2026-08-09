//! Choosing which bytes a patch applies to.
//!
//! `--patch-header auto` decides on checksum proof wherever the patch offers
//! any: [`CliApp::checksum_basis_proof`] compares every whole-file check the
//! patch embeds - under whatever algorithm it uses (BPS/UPS/PMSR crc32, RUP and
//! Solid md5) - plus anything the user, bundle or filename declared, against
//! the raw and the headerless bytes. IPS embeds nothing, and before this path
//! the ambiguity ended the decision - the header was kept, which is wrong
//! whenever the author worked from headerless bytes.
//!
//! Two fallbacks run in order, both reached only after checksum proof turns out
//! to be unavailable:
//!
//! 1. [`CliApp::structural_basis_decision`] scores record geometry
//!    (`rom_weaver_patches::basis_probe`). No apply, no hashing. The probe is
//!    IPS-only, so every other format falls straight through to the tiebreak.
//! 2. [`CliApp::basis_tiebreak_by_rom_header`] applies the patch each way. A
//!    format that verifies its own bytes (APS GBA's exact source size and
//!    per-block source CRC16s, VCDIFF's per-window target checksum) rejects the
//!    basis it was not authored against, which decides outright; when both
//!    candidates apply, the tiebreak asks which output still parses as the
//!    console ROM the input was. A wrongly based patch scatters records across
//!    the internal ROM header and the platform stops recognising its own ROM.
//!
//! Nothing here guesses. When every rule is unconvinced the caller keeps its
//! existing conservative behaviour.

use super::*;

use std::cmp::Ordering;

use rom_weaver_core::{NoopProgressSink, PatchHandler};
use rom_weaver_patches::basis_probe::{PatchBasis, decide_basis, probe_patch_basis};

/// What whole-file checksum proof says about the apply basis.
pub(super) enum ChecksumBasisProof {
    /// A required checksum matched one candidate outright.
    Proved(PatchBasis),
    /// Comparable checksums exist but prove nothing: they matched neither
    /// candidate, or the bytes could not be hashed. Structural evidence must
    /// not paper over contradicted proof, so the caller keeps the header.
    Unproven,
    /// Nothing comparable was offered. Structural evidence may still speak.
    NoEvidence,
}

/// Input size above which the tiebreaker's two speculative applies stop being
/// worth their wall-clock. Plain IPS cannot address past 16 MiB at all; this
/// only bounds a pathological IPS32.
const MAX_TIEBREAK_INPUT_BYTES: u64 = 64 * 1024 * 1024;

impl CliApp {
    /// Compare every whole-file checksum required of the apply input against
    /// the raw and the headerless bytes.
    ///
    /// Requirements come from two places, declared first: what the user, a
    /// bundle or the patch filename asked for, then what the patch itself
    /// embeds (`details.patch.endpoints`, normalized by every handler that has
    /// whole-file checks to report). Any algorithm counts - RUP and Solid pin
    /// an md5, PMSR a crc32 - so hashing follows the patch rather than a
    /// hardcoded crc32.
    ///
    /// A size with no checksum beside it is never proof: two ROMs of the same
    /// length are not the same ROM, and `compare_states` already refuses to
    /// call that a match.
    pub(super) fn checksum_basis_proof(
        &self,
        input: &Path,
        patch: Option<&Path>,
        header_len: u64,
        expected_input_checksums: &BTreeMap<String, String>,
        cached_input_checksums: &BTreeMap<String, String>,
        context: &OperationContext,
    ) -> ChecksumBasisProof {
        // A declared check is the user's own statement about the input and
        // outranks whatever the patch embeds; the patch's endpoints speak only
        // when nothing was declared.
        let declared = patch_plan::PlanState {
            checksums: expected_input_checksums.clone(),
            size: None,
        };
        let required = if declared.has_checksum_evidence() {
            vec![declared]
        } else {
            self.embedded_input_states(patch, context)
        };
        let algorithms = hashable_algorithms(&required);
        if algorithms.is_empty() {
            trace!(
                input = %input.display(),
                candidates = required.len(),
                "auto header: nothing pins a whole-file checksum of the apply input"
            );
            return ChecksumBasisProof::NoEvidence;
        }

        let Some(raw) = Self::basis_state(input, 0, &algorithms, cached_input_checksums, context)
        else {
            return ChecksumBasisProof::Unproven;
        };
        if let Some(matched) = first_matching_state(&required, &raw) {
            trace!(
                ?matched,
                ?algorithms,
                "auto header: a required checksum matches the raw bytes"
            );
            return ChecksumBasisProof::Proved(PatchBasis::Raw);
        }
        if header_len == 0 {
            trace!("auto header: no header to strip, so the headerless candidate does not exist");
            return ChecksumBasisProof::Unproven;
        }
        let Some(headerless) =
            Self::basis_state(input, header_len, &algorithms, &BTreeMap::new(), context)
        else {
            return ChecksumBasisProof::Unproven;
        };
        if let Some(matched) = first_matching_state(&required, &headerless) {
            trace!(
                ?matched,
                ?algorithms,
                "auto header: a required checksum matches the headerless bytes"
            );
            return ChecksumBasisProof::Proved(PatchBasis::Headerless);
        }
        trace!(
            input = %input.display(),
            ?algorithms,
            candidates = required.len(),
            "auto header: required checksums match neither the raw nor the headerless bytes"
        );
        ChecksumBasisProof::Unproven
    }

    /// Every whole-file input expectation the patch itself carries, one entry
    /// per endpoint variant (RUP carries one per file variant per direction).
    /// An unreadable or unclaimed patch contributes nothing, with a reason.
    fn embedded_input_states(
        &self,
        patch: Option<&Path>,
        context: &OperationContext,
    ) -> Vec<patch_plan::PlanState> {
        let Some(patch) = patch else {
            return Vec::new();
        };
        let Some(handler) = self.patches.probe(patch) else {
            trace!(
                patch = %patch.display(),
                "auto header: no handler claims the patch; it embeds no readable checks"
            );
            return Vec::new();
        };
        let report = match handler.describe_metadata(patch, context) {
            Ok(report) => report,
            Err(error) => {
                trace!(
                    %error,
                    patch = %patch.display(),
                    "auto header: patch metadata unavailable; no embedded checks to compare"
                );
                return Vec::new();
            }
        };
        patch_plan::parse_endpoint_variants(report.details.as_ref())
            .into_iter()
            .map(|variant| variant.input)
            .filter(patch_plan::PlanState::has_checksum_evidence)
            .collect()
    }

    /// Hash one candidate basis: the whole file, or everything past `skip`
    /// bytes of copier header. `seeded` supplies checksums the host already
    /// computed for these exact bytes, so the raw candidate usually costs no
    /// read at all.
    fn basis_state(
        input: &Path,
        skip: u64,
        algorithms: &[String],
        seeded: &BTreeMap<String, String>,
        context: &OperationContext,
    ) -> Option<patch_plan::PlanState> {
        let input_len = probe_step("stat input", fs::metadata(input))?.len();
        let mut checksums = BTreeMap::new();
        let mut missing = Vec::new();
        for algorithm in algorithms {
            match seeded.get(algorithm) {
                Some(value) => {
                    checksums.insert(algorithm.clone(), value.to_ascii_lowercase());
                }
                None => missing.push(algorithm.clone()),
            }
        }
        if !missing.is_empty() {
            let mut reader = BufReader::new(probe_step("open input", File::open(input))?);
            if skip > 0 {
                probe_step("seek past the header", reader.seek(SeekFrom::Start(skip)))?;
            }
            let values = probe_step(
                "hash a candidate basis",
                checksum_reader_values_with_progress(&mut reader, &missing, context, &mut |_| {}),
            )?;
            checksums.extend(values.values);
        }
        Some(patch_plan::PlanState {
            checksums,
            size: Some(input_len.saturating_sub(skip)),
        })
    }

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
        // No geometry to score is not a reason to give up: the probe reads IPS
        // records only, and the tiebreak below is format-agnostic. Geometry
        // still wins outright when it has something to say.
        let probe = match probe_patch_basis(patch, input, header_len as u64, header_is_copier_junk)
        {
            Ok(Some(probe)) => Some(probe),
            Ok(None) => {
                trace!(
                    patch = %patch.display(),
                    "auto header: patch carries no probeable record geometry; trying the ROM-header tiebreaker"
                );
                None
            }
            Err(error) => {
                trace!(
                    %error,
                    patch = %patch.display(),
                    "auto header: basis probe failed; trying the ROM-header tiebreaker"
                );
                None
            }
        };

        if let Some(probe) = probe {
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
        }
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

    /// Apply the patch both ways and keep the basis the patch itself accepts,
    /// or failing that the one whose output still looks like the console ROM
    /// the input was.
    ///
    /// A format that verifies its own bytes rejects the basis it was not
    /// authored against - APS GBA demands an exact source size and per-block
    /// source CRC16s, VCDIFF checks the target window it decoded - so a
    /// candidate the format refuses is ruled out by the format itself. That
    /// check runs first because it is proof rather than inference.
    ///
    /// Otherwise: a patch applied against the wrong bytes writes every record
    /// at the wrong place, which usually lands on the internal ROM header and
    /// breaks the structure the platform's own routine looks for. The
    /// comparison is against the *input's* recognised platforms, so a ROM that
    /// never had a valid checksum still works as its own baseline.
    ///
    /// Every side of that comparison - baseline and both candidates - is scored
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

        let raw_apply = Self::apply_basis_candidate(
            handler.as_ref(),
            patch,
            input,
            PatchBasis::Raw,
            context,
            temp_paths,
        )?;
        let headerless_apply = Self::apply_basis_candidate(
            handler.as_ref(),
            patch,
            &headerless_input,
            PatchBasis::Headerless,
            context,
            temp_paths,
        )?;
        let (raw_output, headerless_output) = match (raw_apply, headerless_apply) {
            (BasisApply::Applied(raw), BasisApply::Applied(headerless)) => (raw, headerless),
            (BasisApply::Applied(_), BasisApply::Rejected) => {
                debug!(
                    patch = %patch.display(),
                    "auto header: the patch format rejects the headerless bytes; the basis is raw"
                );
                return Some((
                    PatchBasis::Raw,
                    "the patch format rejects the headerless bytes".to_string(),
                ));
            }
            (BasisApply::Rejected, BasisApply::Applied(_)) => {
                debug!(
                    patch = %patch.display(),
                    "auto header: the patch format rejects the raw bytes; the basis is headerless"
                );
                return Some((
                    PatchBasis::Headerless,
                    "the patch format rejects the raw (headered) bytes".to_string(),
                ));
            }
            (BasisApply::Rejected, BasisApply::Rejected) => {
                debug!(
                    patch = %patch.display(),
                    "auto header: the patch format rejects both candidates; keeping the header"
                );
                return None;
            }
        };

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

        let (raw_score, raw_len) = Self::score_basis_output(
            BasisOutputScore {
                output: &raw_output,
                hint: input,
                baseline: &baseline_profiles,
                label: PatchBasis::Raw.label(),
                strip_bytes: header_len,
            },
            context,
            temp_paths,
        )?;
        let (headerless_score, headerless_len) = Self::score_basis_output(
            BasisOutputScore {
                output: &headerless_output,
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

    /// Apply `patch` to one candidate basis, speculatively.
    ///
    /// `None` aborts the whole tiebreak: the apply failed for a reason that
    /// says nothing about the bytes (cancellation, an I/O fault), and reading
    /// that as "this basis is wrong" would decide on noise. Only the format's
    /// own rejection of the input counts as evidence.
    fn apply_basis_candidate(
        handler: &dyn PatchHandler,
        patch: &Path,
        apply_input: &Path,
        basis: PatchBasis,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<BasisApply> {
        let label = basis.label();
        let output = basis_temp_path(context, &format!("basis-{label}-output"), temp_paths);
        let request = PatchApplyRequest {
            input: apply_input.to_path_buf(),
            patches: vec![patch.to_path_buf()],
            output: output.clone(),
        };
        // The format's own source and target checks stay ON: they are what
        // separates the two candidates. A source check reads the bytes the
        // patch was authored against (APS GBA's exact source size and per-block
        // CRC16s, PPF's file id); a target check catches the same mistake from
        // the other end, because a patch decoded against the wrong source
        // cannot reproduce the output it promised (VCDIFF's per-window
        // checksum). Whichever candidate fails one was not the author's.
        //
        // The patch file's own integrity checksum stays off: it is the same
        // number for both candidates, so it can only fail both. So does
        // progress - this is a probe, not the user's operation.
        let probe_context = context
            .clone()
            .with_progress_sink(Arc::new(NoopProgressSink))
            .with_patch_check_scopes(PatchCheckScopes {
                patch_integrity: false,
                source: true,
                target: true,
            });
        match handler.apply(&request, &probe_context) {
            Ok(_) => Some(BasisApply::Applied(output)),
            Err(error)
                if matches!(
                    error,
                    RomWeaverError::Validation(_) | RomWeaverError::ValidationCode(_)
                ) =>
            {
                debug!(
                    %error,
                    basis = label,
                    "auto header: the patch format rejected this candidate basis"
                );
                Some(BasisApply::Rejected)
            }
            Err(error) => {
                trace!(
                    %error,
                    basis = label,
                    "auto header: speculative apply failed for a reason unrelated to the bytes"
                );
                None
            }
        }
    }

    /// Score how well one candidate's applied output still matches the
    /// platforms the unpatched input matched. Returns the score and the length
    /// of the bytes it scored, which the caller uses to confirm both candidates
    /// were comparable.
    fn score_basis_output(
        inputs: BasisOutputScore<'_>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(BasisScore, u64)> {
        let BasisOutputScore {
            output,
            hint,
            baseline,
            label,
            strip_bytes,
        } = inputs;
        let output = output.to_path_buf();
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

/// How one candidate basis fared when the patch was applied to it.
enum BasisApply {
    /// The format accepted these bytes; its output is at this path.
    Applied(PathBuf),
    /// The format refused these bytes. One-sided evidence: a patch that cannot
    /// be applied to a candidate was not authored against it.
    Rejected,
}

/// Everything scoring one applied candidate needs. Grouped so the call sites
/// read as named fields rather than five positional values.
struct BasisOutputScore<'a> {
    output: &'a Path,
    hint: &'a Path,
    baseline: &'a [&'static str],
    label: &'static str,
    /// Bytes to drop off the front of this candidate's output before scoring,
    /// so both candidates are read as headerless bytes.
    strip_bytes: u64,
}

/// The checksum algorithms worth hashing for `required`: every algorithm some
/// candidate pins, minus any the engine cannot compute. Order is stable so the
/// trace output reads the same across runs.
fn hashable_algorithms(required: &[patch_plan::PlanState]) -> Vec<String> {
    let mut algorithms: Vec<String> = Vec::new();
    for state in required {
        for algorithm in state.checksums.keys() {
            if !supported_algorithms().contains(&algorithm.as_str()) {
                trace!(
                    algorithm,
                    "auto header: a required check names a checksum the engine cannot compute"
                );
                continue;
            }
            if !algorithms.iter().any(|existing| existing == algorithm) {
                algorithms.push(algorithm.clone());
            }
        }
    }
    algorithms
}

/// The first required state that matches `candidate` outright.
///
/// `compare_states` needs a shared checksum algorithm before it calls anything
/// a match, so a size-only endpoint (APS GBA, DPS) can never prove a basis
/// here: two ROMs of one length are not one ROM.
fn first_matching_state<'a>(
    required: &'a [patch_plan::PlanState],
    candidate: &patch_plan::PlanState,
) -> Option<&'a patch_plan::PlanState> {
    required.iter().find(|state| {
        patch_plan::compare_states(state, candidate) == patch_plan::EvidenceMatch::Match
    })
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
            trace!(%error, step, "auto header: basis probe gave up");
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

#[cfg(test)]
#[path = "../tests/unit/patch_basis_decision.rs"]
mod tests;
