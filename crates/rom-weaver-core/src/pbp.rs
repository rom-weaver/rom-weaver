//! Shared PBP layout recognition for container handling and ROM identity.

use std::io::{ErrorKind, Read, Seek, SeekFrom};

use tracing::debug;

use crate::{Result, RomWeaverError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PbpKind {
    Ps1,
    PspEmpty,
    PspNpUmd,
    PspExecutableAssets,
    Unsupported,
}

impl PbpKind {
    pub fn psp_layout(self) -> Option<&'static str> {
        match self {
            Self::PspEmpty => {
                Some("empty DATA.PSAR; self-contained PSP executable with no disc to extract")
            }
            Self::PspNpUmd => Some("PSP NPUMDIMG DATA.PSAR; PSP disc extraction is unsupported"),
            Self::PspExecutableAssets => {
                Some("PSP executable with asset DATA.PSAR; no disc to extract")
            }
            Self::Ps1 | Self::Unsupported => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PbpLayout {
    pub kind: PbpKind,
    pub psar_offset: u64,
}

/// Recognize supported layouts without decoding executable or encrypted disc data.
/// All section offsets are checked before any section is read.
pub fn classify_pbp(reader: &mut (impl Read + Seek), file_size: u64) -> Result<PbpLayout> {
    let result = read_pbp_layout(reader, file_size);
    match &result {
        Ok(layout) => debug!(
            kind = ?layout.kind,
            psar_offset = layout.psar_offset,
            file_size,
            "classified PBP"
        ),
        Err(error) => debug!(%error, file_size, "PBP classification failed"),
    }
    result
}

fn read_pbp_layout(reader: &mut (impl Read + Seek), file_size: u64) -> Result<PbpLayout> {
    let mut header = [0u8; 40];
    read_at(reader, 0, &mut header, "PBP header")?;
    if &header[..4] != b"\0PBP" {
        return Err(RomWeaverError::Validation(
            "not a pbp container (missing \\0PBP magic)".into(),
        ));
    }
    let mut offsets = [0u64; 8];
    let mut previous = 40;
    for (index, offset) in offsets.iter_mut().enumerate() {
        *offset = u64::from(u32::from_le_bytes(
            header[8 + index * 4..12 + index * 4]
                .try_into()
                .expect("section offset"),
        ));
        if index == 0 && *offset < 40 {
            return Err(RomWeaverError::Validation(format!(
                "invalid PBP section table (first section offset is {offset:#X})"
            )));
        }
        if *offset < previous {
            return Err(RomWeaverError::Validation(
                "non-monotonic PBP section offsets".into(),
            ));
        }
        if *offset > file_size {
            return Err(RomWeaverError::Validation(format!(
                "out-of-range PBP section offset ({offset:#X})"
            )));
        }
        previous = *offset;
    }
    let psar_offset = offsets[7];
    let psar_size = file_size - psar_offset;
    let layout = |kind| Ok(PbpLayout { kind, psar_offset });
    if psar_size == 0 {
        return layout(PbpKind::PspEmpty);
    }
    let mut signature = [0; 16];
    let length = usize::try_from(psar_size.min(16)).expect("bounded signature size");
    read_at(
        reader,
        psar_offset,
        &mut signature[..length],
        "DATA.PSAR signature",
    )?;
    // PS1 signatures MUST retain disc validation even when DATA.PSP contains a PSP launcher.
    if signature.starts_with(b"PSISOIMG") || signature.starts_with(b"PSTITLEIMG") {
        return layout(PbpKind::Ps1);
    }
    // PPSSPP reads 256 bytes before interpreting the encrypted NPUMDIMG fields:
    // https://github.com/hrydgard/ppsspp/blob/master/Core/FileSystems/BlockDevices.cpp
    if signature.starts_with(b"NPUMDIMG") {
        if psar_size < 256 {
            return Err(RomWeaverError::Validation(
                "truncated NPUMDIMG header (requires 256 bytes)".into(),
            ));
        }
        return layout(PbpKind::PspNpUmd);
    }
    let psp_size = psar_offset - offsets[6];
    if psp_size < 4 {
        return layout(PbpKind::Unsupported);
    }
    let mut executable = [0; 52];
    let length = usize::try_from(psp_size.min(52)).expect("bounded executable header size");
    read_at(
        reader,
        offsets[6],
        &mut executable[..length],
        "DATA.PSP header",
    )?;
    let is_elf = psp_size >= 52
        && executable.starts_with(b"\x7fELF\x01\x01\x01")
        && executable[18..20] == 8_u16.to_le_bytes()
        && executable[20..24] == 1_u32.to_le_bytes()
        && executable[40..42] == 52_u16.to_le_bytes();
    // The ~PSP header occupies 0x150 bytes; encrypted payloads stay opaque:
    // https://github.com/hrydgard/ppsspp/blob/master/Core/ELF/PrxDecrypter.h
    let is_prx = psp_size >= 0x150 && executable.starts_with(b"~PSP");
    layout(if is_elf || is_prx {
        PbpKind::PspExecutableAssets
    } else {
        PbpKind::Unsupported
    })
}

fn read_at(
    reader: &mut (impl Read + Seek),
    offset: u64,
    bytes: &mut [u8],
    label: &str,
) -> Result<()> {
    reader.seek(SeekFrom::Start(offset))?;
    reader.read_exact(bytes).map_err(|error| {
        if error.kind() == ErrorKind::UnexpectedEof {
            RomWeaverError::Validation(format!("source is truncated while reading {label}"))
        } else {
            error.into()
        }
    })
}
