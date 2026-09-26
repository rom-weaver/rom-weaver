use std::collections::HashSet;

use serde::Deserialize;
use tracing::{debug, trace};

use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityIssue, SaveIntegrityState, SaveRecognition,
    SaveRecognitionConfidence, SaveRecognitionOutcome, SaveRecognitionReason, SaveSection,
    SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

const MAX_PACK_BYTES: usize = 2 * 1024 * 1024;
const MAX_GAMES: usize = 64;
const MAX_FIELDS: usize = 4096;
const MAX_COMPONENTS: usize = 4096;
const MAX_SAVE_SIZE: usize = 8 * 1024 * 1024;
const MAX_SECTIONS: usize = 128;
const MAX_TEXT: usize = 1024;
const MAX_GAME_ID: usize = 128;
const MAX_INTEGRITY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct SaveSchemaPack {
    games: Vec<GameSchema>,
}

impl SaveSchemaPack {
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_PACK_BYTES {
            return Err(invalid("the save schema pack exceeds 2 MiB"));
        }
        let raw: RawPack = serde_json::from_slice(bytes)
            .map_err(|error| invalid_owned(format!("invalid save schema JSON: {error}")))?;
        if let Some(schema) = &raw.schema {
            bounded_text_allow_empty(schema, "$schema")?;
        }
        if raw.schema_version != 1 {
            return Err(invalid("the save schema version is unsupported"));
        }
        if raw.games.is_empty() || raw.games.len() > MAX_GAMES {
            return Err(invalid("a save schema pack must contain 1 to 64 games"));
        }
        let mut ids = HashSet::new();
        let mut games = Vec::with_capacity(raw.games.len());
        let mut integrity_bytes = 0usize;
        for game in raw.games {
            if !ids.insert(game.id.clone()) {
                return Err(invalid("save schema game IDs must be unique"));
            }
            let game = GameSchema::build(game)?;
            integrity_bytes = integrity_bytes
                .checked_add(game.integrity_bytes()?)
                .ok_or_else(|| invalid("schema integrity work exceeds 64 MiB"))?;
            if integrity_bytes > MAX_INTEGRITY_BYTES {
                return Err(invalid("schema integrity work exceeds 64 MiB"));
            }
            games.push(game);
        }
        debug!(games = games.len(), "loaded save schema pack");
        Ok(Self { games })
    }

    pub fn game_ids(&self) -> impl Iterator<Item = &str> {
        self.games.iter().map(|game| game.id.as_str())
    }

    pub fn into_handlers(self) -> Vec<SchemaSaveHandler> {
        self.games
            .into_iter()
            .map(|game| SchemaSaveHandler { game })
            .collect()
    }
}

#[derive(Clone, Debug)]
pub struct SchemaSaveHandler {
    game: GameSchema,
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
        let generation = self.game.generation.as_ref().ok_or_else(|| {
            validation(
                "save_generation_unsupported",
                "this schema has no save initializer",
            )
        })?;
        let mut bytes = vec![generation.fill; self.game.save_size];
        for patch in &generation.patches {
            bytes[patch.offset..patch.offset + patch.bytes.len()].copy_from_slice(&patch.bytes);
        }
        self.game.repair_integrity(&mut bytes);
        let input = self.game.input(bytes.clone());
        self.game.parse_document(&input, game)?;
        debug!(game = %self.game.id, "generated schema save");
        Ok(bytes)
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
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
        if !self.game.signatures_valid(&input.bytes) {
            return unsupported(SaveRecognitionReason::InvalidSignature);
        }
        if !self.game.checksums_valid(&input.bytes) || !self.game.mirrors_valid(&input.bytes) {
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
        self.game.check_identity(game)?;
        let document = self.game.parse_document(input, game)?;
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
        let mut bytes = input.bytes.clone();
        for edit in edits {
            let field = self
                .game
                .fields
                .iter()
                .find(|field| field.id == edit.field)
                .expect("validated schema edit field exists");
            field.write(&mut bytes, &edit.value)?;
        }
        self.game.repair_integrity(&mut bytes);
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
        let output_input = self.game.input(bytes.clone());
        let output = self.game.parse_document(&output_input, game)?;
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
                return Err(invalid(
                    "the edited value did not round trip through the schema",
                ));
            }
        }
        trace!(game = %self.game.id, edits = edits.len(), dry_run, "applied schema save edits");
        Ok(SaveEditResult {
            preview,
            bytes: (!dry_run).then_some(bytes),
            document: output,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPack {
    #[serde(default, rename = "$schema")]
    schema: Option<String>,
    schema_version: u32,
    games: Vec<RawGame>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGame {
    id: String,
    name: String,
    platform: String,
    #[serde(default)]
    description: String,
    save_size: usize,
    fields: Vec<RawField>,
    #[serde(default)]
    signatures: Vec<RawSignature>,
    #[serde(default)]
    checksums: Vec<RawChecksum>,
    #[serde(default)]
    mirrors: Vec<RawMirror>,
    generation: Option<RawGeneration>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawField {
    id: String,
    label: String,
    #[serde(default)]
    description: String,
    offset: usize,
    #[serde(rename = "type")]
    storage: Storage,
    bit: Option<u8>,
    length: Option<u8>,
    min: Option<i64>,
    max: Option<i64>,
    editable: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Storage {
    U8,
    U16Le,
    U16Be,
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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSignature {
    offset: usize,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawChecksum {
    algorithm: ChecksumAlgorithm,
    start: usize,
    length: usize,
    offset: usize,
    target: Option<u16>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ChecksumAlgorithm {
    Sum8,
    Sum16Le,
    Crc16CcittFalseLe,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMirror {
    source: usize,
    target: usize,
    length: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGeneration {
    fill: u8,
    #[serde(default)]
    patches: Vec<RawPatch>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPatch {
    offset: usize,
    bytes: Vec<u8>,
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
}

#[derive(Clone, Debug)]
struct SpanBytes {
    offset: usize,
    bytes: Vec<u8>,
}
#[derive(Clone, Debug)]
struct Checksum {
    algorithm: ChecksumAlgorithm,
    start: usize,
    length: usize,
    offset: usize,
    target: u16,
}
#[derive(Clone, Debug)]
struct Mirror {
    source: usize,
    target: usize,
    length: usize,
}
#[derive(Clone, Debug)]
struct Generation {
    fill: u8,
    patches: Vec<SpanBytes>,
}

impl GameSchema {
    fn build(raw: RawGame) -> Result<Self> {
        validate_game_id(&raw.id)?;
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
            || raw
                .generation
                .as_ref()
                .is_some_and(|generation| generation.patches.len() > MAX_COMPONENTS)
        {
            return Err(invalid("a schema component array exceeds 4096 entries"));
        }
        let mut field_ids = HashSet::new();
        let mut fields = Vec::with_capacity(raw.fields.len());
        for field in raw.fields {
            if !field_ids.insert(field.id.clone()) {
                return Err(invalid("schema field IDs must be unique per game"));
            }
            fields.push(FieldSchema::build(field, raw.save_size)?);
        }
        validate_field_overlaps(&fields)?;
        let signatures = raw
            .signatures
            .into_iter()
            .map(|value| {
                check_nonempty_span(value.offset, value.bytes.len(), raw.save_size, "signature")?;
                Ok(SpanBytes {
                    offset: value.offset,
                    bytes: value.bytes,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let checksums = raw
            .checksums
            .into_iter()
            .map(|value| Checksum::build(value, raw.save_size))
            .collect::<Result<Vec<_>>>()?;
        let mirrors = raw
            .mirrors
            .into_iter()
            .map(|value| Mirror::build(value, raw.save_size))
            .collect::<Result<Vec<_>>>()?;
        validate_reserved_overlaps(&fields, &signatures, &checksums, &mirrors)?;
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
        })
    }

    fn integrity_bytes(&self) -> Result<usize> {
        self.signatures
            .iter()
            .map(|signature| signature.bytes.len())
            .chain(self.checksums.iter().map(|checksum| checksum.length))
            .chain(self.mirrors.iter().map(|mirror| mirror.length))
            .try_fold(0usize, |total, length| {
                total
                    .checked_add(length)
                    .ok_or_else(|| invalid("schema integrity work exceeds 64 MiB"))
            })
    }

    fn identity(&self) -> SaveGameIdentity {
        SaveGameIdentity {
            id: self.id.clone(),
            name: self.name.clone(),
            family: "schema-v1".into(),
        }
    }
    fn definition(&self) -> SaveGameDefinition {
        SaveGameDefinition {
            identity: self.identity(),
            platform: self.platform.clone(),
            save_format: format!("schema:{}", self.id),
            save_format_name: self.name.clone(),
            handler_id: "schema-v1".into(),
            supported_save_sizes: vec![self.save_size as u32],
            known_rom_sha1: Vec::new(),
            checksum_sizes: Vec::new(),
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

    fn parse_document(
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
        if input.bytes.len() != self.save_size {
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
        let mut fields = self
            .fields
            .iter()
            .map(|field| field.to_field(&input.bytes))
            .collect::<Result<Vec<_>>>()?;
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
        self.mirrors
            .iter()
            .all(|m| bytes[m.source..m.source + m.length] == bytes[m.target..m.target + m.length])
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
    fn build(raw: RawField, save_size: usize) -> Result<Self> {
        validate_field_id(&raw.id)?;
        bounded_text(&raw.label, "field label")?;
        bounded_text_allow_empty(&raw.description, "field description")?;
        let (storage_len, intrinsic_min, intrinsic_max) = raw.storage.properties(raw.length)?;
        if matches!(raw.storage, Storage::Bit) != raw.bit.is_some()
            || raw.bit.is_some_and(|bit| bit > 7)
        {
            return Err(invalid("only bit fields require a bit value from 0 to 7"));
        }
        if !matches!(raw.storage, Storage::Ascii) && raw.length.is_some() {
            return Err(invalid("only ascii fields accept length"));
        }
        if matches!(raw.storage, Storage::Bool | Storage::Bit | Storage::Ascii)
            && (raw.min.is_some() || raw.max.is_some())
        {
            return Err(invalid(
                "boolean, bit, and ascii fields do not accept min or max",
            ));
        }
        check_span(raw.offset, storage_len, save_size, "field")?;
        let min = raw.min.unwrap_or(intrinsic_min);
        let max = raw.max.unwrap_or(intrinsic_max);
        if min < intrinsic_min || max > intrinsic_max || min > max {
            return Err(invalid("field min and max must fit its storage type"));
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
        })
    }
    fn span(&self) -> (usize, usize) {
        (self.offset, self.offset + self.length)
    }
    fn to_field(&self, bytes: &[u8]) -> Result<SaveField> {
        let value = self.read(bytes)?;
        let kind = match self.storage {
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
        };
        Ok(SaveField {
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
                choices: Vec::new(),
            },
            description: self.description.clone(),
            warnings: Vec::new(),
            step: Some(1),
            encoding: matches!(self.storage, Storage::Ascii).then(|| "ascii".into()),
        })
    }
    fn read(&self, bytes: &[u8]) -> Result<SaveValue> {
        let b = &bytes[self.offset..self.offset + self.length];
        Ok(match self.storage {
            Storage::U8 => SaveValue::U32(b[0].into()),
            Storage::U16Le => SaveValue::U32(u16::from_le_bytes([b[0], b[1]]).into()),
            Storage::U16Be => SaveValue::U32(u16::from_be_bytes([b[0], b[1]]).into()),
            Storage::U32Le => SaveValue::U32(u32::from_le_bytes(b.try_into().expect("four bytes"))),
            Storage::U32Be => SaveValue::U32(u32::from_be_bytes(b.try_into().expect("four bytes"))),
            Storage::I8 => SaveValue::I32((b[0] as i8).into()),
            Storage::I16Le => SaveValue::I32(i16::from_le_bytes([b[0], b[1]]).into()),
            Storage::I16Be => SaveValue::I32(i16::from_be_bytes([b[0], b[1]]).into()),
            Storage::I32Le => SaveValue::I32(i32::from_le_bytes(b.try_into().expect("four bytes"))),
            Storage::I32Be => SaveValue::I32(i32::from_be_bytes(b.try_into().expect("four bytes"))),
            Storage::Bool => SaveValue::Bool(b[0] != 0),
            Storage::Bit => SaveValue::Bool(b[0] & (1 << self.bit.expect("validated bit")) != 0),
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
        })
    }
    fn write(&self, bytes: &mut [u8], value: &SaveValue) -> Result<()> {
        let dst = &mut bytes[self.offset..self.offset + self.length];
        match (self.storage, value) {
            (Storage::U8, SaveValue::U32(v)) => dst[0] = *v as u8,
            (Storage::U16Le, SaveValue::U32(v)) => dst.copy_from_slice(&(*v as u16).to_le_bytes()),
            (Storage::U16Be, SaveValue::U32(v)) => dst.copy_from_slice(&(*v as u16).to_be_bytes()),
            (Storage::U32Le, SaveValue::U32(v)) => dst.copy_from_slice(&v.to_le_bytes()),
            (Storage::U32Be, SaveValue::U32(v)) => dst.copy_from_slice(&v.to_be_bytes()),
            (Storage::I8, SaveValue::I32(v)) => dst[0] = *v as i8 as u8,
            (Storage::I16Le, SaveValue::I32(v)) => dst.copy_from_slice(&(*v as i16).to_le_bytes()),
            (Storage::I16Be, SaveValue::I32(v)) => dst.copy_from_slice(&(*v as i16).to_be_bytes()),
            (Storage::I32Le, SaveValue::I32(v)) => dst.copy_from_slice(&v.to_le_bytes()),
            (Storage::I32Be, SaveValue::I32(v)) => dst.copy_from_slice(&v.to_be_bytes()),
            (Storage::Bool, SaveValue::Bool(v)) => dst[0] = u8::from(*v),
            (Storage::Bit, SaveValue::Bool(v)) => {
                let mask = 1 << self.bit.expect("validated bit");
                if *v { dst[0] |= mask } else { dst[0] &= !mask }
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
    fn properties(self, length: Option<u8>) -> Result<(usize, i64, i64)> {
        Ok(match self {
            Self::U8 => (1, 0, u8::MAX.into()),
            Self::U16Le | Self::U16Be => (2, 0, u16::MAX.into()),
            Self::U32Le | Self::U32Be => (4, 0, u32::MAX.into()),
            Self::I8 => (1, i8::MIN.into(), i8::MAX.into()),
            Self::I16Le | Self::I16Be => (2, i16::MIN.into(), i16::MAX.into()),
            Self::I32Le | Self::I32Be => (4, i32::MIN.into(), i32::MAX.into()),
            Self::Bool | Self::Bit => (1, 0, 1),
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

impl Checksum {
    fn build(raw: RawChecksum, size: usize) -> Result<Self> {
        check_nonempty_span(raw.start, raw.length, size, "checksum input")?;
        let width = match raw.algorithm {
            ChecksumAlgorithm::Sum8 => 1,
            _ => 2,
        };
        check_span(raw.offset, width, size, "checksum output")?;
        if matches!(raw.algorithm, ChecksumAlgorithm::Crc16CcittFalseLe) && raw.target.is_some() {
            return Err(invalid("crc16_ccitt_false_le does not accept target"));
        }
        if matches!(raw.algorithm, ChecksumAlgorithm::Sum8) && raw.target.is_some_and(|v| v > 255) {
            return Err(invalid("sum8 target must fit in u8"));
        }
        Ok(Self {
            algorithm: raw.algorithm,
            start: raw.start,
            length: raw.length,
            offset: raw.offset,
            target: raw.target.unwrap_or(0),
        })
    }
    fn width(&self) -> usize {
        if matches!(self.algorithm, ChecksumAlgorithm::Sum8) {
            1
        } else {
            2
        }
    }
    fn expected(&self, bytes: &[u8]) -> u16 {
        match self.algorithm {
            ChecksumAlgorithm::Sum8 => (self.target as u8).wrapping_sub(
                bytes[self.start..self.start + self.length]
                    .iter()
                    .fold(0u8, |a, b| a.wrapping_add(*b)),
            ) as u16,
            ChecksumAlgorithm::Sum16Le => self.target.wrapping_sub(
                bytes[self.start..self.start + self.length]
                    .iter()
                    .fold(0u16, |a, b| a.wrapping_add((*b).into())),
            ),
            ChecksumAlgorithm::Crc16CcittFalseLe => bytes[self.start..self.start + self.length]
                .iter()
                .fold(0xffffu16, |mut crc, byte| {
                    crc ^= u16::from(*byte) << 8;
                    for _ in 0..8 {
                        crc = if crc & 0x8000 != 0 {
                            (crc << 1) ^ 0x1021
                        } else {
                            crc << 1
                        }
                    }
                    crc
                }),
        }
    }
    fn valid(&self, bytes: &[u8]) -> bool {
        let stored = if self.width() == 1 {
            bytes[self.offset] as u16
        } else {
            u16::from_le_bytes([bytes[self.offset], bytes[self.offset + 1]])
        };
        stored == self.expected(bytes)
    }
    fn repair(&self, bytes: &mut [u8]) {
        let value = self.expected(bytes);
        if self.width() == 1 {
            bytes[self.offset] = value as u8
        } else {
            bytes[self.offset..self.offset + 2].copy_from_slice(&value.to_le_bytes())
        }
    }
}
impl Mirror {
    fn build(raw: RawMirror, size: usize) -> Result<Self> {
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
        })
    }
}
impl Generation {
    fn build(raw: RawGeneration, size: usize) -> Result<Self> {
        let patches = raw
            .patches
            .into_iter()
            .map(|p| {
                check_nonempty_span(p.offset, p.bytes.len(), size, "generation patch")?;
                Ok(SpanBytes {
                    offset: p.offset,
                    bytes: p.bytes,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            fill: raw.fill,
            patches,
        })
    }
}

fn validate_field_overlaps(fields: &[FieldSchema]) -> Result<()> {
    for (i, a) in fields.iter().enumerate() {
        for b in &fields[i + 1..] {
            if overlaps(a.span(), b.span())
                && (a.editable || b.editable)
                && !(matches!(a.storage, Storage::Bit)
                    && matches!(b.storage, Storage::Bit)
                    && a.offset == b.offset
                    && a.bit != b.bit)
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
    let checksum_inputs: Vec<_> = checksums
        .iter()
        .map(|c| (c.start, c.start + c.length))
        .collect();
    let checksum_outputs: Vec<_> = checksums
        .iter()
        .map(|c| (c.offset, c.offset + c.width()))
        .collect();
    for (i, out) in checksum_outputs.iter().enumerate() {
        if fields.iter().any(|f| overlaps(*out, f.span()))
            || signatures
                .iter()
                .any(|s| overlaps(*out, (s.offset, s.offset + s.bytes.len())))
            || checksum_inputs.iter().any(|span| overlaps(*out, *span))
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
            || checksum_outputs.iter().any(|span| overlaps(target, *span))
            || checksum_inputs.iter().any(|span| overlaps(target, *span))
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
        || !bytes[0].is_ascii_lowercase()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn handler(fields: &str, extra: &str) -> SchemaSaveHandler {
        let json = format!(
            r#"{{"schema_version":1,"games":[{{"id":"demo","name":"Demo","platform":"test","save_size":16,"fields":[{fields}],{extra}}}]}}"#
        );
        SaveSchemaPack::from_json(json.as_bytes())
            .unwrap()
            .into_handlers()
            .remove(0)
    }

    fn identity(handler: &SchemaSaveHandler) -> SaveGameIdentity {
        handler.definitions().remove(0).identity
    }

    #[test]
    fn reads_and_writes_numeric_bit_bool_and_ascii_storage() {
        let handler = handler(
            r#"{"id":"le","label":"LE","offset":0,"type":"u16_le"},{"id":"be","label":"BE","offset":2,"type":"i16_be"},{"id":"flag","label":"Flag","offset":4,"type":"bit","bit":3},{"id":"enabled","label":"Enabled","offset":5,"type":"bool"},{"id":"name","label":"Name","offset":6,"type":"ascii","length":4}"#,
            r#""signatures":[{"offset":15,"bytes":[170]}],"checksums":[],"mirrors":[]"#,
        );
        let game = identity(&handler);
        let input = SaveDetectionInput {
            bytes: vec![
                0x34, 0x12, 0xff, 0xfe, 0xa5, 2, b'A', 0, 0xcc, 0xdd, 0, 0, 0, 0, 0, 0xaa,
            ],
            selected_game: Some("demo".into()),
            rom_sha1: None,
        };
        let document = handler.parse(&input, &game).unwrap();
        assert_eq!(document.fields[0].value, SaveValue::U32(0x1234));
        assert_eq!(document.fields[1].value, SaveValue::I32(-2));
        assert_eq!(document.fields[2].value, SaveValue::Bool(false));
        assert_eq!(document.fields[3].value, SaveValue::Bool(true));
        assert_eq!(document.fields[4].value, SaveValue::Text("A".into()));
        let result = handler
            .apply(
                &input,
                &game,
                &[
                    SaveEdit {
                        field: "le".into(),
                        value: SaveValue::U32(0xabcd),
                    },
                    SaveEdit {
                        field: "be".into(),
                        value: SaveValue::I32(-3),
                    },
                    SaveEdit {
                        field: "flag".into(),
                        value: SaveValue::Bool(true),
                    },
                    SaveEdit {
                        field: "enabled".into(),
                        value: SaveValue::Bool(false),
                    },
                    SaveEdit {
                        field: "name".into(),
                        value: SaveValue::Text("XY".into()),
                    },
                ],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        assert_eq!(
            &bytes[..10],
            &[0xcd, 0xab, 0xff, 0xfd, 0xad, 0, b'X', b'Y', 0, 0]
        );
        assert_eq!(bytes[15], 0xaa);
    }

    #[test]
    fn generation_repairs_checksum_then_mirror() {
        let handler = handler(
            r#"{"id":"value","label":"Value","offset":1,"type":"u8"}"#,
            r#""signatures":[{"offset":0,"bytes":[82]}],"checksums":[{"algorithm":"sum8","start":0,"length":3,"offset":3,"target":255}],"mirrors":[{"source":0,"target":8,"length":4}],"generation":{"fill":0,"patches":[{"offset":0,"bytes":[82,2]}]}"#,
        );
        let bytes = SaveGameHandler::generate(&handler, &identity(&handler)).unwrap();
        assert_eq!(bytes[3], 171);
        assert_eq!(&bytes[..4], &bytes[8..12]);
    }

    #[test]
    fn dry_run_returns_document_without_bytes_or_input_mutation() {
        let handler = handler(
            r#"{"id":"value","label":"Value","offset":1,"type":"u8"}"#,
            r#""signatures":[{"offset":0,"bytes":[82]}],"checksums":[],"mirrors":[]"#,
        );
        let input = SaveDetectionInput {
            bytes: [82, 1].into_iter().chain([0; 14]).collect(),
            selected_game: Some("demo".into()),
            rom_sha1: None,
        };
        let original = input.bytes.clone();
        let result = handler
            .apply(
                &input,
                &identity(&handler),
                &[SaveEdit {
                    field: "value".into(),
                    value: SaveValue::U32(9),
                }],
                true,
            )
            .unwrap();
        assert!(result.bytes.is_none());
        assert_eq!(result.document.fields[0].value, SaveValue::U32(9));
        assert_eq!(input.bytes, original);
    }

    #[test]
    fn schemas_without_evidence_need_explicit_selection() {
        let handler = handler(
            r#"{"id":"value","label":"Value","offset":0,"type":"u8"}"#,
            r#""signatures":[],"checksums":[],"mirrors":[]"#,
        );
        let mut input = SaveDetectionInput {
            bytes: vec![0; 16],
            selected_game: None,
            rom_sha1: None,
        };
        assert!(matches!(
            handler.recognize(&input).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        input.selected_game = Some("demo".into());
        assert!(matches!(
            handler.recognize(&input).outcome,
            SaveRecognitionOutcome::Recognized { .. }
        ));
    }

    #[test]
    fn rejects_unknown_version_attributes_duplicates_bounds_and_overlaps() {
        for json in [
            r#"{"schema_version":2,"games":[]}"#,
            r#"{"schema_version":1,"extra":0,"games":[]}"#,
            r#"{"schema_version":1,"games":[{"id":"x","name":"X","platform":"x","save_size":1,"fields":[{"id":"a","label":"A","offset":0,"type":"u8"},{"id":"a","label":"B","offset":0,"type":"u8"}],"signatures":[],"checksums":[],"mirrors":[]}]}"#,
            r#"{"schema_version":1,"games":[{"id":"x","name":"X","platform":"x","save_size":1,"fields":[{"id":"a","label":"A","offset":1,"type":"u8"}],"signatures":[],"checksums":[],"mirrors":[]}]}"#,
            r#"{"schema_version":1,"games":[{"id":"x","name":"X","platform":"x","save_size":2,"fields":[{"id":"a","label":"A","offset":0,"type":"u16_le"},{"id":"b","label":"B","offset":1,"type":"u8"}],"signatures":[],"checksums":[],"mirrors":[]}]}"#,
        ] {
            assert!(
                SaveSchemaPack::from_json(json.as_bytes()).is_err(),
                "accepted {json}"
            );
        }
    }

    #[test]
    fn corrupted_integrity_refuses_edits() {
        let handler = handler(
            r#"{"id":"value","label":"Value","offset":1,"type":"u8"}"#,
            r#""signatures":[{"offset":0,"bytes":[82]}],"checksums":[{"algorithm":"sum8","start":0,"length":2,"offset":2}],"mirrors":[]"#,
        );
        let input = SaveDetectionInput {
            bytes: vec![82, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            selected_game: Some("demo".into()),
            rom_sha1: None,
        };
        assert!(
            handler
                .apply(
                    &input,
                    &identity(&handler),
                    &[SaveEdit {
                        field: "value".into(),
                        value: SaveValue::U32(2)
                    }],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn rejects_unsafe_game_and_field_ids() {
        for id in ["../save", "a/b", ".hidden", "Upper", "a\\n", ""] {
            let json = format!(
                r#"{{"schema_version":1,"games":[{{"id":"{id}","name":"X","platform":"x","save_size":1,"fields":[],"signatures":[],"checksums":[],"mirrors":[]}}]}}"#
            );
            assert!(SaveSchemaPack::from_json(json.as_bytes()).is_err());
        }
        for id in ["a..b", ".a", "a.", "a/b", "a=b", "a b", "é"] {
            let json = format!(
                r#"{{"schema_version":1,"games":[{{"id":"safe","name":"X","platform":"x","save_size":1,"fields":[{{"id":"{id}","label":"X","offset":0,"type":"u8"}}],"signatures":[],"checksums":[],"mirrors":[]}}]}}"#
            );
            assert!(SaveSchemaPack::from_json(json.as_bytes()).is_err());
        }
    }

    #[test]
    fn rejects_pack_wide_integrity_work_over_64_mib() {
        let size = MAX_SAVE_SIZE;
        let checksums = (0..9)
            .map(|index| {
                format!(
                    r#"{{"algorithm":"sum8","start":0,"length":{},"offset":{}}}"#,
                    size - 9,
                    size - 9 + index
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let json = format!(
            r#"{{"schema_version":1,"games":[{{"id":"safe","name":"X","platform":"x","save_size":{size},"fields":[],"signatures":[],"checksums":[{checksums}],"mirrors":[]}}]}}"#
        );
        assert!(SaveSchemaPack::from_json(json.as_bytes()).is_err());
    }

    #[test]
    fn preview_includes_integrity_mutations_in_other_sections() {
        let size = 65_540;
        let json = format!(
            r#"{{"schema_version":1,"games":[{{"id":"wide","name":"Wide","platform":"x","save_size":{size},"fields":[{{"id":"value","label":"Value","offset":1,"type":"u8"}}],"signatures":[{{"offset":0,"bytes":[82]}}],"checksums":[{{"algorithm":"sum8","start":0,"length":2,"offset":65536}}],"mirrors":[{{"source":1,"target":65537,"length":1}}],"generation":{{"fill":0,"patches":[{{"offset":0,"bytes":[82]}}]}}}}]}}"#
        );
        let handler = SaveSchemaPack::from_json(json.as_bytes())
            .unwrap()
            .into_handlers()
            .remove(0);
        let game = identity(&handler);
        let bytes = SaveGameHandler::generate(&handler, &game).unwrap();
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some("wide".into()),
            rom_sha1: None,
        };
        let result = handler
            .apply(
                &input,
                &game,
                &[SaveEdit {
                    field: "value".into(),
                    value: SaveValue::U32(7),
                }],
                true,
            )
            .unwrap();
        assert_eq!(result.preview.touched_sections, vec![0, 1]);
        assert!(result.bytes.is_none());
    }

    #[test]
    fn invalid_documents_expose_read_only_fields() {
        let handler = handler(
            r#"{"id":"value","label":"Value","offset":1,"type":"u8"}"#,
            r#""signatures":[{"offset":0,"bytes":[82]}],"checksums":[],"mirrors":[]"#,
        );
        let input = SaveDetectionInput {
            bytes: vec![0; 16],
            selected_game: Some("demo".into()),
            rom_sha1: None,
        };
        let document = handler.parse(&input, &identity(&handler)).unwrap();
        assert_eq!(document.integrity.state, SaveIntegrityState::Invalid);
        assert!(!document.fields[0].editable);
    }
}
