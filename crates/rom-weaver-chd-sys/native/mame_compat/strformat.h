// Minimal formatting helper required by the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_STRFORMAT_H
#define ROM_WEAVER_MAME_COMPAT_STRFORMAT_H

#include <cstdio>
#include <string>

namespace util {

template <typename... Args>
std::string string_format(char const *format, Args... args)
{
    int const needed = std::snprintf(nullptr, 0, format, args...);
    if (needed <= 0) {
        return std::string();
    }

    std::string result(static_cast<std::size_t>(needed), '\0');
    std::snprintf(result.data(), result.size() + 1, format, args...);
    return result;
}

} // namespace util

#endif
