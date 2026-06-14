//! Streaming, length-checked file parser shared by the simple record-based
//! patch formats (APS N64, APS GBA, PMSR/MOD).
//!
//! These formats each previously carried a byte-for-byte identical cursor that
//! tracked the consumed offset against the known file length and refused reads
//! that ran past the end. The only per-format differences were the format name
//! and the (cosmetic, unreachable on 64-bit targets) overflow wording in the
//! error strings, so both are passed in by the call site to keep every reported
//! message identical per format.

use std::io::Read;

use rom_weaver_core::{Result, RomWeaverError};

pub(crate) struct LabeledFileParser<R> {
    reader: R,
    file_len: u64,
    offset: u64,
    format_name: &'static str,
    overflow_label: &'static str,
}

impl<R: Read> LabeledFileParser<R> {
    /// `format_name` prefixes the "ended unexpectedly" message (e.g. `APS`,
    /// `APSGBA`, `MOD`); `overflow_label` is the trailing wording of the
    /// length-overflow message (e.g. `u64`, `addressable range`).
    pub(crate) fn new(
        reader: R,
        file_len: u64,
        format_name: &'static str,
        overflow_label: &'static str,
    ) -> Self {
        Self {
            reader,
            file_len,
            offset: 0,
            format_name,
            overflow_label,
        }
    }

    pub(crate) fn remaining(&self) -> u64 {
        self.file_len.saturating_sub(self.offset)
    }

    pub(crate) fn read_exact(&mut self, len: usize, label: &str) -> Result<Vec<u8>> {
        let len_u64 = u64::try_from(len).map_err(|_| {
            RomWeaverError::Validation(format!("{label} length overflowed {}", self.overflow_label))
        })?;
        if len_u64 > self.remaining() {
            return Err(RomWeaverError::Validation(format!(
                "{} patch ended unexpectedly while reading {label}",
                self.format_name
            )));
        }

        let mut bytes = vec![0u8; len];
        self.reader.read_exact(&mut bytes)?;
        self.offset = self
            .offset
            .checked_add(len_u64)
            .ok_or_else(|| RomWeaverError::Validation(format!("{label} offset overflowed")))?;
        Ok(bytes)
    }

    pub(crate) fn read_u8(&mut self, label: &str) -> Result<u8> {
        Ok(self.read_exact(1, label)?[0])
    }

    pub(crate) fn read_u16_le(&mut self, label: &str) -> Result<u16> {
        let bytes = self.read_exact(2, label)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub(crate) fn read_u32_le(&mut self, label: &str) -> Result<u32> {
        let bytes = self.read_exact(4, label)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(crate) fn read_u32_be(&mut self, label: &str) -> Result<u32> {
        let bytes = self.read_exact(4, label)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}
