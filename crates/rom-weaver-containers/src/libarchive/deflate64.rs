use deflate64::InflaterManaged;
use std::ffi::c_int;
use std::slice;
use tracing::debug;

#[unsafe(no_mangle)]
extern "C" fn rom_weaver_deflate64_new() -> *mut InflaterManaged {
    debug!("initializing Deflate64 decoder");
    Box::into_raw(Box::new(InflaterManaged::new()))
}

#[unsafe(no_mangle)]
unsafe extern "C" fn rom_weaver_deflate64_free(decoder: *mut InflaterManaged) {
    if !decoder.is_null() {
        // The C reader MUST release each decoder exactly once after its last use.
        drop(unsafe { Box::from_raw(decoder) });
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn rom_weaver_deflate64_inflate(
    decoder: *mut InflaterManaged,
    input: *const u8,
    available_input: *mut usize,
    output: *mut u8,
    available_output: *mut usize,
) -> c_int {
    // The C reader MUST supply live, disjoint buffers and valid byte-count pointers.
    let (decoder, available_input, available_output) =
        unsafe { (&mut *decoder, &mut *available_input, &mut *available_output) };
    let input = if *available_input == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(input, *available_input) }
    };
    let output = if *available_output == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(output, *available_output) }
    };
    let result = decoder.inflate(input, output);
    *available_input -= result.bytes_consumed;
    *available_output -= result.bytes_written;
    if result.data_error {
        return -1;
    }
    c_int::from(decoder.finished())
}
