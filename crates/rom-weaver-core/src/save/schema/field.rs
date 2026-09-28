use super::{
    FieldSchema, SaveConstraint, SaveFieldKind, SaveValue, invalid,
    rules::{Condition, ReadValue, Scalar, Store},
    text::TextCodec,
};
use crate::Result;

#[derive(Clone, Debug, Default)]
pub struct FieldBehavior {
    pub group: Option<String>,
    pub present_when: Option<Condition>,
    pub editable_when: Option<Condition>,
    pub read: Option<ReadValue>,
    pub xor: Option<ReadValue>,
    pub text_codec: Option<String>,
    pub on_edit: Vec<Store>,
    pub format: Option<Vec<FormatPart>>,
    pub presentation: Option<Presentation>,
    pub value_override: Option<ValueOverride>,
    pub unknown_choice: Option<UnknownChoice>,
}

#[derive(Clone, Debug)]
pub struct UnknownChoice {
    pub value: String,
    pub warning: String,
}

#[derive(Clone, Debug)]
pub struct ValueOverride {
    pub when: Condition,
    pub value: SaveValue,
    pub read_only: bool,
    pub description: Option<String>,
    pub warnings: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
pub enum FormatPart {
    Text(String),
    Number { value: ReadValue, width: u8 },
}

/// Overrides the reported field metadata. An omitted `kind`, `constraints`,
/// `step`, or `encoding` keeps the value derived from the field; an explicit
/// `null` step or encoding clears it.
#[derive(Clone, Debug)]
pub struct Presentation {
    pub section_id: u8,
    pub offset: u16,
    pub kind: Option<SaveFieldKind>,
    pub constraints: Option<SaveConstraint>,
    pub step: Option<Option<u32>>,
    pub encoding: Option<Option<String>>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ArrayGuard {
    pub count: Scalar,
    pub index: usize,
    pub capacity: usize,
}

impl ArrayGuard {
    pub fn visible(&self, bytes: &[u8]) -> Result<bool> {
        let count = self.count.read(bytes)?;
        let count = usize::try_from(count)
            .ok()
            .filter(|count| *count <= self.capacity)
            .ok_or_else(|| invalid("a record array length exceeds its capacity"))?;
        Ok(self.index < count)
    }
}

impl FieldBehavior {
    pub fn validate(&self, size: usize) -> Result<()> {
        if let Some(group) = &self.group {
            super::bounded_text(group, "field group")?;
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
                    FormatPart::Number { value: _, width } => {
                        if *width > 20 {
                            return Err(invalid("a format width exceeds 20 digits"));
                        }
                    }
                }
            }
        }
        if let Some(override_) = &self.value_override {
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
        for guard in &self.array_guards {
            if !guard.visible(bytes)? {
                return Ok(false);
            }
        }
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
