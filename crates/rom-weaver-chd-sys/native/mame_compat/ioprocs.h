// Minimal I/O interfaces required by the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_IOPROCS_H
#define ROM_WEAVER_MAME_COMPAT_IOPROCS_H

#include "utilfwd.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <system_error>
#include <tuple>
#include <utility>

namespace util {

class read_stream
{
public:
    using ptr = std::unique_ptr<read_stream>;
    virtual ~read_stream() = default;
    virtual std::error_condition read_some(void *buffer, std::size_t length, std::size_t &actual) noexcept = 0;
};

class write_stream
{
public:
    using ptr = std::unique_ptr<write_stream>;
    virtual ~write_stream() = default;
    virtual std::error_condition finalize() noexcept = 0;
    virtual std::error_condition flush() noexcept = 0;
    virtual std::error_condition write_some(void const *buffer, std::size_t length, std::size_t &actual) noexcept = 0;
};

class read_write_stream : public virtual read_stream, public virtual write_stream
{
public:
    using ptr = std::unique_ptr<read_write_stream>;
};

class random_access
{
public:
    virtual ~random_access() = default;
    virtual std::error_condition seek(std::int64_t offset, int whence) noexcept = 0;
    virtual std::error_condition tell(std::uint64_t &result) noexcept = 0;
    virtual std::error_condition length(std::uint64_t &result) noexcept = 0;
};

class random_read : public virtual read_stream, public virtual random_access
{
public:
    using ptr = std::unique_ptr<random_read>;
    virtual std::error_condition read_some_at(std::uint64_t offset, void *buffer, std::size_t length, std::size_t &actual) noexcept = 0;
};

class random_write : public virtual write_stream, public virtual random_access
{
public:
    using ptr = std::unique_ptr<random_write>;
    virtual std::error_condition write_some_at(std::uint64_t offset, void const *buffer, std::size_t length, std::size_t &actual) noexcept = 0;
};

class random_read_write : public read_write_stream, public virtual random_read, public virtual random_write
{
public:
    using ptr = std::unique_ptr<random_read_write>;
};

std::pair<std::error_condition, std::size_t> read(read_stream &stream, void *buffer, std::size_t length) noexcept;
std::pair<std::error_condition, std::size_t> write(write_stream &stream, void const *buffer, std::size_t length) noexcept;

} // namespace util

#endif
