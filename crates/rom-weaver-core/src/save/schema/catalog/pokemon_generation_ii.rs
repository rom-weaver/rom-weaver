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
                &format!("pokedex_{kind}_{index}", index = scope.index),
                &format!("Pokédex {kind} #{index}", index = scope.index),
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
            catalog_field("trainer.id", "Trainer ID", 8201, Storage::U16Be)
                .description("Public trainer identifier".into())
                .copies(vec![5575]),
            catalog_field("trainer.money", "Money", 9179, Storage::U24Be)
                .description("Money carried by the player".into())
                .copies(vec![3181]),
            catalog_field("trainer.stored_money", "Stored money", 9182, Storage::U24Be)
                .description("Money stored with the player's mother".into())
                .copies(vec![3184]),
            catalog_field("trainer.coins", "Coins", 9186, Storage::U16Be)
                .description("Coins carried by the player".into())
                .copies(vec![3188]),
            catalog_field(
                "trainer.play_time.hours",
                "Play time hours",
                8275,
                Storage::U16Be,
            )
            .copies(vec![5649]),
            catalog_field(
                "trainer.play_time.minutes",
                "Play time minutes",
                8277,
                Storage::U8,
            )
            .copies(vec![5651]),
            catalog_field(
                "trainer.play_time.seconds",
                "Play time seconds",
                8278,
                Storage::U8,
            )
            .copies(vec![5652]),
            catalog_field(
                "trainer.play_time.frames",
                "Play time frames",
                8279,
                Storage::U8,
            )
            .copies(vec![5653]),
            catalog_field("options.text_speed", "Text speed", 8192, Storage::U8)
                .description("Text delay; changing it preserves the other option bits".into())
                .copies(vec![4608])
                .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
                .mask(7),
            catalog_field("options.battle_scene", "Battle scene", 8192, Storage::Bit)
                .bit(7)
                .description("Show battle animations".into())
                .inverted(true)
                .copies(vec![4608]),
            catalog_field("options.battle_style", "Battle style", 8192, Storage::Bit)
                .bit(6)
                .description("Prompt before switching Pokémon".into())
                .inverted(true)
                .copies(vec![4608]),
            catalog_field("options.sound_stereo", "Stereo sound", 8192, Storage::Bit)
                .bit(5)
                .description("Raw mono or stereo sound flag".into())
                .copies(vec![4608]),
            catalog_field(
                "options.text_box_frame_raw",
                "Text box frame byte",
                8194,
                Storage::U8,
            )
            .copies(vec![4610]),
            catalog_field(
                "options.text_box_flags",
                "Text box flags",
                8195,
                Storage::U8,
            )
            .copies(vec![4611]),
            catalog_field(
                "options.printer_brightness",
                "Printer brightness",
                8196,
                Storage::U8,
            )
            .copies(vec![4612]),
            catalog_field(
                "options.menu_account_raw",
                "Menu account byte",
                8197,
                Storage::U8,
            )
            .copies(vec![4613]),
            catalog_field(
                "trainer.name_glyph_01",
                "Trainer name glyph 1",
                8203,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5577]),
            catalog_field(
                "trainer.name_glyph_02",
                "Trainer name glyph 2",
                8204,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5578]),
            catalog_field(
                "trainer.name_glyph_03",
                "Trainer name glyph 3",
                8205,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5579]),
            catalog_field(
                "trainer.name_glyph_04",
                "Trainer name glyph 4",
                8206,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5580]),
            catalog_field(
                "trainer.name_glyph_05",
                "Trainer name glyph 5",
                8207,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5581]),
            catalog_field(
                "trainer.name_glyph_06",
                "Trainer name glyph 6",
                8208,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5582]),
            catalog_field(
                "trainer.name_glyph_07",
                "Trainer name glyph 7",
                8209,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5583]),
            catalog_field(
                "trainer.name_glyph_08",
                "Trainer name glyph 8",
                8210,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5584]),
            catalog_field(
                "trainer.name_glyph_09",
                "Trainer name glyph 9",
                8211,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5585]),
            catalog_field(
                "trainer.name_glyph_10",
                "Trainer name glyph 10",
                8212,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5586]),
            catalog_field(
                "trainer.name_glyph_11",
                "Trainer name glyph 11",
                8213,
                Storage::U8,
            )
            .description(
                "Raw English Generation II character code; 0x50 terminates the name".into(),
            )
            .copies(vec![5587]),
            catalog_field("progress.badge_1", "Gym badge 1", 9188, Storage::Bit)
                .bit(0)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_2", "Gym badge 2", 9188, Storage::Bit)
                .bit(1)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_3", "Gym badge 3", 9188, Storage::Bit)
                .bit(2)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_4", "Gym badge 4", 9188, Storage::Bit)
                .bit(3)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_5", "Gym badge 5", 9188, Storage::Bit)
                .bit(4)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_6", "Gym badge 6", 9188, Storage::Bit)
                .bit(5)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_7", "Gym badge 7", 9188, Storage::Bit)
                .bit(6)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_8", "Gym badge 8", 9188, Storage::Bit)
                .bit(7)
                .description("Johto Gym Badge flag".into())
                .copies(vec![3190]),
            catalog_field("progress.badge_9", "Gym badge 9", 9189, Storage::Bit)
                .bit(0)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field("progress.badge_10", "Gym badge 10", 9189, Storage::Bit)
                .bit(1)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field("progress.badge_11", "Gym badge 11", 9189, Storage::Bit)
                .bit(2)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field("progress.badge_12", "Gym badge 12", 9189, Storage::Bit)
                .bit(3)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field("progress.badge_13", "Gym badge 13", 9189, Storage::Bit)
                .bit(4)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field("progress.badge_14", "Gym badge 14", 9189, Storage::Bit)
                .bit(5)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field("progress.badge_15", "Gym badge 15", 9189, Storage::Bit)
                .bit(6)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field("progress.badge_16", "Gym badge 16", 9189, Storage::Bit)
                .bit(7)
                .description("Kanto Gym Badge flag".into())
                .copies(vec![3191]),
            catalog_field(
                "inventory.tm_hm.1.quantity",
                "TM01 quantity",
                9190,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3192]),
            catalog_field(
                "inventory.tm_hm.2.quantity",
                "TM02 quantity",
                9191,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3193]),
            catalog_field(
                "inventory.tm_hm.3.quantity",
                "TM03 quantity",
                9192,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3194]),
            catalog_field(
                "inventory.tm_hm.4.quantity",
                "TM04 quantity",
                9193,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3195]),
            catalog_field(
                "inventory.tm_hm.5.quantity",
                "TM05 quantity",
                9194,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3196]),
            catalog_field(
                "inventory.tm_hm.6.quantity",
                "TM06 quantity",
                9195,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3197]),
            catalog_field(
                "inventory.tm_hm.7.quantity",
                "TM07 quantity",
                9196,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3198]),
            catalog_field(
                "inventory.tm_hm.8.quantity",
                "TM08 quantity",
                9197,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3199]),
            catalog_field(
                "inventory.tm_hm.9.quantity",
                "TM09 quantity",
                9198,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3200]),
            catalog_field(
                "inventory.tm_hm.10.quantity",
                "TM10 quantity",
                9199,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3201]),
            catalog_field(
                "inventory.tm_hm.11.quantity",
                "TM11 quantity",
                9200,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3202]),
            catalog_field(
                "inventory.tm_hm.12.quantity",
                "TM12 quantity",
                9201,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3203]),
            catalog_field(
                "inventory.tm_hm.13.quantity",
                "TM13 quantity",
                9202,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3204]),
            catalog_field(
                "inventory.tm_hm.14.quantity",
                "TM14 quantity",
                9203,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3205]),
            catalog_field(
                "inventory.tm_hm.15.quantity",
                "TM15 quantity",
                9204,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3206]),
            catalog_field(
                "inventory.tm_hm.16.quantity",
                "TM16 quantity",
                9205,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3207]),
            catalog_field(
                "inventory.tm_hm.17.quantity",
                "TM17 quantity",
                9206,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3208]),
            catalog_field(
                "inventory.tm_hm.18.quantity",
                "TM18 quantity",
                9207,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3209]),
            catalog_field(
                "inventory.tm_hm.19.quantity",
                "TM19 quantity",
                9208,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3210]),
            catalog_field(
                "inventory.tm_hm.20.quantity",
                "TM20 quantity",
                9209,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3211]),
            catalog_field(
                "inventory.tm_hm.21.quantity",
                "TM21 quantity",
                9210,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3212]),
            catalog_field(
                "inventory.tm_hm.22.quantity",
                "TM22 quantity",
                9211,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3213]),
            catalog_field(
                "inventory.tm_hm.23.quantity",
                "TM23 quantity",
                9212,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3214]),
            catalog_field(
                "inventory.tm_hm.24.quantity",
                "TM24 quantity",
                9213,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3215]),
            catalog_field(
                "inventory.tm_hm.25.quantity",
                "TM25 quantity",
                9214,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3216]),
            catalog_field(
                "inventory.tm_hm.26.quantity",
                "TM26 quantity",
                9215,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3217]),
            catalog_field(
                "inventory.tm_hm.27.quantity",
                "TM27 quantity",
                9216,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3218]),
            catalog_field(
                "inventory.tm_hm.28.quantity",
                "TM28 quantity",
                9217,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3219]),
            catalog_field(
                "inventory.tm_hm.29.quantity",
                "TM29 quantity",
                9218,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3220]),
            catalog_field(
                "inventory.tm_hm.30.quantity",
                "TM30 quantity",
                9219,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3221]),
            catalog_field(
                "inventory.tm_hm.31.quantity",
                "TM31 quantity",
                9220,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3222]),
            catalog_field(
                "inventory.tm_hm.32.quantity",
                "TM32 quantity",
                9221,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3223]),
            catalog_field(
                "inventory.tm_hm.33.quantity",
                "TM33 quantity",
                9222,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3224]),
            catalog_field(
                "inventory.tm_hm.34.quantity",
                "TM34 quantity",
                9223,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3225]),
            catalog_field(
                "inventory.tm_hm.35.quantity",
                "TM35 quantity",
                9224,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3226]),
            catalog_field(
                "inventory.tm_hm.36.quantity",
                "TM36 quantity",
                9225,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3227]),
            catalog_field(
                "inventory.tm_hm.37.quantity",
                "TM37 quantity",
                9226,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3228]),
            catalog_field(
                "inventory.tm_hm.38.quantity",
                "TM38 quantity",
                9227,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3229]),
            catalog_field(
                "inventory.tm_hm.39.quantity",
                "TM39 quantity",
                9228,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3230]),
            catalog_field(
                "inventory.tm_hm.40.quantity",
                "TM40 quantity",
                9229,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3231]),
            catalog_field(
                "inventory.tm_hm.41.quantity",
                "TM41 quantity",
                9230,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3232]),
            catalog_field(
                "inventory.tm_hm.42.quantity",
                "TM42 quantity",
                9231,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3233]),
            catalog_field(
                "inventory.tm_hm.43.quantity",
                "TM43 quantity",
                9232,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3234]),
            catalog_field(
                "inventory.tm_hm.44.quantity",
                "TM44 quantity",
                9233,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3235]),
            catalog_field(
                "inventory.tm_hm.45.quantity",
                "TM45 quantity",
                9234,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3236]),
            catalog_field(
                "inventory.tm_hm.46.quantity",
                "TM46 quantity",
                9235,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3237]),
            catalog_field(
                "inventory.tm_hm.47.quantity",
                "TM47 quantity",
                9236,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3238]),
            catalog_field(
                "inventory.tm_hm.48.quantity",
                "TM48 quantity",
                9237,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3239]),
            catalog_field(
                "inventory.tm_hm.49.quantity",
                "TM49 quantity",
                9238,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3240]),
            catalog_field(
                "inventory.tm_hm.50.quantity",
                "TM50 quantity",
                9239,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3241]),
            catalog_field(
                "inventory.tm_hm.51.quantity",
                "HM01 quantity",
                9240,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3242]),
            catalog_field(
                "inventory.tm_hm.52.quantity",
                "HM02 quantity",
                9241,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3243]),
            catalog_field(
                "inventory.tm_hm.53.quantity",
                "HM03 quantity",
                9242,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3244]),
            catalog_field(
                "inventory.tm_hm.54.quantity",
                "HM04 quantity",
                9243,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3245]),
            catalog_field(
                "inventory.tm_hm.55.quantity",
                "HM05 quantity",
                9244,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3246]),
            catalog_field(
                "inventory.tm_hm.56.quantity",
                "HM06 quantity",
                9245,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .copies(vec![3247]),
            catalog_field(
                "inventory.tm_hm.57.quantity",
                "HM07 quantity",
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
                "English 32 KiB SRAM layout. This profile edits fixed fields in both ",
                "save copies and repairs checksums. Use the full game profile ",
                "for variable inventory."
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
        catalog_field("trainer.id", "Trainer ID", 8201, Storage::U16Be)
            .description("Public trainer identifier".into())
            .copies(vec![4617]),
        catalog_field("trainer.money", "Money", 9180, Storage::U24Be)
            .description("Money carried by the player".into())
            .copies(vec![5596]),
        catalog_field("trainer.stored_money", "Stored money", 9183, Storage::U24Be)
            .description("Money stored with the player's mother".into())
            .copies(vec![5599]),
        catalog_field("trainer.coins", "Coins", 9187, Storage::U16Be)
            .description("Coins carried by the player".into())
            .copies(vec![5603]),
        catalog_field(
            "trainer.play_time.hours",
            "Play time hours",
            8274,
            Storage::U16Be,
        )
        .copies(vec![4690]),
        catalog_field(
            "trainer.play_time.minutes",
            "Play time minutes",
            8276,
            Storage::U8,
        )
        .copies(vec![4692]),
        catalog_field(
            "trainer.play_time.seconds",
            "Play time seconds",
            8277,
            Storage::U8,
        )
        .copies(vec![4693]),
        catalog_field(
            "trainer.play_time.frames",
            "Play time frames",
            8278,
            Storage::U8,
        )
        .copies(vec![4694]),
        catalog_field("options.text_speed", "Text speed", 8192, Storage::U8)
            .description("Text delay; changing it preserves the other option bits".into())
            .copies(vec![4608])
            .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
            .mask(7),
        catalog_field("options.battle_scene", "Battle scene", 8192, Storage::Bit)
            .bit(7)
            .description("Show battle animations".into())
            .inverted(true)
            .copies(vec![4608]),
        catalog_field("options.battle_style", "Battle style", 8192, Storage::Bit)
            .bit(6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true)
            .copies(vec![4608]),
        catalog_field("options.sound_stereo", "Stereo sound", 8192, Storage::Bit)
            .bit(5)
            .description("Raw mono or stereo sound flag".into())
            .copies(vec![4608]),
        catalog_field(
            "options.text_box_frame_raw",
            "Text box frame byte",
            8194,
            Storage::U8,
        )
        .copies(vec![4610]),
        catalog_field(
            "options.text_box_flags",
            "Text box flags",
            8195,
            Storage::U8,
        )
        .copies(vec![4611]),
        catalog_field(
            "options.printer_brightness",
            "Printer brightness",
            8196,
            Storage::U8,
        )
        .copies(vec![4612]),
        catalog_field(
            "options.menu_account_raw",
            "Menu account byte",
            8197,
            Storage::U8,
        )
        .copies(vec![4613]),
        catalog_field(
            "trainer.name_glyph_01",
            "Trainer name glyph 1",
            8203,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4619]),
        catalog_field(
            "trainer.name_glyph_02",
            "Trainer name glyph 2",
            8204,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4620]),
        catalog_field(
            "trainer.name_glyph_03",
            "Trainer name glyph 3",
            8205,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4621]),
        catalog_field(
            "trainer.name_glyph_04",
            "Trainer name glyph 4",
            8206,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4622]),
        catalog_field(
            "trainer.name_glyph_05",
            "Trainer name glyph 5",
            8207,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4623]),
        catalog_field(
            "trainer.name_glyph_06",
            "Trainer name glyph 6",
            8208,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4624]),
        catalog_field(
            "trainer.name_glyph_07",
            "Trainer name glyph 7",
            8209,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4625]),
        catalog_field(
            "trainer.name_glyph_08",
            "Trainer name glyph 8",
            8210,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4626]),
        catalog_field(
            "trainer.name_glyph_09",
            "Trainer name glyph 9",
            8211,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4627]),
        catalog_field(
            "trainer.name_glyph_10",
            "Trainer name glyph 10",
            8212,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4628]),
        catalog_field(
            "trainer.name_glyph_11",
            "Trainer name glyph 11",
            8213,
            Storage::U8,
        )
        .description("Raw English Generation II character code; 0x50 terminates the name".into())
        .copies(vec![4629]),
        catalog_field("progress.badge_1", "Gym badge 1", 9189, Storage::Bit)
            .bit(0)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_2", "Gym badge 2", 9189, Storage::Bit)
            .bit(1)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_3", "Gym badge 3", 9189, Storage::Bit)
            .bit(2)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_4", "Gym badge 4", 9189, Storage::Bit)
            .bit(3)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_5", "Gym badge 5", 9189, Storage::Bit)
            .bit(4)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_6", "Gym badge 6", 9189, Storage::Bit)
            .bit(5)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_7", "Gym badge 7", 9189, Storage::Bit)
            .bit(6)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_8", "Gym badge 8", 9189, Storage::Bit)
            .bit(7)
            .description("Johto Gym Badge flag".into())
            .copies(vec![5605]),
        catalog_field("progress.badge_9", "Gym badge 9", 9190, Storage::Bit)
            .bit(0)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field("progress.badge_10", "Gym badge 10", 9190, Storage::Bit)
            .bit(1)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field("progress.badge_11", "Gym badge 11", 9190, Storage::Bit)
            .bit(2)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field("progress.badge_12", "Gym badge 12", 9190, Storage::Bit)
            .bit(3)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field("progress.badge_13", "Gym badge 13", 9190, Storage::Bit)
            .bit(4)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field("progress.badge_14", "Gym badge 14", 9190, Storage::Bit)
            .bit(5)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field("progress.badge_15", "Gym badge 15", 9190, Storage::Bit)
            .bit(6)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field("progress.badge_16", "Gym badge 16", 9190, Storage::Bit)
            .bit(7)
            .description("Kanto Gym Badge flag".into())
            .copies(vec![5606]),
        catalog_field(
            "inventory.tm_hm.1.quantity",
            "TM01 quantity",
            9191,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5607]),
        catalog_field(
            "inventory.tm_hm.2.quantity",
            "TM02 quantity",
            9192,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5608]),
        catalog_field(
            "inventory.tm_hm.3.quantity",
            "TM03 quantity",
            9193,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5609]),
        catalog_field(
            "inventory.tm_hm.4.quantity",
            "TM04 quantity",
            9194,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5610]),
        catalog_field(
            "inventory.tm_hm.5.quantity",
            "TM05 quantity",
            9195,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5611]),
        catalog_field(
            "inventory.tm_hm.6.quantity",
            "TM06 quantity",
            9196,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5612]),
        catalog_field(
            "inventory.tm_hm.7.quantity",
            "TM07 quantity",
            9197,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5613]),
        catalog_field(
            "inventory.tm_hm.8.quantity",
            "TM08 quantity",
            9198,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5614]),
        catalog_field(
            "inventory.tm_hm.9.quantity",
            "TM09 quantity",
            9199,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5615]),
        catalog_field(
            "inventory.tm_hm.10.quantity",
            "TM10 quantity",
            9200,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5616]),
        catalog_field(
            "inventory.tm_hm.11.quantity",
            "TM11 quantity",
            9201,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5617]),
        catalog_field(
            "inventory.tm_hm.12.quantity",
            "TM12 quantity",
            9202,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5618]),
        catalog_field(
            "inventory.tm_hm.13.quantity",
            "TM13 quantity",
            9203,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5619]),
        catalog_field(
            "inventory.tm_hm.14.quantity",
            "TM14 quantity",
            9204,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5620]),
        catalog_field(
            "inventory.tm_hm.15.quantity",
            "TM15 quantity",
            9205,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5621]),
        catalog_field(
            "inventory.tm_hm.16.quantity",
            "TM16 quantity",
            9206,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5622]),
        catalog_field(
            "inventory.tm_hm.17.quantity",
            "TM17 quantity",
            9207,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5623]),
        catalog_field(
            "inventory.tm_hm.18.quantity",
            "TM18 quantity",
            9208,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5624]),
        catalog_field(
            "inventory.tm_hm.19.quantity",
            "TM19 quantity",
            9209,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5625]),
        catalog_field(
            "inventory.tm_hm.20.quantity",
            "TM20 quantity",
            9210,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5626]),
        catalog_field(
            "inventory.tm_hm.21.quantity",
            "TM21 quantity",
            9211,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5627]),
        catalog_field(
            "inventory.tm_hm.22.quantity",
            "TM22 quantity",
            9212,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5628]),
        catalog_field(
            "inventory.tm_hm.23.quantity",
            "TM23 quantity",
            9213,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5629]),
        catalog_field(
            "inventory.tm_hm.24.quantity",
            "TM24 quantity",
            9214,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5630]),
        catalog_field(
            "inventory.tm_hm.25.quantity",
            "TM25 quantity",
            9215,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5631]),
        catalog_field(
            "inventory.tm_hm.26.quantity",
            "TM26 quantity",
            9216,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5632]),
        catalog_field(
            "inventory.tm_hm.27.quantity",
            "TM27 quantity",
            9217,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5633]),
        catalog_field(
            "inventory.tm_hm.28.quantity",
            "TM28 quantity",
            9218,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5634]),
        catalog_field(
            "inventory.tm_hm.29.quantity",
            "TM29 quantity",
            9219,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5635]),
        catalog_field(
            "inventory.tm_hm.30.quantity",
            "TM30 quantity",
            9220,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5636]),
        catalog_field(
            "inventory.tm_hm.31.quantity",
            "TM31 quantity",
            9221,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5637]),
        catalog_field(
            "inventory.tm_hm.32.quantity",
            "TM32 quantity",
            9222,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5638]),
        catalog_field(
            "inventory.tm_hm.33.quantity",
            "TM33 quantity",
            9223,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5639]),
        catalog_field(
            "inventory.tm_hm.34.quantity",
            "TM34 quantity",
            9224,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5640]),
        catalog_field(
            "inventory.tm_hm.35.quantity",
            "TM35 quantity",
            9225,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5641]),
        catalog_field(
            "inventory.tm_hm.36.quantity",
            "TM36 quantity",
            9226,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5642]),
        catalog_field(
            "inventory.tm_hm.37.quantity",
            "TM37 quantity",
            9227,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5643]),
        catalog_field(
            "inventory.tm_hm.38.quantity",
            "TM38 quantity",
            9228,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5644]),
        catalog_field(
            "inventory.tm_hm.39.quantity",
            "TM39 quantity",
            9229,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5645]),
        catalog_field(
            "inventory.tm_hm.40.quantity",
            "TM40 quantity",
            9230,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5646]),
        catalog_field(
            "inventory.tm_hm.41.quantity",
            "TM41 quantity",
            9231,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5647]),
        catalog_field(
            "inventory.tm_hm.42.quantity",
            "TM42 quantity",
            9232,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5648]),
        catalog_field(
            "inventory.tm_hm.43.quantity",
            "TM43 quantity",
            9233,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5649]),
        catalog_field(
            "inventory.tm_hm.44.quantity",
            "TM44 quantity",
            9234,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5650]),
        catalog_field(
            "inventory.tm_hm.45.quantity",
            "TM45 quantity",
            9235,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5651]),
        catalog_field(
            "inventory.tm_hm.46.quantity",
            "TM46 quantity",
            9236,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5652]),
        catalog_field(
            "inventory.tm_hm.47.quantity",
            "TM47 quantity",
            9237,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5653]),
        catalog_field(
            "inventory.tm_hm.48.quantity",
            "TM48 quantity",
            9238,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5654]),
        catalog_field(
            "inventory.tm_hm.49.quantity",
            "TM49 quantity",
            9239,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5655]),
        catalog_field(
            "inventory.tm_hm.50.quantity",
            "TM50 quantity",
            9240,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5656]),
        catalog_field(
            "inventory.tm_hm.51.quantity",
            "HM01 quantity",
            9241,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5657]),
        catalog_field(
            "inventory.tm_hm.52.quantity",
            "HM02 quantity",
            9242,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5658]),
        catalog_field(
            "inventory.tm_hm.53.quantity",
            "HM03 quantity",
            9243,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5659]),
        catalog_field(
            "inventory.tm_hm.54.quantity",
            "HM04 quantity",
            9244,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5660]),
        catalog_field(
            "inventory.tm_hm.55.quantity",
            "HM05 quantity",
            9245,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5661]),
        catalog_field(
            "inventory.tm_hm.56.quantity",
            "HM06 quantity",
            9246,
            Storage::U8,
        )
        .description("Stored TM or HM quantity".into())
        .copies(vec![5662]),
        catalog_field(
            "inventory.tm_hm.57.quantity",
            "HM07 quantity",
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
