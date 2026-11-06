use super::*;

// Edits each editable field of a profile in turn and records the bytes each edit changes.

pub(super) struct FieldEdit {
    pub id: String,
    pub value: SaveValue,
    pub after: Vec<u8>,
    /// Changed bytes (or bits) outside the edited field's own storage.
    pub stray: Vec<usize>,
    pub fields: Vec<SaveField>,
}

pub(super) fn input(bytes: Vec<u8>, id: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(id.into()),
        rom_sha1: None,
    }
}

pub(super) fn handler(game: &GameDefinition) -> SchemaSaveHandler {
    build(vec![game.clone()], BTreeMap::new(), true).remove(0)
}

/// The bits of byte `index` that the field owns, per its own storage description.
fn owned_bits(field: &FieldDefinition, index: usize) -> u8 {
    if index < field.offset
        || index
            >= field.offset
                + field
                    .storage
                    .properties(field.length)
                    .expect("field storage is valid")
                    .0
    {
        return 0;
    }
    match (field.storage, field.bit, field.mask) {
        (Storage::Bit, Some(bit), _) => 1 << bit,
        (_, _, Some(mask)) => mask as u8,
        _ => 0xff,
    }
}

/// A valid value different from the current one, or `None` for read-only fields.
fn alternate(field: &SaveField) -> Option<SaveValue> {
    if !field.editable {
        return None;
    }
    Some(match &field.value {
        SaveValue::Bool(value) => SaveValue::Bool(!value),
        SaveValue::Enum(name) => SaveValue::Enum(
            field
                .constraints
                .choices
                .iter()
                .rev()
                .find(|choice| *choice != name)?
                .clone(),
        ),
        SaveValue::U32(value) => {
            let max = field.constraints.max.unwrap() as u32;
            SaveValue::U32(if *value == max {
                field.constraints.min.unwrap() as u32
            } else {
                max
            })
        }
        SaveValue::I32(value) => {
            let max = field.constraints.max.unwrap() as i32;
            SaveValue::I32(if *value == max {
                field.constraints.min.unwrap() as i32
            } else {
                max
            })
        }
        other => panic!("unexpected value {other:?}"),
    })
}

pub(super) fn edit_each_field(game: &GameDefinition, template: &[u8]) -> Vec<FieldEdit> {
    let handler = handler(game);
    let identity = handler.definitions().remove(0).identity;
    let source = input(template.to_vec(), &identity.id);
    let document = handler.parse(&source, &identity).unwrap();
    let mut edits = Vec::new();
    for field in &document.fields {
        let Some(value) = alternate(field) else {
            continue;
        };
        let result = handler
            .apply(
                &source,
                &identity,
                &[SaveEdit {
                    field: field.id.clone(),
                    value: value.clone(),
                }],
                false,
            )
            .unwrap_or_else(|error| panic!("{}: {error}", field.id));
        let after = result.bytes.expect("the edit changes the template");
        let definition = game
            .fields
            .iter()
            .find(|definition| definition.id == field.id)
            .unwrap();
        let stray = (0..after.len())
            .filter(|index| {
                (template[*index] ^ after[*index]) & !owned_bits(definition, *index) != 0
            })
            .collect();
        let fields = handler
            .parse(&input(after.clone(), &identity.id), &identity)
            .unwrap()
            .fields;
        edits.push(FieldEdit {
            id: field.id.clone(),
            value,
            after,
            stray,
            fields,
        });
    }
    edits
}

/// Asserts the edit moved only its own field among the decoded values, except `derived`.
pub(super) fn assert_only_changed(edit: &FieldEdit, original: &[SaveField], derived: &[&str]) {
    assert_eq!(edit.fields.len(), original.len());
    for (after, before) in edit.fields.iter().zip(original) {
        if after.id == edit.id {
            assert_eq!(after.value, edit.value, "{}", edit.id);
        } else if !derived.contains(&after.id.as_str()) {
            assert_eq!(
                after.value, before.value,
                "{} changed {}",
                edit.id, after.id
            );
        }
    }
}

pub(super) fn parse_fields(game: &GameDefinition, bytes: &[u8]) -> Vec<SaveField> {
    let handler = handler(game);
    let identity = handler.definitions().remove(0).identity;
    handler
        .parse(&input(bytes.to_vec(), &identity.id), &identity)
        .unwrap()
        .fields
}

pub(super) fn lcg_fill(bytes: &mut [u8], mut seed: u32) {
    for byte in bytes {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *byte = (seed >> 24) as u8;
    }
}
