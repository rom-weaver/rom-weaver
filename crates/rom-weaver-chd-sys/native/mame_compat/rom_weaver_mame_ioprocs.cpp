#include "ioprocs.h"

#include <algorithm>

namespace util {

std::pair<std::error_condition, std::size_t> read(read_stream &stream, void *buffer, std::size_t length) noexcept
{
    std::size_t total = 0;
    auto *current = static_cast<unsigned char *>(buffer);
    while (total < length)
    {
        std::size_t actual = 0;
        std::error_condition err = stream.read_some(current + total, length - total, actual);
        total += actual;
        if (err || !actual)
            return {err, total};
    }
    return {std::error_condition(), total};
}

std::pair<std::error_condition, std::size_t> write(write_stream &stream, void const *buffer, std::size_t length) noexcept
{
    std::size_t total = 0;
    auto const *current = static_cast<unsigned char const *>(buffer);
    while (total < length)
    {
        std::size_t actual = 0;
        std::error_condition err = stream.write_some(current + total, length - total, actual);
        total += actual;
        if (err || !actual)
            return {err, total};
    }
    return {std::error_condition(), total};
}

} // namespace util
