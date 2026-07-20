use super::*;

pub(super) const CD_SYNC_HEADER: [u8; 12] = [
    0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,
];
pub(super) const CD_SYNC_BYTES: usize = 12;
pub(super) const CD_MODE_OFFSET: usize = 0x0f;
pub(super) const CD_ECC_DATA_BYTES: usize = 0x8bc;
pub(super) const CD_ECC_P_OFFSET: usize = 0x81c;
pub(super) const CD_ECC_P_NUM_BYTES: usize = 86;
pub(super) const CD_ECC_P_COMPONENTS: usize = 24;
pub(super) const CD_ECC_Q_OFFSET: usize = CD_ECC_P_OFFSET + CD_ECC_P_NUM_BYTES * 2;
pub(super) const CD_ECC_Q_NUM_BYTES: usize = 52;
pub(super) const CD_ECC_Q_COMPONENTS: usize = 43;
pub(super) const CD_ECC_Q_STEP: usize = 88;
pub(super) const CD_ECC_LOW: [u8; 256] = build_cd_ecc_low_table();
pub(super) const CD_ECC_HIGH: [u8; 256] = build_cd_ecc_high_table();

pub(super) const fn cd_ecc_low_value(value: u8) -> u8 {
    let mut doubled = (value as u16) << 1;
    if value & 0x80 != 0 {
        doubled ^= 0x11d;
    }
    (doubled & 0xff) as u8
}

pub(super) const fn build_cd_ecc_low_table() -> [u8; 256] {
    let mut table = [0_u8; 256];
    let mut value = 0usize;
    while value < 256 {
        table[value] = cd_ecc_low_value(value as u8);
        value += 1;
    }
    table
}

pub(super) const fn build_cd_ecc_high_table() -> [u8; 256] {
    let mut table = [0_u8; 256];
    let mut value = 0usize;
    while value < 256 {
        let byte = value as u8;
        let low = cd_ecc_low_value(byte);
        table[(low ^ byte) as usize] = byte;
        value += 1;
    }
    table
}

impl ChdContainerHandler {
    pub(super) fn cd_sector_has_reconstructable_ecc(sector: &[u8]) -> bool {
        sector.len() == Self::CD_SECTOR_DATA_BYTES
            && sector.starts_with(&CD_SYNC_HEADER)
            && Self::cd_sector_verify_ecc(sector)
    }

    pub(super) fn cd_sector_clear_sync_and_ecc(sector: &mut [u8]) {
        if sector.len() != Self::CD_SECTOR_DATA_BYTES {
            return;
        }
        sector[..CD_SYNC_BYTES].fill(0);
        sector[CD_ECC_P_OFFSET..].fill(0);
    }

    pub(super) fn cd_sector_verify_ecc(sector: &[u8]) -> bool {
        if sector.len() != Self::CD_SECTOR_DATA_BYTES {
            return false;
        }

        for ecc_byte in 0..CD_ECC_P_NUM_BYTES {
            let (low, high) = Self::cd_sector_compute_ecc(
                sector,
                ecc_byte,
                CD_ECC_P_NUM_BYTES,
                CD_ECC_P_COMPONENTS,
            );
            if sector[CD_ECC_P_OFFSET + ecc_byte] != low
                || sector[CD_ECC_P_OFFSET + CD_ECC_P_NUM_BYTES + ecc_byte] != high
            {
                return false;
            }
        }

        for ecc_byte in 0..CD_ECC_Q_NUM_BYTES {
            let start = (ecc_byte / 2) * CD_ECC_P_NUM_BYTES + (ecc_byte & 1);
            let (low, high) =
                Self::cd_sector_compute_ecc(sector, start, CD_ECC_Q_STEP, CD_ECC_Q_COMPONENTS);
            if sector[CD_ECC_Q_OFFSET + ecc_byte] != low
                || sector[CD_ECC_Q_OFFSET + CD_ECC_Q_NUM_BYTES + ecc_byte] != high
            {
                return false;
            }
        }

        true
    }

    pub(super) fn cd_sector_compute_ecc(
        sector: &[u8],
        start: usize,
        step: usize,
        components: usize,
    ) -> (u8, u8) {
        let mut value1 = 0_u8;
        let mut value2 = 0_u8;
        let mut offset = start;
        let mode2 = sector[CD_MODE_OFFSET] == 2;
        for component in 0..components {
            let value = if mode2 && offset < 4 {
                0
            } else {
                sector[CD_SYNC_BYTES + offset]
            };
            value1 = CD_ECC_LOW[(value ^ value1) as usize];
            value2 ^= value;
            if component + 1 < components {
                offset += step;
                if offset >= CD_ECC_DATA_BYTES {
                    offset -= CD_ECC_DATA_BYTES;
                }
            }
        }
        value1 = CD_ECC_HIGH[(CD_ECC_LOW[value1 as usize] ^ value2) as usize];
        (value1, value1 ^ value2)
    }

    #[cfg(test)]
    pub fn generate_cd_sector_ecc_for_tests(sector: &mut [u8]) {
        if sector.len() != Self::CD_SECTOR_DATA_BYTES {
            return;
        }

        for ecc_byte in 0..CD_ECC_P_NUM_BYTES {
            let (low, high) = Self::cd_sector_compute_ecc(
                sector,
                ecc_byte,
                CD_ECC_P_NUM_BYTES,
                CD_ECC_P_COMPONENTS,
            );
            sector[CD_ECC_P_OFFSET + ecc_byte] = low;
            sector[CD_ECC_P_OFFSET + CD_ECC_P_NUM_BYTES + ecc_byte] = high;
        }

        for ecc_byte in 0..CD_ECC_Q_NUM_BYTES {
            let start = (ecc_byte / 2) * CD_ECC_P_NUM_BYTES + (ecc_byte & 1);
            let (low, high) =
                Self::cd_sector_compute_ecc(sector, start, CD_ECC_Q_STEP, CD_ECC_Q_COMPONENTS);
            sector[CD_ECC_Q_OFFSET + ecc_byte] = low;
            sector[CD_ECC_Q_OFFSET + CD_ECC_Q_NUM_BYTES + ecc_byte] = high;
        }
    }
}
