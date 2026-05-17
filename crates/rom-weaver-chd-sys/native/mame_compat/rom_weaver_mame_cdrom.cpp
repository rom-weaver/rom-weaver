#include "cdrom.h"

#include <array>
#include <cstddef>
#include <cstring>

namespace {

constexpr std::uint32_t kPStride = 0x56;
constexpr std::uint32_t kQStride = 0x58;
constexpr std::uint32_t kQModulo = 0x8bc;
constexpr std::uint32_t kSyncOffset = 0x000;
constexpr std::uint32_t kSyncNumBytes = 12;
constexpr std::uint32_t kModeOffset = 0x00f;

constexpr std::array<std::uint8_t, 256> build_ecc_low()
{
    std::array<std::uint8_t, 256> table{};
    for (std::size_t index = 0; index < table.size(); ++index)
    {
        std::uint8_t value = static_cast<std::uint8_t>(index);
        table[index] = static_cast<std::uint8_t>((value < 0x80U) ? (value << 1U) : ((value << 1U) ^ 0x1dU));
    }
    return table;
}

constexpr std::array<std::uint8_t, 256> build_ecc_high(
    std::array<std::uint8_t, 256> const &low
)
{
    std::array<std::uint8_t, 256> table{};
    for (std::size_t index = 0; index < low.size(); ++index)
    {
        std::uint8_t value = static_cast<std::uint8_t>(index);
        table[static_cast<std::uint8_t>(low[index] ^ value)] = value;
    }
    return table;
}

constexpr auto kEccLow = build_ecc_low();
constexpr auto kEccHigh = build_ecc_high(kEccLow);

inline std::uint8_t ecc_source_byte(std::uint8_t const *sector, std::uint32_t offset)
{
    if (sector[kModeOffset] == 2U && offset < 4U)
    {
        return 0U;
    }
    return sector[kSyncOffset + kSyncNumBytes + offset];
}

inline std::uint32_t p_offset(std::uint32_t major, std::uint32_t component)
{
    return major + component * kPStride;
}

inline std::uint32_t q_offset(std::uint32_t major, std::uint32_t component)
{
    std::uint32_t base = (major / 2U) * kPStride + (major & 1U);
    return (base + component * kQStride) % kQModulo;
}

void ecc_compute_bytes(
    std::uint8_t const *sector,
    std::uint32_t major,
    std::uint32_t row_length,
    bool q_axis,
    std::uint8_t &value1,
    std::uint8_t &value2
)
{
    value1 = 0;
    value2 = 0;
    for (std::uint32_t component = 0; component < row_length; ++component)
    {
        std::uint32_t source_offset = q_axis
            ? q_offset(major, component)
            : p_offset(major, component);
        std::uint8_t source = ecc_source_byte(sector, source_offset);
        value1 ^= source;
        value2 ^= source;
        value1 = kEccLow[value1];
    }
    value1 = kEccHigh[static_cast<std::uint8_t>(kEccLow[value1] ^ value2)];
    value2 ^= value1;
}

} // namespace

bool cdrom_file::ecc_verify(std::uint8_t const *sector)
{
    for (std::uint32_t byte = 0; byte < ECC_P_NUM_BYTES; ++byte)
    {
        std::uint8_t value1 = 0;
        std::uint8_t value2 = 0;
        ecc_compute_bytes(sector, byte, ECC_P_COMP, false, value1, value2);
        if (sector[ECC_P_OFFSET + byte] != value1 ||
            sector[ECC_P_OFFSET + ECC_P_NUM_BYTES + byte] != value2)
        {
            return false;
        }
    }

    for (std::uint32_t byte = 0; byte < ECC_Q_NUM_BYTES; ++byte)
    {
        std::uint8_t value1 = 0;
        std::uint8_t value2 = 0;
        ecc_compute_bytes(sector, byte, ECC_Q_COMP, true, value1, value2);
        if (sector[ECC_Q_OFFSET + byte] != value1 ||
            sector[ECC_Q_OFFSET + ECC_Q_NUM_BYTES + byte] != value2)
        {
            return false;
        }
    }

    return true;
}

void cdrom_file::ecc_generate(std::uint8_t *sector)
{
    for (std::uint32_t byte = 0; byte < ECC_P_NUM_BYTES; ++byte)
    {
        ecc_compute_bytes(
            sector,
            byte,
            ECC_P_COMP,
            false,
            sector[ECC_P_OFFSET + byte],
            sector[ECC_P_OFFSET + ECC_P_NUM_BYTES + byte]
        );
    }

    for (std::uint32_t byte = 0; byte < ECC_Q_NUM_BYTES; ++byte)
    {
        ecc_compute_bytes(
            sector,
            byte,
            ECC_Q_COMP,
            true,
            sector[ECC_Q_OFFSET + byte],
            sector[ECC_Q_OFFSET + ECC_Q_NUM_BYTES + byte]
        );
    }
}

void cdrom_file::ecc_clear(std::uint8_t *sector)
{
    std::memset(&sector[ECC_P_OFFSET], 0, 2U * ECC_P_NUM_BYTES);
    std::memset(&sector[ECC_Q_OFFSET], 0, 2U * ECC_Q_NUM_BYTES);
}
