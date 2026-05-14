// Minimal compatibility helpers for the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_CORETMPL_H
#define ROM_WEAVER_MAME_COMPAT_CORETMPL_H

#include <type_traits>

namespace util {

template <typename T>
constexpr auto sext(T value, unsigned bits) noexcept
{
    using signed_t = std::make_signed_t<T>;
    T const mask = T(1) << (bits - 1);
    return signed_t((value ^ mask) - mask);
}

} // namespace util

#endif
