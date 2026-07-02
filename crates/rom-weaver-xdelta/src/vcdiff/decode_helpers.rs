use super::*;
pub(super) fn build_native_window_header(
    window: &WindowIndex,
    source_len: u64,
) -> OxideltaWindowHeader {
    let mut win_ind = 0u8;
    match window.source_kind {
        Some(WindowSourceKind::Source) => {
            win_ind |= VCD_SOURCE;
        }
        Some(WindowSourceKind::Target) => {
            win_ind |= VCD_TARGET;
        }
        None => {}
    }

    if window.checksum.is_some() {
        win_ind |= VCD_ADLER32;
    }

    let mut header = OxideltaWindowHeader {
        win_ind,
        copy_window_len: source_len,
        copy_window_offset: 0,
        enc_len: 0,
        target_window_len: window.target_window_size,
        del_ind: 0,
        data_len: window.data_len,
        inst_len: window.inst_len,
        addr_len: window.addr_len,
        adler32: window.checksum,
    };
    header.enc_len = header.compute_enc_len();
    header
}

pub(super) fn ensure_supported_secondary_compressor(secondary_id: Option<u8>) -> Result<()> {
    match secondary_id {
        Some(id)
            if id != XDELTA_LZMA_SECONDARY_ID
                && id != XDELTA_DJW_SECONDARY_ID
                && id != XDELTA_FGK_SECONDARY_ID =>
        {
            Err(RomWeaverError::Validation(format!(
                "native VCDIFF backend does not support secondary compressor ID {id}"
            )))
        }
        _ => Ok(()),
    }
}

pub(super) fn native_decode_error(
    error: OxideltaDecodeError,
    window: &WindowIndex,
) -> RomWeaverError {
    RomWeaverError::Validation(format!(
        "native VCDIFF decoder failed at output offset {}: {error}",
        window.output_offset
    ))
}
pub(super) fn read_section<R: Read + Seek>(
    reader: &mut R,
    start: u64,
    len: u64,
) -> Result<Vec<u8>> {
    let size = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation("section is too large to fit in memory on this platform".into())
    })?;
    // Validate the declared extent against the real patch length *before*
    // allocating: a malformed window can claim a multi-gigabyte section that
    // would otherwise abort the process on the `vec![0; size]` below.
    let patch_len = reader.seek(SeekFrom::End(0))?;
    let end = checked_add(start, len, "section end")?;
    if end > patch_len {
        return Err(RomWeaverError::Validation(format!(
            "section [{start}, {end}) extends past the {patch_len}-byte patch"
        )));
    }
    let mut buffer = vec![0; size];
    reader.seek(SeekFrom::Start(start))?;
    reader.read_exact(&mut buffer)?;
    Ok(buffer)
}

pub(super) fn skip_bytes<R: Read>(reader: &mut R, len: u64) -> Result<()> {
    // Discard `len` bytes by streaming them into a sink instead of allocating a
    // `len`-sized buffer, so an attacker-controlled section length cannot trigger
    // an out-of-memory abort. `io::copy` stops short at EOF, so verify the full
    // span was actually present (matching the old `read_exact` semantics).
    let copied = std::io::copy(&mut (&mut *reader).take(len), &mut std::io::sink())?;
    if copied != len {
        return Err(RomWeaverError::Validation(format!(
            "section declares {len} byte(s) but only {copied} are available"
        )));
    }
    Ok(())
}

pub(super) fn read_optional_u8<R: Read>(reader: &mut R) -> Result<Option<u8>> {
    let mut buffer = [0; 1];
    match reader.read_exact(&mut buffer) {
        Ok(()) => Ok(Some(buffer[0])),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn read_u8<R: Read>(reader: &mut R) -> Result<u8> {
    let mut buffer = [0; 1];
    reader.read_exact(&mut buffer)?;
    Ok(buffer[0])
}

pub(super) fn read_be_u32<R: Read>(reader: &mut R) -> Result<u32> {
    let mut buffer = [0; 4];
    reader.read_exact(&mut buffer)?;
    Ok(u32::from_be_bytes(buffer))
}

pub(super) fn read_varint<R: Read>(reader: &mut R) -> Result<(u64, usize)> {
    let mut count = 0usize;
    let mut read_error = None;
    let value = decode_base128(|| match read_u8(reader) {
        Ok(byte) => {
            count += 1;
            Some(byte)
        }
        Err(error) => {
            read_error = Some(error);
            None
        }
    });
    // Preserve the original I/O error (e.g. EOF) over the generic length error.
    if let Some(error) = read_error {
        return Err(error);
    }
    Ok((value?, count))
}

pub(super) fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed u64")))
}
