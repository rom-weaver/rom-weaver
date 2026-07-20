use super::*;
pub(super) fn decode_exact(
    mut decoder: impl Read,
    expected_len: u64,
    codec: &'static str,
) -> Result<Vec<u8>> {
    let expected = usize::try_from(expected_len).map_err(|_| {
        RomWeaverError::Validation(format!("{codec} expected size overflowed usize"))
    })?;
    let mut output = vec![0u8; expected];
    decoder
        .read_exact(&mut output)
        .map_err(|error| RomWeaverError::Validation(format!("{codec} decode failed: {error}")))?;
    let mut trailing = [0u8; 1];
    let trailing_bytes = decoder
        .read(&mut trailing)
        .map_err(|error| RomWeaverError::Validation(format!("{codec} decode failed: {error}")))?;
    if trailing_bytes != 0 {
        return Err(RomWeaverError::Validation(format!(
            "{codec} decoded size mismatch: expected {expected}, got more than expected"
        )));
    }
    Ok(output)
}

pub fn decode_bzip2_exact(payload: &[u8], expected_len: u64) -> Result<Vec<u8>> {
    decode_exact(
        MultiBzDecoder::new(BufReader::new(Cursor::new(payload))),
        expected_len,
        "bzip2",
    )
}

pub fn decode_deflate_exact(payload: &[u8], expected_len: u64) -> Result<Vec<u8>> {
    decode_exact(
        DeflateDecoder::new(Cursor::new(payload)),
        expected_len,
        "deflate",
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeflateDecodeIntoBufferResult {
    pub bytes_written: usize,
    pub has_trailing_bytes: bool,
}

pub fn decode_deflate_into_buffer(
    payload: &[u8],
    output: &mut [u8],
) -> Result<DeflateDecodeIntoBufferResult> {
    let mut decoder = DeflateDecoder::new(Cursor::new(payload));
    let mut bytes_written = 0usize;
    while bytes_written < output.len() {
        let read = decoder
            .read(&mut output[bytes_written..])
            .map_err(|error| {
                RomWeaverError::Validation(format!("deflate decode failed: {error}"))
            })?;
        if read == 0 {
            break;
        }
        bytes_written = bytes_written.saturating_add(read);
    }

    let mut has_trailing_bytes = false;
    if bytes_written == output.len() {
        let mut trailing = [0u8; 1];
        has_trailing_bytes = decoder.read(&mut trailing).map_err(|error| {
            RomWeaverError::Validation(format!("deflate decode failed: {error}"))
        })? != 0;
    }

    Ok(DeflateDecodeIntoBufferResult {
        bytes_written,
        has_trailing_bytes,
    })
}

pub fn decode_zlib_exact(payload: &[u8], expected_len: u64) -> Result<Vec<u8>> {
    decode_exact(ZlibDecoder::new(Cursor::new(payload)), expected_len, "zlib")
}

pub fn encode_zstd(payload: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::bulk::compress(payload, level)
        .map_err(|error| RomWeaverError::Validation(format!("zstd encode failed: {error}")))
}

pub fn decode_zstd_exact(payload: &[u8], expected_len: u64) -> Result<Vec<u8>> {
    let decoder = ZstdDecoder::new(BufReader::new(Cursor::new(payload)))
        .map_err(|error| RomWeaverError::Validation(format!("zstd decode init failed: {error}")))?;
    decode_exact(decoder, expected_len, "zstd")
}

pub fn decode_lzma_with_props(
    payload: &[u8],
    expected_len: u64,
    props_byte: u8,
    dict_size: u32,
) -> Result<Vec<u8>> {
    let decoder = LzmaReader::new_with_props(
        Cursor::new(payload),
        expected_len,
        props_byte,
        dict_size,
        None,
    )
    .map_err(|error| RomWeaverError::Validation(format!("lzma decode init failed: {error}")))?;
    decode_exact(decoder, expected_len, "lzma")
}

pub fn decode_lzma2(payload: &[u8], expected_len: u64, dict_size: u32) -> Result<Vec<u8>> {
    decode_exact(
        Lzma2Reader::new(Cursor::new(payload), dict_size, None),
        expected_len,
        "lzma2",
    )
}

pub fn encode_xz_preset(payload: &[u8], level: u32) -> Result<Vec<u8>> {
    let mut encoder = XzWriter::new(Vec::new(), XzOptions::with_preset(level))
        .map_err(|error| RomWeaverError::Validation(format!("xz encode init failed: {error}")))?;
    encoder
        .write_all(payload)
        .map_err(|error| RomWeaverError::Validation(format!("xz encode failed: {error}")))?;
    encoder
        .finish()
        .map_err(|error| RomWeaverError::Validation(format!("xz encode finalize failed: {error}")))
}

pub fn decode_xz_exact(payload: &[u8], expected_len: u64) -> Result<Vec<u8>> {
    decode_exact(
        XzReader::new(Cursor::new(payload), false),
        expected_len,
        "xz",
    )
}
