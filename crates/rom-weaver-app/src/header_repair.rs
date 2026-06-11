//! Header/checksum repair orchestration.
//!
//! [`CliApp::repair_checksum_file_in_place`] walks an open ROM file through
//! every supported platform's `repair_*`/`validate_*` routine (defined in
//! `header_repair_systems`) and records each outcome. The N64 byte-order
//! machinery lives in `header_repair_n64` and the generic byte/checksum helpers
//! in `header_repair_byte_io`.

use super::*;

impl CliApp {
    pub(super) fn repair_checksum_file_in_place(
        path: &Path,
        hint_path: Option<&Path>,
    ) -> Result<HeaderRepairOutcome> {
        let extension = hint_path
            .and_then(|path| path.extension())
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        let extension = extension.as_deref();

        let mut outcome = HeaderRepairOutcome {
            repaired_profiles: Vec::new(),
            matched_without_changes: Vec::new(),
        };

        let mut file = File::options().read(true).write(true).open(path)?;
        let mut repaired_len = usize::try_from(file.metadata()?.len()).map_err(|_| {
            RomWeaverError::Validation("header repair file length overflowed usize".into())
        })?;

        Self::record_header_repair_status(
            &mut outcome,
            "snes",
            Self::repair_snes_checksum_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "nes",
            Self::repair_nes_header_padding_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "fds",
            Self::validate_fds_header_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "game-boy",
            Self::repair_game_boy_checksum_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "gba",
            Self::repair_gba_header_checksum_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "sega-genesis",
            Self::repair_sega_genesis_checksum_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "sms-gg",
            Self::repair_sms_tmr_checksum_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "n64",
            Self::repair_n64_checksum_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-7800",
            Self::repair_atari_7800_header_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-lynx",
            Self::repair_atari_lynx_header_file(&mut file, repaired_len)?,
        );

        let pce_status = Self::repair_pce_copier_header(repaired_len, extension);
        if pce_status == HeaderRepairStatus::Repaired {
            repaired_len = remove_prefix_in_place(&mut file, ROM_HEADER_BYTES, repaired_len)?;
        }
        Self::record_header_repair_status(&mut outcome, "pce-tg16", pce_status);

        Self::record_header_repair_status(
            &mut outcome,
            "virtual-boy",
            Self::repair_virtual_boy_header_file(&mut file, repaired_len, extension)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "neo-geo-pocket",
            Self::repair_neo_geo_pocket_header_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "msx",
            Self::repair_msx_header_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "nds",
            Self::repair_nintendo_ds_header_crc_file(&mut file, repaired_len)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-jaguar",
            Self::validate_atari_jaguar_header_file(repaired_len, extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "colecovision",
            Self::validate_colecovision_header_file(&mut file, repaired_len, extension)?,
        );
        Self::record_header_repair_status(
            &mut outcome,
            "watara-supervision",
            Self::validate_watara_supervision_header_file(repaired_len, extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "intellivision",
            Self::validate_intellivision_header_file(repaired_len, extension),
        );

        file.flush()?;
        Ok(outcome)
    }
}
