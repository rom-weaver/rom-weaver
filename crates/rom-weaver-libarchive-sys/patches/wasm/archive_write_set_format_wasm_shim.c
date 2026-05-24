#include "archive_platform.h"

#include "archive.h"
#include "archive_entry.h"

/*
 * archive_write_set_format.c pulls in setters for every write format, which is
 * too broad for the wasm build we stage here. Some retained format writers
 * still reference this internal helper for unsupported file-type diagnostics,
 * so provide the small helper locally and keep normal file writes self-contained.
 */
void
__archive_write_entry_filetype_unsupported(struct archive *a,
    struct archive_entry *entry, const char *format)
{
	(void)a;
	(void)entry;
	(void)format;
}
