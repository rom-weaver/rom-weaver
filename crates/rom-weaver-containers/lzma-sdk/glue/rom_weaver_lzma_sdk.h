/*
 * Opaque C surface over the vendored 7-Zip LZMA SDK.
 *
 * libarchive carries its own copy of parts of the SDK (archive_ppmd_private.h
 * defines IByteIn / IByteOut with the same names but different layouts), so
 * including the SDK's 7zTypes.h anywhere inside libarchive is a hard
 * redefinition error. Everything SDK-typed therefore lives behind this header:
 * libarchive sees plain C types only, and the SDK headers are included solely
 * by rom_weaver_lzma_sdk.c, which is compiled into the separate lzma_sdk
 * static library.
 *
 * This file is rom-weaver's own code, not part of the vendored SDK drop.
 */

#ifndef ROM_WEAVER_LZMA_SDK_H
#define ROM_WEAVER_LZMA_SDK_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RW_LZMA_OK		0
#define RW_LZMA_ERR_MEM		1
#define RW_LZMA_ERR_PROPS	2
#define RW_LZMA_ERR_DATA	3
#define RW_LZMA_ERR_PARAM	4

/* --- Decode ---------------------------------------------------------- */

typedef struct rw_lzma_dec rw_lzma_dec;

/*
 * lzma2 != 0 selects LZMA2 (props is the single dictionary-size byte);
 * otherwise LZMA1 (props is the 5-byte header). Returns NULL on allocation
 * failure or malformed properties.
 */
rw_lzma_dec *rw_lzma_dec_new(int lzma2, const uint8_t *props, size_t props_size);
void rw_lzma_dec_free(rw_lzma_dec *dec);

/*
 * Streaming push decode. *dest_len / *src_len are in/out byte counts, as in
 * the SDK's own *_DecodeToBuf. *finished is set when the stream's end marker
 * was reached. Returns one of the RW_LZMA_* codes.
 */
int rw_lzma_dec_run(rw_lzma_dec *dec, uint8_t *dest, size_t *dest_len,
    const uint8_t *src, size_t *src_len, int *finished);

#ifdef __cplusplus
}
#endif

#endif /* ROM_WEAVER_LZMA_SDK_H */
