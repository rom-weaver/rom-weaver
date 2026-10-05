#![no_main]
use libfuzzer_sys::fuzz_target;
use rom_weaver_core::save::{SaveDetectionInput, SaveGameRegistry};

fuzz_target!(|data: &[u8]| {
    if data.is_empty() || data.len() > 4096 {
        return;
    }
    let registry = SaveGameRegistry::default();
    let definitions = registry.generation_definitions();
    if definitions.is_empty() {
        panic!("save fuzz target has no generatable schemas");
    }
    let definition = &definitions[usize::from(data[0]) % definitions.len()];
    let mut valid = registry
        .generate(&definition.identity.id)
        .expect("generated schema");
    // Mutate valid authored saves to reach field/integrity parsing beyond detection.
    for pair in data[1..].chunks(3) {
        if pair.len() == 3 && !valid.bytes.is_empty() {
            let offset = usize::from(u16::from_le_bytes([pair[0], pair[1]])) % valid.bytes.len();
            valid.bytes[offset] ^= pair[2];
        }
    }
    let malformed = SaveDetectionInput {
        bytes: data.to_vec(),
        selected_game: Some(definition.identity.id.clone()),
        rom_sha1: None,
    };
    for input in [valid, malformed] {
        let recognition = registry.detect(&input);
        assert_eq!(recognition, registry.detect(&input));
        for candidate in recognition.candidates {
            if let Ok(document) = registry.parse(&input, &candidate.identity) {
                assert_eq!(document.save_size as usize, input.bytes.len());
                assert!(
                    document
                        .sections
                        .iter()
                        .all(|section| (section.physical_offset as usize) < input.bytes.len())
                );
            }
        }
    }
});
