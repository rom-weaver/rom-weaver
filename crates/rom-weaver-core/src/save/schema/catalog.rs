use super::*;
use text::TextCodec;

fn build(
    games: Vec<GameDefinition>,
    codecs: BTreeMap<String, TextCodec>,
    require_selection: bool,
) -> Vec<SchemaSaveHandler> {
    games
        .into_iter()
        .map(|mut game| {
            game.runtime.require_selection = require_selection;
            SchemaSaveHandler::new(game, codecs.clone()).expect("built-in save schema is valid")
        })
        .collect()
}

struct Repetition {
    count: usize,
    start: usize,
    width: usize,
    base: usize,
    stride: usize,
    bit_stride: bool,
    prefix: &'static str,
}

impl Repetition {
    fn new(
        count: usize,
        start: usize,
        width: usize,
        base: usize,
        stride: usize,
        bit_stride: bool,
        prefix: &'static str,
    ) -> Self {
        Self {
            count,
            start,
            width,
            base,
            stride,
            bit_stride,
            prefix,
        }
    }
}

#[derive(Clone, Default)]
struct FieldScope {
    base: usize,
    bits: usize,
    bit_stride: bool,
    prefix: String,
    index: String,
    ordinal: usize,
    group: Option<String>,
    guards: Vec<field::ArrayGuard>,
}

impl FieldScope {
    fn field(&self, id: String, label: String, offset: usize, storage: Storage) -> FieldDefinition {
        FieldDefinition {
            array_guards: self.guards.clone(),
            behavior: field::FieldBehavior {
                group: self.group.clone(),
                ..Default::default()
            },
            ..FieldDefinition::new(self.id(&id), label, self.offset(offset, 0), storage)
        }
    }
    fn bit_field(&self, id: String, label: String, offset: usize, bit: u8) -> FieldDefinition {
        let mut field = self.field(id, label, offset, Storage::Bit);
        field.offset = self.offset(offset, bit);
        field.bit = Some(self.bit(bit));
        field
    }
    fn id(&self, suffix: &str) -> String {
        match (self.prefix.is_empty(), suffix.is_empty()) {
            (true, _) => suffix.into(),
            (_, true) => self.prefix.clone(),
            _ => format!("{}.{suffix}", self.prefix),
        }
    }

    fn offset(&self, offset: usize, bit: u8) -> usize {
        self.base + offset + (self.bits + if self.bit_stride { usize::from(bit) } else { 0 }) / 8
    }

    fn bit(&self, bit: u8) -> u8 {
        if self.bit_stride {
            ((self.bits + usize::from(bit)) % 8) as u8
        } else {
            bit
        }
    }

    fn address(&self) -> FieldAddress {
        FieldAddress {
            base: self.base,
            bits: self.bits,
            bit_stride: self.bit_stride,
        }
    }

    fn scalar(&self, offset: usize, storage: Storage, mask: Option<u32>) -> rules::Scalar {
        self.address().scalar(offset, storage, mask)
    }
}

#[derive(Clone, Copy)]
struct FieldAddress {
    base: usize,
    bits: usize,
    bit_stride: bool,
}

impl FieldAddress {
    fn scalar(self, offset: usize, storage: Storage, mask: Option<u32>) -> rules::Scalar {
        let bit = if self.bit_stride {
            let mask = mask.expect("bit arrays require a mask");
            assert!(mask.is_power_of_two(), "bit arrays require one-bit masks");
            mask.trailing_zeros() as usize
        } else {
            0
        };
        rules::Scalar {
            offset: self.base + offset + (self.bits + bit) / 8,
            storage,
            mask: if self.bit_stride {
                Some(1 << ((self.bits + bit) % 8))
            } else {
                mask
            },
        }
    }
}

fn read_at(bytes: &[u8], offset: i64, storage: Storage) -> Result<i64> {
    let offset =
        usize::try_from(offset).map_err(|_| invalid("save read offset is out of range"))?;
    rules::Scalar {
        offset,
        storage,
        mask: None,
    }
    .read(bytes)
}

pub(in crate::save) mod builtin_pokemon_gen1;
pub(in crate::save) mod builtin_pokemon_gen2;
pub(in crate::save) mod builtin_pokemon_gen3;
pub(in crate::save) mod builtin_pokemon_gen4;
pub(in crate::save) mod builtin_pokemon_gen5;
pub(in crate::save) mod builtin_super_mario_world;
pub(in crate::save) mod builtin_zelda_alttp;
pub(in crate::save) mod donkey_kong_country;
pub(in crate::save) mod donkey_kong_country_2_diddy_s_kong_quest;
pub(in crate::save) mod donkey_kong_country_3_dixie_kong_s_double_trouble;
pub(in crate::save) mod final_fantasy_nes;
pub(in crate::save) mod mario_party;
pub(in crate::save) mod mario_party_2;
pub(in crate::save) mod pokemon_generation_i;
pub(in crate::save) mod pokemon_generation_ii;
pub(in crate::save) mod secret_of_mana;
pub(in crate::save) mod solatorobo_red_the_hunter;
pub(in crate::save) mod super_mario_64;
pub(in crate::save) mod super_mario_kart;
pub(in crate::save) mod super_mario_rpg;
pub(in crate::save) mod super_mario_world;
pub(in crate::save) mod super_metroid;
pub(in crate::save) mod wario_land_super_mario_land_3;
pub(in crate::save) mod zelda_a_link_to_the_past;
pub(in crate::save) fn all() -> Vec<SchemaSaveHandler> {
    static CATALOG: std::sync::OnceLock<Vec<SchemaSaveHandler>> = std::sync::OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let mut games = Vec::new();
            games.extend(builtin_pokemon_gen2::schemas());
            games.extend(builtin_pokemon_gen3::schemas());
            games.extend(builtin_pokemon_gen4::schemas());
            games.extend(builtin_zelda_alttp::schemas());
            games.extend(builtin_pokemon_gen1::schemas());
            games.extend(builtin_pokemon_gen5::schemas());
            games.extend(builtin_super_mario_world::schemas());
            games.extend(donkey_kong_country_2_diddy_s_kong_quest::schemas());
            games.extend(donkey_kong_country_3_dixie_kong_s_double_trouble::schemas());
            games.extend(donkey_kong_country::schemas());
            games.extend(final_fantasy_nes::schemas());
            games.extend(mario_party_2::schemas());
            games.extend(mario_party::schemas());
            games.extend(pokemon_generation_i::schemas());
            games.extend(pokemon_generation_ii::schemas());
            games.extend(secret_of_mana::schemas());
            games.extend(solatorobo_red_the_hunter::schemas());
            games.extend(super_mario_64::schemas());
            games.extend(super_mario_kart::schemas());
            games.extend(super_mario_rpg::schemas());
            games.extend(super_mario_world::schemas());
            games.extend(super_metroid::schemas());
            games.extend(wario_land_super_mario_land_3::schemas());
            games.extend(zelda_a_link_to_the_past::schemas());
            games
        })
        .clone()
}

fn choices(entries: &[(&str, i64)]) -> Vec<FieldChoice> {
    entries
        .iter()
        .map(|(name, value)| FieldChoice {
            name: (*name).into(),
            value: *value,
        })
        .collect()
}
