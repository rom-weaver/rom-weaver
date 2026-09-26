use super::SaveSchemaPack;

#[test]
fn console_catalog_packs_parse() {
    for bytes in [
        include_bytes!("../../../../data/save-schemas/mario-party.json").as_slice(),
        include_bytes!("../../../../data/save-schemas/mario-party-2.json").as_slice(),
        include_bytes!("../../../../data/save-schemas/secret-of-mana.json").as_slice(),
        include_bytes!("../../../../data/save-schemas/super-mario-64.json").as_slice(),
        include_bytes!("../../../../data/save-schemas/super-mario-rpg.json").as_slice(),
        include_bytes!("../../../../data/save-schemas/super-metroid.json").as_slice(),
    ] {
        SaveSchemaPack::from_json(bytes).expect("catalog schema must parse");
    }
}
