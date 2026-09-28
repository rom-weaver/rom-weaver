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
