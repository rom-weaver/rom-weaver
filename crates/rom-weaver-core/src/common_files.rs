const COMMON_CONTAINER_FILE_EXTENSIONS: &[&str] = &[
    ".txt", ".nfo", ".diz", ".rtf", ".doc", ".docx", ".xls", ".xlsx", ".htm", ".html", ".pdf",
    ".jpg", ".jpeg", ".gif", ".png", ".bmp", ".webp", ".sfv", ".md5", ".sha1", ".sha256",
    ".sha512", ".crc", ".log", ".json",
];

const PATCH_FILTER_FILE_EXTENSIONS: &[&str] = &[
    ".ips",
    ".ips32",
    ".solid",
    ".bps",
    ".ups",
    ".vcdiff",
    ".xdelta",
    ".gdiff",
    ".gdf",
    ".hdiff",
    ".hpatchz",
    ".aps",
    ".apsgba",
    ".rup",
    ".ppf",
    ".pat",
    ".ffp",
    ".ebp",
    ".bdf",
    ".bsdiff",
    ".bsdiff40",
    ".bsp",
    ".mod",
    ".pmsr",
    ".dldi",
    ".dps",
    ".pds",
];

const ROM_FILTER_FILE_EXTENSIONS: &[&str] = &[
    ".cue",
    ".iso",
    ".img",
    ".bin",
    ".gdi",
    ".wav",
    ".nds",
    ".dsi",
    ".srl",
    ".gba",
    ".3ds",
    ".n64",
    ".z64",
    ".v64",
    ".nes",
    ".fds",
    ".sfc",
    ".smc",
    ".gen",
    ".md",
    ".gb",
    ".gbc",
    ".pce",
    ".a78",
    ".lnx",
    ".msx",
    ".sms",
    ".gg",
    ".tg16",
    ".vb",
    ".vboy",
    ".ngp",
    ".ngc",
    ".mx1",
    ".mx2",
    ".j64",
    ".jag",
    ".col",
    ".cv",
    ".sv",
    ".int",
    ".rom",
    ".chd",
    ".cso",
    ".ciso",
    ".pbp",
    ".gcz",
    ".wbfs",
    ".wia",
    ".tgc",
    ".nfs",
    ".rvz",
    ".z3ds",
    ".zcci",
    ".zcxi",
    ".zcia",
    ".z3dsx",
    ".xiso",
    ".xiso.iso",
];

const CONTAINER_FILTER_FILE_EXTENSIONS: &[&str] = &[
    ".zip",
    ".zipx",
    ".7z",
    ".rar",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".tar.bz2",
    ".tbz2",
    ".tar.xz",
    ".txz",
    ".gz",
    ".bz2",
    ".xz",
    ".zst",
    ".cso",
    ".ciso",
    ".pbp",
    ".gcz",
    ".wbfs",
    ".wia",
    ".tgc",
    ".nfs",
    ".rvz",
    ".z3ds",
    ".zcci",
    ".zcxi",
    ".zcia",
    ".z3dsx",
    ".xiso",
    ".xiso.iso",
    ".chd",
];

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ArchiveEntryKindFilter {
    pub rom: bool,
    pub patch: bool,
}

impl ArchiveEntryKindFilter {
    pub const fn new(rom: bool, patch: bool) -> Self {
        Self { rom, patch }
    }

    pub const fn disabled(self) -> bool {
        !self.rom && !self.patch
    }

    pub const fn enabled(self) -> bool {
        !self.disabled()
    }

    pub fn matches_payload_name(self, candidate_name: &str) -> bool {
        if self.disabled() {
            return true;
        }
        (self.rom && is_rom_filter_candidate_name(candidate_name))
            || (self.patch && is_patch_filter_candidate_name(candidate_name))
    }

    pub fn matches_payload_or_container_name(self, candidate_name: &str) -> bool {
        self.matches_payload_name(candidate_name)
            || (self.enabled() && is_container_filter_passthrough_candidate_name(candidate_name))
    }

    pub fn matches_container_fallback_name(self, candidate_name: &str) -> bool {
        self.enabled()
            && !self.matches_payload_name(candidate_name)
            && is_container_filter_passthrough_candidate_name(candidate_name)
    }

    pub fn flag_names(self) -> Vec<&'static str> {
        let mut flags = Vec::new();
        if self.rom {
            flags.push("--rom-filter");
        }
        if self.patch {
            flags.push("--patch-filter");
        }
        flags
    }

    pub fn flag_label(self) -> String {
        self.flag_names().join("/")
    }
}

pub fn should_ignore_common_container_file(candidate_name: &str) -> bool {
    let normalized = candidate_name.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if lower.contains("maxcso") {
        return true;
    }
    if lower.split('/').any(|component| component == "__macosx") {
        return true;
    }
    if let Some(file_name) = lower.rsplit('/').next() {
        if file_name.starts_with("._") {
            return true;
        }
        if matches!(file_name, ".ds_store" | "thumbs.db" | "desktop.ini") {
            return true;
        }
    }
    COMMON_CONTAINER_FILE_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}

pub fn is_patch_filter_candidate_name(candidate_name: &str) -> bool {
    has_extension(candidate_name, PATCH_FILTER_FILE_EXTENSIONS)
}

pub fn is_rom_filter_candidate_name(candidate_name: &str) -> bool {
    has_extension(candidate_name, ROM_FILTER_FILE_EXTENSIONS)
}

pub fn is_container_filter_passthrough_candidate_name(candidate_name: &str) -> bool {
    has_extension(candidate_name, CONTAINER_FILTER_FILE_EXTENSIONS)
}

fn has_extension(candidate_name: &str, extensions: &[&str]) -> bool {
    let lower = candidate_name.replace('\\', "/").to_ascii_lowercase();
    extensions
        .iter()
        .any(|extension| lower.ends_with(extension))
}

#[cfg(test)]
mod tests {
    use super::{
        ArchiveEntryKindFilter, is_container_filter_passthrough_candidate_name,
        is_patch_filter_candidate_name, is_rom_filter_candidate_name,
    };

    #[test]
    fn patch_filter_matches_supported_patch_extensions_and_pds() {
        for name in [
            "update.ips",
            "update.ips32",
            "update.bps",
            "update.xdelta",
            "update.hpatchz",
            "update.bsp",
            "update.pds",
            "nested/UPDATE.BPS",
        ] {
            assert!(is_patch_filter_candidate_name(name), "{name}");
        }
        assert!(!is_patch_filter_candidate_name("update.bspatch"));
        assert!(!is_patch_filter_candidate_name("game.nes"));
    }

    #[test]
    fn rom_filter_matches_rom_and_cue_extensions() {
        for name in [
            "game.nes",
            "disc.cue",
            "disc.iso",
            "disc.wav",
            "game.sfc",
            "game.sms",
            "game.tg16",
            "game.rom",
            "disc.chd",
            "disc.cso",
            "disc.pbp",
            "disc.rvz",
            "cart.z3ds",
            "nested/GAME.GBA",
        ] {
            assert!(is_rom_filter_candidate_name(name), "{name}");
        }
        assert!(!is_rom_filter_candidate_name("notes.txt"));
        assert!(!is_rom_filter_candidate_name("update.bps"));
        assert!(!is_rom_filter_candidate_name("inner.zip"));
    }

    #[test]
    fn kind_filter_keeps_nested_containers_as_pass_through() {
        let rom_filter = ArchiveEntryKindFilter::new(true, false);
        assert!(rom_filter.matches_payload_name("game.nes"));
        assert!(rom_filter.matches_payload_name("disc.chd"));
        assert!(rom_filter.matches_payload_name("disc.cso"));
        assert!(!rom_filter.matches_payload_name("inner.zip"));
        assert!(rom_filter.matches_payload_or_container_name("inner.zip"));
        assert!(rom_filter.matches_container_fallback_name("inner.zip"));
        assert!(!rom_filter.matches_container_fallback_name("disc.cso"));
        assert!(is_container_filter_passthrough_candidate_name(
            "nested/archive.tar.gz"
        ));
    }

    #[test]
    fn disabled_kind_filter_matches_everything() {
        let filter = ArchiveEntryKindFilter::default();
        assert!(filter.matches_payload_name("notes.txt"));
        assert!(filter.matches_payload_or_container_name("notes.txt"));
    }
}
