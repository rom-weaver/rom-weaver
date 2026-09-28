use std::sync::OnceLock;

use super::{
    SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveGameDefinition,
    SaveGameHandler, SaveGameIdentity, SaveRecognition, SaveRecognitionOutcome,
    schema::{SchemaSaveHandler, catalog},
};
use crate::{Result, RomWeaverError};

fn definitions(handlers: &[SchemaSaveHandler]) -> Vec<SaveGameDefinition> {
    handlers
        .iter()
        .flat_map(SaveGameHandler::definitions)
        .collect()
}

fn find_handler<'a>(
    handlers: &'a [SchemaSaveHandler],
    game: &SaveGameIdentity,
) -> Result<&'a SchemaSaveHandler> {
    handlers
        .iter()
        .find(|handler| {
            handler
                .definitions()
                .iter()
                .any(|definition| definition.identity == *game)
        })
        .ok_or_else(|| RomWeaverError::Validation("the selected save game is unsupported".into()))
}

fn recognize(handlers: &[SchemaSaveHandler], input: &SaveDetectionInput) -> SaveRecognition {
    let mut candidates = Vec::new();
    let mut recognized_reasons = Vec::new();
    let mut unsupported_reasons = Vec::new();
    for handler in handlers {
        let recognition = handler.recognize(input);
        if !recognition.candidates.is_empty() {
            recognized_reasons.extend(recognition.reasons.clone());
        }
        candidates.extend(recognition.candidates);
        if let SaveRecognitionOutcome::Unsupported {
            reasons: unsupported,
        } = recognition.outcome
        {
            for reason in unsupported {
                if !unsupported_reasons.contains(&reason) {
                    unsupported_reasons.push(reason);
                }
            }
        }
    }
    let reasons = if candidates.is_empty() {
        unsupported_reasons
    } else {
        recognized_reasons
    };
    let outcome = match candidates.as_slice() {
        [candidate] => SaveRecognitionOutcome::Recognized {
            candidate: candidate.clone(),
        },
        [] => SaveRecognitionOutcome::Unsupported {
            reasons: reasons.clone(),
        },
        _ => SaveRecognitionOutcome::Ambiguous {
            candidates: candidates.clone(),
        },
    };
    SaveRecognition {
        outcome,
        candidates,
        reasons,
    }
}

fn generate_first(handlers: &[SchemaSaveHandler]) -> Result<Vec<u8>> {
    let handler = handlers
        .first()
        .ok_or_else(|| RomWeaverError::Validation("the built-in schema catalog is empty".into()))?;
    let identity = handler
        .definitions()
        .into_iter()
        .next()
        .ok_or_else(|| RomWeaverError::Validation("the built-in schema has no game".into()))?
        .identity;
    handler.generate(&identity)
}

macro_rules! builtin_handler {
    ($name:ident, $catalog:ident) => {
        #[derive(Clone, Copy, Debug, Default)]
        pub struct $name;

        impl $name {
            fn handlers() -> &'static [SchemaSaveHandler] {
                static HANDLERS: OnceLock<Vec<SchemaSaveHandler>> = OnceLock::new();
                HANDLERS.get_or_init(catalog::$catalog::schemas)
            }
        }

        impl SaveGameHandler for $name {
            fn definitions(&self) -> Vec<SaveGameDefinition> {
                definitions(Self::handlers())
            }

            fn supports_generation(&self, game: &SaveGameIdentity) -> bool {
                find_handler(Self::handlers(), game)
                    .is_ok_and(|handler| handler.supports_generation(game))
            }

            fn generate(&self, game: &SaveGameIdentity) -> Result<Vec<u8>> {
                find_handler(Self::handlers(), game)?.generate(game)
            }

            fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
                recognize(Self::handlers(), input)
            }

            fn parse(
                &self,
                input: &SaveDetectionInput,
                game: &SaveGameIdentity,
            ) -> Result<SaveDocument> {
                find_handler(Self::handlers(), game)?.parse(input, game)
            }

            fn apply(
                &self,
                input: &SaveDetectionInput,
                game: &SaveGameIdentity,
                edits: &[SaveEdit],
                dry_run: bool,
            ) -> Result<SaveEditResult> {
                find_handler(Self::handlers(), game)?.apply(input, game, edits, dry_run)
            }
        }
    };
}

builtin_handler!(PokemonGen1Handler, builtin_pokemon_gen1);
builtin_handler!(PokemonGen2Handler, builtin_pokemon_gen2);
builtin_handler!(PokemonGen3Handler, builtin_pokemon_gen3);
builtin_handler!(PokemonGen4Handler, builtin_pokemon_gen4);
builtin_handler!(PokemonGen5Handler, builtin_pokemon_gen5);
builtin_handler!(SuperMarioWorldHandler, builtin_super_mario_world);
builtin_handler!(ZeldaAlttpHandler, builtin_zelda_alttp);

impl SuperMarioWorldHandler {
    pub fn generate() -> Result<Vec<u8>> {
        generate_first(Self::handlers())
    }
}

impl ZeldaAlttpHandler {
    pub fn generate() -> Result<Vec<u8>> {
        generate_first(Self::handlers())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_pack_loads_and_defines_games() {
        let counts = [
            PokemonGen1Handler.definitions().len(),
            PokemonGen2Handler.definitions().len(),
            PokemonGen3Handler.definitions().len(),
            PokemonGen4Handler.definitions().len(),
            PokemonGen5Handler.definitions().len(),
            SuperMarioWorldHandler.definitions().len(),
            ZeldaAlttpHandler.definitions().len(),
        ];
        assert!(counts.iter().all(|count| *count > 0));
    }
}
