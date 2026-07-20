use tracing::instrument;

use crate::nod::{
    common::KeyBytes,
    disc::{
        SECTOR_SIZE,
        wii::{HASHES_SIZE, SECTOR_DATA_SIZE},
    },
    util::array_ref,
};

/// Encrypts data in-place using AES-128-CBC with the given key and IV.
pub fn aes_cbc_encrypt(key: &KeyBytes, iv: &KeyBytes, data: &mut [u8]) {
    assert_eq!(data.len() % 16, 0);
    {
        use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::NoPadding};
        <cbc::Encryptor<aes::Aes128>>::new(key.into(), iv.into())
            .encrypt_padded::<NoPadding>(data, data.len())
            .unwrap();
    }
}

/// Decrypts data in-place using AES-128-CBC with the given key and IV.
pub fn aes_cbc_decrypt(key: &KeyBytes, iv: &KeyBytes, data: &mut [u8]) {
    assert_eq!(data.len() % 16, 0);
    {
        use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::NoPadding};
        <cbc::Decryptor<aes::Aes128>>::new(key.into(), iv.into())
            .decrypt_padded::<NoPadding>(data)
            .unwrap();
    }
}

/// Decrypts data buffer-to-buffer using AES-128-CBC with the given key and IV.
pub fn aes_cbc_decrypt_b2b(key: &KeyBytes, iv: &KeyBytes, data: &[u8], out: &mut [u8]) {
    assert_eq!(data.len() % 16, 0);
    assert_eq!(data.len(), out.len());
    {
        use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::NoPadding};
        <cbc::Decryptor<aes::Aes128>>::new(key.into(), iv.into())
            .decrypt_padded_b2b::<NoPadding>(data, out)
            .unwrap();
    }
}

/// Encrypts a Wii partition sector in-place.
#[instrument(skip_all)]
pub fn encrypt_sector(out: &mut [u8; SECTOR_SIZE], key: &KeyBytes) {
    aes_cbc_encrypt(key, &[0u8; 16], &mut out[..HASHES_SIZE]);
    // Data IV from encrypted hash block
    let iv = *array_ref![out, 0x3D0, 16];
    aes_cbc_encrypt(key, &iv, &mut out[HASHES_SIZE..]);
}

/// Decrypts a Wii partition sector in-place.
#[instrument(skip_all)]
pub fn decrypt_sector(out: &mut [u8; SECTOR_SIZE], key: &KeyBytes) {
    // Data IV from encrypted hash block
    let iv = *array_ref![out, 0x3D0, 16];
    aes_cbc_decrypt(key, &[0u8; 16], &mut out[..HASHES_SIZE]);
    aes_cbc_decrypt(key, &iv, &mut out[HASHES_SIZE..]);
}

/// Decrypts a Wii partition sector buffer-to-buffer.
#[instrument(skip_all)]
pub fn decrypt_sector_b2b(data: &[u8; SECTOR_SIZE], out: &mut [u8; SECTOR_SIZE], key: &KeyBytes) {
    // Data IV from encrypted hash block
    let iv = *array_ref![data, 0x3D0, 16];
    aes_cbc_decrypt_b2b(
        key,
        &[0u8; 16],
        &data[..HASHES_SIZE],
        &mut out[..HASHES_SIZE],
    );
    aes_cbc_decrypt_b2b(key, &iv, &data[HASHES_SIZE..], &mut out[HASHES_SIZE..]);
}

/// Decrypts a Wii partition sector data (excluding hashes) buffer-to-buffer.
#[instrument(skip_all)]
pub fn decrypt_sector_data_b2b(
    data: &[u8; SECTOR_SIZE],
    out: &mut [u8; SECTOR_DATA_SIZE],
    key: &KeyBytes,
) {
    // Data IV from encrypted hash block
    let iv = *array_ref![data, 0x3D0, 16];
    aes_cbc_decrypt_b2b(key, &iv, &data[HASHES_SIZE..], out);
}
