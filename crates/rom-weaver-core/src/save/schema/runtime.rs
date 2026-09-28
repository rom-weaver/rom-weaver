use serde::Deserialize;

use super::{
    layout::{Layout, Resolved},
    rules::{Check, Store},
    *,
};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Runtime {
    pub family: Option<String>,
    pub handler_id: Option<String>,
    pub save_format: Option<String>,
    pub save_format_name: Option<String>,
    #[serde(default)]
    pub known_rom_sha1: Vec<String>,
    #[serde(default)]
    pub checksum_sizes: Vec<u16>,
    pub logical_size: Option<usize>,
    pub layout: Option<Layout>,
    pub recognition: Option<Recognition>,
    #[serde(default)]
    pub checks: Vec<Check>,
    #[serde(default)]
    pub document_checks: Vec<Check>,
    #[serde(default)]
    pub edit_checks: Vec<Check>,
    #[serde(default)]
    pub after_edit: Vec<Store>,
    pub recovery: Option<Recovery>,
    #[serde(default)]
    pub include_implicit_changes: bool,
    #[serde(default)]
    pub all_copy_sections: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Recognition {
    #[serde(default)]
    pub checks: Vec<Check>,
    pub reasons: Vec<SaveRecognitionReason>,
    pub confidence: SaveRecognitionConfidence,
    pub incomplete_confidence: Option<SaveRecognitionConfidence>,
    #[serde(default)]
    pub selected_reason: bool,
    #[serde(default)]
    pub empty_top_level_reasons: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Recovery {
    pub no_valid: Failure,
    pub incomplete: Option<RecoveryOutcome>,
    pub damaged: Option<RecoveryOutcome>,
    pub unrecoverable: Option<RecoveryOutcome>,
    pub differing: Option<RecoveryOutcome>,
    #[serde(default)]
    pub active_group: bool,
    #[serde(default)]
    pub zero_counter: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    pub fn error(&self) -> RomWeaverError {
        RomWeaverError::ValidationCode(
            ValidationCodeError::new(self.code.clone()).with_message(self.message.clone()),
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecoveryOutcome {
    pub state: SaveIntegrityState,
    #[serde(default)]
    pub disable_editing: bool,
    pub issue: Option<Failure>,
    pub warning: Option<String>,
    pub field_warning: Option<String>,
    pub edit_error: Option<Failure>,
    pub parse_error: Option<Failure>,
    #[serde(default)]
    pub section_id: bool,
}

impl Runtime {
    pub fn work_bytes(&self) -> Result<usize> {
        rules::sum_work(
            self.checks
                .iter()
                .chain(&self.document_checks)
                .chain(&self.edit_checks)
                .chain(self.recognition.iter().flat_map(|config| &config.checks))
                .map(Check::work_bytes)
                .chain(self.after_edit.iter().map(Store::work_bytes)),
        )
    }
    /// Expands the check and layout shorthands before validation.
    pub fn expand(&mut self, save_size: usize) -> Result<()> {
        if let Some(layout) = &mut self.layout {
            layout.expand()?;
        }
        let size = self.logical_size.unwrap_or(save_size);
        for checks in [
            &mut self.checks,
            &mut self.document_checks,
            &mut self.edit_checks,
        ]
        .into_iter()
        .chain(self.recognition.iter_mut().map(|config| &mut config.checks))
        {
            rules::expand_checks(checks, size)?;
        }
        Ok(())
    }
    pub fn validate(&self, save_size: usize) -> Result<()> {
        let size = self.logical_size.unwrap_or(save_size);
        if size == 0 || size > MAX_SAVE_SIZE {
            return Err(invalid("logical_size exceeds the schema limit"));
        }
        if let Some(layout) = &self.layout {
            layout.validate(save_size, size)?;
        }
        if self.layout.is_none() && size != save_size {
            return Err(invalid("logical_size requires a layout"));
        }
        for text in [
            &self.family,
            &self.handler_id,
            &self.save_format,
            &self.save_format_name,
        ]
        .into_iter()
        .flatten()
        {
            bounded_text(text, "game metadata")?;
        }
        for checks in [&self.checks, &self.document_checks, &self.edit_checks] {
            if checks.len() > MAX_COMPONENTS {
                return Err(invalid("game checks exceed 4096 entries"));
            }
            for check in checks {
                check.validate(size)?;
            }
        }
        if let Some(recognition) = &self.recognition {
            if recognition.checks.len() > MAX_COMPONENTS || recognition.reasons.len() > 16 {
                return Err(invalid("recognition rules exceed their limits"));
            }
            for check in &recognition.checks {
                check.validate(size)?;
            }
        }
        if self.known_rom_sha1.len() > MAX_COMPONENTS || self.checksum_sizes.len() > MAX_COMPONENTS
        {
            return Err(invalid("game metadata arrays exceed 4096 entries"));
        }
        for hash in &self.known_rom_sha1 {
            if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid(
                    "known_rom_sha1 entries must contain 40 hexadecimal digits",
                ));
            }
        }
        if let Some(recovery) = &self.recovery {
            bounded_text(&recovery.no_valid.code, "recovery error code")?;
            bounded_text(&recovery.no_valid.message, "recovery error message")?;
            for outcome in [
                &recovery.incomplete,
                &recovery.damaged,
                &recovery.unrecoverable,
                &recovery.differing,
            ]
            .into_iter()
            .flatten()
            {
                for error in [&outcome.issue, &outcome.edit_error, &outcome.parse_error]
                    .into_iter()
                    .flatten()
                {
                    bounded_text(&error.code, "recovery error code")?;
                    bounded_text(&error.message, "recovery error message")?;
                }
                for text in [&outcome.warning, &outcome.field_warning]
                    .into_iter()
                    .flatten()
                {
                    bounded_text(text, "recovery warning")?;
                }
            }
        }
        if self.after_edit.len() > MAX_COMPONENTS {
            return Err(invalid("game write effects exceed 4096 entries"));
        }
        for effect in &self.after_edit {
            effect.validate(size)?;
        }
        Ok(())
    }
}

impl GameSchema {
    pub(super) fn recognize_configured(&self, input: &SaveDetectionInput) -> SaveRecognition {
        let config = self
            .runtime
            .recognition
            .as_ref()
            .expect("configured recognition");
        let unsupported = |reason: SaveRecognitionReason| SaveRecognition {
            outcome: SaveRecognitionOutcome::Unsupported {
                reasons: vec![reason.clone()],
            },
            candidates: Vec::new(),
            reasons: vec![reason],
        };
        if input.bytes.len() != self.save_size {
            return unsupported(SaveRecognitionReason::WrongSize);
        }
        if input
            .selected_game
            .as_deref()
            .is_some_and(|id| id != self.id)
        {
            return unsupported(SaveRecognitionReason::UnsupportedLayout);
        }
        let Ok(resolved) = self.resolve(&input.bytes, false) else {
            return unsupported(SaveRecognitionReason::ChecksumMismatch);
        };
        if resolved
            .as_ref()
            .is_some_and(|layout| layout.groups.iter().all(|group| group.selected.is_none()))
        {
            return unsupported(SaveRecognitionReason::ChecksumMismatch);
        }
        let bytes = resolved
            .as_ref()
            .map_or(input.bytes.as_slice(), |layout| layout.bytes.as_slice());
        if config.checks.iter().any(|check| check.run(bytes).is_err())
            || !self.signatures_valid(bytes)
            || !self.checksums_valid(bytes)
            || !self.mirrors_valid(bytes)
        {
            return unsupported(SaveRecognitionReason::ChecksumMismatch);
        }
        let incomplete = resolved.as_ref().is_some_and(|layout| {
            layout
                .groups
                .iter()
                .filter(|group| group.copies.iter().any(|copy| !copy.empty))
                .any(|group| group.copies.iter().any(|copy| !copy.valid))
        });
        let mut reasons = config.reasons.clone();
        if config.selected_reason && input.selected_game.is_some() {
            reasons.push(SaveRecognitionReason::SelectedGame);
        }
        let candidate = SaveGameCandidate {
            identity: self.identity(),
            confidence: if incomplete {
                config.incomplete_confidence.unwrap_or(config.confidence)
            } else {
                config.confidence
            },
            reasons: reasons.clone(),
        };
        SaveRecognition {
            outcome: SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            candidates: vec![candidate],
            reasons: if config.empty_top_level_reasons {
                Vec::new()
            } else {
                reasons
            },
        }
    }
    pub(super) fn resolve(
        &self,
        bytes: &[u8],
        selection_required: bool,
    ) -> Result<Option<Resolved>> {
        if bytes.len() != self.save_size {
            return Err(validation(
                "save_wrong_size",
                "the save size does not match the schema",
            ));
        }
        self.runtime
            .layout
            .as_ref()
            .map(|layout| {
                layout.resolve(
                    bytes,
                    self.runtime.logical_size.unwrap_or(self.save_size),
                    selection_required,
                )
            })
            .transpose()
    }

    pub(super) fn parse_document(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
    ) -> Result<SaveDocument> {
        if input
            .selected_game
            .as_deref()
            .is_some_and(|id| id != self.id)
        {
            return Err(validation(
                "save_game_mismatch",
                "the selected game does not match this schema",
            ));
        }
        let resolved = self.resolve(&input.bytes, true)?;
        let bytes = resolved
            .as_ref()
            .map_or(input.bytes.as_slice(), |layout| layout.bytes.as_slice());
        for check in &self.runtime.checks {
            check.run(bytes)?;
        }
        let mut output =
            self.parse_flat_document(&self.input(bytes.to_vec()), game, resolved.as_ref())?;
        if let Some(layout) = &resolved {
            if layout.groups.iter().all(|group| group.selected.is_none()) {
                return Err(self.runtime.recovery.as_ref().map_or_else(
                    || validation("save_integrity_invalid", "the save has no valid copy"),
                    |policy| policy.no_valid.error(),
                ));
            }
            output.integrity = SaveIntegrity {
                state: SaveIntegrityState::Valid,
                issues: Vec::new(),
            };
            output.warnings.clear();
            output.sections = layout
                .groups
                .iter()
                .filter_map(|group| group.selected.map(|index| &group.copies[index]))
                .flat_map(|copy| copy.sections.clone())
                .collect();
            if self.runtime.all_copy_sections {
                output.sections = layout
                    .groups
                    .iter()
                    .flat_map(|group| group.copies.iter())
                    .flat_map(|copy| copy.sections.clone())
                    .collect();
            }
            output.fields.retain(|field| {
                self.fields
                    .iter()
                    .find(|definition| definition.id == field.id)
                    .and_then(|definition| definition.behavior.group.as_deref())
                    .is_none_or(|id| {
                        layout
                            .groups
                            .iter()
                            .any(|group| group.id == id && group.selected.is_some())
                    })
            });
            if let Some(policy) = &self.runtime.recovery {
                let first = layout
                    .groups
                    .iter()
                    .enumerate()
                    .find(|(_, group)| group.selected.is_some())
                    .ok_or_else(|| policy.no_valid.error())?;
                let selected = first.1.selected.expect("selected group");
                output.active_slot = if policy.active_group {
                    first.0 as u8
                } else {
                    selected as u8
                };
                if policy.active_group {
                    for field in &mut output.fields {
                        if let Some(group_id) = self
                            .fields
                            .iter()
                            .find(|definition| definition.id == field.id)
                            .and_then(|definition| definition.behavior.group.as_deref())
                            && let Some(index) =
                                layout.groups.iter().position(|group| group.id == group_id)
                        {
                            field.section_id = index as u8;
                        }
                    }
                }
                output.counter = if policy.zero_counter {
                    0
                } else {
                    first.1.copies[selected].counter.unwrap_or(0)
                };
                for (index, group) in layout.groups.iter().enumerate() {
                    let nonempty = group.copies.iter().any(|copy| !copy.empty);
                    let invalid = group.copies.iter().any(|copy| !copy.valid);
                    let damaged = group.copies.iter().any(|copy| !copy.valid && !copy.empty);
                    let outcome = if group.selected.is_none() && nonempty {
                        &policy.unrecoverable
                    } else if group.selected.is_some() && damaged {
                        &policy.damaged
                    } else if group.selected.is_some() && invalid {
                        &policy.incomplete
                    } else if group.copies_differ {
                        &policy.differing
                    } else {
                        continue;
                    };
                    if let Some(outcome) = outcome {
                        apply_recovery(&mut output, outcome, index)?;
                    }
                }
            }
        }
        for check in &self.runtime.document_checks {
            if check.run(bytes).is_err() {
                output.integrity.state = SaveIntegrityState::Invalid;
                output.integrity.issues.push(SaveIntegrityIssue {
                    code: check.code.clone(),
                    message: check.message.clone(),
                    section_id: check.section_id,
                });
                if let Some(warning) = &check.warning
                    && !output.warnings.contains(warning)
                {
                    output.warnings.push(warning.clone());
                }
                for field in &mut output.fields {
                    field.editable = false;
                }
            }
        }
        let definition = self.definition();
        output.platform = definition.platform;
        output.save_format = definition.save_format;
        output.save_format_name = definition.save_format_name;
        output.handler_id = definition.handler_id;
        output.save_size = self.save_size as u32;
        Ok(output)
    }

    pub(super) fn apply_edits(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        self.check_identity(game)?;
        let resolved = self.resolve(&input.bytes, true)?;
        let original = resolved
            .as_ref()
            .map_or(input.bytes.as_slice(), |layout| layout.bytes.as_slice());
        let document = self.parse_document(input, game)?;
        if let (Some(layout), Some(policy)) = (&resolved, &self.runtime.recovery) {
            for group in &layout.groups {
                let nonempty = group.copies.iter().any(|copy| !copy.empty);
                let invalid = group.copies.iter().any(|copy| !copy.valid);
                let damaged = group.copies.iter().any(|copy| !copy.valid && !copy.empty);
                let outcome = if group.selected.is_none() && nonempty {
                    &policy.unrecoverable
                } else if group.selected.is_some() && damaged {
                    &policy.damaged
                } else if group.selected.is_some() && invalid {
                    &policy.incomplete
                } else {
                    continue;
                };
                if let Some(error) = outcome
                    .as_ref()
                    .and_then(|outcome| outcome.edit_error.as_ref())
                {
                    return Err(error.error());
                }
            }
        }
        for check in &self.runtime.edit_checks {
            check.run(original)?;
        }
        if !matches!(
            document.integrity.state,
            SaveIntegrityState::Valid | SaveIntegrityState::ValidWithWarnings
        ) {
            return Err(validation(
                "save_integrity_invalid",
                "the save failed schema integrity checks",
            ));
        }
        let mut preview = validate_save_edits(&document, edits)?;
        if !preview.changed {
            return Ok(SaveEditResult {
                preview,
                bytes: None,
                document,
            });
        }
        let mut logical = original.to_vec();
        let mut touched = Vec::new();
        for edit in edits {
            let field = self
                .fields
                .iter()
                .find(|field| field.id == edit.field)
                .expect("validated schema field");
            field.write(&mut logical, &edit.value)?;
            if let Some(group) = &field.behavior.group
                && !touched.contains(group)
            {
                touched.push(group.clone());
            }
        }
        for effect in &self.runtime.after_edit {
            effect.apply(&mut logical)?;
        }
        for check in self
            .runtime
            .checks
            .iter()
            .chain(&self.runtime.edit_checks)
            .chain(&self.runtime.document_checks)
        {
            check.run(&logical)?;
        }
        self.repair_integrity(&mut logical);
        let bytes = if let (Some(layout), Some(resolved)) = (&self.runtime.layout, &resolved) {
            let (bytes, sections) =
                layout.write_back(&input.bytes, resolved, &logical, &touched)?;
            preview.touched_sections.extend(sections);
            preview.touched_sections.sort_unstable();
            preview.touched_sections.dedup();
            bytes
        } else {
            logical
        };
        if self.runtime.layout.is_none() && self.runtime.handler_id.is_none() {
            preview.touched_sections = input
                .bytes
                .iter()
                .zip(&bytes)
                .enumerate()
                .filter_map(|(offset, (before, after))| {
                    (before != after).then_some((offset / 65536) as u8)
                })
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            preview.touched_sections.sort_unstable();
        }
        let output = self.parse_document(&self.input(bytes.clone()), game)?;
        if !matches!(
            output.integrity.state,
            SaveIntegrityState::Valid | SaveIntegrityState::ValidWithWarnings
        ) {
            return Err(invalid("the edited save failed schema integrity checks"));
        }
        for edit in edits {
            if output
                .fields
                .iter()
                .find(|field| field.id == edit.field)
                .map(|field| &field.value)
                != Some(&edit.value)
            {
                return Err(validation(
                    "save_edit_reparse_mismatch",
                    "the edited save did not produce the requested value",
                ));
            }
        }
        if self.runtime.include_implicit_changes {
            for field in &output.fields {
                if edits.iter().any(|edit| edit.field == field.id) {
                    continue;
                }
                if let Some(old) = document.fields.iter().find(|old| old.id == field.id)
                    && old.value != field.value
                {
                    preview.changes.push(super::super::SaveFieldChange {
                        field: field.id.clone(),
                        old_value: old.value.clone(),
                        new_value: field.value.clone(),
                    });
                }
            }
        }
        trace!(game = %self.id, edits = edits.len(), dry_run, "applied schema save edits");
        Ok(SaveEditResult {
            preview,
            bytes: (!dry_run).then_some(bytes),
            document: output,
        })
    }
}

fn apply_recovery(
    document: &mut SaveDocument,
    outcome: &RecoveryOutcome,
    index: usize,
) -> Result<()> {
    if let Some(error) = &outcome.parse_error {
        return Err(error.error());
    }
    let render = |text: &str| text.replace("{slot}", &(index + 1).to_string());
    let severity = |state: &SaveIntegrityState| match state {
        SaveIntegrityState::Valid => 0,
        SaveIntegrityState::ValidWithWarnings => 1,
        SaveIntegrityState::PartiallyRecoverable => 2,
        _ => 3,
    };
    if severity(&outcome.state) > severity(&document.integrity.state) {
        document.integrity.state = outcome.state;
    }
    if let Some(issue) = &outcome.issue {
        document.integrity.issues.push(SaveIntegrityIssue {
            code: issue.code.clone(),
            message: render(&issue.message),
            section_id: outcome.section_id.then_some(index as u8),
        });
    }
    if let Some(warning) = &outcome.warning {
        let warning = render(warning);
        if !document.warnings.contains(&warning) {
            document.warnings.push(warning);
        }
    }
    for field in &mut document.fields {
        let was_editable = field.editable;
        if outcome.disable_editing {
            field.editable = false;
        }
        if let Some(warning) = &outcome.field_warning
            && was_editable
        {
            let warning = render(warning);
            if !field.warnings.contains(&warning) {
                field.warnings.push(warning);
            }
        }
    }
    Ok(())
}
