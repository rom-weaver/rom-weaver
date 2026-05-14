// Minimal file adapter required by the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_COREFILE_H
#define ROM_WEAVER_MAME_COMPAT_COREFILE_H

#include "ioprocs.h"
#include "osdfile.h"

#include <cstdint>
#include <memory>
#include <string_view>
#include <system_error>

namespace util {

class core_file : public random_read_write
{
public:
    using ptr = std::unique_ptr<core_file>;

    static std::error_condition open(std::string_view filename, std::uint32_t openflags, ptr &file) noexcept;

    virtual ~core_file() = default;
};

} // namespace util

#endif
