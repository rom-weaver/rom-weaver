//! Orchestration for baking cheat codes (Game Genie, Pro Action Replay /
//! GameShark) into ROMs. The pure decode/resolve logic lives in
//! `cheats`; this module detects the system (reusing the
//! `KnownRomHeader` detection), reads the ROM bytes, resolves the writes, and
//! produces either a synthetic IPS patch (for `patch apply`) or a patched ROM
//! file (for `patch create`).

use super::*;

use crate::cheats::{self, CheatKind, CheatSystem, CheatWrite, RomLayout};

/// Summary of a cheat-code resolution, used to enrich operation labels.
pub(super) struct CheatApplySummary {
    pub system: CheatSystem,
    pub code_count: usize,
    pub write_count: usize,
}

impl CheatApplySummary {
    pub(super) fn label(&self) -> String {
        format!(
            "baked {} cheat code(s) into {} ROM ({} byte write(s))",
            self.code_count,
            self.system.id(),
            self.write_count
        )
    }
}

fn cheat_system_from_header(header: KnownRomHeader) -> Option<CheatSystem> {
    match header {
        KnownRomHeader::Nes => Some(CheatSystem::Nes),
        KnownRomHeader::MegaDrive => Some(CheatSystem::Genesis),
        KnownRomHeader::GameBoy => Some(CheatSystem::GameBoy),
        KnownRomHeader::SnesCopier
        | KnownRomHeader::SmcZero
        | KnownRomHeader::SmcGameDoctor1
        | KnownRomHeader::SmcGameDoctor2 => Some(CheatSystem::Snes),
        _ => None,
    }
}

/// Serialize resolved writes as an IPS patch over `rom`'s bytes. IPS offsets are
/// 3 bytes, so the ROM must be under 16 MiB (true for every cheat-supported
/// system). A record may not START on the reserved `EOF` offset (0x454F46); like
/// canonical IPS writers, a write landing there is emitted one byte earlier with
/// the unchanged preceding ROM byte re-included.
fn serialize_cheat_ips(writes: &[CheatWrite], rom: &[u8]) -> Result<Vec<u8>> {
    const IPS_EOF_OFFSET: usize = 0x45_4F46; // "EOF"
    let mut out = b"PATCH".to_vec();
    for write in writes {
        let mut data = match write.width {
            1 => vec![write.value as u8],
            2 => vec![(write.value >> 8) as u8, write.value as u8],
            other => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported cheat write width {other}"
                )));
            }
        };
        let mut offset = write.offset;
        if offset == IPS_EOF_OFFSET {
            // Shift the record one byte earlier and re-include the original byte
            // so the (unrepresentable) reserved offset is never a record start.
            let preceding = offset
                .checked_sub(1)
                .and_then(|i| rom.get(i))
                .ok_or_else(|| {
                    RomWeaverError::Validation(
                        "cheat write lands on the IPS reserved `EOF` offset with no preceding byte"
                            .to_string(),
                    )
                })?;
            offset -= 1;
            data.insert(0, *preceding);
        }
        if offset >= 0x100_0000 {
            return Err(RomWeaverError::Validation(format!(
                "cheat write offset {offset:#X} exceeds the 16 MiB IPS addressing limit"
            )));
        }
        out.push((offset >> 16) as u8);
        out.push((offset >> 8) as u8);
        out.push(offset as u8);
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
        out.extend_from_slice(&data);
    }
    out.extend_from_slice(b"EOF");
    Ok(out)
}

impl CliApp {
    /// Resolve the cheat system from an explicit override or by detecting the
    /// ROM header.
    pub(super) fn cheat_system_for(
        &self,
        source: &Path,
        override_id: Option<&str>,
    ) -> Result<CheatSystem> {
        if let Some(id) = override_id.map(str::trim).filter(|id| !id.is_empty()) {
            return CheatSystem::parse(id).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "unknown --code-system `{id}`; expected nes, snes, genesis, or gameboy"
                ))
            });
        }
        match Self::detect_known_rom_header(source)? {
            Some(matched) => cheat_system_from_header(matched.header).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "could not map detected ROM header ({}) for `{}` to a cheat system; pass --code-system",
                    matched.profile_name(),
                    source.display()
                ))
            }),
            None => Err(RomWeaverError::Validation(format!(
                "could not detect the ROM system for `{}`; pass --code-system nes|snes|genesis|gameboy",
                source.display()
            ))),
        }
    }

    /// Decode + resolve every code against the ROM bytes into concrete writes.
    fn resolve_cheat_writes(
        rom: &[u8],
        system: CheatSystem,
        codes: &[String],
        kind_id: &str,
    ) -> Result<Vec<CheatWrite>> {
        let layout = RomLayout::detect(rom, system);
        let mut all = Vec::new();
        // A single `--code` value may carry several `+`/comma/space-joined codes.
        for code in codes.iter().flat_map(|code| cheats::split_codes(code)) {
            let decoded = if kind_id.eq_ignore_ascii_case("auto") {
                cheats::decode_auto(code, system)?
            } else {
                let kind = CheatKind::parse(kind_id).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "unknown --code-kind `{kind_id}`; expected auto, game-genie, or gameshark"
                    ))
                })?;
                cheats::decode(code, system, kind)?
            };
            all.extend(cheats::resolve_writes(rom, &layout, &decoded)?);
        }
        Ok(all)
    }

    /// Build a synthetic IPS patch file carrying the resolved cheat writes for
    /// `source`, written under a temp path (registered for cleanup). The patch
    /// applies cleanly to `source`'s bytes via the normal IPS handler.
    pub(super) fn synthesize_cheat_ips(
        &self,
        source: &Path,
        codes: &[String],
        system_override: Option<&str>,
        kind_id: &str,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<(PathBuf, CheatApplySummary)> {
        let system = self.cheat_system_for(source, system_override)?;
        // Read-on-main: a single full read of the source ROM (safe for wasm/OPFS;
        // no spawned threads open the file).
        let rom = fs::read(source)?;
        trace!(
            source = %source.display(),
            system = system.id(),
            rom_len = rom.len(),
            codes = codes.len(),
            "resolving cheat codes into IPS patch"
        );
        let writes = Self::resolve_cheat_writes(&rom, system, codes, kind_id)?;
        let ips = serialize_cheat_ips(&writes, &rom)?;
        let patch_path = context
            .temp_paths()
            .next_path("patch-apply-cheat", Some("ips"));
        if let Some(parent) = patch_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&patch_path, ips)?;
        temp_paths.push(patch_path.clone());
        Ok((
            patch_path,
            CheatApplySummary {
                system,
                code_count: count_codes(codes),
                write_count: writes.len(),
            },
        ))
    }

    /// Apply the resolved cheat writes to a copy of `source`, writing the patched
    /// ROM to `dest`.
    pub(super) fn write_cheat_patched_rom(
        &self,
        source: &Path,
        codes: &[String],
        system_override: Option<&str>,
        kind_id: &str,
        dest: &Path,
    ) -> Result<CheatApplySummary> {
        let system = self.cheat_system_for(source, system_override)?;
        let mut rom = fs::read(source)?;
        trace!(
            source = %source.display(),
            system = system.id(),
            rom_len = rom.len(),
            codes = codes.len(),
            "baking cheat codes into ROM"
        );
        let writes = Self::resolve_cheat_writes(&rom, system, codes, kind_id)?;
        cheats::apply_writes(&mut rom, &writes)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, rom)?;
        Ok(CheatApplySummary {
            system,
            code_count: count_codes(codes),
            write_count: writes.len(),
        })
    }
}

/// Count individual codes after splitting `+`/comma/space-joined `--code` values.
fn count_codes(codes: &[String]) -> usize {
    codes
        .iter()
        .flat_map(|code| cheats::split_codes(code))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validation_message(err: &RomWeaverError) -> String {
        match err {
            RomWeaverError::Validation(message) => message.clone(),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn serialize_basic_records() {
        let writes = vec![
            CheatWrite {
                offset: 0x10,
                value: 0xAB,
                width: 1,
            },
            CheatWrite {
                offset: 0x20,
                value: 0x1234,
                width: 2,
            },
        ];
        let ips = serialize_cheat_ips(&writes, &[0u8; 0x40]).unwrap();
        let expected = [
            b'P', b'A', b'T', b'C', b'H', 0x00, 0x00, 0x10, 0x00, 0x01,
            0xAB, // width-1 at 0x10
            0x00, 0x00, 0x20, 0x00, 0x02, 0x12, 0x34, // big-endian word at 0x20
            b'E', b'O', b'F',
        ];
        assert_eq!(ips, expected);
    }

    #[test]
    fn serialize_shifts_record_off_reserved_eof_offset() {
        // A record may not START on the reserved "EOF" offset (0x454F46); the
        // write must be emitted one byte earlier with the preceding ROM byte.
        let mut rom = vec![0u8; 0x45_4F46 + 1];
        rom[0x45_4F45] = 0x99;
        let writes = vec![CheatWrite {
            offset: 0x45_4F46,
            value: 0x42,
            width: 1,
        }];
        let ips = serialize_cheat_ips(&writes, &rom).unwrap();
        // Record: offset 0x454F45, len 2, data [0x99 (unchanged), 0x42].
        let expected = [
            b'P', b'A', b'T', b'C', b'H', 0x45, 0x4F, 0x45, 0x00, 0x02, 0x99, 0x42, b'E', b'O',
            b'F',
        ];
        assert_eq!(ips, expected);
    }

    #[test]
    fn serialize_rejects_offset_beyond_ips_limit() {
        let writes = vec![CheatWrite {
            offset: 0x100_0000,
            value: 0x01,
            width: 1,
        }];
        let err = serialize_cheat_ips(&writes, &[]).unwrap_err();
        assert!(
            validation_message(&err).contains("16 MiB"),
            "unexpected message: {}",
            validation_message(&err)
        );
    }
}
