use rom_weaver_core::RomWeaverError;
use rom_weaver_core::save::{
    PokemonGen1Handler, PokemonGen2Handler, PokemonGen3Handler, PokemonGen4Handler,
    PokemonGen5Handler, SaveGameHandler, SuperMarioWorldHandler, ZeldaAlttpHandler,
};

#[test]
fn public_handlers_enforce_their_generation_capabilities() {
    let handlers: [&dyn SaveGameHandler; 7] = [
        &PokemonGen1Handler,
        &PokemonGen2Handler,
        &PokemonGen3Handler,
        &PokemonGen4Handler,
        &PokemonGen5Handler,
        &SuperMarioWorldHandler,
        &ZeldaAlttpHandler,
    ];
    for handler in handlers {
        for definition in handler.definitions() {
            let game = &definition.identity;
            let generated = handler.generate(game);
            if handler.supports_generation(game) {
                assert!(generated.is_ok(), "{}: {generated:?}", game.id);
            } else {
                let RomWeaverError::ValidationCode(error) = generated.unwrap_err() else {
                    panic!("{} must reject unsupported generation", game.id);
                };
                assert_eq!(error.code(), "save_generation_unsupported");
            }
        }
    }
}
