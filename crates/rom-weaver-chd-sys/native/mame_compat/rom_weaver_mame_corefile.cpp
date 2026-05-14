#include "corefile.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>

#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

namespace util {
namespace {

class local_core_file final : public core_file
{
public:
    explicit local_core_file(std::FILE *file, bool readable, bool writable) noexcept
        : m_file(file), m_readable(readable), m_writable(writable)
    {
    }

    ~local_core_file() override
    {
        if (m_file)
            std::fclose(m_file);
    }

    std::error_condition finalize() noexcept override
    {
        return flush();
    }

    std::error_condition flush() noexcept override
    {
        if (!m_file || !m_writable)
            return std::error_condition();
        if (std::fflush(m_file) == 0)
            return std::error_condition();
        return std::error_condition(errno, std::generic_category());
    }

    std::error_condition read_some(void *buffer, std::size_t length, std::size_t &actual) noexcept override
    {
        actual = 0;
        if (!m_file || !m_readable)
            return std::errc::bad_file_descriptor;
        actual = std::fread(buffer, 1, length, m_file);
        if (actual < length && std::ferror(m_file))
        {
            std::clearerr(m_file);
            return std::error_condition(errno ? errno : EIO, std::generic_category());
        }
        return std::error_condition();
    }

    std::error_condition write_some(void const *buffer, std::size_t length, std::size_t &actual) noexcept override
    {
        actual = 0;
        if (!m_file || !m_writable)
            return std::errc::bad_file_descriptor;
        actual = std::fwrite(buffer, 1, length, m_file);
        if (actual < length && std::ferror(m_file))
        {
            std::clearerr(m_file);
            return std::error_condition(errno ? errno : EIO, std::generic_category());
        }
        return std::error_condition();
    }

    std::error_condition seek(std::int64_t offset, int whence) noexcept override
    {
        if (!m_file)
            return std::errc::bad_file_descriptor;
#if defined(_WIN32)
        if (_fseeki64(m_file, offset, whence) == 0)
            return std::error_condition();
#else
        if (fseeko(m_file, offset, whence) == 0)
            return std::error_condition();
#endif
        return std::error_condition(errno, std::generic_category());
    }

    std::error_condition tell(std::uint64_t &result) noexcept override
    {
        if (!m_file)
            return std::errc::bad_file_descriptor;
#if defined(_WIN32)
        auto const pos = _ftelli64(m_file);
#else
        auto const pos = ftello(m_file);
#endif
        if (pos < 0)
            return std::error_condition(errno, std::generic_category());
        result = static_cast<std::uint64_t>(pos);
        return std::error_condition();
    }

    std::error_condition length(std::uint64_t &result) noexcept override
    {
        if (!m_file)
            return std::errc::bad_file_descriptor;

        std::uint64_t current = 0;
        if (auto err = tell(current))
            return err;
        if (auto err = seek(0, SEEK_END))
            return err;
        auto err = tell(result);
        if (auto restore = seek(static_cast<std::int64_t>(current), SEEK_SET); !err && restore)
            err = restore;
        return err;
    }

    std::error_condition read_some_at(std::uint64_t offset, void *buffer, std::size_t length, std::size_t &actual) noexcept override
    {
        if (auto err = seek(static_cast<std::int64_t>(offset), SEEK_SET))
        {
            actual = 0;
            return err;
        }
        return read_some(buffer, length, actual);
    }

    std::error_condition write_some_at(std::uint64_t offset, void const *buffer, std::size_t length, std::size_t &actual) noexcept override
    {
        if (auto err = seek(static_cast<std::int64_t>(offset), SEEK_SET))
        {
            actual = 0;
            return err;
        }
        return write_some(buffer, length, actual);
    }

private:
    std::FILE *m_file;
    bool m_readable;
    bool m_writable;
};

} // namespace

std::error_condition core_file::open(std::string_view filename, std::uint32_t openflags, ptr &file) noexcept
{
    file.reset();

    char const *mode = nullptr;
    if (openflags & OPEN_FLAG_CREATE)
        mode = "w+b";
    else if (openflags & OPEN_FLAG_WRITE)
        mode = (openflags & OPEN_FLAG_READ) ? "r+b" : "r+b";
    else
        mode = "rb";

    std::FILE *raw = std::fopen(std::string(filename).c_str(), mode);
    if (!raw)
        return std::error_condition(errno, std::generic_category());

    file.reset(new local_core_file(raw, 0U != (openflags & OPEN_FLAG_READ), 0U != (openflags & OPEN_FLAG_WRITE)));
    return std::error_condition();
}

} // namespace util
