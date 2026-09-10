mod game_boy;
mod gba;
mod nes;
mod nintendo_64;
mod nintendo_ds;
mod playstation;
mod saturn;
mod sega;
mod snes;

use serde::Serialize;
use tracing::trace;

pub use game_boy::GAME_BOY_SRAM_32K;
pub use gba::GBA_FLASH_128K;
pub use nintendo_ds::NINTENDO_DS_512K;
pub use snes::SNES_SRAM_8K;

/// One physical save layout an emulator or dumper writes to disk. `signature`
/// is a content check for formats that carry one; size-only formats leave it
/// `None`, so a size match alone MUST NOT be read as game recognition.
#[derive(Clone, Copy, Debug)]
pub struct SaveFormatDefinition {
    pub id: &'static str,
    pub display_name: &'static str,
    pub platform: &'static str,
    pub platform_name: &'static str,
    pub supported_sizes: &'static [usize],
    pub signature: Option<fn(&[u8]) -> bool>,
}

impl SaveFormatDefinition {
    pub fn accepts(self, bytes: &[u8]) -> bool {
        self.supported_sizes.contains(&bytes.len())
    }

    /// Size match plus the format signature, when the format has one.
    pub fn matches(self, bytes: &[u8]) -> bool {
        self.accepts(bytes) && self.signature.is_none_or(|check| check(bytes))
    }

    pub fn candidate(self) -> SaveFormatCandidate {
        SaveFormatCandidate {
            id: self.id,
            display_name: self.display_name,
            platform: self.platform,
            platform_name: self.platform_name,
            signature_checked: self.signature.is_some(),
        }
    }
}

/// The report-facing view of a physical format match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SaveFormatCandidate {
    pub id: &'static str,
    pub display_name: &'static str,
    pub platform: &'static str,
    pub platform_name: &'static str,
    pub signature_checked: bool,
}

impl SaveFormatCandidate {
    pub fn label(&self) -> String {
        format!("{} ({})", self.display_name, self.platform_name)
    }
}

/// Every physical format the editor can name, grouped by platform. Order is
/// the display order in reports.
pub const ALL_SAVE_FORMATS: &[&[SaveFormatDefinition]] = &[
    game_boy::FORMATS,
    gba::FORMATS,
    nes::FORMATS,
    snes::FORMATS,
    nintendo_64::FORMATS,
    nintendo_ds::FORMATS,
    sega::FORMATS,
    playstation::FORMATS,
    saturn::FORMATS,
];

pub fn all_save_formats() -> impl Iterator<Item = SaveFormatDefinition> {
    ALL_SAVE_FORMATS
        .iter()
        .flat_map(|group| group.iter().copied())
}

/// Physical formats whose size and signature fit `bytes`. Formats with a
/// signature that passed sort first because a size-only match says less.
pub fn candidate_save_formats(bytes: &[u8]) -> Vec<SaveFormatCandidate> {
    let mut candidates: Vec<SaveFormatCandidate> = all_save_formats()
        .filter(|format| format.matches(bytes))
        .map(SaveFormatDefinition::candidate)
        .collect();
    candidates.sort_by_key(|candidate| !candidate.signature_checked);
    trace!(
        save_size = bytes.len(),
        candidates = candidates.len(),
        "matched physical save formats"
    );
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn format_ids_are_unique_and_sized() {
        let mut ids = HashSet::new();
        for format in all_save_formats() {
            assert!(
                ids.insert(format.id),
                "duplicate save format id {}",
                format.id
            );
            assert!(
                !format.supported_sizes.is_empty(),
                "{} has no sizes",
                format.id
            );
            assert!(!format.platform.is_empty() && !format.platform_name.is_empty());
        }
    }

    #[test]
    fn signature_formats_lead_and_size_only_formats_follow() {
        let mut card = vec![0u8; 128 * 1024];
        card[..2].copy_from_slice(b"MC");
        let candidates = candidate_save_formats(&card);
        assert_eq!(candidates[0].id, "psx_memory_card_128k");
        assert!(candidates[0].signature_checked);
        assert!(
            candidates[1..]
                .iter()
                .all(|candidate| !candidate.signature_checked)
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.id == "gba_flash_128k")
        );

        let plain = vec![0u8; 128 * 1024];
        assert!(
            candidate_save_formats(&plain)
                .iter()
                .all(|candidate| candidate.id != "psx_memory_card_128k")
        );
    }

    #[test]
    fn unknown_sizes_have_no_candidates() {
        assert!(candidate_save_formats(&[0u8; 1000]).is_empty());
        assert!(candidate_save_formats(&[]).is_empty());
    }
}
