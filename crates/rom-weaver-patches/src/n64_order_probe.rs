//! Structural evidence for which N64 byte order an offset-only patch was
//! authored against.
//!
//! N64 dumps circulate in three interleavings - big-endian `.z64`, little-endian
//! `.n64` and byte-swapped `.v64` - and a patch only fits the one its author
//! worked from. BPS, UPS and RUP embed a source CRC32, so hashing each variant
//! answers it exactly. IPS embeds nothing, and applying its records to the wrong
//! interleaving scatters every change inside its own 4-byte word.
//!
//! All three orders are permutations *within* each aligned 4-byte word, so a
//! candidate's byte at any offset is a byte of the same word in the file the
//! user already has. That is why nothing here materializes a converted file: the
//! caller passes each candidate's [`N64OrderCandidate::word_map`] and the probe
//! reads through it.
//!
//! Two rules live here, both one-sided - each can rule a candidate out, neither
//! can vote for one on its own:
//!
//! 1. **Magic.** A record writing into the first four bytes decides the order
//!    outright: the finished ROM has to start with the N64 magic, and each order
//!    spells that magic differently.
//! 2. **Untrimmed edges.** A differ trims unchanged bytes off both ends of every
//!    record, so at the right order a record's edge bytes differ from the bytes
//!    underneath. At a wrong order the edge lands on a different byte of the same
//!    word and matches often enough to show up.
//!
//! Three rules from the copier-header probe ([`crate::basis_probe`])
//! deliberately do not appear:
//!
//! - **Records past the end.** Byte order never changes a file's length, so
//!   every candidate has identical geometry and no candidate can be ruled out.
//! - **Writes inside a copier header.** N64 dumps carry no copier header.
//! - **The internal game title at 0x20.** Tempting and unsound: a permutation
//!   inside a word cannot change which bytes are in that word, so a title
//!   written as printable ASCII stays printable ASCII in all three orders. It
//!   only scrambles the letters, which no rule can measure without knowing the
//!   game.
//!
//! When nothing separates the candidates the probe reports
//! [`N64OrderDecision::Inconclusive`] and the caller keeps the order the input
//! already has. With three candidates rather than two, that is the common
//! outcome and the correct one.

use std::{ops::Range, path::Path};

use rom_weaver_core::Result;
use tracing::{debug, trace};

use crate::{
    ips::{IPS_PROBE_PREFIX_BYTES, IpsProbeRecord, probe_ips_records},
    probe_reader::ProbeReader,
};

/// How many byte orders an N64 dump can be in.
pub const N64_ORDER_CANDIDATES: usize = 3;

/// Records compared for trimmed edges. Every real IPS patch is far under this;
/// the cap only bounds the seek count on a pathological patch. Exceeding it is
/// logged, never silent.
const MAX_COMPARED_RECORDS: usize = 4096;

/// Comparable records a candidate needs before its untrimmed-edge count means
/// anything. Below this a single coincidence would decide the order.
const MIN_RECORDS_FOR_EDGE_RULE: usize = 8;

/// Untrimmed-edge records every losing candidate needs before that rule decides.
/// One coincidental match is ordinary; several is a pattern.
///
/// A wrong order lands the comparison on a different byte of the same word,
/// which matches by chance about as often as an unrelated byte would, so this
/// rule stays silent below a few hundred records. That is the intended reach: it
/// is the weaker of the two rules and the safe outcome of silence is
/// [`N64OrderDecision::Inconclusive`].
const MIN_UNTRIMMED_MARGIN: usize = 2;

/// Where the N64 ROM header stores the two boot checksums (CRC1 and CRC2).
///
/// A patch that leaves these alone cannot be told apart by applying it three
/// ways and checking the result: the stored value would stay whatever the input
/// carried, and every candidate would score the same. Callers use
/// [`N64OrderProbe::stored_checksum_writes`] to skip that work.
pub const N64_STORED_CHECKSUM_RANGE: Range<u64> = 0x10..0x18;

/// One candidate byte order, described only by what the probe needs.
#[derive(Clone, Copy, Debug)]
pub struct N64OrderCandidate {
    /// Name for the decision reason, for example `little-endian`.
    pub label: &'static str,
    /// Byte `i` of a word in this candidate's bytes is byte `word_map[i]` of the
    /// same word in the input the caller passed. The identity map describes the
    /// order the input is already in.
    pub word_map: [usize; 4],
    /// The four bytes a valid N64 ROM starts with in this candidate's order.
    pub magic: [u8; 4],
}

/// What a record writing into the first word says about one candidate.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum N64MagicEvidence {
    /// No record writes any of the first four bytes.
    #[default]
    Unwritten,
    /// The finished first word is the N64 magic in this candidate's order.
    Matches,
    /// The finished first word is not a valid magic in this candidate's order,
    /// so applying the patch this way would not leave an N64 ROM.
    Differs,
}

/// What the records look like when applied to one candidate.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct N64OrderEvidence {
    /// Records lying wholly inside the input, so both edges have a byte to
    /// compare against. Byte order moves no record and changes no length, so
    /// this is the same for every candidate; it is kept per candidate so one
    /// candidate's evidence reads on its own.
    pub comparable_records: usize,
    /// Comparable records whose first or last byte already equals the byte this
    /// candidate would put underneath it. A differ that trims unchanged edges
    /// never emits these.
    pub untrimmed_records: usize,
    pub magic: N64MagicEvidence,
}

/// Every candidate's evidence plus the counts the decision rules need.
#[derive(Clone, Debug)]
pub struct N64OrderProbe {
    pub candidates: [N64OrderCandidate; N64_ORDER_CANDIDATES],
    pub evidence: [N64OrderEvidence; N64_ORDER_CANDIDATES],
    pub records: usize,
    /// Records writing into [`N64_STORED_CHECKSUM_RANGE`].
    pub stored_checksum_writes: usize,
}

/// The chosen order, or why no rule fired.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum N64OrderDecision {
    /// Index into [`N64OrderProbe::candidates`].
    Decided {
        candidate: usize,
        reason: String,
    },
    Inconclusive {
        reason: String,
    },
}

impl N64OrderDecision {
    pub fn candidate(&self) -> Option<usize> {
        match self {
            Self::Decided { candidate, .. } => Some(*candidate),
            Self::Inconclusive { .. } => None,
        }
    }

    pub fn reason(&self) -> &str {
        match self {
            Self::Decided { reason, .. } | Self::Inconclusive { reason } => reason,
        }
    }

    fn decided(candidate: usize, reason: impl Into<String>) -> Self {
        Self::Decided {
            candidate,
            reason: reason.into(),
        }
    }

    fn inconclusive(reason: impl Into<String>) -> Self {
        Self::Inconclusive {
            reason: reason.into(),
        }
    }
}

/// Score every candidate order for `patch_path` applied to `input_path`.
///
/// Returns `Ok(None)` when the patch is not IPS or the input cannot hold whole
/// N64 words, leaving the caller on its existing path.
pub fn probe_n64_order(
    patch_path: &Path,
    input_path: &Path,
    candidates: [N64OrderCandidate; N64_ORDER_CANDIDATES],
) -> Result<Option<N64OrderProbe>> {
    let Some(patch) = probe_ips_records(patch_path)? else {
        return Ok(None);
    };
    let mut input = ProbeReader::open(input_path)?;
    // A byte-order rewrite works one whole word at a time and refuses anything
    // else, so a file that is not a multiple of four has no candidate at all.
    if input.len() < 4 || input.len() % 4 != 0 {
        trace!(
            input = %input_path.display(),
            input_len = input.len(),
            "n64 order probe: input does not hold whole N64 words"
        );
        return Ok(None);
    }

    let mut evidence = [N64OrderEvidence::default(); N64_ORDER_CANDIDATES];
    let Some(first_word) = input.read_at::<4>(0)? else {
        trace!(
            input = %input_path.display(),
            "n64 order probe: could not read the first word"
        );
        return Ok(None);
    };
    for (slot, candidate) in evidence.iter_mut().zip(candidates) {
        slot.magic = magic_evidence(candidate, &patch.prefix_writes, first_word);
    }

    let compared = patch.records.len().min(MAX_COMPARED_RECORDS);
    if patch.records.len() > compared {
        debug!(
            patch = %patch_path.display(),
            records = patch.records.len(),
            compared,
            "n64 order probe: comparing only the first records; edge counts are a sample"
        );
    }
    let mut stored_checksum_writes = 0;
    for (index, record) in patch.records.iter().enumerate() {
        if writes_into(record, &N64_STORED_CHECKSUM_RANGE) {
            stored_checksum_writes += 1;
        }
        if index < compared {
            accumulate_edges(&mut evidence, record, &candidates, &mut input)?;
        }
    }

    let probe = N64OrderProbe {
        candidates,
        evidence,
        records: patch.records.len(),
        stored_checksum_writes,
    };
    debug!(
        patch = %patch_path.display(),
        input = %input_path.display(),
        ?probe,
        "n64 order probe: scored every candidate order"
    );
    Ok(Some(probe))
}

/// Whether a record writes any byte of `range`.
fn writes_into(record: &IpsProbeRecord, range: &Range<u64>) -> bool {
    let Some(end) = record.offset.checked_add(record.len) else {
        return false;
    };
    record.len > 0 && record.offset < range.end && end > range.start
}

/// Compose the first word the patch leaves behind for one candidate and check it
/// against that candidate's magic. Bytes no record writes come from the input,
/// read through the candidate's word map.
fn magic_evidence(
    candidate: N64OrderCandidate,
    prefix_writes: &[Option<u8>; IPS_PROBE_PREFIX_BYTES],
    input_word: [u8; 4],
) -> N64MagicEvidence {
    if prefix_writes.iter().all(Option::is_none) {
        return N64MagicEvidence::Unwritten;
    }
    let mut applied = [0_u8; 4];
    for (index, byte) in applied.iter_mut().enumerate() {
        *byte = prefix_writes[index].unwrap_or(input_word[candidate.word_map[index]]);
    }
    if applied == candidate.magic {
        N64MagicEvidence::Matches
    } else {
        N64MagicEvidence::Differs
    }
}

/// Compare a record's edge bytes against the byte each candidate would put
/// underneath them. Records running past the input's end are skipped: there is
/// no byte there to compare against.
fn accumulate_edges(
    evidence: &mut [N64OrderEvidence; N64_ORDER_CANDIDATES],
    record: &IpsProbeRecord,
    candidates: &[N64OrderCandidate; N64_ORDER_CANDIDATES],
    input: &mut ProbeReader,
) -> Result<()> {
    let Some(end) = record.offset.checked_add(record.len) else {
        return Ok(());
    };
    if record.len == 0 || end > input.len() {
        return Ok(());
    }
    let last = end - 1;
    // One read per edge covers all three candidates: every order permutes bytes
    // inside the word, so each candidate's byte is already in this word.
    let (Some(first_word), Some(last_word)) = (
        input.read_at::<4>(record.offset & !3)?,
        input.read_at::<4>(last & !3)?,
    ) else {
        return Ok(());
    };
    let first_index = (record.offset % 4) as usize;
    let last_index = (last % 4) as usize;
    for (slot, candidate) in evidence.iter_mut().zip(candidates) {
        slot.comparable_records += 1;
        let under_first = first_word[candidate.word_map[first_index]];
        let under_last = last_word[candidate.word_map[last_index]];
        if under_first == record.first || under_last == record.last {
            slot.untrimmed_records += 1;
        }
    }
    Ok(())
}

/// Pick an order from the evidence, or report why nothing decided it.
///
/// Rules run strongest first and the first to fire wins. Each is one-sided: it
/// can rule a candidate out but never all of them, so an unconvinced scorer says
/// so instead of guessing.
pub fn decide_n64_order(probe: &N64OrderProbe) -> N64OrderDecision {
    if probe.records == 0 {
        return N64OrderDecision::inconclusive("patch has no records");
    }
    if let Some(decision) = decide_by_magic(probe) {
        return decision;
    }
    decide_by_edges(probe)
}

/// Strongest rule: the finished ROM has to start with the N64 magic, and each
/// order spells it differently. A patch writing into the first word therefore
/// names its own order.
fn decide_by_magic(probe: &N64OrderProbe) -> Option<N64OrderDecision> {
    let matched = probe
        .evidence
        .iter()
        .enumerate()
        .filter(|(_, evidence)| evidence.magic == N64MagicEvidence::Matches)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    match matched.as_slice() {
        [index] => Some(N64OrderDecision::decided(
            *index,
            format!(
                "the patch writes the {} N64 magic at offset 0",
                probe.candidates[*index].label
            ),
        )),
        [] => {
            if probe
                .evidence
                .iter()
                .any(|evidence| evidence.magic == N64MagicEvidence::Differs)
            {
                trace!("n64 order probe: the patched first word is no N64 magic in any order");
            }
            None
        }
        _ => {
            trace!(
                candidates = matched.len(),
                "n64 order probe: the patched first word is a valid magic in more than one order"
            );
            None
        }
    }
}

/// Last rule: a differ trims unchanged bytes off both ends of every record, so
/// at the right order a record's edge bytes differ from the bytes underneath. At
/// a wrong order the edge lands on a different byte of the same word and matches
/// by coincidence often enough to show up.
fn decide_by_edges(probe: &N64OrderProbe) -> N64OrderDecision {
    if probe
        .evidence
        .iter()
        .any(|evidence| evidence.comparable_records < MIN_RECORDS_FOR_EDGE_RULE)
    {
        return N64OrderDecision::inconclusive(
            "too few records lie inside the input to compare edges",
        );
    }
    let untrimmed = probe
        .evidence
        .iter()
        .map(|evidence| evidence.untrimmed_records)
        .collect::<Vec<_>>();
    let clean = untrimmed
        .iter()
        .enumerate()
        .filter(|(_, count)| **count == 0)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    // Two clean candidates are two orders the rule cannot separate, which is the
    // ordinary outcome on a small patch.
    if let [index] = clean.as_slice()
        && untrimmed
            .iter()
            .enumerate()
            .all(|(other, count)| other == *index || *count >= MIN_UNTRIMMED_MARGIN)
    {
        let others = untrimmed
            .iter()
            .enumerate()
            .filter(|(other, _)| other != index)
            .map(|(_, count)| count.to_string())
            .collect::<Vec<_>>()
            .join("/");
        return N64OrderDecision::decided(
            *index,
            format!(
                "every record edge differs from the {} bytes, against {others} untrimmed on the other orders",
                probe.candidates[*index].label
            ),
        );
    }
    N64OrderDecision::inconclusive(format!(
        "record edges look alike across the orders ({} untrimmed)",
        untrimmed
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join("/")
    ))
}

#[cfg(test)]
#[path = "../tests/unit/n64_order_probe.rs"]
mod tests;
