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
}
