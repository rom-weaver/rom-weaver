#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "chd.h"

#include <algorithm>
#include <memory>
#include <new>
#include <string>
#include <system_error>
#include <vector>

namespace {

extern "C" void rw_mame_chd_set_compression_level(int level);

struct rw_mame_chd_handle {
    chd_file file;
    std::unique_ptr<chd_file> parent;
};

class rw_chd_level_scope {
public:
    explicit rw_chd_level_scope(int level)
    {
        rw_mame_chd_set_compression_level(level);
    }

    ~rw_chd_level_scope()
    {
        rw_mame_chd_set_compression_level(0);
    }
};

class rw_path_compressor : public chd_file_compressor {
public:
    rw_path_compressor(FILE *input, uint64_t input_size)
        : m_input(input), m_input_size(input_size) {
    }

protected:
    uint32_t read_data(void *dest, uint64_t offset, uint32_t length) override {
        if (!m_input) {
            throw std::error_condition(std::errc::bad_file_descriptor);
        }
        if (offset > m_input_size) {
            throw std::error_condition(std::errc::invalid_argument);
        }
        if (fseeko(m_input, static_cast<off_t>(offset), SEEK_SET) != 0) {
            throw std::error_condition(errno, std::generic_category());
        }

        uint64_t available = m_input_size - offset;
        uint32_t bytes_to_read = static_cast<uint32_t>(std::min<uint64_t>(available, length));
        size_t actual = fread(dest, 1, bytes_to_read, m_input);
        if (actual != bytes_to_read) {
            throw std::error_condition(errno ? errno : EIO, std::generic_category());
        }
        return static_cast<uint32_t>(actual);
    }

private:
    FILE *m_input;
    uint64_t m_input_size;
};

struct rw_mame_chd_header {
    uint32_t version;
    uint64_t logical_bytes;
    uint32_t hunk_bytes;
    uint32_t hunk_count;
    uint32_t unit_bytes;
    uint64_t unit_count;
    uint8_t compressed;
    uint8_t reserved[3];
    uint32_t compression[4];
};

static constexpr int32_t RW_MAME_CHD_OK = 0;
static constexpr int32_t RW_MAME_CHD_ERR_BUFFER_TOO_SMALL = -1;
static constexpr int32_t RW_MAME_CHD_ERR_INVALID_ARGUMENT = -2;
static constexpr int32_t RW_MAME_CHD_ERR_ALLOC = -3;
static constexpr int32_t RW_MAME_CHD_ERR_NATIVE = -4;

enum rw_mame_chd_media_kind : uint32_t {
    RW_MAME_CHD_MEDIA_RAW = 0,
    RW_MAME_CHD_MEDIA_HARD_DISK = 1,
    RW_MAME_CHD_MEDIA_CDROM = 2,
    RW_MAME_CHD_MEDIA_GDROM = 3,
    RW_MAME_CHD_MEDIA_DVD = 4,
    RW_MAME_CHD_MEDIA_AV = 5,
};

void rw_mame_chd_copy_error(char *error, size_t error_len, char const *message) {
    if ((error == nullptr) || (error_len == 0)) {
        return;
    }

    char const *value = message ? message : "";
    size_t copy_len = 0;
    while ((copy_len + 1) < error_len && value[copy_len] != '\0') {
        error[copy_len] = value[copy_len];
        ++copy_len;
    }
    error[copy_len] = '\0';
}

int32_t rw_mame_chd_fail(char *error, size_t error_len, int32_t code, char const *message) {
    rw_mame_chd_copy_error(error, error_len, message);
    return code;
}

int32_t rw_mame_chd_fail(char *error, size_t error_len, int32_t code, std::error_condition const &condition) {
    return rw_mame_chd_fail(error, error_len, code, condition.message().c_str());
}

int32_t rw_mame_chd_fill_header(chd_file const &file, rw_mame_chd_header *header, char *error, size_t error_len);

int32_t rw_mame_chd_fill_header(rw_mame_chd_handle *handle, rw_mame_chd_header *header, char *error, size_t error_len) {
    if (handle == nullptr || header == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "header query requires a valid CHD handle and destination header"
        );
    }

    return rw_mame_chd_fill_header(handle->file, header, error, error_len);
}

int32_t rw_mame_chd_fill_header(chd_file const &file, rw_mame_chd_header *header, char *error, size_t error_len) {
    if (header == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "header query requires a destination header"
        );
    }

    header->version = file.version();
    header->logical_bytes = file.logical_bytes();
    header->hunk_bytes = file.hunk_bytes();
    header->hunk_count = file.hunk_count();
    header->unit_bytes = file.unit_bytes();
    header->unit_count = file.unit_count();
    header->compressed = file.compressed() ? 1U : 0U;
    header->reserved[0] = 0;
    header->reserved[1] = 0;
    header->reserved[2] = 0;
    for (size_t index = 0; index < 4; ++index) {
        header->compression[index] = file.compression(static_cast<int>(index));
    }
    return RW_MAME_CHD_OK;
}

int32_t rw_mame_chd_fill_media_kind(
    chd_file const &file,
    uint32_t *media_kind,
    char *error,
    size_t error_len
) {
    if (media_kind == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "media kind query requires a destination kind"
        );
    }

    std::error_condition condition = file.check_is_hd();
    if (!condition) {
        *media_kind = RW_MAME_CHD_MEDIA_HARD_DISK;
        rw_mame_chd_copy_error(error, error_len, "");
        return RW_MAME_CHD_OK;
    }
    if (condition != chd_file::error::METADATA_NOT_FOUND) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    condition = file.check_is_gd();
    if (!condition) {
        *media_kind = RW_MAME_CHD_MEDIA_GDROM;
        rw_mame_chd_copy_error(error, error_len, "");
        return RW_MAME_CHD_OK;
    }
    if (condition != chd_file::error::METADATA_NOT_FOUND) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    condition = file.check_is_cd();
    if (!condition) {
        *media_kind = RW_MAME_CHD_MEDIA_CDROM;
        rw_mame_chd_copy_error(error, error_len, "");
        return RW_MAME_CHD_OK;
    }
    if (condition != chd_file::error::METADATA_NOT_FOUND) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    condition = file.check_is_dvd();
    if (!condition) {
        *media_kind = RW_MAME_CHD_MEDIA_DVD;
        rw_mame_chd_copy_error(error, error_len, "");
        return RW_MAME_CHD_OK;
    }
    if (condition != chd_file::error::METADATA_NOT_FOUND) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    condition = file.check_is_av();
    if (!condition) {
        *media_kind = RW_MAME_CHD_MEDIA_AV;
        rw_mame_chd_copy_error(error, error_len, "");
        return RW_MAME_CHD_OK;
    }
    if (condition != chd_file::error::METADATA_NOT_FOUND) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    *media_kind = RW_MAME_CHD_MEDIA_RAW;
    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

int32_t rw_mame_chd_open_parent(
    char const *parent_path,
    std::unique_ptr<chd_file> &parent,
    char *error,
    size_t error_len
) {
    if (parent_path == nullptr || parent_path[0] == '\0') {
        return RW_MAME_CHD_OK;
    }

    std::unique_ptr<chd_file> opened = std::make_unique<chd_file>();
    std::error_condition condition = opened->open(parent_path, false, nullptr, nullptr);
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    parent = std::move(opened);
    return RW_MAME_CHD_OK;
}

bool rw_mame_chd_is_uncompressed(uint32_t const *compression) {
    return compression[0] == CHD_CODEC_NONE && compression[1] == CHD_CODEC_NONE &&
        compression[2] == CHD_CODEC_NONE && compression[3] == CHD_CODEC_NONE;
}

std::error_condition rw_mame_chd_run_compression(
    rw_path_compressor &compressor,
    double &progress,
    double &ratio
) {
    for (;;) {
        std::error_condition condition = compressor.compress_continue(progress, ratio);
        if (!condition) {
            return std::error_condition();
        }
        if (condition != chd_file::error::COMPRESSING && condition != chd_file::error::WALKING_PARENT) {
            return condition;
        }
    }
}

} // namespace

extern "C" {

uint8_t rw_mame_chd_backend_available(void) { return 1U; }

char const *rw_mame_chd_backend_name(void) { return "embedded-zlib-zstd-lzma-huffman-flac-avhuff"; }

int32_t rw_mame_chd_open(
    char const *path,
    char const *parent_path,
    uint8_t writeable,
    void **out_handle,
    rw_mame_chd_header *out_header,
    char *error,
    size_t error_len
) {
    if (path == nullptr || out_handle == nullptr || out_header == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "open requires a path, output handle, and output header"
        );
    }

    *out_handle = nullptr;
    std::unique_ptr<rw_mame_chd_handle> handle(new (std::nothrow) rw_mame_chd_handle());
    if (!handle) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_ALLOC, "failed to allocate MAME CHD handle");
    }

    int32_t status = rw_mame_chd_open_parent(parent_path, handle->parent, error, error_len);
    if (status != RW_MAME_CHD_OK) {
        return status;
    }

    std::error_condition condition = handle->file.open(path, writeable != 0U, handle->parent.get(), nullptr);
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    status = rw_mame_chd_fill_header(handle.get(), out_header, error, error_len);
    if (status != RW_MAME_CHD_OK) {
        return status;
    }

    *out_handle = handle.release();
    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

int32_t rw_mame_chd_create(
    char const *path,
    char const *parent_path,
    uint64_t logical_bytes,
    uint32_t hunk_bytes,
    uint32_t unit_bytes,
    uint32_t const *compression,
    int32_t compression_level,
    void **out_handle,
    rw_mame_chd_header *out_header,
    char *error,
    size_t error_len
) {
    if (path == nullptr || compression == nullptr || out_handle == nullptr || out_header == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "create requires a path, compression list, output handle, and output header"
        );
    }
    if (hunk_bytes == 0) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_INVALID_ARGUMENT, "create requires a non-zero hunk size");
    }
    if (!rw_mame_chd_is_uncompressed(compression)) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "compressed CHD creation must use the high-level compress_file API"
        );
    }

    *out_handle = nullptr;
    std::unique_ptr<rw_mame_chd_handle> handle(new (std::nothrow) rw_mame_chd_handle());
    if (!handle) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_ALLOC, "failed to allocate MAME CHD handle");
    }

    int32_t status = rw_mame_chd_open_parent(parent_path, handle->parent, error, error_len);
    if (status != RW_MAME_CHD_OK) {
        return status;
    }

    chd_codec_type const codecs[4] = {
        compression[0],
        compression[1],
        compression[2],
        compression[3],
    };
    rw_chd_level_scope level_scope(compression_level);
    std::error_condition condition = handle->parent
        ? handle->file.create(path, logical_bytes, hunk_bytes, codecs, *handle->parent)
        : handle->file.create(path, logical_bytes, hunk_bytes, unit_bytes, codecs);
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    status = rw_mame_chd_fill_header(handle.get(), out_header, error, error_len);
    if (status != RW_MAME_CHD_OK) {
        return status;
    }

    *out_handle = handle.release();
    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

int32_t rw_mame_chd_compress_file(
    char const *input_path,
    char const *output_path,
    char const *parent_path,
    uint64_t logical_bytes,
    uint32_t hunk_bytes,
    uint32_t unit_bytes,
    uint32_t const *compression,
    int32_t compression_level,
    rw_mame_chd_header *out_header,
    char *error,
    size_t error_len
) {
    if (input_path == nullptr || output_path == nullptr || compression == nullptr || out_header == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "compress_file requires input path, output path, compression list, and output header"
        );
    }
    if (hunk_bytes == 0) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_INVALID_ARGUMENT, "compress_file requires a non-zero hunk size");
    }

    FILE *input = fopen(input_path, "rb");
    if (!input) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, std::error_condition(errno, std::generic_category()));
    }

    std::unique_ptr<chd_file> parent;
    int32_t status = rw_mame_chd_open_parent(parent_path, parent, error, error_len);
    if (status != RW_MAME_CHD_OK) {
        fclose(input);
        return status;
    }

    if (fseeko(input, 0, SEEK_END) != 0) {
        status = rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, std::error_condition(errno, std::generic_category()));
        fclose(input);
        return status;
    }
    off_t const file_size = ftello(input);
    if (file_size < 0) {
        status = rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, std::error_condition(errno, std::generic_category()));
        fclose(input);
        return status;
    }
    rewind(input);

    uint64_t const input_size = static_cast<uint64_t>(file_size);
    uint64_t const resolved_logical_bytes = logical_bytes ? logical_bytes : input_size;
    if (resolved_logical_bytes > input_size) {
        fclose(input);
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "logical_bytes exceeds the source file length"
        );
    }

    chd_codec_type const codecs[4] = {
        compression[0],
        compression[1],
        compression[2],
        compression[3],
    };

    rw_chd_level_scope level_scope(compression_level);
    rw_path_compressor compressor(input, resolved_logical_bytes);
    std::error_condition condition = parent
        ? compressor.create(output_path, resolved_logical_bytes, hunk_bytes, codecs, *parent)
        : compressor.create(output_path, resolved_logical_bytes, hunk_bytes, unit_bytes ? unit_bytes : 1U, codecs);
    if (condition) {
        fclose(input);
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    compressor.compress_begin();
    double progress = 0.0;
    double ratio = 1.0;
    condition = rw_mame_chd_run_compression(compressor, progress, ratio);
    fclose(input);
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    status = rw_mame_chd_fill_header(compressor, out_header, error, error_len);
    if (status != RW_MAME_CHD_OK) {
        return status;
    }

    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

void rw_mame_chd_close(void *handle) {
    delete static_cast<rw_mame_chd_handle *>(handle);
}

int32_t rw_mame_chd_media_kind(
    void *handle,
    uint32_t *media_kind,
    char *error,
    size_t error_len
) {
    auto *typed = static_cast<rw_mame_chd_handle *>(handle);
    if (typed == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "media kind query requires a valid CHD handle"
        );
    }

    return rw_mame_chd_fill_media_kind(typed->file, media_kind, error, error_len);
}

int32_t rw_mame_chd_refresh_header(void *handle, rw_mame_chd_header *out_header, char *error, size_t error_len) {
    return rw_mame_chd_fill_header(static_cast<rw_mame_chd_handle *>(handle), out_header, error, error_len);
}

int32_t rw_mame_chd_read_hunk(
    void *handle,
    uint32_t hunk_index,
    void *buffer,
    size_t buffer_len,
    char *error,
    size_t error_len
) {
    auto *typed = static_cast<rw_mame_chd_handle *>(handle);
    if (typed == nullptr || buffer == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "read_hunk requires a valid CHD handle and destination buffer"
        );
    }
    if (buffer_len < typed->file.hunk_bytes()) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "read_hunk buffer is smaller than the CHD hunk size"
        );
    }

    std::error_condition condition = typed->file.read_hunk(hunk_index, buffer);
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }
    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

int32_t rw_mame_chd_write_hunk(
    void *handle,
    uint32_t hunk_index,
    void const *buffer,
    size_t buffer_len,
    char *error,
    size_t error_len
) {
    auto *typed = static_cast<rw_mame_chd_handle *>(handle);
    if (typed == nullptr || buffer == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "write_hunk requires a valid CHD handle and source buffer"
        );
    }
    if (buffer_len < typed->file.hunk_bytes()) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "write_hunk buffer is smaller than the CHD hunk size"
        );
    }

    std::error_condition condition = typed->file.write_hunk(hunk_index, buffer);
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }
    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

int32_t rw_mame_chd_read_metadata(
    void *handle,
    uint32_t tag,
    uint32_t index,
    uint8_t *found,
    void *data,
    uint32_t *data_len,
    char *error,
    size_t error_len
) {
    auto *typed = static_cast<rw_mame_chd_handle *>(handle);
    if (typed == nullptr || found == nullptr || data_len == nullptr) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "read_metadata requires a valid CHD handle, found flag, and data length pointer"
        );
    }

    std::vector<uint8_t> metadata;
    std::error_condition condition = typed->file.read_metadata(tag, index, metadata);
    if (condition == chd_file::error::METADATA_NOT_FOUND) {
        *found = 0U;
        *data_len = 0U;
        rw_mame_chd_copy_error(error, error_len, "");
        return RW_MAME_CHD_OK;
    }
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }

    uint32_t required_len = static_cast<uint32_t>(metadata.size());
    if (data == nullptr || *data_len < required_len) {
        *found = 1U;
        *data_len = required_len;
        rw_mame_chd_copy_error(error, error_len, "");
        return RW_MAME_CHD_ERR_BUFFER_TOO_SMALL;
    }

    if (!metadata.empty()) {
        std::memcpy(data, metadata.data(), metadata.size());
    }
    *found = 1U;
    *data_len = required_len;
    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

int32_t rw_mame_chd_write_metadata(
    void *handle,
    uint32_t tag,
    uint32_t index,
    uint8_t flags,
    void const *data,
    uint32_t data_len,
    char *error,
    size_t error_len
) {
    auto *typed = static_cast<rw_mame_chd_handle *>(handle);
    if (typed == nullptr || (data == nullptr && data_len != 0U)) {
        return rw_mame_chd_fail(
            error,
            error_len,
            RW_MAME_CHD_ERR_INVALID_ARGUMENT,
            "write_metadata requires a valid CHD handle and consistent metadata buffer"
        );
    }

    std::error_condition condition = typed->file.write_metadata(tag, index, data, data_len, flags);
    if (condition) {
        return rw_mame_chd_fail(error, error_len, RW_MAME_CHD_ERR_NATIVE, condition);
    }
    rw_mame_chd_copy_error(error, error_len, "");
    return RW_MAME_CHD_OK;
}

} // extern "C"
