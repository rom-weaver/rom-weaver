use std::collections::HashSet;

use serde::Deserialize;

use super::super::SaveSection;
#[cfg(test)]
use super::Storage;
use super::rules::{Predicate, Scalar};
use super::{Checksum, ChecksumAlgorithm, ChecksumSpan, ChecksumUnit, RawChecksum};
use crate::{Result, RomWeaverError, ValidationCodeError};

const MAX_LOGICAL_SIZE: usize = 8 * 1024 * 1024;
const MAX_GROUPS: usize = 128;
const MAX_COPIES: usize = 128;
const MAX_SPANS: usize = 4096;
const MAX_INTEGRITY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Layout {
    #[serde(default)]
    groups: Vec<Group>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    id: String,
    logical_offset: usize,
    logical_length: usize,
    copies: Copies,
    #[serde(default)]
    selection: Selection,
    #[serde(default)]
    write: WritePolicy,
    #[serde(default)]
    empty: Vec<u8>,
    #[serde(default)]
    empty_if_no_signature: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Copies {
    Fixed {
        candidates: Vec<Candidate>,
    },
    Tagged {
        candidates: Vec<TaggedCandidate>,
        sections: Vec<TaggedSection>,
        section_size: usize,
        id_offset: usize,
        checksum_offset: usize,
        checksum_algorithm: Option<ChecksumAlgorithm>,
        checksum_unit: Option<ChecksumUnit>,
        signature_offset: usize,
        counter_offset: usize,
        signature: u32,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Candidate {
    spans: Vec<Span>,
    #[serde(default)]
    signatures: Vec<Signature>,
    #[serde(default)]
    checksums: Vec<RawChecksum>,
    #[serde(default)]
    repairs: Vec<Repair>,
    #[serde(default)]
    predicates: Vec<Predicate>,
    #[serde(default)]
    sections: Vec<FixedSection>,
    counter: Option<Scalar>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Repair {
    Checksum {
        checksum: RawChecksum,
    },
    Mirror {
        source: usize,
        target: usize,
        length: usize,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixedSection {
    id: u8,
    physical_offset: usize,
    checksum: RawChecksum,
    signature: Option<Scalar>,
    counter: Option<Scalar>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaggedCandidate {
    offset: usize,
    section_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaggedSection {
    id: u8,
    logical_offset: usize,
    length: usize,
    checksum_length: usize,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Span {
    logical_offset: usize,
    physical_offset: usize,
    length: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Signature {
    offset: usize,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Selection {
    #[default]
    FirstValid,
    NewestCounter,
    NewestCounterMaxToZero,
    NewestCounterErrorOnTie,
    NewestCounterMaxToZeroErrorOnTie,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WritePolicy {
    #[default]
    Selected,
    PatchAllValid,
    CloneSelectedToAll,
}

#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    pub(crate) bytes: Vec<u8>,
    pub(crate) groups: Vec<ResolvedGroup>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedGroup {
    pub(crate) id: String,
    pub(crate) selected: Option<usize>,
    pub(crate) copies: Vec<ResolvedCopy>,
    pub(crate) copies_differ: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedCopy {
    pub(crate) valid: bool,
    pub(crate) empty: bool,
    pub(crate) counter: Option<u32>,
    pub(crate) sections: Vec<SaveSection>,
    spans: Vec<Span>,
}

impl Layout {
    pub(crate) fn has_group(&self, id: &str) -> bool {
        self.groups.iter().any(|group| group.id == id)
    }
    pub(crate) fn validate(&self, save_size: usize, logical_size: usize) -> Result<()> {
        if logical_size == 0 || logical_size > MAX_LOGICAL_SIZE {
            return Err(invalid("layout logical_size must be from 1 byte to 8 MiB"));
        }
        if self.groups.is_empty() || self.groups.len() > MAX_GROUPS {
            return Err(invalid("layout must contain 1 to 128 groups"));
        }
        let mut ids = HashSet::new();
        let mut logical_ranges = Vec::new();
        for group in &self.groups {
            if group.id.is_empty() || !ids.insert(&group.id) {
                return Err(invalid("layout group IDs must be nonempty and unique"));
            }
            check_span(
                group.logical_offset,
                group.logical_length,
                logical_size,
                "group",
            )?;
            logical_ranges.push((
                group.logical_offset,
                group.logical_offset + group.logical_length,
            ));
            group.validate(save_size, logical_size)?;
        }
        logical_ranges.sort_unstable();
        if logical_ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
            return Err(invalid("layout groups must not overlap"));
        }
        self.integrity_bytes(save_size)?;
        Ok(())
    }

    pub(crate) fn integrity_bytes(&self, save_size: usize) -> Result<usize> {
        self.groups.iter().try_fold(0usize, |total, group| {
            total
                .checked_add(group.integrity_bytes(save_size)?)
                .filter(|total| *total <= MAX_INTEGRITY_BYTES)
                .ok_or_else(|| invalid("layout integrity work exceeds 64 MiB"))
        })
    }

    pub(crate) fn resolve(
        &self,
        save: &[u8],
        logical_size: usize,
        selection_required: bool,
    ) -> Result<Resolved> {
        self.validate(save.len(), logical_size)?;
        let mut bytes = save[..save.len().min(logical_size)].to_vec();
        bytes.resize(logical_size, 0);
        let mut groups = Vec::with_capacity(self.groups.len());
        for group in &self.groups {
            let copies = group.resolve_copies(save)?;
            let selected = select_copy(&copies, group.selection, selection_required)?;
            let copies_differ = selected.is_some_and(|selected| {
                copies.iter().enumerate().any(|(index, copy)| {
                    copy.valid
                        && index != selected
                        && mapped_copy_differs(save, &copies[selected].spans, &copy.spans)
                })
            });
            if let Some(selected) = selected {
                copy_spans(save, &mut bytes, &copies[selected].spans)?;
            }
            groups.push(ResolvedGroup {
                id: group.id.clone(),
                selected,
                copies,
                copies_differ,
            });
        }
        Ok(Resolved { bytes, groups })
    }

    pub(crate) fn write_back(
        &self,
        save: &[u8],
        resolved: &Resolved,
        edited: &[u8],
        touched_groups: &[String],
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        if edited.len() != resolved.bytes.len() || resolved.groups.len() != self.groups.len() {
            return Err(invalid(
                "edited logical image does not match the resolved layout",
            ));
        }
        let mut output = save.to_vec();
        let mut touched_sections = HashSet::new();
        for (offset, (before, after)) in resolved.bytes.iter().zip(edited).enumerate() {
            if before == after
                || self.groups.iter().any(|group| {
                    offset >= group.logical_offset
                        && offset < group.logical_offset + group.logical_length
                })
            {
                continue;
            }
            let target = output.get_mut(offset).ok_or_else(|| {
                invalid("an edited unmapped logical byte is outside the physical save")
            })?;
            *target = *after;
        }
        for (group, state) in self.groups.iter().zip(&resolved.groups) {
            let range = group.logical_offset..group.logical_offset + group.logical_length;
            if !touched_groups.iter().any(|id| id == &group.id)
                && resolved.bytes[range.clone()] == edited[range.clone()]
            {
                continue;
            }
            let targets: Vec<usize> = match group.write {
                WritePolicy::Selected => state.selected.into_iter().collect(),
                WritePolicy::PatchAllValid => state
                    .copies
                    .iter()
                    .enumerate()
                    .filter_map(|(index, copy)| copy.valid.then_some(index))
                    .collect(),
                WritePolicy::CloneSelectedToAll => (0..state.copies.len()).collect(),
            };
            if targets.is_empty() {
                return Err(invalid("a touched layout group has no valid copy"));
            }
            for index in targets {
                let spans = &state.copies[index].spans;
                let mut changed = Vec::new();
                for span in spans {
                    let source = span.logical_offset..span.logical_offset + span.length;
                    let target = span.physical_offset..span.physical_offset + span.length;
                    if matches!(group.write, WritePolicy::CloneSelectedToAll) {
                        output[target].copy_from_slice(&edited[source]);
                        changed.push((span.physical_offset, span.physical_offset + span.length));
                    } else {
                        for (logical, physical) in source.zip(target) {
                            if resolved.bytes[logical] != edited[logical] {
                                output[physical] = edited[logical];
                                changed.push((physical, physical + 1));
                            }
                        }
                    }
                }
                if let Copies::Fixed { candidates } = &group.copies {
                    for raw in &candidates[index].checksums {
                        let checksum = Checksum::build(raw.clone(), output.len())?;
                        if changed.iter().any(|span| checksum.reads_span(*span)) {
                            checksum.repair(&mut output);
                            changed.push((checksum.offset, checksum.offset + checksum.width()));
                        }
                    }
                    for repair in &candidates[index].repairs {
                        repair.apply(&mut output, &mut changed)?;
                    }
                    for section in &candidates[index].sections {
                        let checksum = Checksum::build(section.checksum.clone(), output.len())?;
                        let output_span = (checksum.offset, checksum.offset + checksum.width());
                        if changed.iter().any(|span| {
                            checksum.reads_span(*span)
                                || (span.0 < output_span.1 && output_span.0 < span.1)
                        }) {
                            touched_sections.insert(section.id);
                        }
                    }
                } else if let Copies::Tagged {
                    sections,
                    checksum_offset,
                    checksum_algorithm,
                    checksum_unit,
                    ..
                } = &group.copies
                {
                    for section in sections {
                        let metadata = state.copies[index]
                            .sections
                            .iter()
                            .find(|metadata| metadata.id == section.id)
                            .ok_or_else(|| invalid("tagged copy is missing a section"))?;
                        let offset = metadata.physical_offset as usize + checksum_offset;
                        Checksum::build(
                            tagged_checksum(
                                metadata.physical_offset as usize,
                                section.checksum_length,
                                offset,
                                *checksum_algorithm,
                                *checksum_unit,
                            ),
                            output.len(),
                        )?
                        .repair(&mut output);
                        let physical = metadata.physical_offset as usize;
                        if changed
                            .iter()
                            .any(|span| span.0 < physical + section.length && physical < span.1)
                        {
                            touched_sections.insert(section.id);
                        }
                    }
                }
            }
        }
        let mut touched_sections = touched_sections.into_iter().collect::<Vec<_>>();
        touched_sections.sort_unstable();
        Ok((output, touched_sections))
    }
}

impl Group {
    fn integrity_bytes(&self, save_size: usize) -> Result<usize> {
        match &self.copies {
            Copies::Fixed { candidates } => {
                candidates.iter().try_fold(0usize, |total, candidate| {
                    let checksums = candidate
                        .checksums
                        .iter()
                        .chain(candidate.sections.iter().map(|section| &section.checksum))
                        .chain(candidate.repairs.iter().filter_map(|repair| match repair {
                            Repair::Checksum { checksum } => Some(checksum),
                            Repair::Mirror { .. } => None,
                        }))
                        .try_fold(0usize, |subtotal, raw| {
                            let checksum = Checksum::build(raw.clone(), save_size)?;
                            subtotal
                                .checked_add(checksum.length)
                                .ok_or_else(|| invalid("layout integrity work overflows"))
                        })?;
                    let mirrors = candidate
                        .repairs
                        .iter()
                        .filter_map(|repair| match repair {
                            Repair::Mirror { length, .. } => Some(*length),
                            Repair::Checksum { .. } => None,
                        })
                        .try_fold(0usize, |total, length| {
                            total
                                .checked_add(length)
                                .ok_or_else(|| invalid("layout integrity work overflows"))
                        })?;
                    let mappings = candidate
                        .spans
                        .iter()
                        .map(|span| span.length)
                        .chain(
                            candidate
                                .signatures
                                .iter()
                                .map(|signature| signature.bytes.len()),
                        )
                        .try_fold(0usize, |total, length| {
                            total
                                .checked_add(length)
                                .ok_or_else(|| invalid("layout integrity work overflows"))
                        })?;
                    let predicates =
                        candidate
                            .predicates
                            .iter()
                            .try_fold(0usize, |total, predicate| {
                                total
                                    .checked_add(predicate.work_bytes()?)
                                    .ok_or_else(|| invalid("layout integrity work overflows"))
                            })?;
                    total
                        .checked_add(checksums)
                        .and_then(|value| value.checked_add(mirrors))
                        .and_then(|value| value.checked_add(mappings))
                        .and_then(|value| value.checked_add(predicates))
                        .ok_or_else(|| invalid("layout integrity work overflows"))
                })
            }
            Copies::Tagged {
                candidates,
                sections,
                ..
            } => {
                let one = sections.iter().try_fold(0usize, |total, section| {
                    total
                        .checked_add(section.checksum_length)
                        .and_then(|value| value.checked_add(section.length))
                        .and_then(|value| value.checked_add(10))
                        .ok_or_else(|| invalid("layout integrity work overflows"))
                })?;
                one.checked_mul(candidates.len())
                    .ok_or_else(|| invalid("layout integrity work overflows"))
            }
        }
    }

    fn validate(&self, save_size: usize, logical_size: usize) -> Result<()> {
        if self.empty.len() > 16 {
            return Err(invalid("empty byte sets may contain at most 16 values"));
        }
        match &self.copies {
            Copies::Fixed { candidates } => {
                bounded_count(candidates.len(), "fixed candidates")?;
                for candidate in candidates {
                    validate_spans(
                        &candidate.spans,
                        self.logical_offset,
                        self.logical_length,
                        save_size,
                        logical_size,
                    )?;
                    for signature in &candidate.signatures {
                        check_span(
                            signature.offset,
                            signature.bytes.len(),
                            save_size,
                            "signature",
                        )?;
                    }
                    for checksum in &candidate.checksums {
                        Checksum::build(checksum.clone(), save_size)?;
                    }
                    for repair in &candidate.repairs {
                        repair.validate(save_size)?;
                    }
                    for predicate in &candidate.predicates {
                        predicate.validate(save_size)?;
                    }
                    if candidate.sections.len() > MAX_SPANS {
                        return Err(invalid("fixed sections exceed 4096 entries"));
                    }
                    let mut section_ids = HashSet::new();
                    for section in &candidate.sections {
                        if !section_ids.insert(section.id) {
                            return Err(invalid("fixed section IDs must be unique"));
                        }
                        check_span(section.physical_offset, 1, save_size, "section")?;
                        Checksum::build(section.checksum.clone(), save_size)?;
                        if let Some(signature) = &section.signature {
                            signature.validate(save_size)?;
                        }
                        if let Some(counter) = &section.counter {
                            counter.validate(save_size)?;
                        }
                    }
                    if let Some(counter) = &candidate.counter {
                        counter.validate(save_size)?;
                    }
                }
            }
            Copies::Tagged {
                candidates,
                sections,
                section_size,
                id_offset,
                checksum_offset,
                checksum_algorithm,
                checksum_unit,
                signature_offset,
                counter_offset,
                ..
            } => {
                bounded_count(candidates.len(), "tagged candidates")?;
                if sections.is_empty() || sections.len() > MAX_SPANS || *section_size == 0 {
                    return Err(invalid("tagged layouts require bounded sections"));
                }
                for offset in [
                    *id_offset,
                    *checksum_offset,
                    *signature_offset,
                    *counter_offset,
                ] {
                    check_span(
                        offset,
                        if offset == *signature_offset || offset == *counter_offset {
                            4
                        } else {
                            2
                        },
                        *section_size,
                        "tagged footer",
                    )?;
                }
                let mut section_ids = HashSet::new();
                let mut logical_ranges = Vec::with_capacity(sections.len());
                for section in sections {
                    if !section_ids.insert(section.id) {
                        return Err(invalid("tagged section IDs must be unique"));
                    }
                    check_span(
                        section.logical_offset,
                        section.length,
                        logical_size,
                        "tagged logical section",
                    )?;
                    if section.checksum_length > *section_size {
                        return Err(invalid("tagged checksum length exceeds its section"));
                    }
                    if section.length > *section_size {
                        return Err(invalid("tagged mapping length exceeds its section"));
                    }
                    let checksum = Checksum::build(
                        tagged_checksum(
                            0,
                            section.checksum_length,
                            *checksum_offset,
                            *checksum_algorithm,
                            *checksum_unit,
                        ),
                        *section_size,
                    )?;
                    if checksum.width() != 2 {
                        return Err(invalid("tagged section checksums must be 16-bit"));
                    }
                    logical_ranges.push((
                        section.logical_offset,
                        section.logical_offset + section.length,
                    ));
                }
                logical_ranges.sort_unstable();
                if logical_ranges[0].0 != self.logical_offset
                    || logical_ranges.last().map(|range| range.1)
                        != Some(self.logical_offset + self.logical_length)
                    || logical_ranges.windows(2).any(|pair| pair[0].1 != pair[1].0)
                {
                    return Err(invalid("tagged sections must partition their layout group"));
                }
                for candidate in candidates {
                    if candidate.section_count != sections.len() {
                        return Err(invalid("tagged candidate section count is incomplete"));
                    }
                    let length = candidate
                        .section_count
                        .checked_mul(*section_size)
                        .ok_or_else(|| invalid("tagged candidate size overflows"))?;
                    check_span(candidate.offset, length, save_size, "tagged candidate")?;
                }
            }
        }
        Ok(())
    }

    fn resolve_copies(&self, save: &[u8]) -> Result<Vec<ResolvedCopy>> {
        match &self.copies {
            Copies::Fixed { candidates } => candidates
                .iter()
                .map(|candidate| {
                    let sections = fixed_sections(&candidate.sections, save)?;
                    let predicates_valid = candidate
                        .predicates
                        .iter()
                        .try_fold(true, |valid, predicate| -> Result<bool> {
                            Ok(valid && predicate.test(save)?)
                        })?;
                    let valid = candidate.signatures.iter().all(|signature| {
                        save[signature.offset..signature.offset + signature.bytes.len()]
                            == signature.bytes
                    }) && predicates_valid
                        && candidate.checksums.iter().all(|checksum| {
                            Checksum::build(checksum.clone(), save.len())
                                .is_ok_and(|checksum| checksum.valid(save))
                        })
                        && sections.iter().all(|section| section.valid);
                    let empty = !self.empty.is_empty()
                        && candidate.spans.iter().all(|span| {
                            save[span.physical_offset..span.physical_offset + span.length]
                                .iter()
                                .all(|byte| self.empty.contains(byte))
                        });
                    Ok(ResolvedCopy {
                        valid,
                        empty,
                        counter: candidate
                            .counter
                            .as_ref()
                            .map(|scalar| scalar.read(save).map(|value| value as u32))
                            .transpose()?,
                        sections,
                        spans: candidate.spans.clone(),
                    })
                })
                .collect(),
            Copies::Tagged {
                candidates,
                sections,
                section_size,
                id_offset,
                checksum_offset,
                checksum_algorithm,
                checksum_unit,
                signature_offset,
                counter_offset,
                signature,
            } => candidates
                .iter()
                .map(|candidate| {
                    let mut seen = HashSet::new();
                    let mut spans = Vec::with_capacity(sections.len());
                    let mut metadata = Vec::with_capacity(sections.len());
                    let mut shared_counter = None;
                    let mut valid = true;
                    let mut any_signature = false;
                    for physical in 0..candidate.section_count {
                        let base = candidate.offset + physical * section_size;
                        let id = read_u16(save, base + id_offset) as u8;
                        let Some(section) = sections.iter().find(|section| section.id == id) else {
                            valid = false;
                            continue;
                        };
                        if !seen.insert(id) {
                            valid = false;
                            continue;
                        }
                        let actual = read_u16(save, base + checksum_offset);
                        let expected = Checksum::build(
                            tagged_checksum(
                                base,
                                section.checksum_length,
                                base + checksum_offset,
                                *checksum_algorithm,
                                *checksum_unit,
                            ),
                            save.len(),
                        )?
                        .expected(save) as u16;
                        let found_signature = read_u32(save, base + signature_offset);
                        any_signature |= found_signature == *signature;
                        let counter = read_u32(save, base + counter_offset);
                        valid &= actual == expected
                            && found_signature == *signature
                            && shared_counter.is_none_or(|value| value == counter);
                        shared_counter.get_or_insert(counter);
                        spans.push(Span {
                            logical_offset: section.logical_offset,
                            physical_offset: base,
                            length: section.length,
                        });
                        metadata.push(SaveSection {
                            id,
                            physical_offset: base as u32,
                            checksum_expected: actual,
                            checksum_actual: expected,
                            signature: found_signature,
                            counter,
                            valid: actual == expected && found_signature == *signature,
                        });
                    }
                    valid &= seen.len() == sections.len();
                    spans.sort_by_key(|span| span.logical_offset);
                    metadata.sort_by_key(|section| section.id);
                    let empty = (self.empty_if_no_signature && !any_signature)
                        || !self.empty.is_empty()
                            && spans.iter().all(|span| {
                                save[span.physical_offset..span.physical_offset + span.length]
                                    .iter()
                                    .all(|byte| self.empty.contains(byte))
                            });
                    Ok(ResolvedCopy {
                        valid,
                        empty,
                        counter: shared_counter,
                        sections: metadata,
                        spans,
                    })
                })
                .collect(),
        }
    }
}

fn select_copy(
    copies: &[ResolvedCopy],
    selection: Selection,
    required: bool,
) -> Result<Option<usize>> {
    let valid: Vec<_> = copies
        .iter()
        .enumerate()
        .filter(|(_, copy)| copy.valid)
        .collect();
    let Some(&(mut selected, _)) = valid.first() else {
        return Ok(None);
    };
    if matches!(selection, Selection::FirstValid) {
        return Ok(Some(selected));
    }
    let error_on_tie = matches!(
        selection,
        Selection::NewestCounterErrorOnTie | Selection::NewestCounterMaxToZeroErrorOnTie
    );
    let rollover = matches!(
        selection,
        Selection::NewestCounterMaxToZero | Selection::NewestCounterMaxToZeroErrorOnTie
    );
    let mut tie = false;
    for &(index, copy) in valid.iter().skip(1) {
        let left = copy
            .counter
            .ok_or_else(|| invalid("counter selection requires a counter"))?;
        let right = copies[selected]
            .counter
            .ok_or_else(|| invalid("counter selection requires a counter"))?;
        if left == right {
            tie = true;
            continue;
        }
        if left > right && !(rollover && left == u32::MAX && right == 0)
            || rollover && left == 0 && right == u32::MAX
        {
            selected = index;
            tie = false;
        }
    }
    if tie && error_on_tie && required {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("save_slot_counter").with_message(
                "the save slots have the same counter, so the active slot is ambiguous",
            ),
        ));
    }
    Ok(Some(selected))
}

fn validate_spans(
    spans: &[Span],
    group_offset: usize,
    group_length: usize,
    save_size: usize,
    logical_size: usize,
) -> Result<()> {
    if spans.is_empty() || spans.len() > MAX_SPANS {
        return Err(invalid("candidate spans must contain 1 to 4096 entries"));
    }
    let mut ranges = Vec::with_capacity(spans.len());
    for span in spans {
        check_span(
            span.logical_offset,
            span.length,
            logical_size,
            "logical mapping",
        )?;
        check_span(
            span.physical_offset,
            span.length,
            save_size,
            "physical mapping",
        )?;
        ranges.push((span.logical_offset, span.logical_offset + span.length));
    }
    ranges.sort_unstable();
    if ranges[0].0 != group_offset
        || ranges.last().map(|range| range.1) != Some(group_offset + group_length)
        || ranges.windows(2).any(|pair| pair[0].1 != pair[1].0)
    {
        return Err(invalid("candidate spans must partition their group"));
    }
    Ok(())
}

impl Repair {
    fn validate(&self, size: usize) -> Result<()> {
        match self {
            Self::Checksum { checksum } => Checksum::build(checksum.clone(), size).map(|_| ()),
            Self::Mirror {
                source,
                target,
                length,
            } => {
                check_span(*source, *length, size, "mirror source")?;
                check_span(*target, *length, size, "mirror target")
            }
        }
    }

    fn apply(&self, bytes: &mut [u8], changed: &mut Vec<(usize, usize)>) -> Result<()> {
        match self {
            Self::Checksum { checksum } => {
                let checksum = Checksum::build(checksum.clone(), bytes.len())?;
                if changed.iter().any(|span| checksum.reads_span(*span)) {
                    checksum.repair(bytes);
                    changed.push((checksum.offset, checksum.offset + checksum.width()));
                }
                Ok(())
            }
            Self::Mirror {
                source,
                target,
                length,
            } => {
                if changed
                    .iter()
                    .any(|span| span.0 < source + length && *source < span.1)
                {
                    bytes.copy_within(*source..*source + *length, *target);
                    changed.push((*target, *target + *length));
                }
                Ok(())
            }
        }
    }
}

fn fixed_sections(sections: &[FixedSection], bytes: &[u8]) -> Result<Vec<SaveSection>> {
    sections
        .iter()
        .map(|section| {
            let checksum = Checksum::build(section.checksum.clone(), bytes.len())?;
            let expected = checksum.expected(bytes) as u16;
            let mut stored = [0u8; 4];
            let start = if checksum.algorithm.big_endian() {
                4 - checksum.width()
            } else {
                0
            };
            stored[start..start + checksum.width()]
                .copy_from_slice(&bytes[checksum.offset..checksum.offset + checksum.width()]);
            let actual = if checksum.algorithm.big_endian() {
                u32::from_be_bytes(stored)
            } else {
                u32::from_le_bytes(stored)
            } as u16;
            Ok(SaveSection {
                id: section.id,
                physical_offset: section.physical_offset as u32,
                checksum_expected: actual,
                checksum_actual: expected,
                signature: section
                    .signature
                    .as_ref()
                    .map(|value| value.read(bytes))
                    .transpose()?
                    .unwrap_or(0) as u32,
                counter: section
                    .counter
                    .as_ref()
                    .map(|value| value.read(bytes))
                    .transpose()?
                    .unwrap_or(0) as u32,
                valid: actual == expected,
            })
        })
        .collect()
}

fn copy_spans(source: &[u8], target: &mut [u8], spans: &[Span]) -> Result<()> {
    for span in spans {
        target[span.logical_offset..span.logical_offset + span.length]
            .copy_from_slice(&source[span.physical_offset..span.physical_offset + span.length]);
    }
    Ok(())
}

fn mapped_copy_differs(save: &[u8], left: &[Span], right: &[Span]) -> bool {
    let collect = |spans: &[Span]| {
        let mut mapped = spans
            .iter()
            .flat_map(|span| {
                save[span.physical_offset..span.physical_offset + span.length]
                    .iter()
                    .enumerate()
                    .map(move |(index, byte)| (span.logical_offset + index, *byte))
            })
            .collect::<Vec<_>>();
        mapped.sort_unstable_by_key(|value| value.0);
        mapped
    };
    collect(left) != collect(right)
}
fn bounded_count(count: usize, label: &str) -> Result<()> {
    if count == 0 || count > MAX_COPIES {
        Err(invalid(format!("{label} must contain 1 to 128 entries")))
    } else {
        Ok(())
    }
}
fn check_span(offset: usize, length: usize, size: usize, label: &str) -> Result<()> {
    if length == 0 || offset.checked_add(length).is_none_or(|end| end > size) {
        Err(invalid(format!("{label} is empty or outside its image")))
    } else {
        Ok(())
    }
}
fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated scalar span"),
    )
}
fn tagged_checksum(
    start: usize,
    length: usize,
    offset: usize,
    algorithm: Option<ChecksumAlgorithm>,
    unit: Option<ChecksumUnit>,
) -> RawChecksum {
    RawChecksum {
        algorithm: algorithm.unwrap_or(ChecksumAlgorithm::Sum32LeFold16),
        start: None,
        length: None,
        spans: vec![ChecksumSpan { start, length }],
        offset,
        target: None,
        unit: unit.unwrap_or(ChecksumUnit::U32Le),
        exclude: Vec::new(),
    }
}
fn invalid(message: impl Into<String>) -> RomWeaverError {
    RomWeaverError::Validation(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_layout(write: WritePolicy, selection: Selection) -> Layout {
        Layout {
            groups: vec![Group {
                id: "main".into(),
                logical_offset: 0,
                logical_length: 4,
                copies: Copies::Fixed {
                    candidates: vec![
                        Candidate {
                            spans: vec![Span {
                                logical_offset: 0,
                                physical_offset: 0,
                                length: 4,
                            }],
                            signatures: vec![Signature {
                                offset: 0,
                                bytes: vec![1],
                            }],
                            checksums: vec![],
                            repairs: vec![],
                            predicates: vec![],
                            sections: vec![],
                            counter: Some(Scalar {
                                offset: 3,
                                storage: Storage::U8,
                                mask: None,
                                relative: false,
                            }),
                        },
                        Candidate {
                            spans: vec![Span {
                                logical_offset: 0,
                                physical_offset: 4,
                                length: 4,
                            }],
                            signatures: vec![Signature {
                                offset: 4,
                                bytes: vec![1],
                            }],
                            checksums: vec![],
                            repairs: vec![],
                            predicates: vec![],
                            sections: vec![],
                            counter: Some(Scalar {
                                offset: 7,
                                storage: Storage::U8,
                                mask: None,
                                relative: false,
                            }),
                        },
                    ],
                },
                selection,
                write,
                empty: vec![0, 0xff],
                empty_if_no_signature: false,
            }],
        }
    }

    #[test]
    fn resolves_newest_and_patches_only_selected_copy() {
        let layout = fixed_layout(WritePolicy::Selected, Selection::NewestCounter);
        let save = [1, 2, 3, 4, 1, 6, 7, 5];
        let resolved = layout.resolve(&save, 4, true).unwrap();
        assert_eq!(resolved.bytes, [1, 6, 7, 5]);
        let mut edited = resolved.bytes.clone();
        edited[1] = 9;
        assert_eq!(
            layout.write_back(&save, &resolved, &edited, &[]).unwrap().0,
            [1, 2, 3, 4, 1, 9, 7, 5]
        );
    }

    #[test]
    fn inspection_accepts_a_tie_that_parse_rejects() {
        let layout = fixed_layout(WritePolicy::Selected, Selection::NewestCounterErrorOnTie);
        let save = [1, 2, 3, 4, 1, 6, 7, 4];
        assert!(layout.resolve(&save, 4, false).is_ok());
        assert!(layout.resolve(&save, 4, true).is_err());
    }

    #[test]
    fn rejects_gaps_in_logical_mappings() {
        let mut layout = fixed_layout(WritePolicy::Selected, Selection::FirstValid);
        let Copies::Fixed { candidates } = &mut layout.groups[0].copies else {
            unreachable!()
        };
        candidates[0].spans[0].length = 3;
        assert!(layout.validate(8, 4).is_err());
    }

    #[test]
    fn gen3_checksum_folds_little_endian_words() {
        let mut bytes = vec![0; 10];
        bytes[..8].copy_from_slice(&[0xff, 0xff, 0, 0, 2, 0, 1, 0]);
        let checksum = Checksum::build(tagged_checksum(0, 8, 8, None, None), bytes.len()).unwrap();
        checksum.repair(&mut bytes);
        assert_eq!(&bytes[8..], &3u16.to_le_bytes());
        assert!(checksum.valid(&bytes));
    }

    #[test]
    fn selects_the_only_valid_copy() {
        let layout = fixed_layout(WritePolicy::Selected, Selection::NewestCounter);
        let save = [0, 2, 3, 9, 1, 6, 7, 5];
        let resolved = layout.resolve(&save, 4, true).unwrap();
        assert_eq!(resolved.groups[0].selected, Some(1));
        assert!(!resolved.groups[0].copies[0].valid);
        assert!(resolved.groups[0].copies[1].valid);
    }

    #[test]
    fn rollover_selects_zero_after_maximum() {
        let mut layout = fixed_layout(WritePolicy::Selected, Selection::NewestCounterMaxToZero);
        let Copies::Fixed { candidates } = &mut layout.groups[0].copies else {
            unreachable!()
        };
        candidates[0].counter = Some(Scalar {
            offset: 1,
            relative: false,
            storage: Storage::U32Le,
            mask: None,
        });
        candidates[1].counter = Some(Scalar {
            offset: 6,
            relative: false,
            storage: Storage::U32Le,
            mask: None,
        });
        let save = [1, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0, 0];
        candidates[0].spans[0].length = 4;
        candidates[1].spans[0].physical_offset = 5;
        candidates[1].signatures[0].offset = 5;
        layout.groups[0].logical_length = 4;
        let resolved = layout.resolve(&save, 4, true).unwrap();
        assert_eq!(resolved.groups[0].selected, Some(1));
    }

    #[test]
    fn patch_all_valid_preserves_untouched_copy_bytes() {
        let layout = fixed_layout(WritePolicy::PatchAllValid, Selection::FirstValid);
        let save = [1, 2, 3, 4, 1, 8, 9, 5];
        let resolved = layout.resolve(&save, 4, true).unwrap();
        assert!(resolved.groups[0].copies_differ);
        let mut edited = resolved.bytes.clone();
        edited[1] = 10;
        let output = layout.write_back(&save, &resolved, &edited, &[]).unwrap().0;
        assert_eq!(output, [1, 10, 3, 4, 1, 10, 9, 5]);
    }

    #[test]
    fn sparse_groups_preserve_unmapped_logical_bytes() {
        let mut layout = fixed_layout(WritePolicy::Selected, Selection::FirstValid);
        layout.groups[0].logical_offset = 2;
        layout.groups[0].logical_length = 2;
        let Copies::Fixed { candidates } = &mut layout.groups[0].copies else {
            unreachable!()
        };
        for candidate in candidates.iter_mut() {
            candidate.spans[0].logical_offset = 2;
            candidate.spans[0].length = 2;
        }
        candidates[0].spans[0].physical_offset = 2;
        candidates[0].signatures[0].offset = 2;
        candidates[0].counter.as_mut().unwrap().offset = 3;
        candidates[1].spans[0].physical_offset = 6;
        candidates[1].signatures[0].offset = 6;
        candidates[1].counter.as_mut().unwrap().offset = 7;
        let save = [0, 0, 1, 4, 0, 0, 1, 5];
        let resolved = layout.resolve(&save, save.len(), true).unwrap();
        assert_eq!(&resolved.bytes[..2], &save[..2]);
        let mut edited = resolved.bytes.clone();
        edited[0] = 9;
        edited[2] = 10;
        let output = layout.write_back(&save, &resolved, &edited, &[]).unwrap().0;
        assert_eq!(output[0], 9);
        assert_eq!(output[2], 10);
    }
}
