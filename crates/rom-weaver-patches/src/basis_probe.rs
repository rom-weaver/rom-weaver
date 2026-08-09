//! Structural evidence for which bytes an offset-only patch was authored
//! against.
//!
//! BPS, UPS, RUP and friends embed a source CRC32, so "which variant did the
//! author use" is answered exactly by hashing each candidate. IPS embeds
//! nothing. When the input carries a strippable copier header the patch may
//! target the raw bytes or the headerless bytes, and the patch itself never
//! says which. Guessing wrong applies every record 512 bytes off, which usually
//! still produces a bootable ROM that is quietly corrupt.
//!
//! This module scores the two candidates from structure alone: where records
//! land relative to each candidate's end, whether they write into the copier
//! header, whether the truncate footer matches a candidate's length, and
//! whether record edges look trimmed. Every rule is one-sided evidence, so the
//! scorer reports [`BasisDecision::Inconclusive`] rather than guess.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use rom_weaver_core::Result;
use tracing::{debug, trace};

use crate::ips::{IpsProbeRecord, probe_ips_records};

/// Records compared for trimmed edges. Every real IPS patch is far under this;
/// the cap only bounds the seek count on a pathological patch. Exceeding it is
/// logged, never silent.
const MAX_COMPARED_RECORDS: usize = 4096;

/// Comparable records a basis needs before its untrimmed-edge count means
/// anything. Below this a single coincidence would decide the basis.
const MIN_RECORDS_FOR_EDGE_RULE: usize = 8;

/// Untrimmed-edge records the losing basis needs before that rule decides.
/// One coincidental match is ordinary; several is a pattern.
///
/// A wrong basis produces a coincidental edge match on roughly 1 record in 128,
/// so this rule stays silent below a few hundred records and only speaks up on
/// the large patches typical of a translation or overhaul hack. That is the
/// intended reach: it is the weakest of the rules and the safe outcome of
/// silence is [`BasisDecision::Inconclusive`].
const MIN_UNTRIMMED_MARGIN: usize = 2;

/// Which bytes of the input a patch is applied to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PatchBasis {
    /// The file as it sits on disk, copier header included.
    Raw,
    /// The file with its copier header stripped.
    Headerless,
}

impl PatchBasis {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Headerless => "headerless",
        }
    }
}

/// What the records look like when applied to one candidate.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BasisEvidence {
    pub source_len: u64,
    /// Records starting strictly past the source end, leaving unwritten bytes
    /// behind them. Appending at exactly the end is legal expansion and is not
    /// counted here.
    pub gap_records: usize,
    /// Records writing into the copier header. Always zero for the headerless
    /// basis, whose offsets start after the header.
    pub header_writes: usize,
    /// Records lying wholly inside the source, so both edges have a source byte
    /// to compare against.
    pub comparable_records: usize,
    /// Comparable records whose first or last byte already equals the source
    /// byte. A differ that trims unchanged edges never emits these.
    pub untrimmed_records: usize,
}

/// Both candidates plus the inputs the decision rules need.
#[derive(Clone, Copy, Debug)]
pub struct BasisProbe {
    pub raw: BasisEvidence,
    pub headerless: BasisEvidence,
    pub records: usize,
    /// Whether the stripped header is copier junk rather than an emulator-read
    /// format header. Only junk headers support the header-write rule: nobody
    /// patches copier padding, but iNES header edits are routine.
    pub header_is_copier_junk: bool,
}

/// The chosen basis, or why no rule fired.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BasisDecision {
    Decided { basis: PatchBasis, reason: String },
    Inconclusive { reason: String },
}

impl BasisDecision {
    pub fn basis(&self) -> Option<PatchBasis> {
        match self {
            Self::Decided { basis, .. } => Some(*basis),
            Self::Inconclusive { .. } => None,
        }
    }

    pub fn reason(&self) -> &str {
        match self {
            Self::Decided { reason, .. } | Self::Inconclusive { reason } => reason,
        }
    }

    fn decided(basis: PatchBasis, reason: impl Into<String>) -> Self {
        Self::Decided {
            basis,
            reason: reason.into(),
        }
    }
}

/// Reads single source bytes at scattered offsets.
struct SourceBytes {
    file: File,
    len: u64,
}

impl SourceBytes {
    fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(Self { file, len })
    }

    fn byte_at(&mut self, offset: u64) -> Result<Option<u8>> {
        if offset >= self.len {
            return Ok(None);
        }
        self.file.seek(SeekFrom::Start(offset))?;
        let mut byte = [0_u8; 1];
        self.file.read_exact(&mut byte)?;
        Ok(Some(byte[0]))
    }
}

/// Score both candidate bases for `patch_path` applied to `input_path`.
///
/// `header_len` is the copier header the headerless candidate strips, and
/// `header_is_copier_junk` comes from the header kind's output policy. Returns
/// `Ok(None)` when the patch is not IPS or the header cannot be stripped,
/// leaving the caller on its existing path.
pub fn probe_patch_basis(
    patch_path: &Path,
    input_path: &Path,
    header_len: u64,
    header_is_copier_junk: bool,
) -> Result<Option<BasisProbe>> {
    let Some(patch) = probe_ips_records(patch_path)? else {
        return Ok(None);
    };
    let mut source = SourceBytes::open(input_path)?;
    if header_len == 0 || header_len >= source.len {
        trace!(
            input = %input_path.display(),
            header_len,
            source_len = source.len,
            "basis probe: header does not leave a usable headerless candidate"
        );
        return Ok(None);
    }
    let raw_len = source.len;
    let headerless_len = source.len - header_len;

    let mut raw = BasisEvidence {
        source_len: raw_len,
        ..BasisEvidence::default()
    };
    let mut headerless = BasisEvidence {
        source_len: headerless_len,
        ..BasisEvidence::default()
    };

    let compared = patch.records.len().min(MAX_COMPARED_RECORDS);
    if patch.records.len() > compared {
        debug!(
            patch = %patch_path.display(),
            records = patch.records.len(),
            compared,
            "basis probe: comparing only the first records; edge counts are a sample"
        );
    }
    for (index, record) in patch.records.iter().enumerate() {
        // Gap and header-write rules read no source bytes, so they stay exact
        // over every record even past the comparison cap.
        accumulate_geometry(&mut raw, record, header_len);
        accumulate_geometry(&mut headerless, record, 0);
        if index < compared {
            accumulate_edges(&mut raw, record, 0, &mut source)?;
            accumulate_edges(&mut headerless, record, header_len, &mut source)?;
        }
    }

    let probe = BasisProbe {
        raw,
        headerless,
        records: patch.records.len(),
        header_is_copier_junk,
    };
    debug!(
        patch = %patch_path.display(),
        input = %input_path.display(),
        ?probe,
        "basis probe: scored both candidates"
    );
    Ok(Some(probe))
}

/// Count what a record's placement says about a candidate, without reading the
/// source. `header_len` is non-zero only for the raw candidate, whose low
/// offsets fall inside the copier header.
fn accumulate_geometry(evidence: &mut BasisEvidence, record: &IpsProbeRecord, header_len: u64) {
    if record.offset > evidence.source_len {
        evidence.gap_records += 1;
    }
    if header_len > 0 && record.offset < header_len {
        evidence.header_writes += 1;
    }
}

/// Compare a record's edge bytes against the source it would overwrite.
/// `base_offset` shifts patch offsets to file offsets for the headerless
/// candidate. Records running past the source end are skipped: an expansion
/// patch has no source byte there.
fn accumulate_edges(
    evidence: &mut BasisEvidence,
    record: &IpsProbeRecord,
    base_offset: u64,
    source: &mut SourceBytes,
) -> Result<()> {
    let Some(end) = record.offset.checked_add(record.len) else {
        return Ok(());
    };
    if record.len == 0 || end > evidence.source_len {
        return Ok(());
    }
    evidence.comparable_records += 1;
    let first_at = base_offset.saturating_add(record.offset);
    let last_at = base_offset.saturating_add(end - 1);
    let first_matches = source.byte_at(first_at)? == Some(record.first);
    let last_matches = source.byte_at(last_at)? == Some(record.last);
    if first_matches || last_matches {
        evidence.untrimmed_records += 1;
    }
    Ok(())
}

/// Pick a basis from the evidence, or report why nothing decided it.
///
/// Rules run strongest first and the first to fire wins. Each is one-sided:
/// it can rule a candidate out but never both, so an unconvinced scorer says
/// so instead of guessing.
pub fn decide_basis(probe: &BasisProbe) -> BasisDecision {
    if probe.records == 0 {
        return BasisDecision::Inconclusive {
            reason: "patch has no records".into(),
        };
    }

    // No truncate rule lives here on purpose. An IPS truncate footer states the
    // OUTPUT size, not the size of the bytes the author patched, and a creator
    // only emits one when the patch shrinks the file. So `truncate ==
    // source_len` is false for the author's real basis by construction, and a
    // raw-basis patch that shrinks a headered dump to its headerless length
    // matches the headerless candidate exactly - the rule would fire backwards
    // on the one shape it looked designed for.

    // Records that start past the end leave unwritten bytes behind them, which
    // no patcher emits. Only the headerless candidate can produce them - it is
    // the shorter of the two - so this rule only ever votes raw.
    if probe.headerless.gap_records > 0 && probe.raw.gap_records == 0 {
        return BasisDecision::decided(
            PatchBasis::Raw,
            format!(
                "{} record(s) start past the end of the headerless bytes",
                probe.headerless.gap_records
            ),
        );
    }

    // Copier headers are padding left by dumping hardware. A patch writing into
    // one was addressing ROM data, so its offsets are header-relative.
    if probe.header_is_copier_junk && probe.raw.header_writes > 0 {
        return BasisDecision::decided(
            PatchBasis::Headerless,
            format!(
                "{} record(s) would write inside the copier header",
                probe.raw.header_writes
            ),
        );
    }

    decide_by_edges(probe)
}

/// Last rule: a differ trims unchanged bytes off both ends of every record, so
/// at the right basis a record's edge bytes differ from the source. At the
/// wrong basis they match by coincidence often enough to show up.
fn decide_by_edges(probe: &BasisProbe) -> BasisDecision {
    let raw = probe.raw;
    let headerless = probe.headerless;
    if raw.comparable_records < MIN_RECORDS_FOR_EDGE_RULE
        || headerless.comparable_records < MIN_RECORDS_FOR_EDGE_RULE
    {
        return BasisDecision::Inconclusive {
            reason: "too few records lie inside both candidates to compare edges".into(),
        };
    }
    let candidates = [
        (PatchBasis::Raw, raw.untrimmed_records, headerless),
        (PatchBasis::Headerless, headerless.untrimmed_records, raw),
    ];
    for (basis, untrimmed, other) in candidates {
        if untrimmed == 0 && other.untrimmed_records >= MIN_UNTRIMMED_MARGIN {
            return BasisDecision::decided(
                basis,
                format!(
                    "every record edge differs from the {} bytes, against {} untrimmed on the other candidate",
                    basis.label(),
                    other.untrimmed_records
                ),
            );
        }
    }
    BasisDecision::Inconclusive {
        reason: format!(
            "record edges look alike on both candidates ({} raw, {} headerless untrimmed)",
            raw.untrimmed_records, headerless.untrimmed_records
        ),
    }
}

#[cfg(test)]
#[path = "../tests/unit/basis_probe.rs"]
mod tests;
