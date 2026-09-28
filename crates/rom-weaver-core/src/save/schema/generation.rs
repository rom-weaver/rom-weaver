use std::collections::BTreeMap;

use tracing::debug;

use super::{
    GameSchema, MAX_COMPONENTS, SaveEdit, SaveIntegrityState, SaveValue, SpanBytes,
    check_nonempty_span, invalid, validate_field_id, validate_save_edits,
};
use crate::Result;

#[derive(Clone, Debug)]
pub struct GenerationDefinition {
    pub fill: u8,
    pub patches: Vec<InitialPatch>,
    pub values: BTreeMap<String, SaveValue>,
}

#[derive(Clone, Debug)]
pub struct InitialPatch {
    pub offset: usize,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(super) struct Generation {
    fill: u8,
    patches: Vec<SpanBytes>,
    values: BTreeMap<String, SaveValue>,
}

impl Generation {
    pub(super) fn build(raw: GenerationDefinition, size: usize) -> Result<Self> {
        if raw.patches.len() > MAX_COMPONENTS || raw.values.len() > MAX_COMPONENTS {
            return Err(invalid(
                "generation patches and values may each contain at most 4096 entries",
            ));
        }
        let patches = raw
            .patches
            .into_iter()
            .map(|patch| {
                check_nonempty_span(patch.offset, patch.bytes.len(), size, "generation patch")?;
                Ok(SpanBytes {
                    offset: patch.offset,
                    bytes: patch.bytes,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        for id in raw.values.keys() {
            validate_field_id(id)?;
        }
        Ok(Self {
            fill: raw.fill,
            patches,
            values: raw.values,
        })
    }

    fn initialize(&self, size: usize) -> Vec<u8> {
        let mut bytes = vec![self.fill; size];
        for patch in &self.patches {
            bytes[patch.offset..patch.offset + patch.bytes.len()].copy_from_slice(&patch.bytes);
        }
        bytes
    }
}

impl GameSchema {
    pub(super) fn validate_generation(&self) -> Result<()> {
        if self.generation.is_some() {
            self.generate_save()?;
        }
        Ok(())
    }

    pub(super) fn generate_save(&self) -> Result<Vec<u8>> {
        let generation = self.generation.as_ref().ok_or_else(|| {
            super::validation(
                "save_generation_unsupported",
                "this schema has no save initializer",
            )
        })?;
        let mut bytes = generation.initialize(self.save_size);
        let game = self.identity();
        let edits = generation
            .values
            .iter()
            .map(|(field, value)| SaveEdit {
                field: field.clone(),
                value: value.clone(),
            })
            .collect::<Vec<_>>();

        if self.runtime.layout.is_none() {
            for edit in &edits {
                let field = self
                    .fields
                    .iter()
                    .find(|field| field.id == edit.field)
                    .ok_or_else(|| {
                        super::validation(
                            "save_field_unknown",
                            "the requested save field does not exist",
                        )
                    })?;
                field.write(&mut bytes, &edit.value)?;
            }
            if !edits.is_empty() {
                for effect in &self.runtime.after_edit {
                    effect.apply(&mut bytes)?;
                }
                for check in self.runtime.checks.iter().chain(&self.runtime.edit_checks) {
                    check.run(&bytes)?;
                }
            }
            self.repair_integrity(&mut bytes);
            let document = self.valid_generation_document(&bytes, &game)?;
            validate_save_edits(&document, &edits)?;
            self.check_generation_round_trip(&document, &edits)?;
            debug!(game = %self.id, defaults = edits.len(), "generated schema save");
            return Ok(bytes);
        }

        // Layout initializers MUST already describe valid physical copies. Repairing
        // them here would require guessing which empty or invalid copy is active.
        self.valid_generation_document(&bytes, &game)?;
        if edits.is_empty() {
            return Ok(bytes);
        }
        let result = self.apply_edits(&self.input(bytes.clone()), &game, &edits, false)?;
        let bytes = result.bytes.unwrap_or(bytes);
        debug!(game = %self.id, defaults = edits.len(), "generated schema save");
        Ok(bytes)
    }

    fn valid_generation_document(
        &self,
        bytes: &[u8],
        game: &super::SaveGameIdentity,
    ) -> Result<super::SaveDocument> {
        let document = self.parse_document(&self.input(bytes.to_vec()), game)?;
        if matches!(
            document.integrity.state,
            SaveIntegrityState::Valid | SaveIntegrityState::ValidWithWarnings
        ) {
            return Ok(document);
        }
        Err(invalid(
            "the generation initializer failed schema integrity checks",
        ))
    }

    fn check_generation_round_trip(
        &self,
        document: &super::SaveDocument,
        edits: &[SaveEdit],
    ) -> Result<()> {
        for edit in edits {
            if document
                .fields
                .iter()
                .find(|field| field.id == edit.field)
                .map(|field| &field.value)
                != Some(&edit.value)
            {
                return Err(super::validation(
                    "save_edit_reparse_mismatch",
                    "the generated save did not produce the requested value",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "generation_tests.rs"]
mod tests;
