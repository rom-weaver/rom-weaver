use serde::{Deserialize, Serialize};

use super::{
    FieldSchema, SaveConstraint, SaveFieldKind, SaveValue, invalid,
    rules::{Expr, Predicate, Store},
    text::TextCodec,
};
use crate::Result;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FieldBehavior {
    pub group: Option<String>,
    pub present_when: Option<Predicate>,
    pub editable_when: Option<Predicate>,
    pub read: Option<Expr>,
    pub xor: Option<Expr>,
    pub text_codec: Option<String>,
    #[serde(default)]
    pub on_edit: Vec<Store>,
    pub format: Option<Vec<FormatPart>>,
    pub presentation: Option<Presentation>,
    pub value_override: Option<ValueOverride>,
    pub unknown_choice: Option<UnknownChoice>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UnknownChoice {
    pub value: String,
    pub warning: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ValueOverride {
    pub when: Predicate,
    pub value: SaveValue,
    #[serde(default)]
    pub read_only: bool,
    pub description: Option<String>,
    pub warnings: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum FormatPart {
    Text(String),
    Number {
        value: Expr,
        #[serde(default)]
        width: u8,
    },
}

/// Overrides the reported field metadata. An omitted `kind`, `constraints`,
/// `step`, or `encoding` keeps the value derived from the field; an explicit
/// `null` step or encoding clears it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Presentation {
    #[serde(default)]
    pub relative_offset: bool,
    pub section_id: u8,
    pub offset: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<SaveFieldKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<SaveConstraint>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub step: Option<Option<u32>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub encoding: Option<Option<String>>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Keeps a present `null` distinct from an omitted member.
fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

impl FieldBehavior {
    pub fn work_bytes(&self) -> Result<usize> {
        let conditions = [&self.present_when, &self.editable_when]
            .into_iter()
            .flatten()
            .map(Predicate::work_bytes);
        let expressions = [&self.read, &self.xor]
            .into_iter()
            .flatten()
            .map(Expr::work_bytes);
        let format = self.format.iter().flatten().filter_map(|part| match part {
            FormatPart::Number { value, .. } => Some(value.work_bytes()),
            _ => None,
        });
        super::rules::sum_work(
            conditions
                .chain(expressions)
                .chain(format)
                .chain(self.on_edit.iter().map(Store::work_bytes))
                .chain(
                    self.value_override
                        .iter()
                        .map(|value| value.when.work_bytes()),
                ),
        )
    }
    pub fn metadata_bytes(&self) -> Result<usize> {
        if self.group.is_none()
            && self.present_when.is_none()
            && self.editable_when.is_none()
            && self.read.is_none()
            && self.xor.is_none()
            && self.text_codec.is_none()
            && self.on_edit.is_empty()
            && self.format.is_none()
            && self.presentation.is_none()
            && self.value_override.is_none()
            && self.unknown_choice.is_none()
        {
            return Ok(0);
        }
        serde_json::to_vec(self)
            .map(|bytes| bytes.len())
            .map_err(|error| invalid(&format!("invalid field behavior: {error}")))
    }
    pub fn shift(&mut self, base: usize, bits: usize, bit_stride: bool) -> Result<()> {
        for predicate in [&mut self.present_when, &mut self.editable_when]
            .into_iter()
            .flatten()
        {
            predicate.shift(base, bits, bit_stride)?;
        }
        for expr in [&mut self.read, &mut self.xor].into_iter().flatten() {
            expr.shift(base, bits, bit_stride)?;
        }
        for store in &mut self.on_edit {
            if let Some(when) = &mut store.when {
                when.shift(base, bits, bit_stride)?;
            }
            store.destination.shift(base, bits, bit_stride)?;
            store.value.shift(base, bits, bit_stride)?;
        }
        if let Some(override_) = &mut self.value_override {
            override_.when.shift(base, bits, bit_stride)?;
        }
        if let Some(parts) = &mut self.format {
            for part in parts {
                if let FormatPart::Number { value, .. } = part {
                    value.shift(base, bits, bit_stride)?;
                }
            }
        }
        if let Some(presentation) = &mut self.presentation
            && presentation.relative_offset
        {
            presentation.offset = usize::from(presentation.offset)
                .checked_add(bits / 8)
                .and_then(|offset| u16::try_from(offset).ok())
                .ok_or_else(|| invalid("record presentation offset exceeds u16"))?;
            presentation.relative_offset = false;
        }
        Ok(())
    }
    pub fn validate(&self, size: usize) -> Result<()> {
        if let Some(group) = &self.group {
            super::bounded_text(group, "field group")?;
        }
        for predicate in [&self.present_when, &self.editable_when]
            .into_iter()
            .flatten()
        {
            predicate.validate(size)?;
        }
        for expr in [&self.read, &self.xor].into_iter().flatten() {
            expr.validate(size)?;
        }
        if self.on_edit.len() > 128 {
            return Err(invalid("a field exceeds 128 write effects"));
        }
        for effect in &self.on_edit {
            effect.validate(size)?;
        }
        if let Some(parts) = &self.format {
            if parts.len() > 32 {
                return Err(invalid("a formatted field exceeds 32 parts"));
            }
            for part in parts {
                match part {
                    FormatPart::Text(text) => super::bounded_text_allow_empty(text, "format text")?,
                    FormatPart::Number { value, width } => {
                        if *width > 20 {
                            return Err(invalid("a format width exceeds 20 digits"));
                        }
                        value.validate(size)?;
                    }
                }
            }
        }
        if let Some(override_) = &self.value_override {
            override_.when.validate(size)?;
            if let Some(description) = &override_.description {
                super::bounded_text_allow_empty(description, "override description")?;
            }
            if let SaveValue::Text(value) | SaveValue::Enum(value) = &override_.value {
                super::bounded_text_allow_empty(value, "override value")?;
            }
            if let Some(warnings) = &override_.warnings {
                if warnings.len() > 128 {
                    return Err(invalid("field override exceeds 128 warnings"));
                }
                for warning in warnings {
                    super::bounded_text_allow_empty(warning, "override warning")?;
                }
            }
        }
        if let Some(choice) = &self.unknown_choice {
            super::bounded_text_allow_empty(&choice.value, "unknown choice value")?;
            super::bounded_text_allow_empty(&choice.warning, "unknown choice warning")?;
        }
        if let Some(presentation) = &self.presentation {
            let choices = presentation
                .constraints
                .as_ref()
                .map_or(&[][..], |constraints| &constraints.choices);
            for text in presentation
                .warnings
                .iter()
                .chain(choices)
                .chain(presentation.encoding.iter().flatten())
            {
                super::bounded_text_allow_empty(text, "field presentation")?;
            }
            if presentation.warnings.len() > 128 || choices.len() > 4096 {
                return Err(invalid("field presentation exceeds its collection limit"));
            }
        }
        Ok(())
    }

    pub fn formatted(&self, bytes: &[u8]) -> Result<Option<SaveValue>> {
        let Some(parts) = &self.format else {
            return Ok(None);
        };
        let mut output = String::new();
        for part in parts {
            match part {
                FormatPart::Text(text) => output.push_str(text),
                FormatPart::Number { value, width } => output.push_str(&format!(
                    "{:0width$}",
                    value.eval(bytes)?,
                    width = usize::from(*width)
                )),
            }
        }
        Ok(Some(SaveValue::Text(output)))
    }
}

impl FieldSchema {
    pub(super) fn present(&self, bytes: &[u8]) -> Result<bool> {
        self.behavior
            .present_when
            .as_ref()
            .map(|predicate| predicate.test(bytes))
            .transpose()
            .map(|value| value.unwrap_or(true))
    }

    pub(super) fn bind_codec(
        &mut self,
        codecs: &std::collections::BTreeMap<String, std::sync::Arc<TextCodec>>,
    ) -> Result<()> {
        if let Some(name) = &self.behavior.text_codec {
            if !matches!(self.storage, super::Storage::Ascii) {
                return Err(invalid("text_codec requires text storage"));
            }
            self.codec = Some(
                codecs
                    .get(name)
                    .ok_or_else(|| invalid("field references an unknown text codec"))?
                    .clone(),
            );
        }
        Ok(())
    }
}
