/* Appended to archive_string.c so the pathname conversion cache stays local to
 * that archive. The Rust boundary consumes UTF-8 regardless of the process locale.
 * Callers MUST invoke this before enabling formats or creating conversions. */
int
rom_weaver_archive_set_utf8(struct archive *a)
{
	char *charset = strdup("UTF-8");
	if (charset == NULL) {
		archive_set_error(a, ENOMEM, "Can't allocate UTF-8 archive charset");
		return (ARCHIVE_FATAL);
	}
	free(a->current_code);
	a->current_code = charset;
	a->current_codepage = make_codepage_from_charset("UTF-8");
	a->current_oemcp = get_current_oemcp();
	/* The C locale previously bypassed the Windows OEM conversion. */
	if (a->current_oemcp == CP_C_LOCALE)
		a->current_oemcp = a->current_codepage;
	return (ARCHIVE_OK);
}
