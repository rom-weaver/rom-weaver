use std::collections::BTreeMap;

use serde::Deserialize;
use tracing::debug;

use super::{
    GameSchema, MAX_COMPONENTS, SaveEdit, SaveIntegrityState, SaveValue, SpanBytes,
    check_nonempty_span, invalid, validate_field_id, validate_save_edits,
};
use crate::Result;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawGeneration {
    fill: u8,
    #[serde(default)]
    patches: Vec<RawPatch>,
    #[serde(default)]
    values: BTreeMap<String, SaveValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPatch {
    offset: usize,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(super) struct Generation {
    fill: u8,
    patches: Vec<SpanBytes>,
    values: BTreeMap<String, SaveValue>,
}

impl Generation {
    pub(super) fn build(raw: RawGeneration, size: usize) -> Result<Self> {
        if raw.patches.len() > MAX_COMPONENTS || raw.values.len() > MAX_COMPONENTS {
            return Err(invalid(
                "generation patches and values may each contain at most 4096 entries",
            ));
        }
        let patches = raw
            .patches
            .into_iter()
            .map(|patch| {
                check_nonempty_span(patch.offset, patch.bytes.len(), size, "generation patch")?;
                Ok(SpanBytes {
                    offset: patch.offset,
                    bytes: patch.bytes,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        for id in raw.values.keys() {
            validate_field_id(id)?;
        }
        Ok(Self {
            fill: raw.fill,
            patches,
            values: raw.values,
        })
    }

    fn initialize(&self, size: usize) -> Vec<u8> {
        let mut bytes = vec![self.fill; size];
        for patch in &self.patches {
            bytes[patch.offset..patch.offset + patch.bytes.len()].copy_from_slice(&patch.bytes);
        }
        bytes
    }
}

impl GameSchema {
    pub(super) fn validate_generation(&self) -> Result<()> {
        if self.generation.is_some() {
            self.generate_save()?;
        }
        Ok(())
    }

    pub(super) fn generate_save(&self) -> Result<Vec<u8>> {
        let generation = self.generation.as_ref().ok_or_else(|| {
            super::validation(
                "save_generation_unsupported",
                "this schema has no save initializer",
            )
        })?;
        let mut bytes = generation.initialize(self.save_size);
        let game = self.identity();
        let edits = generation
            .values
            .iter()
            .map(|(field, value)| SaveEdit {
                field: field.clone(),
                value: value.clone(),
            })
            .collect::<Vec<_>>();

        if self.runtime.layout.is_none() {
            for edit in &edits {
                let field = self
                    .fields
                    .iter()
                    .find(|field| field.id == edit.field)
                    .ok_or_else(|| {
                        super::validation(
                            "save_field_unknown",
                            "the requested save field does not exist",
                        )
                    })?;
                field.write(&mut bytes, &edit.value)?;
            }
            if !edits.is_empty() {
                for effect in &self.runtime.after_edit {
                    effect.apply(&mut bytes)?;
                }
                for check in self.runtime.checks.iter().chain(&self.runtime.edit_checks) {
                    check.run(&bytes)?;
                }
            }
            self.repair_integrity(&mut bytes);
            let document = self.valid_generation_document(&bytes, &game)?;
            validate_save_edits(&document, &edits)?;
            self.check_generation_round_trip(&document, &edits)?;
            debug!(game = %self.id, defaults = edits.len(), "generated schema save");
            return Ok(bytes);
        }

        // Layout initializers MUST already describe valid physical copies. Repairing
        // them here would require guessing which empty or invalid copy is active.
        self.valid_generation_document(&bytes, &game)?;
        if edits.is_empty() {
            return Ok(bytes);
        }
        let result = self.apply_edits(&self.input(bytes.clone()), &game, &edits, false)?;
        let bytes = result.bytes.unwrap_or(bytes);
        debug!(game = %self.id, defaults = edits.len(), "generated schema save");
        Ok(bytes)
    }

    fn valid_generation_document(
        &self,
        bytes: &[u8],
        game: &super::SaveGameIdentity,
    ) -> Result<super::SaveDocument> {
        let document = self.parse_document(&self.input(bytes.to_vec()), game)?;
        if matches!(
            document.integrity.state,
            SaveIntegrityState::Valid | SaveIntegrityState::ValidWithWarnings
        ) {
            return Ok(document);
        }
        Err(invalid(
            "the generation initializer failed schema integrity checks",
        ))
    }

    fn check_generation_round_trip(
        &self,
        document: &super::SaveDocument,
        edits: &[SaveEdit],
    ) -> Result<()> {
        for edit in edits {
            if document
                .fields
                .iter()
                .find(|field| field.id == edit.field)
                .map(|field| &field.value)
                != Some(&edit.value)
            {
                return Err(super::validation(
                    "save_edit_reparse_mismatch",
                    "the generated save did not produce the requested value",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{SaveDetectionInput, SaveGameHandler, SaveSchemaPack};
    use super::*;

    fn handler(
        fields: serde_json::Value,
        extra: serde_json::Value,
    ) -> super::super::SchemaSaveHandler {
        let mut game = serde_json::json!({
            "id": "demo",
            "name": "Demo",
            "platform": "test",
            "save_size": 16,
            "fields": fields,
        });
        game.as_object_mut()
            .expect("game object")
            .extend(extra.as_object().expect("extra object").clone());
        SaveSchemaPack::from_json(
            &serde_json::to_vec(&serde_json::json!({
                "schema_version": 1,
                "games": [game],
            }))
            .unwrap(),
        )
        .unwrap()
        .into_handlers()
        .remove(0)
    }

    fn identity(handler: &super::super::SchemaSaveHandler) -> super::super::SaveGameIdentity {
        handler.definitions().remove(0).identity
    }

    #[test]
    fn applies_numeric_text_and_masked_defaults_and_repairs_integrity() {
        let handler = handler(
            serde_json::json!([
                {"id":"unsigned","label":"Unsigned","offset":1,"type":"u8"},
                {"id":"signed","label":"Signed","offset":2,"type":"i8"},
                {"id":"name","label":"Name","offset":3,"type":"ascii","length":3},
                {"id":"masked","label":"Masked","offset":6,"type":"u8","mask":28}
            ]),
            serde_json::json!({
                "signatures": [{"offset":0,"bytes":[82]}],
                "checksums": [{"algorithm":"sum8","start":0,"length":7,"offset":7}],
                "mirrors": [{"source":0,"target":8,"length":8}],
                "generation": {
                    "fill": 0,
                    "patches": [{"offset":0,"bytes":[82]},{"offset":6,"bytes":[227]}],
                    "values": {
                        "unsigned":{"u32":3},
                        "signed":{"i32":-4},
                        "name":{"text":"AB"},
                        "masked":{"u32":5}
                    }
                }
            }),
        );
        let bytes = handler.generate(&identity(&handler)).unwrap();
        assert_eq!(&bytes[..7], &[82, 3, 252, b'A', b'B', 0, 247]);
        assert_eq!(bytes[7], 53);
        assert_eq!(&bytes[..8], &bytes[8..]);
    }

    #[test]
    fn rejects_unknown_read_only_and_invalid_defaults() {
        let fields = serde_json::json!([
            {"id":"editable","label":"Editable","offset":0,"type":"u8","max":3},
            {"id":"locked","label":"Locked","offset":1,"type":"u8","editable":false}
        ]);
        for values in [
            serde_json::json!({"missing":{"u32":1}}),
            serde_json::json!({"locked":{"u32":1}}),
            serde_json::json!({"editable":{"u32":4}}),
            serde_json::json!({"editable":{"text":"bad"}}),
        ] {
            let json = serde_json::json!({
                "schema_version":1,
                "games":[{
                    "id":"demo","name":"Demo","platform":"test","save_size":2,
                    "fields":fields,
                    "generation":{"fill":0,"values":values}
                }]
            });
            assert!(SaveSchemaPack::from_json(&serde_json::to_vec(&json).unwrap()).is_err());
        }
    }

    #[test]
    fn rejects_an_initializer_with_invalid_integrity() {
        let signature = serde_json::json!({
            "schema_version":1,
            "games":[{
                "id":"demo","name":"Demo","platform":"test","save_size":2,
                "fields":[],
                "signatures":[{"offset":0,"bytes":[82]}],
                "generation":{"fill":0}
            }]
        });
        let error = SaveSchemaPack::from_json(&serde_json::to_vec(&signature).unwrap())
            .expect_err("invalid initializer must be rejected");
        assert!(error.to_string().contains("initializer failed"));

        let layout = serde_json::json!({
            "schema_version":1,
            "games":[{
                "id":"demo","name":"Demo","platform":"test","save_size":2,
                "logical_size":1,"fields":[],
                "layout":{"groups":[{
                    "id":"slot","logical_offset":0,"logical_length":1,
                    "copies":{"kind":"fixed","candidates":[{
                        "spans":[{"logical_offset":0,"physical_offset":0,"length":1}],
                        "checksums":[{"algorithm":"sum8","start":0,"length":1,"offset":1}]
                    }]}
                }]},
                "generation":{"fill":0,"patches":[{"offset":0,"bytes":[1,0]}]}
            }]
        });
        assert!(SaveSchemaPack::from_json(&serde_json::to_vec(&layout).unwrap()).is_err());
    }

    #[test]
    fn defaults_apply_only_to_fresh_generation() {
        let handler = handler(
            serde_json::json!([
                {"id":"value","label":"Value","offset":0,"type":"u8","max":9},
                {"id":"name","label":"Name","offset":1,"type":"ascii","length":2}
            ]),
            serde_json::json!({"generation":{"fill":255,"values":{
                "value":{"u32":9},"name":{"text":"A"}
            }}}),
        );
        let game = identity(&handler);
        assert_eq!(&handler.generate(&game).unwrap()[..3], &[9, b'A', 0]);
        let mut existing = vec![0; 16];
        existing[..3].copy_from_slice(&[3, b'B', 0]);
        let input = SaveDetectionInput {
            bytes: existing,
            selected_game: Some("demo".into()),
            rom_sha1: None,
        };
        let result = handler
            .apply(
                &input,
                &game,
                &[SaveEdit {
                    field: "value".into(),
                    value: SaveValue::U32(4),
                }],
                false,
            )
            .unwrap();
        assert_eq!(&result.bytes.unwrap()[..3], &[4, b'B', 0]);
    }

    #[test]
    fn flat_defaults_are_applied_together_before_coupled_checks() {
        let handler = handler(
            serde_json::json!([
                {"id":"current","label":"Current","offset":0,"type":"u8"},
                {"id":"maximum","label":"Maximum","offset":1,"type":"u8"}
            ]),
            serde_json::json!({
                "edit_checks":[{
                    "assert":{"le":[
                        {"read":{"offset":0,"type":"u8"}},
                        {"read":{"offset":1,"type":"u8"}}
                    ]},
                    "code":"range","message":"current must not exceed maximum"
                }],
                "generation":{"fill":255,"values":{
                    "current":{"u32":3},"maximum":{"u32":5}
                }}
            }),
        );
        assert_eq!(
            &handler.generate(&identity(&handler)).unwrap()[..2],
            &[3, 5]
        );
    }

    #[test]
    fn layout_defaults_update_valid_copies_and_preserve_empty_groups() {
        let handler = handler(
            serde_json::json!([
                {"id":"value","label":"Value","offset":0,"type":"u8","group":"active"}
            ]),
            serde_json::json!({
                "save_size": 6,
                "logical_size": 2,
                "layout": {"groups":[
                    {
                        "id":"active","logical_offset":0,"logical_length":1,
                        "copies":{"kind":"fixed","candidates":[
                            {"spans":[{"logical_offset":0,"physical_offset":0,"length":1}],
                             "checksums":[{"algorithm":"sum8","start":0,"length":1,"offset":1}]},
                            {"spans":[{"logical_offset":0,"physical_offset":2,"length":1}],
                             "checksums":[{"algorithm":"sum8","start":2,"length":1,"offset":3}]}
                        ]},
                        "write":"clone_selected_to_all"
                    },
                    {
                        "id":"empty","logical_offset":1,"logical_length":1,
                        "copies":{"kind":"fixed","candidates":[
                            {"spans":[{"logical_offset":1,"physical_offset":4,"length":1}],
                             "signatures":[{"offset":4,"bytes":[9]}]},
                            {"spans":[{"logical_offset":1,"physical_offset":5,"length":1}],
                             "signatures":[{"offset":5,"bytes":[9]}]}
                        ]},
                        "empty":[0]
                    }
                ]},
                "generation": {
                    "fill":0,
                    "patches":[{"offset":0,"bytes":[1,255,1,255]}],
                    "values":{"value":{"u32":7}}
                }
            }),
        );
        let bytes = handler.generate(&identity(&handler)).unwrap();
        assert_eq!(bytes, vec![7, 249, 7, 249, 0, 0]);
    }
}
