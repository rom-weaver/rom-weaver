#![allow(non_camel_case_types)]
#![allow(non_snake_case)]

pub use bzip2_sys;
pub use liblzma_sys;
pub use libz_sys;
pub use lz4_sys;
pub use zstd_sys;

#[cfg(all(not(target_vendor = "apple"), not(target_family = "wasm")))]
pub use openssl_sys;

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));

#[cfg(target_family = "wasm")]
unsafe extern "C" {
    pub fn archive_free(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_errno(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_error_string(arg1: *mut archive) -> *const ::std::os::raw::c_char;
    pub fn archive_format(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_set_error(
        arg1: *mut archive,
        _err: ::std::os::raw::c_int,
        fmt: *const ::std::os::raw::c_char,
        ...
    );

    pub fn archive_read_new() -> *mut archive;
    pub fn archive_read_support_filter_bzip2(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_compress(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_gzip(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_lzip(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_lzma(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_rpm(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_uu(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_xz(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_filter_zstd(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_7zip(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_ar(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_cab(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_cpio(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_empty(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_iso9660(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_lha(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_mtree(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_rar(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_rar5(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_raw(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_tar(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_warc(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_support_format_zip(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_set_seek_callback(
        arg1: *mut archive,
        arg2: archive_seek_callback,
    ) -> ::std::os::raw::c_int;
    pub fn archive_read_open2(
        arg1: *mut archive,
        _client_data: *mut ::std::os::raw::c_void,
        arg2: archive_open_callback,
        arg3: archive_read_callback,
        arg4: archive_skip_callback,
        arg5: archive_close_callback,
    ) -> ::std::os::raw::c_int;
    pub fn archive_read_open_filename(
        arg1: *mut archive,
        _filename: *const ::std::os::raw::c_char,
        _block_size: usize,
    ) -> ::std::os::raw::c_int;
    pub fn archive_read_next_header(
        arg1: *mut archive,
        arg2: *mut *mut archive_entry,
    ) -> ::std::os::raw::c_int;
    pub fn archive_read_data(
        arg1: *mut archive,
        arg2: *mut ::std::os::raw::c_void,
        arg3: usize,
    ) -> la_ssize_t;
    pub fn archive_seek_data(
        arg1: *mut archive,
        arg2: la_int64_t,
        arg3: ::std::os::raw::c_int,
    ) -> la_int64_t;
    pub fn archive_read_close(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_read_free(arg1: *mut archive) -> ::std::os::raw::c_int;

    pub fn archive_write_new() -> *mut archive;
    pub fn archive_write_set_format_7zip(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_set_format_pax_restricted(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_set_format_raw(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_set_format_zip(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_add_filter_none(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_add_filter_gzip(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_add_filter_bzip2(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_add_filter_xz(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_add_filter_zstd(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_open_filename(
        arg1: *mut archive,
        _file: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int;
    pub fn archive_write_header(
        arg1: *mut archive,
        arg2: *mut archive_entry,
    ) -> ::std::os::raw::c_int;
    pub fn archive_write_data(
        arg1: *mut archive,
        arg2: *const ::std::os::raw::c_void,
        arg3: usize,
    ) -> la_ssize_t;
    pub fn archive_write_finish_entry(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_close(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_free(arg1: *mut archive) -> ::std::os::raw::c_int;
    pub fn archive_write_set_format_option(
        _a: *mut archive,
        m: *const ::std::os::raw::c_char,
        o: *const ::std::os::raw::c_char,
        v: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int;
    pub fn archive_write_set_filter_option(
        _a: *mut archive,
        m: *const ::std::os::raw::c_char,
        o: *const ::std::os::raw::c_char,
        v: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int;

    pub fn archive_entry_free(arg1: *mut archive_entry);
    pub fn archive_entry_new() -> *mut archive_entry;
    pub fn archive_entry_filetype(arg1: *mut archive_entry) -> libc::mode_t;
    pub fn archive_entry_pathname(arg1: *mut archive_entry) -> *const ::std::os::raw::c_char;
    pub fn archive_entry_pathname_utf8(arg1: *mut archive_entry) -> *const ::std::os::raw::c_char;
    pub fn archive_entry_size(arg1: *mut archive_entry) -> la_int64_t;
    pub fn archive_entry_size_is_set(arg1: *mut archive_entry) -> ::std::os::raw::c_int;
    pub fn archive_entry_set_filetype(arg1: *mut archive_entry, arg2: ::std::os::raw::c_uint);
    pub fn archive_entry_set_pathname(
        arg1: *mut archive_entry,
        arg2: *const ::std::os::raw::c_char,
    );
    pub fn archive_entry_set_perm(arg1: *mut archive_entry, arg2: libc::mode_t);
    pub fn archive_entry_set_size(arg1: *mut archive_entry, arg2: la_int64_t);
}
