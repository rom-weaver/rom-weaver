use super::{SchemaSaveHandler, schema::catalog};

#[test]
fn console_catalog_modules_build_expected_games() {
    for (schemas, expected) in [
        (
            catalog::mario_party::schemas(),
            "mario-party-canonical-eeprom",
        ),
        (
            catalog::mario_party_2::schemas(),
            "mario-party-2-canonical-eeprom",
        ),
        (catalog::secret_of_mana::schemas(), "secret-of-mana-slot-1"),
        (
            catalog::super_mario_64::schemas(),
            "super-mario-64-canonical-eeprom-mario-a",
        ),
        (
            catalog::super_mario_rpg::schemas(),
            "super-mario-rpg-slot-1",
        ),
        (catalog::super_metroid::schemas(), "super-metroid-samus-a"),
    ] {
        assert!(
            schemas
                .iter()
                .flat_map(SchemaSaveHandler::definitions)
                .any(|definition| definition.identity.id == expected),
            "catalog module omitted {expected}"
        );
    }
}
