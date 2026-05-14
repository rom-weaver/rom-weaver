// Minimal file flags and remove helper required by the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_OSDFILE_H
#define ROM_WEAVER_MAME_COMPAT_OSDFILE_H

#include <cerrno>
#include <cstdio>
#include <cstdint>
#include <string>
#include <system_error>

constexpr uint32_t OPEN_FLAG_READ = 0x0001;
constexpr uint32_t OPEN_FLAG_WRITE = 0x0002;
constexpr uint32_t OPEN_FLAG_CREATE = 0x0004;
constexpr uint32_t OPEN_FLAG_CREATE_PATHS = 0x0008;
constexpr uint32_t OPEN_FLAG_NO_PRELOAD = 0x0010;

class osd_file
{
public:
    static std::error_condition remove(std::string const &filename) noexcept
    {
        if (std::remove(filename.c_str()) == 0)
            return std::error_condition();
        return std::error_condition(errno, std::generic_category());
    }
};

#endif
