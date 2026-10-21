/*-
 * Copyright (c) 2026 Brandon Casey
 *
 * This file is in the public domain.
 */

#ifndef ARCHIVE_ZLIB_PRIVATE_H_INCLUDED
#define ARCHIVE_ZLIB_PRIVATE_H_INCLUDED

#ifndef __LIBARCHIVE_BUILD
#error This header is only to be used internally to libarchive.
#endif

#ifdef HAVE_ZLIB_H

#include <stdlib.h>
#include <zlib.h>

#if defined(__wasi__) || defined(__wasm32__) || defined(__wasm64__)
static voidpf
archive_zlib_alloc(voidpf opaque, uInt items, uInt size)
{
	(void)opaque;
	if (size != 0 && (size_t)items > ((size_t)-1) / (size_t)size)
		return (Z_NULL);
	return (calloc((size_t)items, (size_t)size));
}

static void
archive_zlib_free(voidpf opaque, voidpf address)
{
	(void)opaque;
	free(address);
}
#endif

static void
archive_zlib_set_allocators(z_streamp stream)
{
#if defined(__wasi__) || defined(__wasm32__) || defined(__wasm64__)
	if (stream == Z_NULL)
		return;
	if (stream->zalloc == (alloc_func)0)
		stream->zalloc = archive_zlib_alloc;
	if (stream->zfree == (free_func)0)
		stream->zfree = archive_zlib_free;
#else
	(void)stream;
#endif
}

#endif /* HAVE_ZLIB_H */

#endif /* ARCHIVE_ZLIB_PRIVATE_H_INCLUDED */
