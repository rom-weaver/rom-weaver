use std::collections::HashSet;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::save::{SaveDocument, SaveEditResult};

#[derive(Deserialize)]
struct LegacyContract {
    games: Vec<String>,
    fields: HashSet<String>,
}

fn fields(game: &str) -> &'static HashSet<String> {
    // Legacy field IDs MUST stay frozen, including fields hidden in empty saves.
    // New fields and initializers MUST use independent value and byte tests.
    static CONTRACTS: OnceLock<Vec<LegacyContract>> = OnceLock::new();
    &CONTRACTS
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../tests/fixtures/save-legacy-fields.json"
            ))
            .expect("valid legacy field contract")
        })
        .iter()
        .find(|contract| contract.games.iter().any(|id| id == game))
        .expect("game has a frozen legacy contract")
        .fields
}

fn project_document(actual: &mut SaveDocument, expected: &SaveDocument) {
    let fields = fields(&expected.identity.id);
    assert!(
        expected
            .fields
            .iter()
            .all(|field| fields.contains(&field.id)),
        "the legacy reference must not add schema fields"
    );
    actual.fields.retain(|field| fields.contains(&field.id));
}

pub(super) fn assert_document(mut actual: SaveDocument, expected: &SaveDocument) {
    project_document(&mut actual, expected);
    assert_eq!(&actual, expected);
}

pub(super) fn assert_edit(mut actual: SaveEditResult, expected: SaveEditResult) {
    project_document(&mut actual.document, &expected.document);
    let fields = fields(&expected.document.identity.id);
    assert!(
        expected
            .preview
            .changes
            .iter()
            .all(|change| fields.contains(&change.field)),
        "the legacy reference must not edit schema fields"
    );
    actual
        .preview
        .changes
        .retain(|change| fields.contains(&change.field));
    assert_eq!(actual.document, expected.document);
    assert_eq!(actual.preview, expected.preview);
    assert_eq!(actual.bytes, expected.bytes);
}
