/*
 * rom-weaver: expose the solid block (folder) of the entry whose header was
 * just read, and the decoder memory that folder needs.
 *
 * A 7z "folder" is one solid compression block. libarchive knows which folder
 * every entry lives in (`zip->entry->folderIndex`) but exposes nothing about
 * it, so a caller that hands entries to parallel workers cannot tell which
 * splits are free and which force a second decode of the same block, nor how
 * many workers' decoders fit in memory at once.
 *
 * Appended verbatim to the staged copy of archive_read_support_format_7zip.c
 * by crates/rom-weaver-containers/libarchive/build.rs, which is why it can see
 * the file-local `struct _7zip` definitions. The vendored tree stays a verbatim
 * snapshot of the fork.
 *
 * Both accessors return -1 when they do not apply: a non-7z reader, no entry
 * read yet, or an entry with no stream at all (a directory or an empty file,
 * whose folderIndex libarchive sets to (uint32_t)-1).
 */
static struct _7zip *
rom_weaver_7zip_entry_reader(struct archive *_a)
{
	struct archive_read *a = (struct archive_read *)_a;
	struct _7zip *zip;

	if (a == NULL || a->archive.magic != ARCHIVE_READ_MAGIC)
		return (NULL);
	if ((a->archive.archive_format & ARCHIVE_FORMAT_BASE_MASK)
	    != ARCHIVE_FORMAT_7ZIP)
		return (NULL);
	if (a->format == NULL || a->format->data == NULL)
		return (NULL);
	zip = (struct _7zip *)a->format->data;
	if (zip->entry == NULL)
		return (NULL);
	if (zip->entry->folderIndex >= zip->si.ci.numFolders)
		return (NULL);
	return (zip);
}

int64_t
rom_weaver_7zip_entry_solid_block(struct archive *_a)
{
	struct _7zip *zip = rom_weaver_7zip_entry_reader(_a);

	if (zip == NULL)
		return (-1);
	return ((int64_t)zip->entry->folderIndex);
}

/*
 * Bytes the folder's decoders allocate as working state: each LZMA coder's
 * dictionary, capped at the folder's output exactly as the reader caps it, and
 * each PPMd coder's model. Only sizes the header declares count. The other
 * coders keep at most a few hundred KiB, a zstd window is unknown until its
 * frame is read, and BCJ2's whole-buffered side streams are left out because
 * 7-Zip applies BCJ2 only to executables.
 */
int64_t
rom_weaver_7zip_entry_decoder_bytes(struct archive *_a)
{
	struct _7zip *zip = rom_weaver_7zip_entry_reader(_a);
	struct _7z_folder *folder;
	uint64_t output_bytes, total = 0;
	uint64_t i;

	if (zip == NULL)
		return (-1);
	folder = &zip->si.ci.folders[zip->entry->folderIndex];
	output_bytes = folder_uncompressed_size(folder);
	for (i = 0; i < folder->numCoders; i++) {
		const struct _7z_coder *coder = &folder->coders[i];

		switch (coder->codec) {
		case _7Z_LZMA:
		case _7Z_LZMA2:
			total += rw_lzma_dec_dict_size(coder->codec == _7Z_LZMA2,
			    coder->properties, (size_t)coder->propertiesSize,
			    output_bytes);
			break;
		case _7Z_PPMD:
			if (coder->propertiesSize >= 5)
				total += archive_le32dec(coder->properties + 1);
			break;
		default:
			break;
		}
	}
	return (total > INT64_MAX ? INT64_MAX : (int64_t)total);
}
