use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;

use crate::{Result, RomWeaverError, ValidationCodeError};

const MAX_CODEC_COMPONENTS: usize = 1024;

#[cfg(test)]
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextCodecCatalog {
    pub codecs: BTreeMap<String, TextCodec>,
}

#[cfg(test)]
impl TextCodecCatalog {
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let catalog: Self = serde_json::from_slice(bytes).map_err(|error| {
            RomWeaverError::ValidationCode(
                ValidationCodeError::new("save_text_codec")
                    .with_message(format!("invalid text codec catalog: {error}")),
            )
        })?;
        if catalog.codecs.len() > MAX_CODEC_COMPONENTS {
            return Err(validation(
                "save_text_codec",
                "a text codec catalog cannot exceed 1024 codecs",
            ));
        }
        for (name, codec) in &catalog.codecs {
            codec.validate(name)?;
        }
        Ok(catalog)
    }

    pub fn get(&self, name: &str) -> Result<&TextCodec> {
        self.codecs
            .get(name)
            .ok_or_else(|| validation("save_text_codec", "the requested text codec is unknown"))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextCodec {
    pub unit: TextUnit,
    pub max_chars: usize,
    #[serde(default)]
    pub max_units: Option<usize>,
    #[serde(default)]
    pub terminators: Vec<u32>,
    #[serde(default)]
    pub skip: Vec<u32>,
    pub fill: u32,
    #[serde(default)]
    pub write_terminator: Option<u32>,
    #[serde(default)]
    pub lane: Option<BitLane>,
    pub mapping: TextMapping,
    pub decode_invalid: DecodeInvalid,
    pub missing_terminator: MissingTerminator,
    pub errors: TextErrors,
    #[serde(default)]
    pub encode_transforms: Vec<ConditionalReplacement>,
}

impl TextCodec {
    pub fn decode(&self, bytes: &[u8]) -> Result<String> {
        let units = self.unit.read(bytes)?;
        if let TextMapping::Unicode {
            decode_replacements,
        } = &self.mapping
        {
            let mut decoded = Vec::new();
            let mut terminated = false;
            for storage in units {
                let code = self.decode_lane(storage);
                if self.terminators.contains(&code) {
                    terminated = true;
                    break;
                }
                if self.skip.contains(&code) {
                    continue;
                }
                let code = decode_replacements
                    .get(&code.to_string())
                    .copied()
                    .unwrap_or(code);
                decoded.push(u16::try_from(code).map_err(|_| self.errors.decode_invalid.error())?);
            }
            if let Some(literal) = self.check_terminator(terminated)? {
                return Ok(literal);
            }
            return String::from_utf16(&decoded).map_err(|_| self.errors.decode_invalid.error());
        }
        let mut decoded = Vec::new();
        let mut terminated = false;
        for storage in units {
            let code = self.decode_lane(storage);
            if self.terminators.contains(&code) {
                terminated = true;
                break;
            }
            if self.skip.contains(&code) {
                continue;
            }
            match self.mapping.decode(code) {
                Some(character) => decoded.push(character),
                None => match &self.decode_invalid {
                    DecodeInvalid::Error => {
                        return Err(self.errors.decode_invalid.error());
                    }
                    DecodeInvalid::Replacement { character } => decoded.push(*character),
                    DecodeInvalid::Literal { template } => {
                        return Ok(render_code(template, code, self.unit.hex_width()));
                    }
                },
            }
        }
        if let Some(literal) = self.check_terminator(terminated)? {
            return Ok(literal);
        }
        Ok(decoded.into_iter().collect())
    }

    pub fn encode(&self, value: &str, output: &mut [u8]) -> Result<()> {
        let char_count = value.chars().count();
        if char_count > self.max_chars {
            return Err(self.errors.too_long.error());
        }
        let mut codes = if self.mapping.is_unicode() {
            value.encode_utf16().map(u32::from).collect::<Vec<_>>()
        } else {
            value
                .chars()
                .map(|character| {
                    self.mapping
                        .encode(character)
                        .ok_or_else(|| self.errors.encode_invalid.error())
                })
                .collect::<Result<Vec<_>>>()?
        };
        for transform in &self.encode_transforms {
            transform.apply(value, &mut codes);
        }
        let capacity = self.unit.unit_count(output)?;
        let max_units = self.max_units.unwrap_or(self.max_chars).min(capacity);
        if codes.len() > max_units {
            return Err(self.errors.too_long.error());
        }
        self.fill_output(output, self.fill)?;
        for (index, code) in codes.iter().copied().enumerate() {
            self.write_code(output, index, code)?;
        }
        if codes.len() < capacity
            && let Some(terminator) = self.write_terminator
        {
            self.write_code(output, codes.len(), terminator)?;
        }
        Ok(())
    }

    fn check_terminator(&self, terminated: bool) -> Result<Option<String>> {
        if terminated || self.terminators.is_empty() {
            return Ok(None);
        }
        match &self.missing_terminator {
            MissingTerminator::Accept => Ok(None),
            MissingTerminator::Error => Err(self.errors.missing_terminator.error()),
            MissingTerminator::Literal { value } => Ok(Some(value.clone())),
        }
    }

    pub(super) fn validate(&self, name: &str) -> Result<()> {
        if name.is_empty()
            || name.len() > MAX_CODEC_COMPONENTS
            || self.max_chars == 0
            || self.max_chars > MAX_CODEC_COMPONENTS
            || self.max_units == Some(0)
            || self
                .max_units
                .is_some_and(|units| units > MAX_CODEC_COMPONENTS)
            || self.terminators.len() > MAX_CODEC_COMPONENTS
            || self.skip.len() > MAX_CODEC_COMPONENTS
            || self.encode_transforms.len() > MAX_CODEC_COMPONENTS
        {
            return Err(validation(
                "save_text_codec",
                "text codec names and limits must be nonempty",
            ));
        }
        if let Some(lane) = &self.lane {
            lane.validate(self.unit.bits())?;
        }
        let mut structural = HashSet::new();
        for code in self.terminators.iter().chain(&self.skip) {
            self.validate_code(*code)?;
            if !structural.insert(*code) {
                return Err(validation(
                    "save_text_codec",
                    "text codec structural codes must be unique",
                ));
            }
        }
        self.validate_code(self.fill)?;
        if let Some(code) = self.write_terminator {
            self.validate_code(code)?;
            if !self.terminators.contains(&code) {
                return Err(validation(
                    "save_text_codec",
                    "a written text terminator must be a decode terminator",
                ));
            }
        }
        self.mapping.validate(self.logical_max())?;
        self.errors.validate()?;
        if matches!(&self.decode_invalid, DecodeInvalid::Literal { template } if template.len() > MAX_CODEC_COMPONENTS)
            || matches!(&self.missing_terminator, MissingTerminator::Literal { value } if value.len() > MAX_CODEC_COMPONENTS)
        {
            return Err(validation(
                "save_text_codec",
                "text codec literal output cannot exceed 1024 bytes",
            ));
        }
        for transform in &self.encode_transforms {
            transform.validate(self.unit.maximum())?;
        }
        Ok(())
    }

    fn validate_code(&self, code: u32) -> Result<()> {
        if code > self.logical_max() {
            return Err(validation(
                "save_text_codec",
                "text codec code exceeds its encoded unit",
            ));
        }
        Ok(())
    }

    fn logical_max(&self) -> u32 {
        self.lane
            .as_ref()
            .map_or(self.unit.maximum(), BitLane::logical_max)
    }

    fn decode_lane(&self, storage: u32) -> u32 {
        self.lane
            .as_ref()
            .map_or(storage, |lane| lane.decode(storage))
    }

    fn encode_lane(&self, storage: u32, code: u32) -> u32 {
        self.lane
            .as_ref()
            .map_or(code, |lane| lane.encode(storage, code))
    }

    fn fill_output(&self, output: &mut [u8], code: u32) -> Result<()> {
        let count = self.unit.unit_count(output)?;
        for index in 0..count {
            self.write_code(output, index, code)?;
        }
        Ok(())
    }

    fn write_code(&self, output: &mut [u8], index: usize, code: u32) -> Result<()> {
        self.validate_code(code)?;
        let storage = self.unit.read_at(output, index)?;
        self.unit
            .write_at(output, index, self.encode_lane(storage, code))
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextUnit {
    U8,
    U16Le,
    U16Be,
}

impl TextUnit {
    fn bits(self) -> u8 {
        match self {
            Self::U8 => 8,
            Self::U16Le | Self::U16Be => 16,
        }
    }

    fn width(self) -> usize {
        usize::from(self.bits() / 8)
    }

    fn maximum(self) -> u32 {
        match self {
            Self::U8 => u32::from(u8::MAX),
            Self::U16Le | Self::U16Be => u32::from(u16::MAX),
        }
    }

    fn hex_width(self) -> usize {
        self.width() * 2
    }

    fn unit_count(self, bytes: &[u8]) -> Result<usize> {
        if !bytes.len().is_multiple_of(self.width()) {
            return Err(validation(
                "save_text_codec",
                "text storage is not aligned to its encoded unit",
            ));
        }
        Ok(bytes.len() / self.width())
    }

    fn read(self, bytes: &[u8]) -> Result<Vec<u32>> {
        let count = self.unit_count(bytes)?;
        (0..count).map(|index| self.read_at(bytes, index)).collect()
    }

    fn read_at(self, bytes: &[u8], index: usize) -> Result<u32> {
        let offset = index
            .checked_mul(self.width())
            .ok_or_else(|| validation("save_text_codec", "text storage offset overflowed"))?;
        match self {
            Self::U8 => bytes.get(offset).copied().map(u32::from),
            Self::U16Le | Self::U16Be => bytes.get(offset..offset + 2).map(|pair| {
                u32::from(if matches!(self, Self::U16Le) {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                })
            }),
        }
        .ok_or_else(|| validation("save_text_codec", "text storage is too short"))
    }

    fn write_at(self, bytes: &mut [u8], index: usize, value: u32) -> Result<()> {
        if value > self.maximum() {
            return Err(validation(
                "save_text_codec",
                "text codec code exceeds its encoded unit",
            ));
        }
        let offset = index
            .checked_mul(self.width())
            .ok_or_else(|| validation("save_text_codec", "text storage offset overflowed"))?;
        match self {
            Self::U8 => {
                *bytes
                    .get_mut(offset)
                    .ok_or_else(|| validation("save_text_codec", "text storage is too short"))? =
                    value as u8;
            }
            Self::U16Le | Self::U16Be => {
                let encoded = if matches!(self, Self::U16Le) {
                    (value as u16).to_le_bytes()
                } else {
                    (value as u16).to_be_bytes()
                };
                bytes
                    .get_mut(offset..offset + 2)
                    .ok_or_else(|| validation("save_text_codec", "text storage is too short"))?
                    .copy_from_slice(&encoded);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BitLane {
    pub logical_to_storage: Vec<u8>,
}

impl BitLane {
    fn validate(&self, storage_bits: u8) -> Result<()> {
        if self.logical_to_storage.is_empty()
            || self.logical_to_storage.len() > 32
            || self
                .logical_to_storage
                .iter()
                .any(|bit| *bit >= storage_bits)
            || self
                .logical_to_storage
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                .len()
                != self.logical_to_storage.len()
        {
            return Err(validation(
                "save_text_codec",
                "text codec bit lane is invalid",
            ));
        }
        Ok(())
    }

    fn logical_max(&self) -> u32 {
        if self.logical_to_storage.len() == 32 {
            u32::MAX
        } else {
            (1u32 << self.logical_to_storage.len()) - 1
        }
    }

    fn decode(&self, storage: u32) -> u32 {
        self.logical_to_storage
            .iter()
            .enumerate()
            .fold(0, |value, (logical, storage_bit)| {
                value | (((storage >> storage_bit) & 1) << logical)
            })
    }

    fn encode(&self, mut storage: u32, code: u32) -> u32 {
        for (logical, storage_bit) in self.logical_to_storage.iter().enumerate() {
            let mask = 1u32 << storage_bit;
            storage = (storage & !mask) | (((code >> logical) & 1) << storage_bit);
        }
        storage
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TextMapping {
    Table {
        #[serde(default)]
        ranges: Vec<GlyphRange>,
        #[serde(default)]
        glyphs: BTreeMap<char, u32>,
        #[serde(default)]
        aliases: BTreeMap<char, char>,
    },
    Unicode {
        #[serde(default)]
        decode_replacements: BTreeMap<String, u32>,
    },
}

impl TextMapping {
    fn is_unicode(&self) -> bool {
        matches!(self, Self::Unicode { .. })
    }

    fn decode(&self, code: u32) -> Option<char> {
        match self {
            Self::Table { ranges, glyphs, .. } => glyphs
                .iter()
                .find_map(|(character, value)| (*value == code).then_some(*character))
                .or_else(|| ranges.iter().find_map(|range| range.decode(code))),
            Self::Unicode {
                decode_replacements,
            } => char::from_u32(
                decode_replacements
                    .get(&code.to_string())
                    .copied()
                    .unwrap_or(code),
            ),
        }
    }

    fn encode(&self, character: char) -> Option<u32> {
        match self {
            Self::Table {
                ranges,
                glyphs,
                aliases,
            } => {
                let canonical = aliases.get(&character).copied().unwrap_or(character);
                glyphs
                    .get(&canonical)
                    .copied()
                    .or_else(|| ranges.iter().find_map(|range| range.encode(canonical)))
            }
            Self::Unicode { .. } => Some(u32::from(character)),
        }
    }

    fn validate(&self, logical_max: u32) -> Result<()> {
        let mut codes = HashSet::new();
        let mut glyphs_seen = HashSet::new();
        match self {
            Self::Table {
                ranges,
                glyphs,
                aliases,
            } => {
                if ranges.len() > MAX_CODEC_COMPONENTS
                    || glyphs.len() > MAX_CODEC_COMPONENTS
                    || aliases.len() > MAX_CODEC_COMPONENTS
                {
                    return Err(validation(
                        "save_text_codec",
                        "text codec mapping exceeds 1024 entries",
                    ));
                }
                for range in ranges {
                    for (character, code) in range.entries()? {
                        if code > logical_max
                            || !codes.insert(code)
                            || !glyphs_seen.insert(character)
                        {
                            return Err(validation(
                                "save_text_codec",
                                "text codec mappings must be unique and fit the encoded unit",
                            ));
                        }
                    }
                }
                for (character, code) in glyphs {
                    if *code > logical_max
                        || !codes.insert(*code)
                        || !glyphs_seen.insert(*character)
                    {
                        return Err(validation(
                            "save_text_codec",
                            "text codec mappings must be unique and fit the encoded unit",
                        ));
                    }
                }
                if aliases.iter().any(|(alias, canonical)| {
                    glyphs_seen.contains(alias) || !glyphs_seen.contains(canonical)
                }) {
                    return Err(validation(
                        "save_text_codec",
                        "text codec aliases must reference canonical glyphs",
                    ));
                }
            }
            Self::Unicode {
                decode_replacements,
            } => {
                let valid = decode_replacements.iter().all(|(from, to)| {
                    from.parse::<u32>()
                        .is_ok_and(|from| from <= logical_max && char::from_u32(*to).is_some())
                });
                if decode_replacements.len() > MAX_CODEC_COMPONENTS || !valid {
                    return Err(validation(
                        "save_text_codec",
                        "text codec Unicode replacement is invalid",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GlyphRange {
    pub first: char,
    pub last: char,
    pub first_code: u32,
}

impl GlyphRange {
    fn entries(&self) -> Result<Vec<(char, u32)>> {
        let first = u32::from(self.first);
        let last = u32::from(self.last);
        if first > last || last - first + 1 > MAX_CODEC_COMPONENTS as u32 {
            return Err(validation(
                "save_text_codec",
                "text codec range must contain from 1 to 1024 glyphs",
            ));
        }
        (first..=last)
            .enumerate()
            .map(|(offset, value)| {
                let character = char::from_u32(value).ok_or_else(|| {
                    validation(
                        "save_text_codec",
                        "text codec range contains an invalid glyph",
                    )
                })?;
                let code = self
                    .first_code
                    .checked_add(offset as u32)
                    .ok_or_else(|| validation("save_text_codec", "text codec range overflowed"))?;
                Ok((character, code))
            })
            .collect()
    }

    fn decode(&self, code: u32) -> Option<char> {
        self.entries()
            .ok()?
            .into_iter()
            .find_map(|(character, mapped)| (mapped == code).then_some(character))
    }

    fn encode(&self, character: char) -> Option<u32> {
        (character >= self.first && character <= self.last)
            .then(|| self.first_code + (u32::from(character) - u32::from(self.first)))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DecodeInvalid {
    Error,
    Replacement { character: char },
    Literal { template: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MissingTerminator {
    Accept,
    Error,
    Literal { value: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextErrors {
    pub decode_invalid: TextError,
    pub encode_invalid: TextError,
    pub missing_terminator: TextError,
    pub too_long: TextError,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextError {
    pub code: String,
    pub message: String,
}

impl TextError {
    fn error(&self) -> RomWeaverError {
        RomWeaverError::ValidationCode(
            ValidationCodeError::new(self.code.clone()).with_message(self.message.clone()),
        )
    }

    fn validate(&self) -> Result<()> {
        if self.code.is_empty()
            || self.message.is_empty()
            || self.code.len() > MAX_CODEC_COMPONENTS
            || self.message.len() > MAX_CODEC_COMPONENTS
        {
            return Err(validation(
                "save_text_codec",
                "text codec error codes and messages must contain 1 to 1024 bytes",
            ));
        }
        Ok(())
    }
}

impl TextErrors {
    fn validate(&self) -> Result<()> {
        self.decode_invalid.validate()?;
        self.encode_invalid.validate()?;
        self.missing_terminator.validate()?;
        self.too_long.validate()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConditionalReplacement {
    pub when_all: Vec<CodepointSet>,
    pub replacements: BTreeMap<String, u32>,
}

impl ConditionalReplacement {
    fn apply(&self, value: &str, units: &mut [u32]) {
        if value
            .chars()
            .all(|character| self.when_all.iter().any(|set| set.contains(character)))
        {
            for unit in units {
                if let Some(replacement) = self.replacements.get(&unit.to_string()) {
                    *unit = *replacement;
                }
            }
        }
    }

    fn validate(&self, maximum: u32) -> Result<()> {
        if self.when_all.is_empty()
            || self.when_all.len() > MAX_CODEC_COMPONENTS
            || self.replacements.len() > MAX_CODEC_COMPONENTS
            || self.replacements.iter().any(|(from, to)| {
                from.parse::<u32>()
                    .map_or(true, |from| from > maximum || *to > maximum)
            })
        {
            return Err(validation(
                "save_text_codec",
                "text codec conditional replacement is invalid",
            ));
        }
        for set in &self.when_all {
            set.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum CodepointSet {
    Range { min: u32, max: u32 },
    Values { values: Vec<u32> },
}

impl CodepointSet {
    fn contains(&self, character: char) -> bool {
        let value = u32::from(character);
        match self {
            Self::Range { min, max } => (*min..=*max).contains(&value),
            Self::Values { values } => values.contains(&value),
        }
    }

    fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Range { min, max } => {
                min <= max && char::from_u32(*min).is_some() && char::from_u32(*max).is_some()
            }
            Self::Values { values } => {
                !values.is_empty()
                    && values.len() <= MAX_CODEC_COMPONENTS
                    && values.iter().all(|value| char::from_u32(*value).is_some())
            }
        };
        if !valid {
            return Err(validation(
                "save_text_codec",
                "text codec code-point predicate is invalid",
            ));
        }
        Ok(())
    }
}

fn render_code(template: &str, code: u32, width: usize) -> String {
    template
        .replace("{code:#x}", &format!("{code:#0width$x}", width = width + 2))
        .replace("{code}", &code.to_string())
}

fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

#[cfg(test)]
mod tests {
    use super::TextCodecCatalog;
    use crate::save::SaveSchemaPack;

    const CATALOG: &[u8] = include_bytes!("../../../tests/fixtures/save-codecs.json");

    #[test]
    fn built_in_codecs_match_native_name_rules() {
        let catalog = TextCodecCatalog::from_json(CATALOG).unwrap();

        let gen1 = catalog.get("pokemon_gen1_english").unwrap();
        let mut gen1_bytes = [0xa5; 11];
        gen1.encode("A{9", &mut gen1_bytes).unwrap();
        assert_eq!(&gen1_bytes[..4], &[0x80, 0xe1, 0xff, 0x50]);
        assert_eq!(gen1.decode(&gen1_bytes).unwrap(), "A{9");
        assert_eq!(
            gen1.decode(&[0x01, 0x50]).unwrap(),
            "Unsupported Gen I character byte 0x01"
        );
        assert_eq!(gen1.decode(&[0x80; 11]).unwrap(), "AAAAAAAAAAA");

        let gen2 = catalog.get("pokemon_gen2_english").unwrap();
        assert_eq!(
            gen2.decode(&[0x80; 11]).unwrap(),
            "Trainer name has no terminator"
        );

        let gen3 = catalog.get("pokemon_gen3_english").unwrap();
        let mut gen3_bytes = [0; 7];
        gen3.encode("A'", &mut gen3_bytes).unwrap();
        assert_eq!(&gen3_bytes[..3], &[0xbb, 0xb4, 0xff]);
        assert_eq!(gen3.decode(&gen3_bytes).unwrap(), "A’");
    }

    #[test]
    fn utf16_context_transform_and_unit_limit_match_gen5() {
        let catalog = TextCodecCatalog::from_json(CATALOG).unwrap();
        let codec = catalog.get("pokemon_gen5_utf16le").unwrap();
        let mut bytes = [0; 16];
        codec.encode("A♀é", &mut bytes).unwrap();
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), 0x246e);
        assert_eq!(codec.decode(&bytes).unwrap(), "A♀é");

        codec.encode("漢♀", &mut bytes).unwrap();
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), 0x2640);
        assert!(codec.encode("😀😀😀😀", &mut bytes).is_err());
    }

    #[test]
    fn unicode_replacement_keys_load_in_a_save_schema_pack() {
        let catalog: serde_json::Value = serde_json::from_slice(CATALOG).unwrap();
        let codec = catalog["codecs"]["pokemon_gen5_utf16le"].clone();
        let pack = serde_json::json!({
            "schema_version": 1,
            "text_codecs": { "pokemon_gen5_utf16le": codec },
            "games": [{
                "id": "demo",
                "name": "Demo",
                "platform": "test",
                "save_size": 16,
                "fields": [{
                    "id": "name",
                    "label": "Name",
                    "offset": 0,
                    "type": "ascii",
                    "length": 8,
                    "text_codec": "pokemon_gen5_utf16le"
                }]
            }]
        });

        SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap()).unwrap();
    }

    #[test]
    fn pokemon_gen1_and_gen2_builtin_codecs_bind() {
        for bytes in [
            include_bytes!("../../../../../data/save-schemas/builtin-pokemon-gen1.json").as_slice(),
            include_bytes!("../../../../../data/save-schemas/builtin-pokemon-gen2.json").as_slice(),
        ] {
            SaveSchemaPack::from_json(bytes).unwrap();
        }
    }

    #[test]
    fn zelda_lane_preserves_unrelated_bits() {
        let catalog = TextCodecCatalog::from_json(CATALOG).unwrap();
        let codec = catalog.get("zelda_alttp_english_name").unwrap();
        let mut bytes = [0x10; 12];
        codec.encode("Az", &mut bytes).unwrap();
        assert_eq!(codec.decode(&bytes).unwrap(), "Az");
        for unit in bytes.chunks_exact(2) {
            assert_ne!(u16::from_le_bytes([unit[0], unit[1]]) & 0x10, 0);
        }
    }
}
