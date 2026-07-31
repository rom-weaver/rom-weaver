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
#define RW_LZMA_ERR_THREAD	5
#define RW_LZMA_ERR_LIMIT	6
/* Anything at or above this is the SDK's own SRes plus this base, so an
 * unexpected coder failure keeps its own identity in the error message. */
#define RW_LZMA_ERR_SRES_BASE	100

/* --- Decode ---------------------------------------------------------- */

typedef struct rw_lzma_dec rw_lzma_dec;

/* Implemented in Rust. A zero limit leaves decoder allocations unrestricted. */
uint64_t rw_lzma_dec_memlimit(void);
/* Shared by every live SDK and liblzma decoder. */
int rw_lzma_dec_reserve(uint64_t bytes);
void rw_lzma_dec_release(uint64_t bytes);

/*
 * lzma2 != 0 selects LZMA2 (props is the single dictionary-size byte);
 * otherwise LZMA1 (props is the 5-byte header). Returns NULL on allocation
 * failure or malformed properties.
 */
rw_lzma_dec *rw_lzma_dec_new(int lzma2, const uint8_t *props,
    size_t props_size, int *error);
void rw_lzma_dec_free(rw_lzma_dec *dec);

/*
 * Streaming push decode. *dest_len / *src_len are in/out byte counts, as in
 * the SDK's own *_DecodeToBuf. *finished is set when the stream's end marker
 * was reached. Returns one of the RW_LZMA_* codes.
 */
int rw_lzma_dec_run(rw_lzma_dec *dec, uint8_t *dest, size_t *dest_len,
    const uint8_t *src, size_t *src_len, int *finished);

/* --- Encode ---------------------------------------------------------- */

/*
 * Only present when the SDK was built with its thread layer; the encoder shim
 * runs the SDK's blocking coder on a thread of its own. libarchive gates its
 * calls on ROM_WEAVER_7Z_SDK_LZMA2_ENCODER, which build.rs defines under the same
 * condition.
 */

typedef struct rw_lzma2_enc rw_lzma2_enc;

/*
 * LZMA2 encoder with the SDK's own block multithreading - the same coder and
 * the same thread split 7zz runs.
 *
 * level     1..9.
 * threads   total encoder threads; the SDK splits them into block threads x
 *           per-block match-finder threads exactly as 7zz does.
 * dict_size 0 to take the SDK's per-level default, otherwise an explicit
 *           dictionary size (the wasm dictionary cap uses this).
 * size_hint uncompressed size when known, 0 when not; the SDK reduces the
 *           dictionary and the block count to fit it.
 *
 * The encoder runs on its own thread; rw_lzma2_enc_code is a push/pull shim
 * over the SDK's blocking stream-callback API. Returns NULL when it cannot
 * start - most often because the host has no thread to spare - which the caller
 * is expected to treat as "use the other encoder", not as an error.
 */
rw_lzma2_enc *rw_lzma2_enc_new(int level, int threads, uint32_t dict_size,
    uint64_t size_hint);
void rw_lzma2_enc_free(rw_lzma2_enc *enc);

/* The single LZMA2 properties byte for the 7z coder record. */
uint8_t rw_lzma2_enc_props(const rw_lzma2_enc *enc);

/*
 * Streaming push encode, shaped like libarchive's la_zstream contract:
 * consumes from in, writes to out, and sets *done once the complete stream -
 * end marker included - has been written. finish != 0 means no more input
 * follows what this call supplies.
 */
int rw_lzma2_enc_code(rw_lzma2_enc *enc, const uint8_t *in, size_t *in_len,
    uint8_t *out, size_t *out_len, int finish, int *done);

/* Input bytes the encoder has consumed so far, for progress reporting. */
uint64_t rw_lzma2_enc_consumed(rw_lzma2_enc *enc);

#ifdef __cplusplus
}
#endif

#endif /* ROM_WEAVER_LZMA_SDK_H */
