/*
 * Implementation of the opaque LZMA SDK surface declared in
 * rom_weaver_lzma_sdk.h. This is the only translation unit outside the vendored
 * drop that includes the SDK headers.
 *
 * This file is rom-weaver's own code, not part of the vendored SDK drop.
 */

#include <stddef.h>
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

/* --- Encode ---------------------------------------------------------- */

/*
 * Z7_ST means the SDK was built without its thread layer (wasm32-wasip1, which
 * has no threads at all). The bridge below needs a thread to run the blocking
 * encoder on, so that target keeps liblzma - which is what libarchive's own
 * ROM_WEAVER_LZMA_SDK_MT gate reflects on the writer side.
 */
#ifndef Z7_ST

/*
 * The SDK encoder is a blocking one-shot over stream callbacks, while
 * libarchive's la_zstream is a push API. Bridging them means running
 * Lzma2Enc_Encode2 on its own thread and rendezvousing with the caller: the
 * SDK's Read callback blocks until the caller pushes input, its Write callback
 * blocks until the caller offers output space, and the caller blocks until one
 * side has made progress. MtCoder serialises its own reads and writes, so at
 * most one reader and one writer are ever parked here.
 *
 * The primitives are the platform's own mutex/condvar rather than the SDK's
 * events: three independent waiters with predicates is exactly what a condvar
 * is for, and the SDK only exposes auto-reset events.
 */

#include "Lzma2Enc.h"
#include "Threads.h"

#ifdef _WIN32
typedef CRITICAL_SECTION rw_mutex;
typedef CONDITION_VARIABLE rw_cond;
#define rw_mutex_init(m)	(InitializeCriticalSection(m), 0)
#define rw_mutex_destroy(m)	DeleteCriticalSection(m)
#define rw_lock(m)		EnterCriticalSection(m)
#define rw_unlock(m)		LeaveCriticalSection(m)
#define rw_cond_init(c)		(InitializeConditionVariable(c), 0)
#define rw_cond_destroy(c)	((void)(c))
#define rw_wait(c, m)		SleepConditionVariableCS((c), (m), INFINITE)
#define rw_wake(c)		WakeAllConditionVariable(c)
#else
#include <pthread.h>
typedef pthread_mutex_t rw_mutex;
typedef pthread_cond_t rw_cond;
#define rw_mutex_init(m)	pthread_mutex_init((m), NULL)
#define rw_mutex_destroy(m)	pthread_mutex_destroy(m)
#define rw_lock(m)		pthread_mutex_lock(m)
#define rw_unlock(m)		pthread_mutex_unlock(m)
#define rw_cond_init(c)		pthread_cond_init((c), NULL)
#define rw_cond_destroy(c)	pthread_cond_destroy(c)
#define rw_wait(c, m)		pthread_cond_wait((c), (m))
#define rw_wake(c)		pthread_cond_broadcast(c)
#endif

struct rw_lzma2_enc {
	CLzma2EncHandle	 handle;
	uint8_t		 props;

	ISeqInStream	 in_vt;
	ISeqOutStream	 out_vt;
	CThread		 thread;
	int		 thread_started;

	rw_mutex	 mutex;
	rw_cond		 cond;
	int		 mutex_ready;
	int		 cond_ready;

	/* Caller-owned input window, refreshed on every rw_lzma2_enc_code. */
	const uint8_t	*in;
	size_t		 in_left;
	int		 in_eof;
	int		 reader_parked;
	uint64_t	 consumed;

	/* Caller-owned output window, refreshed on every rw_lzma2_enc_code. */
	uint8_t		*out;
	size_t		 out_left;
	size_t		 out_written;

	int		 encoder_done;
	SRes		 encoder_res;
};

static SRes
rw_enc_read(ISeqInStreamPtr pp, void *data, size_t *size)
{
	struct rw_lzma2_enc *enc =
	    (struct rw_lzma2_enc *)((char *)pp -
	    offsetof(struct rw_lzma2_enc, in_vt));
	size_t want = *size;
	size_t take;

	rw_lock(&enc->mutex);
	while (enc->in_left == 0 && !enc->in_eof) {
		enc->reader_parked = 1;
		rw_wake(&enc->cond);
		rw_wait(&enc->cond, &enc->mutex);
	}
	enc->reader_parked = 0;
	take = want < enc->in_left ? want : enc->in_left;
	if (take > 0) {
		memcpy(data, enc->in, take);
		enc->in += take;
		enc->in_left -= take;
		enc->consumed += take;
	}
	*size = take;/* 0 means end of stream */
	rw_wake(&enc->cond);
	rw_unlock(&enc->mutex);
	return SZ_OK;
}

static size_t
rw_enc_write(ISeqOutStreamPtr pp, const void *data, size_t size)
{
	struct rw_lzma2_enc *enc =
	    (struct rw_lzma2_enc *)((char *)pp -
	    offsetof(struct rw_lzma2_enc, out_vt));
	const uint8_t *src = (const uint8_t *)data;
	size_t done = 0;

	rw_lock(&enc->mutex);
	while (done < size) {
		size_t take;

		while (enc->out_left == 0) {
			rw_wake(&enc->cond);
			rw_wait(&enc->cond, &enc->mutex);
		}
		take = enc->out_left < size - done ? enc->out_left : size - done;
		memcpy(enc->out, src + done, take);
		enc->out += take;
		enc->out_left -= take;
		enc->out_written += take;
		done += take;
	}
	rw_wake(&enc->cond);
	rw_unlock(&enc->mutex);
	return size;
}

static THREAD_FUNC_DECL
rw_enc_thread(void *arg)
{
	struct rw_lzma2_enc *enc = (struct rw_lzma2_enc *)arg;
	SRes res;

	res = Lzma2Enc_Encode2(enc->handle, &enc->out_vt, NULL, NULL,
	    &enc->in_vt, NULL, 0, NULL);

	rw_lock(&enc->mutex);
	enc->encoder_res = res;
	enc->encoder_done = 1;
	rw_wake(&enc->cond);
	rw_unlock(&enc->mutex);
	return THREAD_FUNC_RET_ZERO;
}

rw_lzma2_enc *
rw_lzma2_enc_new(int level, int threads, uint32_t dict_size, uint64_t size_hint)
{
	struct rw_lzma2_enc *enc;
	CLzma2EncProps props;

	enc = calloc(1, sizeof(*enc));
	if (enc == NULL)
		return NULL;

	if (rw_mutex_init(&enc->mutex) != 0) {
		free(enc);
		return NULL;
	}
	enc->mutex_ready = 1;
	if (rw_cond_init(&enc->cond) != 0) {
		rw_mutex_destroy(&enc->mutex);
		free(enc);
		return NULL;
	}
	enc->cond_ready = 1;

	enc->handle = Lzma2Enc_Create(&rw_sdk_allocator, &rw_sdk_allocator);
	if (enc->handle == NULL) {
		rw_lzma2_enc_free(enc);
		return NULL;
	}

	Lzma2EncProps_Init(&props);
	props.lzmaProps.level = level;
	if (dict_size != 0)
		props.lzmaProps.dictSize = dict_size;
	if (size_hint != 0)
		props.lzmaProps.reduceSize = size_hint;
	/* Leaving numBlockThreads_Max and lzmaProps.numThreads at their auto
	 * values makes Lzma2EncProps_Normalize divide numTotalThreads into
	 * block threads x match-finder threads the way 7zz's -mmt does. */
	props.numTotalThreads = threads > 0 ? threads : 1;
	if (Lzma2Enc_SetProps(enc->handle, &props) != SZ_OK) {
		rw_lzma2_enc_free(enc);
		return NULL;
	}
	if (size_hint != 0)
		Lzma2Enc_SetDataSize(enc->handle, size_hint);
	enc->props = Lzma2Enc_WriteProperties(enc->handle);

	enc->in_vt.Read = rw_enc_read;
	enc->out_vt.Write = rw_enc_write;

	if (Thread_Create(&enc->thread, rw_enc_thread, enc) != 0) {
		rw_lzma2_enc_free(enc);
		return NULL;
	}
	enc->thread_started = 1;
	return enc;
}

void
rw_lzma2_enc_free(rw_lzma2_enc *enc)
{
	if (enc == NULL)
		return;
	if (enc->thread_started) {
		/* Unblock a reader still waiting on input so the encoder can
		 * finish; an abandoned encode ends at the first short read. */
		rw_lock(&enc->mutex);
		enc->in_left = 0;
		enc->in_eof = 1;
		rw_wake(&enc->cond);
		rw_unlock(&enc->mutex);
		/* A writer may still be parked on a full output window; give it
		 * a scratch sink so it can drain and the thread can exit. */
		for (;;) {
			static uint8_t sink[1 << 16];
			int done;

			rw_lock(&enc->mutex);
			done = enc->encoder_done;
			if (!done) {
				enc->out = sink;
				enc->out_left = sizeof(sink);
				enc->out_written = 0;
				rw_wake(&enc->cond);
				rw_wait(&enc->cond, &enc->mutex);
			}
			rw_unlock(&enc->mutex);
			if (done)
				break;
		}
		Thread_Wait_Close(&enc->thread);
	}
	if (enc->handle != NULL)
		Lzma2Enc_Destroy(enc->handle);
	if (enc->cond_ready)
		rw_cond_destroy(&enc->cond);
	if (enc->mutex_ready)
		rw_mutex_destroy(&enc->mutex);
	free(enc);
}

uint8_t
rw_lzma2_enc_props(const rw_lzma2_enc *enc)
{
	return enc->props;
}

uint64_t
rw_lzma2_enc_consumed(rw_lzma2_enc *enc)
{
	uint64_t consumed;

	rw_lock(&enc->mutex);
	consumed = enc->consumed;
	rw_unlock(&enc->mutex);
	return consumed;
}

int
rw_lzma2_enc_code(rw_lzma2_enc *enc, const uint8_t *in, size_t *in_len,
    uint8_t *out, size_t *out_len, int finish, int *done)
{
	size_t in_size;
	SRes res;

	if (enc == NULL || in_len == NULL || out_len == NULL || done == NULL)
		return RW_LZMA_ERR_PARAM;

	in_size = *in_len;
	rw_lock(&enc->mutex);
	enc->in = in;
	enc->in_left = in_size;
	if (finish)
		enc->in_eof = 1;
	enc->out = out;
	enc->out_left = *out_len;
	enc->out_written = 0;
	rw_wake(&enc->cond);

	/*
	 * Return as soon as one side is blocked on the caller: the output
	 * window filled up, or the encoder ran out of input and there is no
	 * more coming this call. Either way the caller gets a fresh window on
	 * the next call.
	 */
	while (!enc->encoder_done && enc->out_left > 0 &&
	    !(enc->in_left == 0 && enc->reader_parked && !enc->in_eof))
		rw_wait(&enc->cond, &enc->mutex);

	*in_len = in_size - enc->in_left;
	*out_len = enc->out_written;
	*done = enc->encoder_done;
	res = enc->encoder_res;
	/* Retire both windows before returning: a worker that wakes after this
	 * must not touch the caller's buffers. */
	enc->in = NULL;
	enc->in_left = 0;
	enc->out = NULL;
	enc->out_left = 0;
	rw_unlock(&enc->mutex);

	if (*done && res != SZ_OK)
		return res == SZ_ERROR_MEM ? RW_LZMA_ERR_MEM : RW_LZMA_ERR_DATA;
	return RW_LZMA_OK;
}

#endif /* !Z7_ST */
