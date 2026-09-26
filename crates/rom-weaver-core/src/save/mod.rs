mod container;
pub mod formats;
mod pokemon_gen1;
mod pokemon_gen2;
mod pokemon_gen3;
mod pokemon_gen4;
mod pokemon_gen5;
mod schema;
mod super_mario_world;
mod zelda_alttp;

use std::borrow::Cow;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

use crate::{Result, RomWeaverError, ValidationCodeError};

pub use container::{SaveContainer, SaveContainerKind, unwrap_save_container};
pub use formats::{
    SaveFormatCandidate, SaveFormatDefinition, all_save_formats, candidate_save_formats,
};
pub use pokemon_gen1::PokemonGen1Handler;
pub use pokemon_gen2::PokemonGen2Handler;
pub use pokemon_gen3::PokemonGen3Handler;
pub use pokemon_gen4::PokemonGen4Handler;
pub use pokemon_gen5::PokemonGen5Handler;
pub use schema::{SaveSchemaPack, SchemaSaveHandler};
pub use super_mario_world::SuperMarioWorldHandler;
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
    fn supports_generation(&self, _game: &SaveGameIdentity) -> bool {
        false
    }
    fn generate(&self, _game: &SaveGameIdentity) -> Result<Vec<u8>> {
        Err(validation(
            "save_generation_unsupported",
            "fresh save generation is unsupported for this game; use an existing save as a template",
        ))
    }
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
                Box::new(PokemonGen1Handler),
                Box::new(PokemonGen5Handler),
                Box::new(SuperMarioWorldHandler),
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

    /// Loads a data-only schema pack without replacing registered game handlers.
    pub fn with_schema_pack_json(mut self, bytes: &[u8]) -> Result<Self> {
        let pack = SaveSchemaPack::from_json(bytes)?;
        let mut ids = self
            .definitions()
            .into_iter()
            .map(|definition| definition.identity.id)
            .collect::<std::collections::HashSet<_>>();
        for handler in pack.into_handlers() {
            for definition in handler.definitions() {
                if !ids.insert(definition.identity.id) {
                    return Err(validation(
                        "save_schema_duplicate_game",
                        "the schema pack repeats a registered game ID; use a distinct ID",
                    ));
                }
            }
            self.handlers.push(Box::new(handler));
        }
        Ok(self)
    }

    pub fn definitions(&self) -> Vec<SaveGameDefinition> {
        self.handlers
            .iter()
            .flat_map(|handler| handler.definitions())
            .collect()
    }

    pub fn generation_definitions(&self) -> Vec<SaveGameDefinition> {
        self.handlers
            .iter()
            .flat_map(|handler| {
                handler
                    .definitions()
                    .into_iter()
                    .filter(|definition| handler.supports_generation(&definition.identity))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    pub fn generate(&self, game_id: &str) -> Result<SaveDetectionInput> {
        for handler in &self.handlers {
            if let Some(definition) = handler
                .definitions()
                .into_iter()
                .find(|definition| definition.identity.id == game_id)
            {
                if !handler.supports_generation(&definition.identity) {
                    return Err(validation(
                        "save_generation_unsupported",
                        "fresh save generation is unsupported for this game; use an existing save as a template",
                    ));
                }
                let input = SaveDetectionInput {
                    bytes: handler.generate(&definition.identity)?,
                    selected_game: Some(game_id.to_string()),
                    rom_sha1: None,
                };
                let document = handler.parse(&input, &definition.identity)?;
                if !matches!(
                    document.integrity.state,
                    SaveIntegrityState::Valid | SaveIntegrityState::ValidWithWarnings
                ) {
                    return Err(validation(
                        "save_generation_invalid",
                        "the generated save failed its integrity checks",
                    ));
                }
                return Ok(input);
            }
        }
        Err(validation(
            "save_game_unsupported",
            "the selected save game is unsupported",
        ))
    }

    pub fn detect(&self, input: &SaveDetectionInput) -> SaveRecognition {
        let (_, input) = normalize_container_input(input);
        let input = input.as_ref();
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
        let (container, input) = normalize_container_input(input);
        let mut document = self
            .handlers
            .iter()
            .find_map(|handler| {
                handler
                    .definitions()
                    .into_iter()
                    .any(|definition| definition.identity == *game)
                    .then(|| handler.parse(input.as_ref(), game))
            })
            .unwrap_or_else(|| {
                Err(validation(
                    "save_game_unsupported",
                    "the selected save game is unsupported",
                ))
            })?;
        if let Some(container) = container {
            attach_container_warnings(&mut document.warnings, &container);
        }
        Ok(document)
    }

    pub fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        let (container, input) = normalize_container_input(input);
        let mut result = self
            .handlers
            .iter()
            .find_map(|handler| {
                handler
                    .definitions()
                    .into_iter()
                    .any(|definition| definition.identity == *game)
                    .then(|| handler.apply(input.as_ref(), game, edits, dry_run))
            })
            .unwrap_or_else(|| {
                Err(validation(
                    "save_game_unsupported",
                    "the selected save game is unsupported",
                ))
            })?;
        if let Some(container) = container {
            attach_container_warnings(&mut result.document.warnings, &container);
            if let Some(bytes) = result.bytes.take() {
                result.bytes = Some(container.wrap(&bytes)?);
            }
        }
        Ok(result)
    }
}

/// Remove a recognized save container so handlers receive raw save bytes.
/// `apply` restores the original wrapper around the edited bytes.
fn normalize_container_input(
    input: &SaveDetectionInput,
) -> (Option<SaveContainer>, Cow<'_, SaveDetectionInput>) {
    match unwrap_save_container(&input.bytes) {
        Some((container, bytes)) => (
            Some(container),
            Cow::Owned(SaveDetectionInput {
                bytes,
                selected_game: input.selected_game.clone(),
                rom_sha1: input.rom_sha1.clone(),
            }),
        ),
        None => (None, Cow::Borrowed(input)),
    }
}

fn attach_container_warnings(warnings: &mut Vec<String>, container: &SaveContainer) {
    warnings.push(format!(
        "the save is inside a {} wrapper; the output keeps the wrapper",
        container.kind().display_name()
    ));
    warnings.extend(container.warnings().iter().cloned());
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
