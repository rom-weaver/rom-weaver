/*
 * Implementation of the opaque LZMA SDK surface declared in
 * rom_weaver_lzma_sdk.h. This is the only translation unit outside the vendored
 * drop that includes the SDK headers.
 *
 * This file is rom-weaver's own code, not part of the vendored SDK drop.
 */

#include <stdlib.h>
#include <string.h>

#include "Lzma2Dec.h"
#include "LzmaDec.h"

#include "rom_weaver_lzma_sdk.h"

static void *
rw_sdk_alloc(ISzAllocPtr self, size_t size)
{
	(void)self;
	return malloc(size);
}

static void
rw_sdk_free(ISzAllocPtr self, void *address)
{
	(void)self;
	free(address);
}

static const ISzAlloc rw_sdk_allocator = { rw_sdk_alloc, rw_sdk_free };

struct rw_lzma_dec {
	int		is_lzma2;
	CLzmaDec	lzma1;
	CLzma2Dec	lzma2;
};

rw_lzma_dec *
rw_lzma_dec_new(int lzma2, const uint8_t *props, size_t props_size)
{
	rw_lzma_dec *dec;
	SRes res;

	if (props == NULL)
		return NULL;
	if (lzma2 ? props_size != 1 : props_size != LZMA_PROPS_SIZE)
		return NULL;

	dec = calloc(1, sizeof(*dec));
	if (dec == NULL)
		return NULL;
	dec->is_lzma2 = lzma2 ? 1 : 0;

	if (dec->is_lzma2) {
		Lzma2Dec_CONSTRUCT(&dec->lzma2);
		res = Lzma2Dec_Allocate(&dec->lzma2, (Byte)props[0],
		    &rw_sdk_allocator);
		if (res != SZ_OK) {
			free(dec);
			return NULL;
		}
		Lzma2Dec_Init(&dec->lzma2);
	} else {
		LzmaDec_CONSTRUCT(&dec->lzma1);
		res = LzmaDec_Allocate(&dec->lzma1, (const Byte *)props,
		    LZMA_PROPS_SIZE, &rw_sdk_allocator);
		if (res != SZ_OK) {
			free(dec);
			return NULL;
		}
		LzmaDec_Init(&dec->lzma1);
	}
	return dec;
}

void
rw_lzma_dec_free(rw_lzma_dec *dec)
{
	if (dec == NULL)
		return;
	if (dec->is_lzma2)
		Lzma2Dec_Free(&dec->lzma2, &rw_sdk_allocator);
	else
		LzmaDec_Free(&dec->lzma1, &rw_sdk_allocator);
	free(dec);
}

int
rw_lzma_dec_run(rw_lzma_dec *dec, uint8_t *dest, size_t *dest_len,
    const uint8_t *src, size_t *src_len, int *finished)
{
	ELzmaStatus status;
	SizeT out_len;
	SizeT in_len;
	SRes res;

	if (dec == NULL || dest_len == NULL || src_len == NULL ||
	    finished == NULL)
		return RW_LZMA_ERR_PARAM;

	out_len = (SizeT)*dest_len;
	in_len = (SizeT)*src_len;

	if (dec->is_lzma2)
		res = Lzma2Dec_DecodeToBuf(&dec->lzma2, (Byte *)dest, &out_len,
		    (const Byte *)src, &in_len, LZMA_FINISH_ANY, &status);
	else
		res = LzmaDec_DecodeToBuf(&dec->lzma1, (Byte *)dest, &out_len,
		    (const Byte *)src, &in_len, LZMA_FINISH_ANY, &status);

	*dest_len = (size_t)out_len;
	*src_len = (size_t)in_len;
	*finished = (status == LZMA_STATUS_FINISHED_WITH_MARK) ? 1 : 0;

	if (res == SZ_OK)
		return RW_LZMA_OK;
	if (res == SZ_ERROR_MEM)
		return RW_LZMA_ERR_MEM;
	return RW_LZMA_ERR_DATA;
}
