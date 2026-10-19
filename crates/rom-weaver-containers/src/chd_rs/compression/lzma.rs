use crate::chd_rs::compression::{
    CodecImplementation, CompressionCodec, CompressionCodecType, DecompressResult,
};
use crate::chd_rs::const_assert;
use crate::chd_rs::error::{Error, Result};
use crate::chd_rs::header::CodecType;
use lzma_rust2::LzmaReader;
use std::io::{Cursor, Read};

/// LZMA (lzma) codec.
///
/// ## Format Details
/// CHD compresses LZMA hunks without an xz stream header or end marker using
/// the default compression settings for LZMA 19.0. These settings are
///
/// * Literal Context Bits (`LC`): 3
/// * Literal Position Bits (`LP`): 0
/// * Position Bits (`PB`): 2
///
/// The dictionary size is determined via the following algorithm with a level of 9, and a
/// reduction size of hunk size.
///
/// ```rust
/// fn get_lzma_dict_size(level: u32, reduce_size: u32) -> u32 {
///     let mut dict_size = if level <= 5 {
///         1 << (level * 2 + 14)
///     } else if level <= 7 {
///         1 << 25
///     } else {
///        1 << 26
///     };
///
///     // This does the same thing as LzmaEnc.c when determining dict_size
///     if dict_size > reduce_size {
///         for i in 11..=30 {
///             if reduce_size <= (2u32 << i) {
///                 dict_size = 2u32 << i;
///                 break;
///             }
///             if reduce_size <= (3u32 << i) {
///                 dict_size = 3u32 << i;
///                 break;
///             }
///         }
///     }
///     dict_size
/// }
/// ```
///
/// ## Buffer Restrictions
/// Each compressed LZMA hunk decompresses to a hunk-sized chunk.
/// The input buffer must contain exactly enough data to fill the output buffer
/// when decompressed.
pub struct LzmaCodec<const LC: u32 = 3, const LP: u32 = 0, const PB: u32 = 2> {
    dict_size: u32,
    level: u32,
    encode_dict_size: u32,
}

/// The LZMA level that MAME compresses with.
const MAME_LZMA_LEVEL: u32 = 6;

impl<const LC: u32, const LP: u32, const PB: u32> CompressionCodec for LzmaCodec<LC, LP, PB> {}

/// The mode, match finder, nice length and match depth that `LzmaEncProps_Normalize` picks
/// for a level, as liblzma options.
fn lzma_enc_props(
    level: u32,
) -> (
    liblzma_sys::lzma_mode,
    liblzma_sys::lzma_match_finder,
    u32,
    u32,
) {
    let fast = level < 5;
    let (mode, mf) = if fast {
        (liblzma_sys::LZMA_MODE_FAST, liblzma_sys::LZMA_MF_HC4)
    } else {
        (liblzma_sys::LZMA_MODE_NORMAL, liblzma_sys::LZMA_MF_BT4)
    };
    let nice_len = if level < 7 { 32 } else { 64 };
    (mode, mf, nice_len, (16 + nice_len / 2) >> u32::from(fast))
}

/// MAME/libchdr uses an ancient LZMA 19.00.
///
/// To match the proper dictionary size, we copy the algorithm from
/// [`LzmaEnc::LzmaEncProps_Normalize`](https://github.com/rtissera/libchdr/blob/cdcb714235b9ff7d207b703260706a364282b063/deps/lzma-19.00/src/LzmaEnc.c#L52).
fn get_lzma_dict_size(level: u32, reduce_size: u32) -> u32 {
    let mut dict_size = if level <= 5 {
        1 << (level * 2 + 14)
    } else if level <= 7 {
        1 << 25
    } else {
        1 << 26
    };

    // this does the same thing as LzmaEnc.c when determining dict_size
    if dict_size > reduce_size {
        // might be worth converting this to a while loop for const
        // depends if we can const-propagate hunk_size.
        // todo: #[feature(const_inherent_unchecked_arith)
        for i in 11..=30 {
            if reduce_size <= (2u32 << i) {
                dict_size = 2u32 << i;
                break;
            }
            if reduce_size <= (3u32 << i) {
                dict_size = 3u32 << i;
                break;
            }
        }
    }

    dict_size
}

impl<const LC: u32, const LP: u32, const PB: u32> CompressionCodecType for LzmaCodec<LC, LP, PB> {
    fn codec_type(&self) -> CodecType
    where
        Self: Sized,
    {
        CodecType::LzmaV5
    }
}

impl<const LC: u32, const LP: u32, const PB: u32> CodecImplementation for LzmaCodec<LC, LP, PB> {
    fn new(hunk_size: u32) -> Result<Self> {
        const_assert!(LC: u32, LP: u32, PB: u32 => LC <= 8 && LP <= 4 && PB <= 4);

        Ok(LzmaCodec {
            dict_size: get_lzma_dict_size(9, hunk_size),
            level: MAME_LZMA_LEVEL,
            encode_dict_size: get_lzma_dict_size(MAME_LZMA_LEVEL, hunk_size),
        })
    }

    /// LZMA levels range from 0 to 9, like LzmaEncProps. chdman uses 6.
    ///
    /// Hunks compressed at any level decompress with the dictionary size of level 9.
    fn with_level(hunk_size: u32, level: i32) -> Result<Self> {
        let level = u32::try_from(level)
            .ok()
            .filter(|level| *level <= 9)
            .ok_or(Error::InvalidParameter)?;
        Ok(LzmaCodec {
            level,
            encode_dict_size: get_lzma_dict_size(level, hunk_size),
            ..Self::new(hunk_size)?
        })
    }

    fn decompress(&mut self, input: &[u8], output: &mut [u8]) -> Result<DecompressResult> {
        let mut reader = LzmaReader::new(
            Cursor::new(input),
            output.len() as u64,
            LC,
            LP,
            PB,
            self.dict_size,
            None,
        )
        .map_err(|_| Error::DecompressionError)?;

        reader
            .read_exact(output)
            .map_err(|_| Error::DecompressionError)?;

        // Rewind back to only decoded bytes.
        let (input_cursor, unread) = reader.into_parts();
        let bytes_read = input_cursor.position() as usize - unread.len();
        Ok(DecompressResult::new(output.len(), bytes_read))
    }

    fn compress(&mut self, input: &[u8], output: &mut [u8]) -> Result<usize> {
        // MAME compresses with LzmaEncProps level 6, in
        // https://github.com/mamedev/mame/blob/74b9fae5a3ca3c99828fe41da154e3c84951414e/src/lib/util/chdcodec.cpp#L1312-L1318
        //
        // rom-weaver already links liblzma, so this avoids carrying a second LZMA encoder.
        // liblzma's presets differ from LzmaEncProps_Normalize in mode, match finder, nice
        // length and match depth, so those are set from LzmaEncProps below.
        //
        // LZMA1EXT with a known size writes a raw stream with no header and no end marker,
        // which is how CHD stores LZMA hunks.
        const LZMA_FILTER_LZMA1EXT: liblzma_sys::lzma_vli = 0x4000000000000002;

        // Anything not smaller than the input is a failure, so don't bother writing more.
        let output_len = output.len().min(input.len());
        if output_len == 0 {
            return Err(Error::CompressionError);
        }

        // SAFETY: `lzma_options_lzma` is a plain C struct that `lzma_lzma_preset` initialises.
        let mut options = unsafe { std::mem::zeroed::<liblzma_sys::lzma_options_lzma>() };
        // SAFETY: `options` is a valid, writable `lzma_options_lzma`.
        if unsafe { liblzma_sys::lzma_lzma_preset(&mut options, self.level) } != 0 {
            return Err(Error::CompressionError);
        }
        // LzmaEncProps_Normalize
        // https://github.com/rtissera/libchdr/blob/cdcb714235b9ff7d207b703260706a364282b063/deps/lzma-19.00/src/LzmaEnc.c#L74-L78
        // normalizes the level to the fast algorithm with a HC4 hash chain match finder below
        // level 5, or the normal (optimum) algorithm with a BT4 binary tree otherwise
        // (btMode = algo, numHashBytes = 4), fb = 32 below level 7 or 64 otherwise, and
        // mc = (16 + fb / 2), halved for hash chains. Level 6 is normal, BT4, fb = 32 and mc = 32.
        (options.mode, options.mf, options.nice_len, options.depth) = lzma_enc_props(self.level);
        options.lc = LC;
        options.lp = LP;
        options.pb = PB;
        options.dict_size = self.encode_dict_size;
        options.ext_flags = 0;
        options.ext_size_low = input.len() as u32;
        options.ext_size_high = ((input.len() as u64) >> 32) as u32;

        let filters = [
            liblzma_sys::lzma_filter {
                id: LZMA_FILTER_LZMA1EXT,
                options: (&raw mut options).cast::<std::ffi::c_void>(),
            },
            liblzma_sys::lzma_filter {
                id: liblzma_sys::LZMA_VLI_UNKNOWN,
                options: std::ptr::null_mut(),
            },
        ];

        let mut output_pos = 0usize;
        // SAFETY: the filter chain, input and output pointers are valid for the given lengths,
        // and liblzma writes at most `output_len` bytes into `output`.
        let status = unsafe {
            liblzma_sys::lzma_raw_buffer_encode(
                filters.as_ptr(),
                std::ptr::null(),
                input.as_ptr(),
                input.len(),
                output.as_mut_ptr(),
                &mut output_pos,
                output_len,
            )
        };
        // LZMA_BUF_ERROR means the stream did not fit in the output, so it is not smaller.
        if status != liblzma_sys::LZMA_OK || output_pos >= input.len() {
            return Err(Error::CompressionError);
        }
        Ok(output_pos)
    }
}

#[cfg(test)]
mod tests {
    use super::lzma_enc_props;
    use liblzma_sys::{LZMA_MF_BT4, LZMA_MF_HC4, LZMA_MODE_FAST, LZMA_MODE_NORMAL};

    #[test]
    fn levels_use_the_lzma_enc_props_encoder_settings() {
        // LzmaEnc.c: algo = level < 5 ? 0 : 1, fb = level < 7 ? 32 : 64,
        // mc = (16 + fb / 2) >> (btMode ? 0 : 1).
        assert_eq!(lzma_enc_props(0), (LZMA_MODE_FAST, LZMA_MF_HC4, 32, 16));
        assert_eq!(lzma_enc_props(4), (LZMA_MODE_FAST, LZMA_MF_HC4, 32, 16));
        assert_eq!(lzma_enc_props(5), (LZMA_MODE_NORMAL, LZMA_MF_BT4, 32, 32));
        assert_eq!(lzma_enc_props(6), (LZMA_MODE_NORMAL, LZMA_MF_BT4, 32, 32));
        assert_eq!(lzma_enc_props(7), (LZMA_MODE_NORMAL, LZMA_MF_BT4, 64, 48));
        assert_eq!(lzma_enc_props(9), (LZMA_MODE_NORMAL, LZMA_MF_BT4, 64, 48));
    }
}
