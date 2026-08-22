//! Orchestration for baking cheat codes into ROMs. The pure decode/resolve logic lives in
//! `cheats`; this module detects the system (reusing the
//! `KnownRomHeader` detection), reads the ROM bytes, resolves the writes, and
//! produces either a synthetic IPS/IPS32 patch (for `patch apply`) or a patched ROM
//! file (for `patch create`).

use super::*;

use crate::cheats::{
    self, CheatKind, CheatRecord, CheatResolution, CheatSystem, CheatWrite, RomLayout,
};

/// Summary of a cheat-code resolution, used to enrich operation labels.
pub(super) struct CheatApplySummary {
    pub system: CheatSystem,
    pub code_count: usize,
    pub write_count: usize,
}

pub(super) struct CheatIpsRequest<'a> {
    pub source: &'a Path,
    pub codes: &'a [String],
    pub system_override: Option<&'a str>,
    pub kind_id: &'a str,
    pub context: &'a OperationContext,
    pub temp_paths: &'a mut Vec<PathBuf>,
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
        KnownRomHeader::Gba => Some(CheatSystem::GameBoyAdvance),
        KnownRomHeader::SnesCopier
        | KnownRomHeader::SmcZero
        | KnownRomHeader::SmcGameDoctor1
        | KnownRomHeader::SmcGameDoctor2 => Some(CheatSystem::Snes),
        _ => None,
    }
}

/// Serialize resolved writes as an IPS patch over `rom`'s bytes. A record may
/// not START on the reserved `EOF` offset (0x454F46); like canonical IPS
/// writers, a write landing there is emitted one byte earlier with the
/// unchanged preceding ROM byte re-included.
fn serialize_cheat_ips(writes: &[CheatWrite], rom: &[u8], system: CheatSystem) -> Result<Vec<u8>> {
    const IPS_EOF_OFFSET: usize = 0x45_4F46; // "EOF"
    let mut out = b"PATCH".to_vec();
    for write in writes {
        let mut data = cheat_write_data(write, system)?;
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

fn serialize_cheat_ips32(writes: &[CheatWrite], system: CheatSystem) -> Result<Vec<u8>> {
    const IPS32_RESERVED_EOF_OFFSET: u32 = 0x4545_4F46; // "EEOF"
    let mut out = b"IPS32".to_vec();
    for write in writes {
        let offset = u32::try_from(write.offset).map_err(|_| {
            RomWeaverError::Validation(format!(
                "cheat write offset {:#X} exceeds the IPS32 addressing limit",
                write.offset
            ))
        })?;
        if offset == IPS32_RESERVED_EOF_OFFSET {
            return Err(RomWeaverError::Validation(
                "cheat write lands on the IPS32 reserved `EEOF` offset".to_string(),
            ));
        }
        let data = cheat_write_data(write, system)?;
        let length = u16::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation("cheat write is too large for an IPS32 record".to_string())
        })?;
        out.extend_from_slice(&offset.to_be_bytes());
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(&data);
    }
    out.extend_from_slice(b"EEOF");
    Ok(out)
}

fn cheat_write_data(write: &CheatWrite, system: CheatSystem) -> Result<Vec<u8>> {
    let bytes = if matches!(system, CheatSystem::Genesis) {
        write.value.to_be_bytes()
    } else {
        write.value.to_le_bytes()
    };
    match write.width {
        1 => Ok(vec![write.value as u8]),
        2 => {
            let start = if matches!(system, CheatSystem::Genesis) {
                2
            } else {
                0
            };
            Ok(bytes[start..start + 2].to_vec())
        }
        4 => Ok(bytes.to_vec()),
        other => Err(RomWeaverError::Validation(format!(
            "unsupported cheat write width {other}"
        ))),
    }
}

fn serialize_cheat_patch(
    writes: &[CheatWrite],
    rom: &[u8],
    system: CheatSystem,
) -> Result<Vec<u8>> {
    if writes.iter().any(|write| write.offset > 0xFF_FFFF) {
        serialize_cheat_ips32(writes, system)
    } else {
        serialize_cheat_ips(writes, rom, system)
    }
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
                    "unknown --code-system `{id}`; expected nes, snes, genesis, gameboy, gba, or psx"
                ))
            });
        }
        if is_playstation_executable(source)? {
            return Ok(CheatSystem::PlayStation);
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
                "could not detect the ROM system for `{}`; pass --code-system nes|snes|genesis|gameboy|gba|psx",
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
        for code in codes_for_kind(codes, system, kind_id) {
            let decoded = if kind_id.eq_ignore_ascii_case("auto") {
                cheats::decode_auto(&code, system)?
            } else {
                let kind = CheatKind::parse(kind_id).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "unknown --code-kind `{kind_id}`; expected auto, game-genie, gameshark, or xploder"
                    ))
                })?;
                cheats::decode(&code, system, kind)?
            };
            all.extend(cheats::resolve_writes(rom, &layout, &decoded)?);
        }
        Ok(all)
    }

    /// Build a synthetic IPS or IPS32 patch file carrying the resolved cheat writes for
    /// `source`, written under a temp path (registered for cleanup). The patch
    /// applies cleanly to `source`'s bytes via the normal IPS handler.
    pub(super) fn synthesize_cheat_ips(
        &self,
        request: CheatIpsRequest<'_>,
    ) -> Result<(PathBuf, CheatApplySummary)> {
        let CheatIpsRequest {
            source,
            codes,
            system_override,
            kind_id,
            context,
            temp_paths,
        } = request;
        let system = self.cheat_system_for(source, system_override)?;
        // Read-on-main: a single full read of the source ROM (safe for wasm/OPFS;
        // no spawned threads open the file).
        let rom = fs::read(source)?;
        trace!(
            source = %source.display(),
            system = system.id(),
            rom_len = rom.len(),
            codes = codes.len(),
            "resolving cheat codes into patch"
        );
        let writes = Self::resolve_cheat_writes(&rom, system, codes, kind_id)?;
        let use_ips32 = writes.iter().any(|write| write.offset > 0xFF_FFFF);
        let ips = serialize_cheat_patch(&writes, &rom, system)?;
        let patch_path = context.temp_paths().next_path(
            "patch-apply-cheat",
            Some(if use_ips32 { "ips32" } else { "ips" }),
        );
        if let Some(parent) = patch_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&patch_path, ips)?;
        temp_paths.push(patch_path.clone());
        Ok((
            patch_path,
            CheatApplySummary {
                system,
                code_count: count_codes(codes, system, kind_id),
                write_count: writes.len(),
            },
        ))
    }

    pub(super) fn resolve_database_cheat_writes(
        rom: &[u8],
        records: &[CheatRecord],
    ) -> Result<(Vec<CheatWrite>, CheatApplySummary)> {
        let system = records.first().map(|record| record.system).ok_or_else(|| {
            RomWeaverError::Validation("no cheat records were selected".to_string())
        })?;
        if records.iter().any(|record| record.system != system) {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("cheat_system_mismatch")
                    .with_message("all selected cheat records must target the same system"),
            ));
        }
        let mut writes = Vec::new();
        let mut record_writes = Vec::new();
        for record in records {
            let classified = cheats::classify_record(rom, record);
            match classified.resolution {
                CheatResolution::RomBakeable { writes: resolved } => {
                    record_writes.push((record.id.clone(), resolved.clone()));
                    writes.extend(resolved);
                }
                CheatResolution::Runtime { .. } => {
                    return Err(RomWeaverError::ValidationCode(
                        ValidationCodeError::new("cheat_runtime_not_bakeable")
                            .with_message("a runtime cheat cannot be baked into the ROM")
                            .with_field("cheat_id", record.id.clone()),
                    ));
                }
                CheatResolution::Mixed { .. } => {
                    return Err(RomWeaverError::ValidationCode(
                        ValidationCodeError::new("cheat_mixed_not_bakeable")
                            .with_message(
                                "a mixed cheat must remain intact in a runtime cheat file",
                            )
                            .with_field("cheat_id", record.id.clone()),
                    ));
                }
                CheatResolution::RequiresParameter { .. } => {
                    return Err(RomWeaverError::ValidationCode(
                        ValidationCodeError::new("cheat_requires_parameter")
                            .with_message("the cheat needs a parameter value before use")
                            .with_field("cheat_id", record.id.clone()),
                    ));
                }
                CheatResolution::Unsupported { reason } => {
                    return Err(RomWeaverError::ValidationCode(
                        ValidationCodeError::new("cheat_unsupported")
                            .with_message("the selected cheat cannot be baked into the ROM")
                            .with_field("reason", reason)
                            .with_field("cheat_id", record.id.clone()),
                    ));
                }
            }
        }
        let conflicts = cheats::detect_write_conflicts(&record_writes);
        if let Some(conflict) = conflicts.first() {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("cheat_write_conflict")
                    .with_message("selected ROM cheats write different values at the same offset")
                    .with_field("first_cheat_id", conflict.first_id.clone())
                    .with_field("second_cheat_id", conflict.second_id.clone())
                    .with_field("offset", format!("{:#X}", conflict.offset))
                    .with_field("first_value", format!("{:02X}", conflict.first_value))
                    .with_field("second_value", format!("{:02X}", conflict.second_value)),
            ));
        }
        let write_count = writes.len();
        Ok((
            writes,
            CheatApplySummary {
                system,
                code_count: records.len(),
                write_count,
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
        cheats::apply_writes(&mut rom, system, &writes)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, rom)?;
        Ok(CheatApplySummary {
            system,
            code_count: count_codes(codes, system, kind_id),
            write_count: writes.len(),
        })
    }
}

/// Count individual codes after splitting `+`/comma/space-joined `--code` values.
fn codes_for_kind(codes: &[String], system: CheatSystem, kind_id: &str) -> Vec<String> {
    let use_xploder = CheatKind::parse(kind_id) == Some(CheatKind::Xploder)
        || (kind_id.eq_ignore_ascii_case("auto")
            && matches!(
                system,
                CheatSystem::GameBoyAdvance | CheatSystem::PlayStation
            ));
    if use_xploder {
        codes
            .iter()
            .flat_map(|code| cheats::split_xploder_codes(code))
            .collect()
    } else {
        codes
            .iter()
            .flat_map(|code| cheats::split_codes(code).into_iter().map(str::to_owned))
            .collect()
    }
}

fn count_codes(codes: &[String], system: CheatSystem, kind_id: &str) -> usize {
    codes_for_kind(codes, system, kind_id).len()
}

fn is_playstation_executable(path: &Path) -> Result<bool> {
    let mut file = File::open(path)?;
    let mut signature = [0_u8; 8];
    Ok(file.read_exact(&mut signature).is_ok() && signature == *b"PS-X EXE")
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
        let ips = serialize_cheat_ips(&writes, &[0u8; 0x40], CheatSystem::Genesis).unwrap();
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
        let ips = serialize_cheat_ips(&writes, &rom, CheatSystem::Genesis).unwrap();
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
        let err = serialize_cheat_ips(&writes, &[], CheatSystem::Genesis).unwrap_err();
        assert!(
            validation_message(&err).contains("16 MiB"),
            "unexpected message: {}",
            validation_message(&err)
        );
    }

    #[test]
    fn serialize_uses_little_endian_for_xploder_words() {
        let writes = vec![CheatWrite {
            offset: 0x10,
            value: 0xABCD,
            width: 2,
        }];
        let ips = serialize_cheat_ips(&writes, &[0u8; 0x20], CheatSystem::GameBoyAdvance).unwrap();
        assert_eq!(&ips[10..12], &[0xCD, 0xAB]);
    }

    #[test]
    fn serialize_uses_ips32_for_large_offsets() {
        let writes = vec![CheatWrite {
            offset: 0x100_0000,
            value: 0xABCD,
            width: 2,
        }];
        let ips = serialize_cheat_patch(&writes, &[], CheatSystem::GameBoyAdvance).unwrap();
        assert_eq!(&ips[..5], b"IPS32");
        assert_eq!(&ips[5..9], &0x100_0000u32.to_be_bytes());
        assert_eq!(&ips[9..11], &2u16.to_be_bytes());
        assert_eq!(&ips[11..13], &[0xCD, 0xAB]);
        assert_eq!(&ips[13..], b"EEOF");
    }

    #[test]
    fn split_codes_uses_xploder_aliases() {
        assert_eq!(
            codes_for_kind(
                &["30010000 00FF + 88010002 1234".to_owned()],
                CheatSystem::PlayStation,
                "xplorer"
            ),
            vec!["3001000000FF", "880100021234"]
        );
    }
}
