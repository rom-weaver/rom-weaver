//! Choosing which N64 byte order a checksumless patch was authored against.
//!
//! `--n64-byte-order auto` normally decides on checksum proof: BPS, UPS and RUP
//! embed a source CRC32, so the CLI hashes all three interleavings of the input
//! and takes the match. IPS embeds nothing, and before this path the ambiguity
//! ended the decision - the ROM was left in the order it arrived in, which is
//! wrong whenever the author worked from a different one. Every change then
//! lands scrambled inside its own 4-byte word.
//!
//! Two fallbacks run in order, both reached only after checksum proof turns out
//! to be unavailable:
//!
//! 1. [`CliApp::structural_n64_order_decision`] scores record structure
//!    (`rom_weaver_patches::n64_order_probe`). No apply, no hashing.
//! 2. [`CliApp::n64_order_tiebreak_by_internal_checksum`] applies the patch in
//!    all three orders and asks which result leaves the ROM's own boot checksum
//!    correct. Only the order the author used can, because the checksum covers a
//!    megabyte of boot code that every other order scrambles.
//!
//! Neither fallback guesses. When both are unconvinced the caller keeps the
//! order the input already has, and a decision that came from evidence rather
//! than proof is always reported in the operation label.

use super::*;

use rom_weaver_core::{NoopProgressSink, PatchHandler};
use rom_weaver_patches::n64_order_probe::{
    N64_ORDER_CANDIDATES, N64OrderCandidate, decide_n64_order, probe_n64_order,
};

use super::patch_basis_decision::{basis_temp_path, probe_step};

/// Every N64 byte order, in the order the probe scores them. The probe reports a
/// candidate index into this array.
const N64_ORDERS: [N64ByteOrder; N64_ORDER_CANDIDATES] = [
    N64ByteOrder::BigEndian,
    N64ByteOrder::LittleEndian,
    N64ByteOrder::ByteSwapped,
];

/// Input size above which the tiebreaker's three speculative applies stop being
/// worth their wall-clock. Retail N64 ROMs run to 64 MiB, and plain IPS cannot
/// address past 16 MiB of one anyway.
const MAX_N64_TIEBREAK_INPUT_BYTES: u64 = 64 * 1024 * 1024;

/// Shortest file [`CliApp::repair_n64_checksum_file`] will look at: the boot
/// checksum covers 0x1000..0x101000, so a shorter ROM has none and every
/// candidate would score alike.
const N64_CHECKSUM_MIN_BYTES: u64 = 0x101000;

/// The profile name the checksum-repair pass reports N64 results under.
const N64_PROFILE: &str = "n64";

impl CliApp {
    /// Decide which byte order to put the input in for a patch that carries no
    /// source checksum. `None` means no rule fired and the caller should keep the
    /// order the input already has.
    ///
    /// The returned reason goes in the operation report. This decision changes
    /// output bytes on evidence rather than proof, so it must never be silent.
    pub(super) fn structural_n64_order_decision(
        &self,
        input: &Path,
        patch: &Path,
        source: N64ByteOrder,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(N64ByteOrder, String)> {
        let probe = match probe_n64_order(patch, input, Self::n64_order_candidates(source)) {
            Ok(Some(probe)) => probe,
            Ok(None) => {
                trace!(
                    patch = %patch.display(),
                    "auto n64: patch carries no probeable record structure"
                );
                return None;
            }
            Err(error) => {
                trace!(%error, patch = %patch.display(), "auto n64: order probe failed");
                return None;
            }
        };

        let decision = decide_n64_order(&probe);
        if let Some(candidate) = decision.candidate() {
            let target = N64_ORDERS[candidate];
            debug!(
                patch = %patch.display(),
                order = target.id(),
                reason = decision.reason(),
                "auto n64: record structure chose the byte order"
            );
            return Some((target, decision.reason().to_string()));
        }
        trace!(
            patch = %patch.display(),
            reason = decision.reason(),
            "auto n64: record structure inconclusive; trying the internal-checksum tiebreaker"
        );
        self.n64_order_tiebreak_by_internal_checksum(
            N64TiebreakInputs {
                input,
                patch,
                source,
                stored_checksum_writes: probe.stored_checksum_writes,
            },
            context,
            temp_paths,
        )
    }

    /// Describe each byte order the way the probe needs it: where every byte of a
    /// candidate word comes from in the input's own word, plus the magic a valid
    /// ROM carries in that order.
    fn n64_order_candidates(source: N64ByteOrder) -> [N64OrderCandidate; N64_ORDER_CANDIDATES] {
        N64_ORDERS.map(|target| N64OrderCandidate {
            label: target.label(),
            word_map: Self::n64_candidate_word_map(source, target),
            magic: n64_magic(target),
        })
    }

    /// Where each byte of a `target`-order word comes from in the same word of a
    /// `source`-order file.
    ///
    /// Derived by running the real rewrite's two transforms over a word of
    /// position tags, so the map cannot drift from
    /// [`Self::rewrite_n64_byte_order`]. Reading the input through it is what
    /// lets the probe score all three candidates without writing three converted
    /// copies of a 64 MiB ROM.
    fn n64_candidate_word_map(source: N64ByteOrder, target: N64ByteOrder) -> [usize; 4] {
        let mut tags = [0_u8, 1, 2, 3];
        Self::transform_n64_word(&mut tags, source);
        Self::transform_n64_word(&mut tags, target);
        tags.map(usize::from)
    }

    /// Apply the patch in all three orders and keep the one whose result leaves
    /// the ROM's internal boot checksum correct.
    ///
    /// The N64 boot checksum covers 0x1000..0x101000, a megabyte of code that a
    /// wrongly-ordered apply scrambles inside every word it touches. So at most
    /// one order can leave a correct checksum behind, and when none does - the
    /// patch never fixed it, or the input is not the author's base - nothing is
    /// decided.
    ///
    /// Every candidate is scored in its own order rather than converted back
    /// first. The checksum routine normalizes to big-endian words before hashing
    /// and reads the stored value the same way, so its verdict is the same on
    /// either side of a byte-order rewrite; the extra rewrite would only copy the
    /// file again.
    fn n64_order_tiebreak_by_internal_checksum(
        &self,
        inputs: N64TiebreakInputs<'_>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(N64ByteOrder, String)> {
        let N64TiebreakInputs {
            input,
            patch,
            source,
            stored_checksum_writes,
        } = inputs;
        // Without a record over the stored checksum every candidate keeps
        // whatever the input carried, so three applies could not separate them.
        if stored_checksum_writes == 0 {
            trace!(
                patch = %patch.display(),
                "auto n64: the patch leaves the stored boot checksum alone; the tiebreaker cannot separate the orders"
            );
            return None;
        }
        let input_len = probe_step("stat input", fs::metadata(input))?.len();
        if input_len < N64_CHECKSUM_MIN_BYTES {
            trace!(
                input = %input.display(),
                input_len,
                minimum = N64_CHECKSUM_MIN_BYTES,
                "auto n64: input is too short to carry a boot checksum"
            );
            return None;
        }
        if input_len > MAX_N64_TIEBREAK_INPUT_BYTES {
            debug!(
                input = %input.display(),
                input_len,
                limit = MAX_N64_TIEBREAK_INPUT_BYTES,
                "auto n64: input too large for the internal-checksum tiebreaker; keeping the current order"
            );
            return None;
        }
        let Some(handler) = self.patches.probe(patch) else {
            trace!(
                patch = %patch.display(),
                "auto n64: no handler claims the patch; the tiebreaker cannot apply it"
            );
            return None;
        };

        let mut valid = Vec::new();
        let mut scored_len: Option<u64> = None;
        for target in N64_ORDERS {
            let (checksum_valid, output_len) = Self::score_n64_order_apply(
                N64OrderApplyScore {
                    handler: handler.as_ref(),
                    patch,
                    input,
                    source,
                    target,
                },
                context,
                temp_paths,
            )?;
            // Byte order changes no length, so all three outputs must come out
            // the same size. Different sizes mean the applies were not the same
            // comparison and nothing survives that.
            match scored_len {
                None => scored_len = Some(output_len),
                Some(previous) if previous != output_len => {
                    debug!(
                        patch = %patch.display(),
                        previous,
                        output_len,
                        "auto n64: candidate outputs differ in length; not comparable, keeping the current order"
                    );
                    return None;
                }
                Some(_) => {}
            }
            if checksum_valid {
                valid.push(target);
            }
        }

        let [chosen] = valid.as_slice() else {
            debug!(
                patch = %patch.display(),
                valid = valid.len(),
                "auto n64: the internal checksum does not single out one order; keeping the current order"
            );
            return None;
        };
        debug!(
            patch = %patch.display(),
            order = chosen.id(),
            "auto n64: internal-checksum tiebreaker chose the byte order"
        );
        Some((
            *chosen,
            "applying it in any other order leaves the ROM's own boot checksum wrong".to_string(),
        ))
    }

    /// Apply `patch` to one candidate order and report whether the result still
    /// carries a correct internal N64 checksum, plus the length it scored, which
    /// the caller uses to confirm all three candidates were comparable.
    fn score_n64_order_apply(
        inputs: N64OrderApplyScore<'_>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Option<(bool, u64)> {
        let N64OrderApplyScore {
            handler,
            patch,
            input,
            source,
            target,
        } = inputs;
        let label = target.id();
        // Only a candidate that differs from the input's own order needs a
        // converted copy; the input itself is the caller's file and is never
        // written to or discarded here.
        let rewritten = (target != source)
            .then(|| basis_temp_path(context, &format!("n64-{label}-input"), temp_paths));
        if let Some(rewritten) = rewritten.as_ref() {
            probe_step(
                "rewrite input byte order",
                Self::rewrite_n64_byte_order(input, rewritten, source, target),
            )?;
        }
        let output = basis_temp_path(context, &format!("n64-{label}-output"), temp_paths);
        let request = PatchApplyRequest {
            input: rewritten.clone().unwrap_or_else(|| input.to_path_buf()),
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
        let applied = handler.apply(&request, &probe_context);
        // Three candidates over a ROM that can reach 64 MiB: free each one's
        // copies as soon as they are read, so the probe holds one candidate's
        // worth of scratch rather than all three.
        if let Some(rewritten) = rewritten.as_ref() {
            discard_probe_file(rewritten);
        }
        if let Err(error) = applied {
            trace!(%error, order = label, "auto n64: speculative apply failed");
            return None;
        }
        let output_len = probe_step("stat candidate output", fs::metadata(&output))?.len();

        let scratch = basis_temp_path(context, &format!("n64-{label}-scratch"), temp_paths);
        let outcome = Self::validate_checksum_file(&output, Some(input), &scratch);
        discard_probe_file(&output);
        discard_probe_file(&scratch);
        let outcome = probe_step("validate candidate output", outcome)?;
        let checksum_valid = outcome.matched_without_changes.contains(&N64_PROFILE);
        trace!(
            order = label,
            checksum_valid, output_len, "auto n64: scored a speculative apply"
        );
        Some((checksum_valid, output_len))
    }
}

/// Delete a probe's scratch file now that it has been read. The path stays
/// registered for the caller's final sweep, which tolerates a missing file.
fn discard_probe_file(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        trace!(
            %error,
            path = %path.display(),
            "auto n64: could not free a probe scratch file; leaving it for the final cleanup"
        );
    }
}

/// Everything the internal-checksum tiebreaker needs.
struct N64TiebreakInputs<'a> {
    input: &'a Path,
    patch: &'a Path,
    /// The order the input is already in.
    source: N64ByteOrder,
    /// Records writing the stored boot checksum, from the structural probe.
    stored_checksum_writes: usize,
}

/// Everything one speculative apply needs.
struct N64OrderApplyScore<'a> {
    handler: &'a dyn PatchHandler,
    patch: &'a Path,
    input: &'a Path,
    source: N64ByteOrder,
    target: N64ByteOrder,
}

/// The four bytes a valid N64 ROM starts with in `order`.
const fn n64_magic(order: N64ByteOrder) -> [u8; 4] {
    match order {
        N64ByteOrder::BigEndian => N64_BIG_ENDIAN_MAGIC,
        N64ByteOrder::LittleEndian => N64_LITTLE_ENDIAN_MAGIC,
        N64ByteOrder::ByteSwapped => N64_BYTE_SWAPPED_MAGIC,
    }
}

#[cfg(test)]
#[path = "../tests/unit/patch_n64_order_decision.rs"]
mod tests;
