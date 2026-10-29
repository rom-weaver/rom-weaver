# RAR regression fixtures

These fixtures come from libarchive revision `ded82291ab41d5e355831b96b0e1ff49e24d8939`, decoded from the corresponding `libarchive/test/*.rar.uu` files:

- `rar4-unicode.rar`: `test_read_format_rar_unicode.rar.uu`; Unicode names and a symbolic link.
- `rar5-unicode.rar`: `test_read_format_rar5_unicode.rar.uu`; Unicode names, a hard link, and a symbolic link.
- `rar5-multiple-files.rar`: `test_read_format_rar5_multiple_files.rar.uu`; four complete files.
- `rar5-part01.rar`: `test_read_format_rar5_multiarchive.part01.rar.uu`; the first archive volume.

Source: [libarchive test fixtures](https://github.com/libarchive/libarchive/tree/ded82291ab41d5e355831b96b0e1ff49e24d8939/libarchive/test).

`rar5-stored.rar` is a synthetic RAR5 archive with an empty file and a stored 19-byte payload. Its header and payload checksums use CRC32.

`version.rar` predates these regression fixtures.
