pub mod formats;
mod pokemon_gen2;
mod pokemon_gen3;
mod pokemon_gen4;
mod zelda_alttp;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

use crate::{Result, RomWeaverError, ValidationCodeError};

pub use pokemon_gen2::PokemonGen2Handler;
pub use pokemon_gen3::PokemonGen3Handler;
pub use pokemon_gen4::PokemonGen4Handler;
pub use zelda_alttp::ZeldaAlttpHandler;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveGameIdentity {
    pub id: String,
    pub name: String,
    pub family: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveGameDefinition {
    pub identity: SaveGameIdentity,
    pub platform: String,
    pub save_format: String,
    pub save_format_name: String,
    pub handler_id: String,
    pub supported_save_sizes: Vec<u32>,
    pub known_rom_sha1: Vec<String>,
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub checksum_sizes: Vec<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SaveRecognitionConfidence {
    Low,
    Medium,
    High,
}

pub type SaveConfidence = SaveRecognitionConfidence;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SaveRecognitionReason {
    ChecksumValid,
    SignatureValid,
    CounterUniform,
    SelectedGame,
    ChecksumMismatch,
    MissingSection,
    DuplicateSection,
    InvalidSignature,
    NonUniformCounter,
    WrongSize,
    UnsupportedLayout,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveGameCandidate {
    pub identity: SaveGameIdentity,
    pub confidence: SaveRecognitionConfidence,
    pub reasons: Vec<SaveRecognitionReason>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SaveRecognitionOutcome {
    Recognized { candidate: SaveGameCandidate },
    Ambiguous { candidates: Vec<SaveGameCandidate> },
    Unsupported { reasons: Vec<SaveRecognitionReason> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveRecognition {
    pub outcome: SaveRecognitionOutcome,
    pub candidates: Vec<SaveGameCandidate>,
    pub reasons: Vec<SaveRecognitionReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SaveIntegrityState {
    Valid,
    ValidWithWarnings,
    Invalid,
    PartiallyRecoverable,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveIntegrityIssue {
    pub code: String,
    pub message: String,
    pub section_id: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveIntegrity {
    pub state: SaveIntegrityState,
    pub issues: Vec<SaveIntegrityIssue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveSection {
    pub id: u8,
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub physical_offset: u32,
    pub checksum_expected: u16,
    pub checksum_actual: u16,
    pub signature: u32,
    pub counter: u32,
    pub valid: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SaveValue {
    Text(String),
    U32(u32),
    I32(i32),
    Bool(bool),
    Enum(String),
    List(Vec<SaveValue>),
    Table(Vec<BTreeMap<String, SaveValue>>),
    Object(BTreeMap<String, SaveValue>),
}

pub type SaveFieldValue = SaveValue;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SaveFieldKind {
    Text,
    UnsignedInteger,
    SignedInteger,
    Boolean,
    Enum,
    ReadOnlyText,
    ReadOnlyInteger,
    BitfieldBoolean,
    List,
    Table,
    Object,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveConstraint {
    #[cfg_attr(feature = "typescript-types", ts(type = "number | null"))]
    pub min: Option<i64>,
    #[cfg_attr(feature = "typescript-types", ts(type = "number | null"))]
    pub max: Option<i64>,
    pub max_length: Option<u8>,
    pub choices: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveField {
    pub id: String,
    pub label: String,
    pub section_id: u8,
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub offset: u16,
    pub kind: SaveFieldKind,
    pub value: SaveValue,
    pub editable: bool,
    pub constraints: SaveConstraint,
    pub description: String,
    pub warnings: Vec<String>,
    pub step: Option<u32>,
    pub encoding: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveDocument {
    pub identity: SaveGameIdentity,
    pub active_slot: u8,
    pub counter: u32,
    pub integrity: SaveIntegrity,
    pub sections: Vec<SaveSection>,
    pub fields: Vec<SaveField>,
    pub platform: String,
    pub save_format: String,
    pub save_format_name: String,
    pub handler_id: String,
    pub save_size: u32,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveFieldChange {
    pub field: String,
    pub old_value: SaveValue,
    pub new_value: SaveValue,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveEdit {
    pub field: String,
    pub value: SaveValue,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveChangePreview {
    pub changes: Vec<SaveFieldChange>,
    pub changed: bool,
    pub touched_sections: Vec<u8>,
    pub output_valid: bool,
    pub integrity_recalculated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveEditResult {
    pub preview: SaveChangePreview,
    pub bytes: Option<Vec<u8>>,
    pub document: SaveDocument,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub struct SaveDetectionInput {
    pub bytes: Vec<u8>,
    pub selected_game: Option<String>,
    pub rom_sha1: Option<String>,
}

pub trait SaveGameHandler: Send + Sync {
    fn definitions(&self) -> Vec<SaveGameDefinition>;
    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition;
    fn parse(&self, input: &SaveDetectionInput, game: &SaveGameIdentity) -> Result<SaveDocument>;
    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult>;
}

pub struct SaveGameRegistry {
    handlers: Vec<Box<dyn SaveGameHandler>>,
}

impl Default for SaveGameRegistry {
    fn default() -> Self {
        Self {
            handlers: vec![
                Box::new(PokemonGen2Handler),
                Box::new(PokemonGen3Handler),
                Box::new(PokemonGen4Handler),
                Box::new(ZeldaAlttpHandler),
            ],
        }
    }
}

impl SaveGameRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_handler(mut self, handler: impl SaveGameHandler + 'static) -> Self {
        self.handlers.push(Box::new(handler));
        self
    }

    pub fn definitions(&self) -> Vec<SaveGameDefinition> {
        self.handlers
            .iter()
            .flat_map(|handler| handler.definitions())
            .collect()
    }

    pub fn detect(&self, input: &SaveDetectionInput) -> SaveRecognition {
        let mut candidates = Vec::new();
        let mut reasons = Vec::new();
        for handler in &self.handlers {
            let recognition = handler.recognize(input);
            candidates.extend(recognition.candidates);
            if let SaveRecognitionOutcome::Unsupported { reasons: values } = recognition.outcome {
                reasons.extend(values);
            }
        }
        let outcome = match candidates.as_slice() {
            [candidate] => SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            [] => SaveRecognitionOutcome::Unsupported {
                reasons: reasons.clone(),
            },
            candidates => SaveRecognitionOutcome::Ambiguous {
                candidates: candidates.to_vec(),
            },
        };
        SaveRecognition {
            outcome,
            candidates,
            reasons,
        }
    }

    pub fn parse(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
    ) -> Result<SaveDocument> {
        self.handlers
            .iter()
            .find_map(|handler| {
                handler
                    .definitions()
                    .into_iter()
                    .any(|definition| definition.identity == *game)
                    .then(|| handler.parse(input, game))
            })
            .unwrap_or_else(|| {
                Err(validation(
                    "save_game_unsupported",
                    "the selected save game is unsupported",
                ))
            })
    }

    pub fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        self.handlers
            .iter()
            .find_map(|handler| {
                handler
                    .definitions()
                    .into_iter()
                    .any(|definition| definition.identity == *game)
                    .then(|| handler.apply(input, game, edits, dry_run))
            })
            .unwrap_or_else(|| {
                Err(validation(
                    "save_game_unsupported",
                    "the selected save game is unsupported",
                ))
            })
    }
}

pub fn detect_save(input: &SaveDetectionInput) -> SaveRecognition {
    SaveGameRegistry::default().detect(input)
}

pub fn parse_save(input: &SaveDetectionInput, game: &SaveGameIdentity) -> Result<SaveDocument> {
    SaveGameRegistry::default().parse(input, game)
}

pub fn apply_save_edits(
    input: &SaveDetectionInput,
    game: &SaveGameIdentity,
    edits: &[SaveEdit],
    dry_run: bool,
) -> Result<SaveEditResult> {
    SaveGameRegistry::default().apply(input, game, edits, dry_run)
}

pub fn validate_save_edits(
    document: &SaveDocument,
    edits: &[SaveEdit],
) -> Result<SaveChangePreview> {
    let mut touched = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut changes = Vec::with_capacity(edits.len());
    for edit in edits {
        if !seen.insert(&edit.field) {
            return Err(validation(
                "save_edit_conflict",
                "a save field can appear only once in an edit request",
            ));
        }
        let field = document
            .fields
            .iter()
            .find(|field| field.id == edit.field)
            .ok_or_else(|| {
                validation("save_field_unknown", "the requested save field is unknown")
            })?;
        if !field.editable {
            return Err(validation(
                "save_field_read_only",
                "the requested save field is read-only",
            ));
        }
        let correct_kind = matches!(
            (&field.kind, &edit.value),
            (SaveFieldKind::Text, SaveValue::Text(_))
                | (SaveFieldKind::UnsignedInteger, SaveValue::U32(_))
                | (SaveFieldKind::SignedInteger, SaveValue::I32(_))
                | (SaveFieldKind::Boolean, SaveValue::Bool(_))
                | (SaveFieldKind::BitfieldBoolean, SaveValue::Bool(_))
                | (SaveFieldKind::Enum, SaveValue::Enum(_))
                | (SaveFieldKind::List, SaveValue::List(_))
                | (SaveFieldKind::Table, SaveValue::Table(_))
                | (SaveFieldKind::Object, SaveValue::Object(_))
        );
        if !correct_kind {
            return Err(validation(
                "save_value_kind",
                "the requested value has the wrong type",
            ));
        }
        let integer = match edit.value {
            SaveValue::U32(value) => Some(i64::from(value)),
            SaveValue::I32(value) => Some(i64::from(value)),
            _ => None,
        };
        if integer.is_some_and(|value| {
            field.constraints.min.is_some_and(|min| value < min)
                || field.constraints.max.is_some_and(|max| value > max)
        }) {
            return Err(validation(
                "save_value_range",
                "the requested save value is outside its allowed range",
            ));
        }
        if let SaveValue::Text(value) = &edit.value
            && field
                .constraints
                .max_length
                .is_some_and(|max| value.chars().count() > usize::from(max))
        {
            return Err(validation(
                "save_name_length",
                "the requested text is too long",
            ));
        }
        if let SaveValue::Enum(value) = &edit.value
            && !field.constraints.choices.is_empty()
            && !field
                .constraints
                .choices
                .iter()
                .any(|choice| choice == value)
        {
            return Err(validation(
                "save_value_choice",
                "the requested enum value is not allowed",
            ));
        }
        if !touched.contains(&field.section_id) {
            touched.push(field.section_id);
        }
        changes.push(SaveFieldChange {
            field: edit.field.clone(),
            old_value: field.value.clone(),
            new_value: edit.value.clone(),
        });
    }
    touched.sort_unstable();
    let changed = changes
        .iter()
        .any(|change| change.old_value != change.new_value);
    Ok(SaveChangePreview {
        changes,
        changed,
        touched_sections: touched,
        output_valid: true,
        integrity_recalculated: changed,
    })
}

fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

#[cfg(test)]
#[path = "../../tests/unit/save.rs"]
mod tests;
