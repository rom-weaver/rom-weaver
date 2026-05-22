fn build_native_window_header(window: &WindowIndex, source_len: u64) -> OxideltaWindowHeader {
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

fn ensure_supported_secondary_compressor(secondary_id: Option<u8>) -> Result<()> {
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

fn native_decode_error(error: OxideltaDecodeError, window: &WindowIndex) -> RomWeaverError {
    RomWeaverError::Validation(format!(
        "native VCDIFF decoder failed at output offset {}: {error}",
        window.output_offset
    ))
}
fn read_section<R: Read + Seek>(reader: &mut R, start: u64, len: u64) -> Result<Vec<u8>> {
    let size = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation("section is too large to fit in memory on this platform".into())
    })?;
    let mut buffer = vec![0; size];
    reader.seek(SeekFrom::Start(start))?;
    reader.read_exact(&mut buffer)?;
    Ok(buffer)
}

fn skip_bytes<R: Read>(reader: &mut R, len: u64) -> Result<()> {
    let size = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation("section is too large to fit in memory on this platform".into())
    })?;
    let mut buffer = vec![0; size];
    reader.read_exact(&mut buffer)?;
    Ok(())
}

fn read_optional_u8<R: Read>(reader: &mut R) -> Result<Option<u8>> {
    let mut buffer = [0; 1];
    match reader.read_exact(&mut buffer) {
        Ok(()) => Ok(Some(buffer[0])),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_u8<R: Read>(reader: &mut R) -> Result<u8> {
    let mut buffer = [0; 1];
    reader.read_exact(&mut buffer)?;
    Ok(buffer[0])
}

fn read_be_u32<R: Read>(reader: &mut R) -> Result<u32> {
    let mut buffer = [0; 4];
    reader.read_exact(&mut buffer)?;
    Ok(u32::from_be_bytes(buffer))
}

fn read_varint<R: Read>(reader: &mut R) -> Result<(u64, usize)> {
    let mut value = 0u64;
    let mut count = 0usize;
    loop {
        let byte = read_u8(reader)?;
        count += 1;
        value = value
            .checked_mul(128)
            .and_then(|current| current.checked_add(u64::from(byte & 0x7F)))
            .ok_or_else(|| RomWeaverError::Validation("base-128 integer overflowed u64".into()))?;
        if byte & 0x80 == 0 {
            break;
        }
        if count >= 10 {
            return Err(RomWeaverError::Validation(
                "base-128 integer exceeds the supported length".into(),
            ));
        }
    }
    Ok((value, count))
}

fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed u64")))
}

