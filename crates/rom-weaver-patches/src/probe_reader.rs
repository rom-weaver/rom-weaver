//! Scattered small reads over a structural probe's input.
//!
//! The structural probes ([`crate::basis_probe`], [`crate::n64_order_probe`])
//! read a handful of bytes at unrelated offsets of a ROM that may be tens of
//! megabytes. Buffering would read far more than they ask for, so both seek to
//! each offset and read only what they need.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use rom_weaver_core::Result;

/// An open probe input plus its length.
pub(crate) struct ProbeReader {
    file: File,
    len: u64,
}

impl ProbeReader {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(Self { file, len })
    }

    pub(crate) const fn len(&self) -> u64 {
        self.len
    }

    /// Read `N` bytes at `offset`, or `None` when they do not all lie inside the
    /// file. A short read is never padded: a probe that cannot see a byte must
    /// draw no conclusion from it.
    pub(crate) fn read_at<const N: usize>(&mut self, offset: u64) -> Result<Option<[u8; N]>> {
        let width = N as u64;
        if width > self.len || offset > self.len - width {
            return Ok(None);
        }
        self.file.seek(SeekFrom::Start(offset))?;
        let mut bytes = [0_u8; N];
        self.file.read_exact(&mut bytes)?;
        Ok(Some(bytes))
    }

    pub(crate) fn byte_at(&mut self, offset: u64) -> Result<Option<u8>> {
        Ok(self.read_at::<1>(offset)?.map(|bytes| bytes[0]))
    }
}
