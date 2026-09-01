use crate::nod::common::Compression;
use crate::nod::disc::fst::{Fst, FstBuilder, Node};
use crate::nod::util::compress::Compressor;

#[cfg(feature = "compress-bzip2")]
#[test]
fn bzip2_stores_a_block_raw_when_it_does_not_fit() {
    // Incompressible input: bzip2 needs more room than the block it came from,
    // which is the "store it raw" signal, not a compression failure.
    let mut data = vec![0u8; 16 * 1024];
    let mut state = 0x1234_5678u32;
    for byte in data.iter_mut() {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *byte = (state >> 24) as u8;
    }

    let mut compressor = Compressor::new(Compression::Bzip2(1), 64);
    let compressed = compressor.compress(&data).expect("compress must not fail");

    assert!(!compressed, "an incompressible block must be stored raw");
    assert!(compressor.buffer.is_empty());
}

#[test]
fn fst_new_rejects_a_root_length_that_overflows_the_node_array() {
    let mut buf = vec![0u8; size_of::<Node>() * 2];
    // Root node length is an attacker-controlled u32; u32::MAX * 12 leaves u32.
    buf[8..12].copy_from_slice(&u32::MAX.to_be_bytes());

    let error = Fst::new(&buf)
        .err()
        .expect("an oversized root length must be rejected");
    assert_eq!(error, "FST string table out of bounds");
}

#[test]
fn a_wii_fst_is_padded_to_a_multiple_of_four() {
    let mut builder = FstBuilder::new(true);
    // A 3-character name leaves the string table at 4 bytes; a 4-character one
    // makes it 5 and the FST size odd.
    builder.add_file("abcd", 0, 0);

    let size = builder.byte_size();
    let raw = builder.finalize();

    assert_eq!(size % 4, 0, "a Wii FST size must divide by four");
    assert_eq!(raw.len(), size);
}

#[test]
fn a_gamecube_fst_keeps_its_exact_size() {
    // The GameCube boot header stores byte counts, so nothing is padded: the
    // name that costs a Wii FST three padding bytes costs this one none.
    let mut gamecube = FstBuilder::new(false);
    gamecube.add_file("abcde", 0, 0);
    let gamecube_size = gamecube.byte_size();

    let mut wii = FstBuilder::new(true);
    wii.add_file("abcde", 0, 0);

    assert_eq!(gamecube_size % 4, 1);
    assert_eq!(gamecube.finalize().len(), gamecube_size);
    assert_eq!(wii.byte_size(), gamecube_size + 3);
}
