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
    // Repeated fields MUST share this construction code to bound WASM size.
    #[inline(never)]
    fn field(&self, id: &str, label: &str, offset: usize, storage: Storage) -> FieldDefinition {
        FieldDefinition {
            array_guards: self.guards.clone(),
            behavior: field::FieldBehavior {
                group: self.group.clone(),
                ..Default::default()
            },
            ..FieldDefinition::new(self.id(id), label.into(), self.offset(offset, 0), storage)
        }
    }
    // Bit fields MUST share the offset and bit initialization to bound WASM size.
    #[inline(never)]
    fn bit_field(&self, id: &str, label: &str, offset: usize, bit: u8) -> FieldDefinition {
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

pub(in crate::save) mod actraiser;
pub(in crate::save) mod advance_wars;
pub(in crate::save) mod banjo_kazooie;
pub(in crate::save) mod bomberman_64;
pub(in crate::save) mod builtin_pokemon_gen1;
pub(in crate::save) mod builtin_pokemon_gen2;
pub(in crate::save) mod builtin_pokemon_gen3;
pub(in crate::save) mod builtin_pokemon_gen4;
pub(in crate::save) mod builtin_pokemon_gen5;
pub(in crate::save) mod builtin_super_mario_world;
pub(in crate::save) mod builtin_zelda_alttp;
pub(in crate::save) mod capcom_gba_eeprom;
pub(in crate::save) mod castlevania_aria_of_sorrow;
pub(in crate::save) mod castlevania_circle_of_the_moon;
pub(in crate::save) mod castlevania_ds;
pub(in crate::save) mod castlevania_harmony_of_dissonance;
pub(in crate::save) mod chrono_trigger;
pub(in crate::save) mod diddy_kong_racing;
pub(in crate::save) mod donkey_kong_country;
pub(in crate::save) mod donkey_kong_country_2_diddy_s_kong_quest;
pub(in crate::save) mod donkey_kong_country_3_dixie_kong_s_double_trouble;
pub(in crate::save) mod donkey_kong_land;
pub(in crate::save) mod f_zero;
pub(in crate::save) mod f_zero_maximum_velocity;
pub(in crate::save) mod f_zero_x;
pub(in crate::save) mod final_fantasy_nes;
pub(in crate::save) mod final_fantasy_vi;
pub(in crate::save) mod game_and_watch_gallery_3;
pub(in crate::save) mod game_boy_camera;
pub(in crate::save) mod golden_sun;
pub(in crate::save) mod kingdom_hearts_chain_of_memories;
pub(in crate::save) mod kirbys_adventure;
pub(in crate::save) mod konami_krazy_racers;
pub(in crate::save) mod kurukuru_kururin;
pub(in crate::save) mod lylat_wars;
pub(in crate::save) mod mario_kart_64;
pub(in crate::save) mod mario_party;
pub(in crate::save) mod mario_party_2;
pub(in crate::save) mod mission_impossible;
pub(in crate::save) mod mystic_quest_legend;
pub(in crate::save) mod paper_mario;
pub(in crate::save) mod playstation_card;
pub(in crate::save) mod pokemon_generation_i;
pub(in crate::save) mod pokemon_generation_ii;
pub(in crate::save) mod pokemon_trading_card_game;
pub(in crate::save) mod ps1_final_fantasy;
pub(in crate::save) mod ps1_single_block;
pub(in crate::save) mod rondo_of_blood;
pub(in crate::save) mod secret_of_mana;
pub(in crate::save) mod shining_force;
pub(in crate::save) mod snowboarding_1080;
pub(in crate::save) mod solatorobo_red_the_hunter;
pub(in crate::save) mod soleil;
pub(in crate::save) mod sonic_3;
pub(in crate::save) mod sonic_advance_series;
pub(in crate::save) mod sonic_rush;
pub(in crate::save) mod super_mario_64;
pub(in crate::save) mod super_mario_kart;
pub(in crate::save) mod super_mario_rpg;
pub(in crate::save) mod super_mario_world;
pub(in crate::save) mod super_metroid;
pub(in crate::save) mod super_punch_out;
pub(in crate::save) mod super_smash_bros;
pub(in crate::save) mod wario_land_3;
pub(in crate::save) mod wario_land_4;
pub(in crate::save) mod wario_land_ii;
pub(in crate::save) mod wario_land_super_mario_land_3;
pub(in crate::save) mod warioware_inc;
pub(in crate::save) mod yoshis_story;
pub(in crate::save) mod zelda_a_link_to_the_past;
pub(in crate::save) mod zelda_links_awakening;
pub(in crate::save) mod zelda_minish_cap;
pub(in crate::save) mod zelda_ocarina_of_time;
pub(in crate::save) mod zelda_oracle_of_ages;
pub(in crate::save) mod zelda_oracle_of_seasons;
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
            games.extend(kirbys_adventure::schemas());
            games.extend(f_zero::schemas());
            games.extend(game_and_watch_gallery_3::schemas());
            games.extend(capcom_gba_eeprom::schemas());
            games.extend(f_zero_x::schemas());
            games.extend(diddy_kong_racing::schemas());
            games.extend(lylat_wars::schemas());
            games.extend(mission_impossible::schemas());
            games.extend(final_fantasy_vi::schemas());
            games.extend(mystic_quest_legend::schemas());
            games.extend(donkey_kong_land::schemas());
            games.extend(f_zero_maximum_velocity::schemas());
            games.extend(pokemon_trading_card_game::schemas());
            games.extend(wario_land_3::schemas());
            games.extend(zelda_oracle_of_ages::schemas());
            games.extend(zelda_oracle_of_seasons::schemas());
            games.extend(mario_kart_64::schemas());
            games.extend(actraiser::schemas());
            games.extend(chrono_trigger::schemas());
            games.extend(super_punch_out::schemas());
            games.extend(sonic_3::schemas());
            games.extend(shining_force::schemas());
            games.extend(soleil::schemas());
            games.extend(castlevania_aria_of_sorrow::schemas());
            games.extend(castlevania_circle_of_the_moon::schemas());
            games.extend(snowboarding_1080::schemas());
            games.extend(yoshis_story::schemas());
            games.extend(wario_land_ii::schemas());
            games.extend(zelda_links_awakening::schemas());
            games.extend(rondo_of_blood::schemas());
            games.extend(sonic_advance_series::schemas());
            games.extend(bomberman_64::schemas());
            games.extend(super_smash_bros::schemas());
            games.extend(ps1_single_block::schemas());
            games.extend(paper_mario::schemas());
            games.extend(zelda_ocarina_of_time::schemas());
            games.extend(wario_land_4::schemas());
            games.extend(konami_krazy_racers::schemas());
            games.extend(warioware_inc::schemas());
            games.extend(castlevania_harmony_of_dissonance::schemas());
            games.extend(advance_wars::schemas());
            games.extend(golden_sun::schemas());
            games.extend(kurukuru_kururin::schemas());
            games.extend(zelda_minish_cap::schemas());
            games.extend(sonic_rush::schemas());
            games.extend(castlevania_ds::schemas());
            games.extend(game_boy_camera::schemas());
            games.extend(kingdom_hearts_chain_of_memories::schemas());
            games.extend(banjo_kazooie::schemas());
            games.extend(ps1_final_fantasy::schemas());
            games
        })
        .clone()
}

// Catalog choices MUST share this allocation loop to bound WASM size.
#[inline(never)]
fn choices(entries: &[(&str, i64)]) -> Vec<FieldChoice> {
    entries
        .iter()
        .map(|(name, value)| FieldChoice {
            name: (*name).into(),
            value: *value,
        })
        .collect()
}
