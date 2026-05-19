use std::{
    ffi::{c_char, c_int, c_void},
    mem, slice,
};

pub type UsizeT = u32;
pub type XoffT = std::os::raw::c_ulong;

pub const XD3_INPUT: c_int = -17_703;
pub const XD3_OUTPUT: c_int = -17_704;
pub const XD3_GETSRCBLK: c_int = -17_705;
pub const XD3_GOTHEADER: c_int = -17_706;
pub const XD3_WINSTART: c_int = -17_707;
pub const XD3_WINFINISH: c_int = -17_708;
pub const XD3_INTERNAL: c_int = -17_710;

pub const XD3_FLUSH: c_int = 1 << 4;
pub const XD3_SEC_DJW: c_int = 1 << 5;
#[cfg(test)]
pub const XD3_SEC_FGK: c_int = 1 << 6;
pub const XD3_ADLER32: c_int = 1 << 10;
pub const XD3_ADLER32_NOVER: c_int = 1 << 11;
#[cfg(test)]
pub const XD3_NOCOMPRESS: c_int = 1 << 13;

pub const XD3_DEFAULT_WINSIZE: usize = 1 << 23;
pub const XD3_ALLOCSIZE: usize = 1 << 14;

pub type Xd3AllocFn =
    Option<unsafe extern "C" fn(opaque: *mut c_void, items: usize, size: UsizeT) -> *mut c_void>;
pub type Xd3FreeFn = Option<unsafe extern "C" fn(opaque: *mut c_void, address: *mut c_void)>;
pub type Xd3GetblkFn = Option<
    unsafe extern "C" fn(stream: *mut Xd3Stream, source: *mut Xd3Source, blkno: XoffT) -> c_int,
>;

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct Xd3Smatcher {
    pub name: *const c_char,
    pub string_match: Option<unsafe extern "C" fn(stream: *mut Xd3Stream) -> c_int>,
    pub large_look: UsizeT,
    pub large_step: UsizeT,
    pub small_look: UsizeT,
    pub small_chain: UsizeT,
    pub small_lchain: UsizeT,
    pub max_lazy: UsizeT,
    pub long_enough: UsizeT,
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct Xd3SecCfg {
    pub data_type: c_int,
    pub ngroups: UsizeT,
    pub sector_size: UsizeT,
    pub inefficient: c_int,
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct Xd3Config {
    pub winsize: UsizeT,
    pub sprevsz: UsizeT,
    pub iopt_size: UsizeT,
    pub getblk: Xd3GetblkFn,
    pub alloc: Xd3AllocFn,
    pub freef: Xd3FreeFn,
    pub opaque: *mut c_void,
    pub flags: c_int,
    pub sec_data: Xd3SecCfg,
    pub sec_inst: Xd3SecCfg,
    pub sec_addr: Xd3SecCfg,
    pub smatch_cfg: u32,
    pub smatcher_soft: Xd3Smatcher,
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct Xd3Source {
    pub blksize: UsizeT,
    pub name: *const c_char,
    pub ioh: *mut c_void,
    pub max_winsize: XoffT,
    pub curblkno: XoffT,
    pub onblk: UsizeT,
    pub curblk: *const u8,
    pub srclen: UsizeT,
    pub srcbase: XoffT,
    pub shiftby: c_int,
    pub maskby: c_int,
    pub cpyoff_blocks: XoffT,
    pub cpyoff_blkoff: UsizeT,
    pub getblkno: XoffT,
    pub max_blkno: XoffT,
    pub onlastblk: UsizeT,
    pub eof_known: c_int,
}

const XD3_STREAM_TAIL_SIZE: usize = 1_076;

#[repr(C)]
#[derive(Copy, Clone)]
pub struct Xd3Stream {
    pub next_in: *const u8,
    pub avail_in: UsizeT,
    _pad0: u32,
    pub total_in: XoffT,
    pub next_out: *mut u8,
    pub avail_out: UsizeT,
    pub space_out: UsizeT,
    pub current_window: XoffT,
    pub total_out: XoffT,
    pub msg: *const c_char,
    pub src: *mut Xd3Source,
    pub winsize: UsizeT,
    pub sprevsz: UsizeT,
    pub sprevmask: UsizeT,
    pub iopt_size: UsizeT,
    pub iopt_unlimited: UsizeT,
    _pad1: u32,
    pub getblk: Xd3GetblkFn,
    pub alloc: Xd3AllocFn,
    pub free: Xd3FreeFn,
    pub opaque: *mut c_void,
    pub flags: c_int,
    pub tail: [u8; XD3_STREAM_TAIL_SIZE],
}

impl Xd3Config {
    pub fn with_flags(flags: c_int) -> Self {
        let mut config = unsafe { mem::zeroed::<Self>() };
        config.flags = flags;
        config
    }
}

impl Xd3Source {
    pub fn zeroed() -> Self {
        unsafe { mem::zeroed::<Self>() }
    }
}

impl Xd3Stream {
    pub fn zeroed() -> Self {
        unsafe { mem::zeroed::<Self>() }
    }

    pub fn avail_input(&mut self, data: *const u8, size: UsizeT) {
        self.next_in = data;
        self.avail_in = size;
    }

    pub fn consume_output(&mut self) {
        self.avail_out = 0;
    }

    pub fn set_flags(&mut self, flags: c_int) {
        self.flags = flags;
    }

    pub unsafe fn output_slice(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.next_out, self.avail_out as usize) }
    }
}

#[cfg(target_pointer_width = "64")]
const _: [(); 152] = [(); mem::size_of::<Xd3Config>()];
#[cfg(target_pointer_width = "64")]
const _: [(); 8] = [(); mem::align_of::<Xd3Config>()];
#[cfg(target_pointer_width = "64")]
const _: [(); 120] = [(); mem::size_of::<Xd3Source>()];
#[cfg(target_pointer_width = "64")]
const _: [(); 8] = [(); mem::align_of::<Xd3Source>()];
#[cfg(target_pointer_width = "64")]
const _: [(); 1_208] = [(); mem::size_of::<Xd3Stream>()];
#[cfg(target_pointer_width = "64")]
const _: [(); 8] = [(); mem::align_of::<Xd3Stream>()];

#[cfg(target_pointer_width = "32")]
const _: [(); 120] = [(); mem::size_of::<Xd3Config>()];
#[cfg(target_pointer_width = "32")]
const _: [(); 4] = [(); mem::align_of::<Xd3Config>()];
#[cfg(target_pointer_width = "32")]
const _: [(); 68] = [(); mem::size_of::<Xd3Source>()];
#[cfg(target_pointer_width = "32")]
const _: [(); 4] = [(); mem::align_of::<Xd3Source>()];
#[cfg(target_pointer_width = "32")]
const _: [(); 1_164] = [(); mem::size_of::<Xd3Stream>()];
#[cfg(target_pointer_width = "32")]
const _: [(); 4] = [(); mem::align_of::<Xd3Stream>()];

unsafe extern "C" {
    #[cfg(test)]
    pub fn xd3_encode_memory(
        input: *const u8,
        input_size: UsizeT,
        source: *const u8,
        source_size: UsizeT,
        output_buffer: *mut u8,
        output_size: *mut UsizeT,
        avail_output: UsizeT,
        flags: c_int,
    ) -> c_int;

    pub fn xd3_decode_memory(
        input: *const u8,
        input_size: UsizeT,
        source: *const u8,
        source_size: UsizeT,
        output_buf: *mut u8,
        output_size: *mut UsizeT,
        avail_output: UsizeT,
        flags: c_int,
    ) -> c_int;

    pub fn xd3_encode_input(stream: *mut Xd3Stream) -> c_int;
    pub fn xd3_config_stream(stream: *mut Xd3Stream, config: *mut Xd3Config) -> c_int;
    pub fn xd3_close_stream(stream: *mut Xd3Stream) -> c_int;
    pub fn xd3_abort_stream(stream: *mut Xd3Stream);
    pub fn xd3_free_stream(stream: *mut Xd3Stream);
    pub fn xd3_set_source_and_size(
        stream: *mut Xd3Stream,
        source: *mut Xd3Source,
        source_size: XoffT,
    ) -> c_int;
    pub fn xd3_strerror(ret: c_int) -> *const c_char;
}

#[cfg(test)]
mod tests {
    use std::{mem::MaybeUninit, ptr};

    use super::{Xd3Config, Xd3Source, Xd3Stream};

    #[test]
    fn ffi_layout_matches_expected_prefix_offsets() {
        let stream = MaybeUninit::<Xd3Stream>::uninit();
        let stream_ptr = stream.as_ptr();
        assert_eq!(
            unsafe { ptr::addr_of!((*stream_ptr).next_out) as usize - stream_ptr as usize },
            24
        );
        assert_eq!(
            unsafe { ptr::addr_of!((*stream_ptr).avail_out) as usize - stream_ptr as usize },
            32
        );
        assert_eq!(
            unsafe { ptr::addr_of!((*stream_ptr).msg) as usize - stream_ptr as usize },
            56
        );
        assert_eq!(
            unsafe { ptr::addr_of!((*stream_ptr).flags) as usize - stream_ptr as usize },
            128
        );

        let config = MaybeUninit::<Xd3Config>::uninit();
        let config_ptr = config.as_ptr();
        assert_eq!(
            unsafe { ptr::addr_of!((*config_ptr).getblk) as usize - config_ptr as usize },
            16
        );
        assert_eq!(
            unsafe { ptr::addr_of!((*config_ptr).flags) as usize - config_ptr as usize },
            48
        );

        let source = MaybeUninit::<Xd3Source>::uninit();
        let source_ptr = source.as_ptr();
        assert_eq!(
            unsafe { ptr::addr_of!((*source_ptr).ioh) as usize - source_ptr as usize },
            16
        );
        assert_eq!(
            unsafe { ptr::addr_of!((*source_ptr).curblk) as usize - source_ptr as usize },
            48
        );
        assert_eq!(
            unsafe { ptr::addr_of!((*source_ptr).getblkno) as usize - source_ptr as usize },
            96
        );
    }
}
