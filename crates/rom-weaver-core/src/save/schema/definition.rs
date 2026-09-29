use super::*;

impl FieldDefinition {
    pub fn description(mut self, value: String) -> Self {
        self.description = value;
        self
    }
    pub fn bit(mut self, value: u8) -> Self {
        self.bit = Some(value);
        self
    }
    pub fn length(mut self, value: u8) -> Self {
        self.length = Some(value);
        self
    }
    pub fn min(mut self, value: i64) -> Self {
        self.min = Some(value);
        self
    }
    pub fn max(mut self, value: i64) -> Self {
        self.max = Some(value);
        self
    }
    pub fn editable(mut self, value: bool) -> Self {
        self.editable = Some(value);
        self
    }
    pub fn inverted(mut self, value: bool) -> Self {
        self.inverted = value;
        self
    }
    pub fn copies(mut self, value: Vec<usize>) -> Self {
        self.copies = value;
        self
    }
    pub fn choices(mut self, value: Vec<FieldChoice>) -> Self {
        self.choices = value;
        self
    }
    pub fn mask(mut self, value: u32) -> Self {
        self.mask = Some(value);
        self
    }
    pub fn behavior(mut self, mut behavior: field::FieldBehavior) -> Self {
        if behavior.group.is_none() {
            behavior.group = self.behavior.group;
        }
        self.behavior = behavior;
        self
    }
    pub fn presentation(mut self, presentation: field::Presentation) -> Self {
        self.behavior.presentation = Some(presentation);
        self
    }
    pub fn text_codec(mut self, codec: &str) -> Self {
        self.behavior.text_codec = Some(codec.into());
        self
    }
}
impl ChecksumDefinition {
    pub fn new(algorithm: ChecksumAlgorithm, offset: usize) -> Self {
        Self {
            algorithm,
            offset,
            start: None,
            length: None,
            spans: Vec::new(),
            target: None,
            unit: ChecksumUnit::default(),
            exclude: Vec::new(),
        }
    }
}
impl field::Presentation {
    pub fn new(section_id: u8, offset: u16) -> Self {
        Self {
            section_id,
            offset,
            kind: None,
            constraints: None,
            step: None,
            encoding: None,
            warnings: Vec::new(),
        }
    }
    fn constraints_mut(&mut self) -> &mut SaveConstraint {
        self.constraints.get_or_insert_with(Default::default)
    }
    pub fn constraints(mut self, constraints: SaveConstraint) -> Self {
        self.constraints = Some(constraints);
        self
    }
    pub fn range(mut self, min: i64, max: i64) -> Self {
        self.constraints_mut().min = Some(min);
        self.constraints_mut().max = Some(max);
        self
    }
    pub fn text_length(mut self, max: u8) -> Self {
        self.constraints_mut().max_length = Some(max);
        self
    }
    pub fn choices(mut self, choices: Vec<String>) -> Self {
        self.constraints_mut().choices = choices;
        self
    }
    pub fn step(mut self, step: Option<u32>) -> Self {
        self.step = Some(step);
        self
    }
    pub fn encoding(mut self, encoding: Option<&str>) -> Self {
        self.encoding = Some(encoding.map(Into::into));
        self
    }
    pub fn kind(mut self, kind: SaveFieldKind) -> Self {
        self.kind = Some(kind);
        self
    }
    pub fn warnings(mut self, warnings: Vec<String>) -> Self {
        self.warnings = warnings;
        self
    }
}
