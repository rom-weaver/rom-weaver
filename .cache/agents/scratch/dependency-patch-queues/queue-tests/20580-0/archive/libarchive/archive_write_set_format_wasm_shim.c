#include "archive_platform.h"

#include "archive.h"
#include "archive_entry.h"

/*
 * Retained WASM writers reference this diagnostic helper, but its upstream
 * file also links excluded format setters. This no-op resolves those references
 * without adding the excluded writers; it emits no unsupported-type diagnostic.
 */
void
__archive_write_entry_filetype_unsupported(struct archive *a,
    struct archive_entry *entry, const char *format)
{
	(void)a;
	(void)entry;
	(void)format;
}
