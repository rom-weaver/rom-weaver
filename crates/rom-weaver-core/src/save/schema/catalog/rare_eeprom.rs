use super::rules::{ReadValue, Scalar, Store};
use super::*;

// Rare's 64-bit EEPROM record checksum, shared by GoldenEye 007, Banjo-Kazooie, and Banjo-Tooie.
// The hash follows
// https://github.com/bryc/rare-n64-chksm as ported at this pinned MIT-licensed revision.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/utils/common/nintendo64/index.ts
fn hash(byte: u8, polynomial: u64, shift: u32) -> u64 {
    let first = polynomial.wrapping_add(u64::from(byte) << (shift & 15)) & 0x1_ffff_ffff;
    let second = ((first << 63) >> 31 | (first >> 1)) ^ ((first << 44) >> 32);
    second ^ ((second >> 20) & 0xfff)
}

/// Returns the big-endian words stored for a record: the low 32 bits of the forward-pass
/// accumulator, then the low 32 bits of the reverse-pass accumulator.
pub(super) fn checksum(data: &[u8]) -> [u32; 2] {
    let mut polynomial = 0x1_3108_b3c1;
    let mut forward = 0;
    let mut reverse = 0;
    let mut shift = 0;
    for byte in data {
        polynomial = hash(*byte, polynomial, shift);
        forward ^= polynomial;
        shift += 7;
    }
    for byte in data.iter().rev() {
        polynomial = hash(*byte, polynomial, shift);
        reverse ^= polynomial;
        shift += 3;
    }
    let words = [forward as u32, reverse as u32];
    trace!(
        length = data.len(),
        high = words[0],
        low = words[1],
        "computed Rare EEPROM checksum"
    );
    words
}

/// Reports whether the two words at `offset` match the checksum of `bytes[data]`.
pub(super) fn valid(bytes: &[u8], offset: usize, data: std::ops::Range<usize>) -> bool {
    let words = checksum(&bytes[data]);
    bytes[offset..offset + 4] == words[0].to_be_bytes()
        && bytes[offset + 4..offset + 8] == words[1].to_be_bytes()
}

/// Rewrites the two words at `offset` from `data` after every edit.
pub(super) fn stores(offset: usize, data: std::ops::Range<usize>) -> Vec<Store> {
    (0..2)
        .map(|word| {
            let data = data.clone();
            Store {
                when: None,
                destination: Scalar {
                    offset: offset + word * 4,
                    storage: Storage::U32Be,
                    mask: None,
                },
                value: ReadValue::new(move |bytes| {
                    Ok(i64::from(checksum(&bytes[data.clone()])[word]))
                }),
            }
        })
        .collect()
}

/// Independent formulation of the checksum for tests: wide integers and bit masks instead of
/// shifting a 64-bit value out of range.
#[cfg(test)]
pub(super) fn reference_checksum(data: &[u8]) -> [u32; 2] {
    let step = |byte: u8, polynomial: u128, shift: u32| -> u128 {
        let first = (polynomial + (u128::from(byte) << (shift & 15))) & ((1 << 33) - 1);
        let second = ((first & 1) << 32 | first >> 1) ^ ((first & 0xf_ffff) << 12);
        second ^ ((second >> 20) & 0xfff)
    };
    let mut polynomial = 0x1_3108_b3c1;
    let (mut forward, mut reverse, mut shift) = (0u128, 0u128, 0);
    for byte in data {
        polynomial = step(*byte, polynomial, shift);
        forward ^= polynomial;
        shift += 7;
    }
    for byte in data.iter().rev() {
        polynomial = step(*byte, polynomial, shift);
        reverse ^= polynomial;
        shift += 3;
    }
    [forward as u32, reverse as u32]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_independent_vectors() {
        // Calculated with a Python port of the upstream Long arithmetic, masking every 64-bit shift.
        let ramp = |length: usize, scale: usize, bias: usize| -> Vec<u8> {
            (0..length)
                .map(|index| (index * scale + bias) as u8)
                .collect()
        };
        for (data, expected) in [
            (vec![], [0, 0]),
            (vec![0; 0x58], [0xea99_9317, 0x6de5_0fa7]),
            (vec![0x25; 0x58], [0x6e4d_9c46, 0xab1f_7722]),
            (ramp(0x58, 7, 3), [0xee5c_3e13, 0xca97_752f]),
            (vec![0xff; 0x58], [0xbc1d_bdb3, 0x628d_8299]),
            (ramp(0x1b8, 13, 5), [0xaa21_05c9, 0x18b6_7f04]),
            (vec![1], [0x13b8_78da, 0x8e49_9449]),
        ] {
            assert_eq!(checksum(&data), expected, "length {}", data.len());
            assert_eq!(reference_checksum(&data), expected, "length {}", data.len());
        }
    }
}
