use rom_weaver_core::{RomWeaverError, SaveGameRegistry};

#[test]
fn registry_enforces_each_profiles_generation_capability() {
    let registry = SaveGameRegistry::default();
    let supported = registry.generation_definitions();
    let definitions = registry.definitions();
    assert_eq!(definitions.len(), 93);
    assert_eq!(supported.len(), 4);
    for definition in definitions {
        let id = &definition.identity.id;
        let generated = registry.generate(id);
        if supported.iter().any(|game| game.identity.id == *id) {
            let input = generated.unwrap();
            assert_eq!(
                input.bytes.len(),
                definition.supported_save_sizes[0] as usize
            );
            assert!(registry.parse(&input, &definition.identity).is_ok());
        } else {
            let RomWeaverError::ValidationCode(error) = generated.unwrap_err() else {
                panic!("{id} must reject unsupported generation");
            };
            assert_eq!(error.code(), "save_generation_unsupported");
        }
    }
}
