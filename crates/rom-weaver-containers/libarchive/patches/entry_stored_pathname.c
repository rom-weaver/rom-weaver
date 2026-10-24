/*
 * rom-weaver: expose the entry pathname bytes exactly as the format reader
 * stored them, or NULL when the reader stored a wide or UTF-8 form instead.
 *
 * Names without a charset marker (ZIP without the UTF-8 flag, plain tar) are
 * stored as raw bytes. The public accessors re-read those bytes in the process
 * locale; on Windows the "C" locale widens each byte to the code point of the
 * same value, so the UTF-8 accessor succeeds with mojibake and the caller
 * cannot tell it from a real Unicode name.
 *
 * Callers MUST call this before archive_entry_pathname(), which caches a
 * locale-converted form in the same field. Appended to the staged copy of
 * archive_entry.c by crates/rom-weaver-containers/libarchive/build.rs.
 */
const char *
rom_weaver_archive_entry_stored_pathname(struct archive_entry *entry)
{
	if ((entry->ae_pathname.aes_set & AES_SET_MBS) == 0)
		return (NULL);
	return (entry->ae_pathname.aes_mbs.s);
}
