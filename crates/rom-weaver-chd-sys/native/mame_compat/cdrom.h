// Minimal CD constants and ECC helpers required by the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_CDROM_H
#define ROM_WEAVER_MAME_COMPAT_CDROM_H

#include <cstdint>

class cdrom_file
{
public:
    static constexpr std::uint32_t MAX_SECTOR_DATA = 2352;
    static constexpr std::uint32_t MAX_SUBCODE_DATA = 96;
    static constexpr std::uint32_t FRAME_SIZE = MAX_SECTOR_DATA + MAX_SUBCODE_DATA;

    static bool ecc_verify(std::uint8_t const *sector);
    static void ecc_generate(std::uint8_t *sector);
    static void ecc_clear(std::uint8_t *sector);

private:
    static constexpr std::uint32_t SYNC_OFFSET = 0x000;
    static constexpr std::uint32_t SYNC_NUM_BYTES = 12;
    static constexpr std::uint32_t MODE_OFFSET = 0x00f;
    static constexpr std::uint32_t ECC_P_OFFSET = 0x81c;
    static constexpr std::uint32_t ECC_P_NUM_BYTES = 86;
    static constexpr std::uint32_t ECC_P_COMP = 24;
    static constexpr std::uint32_t ECC_Q_OFFSET = ECC_P_OFFSET + 2 * ECC_P_NUM_BYTES;
    static constexpr std::uint32_t ECC_Q_NUM_BYTES = 52;
    static constexpr std::uint32_t ECC_Q_COMP = 43;
};

#endif
