#include "chdcodec.h"

#include "chd.h"
#include "huffman.h"
#include "lzma/C/LzmaDec.h"
#include "lzma/C/LzmaEnc.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <new>
#include <zlib.h>
#include <zstd.h>

namespace {

class chd_zlib_compressor : public chd_compressor
{
public:
    chd_zlib_compressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_compressor(chd, hunkbytes, lossy)
    {
        m_stream.zalloc = Z_NULL;
        m_stream.zfree = Z_NULL;
        m_stream.opaque = Z_NULL;
        int rc = deflateInit2(
            &m_stream,
            Z_BEST_COMPRESSION,
            Z_DEFLATED,
            -MAX_WBITS,
            8,
            Z_DEFAULT_STRATEGY
        );
        if (rc == Z_MEM_ERROR) {
            throw std::bad_alloc();
        }
        if (rc != Z_OK) {
            throw std::error_condition(chd_file::error::CODEC_ERROR);
        }
    }

    ~chd_zlib_compressor() override
    {
        deflateEnd(&m_stream);
    }

    uint32_t compress(uint8_t const *src, uint32_t srclen, uint8_t *dest) override
    {
        m_stream.next_in = const_cast<Bytef *>(src);
        m_stream.avail_in = srclen;
        m_stream.total_in = 0;
        m_stream.next_out = dest;
        m_stream.avail_out = srclen;
        m_stream.total_out = 0;
        if (deflateReset(&m_stream) != Z_OK) {
            throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
        }
        int rc = deflate(&m_stream, Z_FINISH);
        if (rc != Z_STREAM_END || m_stream.total_out >= srclen) {
            throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
        }
        return static_cast<uint32_t>(m_stream.total_out);
    }

private:
    z_stream m_stream{};
};

class chd_zlib_decompressor : public chd_decompressor
{
public:
    chd_zlib_decompressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_decompressor(chd, hunkbytes, lossy)
    {
        m_stream.zalloc = Z_NULL;
        m_stream.zfree = Z_NULL;
        m_stream.opaque = Z_NULL;
        int rc = inflateInit2(&m_stream, -MAX_WBITS);
        if (rc == Z_MEM_ERROR) {
            throw std::bad_alloc();
        }
        if (rc != Z_OK) {
            throw std::error_condition(chd_file::error::CODEC_ERROR);
        }
    }

    ~chd_zlib_decompressor() override
    {
        inflateEnd(&m_stream);
    }

    void decompress(uint8_t const *src, uint32_t complen, uint8_t *dest, uint32_t destlen) override
    {
        m_stream.next_in = const_cast<Bytef *>(src);
        m_stream.avail_in = complen;
        m_stream.total_in = 0;
        m_stream.next_out = dest;
        m_stream.avail_out = destlen;
        m_stream.total_out = 0;
        if (inflateReset(&m_stream) != Z_OK) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
        int rc = inflate(&m_stream, Z_FINISH);
        if (rc != Z_STREAM_END || m_stream.total_out != destlen) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
    }

private:
    z_stream m_stream{};
};

class chd_zstd_compressor : public chd_compressor
{
public:
    chd_zstd_compressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_compressor(chd, hunkbytes, lossy), m_stream(ZSTD_createCStream())
    {
        if (!m_stream) {
            throw std::bad_alloc();
        }
    }

    ~chd_zstd_compressor() override
    {
        ZSTD_freeCStream(m_stream);
    }

    uint32_t compress(uint8_t const *src, uint32_t srclen, uint8_t *dest) override
    {
        size_t result = ZSTD_initCStream(m_stream, ZSTD_maxCLevel());
        if (ZSTD_isError(result)) {
            throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
        }

        ZSTD_inBuffer input{src, srclen, 0};
        ZSTD_outBuffer output{dest, srclen, 0};
        while (output.pos < output.size) {
            result = ZSTD_compressStream2(m_stream, &output, &input, ZSTD_e_end);
            if (ZSTD_isError(result)) {
                throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
            }
            if (!result) {
                break;
            }
        }

        if (input.pos != input.size || output.pos >= output.size) {
            throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
        }
        return static_cast<uint32_t>(output.pos);
    }

private:
    ZSTD_CStream *m_stream;
};

class chd_zstd_decompressor : public chd_decompressor
{
public:
    chd_zstd_decompressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_decompressor(chd, hunkbytes, lossy), m_stream(ZSTD_createDStream())
    {
        if (!m_stream) {
            throw std::bad_alloc();
        }
    }

    ~chd_zstd_decompressor() override
    {
        ZSTD_freeDStream(m_stream);
    }

    void decompress(uint8_t const *src, uint32_t complen, uint8_t *dest, uint32_t destlen) override
    {
        size_t result = ZSTD_initDStream(m_stream);
        if (ZSTD_isError(result)) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }

        ZSTD_inBuffer input{src, complen, 0};
        ZSTD_outBuffer output{dest, destlen, 0};
        while ((input.pos < input.size) && (output.pos < output.size)) {
            result = ZSTD_decompressStream(m_stream, &output, &input);
            if (ZSTD_isError(result)) {
                throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
            }
        }

        if (input.pos != input.size || output.pos != output.size) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
    }

private:
    ZSTD_DStream *m_stream;
};

class chd_lzma_allocator : public ISzAlloc
{
public:
    chd_lzma_allocator()
    {
        std::memset(m_allocptr.data(), 0, sizeof(m_allocptr));
        Alloc = &chd_lzma_allocator::fast_alloc;
        Free = &chd_lzma_allocator::fast_free;
    }

    ~chd_lzma_allocator()
    {
        for (auto &elem : m_allocptr) {
            delete[] elem;
        }
    }

private:
    static constexpr int MAX_LZMA_ALLOCS = 64;

    static void *fast_alloc(ISzAllocPtr p, size_t size)
    {
        auto *codec = static_cast<chd_lzma_allocator *>(const_cast<ISzAlloc *>(p));
        size = (size + 0x3ff) & ~0x3ff;

        for (int scan = 0; scan < MAX_LZMA_ALLOCS; ++scan) {
            uint32_t *ptr = codec->m_allocptr[scan];
            if (ptr != nullptr && size == *ptr) {
                *ptr |= 1;
                return ptr + 1;
            }
        }

        auto *ptr = reinterpret_cast<uint32_t *>(new uint8_t[size + sizeof(uint32_t)]);
        for (int scan = 0; scan < MAX_LZMA_ALLOCS; ++scan) {
            if (codec->m_allocptr[scan] == nullptr) {
                codec->m_allocptr[scan] = ptr;
                break;
            }
        }

        *ptr = static_cast<uint32_t>(size) | 1U;
        return ptr + 1;
    }

    static void fast_free(ISzAllocPtr p, void *address)
    {
        if (address == nullptr) {
            return;
        }

        auto *codec = static_cast<chd_lzma_allocator *>(const_cast<ISzAlloc *>(p));
        uint32_t *ptr = reinterpret_cast<uint32_t *>(address) - 1;
        for (int scan = 0; scan < MAX_LZMA_ALLOCS; ++scan) {
            if (ptr == codec->m_allocptr[scan]) {
                *ptr &= ~1U;
                return;
            }
        }
    }

    std::array<uint32_t *, MAX_LZMA_ALLOCS> m_allocptr;
};

class chd_lzma_compressor : public chd_compressor
{
public:
    chd_lzma_compressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_compressor(chd, hunkbytes, lossy)
    {
        configure_properties(m_props, hunkbytes);
    }

    ~chd_lzma_compressor() override = default;

    uint32_t compress(uint8_t const *src, uint32_t srclen, uint8_t *dest) override
    {
        CLzmaEncHandle encoder = LzmaEnc_Create(&m_allocator);
        if (encoder == nullptr) {
            throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
        }

        try {
            if (LzmaEnc_SetProps(encoder, &m_props) != SZ_OK) {
                throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
            }

            SizeT complen = srclen;
            SRes res = LzmaEnc_MemEncode(
                encoder,
                dest,
                &complen,
                src,
                srclen,
                0,
                nullptr,
                &m_allocator,
                &m_allocator
            );
            if (res != SZ_OK) {
                throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
            }

            LzmaEnc_Destroy(encoder, &m_allocator, &m_allocator);
            return static_cast<uint32_t>(complen);
        } catch (...) {
            LzmaEnc_Destroy(encoder, &m_allocator, &m_allocator);
            throw;
        }
    }

    static void configure_properties(CLzmaEncProps &props, uint32_t hunkbytes)
    {
        LzmaEncProps_Init(&props);
        props.level = 8;
        props.reduceSize = hunkbytes;
        props.numThreads = 1;
        LzmaEncProps_Normalize(&props);
    }

private:
    CLzmaEncProps m_props{};
    chd_lzma_allocator m_allocator;
};

class chd_lzma_decompressor : public chd_decompressor
{
public:
    chd_lzma_decompressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_decompressor(chd, hunkbytes, lossy)
    {
        LzmaDec_Construct(&m_decoder);

        CLzmaEncProps encoder_props;
        chd_lzma_compressor::configure_properties(encoder_props, hunkbytes);

        CLzmaEncHandle enc = LzmaEnc_Create(&m_allocator);
        if (!enc) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
        if (LzmaEnc_SetProps(enc, &encoder_props) != SZ_OK) {
            LzmaEnc_Destroy(enc, &m_allocator, &m_allocator);
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }

        Byte decoder_props[LZMA_PROPS_SIZE];
        SizeT props_size = sizeof(decoder_props);
        if (LzmaEnc_WriteProperties(enc, decoder_props, &props_size) != SZ_OK) {
            LzmaEnc_Destroy(enc, &m_allocator, &m_allocator);
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
        LzmaEnc_Destroy(enc, &m_allocator, &m_allocator);

        if (LzmaDec_Allocate(&m_decoder, decoder_props, LZMA_PROPS_SIZE, &m_allocator) != SZ_OK) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
    }

    ~chd_lzma_decompressor() override
    {
        LzmaDec_Free(&m_decoder, &m_allocator);
    }

    void decompress(uint8_t const *src, uint32_t complen, uint8_t *dest, uint32_t destlen) override
    {
        LzmaDec_Init(&m_decoder);

        SizeT consumedlen = complen;
        SizeT decodedlen = destlen;
        ELzmaStatus status = LZMA_STATUS_NOT_SPECIFIED;
        SRes res = LzmaDec_DecodeToBuf(
            &m_decoder,
            dest,
            &decodedlen,
            src,
            &consumedlen,
            LZMA_FINISH_END,
            &status
        );
        if (res != SZ_OK || consumedlen != complen || decodedlen != destlen) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
        if (status != LZMA_STATUS_FINISHED_WITH_MARK &&
            status != LZMA_STATUS_MAYBE_FINISHED_WITHOUT_MARK) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
    }

private:
    CLzmaDec m_decoder{};
    chd_lzma_allocator m_allocator;
};

class chd_huffman_compressor : public chd_compressor
{
public:
    chd_huffman_compressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_compressor(chd, hunkbytes, lossy)
    {
    }

    uint32_t compress(uint8_t const *src, uint32_t srclen, uint8_t *dest) override
    {
        uint32_t complen = 0;
        if (m_encoder.encode(src, srclen, dest, srclen, complen) != HUFFERR_NONE) {
            throw std::error_condition(chd_file::error::COMPRESSION_ERROR);
        }
        return complen;
    }

private:
    huffman_8bit_encoder m_encoder;
};

class chd_huffman_decompressor : public chd_decompressor
{
public:
    chd_huffman_decompressor(chd_file &chd, uint32_t hunkbytes, bool lossy)
        : chd_decompressor(chd, hunkbytes, lossy)
    {
    }

    void decompress(uint8_t const *src, uint32_t complen, uint8_t *dest, uint32_t destlen) override
    {
        if (m_decoder.decode(src, complen, dest, destlen) != HUFFERR_NONE) {
            throw std::error_condition(chd_file::error::DECOMPRESSION_ERROR);
        }
    }

private:
    huffman_8bit_decoder m_decoder;
};

struct codec_entry
{
    chd_codec_type type;
    bool lossy;
    char const *name;
    chd_compressor::ptr (*make_compressor)(chd_file &);
    chd_decompressor::ptr (*make_decompressor)(chd_file &);
};

template <typename Compressor>
chd_compressor::ptr make_compressor(chd_file &chd)
{
    return std::make_unique<Compressor>(chd, chd.hunk_bytes(), false);
}

template <typename Decompressor>
chd_decompressor::ptr make_decompressor(chd_file &chd)
{
    return std::make_unique<Decompressor>(chd, chd.hunk_bytes(), false);
}

codec_entry const *find_codec(chd_codec_type type) noexcept
{
    static constexpr codec_entry codecs[] = {
        {CHD_CODEC_ZLIB, false, "Deflate", &make_compressor<chd_zlib_compressor>, &make_decompressor<chd_zlib_decompressor>},
        {CHD_CODEC_ZSTD, false, "Zstandard", &make_compressor<chd_zstd_compressor>, &make_decompressor<chd_zstd_decompressor>},
        {CHD_CODEC_LZMA, false, "LZMA", &make_compressor<chd_lzma_compressor>, &make_decompressor<chd_lzma_decompressor>},
        {CHD_CODEC_HUFFMAN, false, "Huffman", &make_compressor<chd_huffman_compressor>, &make_decompressor<chd_huffman_decompressor>},
    };

    auto const iter = std::find_if(
        std::begin(codecs),
        std::end(codecs),
        [type](codec_entry const &entry) { return entry.type == type; }
    );
    return (iter == std::end(codecs)) ? nullptr : iter;
}

} // namespace

chd_codec::chd_codec(chd_file &file, uint32_t hunkbytes, bool lossy)
    : m_chd(file), m_hunkbytes(hunkbytes), m_lossy(lossy)
{
}

chd_codec::~chd_codec() = default;

void chd_codec::configure(int, void *)
{
}

chd_compressor::chd_compressor(chd_file &file, uint32_t hunkbytes, bool lossy)
    : chd_codec(file, hunkbytes, lossy)
{
}

chd_decompressor::chd_decompressor(chd_file &file, uint32_t hunkbytes, bool lossy)
    : chd_codec(file, hunkbytes, lossy)
{
}

void chd_decompressor::process(uint8_t const *, uint32_t)
{
}

chd_compressor::ptr chd_codec_list::new_compressor(chd_codec_type type, chd_file &file)
{
    codec_entry const *entry = find_codec(type);
    return entry ? entry->make_compressor(file) : nullptr;
}

chd_decompressor::ptr chd_codec_list::new_decompressor(chd_codec_type type, chd_file &file)
{
    codec_entry const *entry = find_codec(type);
    return entry ? entry->make_decompressor(file) : nullptr;
}

bool chd_codec_list::codec_exists(chd_codec_type type) noexcept
{
    return find_codec(type) != nullptr;
}

char const *chd_codec_list::codec_name(chd_codec_type type) noexcept
{
    if (type == CHD_CODEC_NONE) {
        return "Uncompressed";
    }
    codec_entry const *entry = find_codec(type);
    return entry ? entry->name : nullptr;
}

chd_compressor_group::chd_compressor_group(chd_file &file, chd_codec_type compressor_list[4])
    : m_hunkbytes(file.hunk_bytes()), m_compress_test(m_hunkbytes)
{
    for (int codecnum = 0; codecnum < std::size(m_compressor); ++codecnum) {
        if (compressor_list[codecnum] == CHD_CODEC_NONE) {
            continue;
        }
        m_compressor[codecnum] = chd_codec_list::new_compressor(compressor_list[codecnum], file);
        if (!m_compressor[codecnum]) {
            throw std::error_condition(chd_file::error::UNKNOWN_COMPRESSION);
        }
    }
}

chd_compressor_group::~chd_compressor_group() = default;

int8_t chd_compressor_group::find_best_compressor(uint8_t const *src, uint8_t *compressed, uint32_t &complen)
{
    complen = m_hunkbytes;
    int8_t compression = -1;
    for (int codecnum = 0; codecnum < std::size(m_compressor); ++codecnum) {
        if (!m_compressor[codecnum]) {
            continue;
        }
        try {
            uint32_t compbytes =
                m_compressor[codecnum]->compress(src, m_hunkbytes, m_compress_test.data());
            if (compbytes < complen) {
                std::copy_n(m_compress_test.data(), compbytes, compressed);
                complen = compbytes;
                compression = static_cast<int8_t>(codecnum);
            }
        } catch (...) {
        }
    }
    return compression;
}
