use crate::chd_rs::Error;
use crate::chd_rs::compression::{
    CodecImplementation, CompressionCodec, CompressionCodecType, DecompressResult,
};
use crate::chd_rs::header::CodecType;
use zstd::zstd_safe;

/// Zstandard (zstd) decompression codec.
///
/// ## Format Details
/// CHD compresses Zstandard hunks with the streaming compressor.
///
/// ## Buffer Restrictions
/// Each compressed Zstandard hunk decompresses to a hunk-sized chunk.
/// The input buffer must contain exactly enough data to fill the output buffer
/// when decompressed.
pub struct ZstdCodec {
    zstd_context: zstd_safe::DCtx<'static>,
    compressor: zstd_safe::CCtx<'static>,
}

impl CodecImplementation for ZstdCodec {
    fn new(_hunk_size: u32) -> crate::chd_rs::Result<Self>
    where
        Self: Sized,
    {
        Ok(Self {
            zstd_context: zstd_safe::DCtx::try_create().ok_or(crate::chd_rs::Error::CodecError)?,
            compressor: zstd_safe::CCtx::try_create().ok_or(Error::CodecError)?,
        })
    }

    fn compress(&mut self, input: &[u8], output: &mut [u8]) -> crate::chd_rs::Result<usize> {
        // Anything not smaller than the input is a failure, so don't bother writing more.
        let output_len = output.len().min(input.len());
        let compressed_len = self
            .compressor
            .compress(&mut output[..output_len], input, zstd_safe::max_c_level())
            .map_err(|_| Error::CompressionError)?;
        if compressed_len >= input.len() {
            return Err(Error::CompressionError);
        }
        Ok(compressed_len)
    }

    fn decompress(
        &mut self,
        input: &[u8],
        output: &mut [u8],
    ) -> crate::chd_rs::Result<DecompressResult> {
        self.zstd_context
            .reset(zstd_safe::ResetDirective::SessionAndParameters)
            .map_err(|_| Error::DecompressionError)?;

        // If each chunk doesn't output to exactly the same then it's an error
        let bytes_out = self
            .zstd_context
            .decompress(output, input)
            .map_err(|_| Error::DecompressionError)?;

        if bytes_out != output.len() {
            return Err(Error::DecompressionError);
        }

        Ok(DecompressResult {
            bytes_out: output.len(),
            // ZSTD_decompress() takes the exact size of a number of frames, so it
            // should've returned an error if it hasn't used the entire input slice.
            bytes_read: input.len(),
        })
    }
}

impl CompressionCodecType for ZstdCodec {
    fn codec_type(&self) -> CodecType
    where
        Self: Sized,
    {
        CodecType::ZstdV5
    }
}

impl CompressionCodec for ZstdCodec {}
