#![expect(non_camel_case_types)]
#![allow(non_snake_case)]

pub use bzip2_sys;
pub use liblzma_sys;
pub use libz_sys;
pub use lz4_sys;
pub use zstd_sys;

#[cfg(all(not(target_vendor = "apple"), not(target_arch = "wasm32")))]
pub use openssl_sys;

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
