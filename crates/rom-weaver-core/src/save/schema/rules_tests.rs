use super::*;
use serde_json::json;

fn load(game: serde_json::Value) -> SchemaSaveHandler {
    SaveSchemaPack::from_json(
        &serde_json::to_vec(&json!({"schema_version": 1, "games": [game]})).unwrap(),
    )
    .unwrap()
    .into_handlers()
    .remove(0)
}

#[test]
fn coupled_value_checks_accept_a_complete_batch_and_reject_partial_output() {
    let handler = load(json!({
        "id":"health", "name":"Health", "platform":"test", "save_size":16,
        "fields":[
            {"id":"capacity","label":"Capacity","offset":1,"type":"u8"},
            {"id":"health","label":"Health","offset":2,"type":"u8"}
        ],
        "signatures":[{"offset":0,"bytes":[82]}],
        "edit_checks":[{"assert":{"le":[{"read":{"offset":2,"type":"u8"}},{"read":{"offset":1,"type":"u8"}}]},"code":"health_range","message":"health cannot exceed capacity"}]
    }));
    let game = handler.definitions().remove(0).identity;
    let mut bytes = vec![0xa5; 16];
    bytes[..3].copy_from_slice(&[82, 8, 8]);
    let input = SaveDetectionInput {
        bytes: bytes.clone(),
        selected_game: Some(game.id.clone()),
        rom_sha1: None,
    };
    let capacity = SaveEdit {
        field: "capacity".into(),
        value: SaveValue::U32(4),
    };
    let health = SaveEdit {
        field: "health".into(),
        value: SaveValue::U32(4),
    };
    assert!(
        handler
            .apply(&input, &game, std::slice::from_ref(&capacity), false)
            .is_err()
    );
    for edits in [[capacity.clone(), health.clone()], [health, capacity]] {
        let result = handler.apply(&input, &game, &edits, false).unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(&output[..3], &[82, 4, 4]);
        assert_eq!(&output[3..], &bytes[3..]);
        let preview = handler.apply(&input, &game, &edits, true).unwrap();
        assert!(preview.bytes.is_none());
        assert_eq!(preview.document, result.document);
    }
    assert_eq!(input.bytes, bytes);
}

#[test]
fn repeated_bit_rules_move_their_relative_writes_across_bytes() {
    let pack = json!({"schema_version":1,"records":{"flag":[{
        "id":"flag_{index}","label":"Flag {index}","offset":0,"type":"bit","bit":0,
        "on_edit":[{"destination":{"offset":4,"type":"u8","mask":1,"relative":true},"value":{"read":{"offset":0,"type":"u8","mask":1,"relative":true}}}]
    }]},"games":[{"id":"flags","name":"Flags","platform":"test","save_size":16,"fields":[],"records":[{"id":"flags","record":"flag","offset":0,"count":9,"stride_bits":1}]}]});
    let handler = SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap())
        .unwrap()
        .into_handlers()
        .remove(0);
    let game = handler.definitions().remove(0).identity;
    let mut bytes = vec![0; 16];
    bytes[5] = 0xf0;
    let input = SaveDetectionInput {
        bytes,
        selected_game: Some(game.id.clone()),
        rom_sha1: None,
    };
    let result = handler
        .apply(
            &input,
            &game,
            &[SaveEdit {
                field: "flags.flag_8".into(),
                value: SaveValue::Bool(true),
            }],
            false,
        )
        .unwrap();
    let output = result.bytes.unwrap();
    assert_eq!(
        (output[0], output[1], output[4], output[5]),
        (0, 1, 0, 0xf1)
    );
}

#[test]
fn repeated_rules_and_large_byte_predicates_share_pack_work_limits() {
    let checks = (0..9).map(|_|json!({"assert":{"uniform":{"offset":0,"length":8388608,"values":[0]}},"code":"range","message":"invalid range"})).collect::<Vec<_>>();
    let pack = json!({"schema_version":1,"games":[{"id":"bounded","name":"Bounded","platform":"test","save_size":8388608,"fields":[],"checks":checks}]});
    assert!(
        SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap())
            .unwrap_err()
            .to_string()
            .contains("64 MiB")
    );
    let effects = (0..128)
        .map(|_| json!({"destination":{"offset":5000,"type":"u8"},"value":0,"when":{"eq":[1,1]}}))
        .collect::<Vec<_>>();
    let pack = json!({"schema_version":1,"records":{"entry":[{"id":"value_{index}","label":"Value","offset":0,"type":"u8","on_edit":effects}]},"games":[{"id":"bounded","name":"Bounded","platform":"test","save_size":8192,"fields":[],"records":[{"id":"item","record":"entry","offset":0,"count":4096,"stride":1}]}]});
    assert!(
        SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap())
            .unwrap_err()
            .to_string()
            .contains("metadata")
    );
}

#[test]
fn logical_integrity_ranges_are_checked_before_recognition() {
    let mut game = json!({
        "id":"mapped", "name":"Mapped", "platform":"test", "save_size":16,
        "logical_size":8, "fields":[],
        "layout":{"groups":[{"id":"body","logical_offset":0,"logical_length":8,
            "copies":{"kind":"fixed","candidates":[{"spans":[{
                "logical_offset":0,"physical_offset":8,"length":8
            }]}]}}]},
        "signatures":[{"offset":0,"bytes":[82]}]
    });
    game["fields"] = json!([{"id":"value","label":"Value","offset":1,"type":"u8"}]);
    game["checksums"] = json!([{"algorithm":"add8","start":0,"length":7,"offset":7}]);
    let handler = load(game.clone());
    let mut bytes = vec![0; 16];
    bytes[8] = 82;
    bytes[15] = 82;
    let input = SaveDetectionInput {
        bytes,
        selected_game: None,
        rom_sha1: None,
    };
    assert!(matches!(
        handler.recognize(&input).outcome,
        SaveRecognitionOutcome::Recognized { .. }
    ));
    let identity = handler.definitions().remove(0).identity;
    let output = handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "value".into(),
                value: SaveValue::U32(1),
            }],
            false,
        )
        .unwrap()
        .bytes
        .unwrap();
    assert_eq!((output[9], output[15]), (1, 83));
    assert_eq!(&output[..8], &input.bytes[..8]);
    for component in [
        json!({"signatures":[{"offset":15,"bytes":[82]}]}),
        json!({"checksums":[{"algorithm":"sum8","start":0,"length":8,"offset":15}]}),
        json!({"mirrors":[{"source":0,"target":15,"length":1}]}),
    ] {
        game["signatures"] = json!([]);
        game["checksums"] = json!([]);
        game["mirrors"] = json!([]);
        for (key, value) in component.as_object().unwrap() {
            game[key] = value.clone();
        }
        let pack = json!({"schema_version":1,"games":[game.clone()]});
        assert!(SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap()).is_err());
    }
}

#[test]
fn repeated_checks_move_relative_reads_and_keep_absolute_reads() {
    // Byte 0 holds the limit; each 2-byte slot holds a value and an active flag.
    let check = |repeat: serde_json::Value| {
        json!({
            "when":{"ne":[{"read":{"offset":2,"type":"u8","relative":true}},0]},
            "assert":{"le":[{"read":{"offset":1,"type":"u8","relative":true}},{"read":{"offset":0,"type":"u8"}}]},
            "code":"slot_range", "message":"a slot exceeds the limit", "repeat":repeat
        })
    };
    let game = |repeat: serde_json::Value| {
        json!({"id":"slots", "name":"Slots", "platform":"test", "save_size":8, "fields":[],
            "checks":[check(repeat)]})
    };
    let handler = load(game(json!({"count":3,"stride":2})));
    let game_id = handler.definitions().remove(0).identity;
    let parse = |bytes: Vec<u8>| {
        handler.parse(
            &SaveDetectionInput {
                bytes,
                selected_game: Some(game_id.id.clone()),
                rom_sha1: None,
            },
            &game_id,
        )
    };
    assert!(parse(vec![5, 5, 1, 5, 1, 6, 0, 9]).is_ok());
    let RomWeaverError::ValidationCode(error) = parse(vec![5, 5, 0, 5, 0, 6, 1, 0]).unwrap_err()
    else {
        panic!("the third repetition must fail with a validation code");
    };
    assert_eq!(error.code(), "slot_range");
    for repeat in [json!({"count":0,"stride":2}), json!({"count":3,"stride":0})] {
        let pack = json!({"schema_version":1,"games":[game(repeat)]});
        assert!(
            SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap())
                .unwrap_err()
                .to_string()
                .contains("check repeat")
        );
    }
    let pack = json!({"schema_version":1,"games":[game(json!({"count":5,"stride":2}))]});
    assert!(SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap()).is_err());

    let every_list = load(json!({
        "id":"lists", "name":"Lists", "platform":"test", "save_size":8, "fields":[],
        "document_checks":[check(json!({"count":2,"stride":2}))],
        "edit_checks":[check(json!({"count":3,"stride":2}))],
        "recognition":{"checks":[check(json!({"count":2,"stride":1}))],
            "reasons":["selected_game"],"confidence":"high"}
    }));
    let runtime = &every_list.game.runtime;
    let recognition = &runtime.recognition.as_ref().unwrap().checks;
    for (checks, count) in [
        (&runtime.document_checks, 2),
        (&runtime.edit_checks, 3),
        (recognition, 2),
    ] {
        assert_eq!(checks.len(), count);
        assert!(checks.iter().all(|check| check.repeat.is_none()));
    }
}

#[test]
fn repeated_checks_meet_their_limits_before_expansion() {
    let terms = (0..1400).map(|_| json!({"eq":[1,1]})).collect::<Vec<_>>();
    let wide = json!({"schema_version":1,"games":[{"id":"wide","name":"Wide","platform":"test",
        "save_size":8,"fields":[],"checks":[{"assert":{"all":terms},"code":"wide",
        "message":"wide","repeat":{"count":4096,"stride":1}}]}]});
    assert!(
        SaveSchemaPack::from_json(&serde_json::to_vec(&wide).unwrap())
            .unwrap_err()
            .to_string()
            .contains("depth or work limit")
    );
    let heavy = json!({"schema_version":1,"games":[{"id":"heavy","name":"Heavy","platform":"test",
        "save_size":8388608,"fields":[],"checks":[{"assert":{"uniform":{"offset":0,
        "length":8388608,"values":[0]}},"code":"heavy","message":"heavy",
        "repeat":{"count":9,"stride":1}}]}]});
    assert!(
        SaveSchemaPack::from_json(&serde_json::to_vec(&heavy).unwrap())
            .unwrap_err()
            .to_string()
            .contains("64 MiB")
    );
}

#[test]
fn presentation_kind_and_constraints_reject_null() {
    for member in ["kind", "constraints"] {
        let mut presentation = json!({"section_id":0,"offset":0});
        presentation[member] = serde_json::Value::Null;
        let pack = json!({"schema_version":1,"games":[{"id":"nulls","name":"Nulls",
            "platform":"test","save_size":8,"fields":[{"id":"value","label":"Value",
            "offset":0,"type":"u8","presentation":presentation}]}]});
        assert!(
            SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap()).is_err(),
            "{member}: null must be rejected"
        );
    }
}

#[test]
fn record_ordinals_and_omitted_presentation_members_follow_the_field() {
    let pack = json!({"schema_version":1,"records":{"slot":[{
        "id":"slot_{index}","label":"Slot {ordinal}","offset":0,"type":"u8","min":0,"max":9,
        "presentation":{"section_id":3,"offset":0,"relative_offset":true}
    },{
        "id":"name_{index}","label":"Name {ordinal}","offset":1,"type":"ascii","length":1,
        "presentation":{"section_id":3,"offset":1,"relative_offset":true,"step":null,"encoding":null}
    }]},"games":[{"id":"slots","name":"Slots","platform":"test","save_size":8,"fields":[],
        "records":[{"id":"bag","record":"slot","offset":2,"count":2,"stride":2}]}]});
    let handler = SaveSchemaPack::from_json(&serde_json::to_vec(&pack).unwrap())
        .unwrap()
        .into_handlers()
        .remove(0);
    let game = handler.definitions().remove(0).identity;
    let document = handler
        .parse(
            &SaveDetectionInput {
                bytes: vec![0, 0, 4, b'A', 7, b'B', 0, 0],
                selected_game: Some(game.id.clone()),
                rom_sha1: None,
            },
            &game,
        )
        .unwrap();
    let fields = &document.fields;
    let slot = fields
        .iter()
        .find(|field| field.id == "bag.slot_1")
        .unwrap();
    assert_eq!(slot.label, "Slot 2");
    assert_eq!((slot.section_id, slot.offset), (3, 2));
    assert_eq!(slot.kind, SaveFieldKind::UnsignedInteger);
    assert_eq!(
        (slot.constraints.min, slot.constraints.max),
        (Some(0), Some(9))
    );
    assert_eq!(slot.step, Some(1));
    let name = fields
        .iter()
        .find(|field| field.id == "bag.name_0")
        .unwrap();
    assert_eq!(name.label, "Name 1");
    assert_eq!((name.step, name.encoding.as_deref()), (None, None));
    assert_eq!(name.constraints.max_length, Some(1));
}
