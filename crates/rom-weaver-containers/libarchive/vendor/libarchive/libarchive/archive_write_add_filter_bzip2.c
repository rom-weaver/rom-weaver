/*-
 * Copyright (c) 2003-2007 Tim Kientzle
 * Copyright (c) 2012 Michihiro NAKAJIMA
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR(S) ``AS IS'' AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 * IN NO EVENT SHALL THE AUTHOR(S) BE LIABLE FOR ANY DIRECT, INDIRECT,
 * INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 * NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#include "archive_platform.h"

#ifdef HAVE_ERRNO_H
#include <errno.h>
#endif
#ifdef HAVE_INTTYPES_H
#include <inttypes.h>
#endif
#ifdef HAVE_LIMITS_H
#include <limits.h>
#endif
#ifdef HAVE_PTHREAD_H
#include <pthread.h>
#endif
#include <stdio.h>
#ifdef HAVE_STDLIB_H
#include <stdlib.h>
#endif
#ifdef HAVE_STRING_H
#include <string.h>
#endif
#ifdef HAVE_UNISTD_H
#include <unistd.h>
#endif
#ifdef HAVE_BZLIB_H
#include <bzlib.h>
#endif

#include "archive.h"
#include "archive_private.h"
#include "archive_write_private.h"

#if defined(HAVE_BZLIB_H) && defined(BZ_CONFIG_ERROR) && defined(HAVE_PTHREAD_H)
#define HAVE_BZIP2_THREADS 1
#else
#define HAVE_BZIP2_THREADS 0
#endif

#if ARCHIVE_VERSION_NUMBER < 4000000
int
archive_write_set_compression_bzip2(struct archive *a)
{
	__archive_write_filters_free(a);
	return (archive_write_add_filter_bzip2(a));
}
#endif

#if HAVE_BZIP2_THREADS
struct bzip2_mt_job {
	pthread_t	 thread;
	int		 joined;
	char		*in;
	unsigned int	 in_size;
	char		*out;
	unsigned int	 out_size;
	int		 compression_level;
	int		 bzret;
};
#endif

struct private_data {
	int		 compression_level;
	int		 threads;
#if defined(HAVE_BZLIB_H) && defined(BZ_CONFIG_ERROR)
	bz_stream	 stream;
	int		 stream_valid;
	int64_t		 total_in;
	char		*compressed;
	size_t		 compressed_buffer_size;
#if HAVE_BZIP2_THREADS
	char		*mt_chunk;
	size_t		 mt_chunk_size;
	size_t		 mt_chunk_used;
	struct bzip2_mt_job *mt_jobs;
	size_t		 mt_job_head;
	size_t		 mt_job_count;
#endif
#else
	struct archive_write_program_data *pdata;
#endif
};

static int archive_compressor_bzip2_close(struct archive_write_filter *);
static int archive_compressor_bzip2_free(struct archive_write_filter *);
static int archive_compressor_bzip2_open(struct archive_write_filter *);
static int archive_compressor_bzip2_options(struct archive_write_filter *,
		    const char *, const char *);
static int archive_compressor_bzip2_write(struct archive_write_filter *,
		    const void *, size_t);

/*
 * Add a bzip2 compression filter to this write handle.
 */
int
archive_write_add_filter_bzip2(struct archive *_a)
{
	struct archive_write *a = (struct archive_write *)_a;
	struct archive_write_filter *f = __archive_write_allocate_filter(_a);
	struct private_data *data;

	archive_check_magic(&a->archive, ARCHIVE_WRITE_MAGIC,
	    ARCHIVE_STATE_NEW, "archive_write_add_filter_bzip2");

	data = calloc(1, sizeof(*data));
	if (data == NULL) {
		archive_set_error(&a->archive, ENOMEM, "Out of memory");
		return (ARCHIVE_FATAL);
	}
	data->compression_level = 9; /* default */
	data->threads = 1;

	f->data = data;
	f->options = &archive_compressor_bzip2_options;
	f->close = &archive_compressor_bzip2_close;
	f->free = &archive_compressor_bzip2_free;
	f->open = &archive_compressor_bzip2_open;
	f->code = ARCHIVE_FILTER_BZIP2;
	f->name = "bzip2";
#if defined(HAVE_BZLIB_H) && defined(BZ_CONFIG_ERROR)
	return (ARCHIVE_OK);
#else
	data->pdata = __archive_write_program_allocate("bzip2");
	if (data->pdata == NULL) {
		free(data);
		archive_set_error(&a->archive, ENOMEM, "Out of memory");
		return (ARCHIVE_FATAL);
	}
	data->compression_level = 0;
	archive_set_error(&a->archive, ARCHIVE_ERRNO_MISC,
	    "Using external bzip2 program");
	return (ARCHIVE_WARN);
#endif
}

static int
string_to_number(const char *string, intmax_t *numberp)
{
	char *end;

	if (string == NULL || *string == '\0')
		return (ARCHIVE_WARN);
	errno = 0;
	*numberp = strtoimax(string, &end, 10);
	if (end == string || *end != '\0' || errno == EOVERFLOW) {
		*numberp = 0;
		return (ARCHIVE_WARN);
	}
	return (ARCHIVE_OK);
}

/*
 * Set write options.
 */
static int
archive_compressor_bzip2_options(struct archive_write_filter *f,
    const char *key, const char *value)
{
	struct private_data *data = (struct private_data *)f->data;

	if (strcmp(key, "compression-level") == 0) {
		if (value == NULL || !(value[0] >= '0' && value[0] <= '9') ||
		    value[1] != '\0') {
			archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
			    "compression-level invalid");
			return (ARCHIVE_FAILED);
		}
		data->compression_level = value[0] - '0';
		/* Make '0' be a synonym for '1'. */
		/* This way, bzip2 compressor supports the same 0..9
		 * range of levels as gzip. */
		if (data->compression_level < 1)
			data->compression_level = 1;
		return (ARCHIVE_OK);
	} else if (strcmp(key, "threads") == 0) {
		intmax_t threads;

		if (string_to_number(value, &threads) != ARCHIVE_OK) {
			archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
			    "threads invalid");
			return (ARCHIVE_FAILED);
		}
		if (threads < 0 || threads > INT_MAX) {
			archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
			    "threads out of range");
			return (ARCHIVE_FAILED);
		}
		if (threads == 0) {
#if HAVE_BZIP2_THREADS && defined(HAVE_SYSCONF) && defined(_SC_NPROCESSORS_ONLN)
			threads = sysconf(_SC_NPROCESSORS_ONLN);
			if (threads < 1)
				threads = 1;
#else
			threads = 1;
#endif
		}
#if !HAVE_BZIP2_THREADS
		if (threads > 1) {
			archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
			    "bzip2 threads are not supported on this platform");
			return (ARCHIVE_FAILED);
		}
#endif
		data->threads = (int)threads;
		return (ARCHIVE_OK);
	}

	/* Note: The "warn" return is just to inform the options
	 * supervisor that we didn't handle it.  It will generate
	 * a suitable error if no one used this option. */
	return (ARCHIVE_WARN);
}

#if defined(HAVE_BZLIB_H) && defined(BZ_CONFIG_ERROR)
/* Don't compile this if we don't have bzlib. */

/*
 * Yuck.  bzlib.h is not const-correct, so I need this one bit
 * of ugly hackery to convert a const * pointer to a non-const pointer.
 */
#define	SET_NEXT_IN(st,src)					\
	(st)->stream.next_in = (char *)(uintptr_t)(const void *)(src)
static int drive_compressor(struct archive_write_filter *,
		    struct private_data *, int finishing);
#if HAVE_BZIP2_THREADS
static int drive_compressor_mt(struct archive_write_filter *,
		    struct private_data *, const void *, size_t);
static int finish_compressor_mt(struct archive_write_filter *,
		    struct private_data *);
static int setup_compressor_mt(struct archive_write_filter *,
		    struct private_data *);
static void free_compressor_mt(struct private_data *);
#endif

/*
 * Setup callback.
 */
static int
archive_compressor_bzip2_open(struct archive_write_filter *f)
{
	struct private_data *data = (struct private_data *)f->data;
	int ret;

#if HAVE_BZIP2_THREADS
	if (data->threads > 1)
		return (setup_compressor_mt(f, data));
#endif

	if (data->compressed == NULL) {
		size_t bs = 65536, bpb;
		if (f->archive->magic == ARCHIVE_WRITE_MAGIC) {
			/* Buffer size should be a multiple number of the bytes
			 * per block for performance. */
			bpb = archive_write_get_bytes_per_block(f->archive);
			if (bpb > bs)
				bs = bpb;
			else if (bpb != 0)
				bs -= bs % bpb;
		}
		data->compressed_buffer_size = bs;
		data->compressed = malloc(data->compressed_buffer_size);
		if (data->compressed == NULL) {
			archive_set_error(f->archive, ENOMEM,
			    "Can't allocate data for compression buffer");
			return (ARCHIVE_FATAL);
		}
	}

	memset(&data->stream, 0, sizeof(data->stream));
	data->stream.next_out = data->compressed;
	data->stream.avail_out = (uint32_t)data->compressed_buffer_size;
	f->write = archive_compressor_bzip2_write;
	data->stream_valid = 0;

	/* Initialize compression library */
	ret = BZ2_bzCompressInit(&(data->stream),
	    data->compression_level, 0, 30);
	if (ret == BZ_OK) {
		data->stream_valid = 1;
		f->data = data;
		return (ARCHIVE_OK);
	}

	/* Library setup failed: clean up. */
	archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
	    "Internal error initializing compression library");

	/* Override the error message if we know what really went wrong. */
	switch (ret) {
	case BZ_PARAM_ERROR:
		archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
		    "Internal error initializing compression library: "
		    "invalid setup parameter");
		break;
	case BZ_MEM_ERROR:
		archive_set_error(f->archive, ENOMEM,
		    "Internal error initializing compression library: "
		    "out of memory");
		break;
	case BZ_CONFIG_ERROR:
		archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
		    "Internal error initializing compression library: "
		    "mis-compiled library");
		break;
	}

	return (ARCHIVE_FATAL);

}

/*
 * Write data to the compressed stream.
 *
 * Returns ARCHIVE_OK if all data written, error otherwise.
 */
static int
archive_compressor_bzip2_write(struct archive_write_filter *f,
    const void *buff, size_t length)
{
	struct private_data *data = (struct private_data *)f->data;

	/* Update statistics */
	data->total_in += length;

#if HAVE_BZIP2_THREADS
	if (data->threads > 1 && data->mt_jobs != NULL)
		return (drive_compressor_mt(f, data, buff, length));
#endif

	/* Compress input data to output buffer */
	SET_NEXT_IN(data, buff);
	data->stream.avail_in = (uint32_t)length;
	if (drive_compressor(f, data, 0))
		return (ARCHIVE_FATAL);
	return (ARCHIVE_OK);
}


/*
 * Finish the compression.
 */
static int
archive_compressor_bzip2_close(struct archive_write_filter *f)
{
	struct private_data *data = (struct private_data *)f->data;
	int ret;

#if HAVE_BZIP2_THREADS
	if (data->threads > 1 && data->mt_jobs != NULL)
		return (finish_compressor_mt(f, data));
#endif

	/* Finish compression cycle. */
	ret = drive_compressor(f, data, 1);
	if (ret == ARCHIVE_OK) {
		/* Write the last block */
		ret = __archive_write_filter(f->next_filter,
		    data->compressed,
		    data->compressed_buffer_size - data->stream.avail_out);
	}

	if (data->stream_valid) {
		switch (BZ2_bzCompressEnd(&(data->stream))) {
		case BZ_OK:
			data->stream_valid = 0;
			break;
		default:
			archive_set_error(f->archive, ARCHIVE_ERRNO_PROGRAMMER,
			    "Failed to clean up compressor");
			ret = ARCHIVE_FATAL;
		}
	}
	return ret;
}

static int
archive_compressor_bzip2_free(struct archive_write_filter *f)
{
	struct private_data *data = (struct private_data *)f->data;

	/* May already have been called, but not necessarily. */
	if (data->stream_valid)
		(void)BZ2_bzCompressEnd(&(data->stream));

#if HAVE_BZIP2_THREADS
	free_compressor_mt(data);
#endif
	free(data->compressed);
	free(data);
	f->data = NULL;
	return (ARCHIVE_OK);
}

/*
 * Utility function to push input data through compressor, writing
 * full output blocks as necessary.
 *
 * Note that this handles both the regular write case (finishing ==
 * false) and the end-of-archive case (finishing == true).
 */
static int
drive_compressor(struct archive_write_filter *f,
    struct private_data *data, int finishing)
{
	int ret;

	for (;;) {
		if (data->stream.avail_out == 0) {
			ret = __archive_write_filter(f->next_filter,
			    data->compressed,
			    data->compressed_buffer_size);
			if (ret != ARCHIVE_OK) {
				/* TODO: Handle this write failure */
				return (ARCHIVE_FATAL);
			}
			data->stream.next_out = data->compressed;
			data->stream.avail_out = (uint32_t)data->compressed_buffer_size;
		}

		/* If there's nothing to do, we're done. */
		if (!finishing && data->stream.avail_in == 0)
			return (ARCHIVE_OK);

		ret = BZ2_bzCompress(&(data->stream),
		    finishing ? BZ_FINISH : BZ_RUN);

		switch (ret) {
		case BZ_RUN_OK:
			/* In non-finishing case, did compressor
			 * consume everything? */
			if (!finishing && data->stream.avail_in == 0)
				return (ARCHIVE_OK);
			break;
		case BZ_FINISH_OK:  /* Finishing: There's more work to do */
			break;
		case BZ_STREAM_END: /* Finishing: all done */
			/* Only occurs in finishing case */
			return (ARCHIVE_OK);
		default:
			/* Any other return value indicates an error */
			archive_set_error(f->archive,
			    ARCHIVE_ERRNO_PROGRAMMER,
			    "Bzip2 compression failed;"
			    " BZ2_bzCompress() returned %d",
			    ret);
			return (ARCHIVE_FATAL);
		}
	}
}

#if HAVE_BZIP2_THREADS

static size_t
bzip2_mt_chunk_size(int compression_level)
{
	size_t chunk_size;

	chunk_size = (size_t)compression_level * 100000U * 4U;
	if (chunk_size < 1024U * 1024U)
		chunk_size = 1024U * 1024U;
	return (chunk_size);
}

static void
bzip2_mt_set_error(struct archive_write_filter *f, int bzret)
{
	switch (bzret) {
	case BZ_MEM_ERROR:
		archive_set_error(f->archive, ENOMEM,
		    "Bzip2 compression failed: out of memory");
		break;
	case BZ_PARAM_ERROR:
		archive_set_error(f->archive, ARCHIVE_ERRNO_PROGRAMMER,
		    "Bzip2 compression failed: invalid parameter");
		break;
	case BZ_OUTBUFF_FULL:
		archive_set_error(f->archive, ENOMEM,
		    "Bzip2 compression failed: output buffer too small");
		break;
	case BZ_CONFIG_ERROR:
		archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
		    "Bzip2 compression failed: mis-compiled library");
		break;
	default:
		archive_set_error(f->archive, ARCHIVE_ERRNO_PROGRAMMER,
		    "Bzip2 compression failed; BZ2_bzBuffToBuffCompress() "
		    "returned %d", bzret);
		break;
	}
}

static void *
bzip2_mt_worker(void *arg)
{
	struct bzip2_mt_job *job = (struct bzip2_mt_job *)arg;
	unsigned int out_size;

	if (job->in_size > UINT_MAX - (job->in_size / 100U) - 601U) {
		job->bzret = BZ_MEM_ERROR;
		return (NULL);
	}
	out_size = job->in_size + (job->in_size / 100U) + 600U;
	if (out_size < 600U)
		out_size = 600U;
	job->out = malloc(out_size);
	if (job->out == NULL) {
		job->bzret = BZ_MEM_ERROR;
		return (NULL);
	}

	job->bzret = BZ2_bzBuffToBuffCompress(job->out, &out_size,
	    job->in, job->in_size, job->compression_level, 0, 30);
	if (job->bzret != BZ_OK) {
		free(job->out);
		job->out = NULL;
		return (NULL);
	}
	job->out_size = out_size;
	return (NULL);
}

static int
bzip2_mt_join(struct archive_write_filter *f, struct bzip2_mt_job *job)
{
	int ret;

	if (job->joined)
		return (ARCHIVE_OK);
	ret = pthread_join(job->thread, NULL);
	if (ret != 0) {
		archive_set_error(f->archive, ret,
		    "Couldn't join bzip2 worker thread");
		return (ARCHIVE_FATAL);
	}
	job->joined = 1;
	free(job->in);
	job->in = NULL;
	if (job->bzret != BZ_OK) {
		bzip2_mt_set_error(f, job->bzret);
		return (ARCHIVE_FATAL);
	}
	return (ARCHIVE_OK);
}

static int
bzip2_mt_drain(struct archive_write_filter *f, struct private_data *data)
{
	while (data->mt_job_count > 0) {
		struct bzip2_mt_job *job = &data->mt_jobs[data->mt_job_head];
		int ret;

		ret = bzip2_mt_join(f, job);
		if (ret != ARCHIVE_OK)
			return (ret);
		ret = __archive_write_filter(f->next_filter, job->out,
		    job->out_size);
		if (ret != ARCHIVE_OK)
			return (ARCHIVE_FATAL);
		free(job->out);
		memset(job, 0, sizeof(*job));
		data->mt_job_head = (data->mt_job_head + 1) %
		    (size_t)data->threads;
		data->mt_job_count--;
		if (data->mt_job_count < (size_t)data->threads)
			return (ARCHIVE_OK);
	}
	return (ARCHIVE_OK);
}

static int
bzip2_mt_submit(struct archive_write_filter *f, struct private_data *data,
    int force)
{
	struct bzip2_mt_job *job;
	size_t in_alloc;
	size_t job_index;
	int ret;

	if (data->mt_chunk_used == 0 && !force)
		return (ARCHIVE_OK);
	if (data->mt_job_count >= (size_t)data->threads) {
		ret = bzip2_mt_drain(f, data);
		if (ret != ARCHIVE_OK)
			return (ret);
	}
	if (data->mt_job_count >= (size_t)data->threads) {
		archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
		    "Internal error queueing bzip2 worker thread");
		return (ARCHIVE_FATAL);
	}
	if (data->mt_chunk_used > UINT_MAX) {
		archive_set_error(f->archive, ARCHIVE_ERRNO_MISC,
		    "Internal error queueing bzip2 worker thread");
		return (ARCHIVE_FATAL);
	}

	job_index = (data->mt_job_head + data->mt_job_count) %
	    (size_t)data->threads;
	job = &data->mt_jobs[job_index];
	memset(job, 0, sizeof(*job));
	in_alloc = data->mt_chunk_used == 0 ? 1 : data->mt_chunk_used;
	job->in = malloc(in_alloc);
	if (job->in == NULL) {
		archive_set_error(f->archive, ENOMEM,
		    "Can't allocate memory for bzip2 worker input");
		return (ARCHIVE_FATAL);
	}
	if (data->mt_chunk_used > 0)
		memcpy(job->in, data->mt_chunk, data->mt_chunk_used);
	job->in_size = (unsigned int)data->mt_chunk_used;
	job->compression_level = data->compression_level;
	ret = pthread_create(&job->thread, NULL, bzip2_mt_worker, job);
	if (ret != 0) {
		free(job->in);
		memset(job, 0, sizeof(*job));
		archive_set_error(f->archive, ret,
		    "Couldn't create bzip2 worker thread");
		return (ARCHIVE_FATAL);
	}
	data->mt_job_count++;
	data->mt_chunk_used = 0;
	return (ARCHIVE_OK);
}

static int
setup_compressor_mt(struct archive_write_filter *f, struct private_data *data)
{
	data->mt_chunk_size = bzip2_mt_chunk_size(data->compression_level);
	data->mt_chunk = malloc(data->mt_chunk_size);
	data->mt_jobs = calloc((size_t)data->threads, sizeof(*data->mt_jobs));
	if (data->mt_chunk == NULL || data->mt_jobs == NULL) {
		free(data->mt_chunk);
		free(data->mt_jobs);
		data->mt_chunk = NULL;
		data->mt_jobs = NULL;
		archive_set_error(f->archive, ENOMEM,
		    "Can't allocate data for threaded bzip2 compression");
		return (ARCHIVE_FATAL);
	}
	f->write = archive_compressor_bzip2_write;
	return (ARCHIVE_OK);
}

static int
drive_compressor_mt(struct archive_write_filter *f, struct private_data *data,
    const void *buff, size_t length)
{
	const char *p = (const char *)buff;
	int ret;

	while (length > 0) {
		size_t bytes;

		while (data->mt_job_count >= (size_t)data->threads) {
			ret = bzip2_mt_drain(f, data);
			if (ret != ARCHIVE_OK)
				return (ret);
		}

		bytes = data->mt_chunk_size - data->mt_chunk_used;
		if (bytes > length)
			bytes = length;
		memcpy(data->mt_chunk + data->mt_chunk_used, p, bytes);
		data->mt_chunk_used += bytes;
		p += bytes;
		length -= bytes;

		if (data->mt_chunk_used == data->mt_chunk_size) {
			ret = bzip2_mt_submit(f, data, 0);
			if (ret != ARCHIVE_OK)
				return (ret);
		}
	}
	return (ARCHIVE_OK);
}

static int
finish_compressor_mt(struct archive_write_filter *f, struct private_data *data)
{
	int ret;

	ret = bzip2_mt_submit(f, data, data->total_in == 0);
	if (ret != ARCHIVE_OK)
		return (ret);
	while (data->mt_job_count > 0) {
		ret = bzip2_mt_drain(f, data);
		if (ret != ARCHIVE_OK)
			return (ret);
	}
	return (ARCHIVE_OK);
}

static void
free_compressor_mt(struct private_data *data)
{
	size_t i;

	if (data->mt_jobs != NULL) {
		for (i = 0; i < data->mt_job_count; i++) {
			struct bzip2_mt_job *job;

			job = &data->mt_jobs[(data->mt_job_head + i) %
			    (size_t)data->threads];
			if (!job->joined)
				pthread_join(job->thread, NULL);
			free(job->in);
			free(job->out);
		}
	}
	free(data->mt_jobs);
	free(data->mt_chunk);
	data->mt_jobs = NULL;
	data->mt_chunk = NULL;
	data->mt_job_count = 0;
}
#endif

#else /* HAVE_BZLIB_H && BZ_CONFIG_ERROR */

static int
archive_compressor_bzip2_open(struct archive_write_filter *f)
{
	struct private_data *data = (struct private_data *)f->data;
	struct archive_string as;
	int r;

	archive_string_init(&as);
	archive_strcpy(&as, "bzip2");

	/* Specify compression level. */
	if (data->compression_level > 0) {
		archive_strcat(&as, " -");
		archive_strappend_char(&as, '0' + data->compression_level);
	}
	f->write = archive_compressor_bzip2_write;

	r = __archive_write_program_open(f, data->pdata, as.s);
	archive_string_free(&as);
	return (r);
}

static int
archive_compressor_bzip2_write(struct archive_write_filter *f, const void *buff,
    size_t length)
{
	struct private_data *data = (struct private_data *)f->data;

	return __archive_write_program_write(f, data->pdata, buff, length);
}

static int
archive_compressor_bzip2_close(struct archive_write_filter *f)
{
	struct private_data *data = (struct private_data *)f->data;

	return __archive_write_program_close(f, data->pdata);
}

static int
archive_compressor_bzip2_free(struct archive_write_filter *f)
{
	struct private_data *data = (struct private_data *)f->data;

	__archive_write_program_free(data->pdata);
	free(data);
	return (ARCHIVE_OK);
}

#endif /* HAVE_BZLIB_H && BZ_CONFIG_ERROR */
