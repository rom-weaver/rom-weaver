use super::*;

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

fn extend_fields(
    fields: &mut Vec<FieldDefinition>,
    scope: &FieldScope,
    repetition: Repetition,
    build: fn(&FieldScope) -> Vec<FieldDefinition>,
) {
    for item in 0..repetition.count {
        let number = item + repetition.start;
        let index = format!("{number:0width$}", width = repetition.width);
        let mut child = FieldScope {
            base: scope.base + scope.bits / 8 + repetition.base,
            bits: item * repetition.stride,
            bit_stride: repetition.bit_stride,
            index,
            ordinal: item + 1,
            prefix: String::new(),
            group: scope.group.clone(),
            guards: scope.guards.clone(),
        };
        child.prefix = scope.id(repetition.prefix);
        fields.extend(build(&child));
    }
}

fn dex_field(scope: &FieldScope, kind: &str, offset: usize) -> Vec<FieldDefinition> {
    vec![
        scope
            .bit_field(
                format!("pokedex_{kind}_{index}", index = scope.index),
                format!("Pokédex {kind} #{index}", index = scope.index),
                offset,
                0,
            )
            .copies(vec![scope.offset(0, 0)]),
    ]
}

fn gold_silver_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    dex_field(scope, "owned", 5998)
}

fn gold_silver_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    dex_field(scope, "seen", 5998)
}

fn crystal_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    dex_field(scope, "owned", 3584)
}

fn crystal_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    dex_field(scope, "seen", 3584)
}

fn default() -> GameDefinition {
    {
        let mut fields = vec![
            FieldDefinition::new(
                "trainer.id".into(),
                "Trainer ID".into(),
                8201,
                Storage::U16Be,
            )
            .description("Public trainer identifier".into())
            .copies(vec![5575]),
            FieldDefinition::new("trainer.money".into(), "Money".into(), 9179, Storage::U24Be)
                .description("Money carried by the player".into())
                .copies(vec![3181]),
            FieldDefinition::new(
                "trainer.stored_money".into(),
                "Stored money".into(),
                9182,
                Storage::U24Be,
            )
            .description("Money stored with the player's mother".into())
            .copies(vec![3184]),
            FieldDefinition::new("trainer.coins".into(), "Coins".into(), 9186, Storage::U16Be)
                .description("Coins carried by the player".into())
                .copies(vec![3188]),
            FieldDefinition::new(
                "trainer.play_time.hours".into(),
                "Play time hours".into(),
                8275,
                Storage::U16Be,
            )
            .copies(vec![5649]),
            FieldDefinition::new(
                "trainer.play_time.minutes".into(),
                "Play time minutes".into(),
                8277,
                Storage::U8,
            )
            .copies(vec![5651]),
            FieldDefinition::new(
                "trainer.play_time.seconds".into(),
                "Play time seconds".into(),
                8278,
                Storage::U8,
            )
            .copies(vec![5652]),
            FieldDefinition::new(
                "trainer.play_time.frames".into(),
                "Play time frames".into(),
                8279,
                Storage::U8,
            )
            .copies(vec![5653]),
            FieldDefinition::new(
                "options.text_speed".into(),
                "Text speed".into(),
                8192,
                Storage::U8,
            )
            .description("Text delay; changing it preserves the other option bits".into())
            .copies(vec![4608])
            .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
            .mask(7),
            FieldDefinition::new(
                "options.battle_scene".into(),
                "Battle scene".into(),
                8192,
                Storage::Bit,
            )
            .bit(7)
            .description("Show battle animations".into())
            .inverted(true)
            .copies(vec![4608]),
            FieldDefinition::new(
                "options.battle_style".into(),
                "Battle style".into(),
                8192,
                Storage::Bit,
            )
            .bit(6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true)
            .copies(vec![4608]),
            FieldDefinition::new(
                "options.sound_stereo".into(),
                "Stereo sound".into(),
                8192,
                Storage::Bit,
            )
            .bit(5)
            .description("Raw mono or stereo sound flag".into())
            .copies(vec![4608]),
            FieldDefinition::new(
                "options.text_box_frame_raw".into(),
                "Text box frame byte".into(),
                8194,
                Storage::U8,
            )
            .copies(vec![4610]),
            FieldDefinition::new(
                "options.text_box_flags".into(),
                "Text box flags".into(),
                8195,
                Storage::U8,
            )
            .copies(vec![4611]),
            FieldDefinition::new(
                "options.printer_brightness".into(),
                "Printer brightness".into(),
                8196,
                Storage::U8,
            )
            .copies(vec![4612]),
            FieldDefinition::new(
                "options.menu_account_raw".into(),
                "Menu account byte".into(),
                8197,
                Storage::U8,
            )
            .copies(vec![4613]),
            FieldDefinition::new(
                "trainer.name_glyph_01".into(),
                "Trainer name glyph 1".into(),
                8203,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5577]),
            FieldDefinition::new(
                "trainer.name_glyph_02".into(),
                "Trainer name glyph 2".into(),
                8204,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5578]),
            FieldDefinition::new(
                "trainer.name_glyph_03".into(),
                "Trainer name glyph 3".into(),
                8205,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5579]),
            FieldDefinition::new(
                "trainer.name_glyph_04".into(),
                "Trainer name glyph 4".into(),
                8206,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5580]),
            FieldDefinition::new(
                "trainer.name_glyph_05".into(),
                "Trainer name glyph 5".into(),
                8207,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5581]),
            FieldDefinition::new(
                "trainer.name_glyph_06".into(),
                "Trainer name glyph 6".into(),
                8208,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5582]),
            FieldDefinition::new(
                "trainer.name_glyph_07".into(),
                "Trainer name glyph 7".into(),
                8209,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5583]),
            FieldDefinition::new(
                "trainer.name_glyph_08".into(),
                "Trainer name glyph 8".into(),
                8210,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5584]),
            FieldDefinition::new(
                "trainer.name_glyph_09".into(),
                "Trainer name glyph 9".into(),
                8211,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5585]),
            FieldDefinition::new(
                "trainer.name_glyph_10".into(),
                "Trainer name glyph 10".into(),
                8212,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5586]),
            FieldDefinition::new(
                "trainer.name_glyph_11".into(),
                "Trainer name glyph 11".into(),
                8213,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5587]),
            FieldDefinition::new(
                "progress.badge_1".into(),
                "Gym badge 1".into(),
                9188,
                Storage::Bit,
            )
            .bit(0)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_2".into(),
                "Gym badge 2".into(),
                9188,
                Storage::Bit,
            )
            .bit(1)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_3".into(),
                "Gym badge 3".into(),
                9188,
                Storage::Bit,
            )
            .bit(2)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_4".into(),
                "Gym badge 4".into(),
                9188,
                Storage::Bit,
            )
            .bit(3)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_5".into(),
                "Gym badge 5".into(),
                9188,
                Storage::Bit,
            )
            .bit(4)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_6".into(),
                "Gym badge 6".into(),
                9188,
                Storage::Bit,
            )
            .bit(5)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_7".into(),
                "Gym badge 7".into(),
                9188,
                Storage::Bit,
            )
            .bit(6)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_8".into(),
                "Gym badge 8".into(),
                9188,
                Storage::Bit,
            )
            .bit(7)
            .description("Johto Gym Badge flag".into())
            .copies(vec![3190]),
            FieldDefinition::new(
                "progress.badge_9".into(),
                "Gym badge 9".into(),
                9189,
                Storage::Bit,
            )
            .bit(0)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "progress.badge_10".into(),
                "Gym badge 10".into(),
                9189,
                Storage::Bit,
            )
            .bit(1)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "progress.badge_11".into(),
                "Gym badge 11".into(),
                9189,
                Storage::Bit,
            )
            .bit(2)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "progress.badge_12".into(),
                "Gym badge 12".into(),
                9189,
                Storage::Bit,
            )
            .bit(3)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "progress.badge_13".into(),
                "Gym badge 13".into(),
                9189,
                Storage::Bit,
            )
            .bit(4)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "progress.badge_14".into(),
                "Gym badge 14".into(),
                9189,
                Storage::Bit,
            )
            .bit(5)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "progress.badge_15".into(),
                "Gym badge 15".into(),
                9189,
                Storage::Bit,
            )
            .bit(6)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "progress.badge_16".into(),
                "Gym badge 16".into(),
                9189,
                Storage::Bit,
            )
            .bit(7)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![3191]),
            FieldDefinition::new(
                "inventory.tm_hm.1.quantity".into(),
                "TM01 quantity".into(),
                9190,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3192]),
            FieldDefinition::new(
                "inventory.tm_hm.2.quantity".into(),
                "TM02 quantity".into(),
                9191,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3193]),
            FieldDefinition::new(
                "inventory.tm_hm.3.quantity".into(),
                "TM03 quantity".into(),
                9192,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3194]),
            FieldDefinition::new(
                "inventory.tm_hm.4.quantity".into(),
                "TM04 quantity".into(),
                9193,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3195]),
            FieldDefinition::new(
                "inventory.tm_hm.5.quantity".into(),
                "TM05 quantity".into(),
                9194,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3196]),
            FieldDefinition::new(
                "inventory.tm_hm.6.quantity".into(),
                "TM06 quantity".into(),
                9195,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3197]),
            FieldDefinition::new(
                "inventory.tm_hm.7.quantity".into(),
                "TM07 quantity".into(),
                9196,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3198]),
            FieldDefinition::new(
                "inventory.tm_hm.8.quantity".into(),
                "TM08 quantity".into(),
                9197,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3199]),
            FieldDefinition::new(
                "inventory.tm_hm.9.quantity".into(),
                "TM09 quantity".into(),
                9198,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3200]),
            FieldDefinition::new(
                "inventory.tm_hm.10.quantity".into(),
                "TM10 quantity".into(),
                9199,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3201]),
            FieldDefinition::new(
                "inventory.tm_hm.11.quantity".into(),
                "TM11 quantity".into(),
                9200,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3202]),
            FieldDefinition::new(
                "inventory.tm_hm.12.quantity".into(),
                "TM12 quantity".into(),
                9201,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3203]),
            FieldDefinition::new(
                "inventory.tm_hm.13.quantity".into(),
                "TM13 quantity".into(),
                9202,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3204]),
            FieldDefinition::new(
                "inventory.tm_hm.14.quantity".into(),
                "TM14 quantity".into(),
                9203,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3205]),
            FieldDefinition::new(
                "inventory.tm_hm.15.quantity".into(),
                "TM15 quantity".into(),
                9204,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3206]),
            FieldDefinition::new(
                "inventory.tm_hm.16.quantity".into(),
                "TM16 quantity".into(),
                9205,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3207]),
            FieldDefinition::new(
                "inventory.tm_hm.17.quantity".into(),
                "TM17 quantity".into(),
                9206,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3208]),
            FieldDefinition::new(
                "inventory.tm_hm.18.quantity".into(),
                "TM18 quantity".into(),
                9207,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3209]),
            FieldDefinition::new(
                "inventory.tm_hm.19.quantity".into(),
                "TM19 quantity".into(),
                9208,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3210]),
            FieldDefinition::new(
                "inventory.tm_hm.20.quantity".into(),
                "TM20 quantity".into(),
                9209,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3211]),
            FieldDefinition::new(
                "inventory.tm_hm.21.quantity".into(),
                "TM21 quantity".into(),
                9210,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3212]),
            FieldDefinition::new(
                "inventory.tm_hm.22.quantity".into(),
                "TM22 quantity".into(),
                9211,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3213]),
            FieldDefinition::new(
                "inventory.tm_hm.23.quantity".into(),
                "TM23 quantity".into(),
                9212,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3214]),
            FieldDefinition::new(
                "inventory.tm_hm.24.quantity".into(),
                "TM24 quantity".into(),
                9213,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3215]),
            FieldDefinition::new(
                "inventory.tm_hm.25.quantity".into(),
                "TM25 quantity".into(),
                9214,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3216]),
            FieldDefinition::new(
                "inventory.tm_hm.26.quantity".into(),
                "TM26 quantity".into(),
                9215,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3217]),
            FieldDefinition::new(
                "inventory.tm_hm.27.quantity".into(),
                "TM27 quantity".into(),
                9216,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3218]),
            FieldDefinition::new(
                "inventory.tm_hm.28.quantity".into(),
                "TM28 quantity".into(),
                9217,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3219]),
            FieldDefinition::new(
                "inventory.tm_hm.29.quantity".into(),
                "TM29 quantity".into(),
                9218,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3220]),
            FieldDefinition::new(
                "inventory.tm_hm.30.quantity".into(),
                "TM30 quantity".into(),
                9219,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3221]),
            FieldDefinition::new(
                "inventory.tm_hm.31.quantity".into(),
                "TM31 quantity".into(),
                9220,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3222]),
            FieldDefinition::new(
                "inventory.tm_hm.32.quantity".into(),
                "TM32 quantity".into(),
                9221,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3223]),
            FieldDefinition::new(
                "inventory.tm_hm.33.quantity".into(),
                "TM33 quantity".into(),
                9222,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3224]),
            FieldDefinition::new(
                "inventory.tm_hm.34.quantity".into(),
                "TM34 quantity".into(),
                9223,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3225]),
            FieldDefinition::new(
                "inventory.tm_hm.35.quantity".into(),
                "TM35 quantity".into(),
                9224,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3226]),
            FieldDefinition::new(
                "inventory.tm_hm.36.quantity".into(),
                "TM36 quantity".into(),
                9225,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3227]),
            FieldDefinition::new(
                "inventory.tm_hm.37.quantity".into(),
                "TM37 quantity".into(),
                9226,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3228]),
            FieldDefinition::new(
                "inventory.tm_hm.38.quantity".into(),
                "TM38 quantity".into(),
                9227,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3229]),
            FieldDefinition::new(
                "inventory.tm_hm.39.quantity".into(),
                "TM39 quantity".into(),
                9228,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3230]),
            FieldDefinition::new(
                "inventory.tm_hm.40.quantity".into(),
                "TM40 quantity".into(),
                9229,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3231]),
            FieldDefinition::new(
                "inventory.tm_hm.41.quantity".into(),
                "TM41 quantity".into(),
                9230,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3232]),
            FieldDefinition::new(
                "inventory.tm_hm.42.quantity".into(),
                "TM42 quantity".into(),
                9231,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3233]),
            FieldDefinition::new(
                "inventory.tm_hm.43.quantity".into(),
                "TM43 quantity".into(),
                9232,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3234]),
            FieldDefinition::new(
                "inventory.tm_hm.44.quantity".into(),
                "TM44 quantity".into(),
                9233,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3235]),
            FieldDefinition::new(
                "inventory.tm_hm.45.quantity".into(),
                "TM45 quantity".into(),
                9234,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3236]),
            FieldDefinition::new(
                "inventory.tm_hm.46.quantity".into(),
                "TM46 quantity".into(),
                9235,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3237]),
            FieldDefinition::new(
                "inventory.tm_hm.47.quantity".into(),
                "TM47 quantity".into(),
                9236,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3238]),
            FieldDefinition::new(
                "inventory.tm_hm.48.quantity".into(),
                "TM48 quantity".into(),
                9237,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3239]),
            FieldDefinition::new(
                "inventory.tm_hm.49.quantity".into(),
                "TM49 quantity".into(),
                9238,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3240]),
            FieldDefinition::new(
                "inventory.tm_hm.50.quantity".into(),
                "TM50 quantity".into(),
                9239,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3241]),
            FieldDefinition::new(
                "inventory.tm_hm.51.quantity".into(),
                "HM01 quantity".into(),
                9240,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3242]),
            FieldDefinition::new(
                "inventory.tm_hm.52.quantity".into(),
                "HM02 quantity".into(),
                9241,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3243]),
            FieldDefinition::new(
                "inventory.tm_hm.53.quantity".into(),
                "HM03 quantity".into(),
                9242,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3244]),
            FieldDefinition::new(
                "inventory.tm_hm.54.quantity".into(),
                "HM04 quantity".into(),
                9243,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3245]),
            FieldDefinition::new(
                "inventory.tm_hm.55.quantity".into(),
                "HM05 quantity".into(),
                9244,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3246]),
            FieldDefinition::new(
                "inventory.tm_hm.56.quantity".into(),
                "HM06 quantity".into(),
                9245,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3247]),
            FieldDefinition::new(
                "inventory.tm_hm.57.quantity".into(),
                "HM07 quantity".into(),
                9246,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3248]),
        ];
        let scope = FieldScope::default();
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(251, 1, 3, 4830, 1, true, "progress"),
            gold_silver_owned,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(251, 1, 3, 4862, 1, true, "progress"),
            gold_silver_seen,
        );
        GameDefinition {
            fields,
            description: concat!(
                "English 32 KiB SRAM layout. Edits fixed fields in both primary ",
                "and backup copies and repairs both checksums. Variable-length ",
                "inventory remains with the native handler."
            )
            .into(),
            signatures: vec![
                SignatureDefinition {
                    offset: 8200,
                    bytes: vec![99],
                },
                SignatureDefinition {
                    offset: 11627,
                    bytes: vec![127],
                },
                SignatureDefinition {
                    offset: 32312,
                    bytes: vec![99],
                },
                SignatureDefinition {
                    offset: 32367,
                    bytes: vec![127],
                },
            ],
            checksums: vec![
                ChecksumDefinition {
                    start: Some(8201),
                    length: Some(3424),
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 11625)
                },
                ChecksumDefinition {
                    spans: vec![
                        ChecksumSpan {
                            start: 4328,
                            length: 1247,
                        },
                        ChecksumSpan {
                            start: 3179,
                            length: 1149,
                        },
                        ChecksumSpan {
                            start: 5575,
                            length: 550,
                        },
                        ChecksumSpan {
                            start: 15766,
                            length: 426,
                        },
                        ChecksumSpan {
                            start: 32313,
                            length: 52,
                        },
                    ],
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 32365)
                },
            ],
            ..GameDefinition::new("".into(), "".into(), "game-boy-color".into(), 32768)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_pokemon_gold_schema(),
        game_pokemon_silver_schema(),
        game_pokemon_crystal_schema(),
    ];

    build(games, codecs, true)
}

fn game_pokemon_gold_schema() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-gold-schema".into();
    game.name = "Pokémon Gold (English schema)".into();
    game
}

fn game_pokemon_silver_schema() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-silver-schema".into();
    game.name = "Pokémon Silver (English schema)".into();
    game
}

fn game_pokemon_crystal_schema() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-crystal-schema".into();
    game.name = "Pokémon Crystal (English schema)".into();
    game.signatures = vec![
        SignatureDefinition {
            offset: 8200,
            bytes: vec![99],
        },
        SignatureDefinition {
            offset: 11535,
            bytes: vec![127],
        },
        SignatureDefinition {
            offset: 4616,
            bytes: vec![99],
        },
        SignatureDefinition {
            offset: 7951,
            bytes: vec![127],
        },
    ];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(8201),
            length: Some(2938),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 11533)
        },
        ChecksumDefinition {
            start: Some(4617),
            length: Some(2938),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 7949)
        },
    ];
    let mut fields = vec![
        FieldDefinition::new(
            "trainer.id".into(),
            "Trainer ID".into(),
            8201,
            Storage::U16Be,
        )
        .description("Public trainer identifier".into())
        .copies(vec![4617]),
        FieldDefinition::new("trainer.money".into(), "Money".into(), 9180, Storage::U24Be)
            .description("Money carried by the player".into())
            .copies(vec![5596]),
        FieldDefinition::new(
            "trainer.stored_money".into(),
            "Stored money".into(),
            9183,
            Storage::U24Be,
        )
        .description("Money stored with the player's mother".into())
        .copies(vec![5599]),
        FieldDefinition::new("trainer.coins".into(), "Coins".into(), 9187, Storage::U16Be)
            .description("Coins carried by the player".into())
            .copies(vec![5603]),
        FieldDefinition::new(
            "trainer.play_time.hours".into(),
            "Play time hours".into(),
            8274,
            Storage::U16Be,
        )
        .copies(vec![4690]),
        FieldDefinition::new(
            "trainer.play_time.minutes".into(),
            "Play time minutes".into(),
            8276,
            Storage::U8,
        )
        .copies(vec![4692]),
        FieldDefinition::new(
            "trainer.play_time.seconds".into(),
            "Play time seconds".into(),
            8277,
            Storage::U8,
        )
        .copies(vec![4693]),
        FieldDefinition::new(
            "trainer.play_time.frames".into(),
            "Play time frames".into(),
            8278,
            Storage::U8,
        )
        .copies(vec![4694]),
        FieldDefinition::new(
            "options.text_speed".into(),
            "Text speed".into(),
            8192,
            Storage::U8,
        )
        .description("Text delay; changing it preserves the other option bits".into())
        .copies(vec![4608])
        .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
        .mask(7),
        FieldDefinition::new(
            "options.battle_scene".into(),
            "Battle scene".into(),
            8192,
            Storage::Bit,
        )
        .bit(7)
        .description("Show battle animations".into())
        .inverted(true)
        .copies(vec![4608]),
        FieldDefinition::new(
            "options.battle_style".into(),
            "Battle style".into(),
            8192,
            Storage::Bit,
        )
        .bit(6)
        .description("Prompt before switching Pokémon".into())
        .inverted(true)
        .copies(vec![4608]),
        FieldDefinition::new(
            "options.sound_stereo".into(),
            "Stereo sound".into(),
            8192,
            Storage::Bit,
        )
        .bit(5)
        .description("Raw mono or stereo sound flag".into())
        .copies(vec![4608]),
        FieldDefinition::new(
            "options.text_box_frame_raw".into(),
            "Text box frame byte".into(),
            8194,
            Storage::U8,
        )
        .copies(vec![4610]),
        FieldDefinition::new(
            "options.text_box_flags".into(),
            "Text box flags".into(),
            8195,
            Storage::U8,
        )
        .copies(vec![4611]),
        FieldDefinition::new(
            "options.printer_brightness".into(),
            "Printer brightness".into(),
            8196,
            Storage::U8,
        )
        .copies(vec![4612]),
        FieldDefinition::new(
            "options.menu_account_raw".into(),
            "Menu account byte".into(),
            8197,
            Storage::U8,
        )
        .copies(vec![4613]),
        FieldDefinition::new(
            "trainer.name_glyph_01".into(),
            "Trainer name glyph 1".into(),
            8203,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4619]),
        FieldDefinition::new(
            "trainer.name_glyph_02".into(),
            "Trainer name glyph 2".into(),
            8204,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4620]),
        FieldDefinition::new(
            "trainer.name_glyph_03".into(),
            "Trainer name glyph 3".into(),
            8205,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4621]),
        FieldDefinition::new(
            "trainer.name_glyph_04".into(),
            "Trainer name glyph 4".into(),
            8206,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4622]),
        FieldDefinition::new(
            "trainer.name_glyph_05".into(),
            "Trainer name glyph 5".into(),
            8207,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4623]),
        FieldDefinition::new(
            "trainer.name_glyph_06".into(),
            "Trainer name glyph 6".into(),
            8208,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4624]),
        FieldDefinition::new(
            "trainer.name_glyph_07".into(),
            "Trainer name glyph 7".into(),
            8209,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4625]),
        FieldDefinition::new(
            "trainer.name_glyph_08".into(),
            "Trainer name glyph 8".into(),
            8210,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4626]),
        FieldDefinition::new(
            "trainer.name_glyph_09".into(),
            "Trainer name glyph 9".into(),
            8211,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4627]),
        FieldDefinition::new(
            "trainer.name_glyph_10".into(),
            "Trainer name glyph 10".into(),
            8212,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4628]),
        FieldDefinition::new(
            "trainer.name_glyph_11".into(),
            "Trainer name glyph 11".into(),
            8213,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4629]),
        FieldDefinition::new(
            "progress.badge_1".into(),
            "Gym badge 1".into(),
            9189,
            Storage::Bit,
        )
        .bit(0)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_2".into(),
            "Gym badge 2".into(),
            9189,
            Storage::Bit,
        )
        .bit(1)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_3".into(),
            "Gym badge 3".into(),
            9189,
            Storage::Bit,
        )
        .bit(2)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_4".into(),
            "Gym badge 4".into(),
            9189,
            Storage::Bit,
        )
        .bit(3)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_5".into(),
            "Gym badge 5".into(),
            9189,
            Storage::Bit,
        )
        .bit(4)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_6".into(),
            "Gym badge 6".into(),
            9189,
            Storage::Bit,
        )
        .bit(5)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_7".into(),
            "Gym badge 7".into(),
            9189,
            Storage::Bit,
        )
        .bit(6)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_8".into(),
            "Gym badge 8".into(),
            9189,
            Storage::Bit,
        )
        .bit(7)
        .description("Johto Gym Badge flag".into())
        .copies(vec![5605]),
        FieldDefinition::new(
            "progress.badge_9".into(),
            "Gym badge 9".into(),
            9190,
            Storage::Bit,
        )
        .bit(0)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "progress.badge_10".into(),
            "Gym badge 10".into(),
            9190,
            Storage::Bit,
        )
        .bit(1)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "progress.badge_11".into(),
            "Gym badge 11".into(),
            9190,
            Storage::Bit,
        )
        .bit(2)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "progress.badge_12".into(),
            "Gym badge 12".into(),
            9190,
            Storage::Bit,
        )
        .bit(3)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "progress.badge_13".into(),
            "Gym badge 13".into(),
            9190,
            Storage::Bit,
        )
        .bit(4)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "progress.badge_14".into(),
            "Gym badge 14".into(),
            9190,
            Storage::Bit,
        )
        .bit(5)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "progress.badge_15".into(),
            "Gym badge 15".into(),
            9190,
            Storage::Bit,
        )
        .bit(6)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "progress.badge_16".into(),
            "Gym badge 16".into(),
            9190,
            Storage::Bit,
        )
        .bit(7)
        .description("Kanto Gym Badge flag".into())
        .copies(vec![5606]),
        FieldDefinition::new(
            "inventory.tm_hm.1.quantity".into(),
            "TM01 quantity".into(),
            9191,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5607]),
        FieldDefinition::new(
            "inventory.tm_hm.2.quantity".into(),
            "TM02 quantity".into(),
            9192,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5608]),
        FieldDefinition::new(
            "inventory.tm_hm.3.quantity".into(),
            "TM03 quantity".into(),
            9193,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5609]),
        FieldDefinition::new(
            "inventory.tm_hm.4.quantity".into(),
            "TM04 quantity".into(),
            9194,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5610]),
        FieldDefinition::new(
            "inventory.tm_hm.5.quantity".into(),
            "TM05 quantity".into(),
            9195,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5611]),
        FieldDefinition::new(
            "inventory.tm_hm.6.quantity".into(),
            "TM06 quantity".into(),
            9196,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5612]),
        FieldDefinition::new(
            "inventory.tm_hm.7.quantity".into(),
            "TM07 quantity".into(),
            9197,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5613]),
        FieldDefinition::new(
            "inventory.tm_hm.8.quantity".into(),
            "TM08 quantity".into(),
            9198,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5614]),
        FieldDefinition::new(
            "inventory.tm_hm.9.quantity".into(),
            "TM09 quantity".into(),
            9199,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5615]),
        FieldDefinition::new(
            "inventory.tm_hm.10.quantity".into(),
            "TM10 quantity".into(),
            9200,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5616]),
        FieldDefinition::new(
            "inventory.tm_hm.11.quantity".into(),
            "TM11 quantity".into(),
            9201,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5617]),
        FieldDefinition::new(
            "inventory.tm_hm.12.quantity".into(),
            "TM12 quantity".into(),
            9202,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5618]),
        FieldDefinition::new(
            "inventory.tm_hm.13.quantity".into(),
            "TM13 quantity".into(),
            9203,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5619]),
        FieldDefinition::new(
            "inventory.tm_hm.14.quantity".into(),
            "TM14 quantity".into(),
            9204,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5620]),
        FieldDefinition::new(
            "inventory.tm_hm.15.quantity".into(),
            "TM15 quantity".into(),
            9205,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5621]),
        FieldDefinition::new(
            "inventory.tm_hm.16.quantity".into(),
            "TM16 quantity".into(),
            9206,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5622]),
        FieldDefinition::new(
            "inventory.tm_hm.17.quantity".into(),
            "TM17 quantity".into(),
            9207,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5623]),
        FieldDefinition::new(
            "inventory.tm_hm.18.quantity".into(),
            "TM18 quantity".into(),
            9208,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5624]),
        FieldDefinition::new(
            "inventory.tm_hm.19.quantity".into(),
            "TM19 quantity".into(),
            9209,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5625]),
        FieldDefinition::new(
            "inventory.tm_hm.20.quantity".into(),
            "TM20 quantity".into(),
            9210,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5626]),
        FieldDefinition::new(
            "inventory.tm_hm.21.quantity".into(),
            "TM21 quantity".into(),
            9211,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5627]),
        FieldDefinition::new(
            "inventory.tm_hm.22.quantity".into(),
            "TM22 quantity".into(),
            9212,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5628]),
        FieldDefinition::new(
            "inventory.tm_hm.23.quantity".into(),
            "TM23 quantity".into(),
            9213,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5629]),
        FieldDefinition::new(
            "inventory.tm_hm.24.quantity".into(),
            "TM24 quantity".into(),
            9214,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5630]),
        FieldDefinition::new(
            "inventory.tm_hm.25.quantity".into(),
            "TM25 quantity".into(),
            9215,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5631]),
        FieldDefinition::new(
            "inventory.tm_hm.26.quantity".into(),
            "TM26 quantity".into(),
            9216,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5632]),
        FieldDefinition::new(
            "inventory.tm_hm.27.quantity".into(),
            "TM27 quantity".into(),
            9217,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5633]),
        FieldDefinition::new(
            "inventory.tm_hm.28.quantity".into(),
            "TM28 quantity".into(),
            9218,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5634]),
        FieldDefinition::new(
            "inventory.tm_hm.29.quantity".into(),
            "TM29 quantity".into(),
            9219,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5635]),
        FieldDefinition::new(
            "inventory.tm_hm.30.quantity".into(),
            "TM30 quantity".into(),
            9220,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5636]),
        FieldDefinition::new(
            "inventory.tm_hm.31.quantity".into(),
            "TM31 quantity".into(),
            9221,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5637]),
        FieldDefinition::new(
            "inventory.tm_hm.32.quantity".into(),
            "TM32 quantity".into(),
            9222,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5638]),
        FieldDefinition::new(
            "inventory.tm_hm.33.quantity".into(),
            "TM33 quantity".into(),
            9223,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5639]),
        FieldDefinition::new(
            "inventory.tm_hm.34.quantity".into(),
            "TM34 quantity".into(),
            9224,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5640]),
        FieldDefinition::new(
            "inventory.tm_hm.35.quantity".into(),
            "TM35 quantity".into(),
            9225,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5641]),
        FieldDefinition::new(
            "inventory.tm_hm.36.quantity".into(),
            "TM36 quantity".into(),
            9226,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5642]),
        FieldDefinition::new(
            "inventory.tm_hm.37.quantity".into(),
            "TM37 quantity".into(),
            9227,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5643]),
        FieldDefinition::new(
            "inventory.tm_hm.38.quantity".into(),
            "TM38 quantity".into(),
            9228,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5644]),
        FieldDefinition::new(
            "inventory.tm_hm.39.quantity".into(),
            "TM39 quantity".into(),
            9229,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5645]),
        FieldDefinition::new(
            "inventory.tm_hm.40.quantity".into(),
            "TM40 quantity".into(),
            9230,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5646]),
        FieldDefinition::new(
            "inventory.tm_hm.41.quantity".into(),
            "TM41 quantity".into(),
            9231,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5647]),
        FieldDefinition::new(
            "inventory.tm_hm.42.quantity".into(),
            "TM42 quantity".into(),
            9232,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5648]),
        FieldDefinition::new(
            "inventory.tm_hm.43.quantity".into(),
            "TM43 quantity".into(),
            9233,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5649]),
        FieldDefinition::new(
            "inventory.tm_hm.44.quantity".into(),
            "TM44 quantity".into(),
            9234,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5650]),
        FieldDefinition::new(
            "inventory.tm_hm.45.quantity".into(),
            "TM45 quantity".into(),
            9235,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5651]),
        FieldDefinition::new(
            "inventory.tm_hm.46.quantity".into(),
            "TM46 quantity".into(),
            9236,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5652]),
        FieldDefinition::new(
            "inventory.tm_hm.47.quantity".into(),
            "TM47 quantity".into(),
            9237,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5653]),
        FieldDefinition::new(
            "inventory.tm_hm.48.quantity".into(),
            "TM48 quantity".into(),
            9238,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5654]),
        FieldDefinition::new(
            "inventory.tm_hm.49.quantity".into(),
            "TM49 quantity".into(),
            9239,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5655]),
        FieldDefinition::new(
            "inventory.tm_hm.50.quantity".into(),
            "TM50 quantity".into(),
            9240,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5656]),
        FieldDefinition::new(
            "inventory.tm_hm.51.quantity".into(),
            "HM01 quantity".into(),
            9241,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5657]),
        FieldDefinition::new(
            "inventory.tm_hm.52.quantity".into(),
            "HM02 quantity".into(),
            9242,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5658]),
        FieldDefinition::new(
            "inventory.tm_hm.53.quantity".into(),
            "HM03 quantity".into(),
            9243,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5659]),
        FieldDefinition::new(
            "inventory.tm_hm.54.quantity".into(),
            "HM04 quantity".into(),
            9244,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5660]),
        FieldDefinition::new(
            "inventory.tm_hm.55.quantity".into(),
            "HM05 quantity".into(),
            9245,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5661]),
        FieldDefinition::new(
            "inventory.tm_hm.56.quantity".into(),
            "HM06 quantity".into(),
            9246,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5662]),
        FieldDefinition::new(
            "inventory.tm_hm.57.quantity".into(),
            "HM07 quantity".into(),
            9247,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5663]),
    ];
    let scope = FieldScope::default();
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(251, 1, 3, 7207, 1, true, "progress"),
        crystal_owned,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(251, 1, 3, 7239, 1, true, "progress"),
        crystal_seen,
    );
    game.fields = fields;
    game
}
