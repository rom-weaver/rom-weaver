use super::{rules::Scalar, *};

const MAX_DEPTH: usize = 16;
const MAX_VISITS: usize = MAX_FIELDS * MAX_DEPTH;
const ARRAY_GUARD_COST: usize = 128;

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Record {
    Fields(Vec<RawField>),
    Nested(Definition),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Definition {
    #[serde(default)]
    fields: Vec<RawField>,
    #[serde(default)]
    records: Vec<Instance>,
}

impl Record {
    fn fields(&self) -> &[RawField] {
        match self {
            Self::Fields(fields) => fields,
            Self::Nested(record) => &record.fields,
        }
    }

    fn instances(&self) -> &[Instance] {
        match self {
            Self::Fields(_) => &[],
            Self::Nested(record) => &record.records,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Instance {
    record: String,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    id: String,
    #[serde(default = "one")]
    count: usize,
    stride: Option<usize>,
    stride_bits: Option<usize>,
    #[serde(default)]
    index_start: usize,
    #[serde(default)]
    index_width: u8,
    #[serde(default = "decimal")]
    index_radix: u8,
    count_from: Option<Scalar>,
    group: Option<String>,
}

fn one() -> usize {
    1
}

fn decimal() -> u8 {
    10
}

#[derive(Clone, Debug)]
pub(super) struct ArrayGuard {
    pub count: Scalar,
    index: usize,
    capacity: usize,
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

impl Instance {
    fn validate(&self, records: &BTreeMap<String, Record>) -> Result<()> {
        let record = records
            .get(&self.record)
            .ok_or_else(|| invalid("record instance references an unknown template"))?;
        if self.count == 0 || self.count > MAX_RECORD_COUNT {
            return Err(invalid("record instance count must be from 1 to 4096"));
        }
        if self.index_width > 10 || !matches!(self.index_radix, 10 | 16) {
            return Err(invalid(
                "record indices require width at most 10 and radix 10 or 16",
            ));
        }
        if self.index_start > u32::MAX as usize {
            return Err(invalid("record instance index_start must fit u32"));
        }
        if !self.id.is_empty() {
            validate_field_id(&render(&self.id, "0", "1"))?;
        }
        if let Some(group) = &self.group {
            bounded_text(group, "record layout group")?;
        }
        if self.stride.is_some() && self.stride_bits.is_some() {
            return Err(invalid(
                "record instance stride and stride_bits are mutually exclusive",
            ));
        }
        if self.count > 1 && self.stride.is_none() && self.stride_bits.is_none() {
            return Err(invalid(
                "repeated record instances require a positive stride or stride_bits",
            ));
        }
        if self.stride == Some(0) || self.stride_bits == Some(0) {
            return Err(invalid("record instance strides must be positive"));
        }
        if self.offset > MAX_SAVE_SIZE
            || self.stride.is_some_and(|stride| stride > MAX_SAVE_SIZE)
            || self
                .stride_bits
                .is_some_and(|stride| stride > MAX_SAVE_SIZE * 8)
        {
            return Err(invalid(
                "record instance displacement exceeds the save-size limit",
            ));
        }
        if self.stride_bits.is_some()
            && (!record.instances().is_empty()
                || record
                    .fields()
                    .iter()
                    .any(|field| !matches!(field.storage, Storage::Bit)))
        {
            return Err(invalid(
                "stride_bits requires a record containing only bit fields",
            ));
        }
        if let Some(count) = &self.count_from {
            count.validate(MAX_SAVE_SIZE)?;
        }
        Ok(())
    }
}

pub(super) fn validate_templates(records: &BTreeMap<String, Record>) -> Result<()> {
    if records.len() > MAX_COMPONENTS {
        return Err(invalid("record templates exceed 4096 entries"));
    }
    let mut fields = 0usize;
    let mut instances = 0usize;
    for (name, record) in records {
        validate_field_id(name)?;
        if record.fields().is_empty() && record.instances().is_empty() {
            return Err(invalid(
                "record templates must contain at least one field or record",
            ));
        }
        fields = bounded_add(
            fields,
            record.fields().len(),
            MAX_FIELDS,
            "record template fields exceed 4096 entries",
        )?;
        instances = bounded_add(
            instances,
            record.instances().len(),
            MAX_COMPONENTS,
            "nested record instances exceed 4096 entries",
        )?;
        for field in record.fields() {
            let mut field = field.clone();
            field.id = render(&field.id, "0", "1");
            field.label = render(&field.label, "0", "1");
            field.description = render(&field.description, "0", "1");
            FieldSchema::build(field, MAX_SAVE_SIZE)?;
        }
        for instance in record.instances() {
            instance.validate(records)?;
        }
    }
    let mut heights = BTreeMap::new();
    for name in records.keys() {
        height(name, records, &mut HashSet::new(), &mut heights)?;
    }
    Ok(())
}

fn height<'a>(
    name: &'a str,
    records: &'a BTreeMap<String, Record>,
    visiting: &mut HashSet<&'a str>,
    heights: &mut BTreeMap<&'a str, usize>,
) -> Result<usize> {
    if let Some(height) = heights.get(name) {
        return Ok(*height);
    }
    if !visiting.insert(name) {
        return Err(invalid("record templates cannot contain cycles"));
    }
    if visiting.len() > MAX_DEPTH {
        return Err(invalid("record nesting exceeds 16 levels"));
    }
    let mut result = 1;
    for instance in records[name].instances() {
        result = result.max(1 + height(&instance.record, records, visiting, heights)?);
    }
    if result > MAX_DEPTH {
        return Err(invalid("record nesting exceeds 16 levels"));
    }
    visiting.remove(name);
    heights.insert(name, result);
    Ok(result)
}

#[derive(Default)]
struct Scope {
    base: usize,
    bits: usize,
    bit_stride: bool,
    prefix: String,
    index: String,
    ordinal: String,
    group: Option<String>,
    guards: Vec<ArrayGuard>,
}

#[derive(Default)]
struct Budget {
    fields: usize,
    storage: usize,
    metadata: usize,
}

impl Budget {
    fn field(&mut self, field: &RawField, scope: &Scope) -> Result<()> {
        self.fields = bounded_add(
            self.fields,
            1,
            MAX_FIELDS,
            "expanded record fields exceed 4096 entries",
        )?;
        self.storage = bounded_add(
            self.storage,
            field.copies.len() + 1,
            MAX_FIELDS,
            "fields and their copies exceed 4096 storage locations",
        )?;
        let mut bytes = EXPANDED_FIELD_COST + field.behavior.metadata_bytes()?;
        for text in [&field.id, &field.label, &field.description] {
            bytes += render(text, &scope.index, &scope.ordinal).len();
        }
        bytes += scope.prefix.len() + usize::from(!scope.prefix.is_empty());
        bytes += field.copies.len() * EXPANDED_COPY_COST;
        bytes += scope.guards.len() * ARRAY_GUARD_COST;
        bytes += scope.group.as_ref().map_or(0, String::len);
        for choice in &field.choices {
            bytes += EXPANDED_CHOICE_COST + choice.name.len();
        }
        self.metadata = bounded_add(
            self.metadata,
            bytes,
            MAX_EXPANDED_METADATA_BYTES,
            "expanded record metadata exceeds 2 MiB",
        )?;
        Ok(())
    }
}

pub(super) fn expand(game: &mut RawGame, records: &BTreeMap<String, Record>) -> Result<()> {
    if game.records.len() > MAX_COMPONENTS {
        return Err(invalid("record instances exceed 4096 entries"));
    }
    let mut budget = Budget::default();
    let scope = Scope::default();
    for field in &game.fields {
        budget.field(field, &scope)?;
    }
    // The first pass MUST charge every expanded field before any field is cloned.
    walk(
        &game.records,
        records,
        &scope,
        &mut 0,
        &mut |field, scope| budget.field(field, scope),
    )?;
    let mut fields = Vec::with_capacity(budget.fields);
    fields.append(&mut game.fields);
    walk(
        &game.records,
        records,
        &scope,
        &mut 0,
        &mut |field, scope| {
            fields.push(materialize(field, scope)?);
            Ok(())
        },
    )?;
    game.fields = fields;
    Ok(())
}

fn walk(
    instances: &[Instance],
    records: &BTreeMap<String, Record>,
    parent: &Scope,
    visits: &mut usize,
    emit: &mut impl FnMut(&RawField, &Scope) -> Result<()>,
) -> Result<()> {
    for instance in instances {
        instance.validate(records)?;
        let template = &records[&instance.record];
        let parent_base = parent
            .base
            .checked_add(parent.bits / 8)
            .ok_or_else(|| invalid("record displacement overflows"))?;
        let base = parent_base
            .checked_add(instance.offset)
            .filter(|base| *base <= MAX_SAVE_SIZE)
            .ok_or_else(|| invalid("record displacement exceeds the save-size limit"))?;
        let mut count_from = instance.count_from.clone();
        if let Some(count) = &mut count_from {
            count.shift(parent_base, 0, false)?;
        }
        for repetition in 0..instance.count {
            *visits = bounded_add(
                *visits,
                1,
                MAX_VISITS,
                "expanded record traversal exceeds its limit",
            )?;
            let number = instance
                .index_start
                .checked_add(repetition)
                .filter(|index| *index <= u32::MAX as usize)
                .ok_or_else(|| invalid("record index overflows"))?;
            let width = usize::from(instance.index_width);
            let index = if instance.index_radix == 16 {
                format!("{number:0width$x}")
            } else {
                format!("{number:0width$}")
            };
            let ordinal = (repetition + 1).to_string();
            let prefix = join(&parent.prefix, &render(&instance.id, &index, &ordinal));
            bounded_text_allow_empty(&prefix, "record instance prefix")?;
            let bits = repetition
                .checked_mul(
                    instance
                        .stride_bits
                        .unwrap_or_else(|| instance.stride.unwrap_or(0) * 8),
                )
                .filter(|bits| *bits <= MAX_SAVE_SIZE * 8)
                .ok_or_else(|| invalid("record displacement exceeds the save-size limit"))?;
            let group = instance
                .group
                .as_ref()
                .map(|group| render(group, &index, &ordinal))
                .or_else(|| parent.group.clone());
            let mut guards = parent.guards.clone();
            if let Some(count) = &count_from {
                guards.push(ArrayGuard {
                    count: count.clone(),
                    index: repetition,
                    capacity: instance.count,
                });
            }
            let scope = Scope {
                base,
                bits,
                bit_stride: instance.stride_bits.is_some(),
                prefix,
                index,
                ordinal,
                group,
                guards,
            };
            for field in template.fields() {
                emit(field, &scope)?;
            }
            walk(template.instances(), records, &scope, visits, emit)?;
        }
    }
    Ok(())
}

fn materialize(source: &RawField, scope: &Scope) -> Result<RawField> {
    let mut field = source.clone();
    field.id = join(
        &scope.prefix,
        &render(&field.id, &scope.index, &scope.ordinal),
    );
    field.label = render(&field.label, &scope.index, &scope.ordinal);
    field.description = render(&field.description, &scope.index, &scope.ordinal);
    field.behavior.group = field
        .behavior
        .group
        .as_ref()
        .map(|group| render(group, &scope.index, &scope.ordinal))
        .or_else(|| scope.group.clone());
    field
        .behavior
        .shift(scope.base, scope.bits, scope.bit_stride)?;
    field.array_guards = scope.guards.clone();
    let shift = |offset: usize, bit: u8| -> Result<(usize, u8)> {
        let bits = offset
            .checked_add(scope.base)
            .and_then(|offset| offset.checked_mul(8))
            .and_then(|offset| offset.checked_add(scope.bits))
            .and_then(|offset| offset.checked_add(usize::from(bit)))
            .ok_or_else(|| invalid("record field offset overflows"))?;
        Ok((bits / 8, (bits % 8) as u8))
    };
    let bit = if scope.bit_stride {
        field.bit.expect("validated bit field")
    } else {
        0
    };
    let (offset, shifted_bit) = shift(field.offset, bit)?;
    field.offset = offset;
    if scope.bit_stride {
        field.bit = Some(shifted_bit);
    }
    for copy in &mut field.copies {
        *copy = shift(*copy, bit)?.0;
    }
    Ok(field)
}

fn bounded_add(value: usize, addition: usize, limit: usize, message: &str) -> Result<usize> {
    value
        .checked_add(addition)
        .filter(|value| *value <= limit)
        .ok_or_else(|| invalid(message))
}

fn render(value: &str, index: &str, ordinal: &str) -> String {
    value
        .replace("{index}", index)
        .replace("{index_upper}", &index.to_ascii_uppercase())
        .replace("{ordinal}", ordinal)
}

fn join(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.into()
    } else if child.is_empty() {
        parent.into()
    } else {
        format!("{parent}.{child}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn pack(records: Value, instances: Value) -> Value {
        json!({
            "schema_version": 1,
            "records": records,
            "games": [{
                "id": "demo", "name": "Demo", "platform": "test",
                "save_size": 32, "fields": [], "records": instances
            }]
        })
    }

    fn load(pack: &Value) -> Result<SaveSchemaPack> {
        SaveSchemaPack::from_json(&serde_json::to_vec(pack).unwrap())
    }

    fn counted_pack() -> Value {
        pack(
            json!({
                "item": [
                    {"id":"id","label":"Item {ordinal}","offset":0,"type":"u8"},
                    {"id":"quantity","label":"Quantity {ordinal}","offset":1,"type":"u8"}
                ],
                "bag": {
                    "fields":[{"id":"count","label":"Count","offset":0,"type":"u8","editable":false}],
                    "records":[{
                        "record":"item","id":"items.{index}","offset":1,
                        "count":3,"stride":2,"index_start":1,
                        "count_from":{"offset":0,"type":"u8","relative":true}
                    }]
                }
            }),
            json!([{"record":"bag","id":"bag{ordinal}","count":2,"stride":8}]),
        )
    }

    #[test]
    fn nested_counted_arrays_preserve_ids_offsets_and_unrelated_bytes() {
        let handler = load(&counted_pack()).unwrap().into_handlers().remove(0);
        let game = handler.definitions().remove(0).identity;
        let mut bytes = vec![99; 32];
        bytes[0] = 2;
        bytes[8] = 1;
        let input = SaveDetectionInput {
            bytes: bytes.clone(),
            selected_game: Some(game.id.clone()),
            rom_sha1: None,
        };
        let document = handler.parse(&input, &game).unwrap();
        assert_eq!(
            document
                .fields
                .iter()
                .map(|field| field.id.as_str())
                .collect::<Vec<_>>(),
            [
                "bag1.count",
                "bag1.items.1.id",
                "bag1.items.1.quantity",
                "bag1.items.2.id",
                "bag1.items.2.quantity",
                "bag2.count",
                "bag2.items.1.id",
                "bag2.items.1.quantity"
            ]
        );
        let result = handler
            .apply(
                &input,
                &game,
                &[SaveEdit {
                    field: "bag2.items.1.quantity".into(),
                    value: SaveValue::U32(7),
                }],
                false,
            )
            .unwrap();
        bytes[10] = 7;
        assert_eq!(result.bytes.unwrap(), bytes);
    }

    #[test]
    fn array_lengths_are_bounded_and_zero_hides_all_elements() {
        let handler = load(&counted_pack()).unwrap().into_handlers().remove(0);
        let game = handler.definitions().remove(0).identity;
        let mut input = SaveDetectionInput {
            bytes: vec![0; 32],
            selected_game: Some(game.id.clone()),
            rom_sha1: None,
        };
        assert_eq!(handler.parse(&input, &game).unwrap().fields.len(), 2);
        input.bytes[0] = 3;
        assert_eq!(handler.parse(&input, &game).unwrap().fields.len(), 8);
        input.bytes[0] = 4;
        assert!(
            handler
                .parse(&input, &game)
                .unwrap_err()
                .to_string()
                .contains("capacity")
        );
    }

    #[test]
    fn hex_indices_and_relative_rule_reads_follow_nested_byte_offsets() {
        let schema = pack(
            json!({
                "value": [{"id":"value_{index}","label":"Value {index_upper}","offset":0,"type":"u8",
                    "read":{"read":{"offset":0,"relative":true,"type":"u8"}}}],
                "parent": {"fields":[], "records":[{"record":"value","offset":2,"count":2,"stride":1,
                    "index_start":15,"index_radix":16,"index_width":2}]}
            }),
            json!([{"record":"parent","offset":8,"id":"slot"}]),
        );
        let handler = load(&schema).unwrap().into_handlers().remove(0);
        let game = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 32];
        bytes[10] = 17;
        bytes[11] = 23;
        let document = handler
            .parse(
                &SaveDetectionInput {
                    bytes,
                    selected_game: Some(game.id.clone()),
                    rom_sha1: None,
                },
                &game,
            )
            .unwrap();
        assert_eq!(document.fields[0].id, "slot.value_0f");
        assert_eq!(document.fields[1].id, "slot.value_10");
        assert_eq!(document.fields[0].label, "Value 0F");
        assert_eq!(document.fields[0].value, SaveValue::U32(17));
        assert_eq!(document.fields[1].value, SaveValue::U32(23));
    }

    #[test]
    fn rejects_cycles_unknown_references_and_nested_bit_strides() {
        for (records, instances) in [
            (
                json!({"loop":{"fields":[],"records":[{"record":"loop"}]}}),
                json!([]),
            ),
            (
                json!({"a":{"fields":[],"records":[{"record":"missing"}]}}),
                json!([]),
            ),
            (
                json!({"leaf":[{"id":"x","label":"X","offset":0,"type":"bit","bit":0}],
                "parent":{"fields":[],"records":[{"record":"leaf"}]}}),
                json!([{"record":"parent","count":2,"stride_bits":1}]),
            ),
        ] {
            assert!(load(&pack(records, instances)).is_err());
        }
    }

    #[test]
    fn bounds_nested_expansion_and_count_addresses_before_use() {
        let mut schema = counted_pack();
        schema["games"][0]["records"][0]["count"] = json!(4096);
        assert!(load(&schema).unwrap_err().to_string().contains("4096"));
        let mut schema = counted_pack();
        schema["records"]["bag"]["records"][0]["count_from"]["offset"] = json!(32);
        assert!(load(&schema).is_err());
        let mut definitions = serde_json::Map::new();
        definitions.insert(
            "r0".into(),
            json!([{"id":"x","label":"X","offset":0,"type":"u8"}]),
        );
        for depth in 1..=16 {
            definitions.insert(
                format!("r{depth}"),
                json!({"fields":[],"records":[{"record":format!("r{}",depth-1)}]}),
            );
        }
        assert!(
            load(&pack(Value::Object(definitions), json!([])))
                .unwrap_err()
                .to_string()
                .contains("16 levels")
        );
    }
}
