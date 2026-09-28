#[cfg(test)]
mod advanced_parity;
pub(super) mod catalog;
mod definition;
#[cfg(test)]
mod early_parity;
pub mod field;
pub mod generation;
#[cfg(test)]
#[path = "../../tests/unit/schema_catalog.rs"]
mod schema_catalog_tests;
#[cfg(test)]
mod tests;
use generation::{Generation, GenerationDefinition};
pub mod layout;
#[cfg(test)]
mod parity;
pub mod rules;
#[cfg(test)]
mod rules_tests;
pub mod runtime;
pub mod text;

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use tracing::trace;

use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityIssue, SaveIntegrityState, SaveRecognition,
    SaveRecognitionConfidence, SaveRecognitionOutcome, SaveRecognitionReason, SaveSection,
    SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

const MAX_FIELDS: usize = 4096;
const MAX_COMPONENTS: usize = 4096;
const MAX_INTEGRITY_BYTES: usize = 64 * 1024 * 1024;
const MAX_SAVE_SIZE: usize = 8 * 1024 * 1024;
const MAX_SECTIONS: usize = 128;
const MAX_TEXT: usize = 1024;
const MAX_GAME_ID: usize = 128;

#[derive(Clone, Debug)]
pub struct SchemaSaveHandler {
    game: Arc<GameSchema>,
}

impl SchemaSaveHandler {
    pub fn new(
        definition: GameDefinition,
        codecs: BTreeMap<String, text::TextCodec>,
    ) -> Result<Self> {
        let mut shared = BTreeMap::new();
        for (name, codec) in codecs {
            codec.validate(&name)?;
            shared.insert(name, Arc::new(codec));
        }
        let mut game = GameSchema::build(definition)?;
        for field in &mut game.fields {
            field.bind_codec(&shared)?;
        }
        game.validate_generation()?;
        Ok(Self {
            game: Arc::new(game),
        })
    }
}

impl SaveGameHandler for SchemaSaveHandler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        vec![self.game.definition()]
    }

    fn supports_generation(&self, game: &SaveGameIdentity) -> bool {
        self.game.matches(game) && self.game.generation.is_some()
    }

    fn generate(&self, game: &SaveGameIdentity) -> Result<Vec<u8>> {
        self.game.check_identity(game)?;
        self.game.generate_save()
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        if self.game.runtime.require_selection
            && input.selected_game.as_deref() != Some(&self.game.id)
        {
            return SaveRecognition {
                outcome: SaveRecognitionOutcome::Unsupported {
                    reasons: vec![SaveRecognitionReason::UnsupportedLayout],
                },
                candidates: Vec::new(),
                reasons: vec![SaveRecognitionReason::UnsupportedLayout],
            };
        }
        if self.game.runtime.recognition.is_some() {
            return self.game.recognize_configured(input);
        }
        let unsupported = |reason: SaveRecognitionReason| SaveRecognition {
            outcome: SaveRecognitionOutcome::Unsupported {
                reasons: vec![reason.clone()],
            },
            candidates: Vec::new(),
            reasons: vec![reason],
        };
        if input
            .selected_game
            .as_deref()
            .is_some_and(|id| id != self.game.id)
        {
            return unsupported(SaveRecognitionReason::UnsupportedLayout);
        }
        if input.bytes.len() != self.game.save_size {
            return unsupported(SaveRecognitionReason::WrongSize);
        }
        if self.game.signatures.is_empty()
            && self.game.checksums.is_empty()
            && input.selected_game.as_deref() != Some(self.game.id.as_str())
        {
            return unsupported(SaveRecognitionReason::UnsupportedLayout);
        }
        let Ok(resolved) = self.game.resolve(&input.bytes, false) else {
            return unsupported(SaveRecognitionReason::ChecksumMismatch);
        };
        let bytes = resolved
            .as_ref()
            .map_or(input.bytes.as_slice(), |layout| layout.bytes.as_slice());
        if !self.game.signatures_valid(bytes) {
            return unsupported(SaveRecognitionReason::InvalidSignature);
        }
        if !self.game.checksums_valid(bytes) || !self.game.mirrors_valid(bytes) {
            return unsupported(SaveRecognitionReason::ChecksumMismatch);
        }
        let mut reasons = Vec::new();
        if !self.game.checksums.is_empty() {
            reasons.push(SaveRecognitionReason::ChecksumValid);
        }
        if !self.game.signatures.is_empty() {
            reasons.push(SaveRecognitionReason::SignatureValid);
        }
        if reasons.is_empty() {
            reasons.push(SaveRecognitionReason::SelectedGame);
        }
        let candidate = SaveGameCandidate {
            identity: self.game.identity(),
            confidence: if input.selected_game.as_deref() == Some(self.game.id.as_str()) {
                SaveRecognitionConfidence::High
            } else {
                SaveRecognitionConfidence::Medium
            },
            reasons: reasons.clone(),
        };
        SaveRecognition {
            outcome: SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            candidates: vec![candidate],
            reasons,
        }
    }

    fn parse(&self, input: &SaveDetectionInput, game: &SaveGameIdentity) -> Result<SaveDocument> {
        self.game.check_identity(game)?;
        self.game.parse_document(input, game)
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        self.game.apply_edits(input, game, edits, dry_run)
    }
}

#[derive(Clone, Debug)]
pub struct GameDefinition {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub description: String,
    pub save_size: usize,
    pub fields: Vec<FieldDefinition>,
    pub signatures: Vec<SignatureDefinition>,
    pub checksums: Vec<ChecksumDefinition>,
    pub mirrors: Vec<MirrorDefinition>,
    pub generation: Option<GenerationDefinition>,
    pub runtime: runtime::Runtime,
}

#[derive(Clone, Debug)]
pub struct FieldDefinition {
    pub id: String,
    pub label: String,
    pub description: String,
    pub offset: usize,
    pub storage: Storage,
    pub bit: Option<u8>,
    pub length: Option<u8>,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub editable: Option<bool>,
    pub inverted: bool,
    pub copies: Vec<usize>,
    pub choices: Vec<FieldChoice>,
    pub mask: Option<u32>,
    pub behavior: field::FieldBehavior,
    pub array_guards: Vec<field::ArrayGuard>,
}

#[derive(Clone, Debug)]
pub struct FieldChoice {
    pub name: String,
    pub value: i64,
}

#[derive(Clone, Copy, Debug)]
pub enum Storage {
    U8,
    U16Le,
    U16Be,
    U24Le,
    U24Be,
    U32Le,
    U32Be,
    I8,
    I16Le,
    I16Be,
    I32Le,
    I32Be,
    Bool,
    Bit,
    Ascii,
    BcdLe,
    BcdBe,
}

#[derive(Clone, Debug)]
pub struct SignatureDefinition {
    pub offset: usize,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ChecksumDefinition {
    pub algorithm: ChecksumAlgorithm,
    pub start: Option<usize>,
    pub length: Option<usize>,
    pub spans: Vec<ChecksumSpan>,
    pub offset: usize,
    pub target: Option<u32>,
    pub unit: ChecksumUnit,
    pub exclude: Vec<ChecksumExclusion>,
}

#[derive(Clone, Copy, Debug)]
pub enum ChecksumAlgorithm {
    Sum8,
    Sum16Le,
    Sum16Be,
    Sum32Le,
    Sum32Be,
    Add8,
    Add16Le,
    Add16Be,
    Add32Le,
    Add32Be,
    Xor8,
    Xor16Le,
    Xor16Be,
    Xor32Le,
    Xor32Be,
    Sum8Mod255Complement,
    Sum32LeFold16,
    Crc16CcittFalseLe,
}

#[derive(Clone, Copy, Debug, Default)]
pub enum ChecksumUnit {
    #[default]
    U8,
    U16Le,
    U16Be,
    U32Le,
    U32Be,
}

#[derive(Clone, Debug)]
pub struct ChecksumExclusion {
    pub offset: usize,
    pub length: usize,
}

#[derive(Clone, Debug)]
pub struct ChecksumSpan {
    pub start: usize,
    pub length: usize,
}

#[derive(Clone, Debug)]
pub struct MirrorDefinition {
    pub source: usize,
    pub target: usize,
    pub length: usize,
    pub validate: Option<bool>,
}

#[derive(Clone, Debug)]
struct GameSchema {
    id: String,
    name: String,
    platform: String,
    save_size: usize,
    fields: Vec<FieldSchema>,
    signatures: Vec<SpanBytes>,
    checksums: Vec<Checksum>,
    mirrors: Vec<Mirror>,
    generation: Option<Generation>,
    runtime: runtime::Runtime,
}

#[derive(Clone, Debug)]
struct FieldSchema {
    id: String,
    label: String,
    description: String,
    offset: usize,
    storage: Storage,
    bit: Option<u8>,
    length: usize,
    min: i64,
    max: i64,
    editable: bool,
    inverted: bool,
    copies: Vec<usize>,
    choices: Vec<Choice>,
    mask: Option<u32>,
    behavior: field::FieldBehavior,
    codec: Option<Arc<text::TextCodec>>,
    array_guards: Vec<field::ArrayGuard>,
}

#[derive(Clone, Debug)]
struct Choice {
    name: String,
    value: i64,
}

#[derive(Clone, Debug)]
struct SpanBytes {
    offset: usize,
    bytes: Vec<u8>,
}
#[derive(Clone, Debug)]
struct Checksum {
    algorithm: ChecksumAlgorithm,
    spans: Vec<ChecksumSpan>,
    length: usize,
    offset: usize,
    target: u32,
    unit: ChecksumUnit,
    exclude: Vec<ChecksumExclusion>,
}
#[derive(Clone, Debug)]
struct Mirror {
    source: usize,
    target: usize,
    length: usize,
    validate: bool,
}
impl GameSchema {
    fn build(mut raw: GameDefinition) -> Result<Self> {
        validate_game_id(&raw.id)?;
        raw.runtime.expand(raw.save_size)?;
        raw.runtime.validate(raw.save_size)?;
        let logical_size = raw.runtime.logical_size.unwrap_or(raw.save_size);
        bounded_text(&raw.name, "game name")?;
        bounded_text(&raw.platform, "platform")?;
        bounded_text_allow_empty(&raw.description, "description")?;
        if raw.save_size == 0
            || raw.save_size > MAX_SAVE_SIZE
            || raw.save_size.div_ceil(65536) > MAX_SECTIONS
        {
            return Err(invalid(
                "schema save_size must use 1 to 128 64 KiB sections",
            ));
        }
        if raw.fields.len() > MAX_FIELDS {
            return Err(invalid("a game schema exceeds 4096 fields"));
        }
        if raw.signatures.len() > MAX_COMPONENTS
            || raw.checksums.len() > MAX_COMPONENTS
            || raw.mirrors.len() > MAX_COMPONENTS
        {
            return Err(invalid("a schema component array exceeds 4096 entries"));
        }
        let mut field_ids = HashSet::new();
        let mut fields = Vec::with_capacity(raw.fields.len());
        for field in raw.fields {
            if !field_ids.insert(field.id.clone()) {
                return Err(invalid("schema field IDs must be unique per game"));
            }
            if let Some(group) = &field.behavior.group
                && raw
                    .runtime
                    .layout
                    .as_ref()
                    .is_none_or(|layout| !layout.has_group(group))
            {
                return Err(invalid("a field references an unknown layout group"));
            }
            fields.push(FieldSchema::build(field, logical_size)?);
        }
        let mut storage_fields = Vec::new();
        for field in &fields {
            if field.behavior.format.is_some() {
                continue;
            }
            if storage_fields.len() + field.copies.len() + 1 > MAX_FIELDS {
                return Err(invalid(
                    "fields and their copies exceed 4096 storage locations",
                ));
            }
            for offset in std::iter::once(&field.offset).chain(&field.copies) {
                let mut stored = field.clone();
                stored.offset = *offset;
                stored.copies.clear();
                storage_fields.push(stored);
            }
        }
        validate_field_overlaps(&storage_fields)?;
        let signatures = raw
            .signatures
            .into_iter()
            .map(|value| {
                check_nonempty_span(value.offset, value.bytes.len(), logical_size, "signature")?;
                Ok(SpanBytes {
                    offset: value.offset,
                    bytes: value.bytes,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let checksums = raw
            .checksums
            .into_iter()
            .map(|value| Checksum::build(value, logical_size))
            .collect::<Result<Vec<_>>>()?;
        let mirrors = raw
            .mirrors
            .into_iter()
            .map(|value| Mirror::build(value, logical_size))
            .collect::<Result<Vec<_>>>()?;
        validate_reserved_overlaps(&storage_fields, &signatures, &checksums, &mirrors)?;
        let generation = raw
            .generation
            .map(|value| Generation::build(value, raw.save_size))
            .transpose()?;
        Ok(Self {
            id: raw.id,
            name: raw.name,
            platform: raw.platform,
            save_size: raw.save_size,
            fields,
            signatures,
            checksums,
            mirrors,
            generation,
            runtime: raw.runtime,
        })
    }

    fn identity(&self) -> SaveGameIdentity {
        SaveGameIdentity {
            id: self.id.clone(),
            name: self.name.clone(),
            family: self
                .runtime
                .family
                .clone()
                .unwrap_or_else(|| "schema-v1".into()),
        }
    }
    fn definition(&self) -> SaveGameDefinition {
        SaveGameDefinition {
            identity: self.identity(),
            platform: self.platform.clone(),
            save_format: self
                .runtime
                .save_format
                .clone()
                .unwrap_or_else(|| format!("schema:{}", self.id)),
            save_format_name: self
                .runtime
                .save_format_name
                .clone()
                .unwrap_or_else(|| self.name.clone()),
            handler_id: self
                .runtime
                .handler_id
                .clone()
                .unwrap_or_else(|| "schema-v1".into()),
            supported_save_sizes: vec![self.save_size as u32],
            known_rom_sha1: self.runtime.known_rom_sha1.clone(),
            checksum_sizes: self.runtime.checksum_sizes.clone(),
        }
    }
    fn matches(&self, game: &SaveGameIdentity) -> bool {
        *game == self.identity()
    }
    fn check_identity(&self, game: &SaveGameIdentity) -> Result<()> {
        if self.matches(game) {
            Ok(())
        } else {
            Err(validation(
                "save_game_mismatch",
                "the selected game does not match this schema",
            ))
        }
    }
    fn input(&self, bytes: Vec<u8>) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes,
            selected_game: Some(self.id.clone()),
            rom_sha1: None,
        }
    }

    fn parse_flat_document(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        resolved: Option<&layout::Resolved>,
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
        if input.bytes.len() != self.runtime.logical_size.unwrap_or(self.save_size) {
            return Err(validation(
                "save_size_invalid",
                "the save size does not match the schema",
            ));
        }
        let mut issues = Vec::new();
        if !self.signatures_valid(&input.bytes) {
            issues.push(issue(
                "signature_mismatch",
                "a schema signature does not match",
            ));
        }
        if !self.checksums_valid(&input.bytes) {
            issues.push(issue(
                "checksum_mismatch",
                "a schema checksum does not match",
            ));
        }
        if !self.mirrors_valid(&input.bytes) {
            issues.push(issue(
                "mirror_mismatch",
                "a schema mirror does not match its source",
            ));
        }
        let state = if !issues.is_empty() {
            SaveIntegrityState::Invalid
        } else if self.checksums.is_empty() {
            issues.push(issue(
                "checksums_absent",
                "this schema defines no checksums",
            ));
            SaveIntegrityState::ValidWithWarnings
        } else {
            SaveIntegrityState::Valid
        };
        let section_valid = !matches!(state, SaveIntegrityState::Invalid);
        let mut fields = Vec::new();
        for field in &self.fields {
            if field.behavior.group.as_deref().is_some_and(|id| {
                resolved.is_some_and(|layout| {
                    !layout
                        .groups
                        .iter()
                        .any(|group| group.id == id && group.selected.is_some())
                })
            }) {
                continue;
            }
            if field.present(&input.bytes)? {
                fields.push(field.to_field(&input.bytes)?);
            }
        }
        if matches!(state, SaveIntegrityState::Invalid) {
            for field in &mut fields {
                field.editable = false;
            }
        }
        let sections = (0..self.save_size.div_ceil(65536))
            .map(|id| SaveSection {
                id: id as u8,
                physical_offset: (id * 65536) as u32,
                checksum_expected: 0,
                checksum_actual: 0,
                signature: 0,
                counter: 0,
                valid: section_valid,
            })
            .collect();
        Ok(SaveDocument {
            identity: game.clone(),
            active_slot: 0,
            counter: 0,
            integrity: SaveIntegrity { state, issues },
            sections,
            fields,
            platform: self.platform.clone(),
            save_format: format!("schema:{}", self.id),
            save_format_name: self.name.clone(),
            handler_id: "schema-v1".into(),
            save_size: self.save_size as u32,
            warnings: if self.checksums.is_empty() {
                vec!["the schema defines no checksums".into()]
            } else {
                Vec::new()
            },
        })
    }
    fn signatures_valid(&self, bytes: &[u8]) -> bool {
        self.signatures
            .iter()
            .all(|s| bytes[s.offset..s.offset + s.bytes.len()] == s.bytes)
    }
    fn checksums_valid(&self, bytes: &[u8]) -> bool {
        self.checksums.iter().all(|c| c.valid(bytes))
    }
    fn mirrors_valid(&self, bytes: &[u8]) -> bool {
        self.mirrors.iter().all(|m| {
            !m.validate
                || bytes[m.source..m.source + m.length] == bytes[m.target..m.target + m.length]
        })
    }
    fn repair_integrity(&self, bytes: &mut [u8]) {
        for checksum in &self.checksums {
            checksum.repair(bytes);
        }
        for mirror in &self.mirrors {
            bytes.copy_within(mirror.source..mirror.source + mirror.length, mirror.target);
        }
    }
}

impl FieldSchema {
    fn build(raw: FieldDefinition, save_size: usize) -> Result<Self> {
        validate_field_id(&raw.id)?;
        bounded_text(&raw.label, "field label")?;
        bounded_text_allow_empty(&raw.description, "field description")?;
        let (storage_len, intrinsic_min, mut intrinsic_max) = raw.storage.properties(raw.length)?;
        if matches!(raw.storage, Storage::Bit) != raw.bit.is_some()
            || raw.bit.is_some_and(|bit| bit > 7)
        {
            return Err(invalid("only bit fields require a bit value from 0 to 7"));
        }
        if !matches!(
            raw.storage,
            Storage::Ascii | Storage::BcdLe | Storage::BcdBe
        ) && raw.length.is_some()
        {
            return Err(invalid("only ascii and BCD fields accept length"));
        }
        if raw.inverted && !matches!(raw.storage, Storage::Bool | Storage::Bit) {
            return Err(invalid("only boolean and bit fields accept inverted"));
        }
        if matches!(raw.storage, Storage::Bool | Storage::Bit | Storage::Ascii)
            && (raw.min.is_some() || raw.max.is_some())
        {
            return Err(invalid(
                "boolean, bit, and ascii fields do not accept min or max",
            ));
        }
        if let Some(mask) = raw.mask {
            if !raw.storage.is_unsigned_binary() {
                return Err(invalid(
                    "mask is allowed only on unsigned binary integer fields",
                ));
            }
            if mask == 0 {
                return Err(invalid(
                    "field mask must be nonzero, contiguous, and fit its storage",
                ));
            }
            let storage_mask = if storage_len == 4 {
                u32::MAX
            } else {
                (1u32 << (storage_len * 8)) - 1
            };
            let shifted = mask >> mask.trailing_zeros();
            if mask & !storage_mask != 0 || shifted & shifted.wrapping_add(1) != 0 {
                return Err(invalid(
                    "field mask must be nonzero, contiguous, and fit its storage",
                ));
            }
            intrinsic_max = i64::from(shifted);
        }
        raw.behavior.validate(save_size)?;
        for guard in &raw.array_guards {
            guard.count.validate(save_size)?;
        }
        if raw.behavior.format.is_some() && raw.editable.unwrap_or(true) {
            return Err(invalid("formatted fields must be read-only"));
        }
        check_span(raw.offset, storage_len, save_size, "field")?;
        if raw.copies.len() > MAX_FIELDS {
            return Err(invalid("field copies exceed 4096 entries"));
        }
        for offset in &raw.copies {
            check_span(*offset, storage_len, save_size, "field copy")?;
        }
        let min = raw.min.unwrap_or(intrinsic_min);
        let max = raw.max.unwrap_or(intrinsic_max);
        if min < intrinsic_min || max > intrinsic_max || min > max {
            return Err(invalid("field min and max must fit its storage type"));
        }
        if raw.choices.len() > MAX_FIELDS {
            return Err(invalid("field choices exceed 4096 entries"));
        }
        if !raw.choices.is_empty()
            && matches!(raw.storage, Storage::Bool | Storage::Bit | Storage::Ascii)
        {
            return Err(invalid("choices are allowed only on integer fields"));
        }
        let mut choice_names = HashSet::new();
        let mut choice_values = HashSet::new();
        for choice in &raw.choices {
            bounded_text(&choice.name, "choice name")?;
            if choice.name.starts_with("raw:") {
                return Err(invalid(
                    "choice names must not use the reserved raw: prefix",
                ));
            }
            if !choice_names.insert(&choice.name) || !choice_values.insert(choice.value) {
                return Err(invalid("choice names and values must be unique"));
            }
            if choice.value < min || choice.value > max {
                return Err(invalid("choice values must fit the field range"));
            }
        }
        Ok(Self {
            id: raw.id,
            label: raw.label,
            description: raw.description,
            offset: raw.offset,
            storage: raw.storage,
            bit: raw.bit,
            length: storage_len,
            min,
            max,
            editable: raw.editable.unwrap_or(true),
            inverted: raw.inverted,
            copies: raw.copies,
            choices: raw
                .choices
                .into_iter()
                .map(|choice| Choice {
                    name: choice.name,
                    value: choice.value,
                })
                .collect(),
            mask: raw.mask,
            behavior: raw.behavior,
            codec: None,
            array_guards: raw.array_guards,
        })
    }
    fn span(&self) -> (usize, usize) {
        (self.offset, self.offset + self.length)
    }
    fn byte_mask(&self, absolute_offset: usize) -> u8 {
        if absolute_offset < self.offset || absolute_offset >= self.offset + self.length {
            return 0;
        }
        if matches!(self.storage, Storage::Bit) {
            return 1 << self.bit.expect("validated bit");
        }
        let Some(mask) = self.mask else {
            return u8::MAX;
        };
        let byte_index = absolute_offset - self.offset;
        let shift = if matches!(
            self.storage,
            Storage::U16Be | Storage::U24Be | Storage::U32Be
        ) {
            (self.length - 1 - byte_index) * 8
        } else {
            byte_index * 8
        };
        (mask >> shift) as u8
    }
    fn to_field(&self, bytes: &[u8]) -> Result<SaveField> {
        let value = self.read(bytes)?;
        let kind = if !self.choices.is_empty() {
            SaveFieldKind::Enum
        } else {
            match self.storage {
                Storage::Ascii => {
                    if self.editable {
                        SaveFieldKind::Text
                    } else {
                        SaveFieldKind::ReadOnlyText
                    }
                }
                Storage::Bool => SaveFieldKind::Boolean,
                Storage::Bit => SaveFieldKind::BitfieldBoolean,
                Storage::I8 | Storage::I16Le | Storage::I16Be | Storage::I32Le | Storage::I32Be => {
                    if self.editable {
                        SaveFieldKind::SignedInteger
                    } else {
                        SaveFieldKind::ReadOnlyInteger
                    }
                }
                _ => {
                    if self.editable {
                        SaveFieldKind::UnsignedInteger
                    } else {
                        SaveFieldKind::ReadOnlyInteger
                    }
                }
            }
        };
        let mut choices = self
            .choices
            .iter()
            .map(|choice| choice.name.clone())
            .collect::<Vec<_>>();
        if let SaveValue::Enum(value) = &value
            && !choices.contains(value)
        {
            choices.push(value.clone());
        }
        let mut output = SaveField {
            id: self.id.clone(),
            label: self.label.clone(),
            section_id: (self.offset / 65536) as u8,
            offset: (self.offset % 65536) as u16,
            kind,
            value,
            editable: self.editable,
            constraints: SaveConstraint {
                min: (!matches!(self.storage, Storage::Bool | Storage::Bit | Storage::Ascii))
                    .then_some(self.min),
                max: (!matches!(self.storage, Storage::Bool | Storage::Bit | Storage::Ascii))
                    .then_some(self.max),
                max_length: matches!(self.storage, Storage::Ascii).then_some(self.length as u8),
                choices,
            },
            description: self.description.clone(),
            warnings: Vec::new(),
            step: Some(1),
            encoding: matches!(self.storage, Storage::Ascii).then(|| "ascii".into()),
        };
        if let Some(presentation) = &self.behavior.presentation {
            output.section_id = presentation.section_id;
            output.offset = presentation.offset;
            if let Some(kind) = &presentation.kind {
                output.kind = kind.clone();
            }
            if let Some(constraints) = &presentation.constraints {
                output.constraints = constraints.clone();
            }
            if let Some(step) = presentation.step {
                output.step = step;
            }
            if let Some(encoding) = &presentation.encoding {
                output.encoding = encoding.clone();
            }
            output.warnings = presentation.warnings.clone();
        }
        if self
            .behavior
            .editable_when
            .as_ref()
            .is_some_and(|predicate| !predicate.test(bytes).unwrap_or(false))
        {
            output.editable = false;
        }
        if let Some(override_) = &self.behavior.value_override
            && override_.when.test(bytes)?
        {
            if override_.read_only {
                output.editable = false;
            }
            if let Some(description) = &override_.description {
                output.description = description.clone();
            }
            if let Some(warnings) = &override_.warnings {
                output.warnings = warnings.clone();
            }
        }
        if let Some(unknown) = &self.behavior.unknown_choice
            && output.value == SaveValue::Enum(unknown.value.clone())
        {
            output.editable = false;
            output.warnings.push(unknown.warning.clone());
        }
        Ok(output)
    }
    fn read(&self, bytes: &[u8]) -> Result<SaveValue> {
        if let Some(value) = self.behavior.formatted(bytes)? {
            return Ok(value);
        }
        if let Some(override_) = &self.behavior.value_override
            && override_.when.test(bytes)?
        {
            return Ok(override_.value.clone());
        }
        let b = &bytes[self.offset..self.offset + self.length];
        if let Some(codec) = &self.codec {
            return codec.decode(b).map(SaveValue::Text);
        }
        let mut value = match self.storage {
            Storage::U8 => SaveValue::U32(b[0].into()),
            Storage::U16Le => SaveValue::U32(u16::from_le_bytes([b[0], b[1]]).into()),
            Storage::U16Be => SaveValue::U32(u16::from_be_bytes([b[0], b[1]]).into()),
            Storage::U24Le => SaveValue::U32(u32::from_le_bytes([b[0], b[1], b[2], 0])),
            Storage::U24Be => SaveValue::U32(u32::from_be_bytes([0, b[0], b[1], b[2]])),
            Storage::U32Le => SaveValue::U32(u32::from_le_bytes(b.try_into().expect("four bytes"))),
            Storage::U32Be => SaveValue::U32(u32::from_be_bytes(b.try_into().expect("four bytes"))),
            Storage::I8 => SaveValue::I32((b[0] as i8).into()),
            Storage::I16Le => SaveValue::I32(i16::from_le_bytes([b[0], b[1]]).into()),
            Storage::I16Be => SaveValue::I32(i16::from_be_bytes([b[0], b[1]]).into()),
            Storage::I32Le => SaveValue::I32(i32::from_le_bytes(b.try_into().expect("four bytes"))),
            Storage::I32Be => SaveValue::I32(i32::from_be_bytes(b.try_into().expect("four bytes"))),
            Storage::Bool => SaveValue::Bool((b[0] != 0) ^ self.inverted),
            Storage::Bit => SaveValue::Bool(
                (b[0] & (1 << self.bit.expect("validated bit")) != 0) ^ self.inverted,
            ),
            Storage::BcdLe | Storage::BcdBe => {
                let mut value = 0;
                for index in 0..b.len() {
                    let byte = b[if matches!(self.storage, Storage::BcdLe) {
                        b.len() - 1 - index
                    } else {
                        index
                    }];
                    if byte >> 4 > 9 || byte & 15 > 9 {
                        return Err(validation(
                            "save_bcd_encoding",
                            "the save contains an invalid BCD digit",
                        ));
                    }
                    value = value * 100 + u32::from(byte >> 4) * 10 + u32::from(byte & 15);
                }
                SaveValue::U32(value)
            }
            Storage::Ascii => {
                let end = b.iter().position(|byte| *byte == 0).unwrap_or(b.len());
                if !b[..end].iter().all(|byte| (0x20..=0x7e).contains(byte)) {
                    return Err(validation(
                        "save_text_encoding",
                        "the save contains non-printable ASCII",
                    ));
                }
                SaveValue::Text(String::from_utf8(b[..end].to_vec()).expect("ASCII is UTF-8"))
            }
        };
        if let Some(mask) = self.mask {
            let raw = match value {
                SaveValue::U32(value) => value,
                _ => unreachable!("mask storage was validated"),
            };
            value = SaveValue::U32((raw & mask) >> mask.trailing_zeros());
        }
        if let Some(xor) = &self.behavior.xor {
            let SaveValue::U32(raw) = value else {
                return Err(invalid("XOR requires unsigned integer storage"));
            };
            value = SaveValue::U32(raw ^ (xor.eval(bytes)? as u32));
        }
        if let Some(read) = &self.behavior.read {
            let raw = read.eval(bytes)?;
            value = match self.storage {
                Storage::Bool | Storage::Bit => SaveValue::Bool(raw != 0),
                Storage::I8 | Storage::I16Le | Storage::I16Be | Storage::I32Le | Storage::I32Be => {
                    SaveValue::I32(
                        i32::try_from(raw).map_err(|_| invalid("read expression exceeds i32"))?,
                    )
                }
                _ => SaveValue::U32(
                    u32::try_from(raw).map_err(|_| invalid("read expression exceeds u32"))?,
                ),
            };
        }
        if !self.choices.is_empty() {
            let numeric = match value {
                SaveValue::U32(value) => i64::from(value),
                SaveValue::I32(value) => i64::from(value),
                _ => unreachable!("choice storage was validated"),
            };
            let name = self
                .choices
                .iter()
                .find(|choice| choice.value == numeric)
                .map_or_else(
                    || {
                        self.behavior.unknown_choice.as_ref().map_or_else(
                            || format!("raw:{numeric}"),
                            |unknown| unknown.value.clone(),
                        )
                    },
                    |choice| choice.name.clone(),
                );
            value = SaveValue::Enum(name);
        }
        Ok(value)
    }
    fn write(&self, bytes: &mut [u8], value: &SaveValue) -> Result<()> {
        let transformed = if let Some(xor) = &self.behavior.xor {
            let SaveValue::U32(value) = value else {
                return Err(invalid("XOR writes require unsigned values"));
            };
            Some(SaveValue::U32(value ^ xor.eval(bytes)? as u32))
        } else {
            None
        };
        let value = transformed.as_ref().unwrap_or(value);
        for offset in std::iter::once(&self.offset).chain(&self.copies) {
            let destination = &mut bytes[*offset..*offset + self.length];
            if let Some(codec) = &self.codec {
                let SaveValue::Text(value) = value else {
                    return Err(invalid("text codec writes require text values"));
                };
                codec.encode(value, destination)?;
            } else {
                self.write_at(destination, value)?;
            }
        }
        for effect in &self.behavior.on_edit {
            effect.apply(bytes)?;
        }
        Ok(())
    }
    fn write_at(&self, dst: &mut [u8], value: &SaveValue) -> Result<()> {
        let normalized = if let SaveValue::Enum(name) = value {
            let choice_value = self
                .choices
                .iter()
                .find(|choice| choice.name == *name)
                .map(|choice| choice.value)
                .or_else(|| name.strip_prefix("raw:")?.parse().ok())
                .ok_or_else(|| {
                    validation(
                        "save_value_choice",
                        "the requested enum value is not allowed",
                    )
                })?;
            if choice_value < self.min || choice_value > self.max {
                return Err(validation(
                    "save_value_range",
                    "the requested save value is outside its allowed range",
                ));
            }
            Some(match self.storage {
                Storage::I8 | Storage::I16Le | Storage::I16Be | Storage::I32Le | Storage::I32Be => {
                    SaveValue::I32(choice_value as i32)
                }
                _ => SaveValue::U32(choice_value as u32),
            })
        } else {
            None
        };
        let value = normalized.as_ref().unwrap_or(value);
        if let Some(mask) = self.mask {
            let SaveValue::U32(value) = value else {
                return Err(validation(
                    "save_value_kind",
                    "the requested value has the wrong type",
                ));
            };
            let shifted = value << mask.trailing_zeros();
            if shifted & !mask != 0 {
                return Err(validation(
                    "save_value_range",
                    "the requested save value is outside its allowed range",
                ));
            }
            let existing = self.storage.read_unsigned(dst);
            self.storage
                .write_unsigned(dst, (existing & !mask) | shifted);
            return Ok(());
        }
        match (self.storage, value) {
            (Storage::U8, SaveValue::U32(v)) => dst[0] = *v as u8,
            (Storage::U16Le, SaveValue::U32(v)) => dst.copy_from_slice(&(*v as u16).to_le_bytes()),
            (Storage::U16Be, SaveValue::U32(v)) => dst.copy_from_slice(&(*v as u16).to_be_bytes()),
            (Storage::U24Le, SaveValue::U32(v)) => dst.copy_from_slice(&v.to_le_bytes()[..3]),
            (Storage::U24Be, SaveValue::U32(v)) => dst.copy_from_slice(&v.to_be_bytes()[1..]),
            (Storage::U32Le, SaveValue::U32(v)) => dst.copy_from_slice(&v.to_le_bytes()),
            (Storage::U32Be, SaveValue::U32(v)) => dst.copy_from_slice(&v.to_be_bytes()),
            (Storage::I8, SaveValue::I32(v)) => dst[0] = *v as i8 as u8,
            (Storage::I16Le, SaveValue::I32(v)) => dst.copy_from_slice(&(*v as i16).to_le_bytes()),
            (Storage::I16Be, SaveValue::I32(v)) => dst.copy_from_slice(&(*v as i16).to_be_bytes()),
            (Storage::I32Le, SaveValue::I32(v)) => dst.copy_from_slice(&v.to_le_bytes()),
            (Storage::I32Be, SaveValue::I32(v)) => dst.copy_from_slice(&v.to_be_bytes()),
            (Storage::Bool, SaveValue::Bool(v)) => dst[0] = u8::from(*v ^ self.inverted),
            (Storage::Bit, SaveValue::Bool(v)) => {
                let mask = 1 << self.bit.expect("validated bit");
                if *v ^ self.inverted {
                    dst[0] |= mask
                } else {
                    dst[0] &= !mask
                }
            }
            (Storage::BcdLe | Storage::BcdBe, SaveValue::U32(v)) => {
                let mut value = *v;
                for index in 0..dst.len() {
                    let offset = if matches!(self.storage, Storage::BcdLe) {
                        index
                    } else {
                        dst.len() - 1 - index
                    };
                    dst[offset] = (((value / 10 % 10) << 4) | (value % 10)) as u8;
                    value /= 100;
                }
            }
            (Storage::Ascii, SaveValue::Text(v)) => {
                if !v.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
                    return Err(validation(
                        "save_text_encoding",
                        "schema text must use printable ASCII",
                    ));
                }
                if v.len() > dst.len() {
                    return Err(validation("save_name_length", "schema text is too long"));
                }
                dst.fill(0);
                dst[..v.len()].copy_from_slice(v.as_bytes());
            }
            _ => {
                return Err(validation(
                    "save_value_kind",
                    "the requested value has the wrong type",
                ));
            }
        }
        Ok(())
    }
}

impl Storage {
    fn is_unsigned_binary(self) -> bool {
        matches!(
            self,
            Self::U8
                | Self::U16Le
                | Self::U16Be
                | Self::U24Le
                | Self::U24Be
                | Self::U32Le
                | Self::U32Be
        )
    }

    fn read_unsigned(self, bytes: &[u8]) -> u32 {
        match self {
            Self::U8 => bytes[0].into(),
            Self::U16Le => u16::from_le_bytes([bytes[0], bytes[1]]).into(),
            Self::U16Be => u16::from_be_bytes([bytes[0], bytes[1]]).into(),
            Self::U24Le => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], 0]),
            Self::U24Be => u32::from_be_bytes([0, bytes[0], bytes[1], bytes[2]]),
            Self::U32Le => u32::from_le_bytes(bytes.try_into().expect("four bytes")),
            Self::U32Be => u32::from_be_bytes(bytes.try_into().expect("four bytes")),
            _ => unreachable!("unsigned storage was validated"),
        }
    }

    fn write_unsigned(self, dst: &mut [u8], value: u32) {
        match self {
            Self::U8 => dst[0] = value as u8,
            Self::U16Le => dst.copy_from_slice(&(value as u16).to_le_bytes()),
            Self::U16Be => dst.copy_from_slice(&(value as u16).to_be_bytes()),
            Self::U24Le => dst.copy_from_slice(&value.to_le_bytes()[..3]),
            Self::U24Be => dst.copy_from_slice(&value.to_be_bytes()[1..]),
            Self::U32Le => dst.copy_from_slice(&value.to_le_bytes()),
            Self::U32Be => dst.copy_from_slice(&value.to_be_bytes()),
            _ => unreachable!("unsigned storage was validated"),
        }
    }

    fn properties(self, length: Option<u8>) -> Result<(usize, i64, i64)> {
        Ok(match self {
            Self::U8 => (1, 0, u8::MAX.into()),
            Self::U16Le | Self::U16Be => (2, 0, u16::MAX.into()),
            Self::U24Le | Self::U24Be => (3, 0, 0xff_ffff),
            Self::U32Le | Self::U32Be => (4, 0, u32::MAX.into()),
            Self::I8 => (1, i8::MIN.into(), i8::MAX.into()),
            Self::I16Le | Self::I16Be => (2, i16::MIN.into(), i16::MAX.into()),
            Self::I32Le | Self::I32Be => (4, i32::MIN.into(), i32::MAX.into()),
            Self::Bool | Self::Bit => (1, 0, 1),
            Self::BcdLe | Self::BcdBe => {
                let length = length
                    .filter(|length| (1..=4).contains(length))
                    .ok_or_else(|| invalid("BCD fields require a length from 1 to 4"))?;
                (length.into(), 0, 10i64.pow(u32::from(length) * 2) - 1)
            }
            Self::Ascii => {
                let value = length.ok_or_else(|| invalid("ascii fields require length"))?;
                if value == 0 {
                    return Err(invalid("ascii length must be from 1 to 255"));
                }
                (value.into(), 0, 0)
            }
        })
    }
}

impl ChecksumUnit {
    fn width(self) -> usize {
        match self {
            Self::U8 => 1,
            Self::U16Le | Self::U16Be => 2,
            Self::U32Le | Self::U32Be => 4,
        }
    }
    fn read(self, bytes: [u8; 4]) -> u32 {
        match self {
            Self::U8 => u32::from(bytes[0]),
            Self::U16Le => u16::from_le_bytes([bytes[0], bytes[1]]).into(),
            Self::U16Be => u16::from_be_bytes([bytes[0], bytes[1]]).into(),
            Self::U32Le => u32::from_le_bytes(bytes),
            Self::U32Be => u32::from_be_bytes(bytes),
        }
    }
}

impl ChecksumAlgorithm {
    fn width(self) -> usize {
        match self {
            Self::Sum8 | Self::Add8 | Self::Xor8 | Self::Sum8Mod255Complement => 1,
            Self::Sum32Le
            | Self::Sum32Be
            | Self::Add32Le
            | Self::Add32Be
            | Self::Xor32Le
            | Self::Xor32Be => 4,
            _ => 2,
        }
    }
    fn big_endian(self) -> bool {
        matches!(
            self,
            Self::Sum16Be
                | Self::Sum32Be
                | Self::Add16Be
                | Self::Add32Be
                | Self::Xor16Be
                | Self::Xor32Be
        )
    }
    fn mask(self) -> u32 {
        u32::MAX >> (8 * (4 - self.width()))
    }
}

impl Checksum {
    fn build(raw: ChecksumDefinition, size: usize) -> Result<Self> {
        let spans = match (raw.start, raw.length, raw.spans.is_empty()) {
            (Some(start), Some(length), true) => vec![ChecksumSpan { start, length }],
            (None, None, false) => raw.spans,
            _ => {
                return Err(invalid(
                    "checksum requires start/length or nonempty spans, exclusively",
                ));
            }
        };
        if spans.len() > MAX_COMPONENTS {
            return Err(invalid("checksum input spans exceed 4096 entries"));
        }
        let mut length = 0usize;
        let mut sorted_spans = Vec::new();
        for span in &spans {
            check_nonempty_span(span.start, span.length, size, "checksum input")?;
            if !span.length.is_multiple_of(raw.unit.width()) {
                return Err(invalid("checksum spans must contain complete input units"));
            }
            length = length
                .checked_add(span.length)
                .filter(|total| *total <= MAX_INTEGRITY_BYTES)
                .ok_or_else(|| invalid("checksum integrity work exceeds 64 MiB"))?;
            sorted_spans.push((span.start, span.start + span.length));
        }
        sorted_spans.sort_unstable();
        if sorted_spans.windows(2).any(|pair| pair[0].1 > pair[1].0) {
            return Err(invalid("checksum input spans must not overlap"));
        }
        check_span(raw.offset, raw.algorithm.width(), size, "checksum output")?;
        if matches!(
            raw.algorithm,
            ChecksumAlgorithm::Crc16CcittFalseLe | ChecksumAlgorithm::Sum8Mod255Complement
        ) && (raw.target.is_some() || !matches!(raw.unit, ChecksumUnit::U8))
        {
            return Err(invalid(
                "this checksum requires byte inputs and does not accept target",
            ));
        }
        if matches!(raw.algorithm, ChecksumAlgorithm::Sum32LeFold16)
            && (raw.target.is_some() || !matches!(raw.unit, ChecksumUnit::U32Le))
        {
            return Err(invalid(
                "sum32_le_fold16 requires u32_le input units and does not accept target",
            ));
        }
        if raw
            .target
            .is_some_and(|target| target > raw.algorithm.mask())
        {
            return Err(invalid("checksum target must fit its output width"));
        }
        if raw.exclude.len() > MAX_COMPONENTS {
            return Err(invalid("checksum exclusions exceed 4096 entries"));
        }
        let mut exclude = raw.exclude;
        exclude.sort_by_key(|span| span.offset);
        let mut previous_end = 0;
        for span in &exclude {
            check_nonempty_span(span.offset, span.length, size, "checksum exclusion")?;
            if span.offset < previous_end
                || !spans.iter().any(|input| {
                    span.offset >= input.start
                        && span.offset + span.length <= input.start + input.length
                })
            {
                return Err(invalid(
                    "checksum exclusions must be disjoint and inside its input",
                ));
            }
            previous_end = span.offset + span.length;
        }
        Ok(Self {
            algorithm: raw.algorithm,
            spans,
            length,
            offset: raw.offset,
            target: raw.target.unwrap_or(0),
            unit: raw.unit,
            exclude,
        })
    }
    fn width(&self) -> usize {
        self.algorithm.width()
    }
    fn reads_span(&self, span: (usize, usize)) -> bool {
        self.spans.iter().any(|input| {
            let mut cursor = input.start.max(span.0);
            let end = (input.start + input.length).min(span.1);
            if cursor >= end {
                return false;
            }
            for excluded in &self.exclude {
                if excluded.offset > cursor {
                    return true;
                }
                cursor = cursor.max(excluded.offset + excluded.length);
                if cursor >= end {
                    return false;
                }
            }
            true
        })
    }
    fn expected(&self, bytes: &[u8]) -> u32 {
        let input = self.spans.iter().flat_map(|span| {
            let mut excluded = self.exclude.iter().peekable();
            bytes[span.start..span.start + span.length]
                .iter()
                .enumerate()
                .map(move |(index, byte)| {
                    let offset = span.start + index;
                    while excluded
                        .peek()
                        .is_some_and(|span| span.offset + span.length <= offset)
                    {
                        excluded.next();
                    }
                    if excluded.peek().is_some_and(|span| span.offset <= offset) {
                        0
                    } else {
                        *byte
                    }
                })
        });
        if matches!(self.algorithm, ChecksumAlgorithm::Crc16CcittFalseLe) {
            return input
                .fold(0xffffu16, |mut crc, byte| {
                    crc ^= u16::from(byte) << 8;
                    for _ in 0..8 {
                        crc = if crc & 0x8000 != 0 {
                            (crc << 1) ^ 0x1021
                        } else {
                            crc << 1
                        };
                    }
                    crc
                })
                .into();
        }
        if matches!(self.algorithm, ChecksumAlgorithm::Sum8Mod255Complement) {
            return input.fold(0u32, |sum, byte| (sum + u32::from(byte)) % 255) ^ 255;
        }
        if matches!(self.algorithm, ChecksumAlgorithm::Sum32LeFold16) {
            let mut input = input;
            let mut sum = 0u32;
            for _ in 0..self.length / 4 {
                let word = u32::from_le_bytes([
                    input.next().expect("validated u32 unit"),
                    input.next().expect("validated u32 unit"),
                    input.next().expect("validated u32 unit"),
                    input.next().expect("validated u32 unit"),
                ]);
                sum = sum.wrapping_add(word);
            }
            return u32::from((sum as u16).wrapping_add((sum >> 16) as u16));
        }
        let xor = matches!(
            self.algorithm,
            ChecksumAlgorithm::Xor8
                | ChecksumAlgorithm::Xor16Le
                | ChecksumAlgorithm::Xor16Be
                | ChecksumAlgorithm::Xor32Le
                | ChecksumAlgorithm::Xor32Be
        );
        let mut input = input;
        let mut accumulated = 0u32;
        for _ in 0..self.length / self.unit.width() {
            let mut value = [0u8; 4];
            for byte in &mut value[..self.unit.width()] {
                *byte = input.next().expect("validated input unit");
            }
            let value = self.unit.read(value);
            accumulated = if xor {
                accumulated ^ value
            } else {
                accumulated.wrapping_add(value)
            };
        }
        let value = match self.algorithm {
            ChecksumAlgorithm::Sum8
            | ChecksumAlgorithm::Sum16Le
            | ChecksumAlgorithm::Sum16Be
            | ChecksumAlgorithm::Sum32Le
            | ChecksumAlgorithm::Sum32Be => self.target.wrapping_sub(accumulated),
            _ if xor => self.target ^ accumulated,
            _ => self.target.wrapping_add(accumulated),
        };
        value & self.algorithm.mask()
    }
    fn valid(&self, bytes: &[u8]) -> bool {
        let mut stored = [0u8; 4];
        let start = if self.algorithm.big_endian() {
            4 - self.width()
        } else {
            0
        };
        stored[start..start + self.width()]
            .copy_from_slice(&bytes[self.offset..self.offset + self.width()]);
        let value = if self.algorithm.big_endian() {
            u32::from_be_bytes(stored)
        } else {
            u32::from_le_bytes(stored)
        };
        value == self.expected(bytes)
    }
    fn repair(&self, bytes: &mut [u8]) {
        let value = self.expected(bytes);
        let stored = if self.algorithm.big_endian() {
            value.to_be_bytes()
        } else {
            value.to_le_bytes()
        };
        let start = if self.algorithm.big_endian() {
            4 - self.width()
        } else {
            0
        };
        bytes[self.offset..self.offset + self.width()]
            .copy_from_slice(&stored[start..start + self.width()]);
    }
}
impl Mirror {
    fn build(raw: MirrorDefinition, size: usize) -> Result<Self> {
        check_nonempty_span(raw.source, raw.length, size, "mirror source")?;
        check_nonempty_span(raw.target, raw.length, size, "mirror target")?;
        if overlaps(
            (raw.source, raw.source + raw.length),
            (raw.target, raw.target + raw.length),
        ) {
            return Err(invalid("mirror source and target must not overlap"));
        }
        Ok(Self {
            source: raw.source,
            target: raw.target,
            length: raw.length,
            validate: raw.validate.unwrap_or(true),
        })
    }
}
fn validate_field_overlaps(fields: &[FieldSchema]) -> Result<()> {
    let mut sorted = fields.iter().collect::<Vec<_>>();
    sorted.sort_unstable_by_key(|field| field.offset);
    let editable = sorted
        .iter()
        .copied()
        .filter(|field| field.editable)
        .collect::<Vec<_>>();
    for a in &sorted {
        let candidates = if a.editable { &sorted } else { &editable };
        let start = candidates.partition_point(|field| field.offset < a.offset);
        for b in candidates[start..]
            .iter()
            .take_while(|field| field.offset < a.offset + a.length)
        {
            if !std::ptr::eq(*a, *b)
                && (a.span().0.max(b.span().0)..a.span().1.min(b.span().1))
                    .any(|offset| a.byte_mask(offset) & b.byte_mask(offset) != 0)
            {
                return Err(invalid("editable schema field storage overlaps"));
            }
        }
    }
    Ok(())
}
fn validate_reserved_overlaps(
    fields: &[FieldSchema],
    signatures: &[SpanBytes],
    checksums: &[Checksum],
    mirrors: &[Mirror],
) -> Result<()> {
    let checksum_outputs: Vec<_> = checksums
        .iter()
        .map(|c| (c.offset, c.offset + c.width()))
        .collect();
    for (i, out) in checksum_outputs.iter().enumerate() {
        if fields.iter().any(|f| overlaps(*out, f.span()))
            || signatures
                .iter()
                .any(|s| overlaps(*out, (s.offset, s.offset + s.bytes.len())))
            || checksums.iter().any(|checksum| checksum.reads_span(*out))
            || checksum_outputs
                .iter()
                .enumerate()
                .any(|(j, other)| i != j && overlaps(*out, *other))
        {
            return Err(invalid("checksum output overlaps protected schema storage"));
        }
    }
    for signature in signatures {
        let span = (signature.offset, signature.offset + signature.bytes.len());
        if fields
            .iter()
            .any(|field| field.editable && overlaps(span, field.span()))
        {
            return Err(invalid("an editable field overlaps a signature"));
        }
    }
    for (i, m) in mirrors.iter().enumerate() {
        let target = (m.target, m.target + m.length);
        if fields.iter().any(|f| overlaps(target, f.span()))
            || signatures
                .iter()
                .any(|s| overlaps(target, (s.offset, s.offset + s.bytes.len())))
            || checksum_outputs.iter().any(|span| overlaps(target, *span))
            || checksums.iter().any(|checksum| checksum.reads_span(target))
            || mirrors.iter().enumerate().any(|(j, other)| {
                i != j
                    && (overlaps(target, (other.target, other.target + other.length))
                        || overlaps(target, (other.source, other.source + other.length)))
            })
        {
            return Err(invalid(
                "mirror targets overlap protected or chained storage",
            ));
        }
    }
    Ok(())
}
fn overlaps(a: (usize, usize), b: (usize, usize)) -> bool {
    a.0 < b.1 && b.0 < a.1
}
fn check_nonempty_span(offset: usize, length: usize, size: usize, name: &str) -> Result<()> {
    if length == 0 {
        return Err(invalid_owned(format!("{name} must not be empty")));
    }
    check_span(offset, length, size, name)
}
fn check_span(offset: usize, length: usize, size: usize, name: &str) -> Result<()> {
    if offset.checked_add(length).is_none_or(|end| end > size) {
        return Err(invalid_owned(format!("{name} is outside the save")));
    }
    Ok(())
}
fn bounded_text(value: &str, name: &str) -> Result<()> {
    if value.is_empty() {
        return Err(invalid_owned(format!("{name} must not be empty")));
    }
    bounded_text_allow_empty(value, name)
}
fn bounded_text_allow_empty(value: &str, name: &str) -> Result<()> {
    if value.len() > MAX_TEXT {
        return Err(invalid_owned(format!("{name} exceeds {MAX_TEXT} bytes")));
    }
    Ok(())
}
fn validate_game_id(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_GAME_ID
        || !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
    {
        return Err(invalid(
            "game IDs must be 1 to 128 bytes and match [a-z0-9][a-z0-9_-]*",
        ));
    }
    Ok(())
}
fn validate_field_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_TEXT
        || value.split('.').any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
    {
        return Err(invalid(
            "field IDs must contain nonempty ASCII alphanumeric, underscore, or hyphen segments separated by dots",
        ));
    }
    Ok(())
}
fn issue(code: &str, message: &str) -> SaveIntegrityIssue {
    SaveIntegrityIssue {
        code: code.into(),
        message: message.into(),
        section_id: None,
    }
}
fn invalid(message: &str) -> RomWeaverError {
    RomWeaverError::Validation(message.into())
}
fn invalid_owned(message: String) -> RomWeaverError {
    RomWeaverError::Validation(message)
}
fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

impl GameDefinition {
    pub fn new(id: String, name: String, platform: String, save_size: usize) -> Self {
        Self {
            id,
            name,
            platform,
            save_size,
            description: String::new(),
            fields: Vec::new(),
            signatures: Vec::new(),
            checksums: Vec::new(),
            mirrors: Vec::new(),
            generation: None,
            runtime: runtime::Runtime::default(),
        }
    }
}
impl FieldDefinition {
    pub fn new(id: String, label: String, offset: usize, storage: Storage) -> Self {
        Self {
            id,
            label,
            offset,
            storage,
            description: String::new(),
            bit: None,
            length: None,
            min: None,
            max: None,
            editable: None,
            inverted: false,
            copies: Vec::new(),
            choices: Vec::new(),
            mask: None,
            behavior: field::FieldBehavior::default(),
            array_guards: Vec::new(),
        }
    }
}
