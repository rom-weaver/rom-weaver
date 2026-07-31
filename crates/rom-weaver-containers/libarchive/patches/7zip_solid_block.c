/*
 * rom-weaver: expose the solid-block (folder) index of the entry whose header
 * was just read.
 *
 * A 7z "folder" is one solid compression block. libarchive knows which folder
 * every entry lives in (`zip->entry->folderIndex`) but exposes nothing about
 * it, so a caller that hands entries to parallel workers cannot tell which
 * splits are free and which force a second decode of the same block.
 *
 * Appended verbatim to the staged copy of archive_read_support_format_7zip.c
 * by crates/rom-weaver-containers/libarchive/build.rs, which is why it can see
 * the file-local `struct _7zip` definitions. The vendored tree stays a verbatim
 * snapshot of the fork.
 *
 * Returns the folder index, or -1 when it does not apply: a non-7z reader, no
 * entry read yet, or an entry with no stream at all (a directory or an empty
 * file, whose folderIndex libarchive sets to (uint32_t)-1).
 */
int64_t
rom_weaver_7zip_entry_solid_block(struct archive *_a)
{
	struct archive_read *a = (struct archive_read *)_a;
	struct _7zip *zip;

	if (a == NULL || a->archive.magic != ARCHIVE_READ_MAGIC)
		return (-1);
	if ((a->archive.archive_format & ARCHIVE_FORMAT_BASE_MASK)
	    != ARCHIVE_FORMAT_7ZIP)
		return (-1);
	if (a->format == NULL || a->format->data == NULL)
		return (-1);
	zip = (struct _7zip *)a->format->data;
	if (zip->entry == NULL)
		return (-1);
	if (zip->entry->folderIndex >= zip->si.ci.numFolders)
		return (-1);
	return ((int64_t)zip->entry->folderIndex);
}
