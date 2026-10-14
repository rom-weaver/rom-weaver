//! Disc file format related logic (CISO, NFS, WBFS, WIA, etc.)

pub(crate) mod block;
pub(crate) mod ciso;
#[cfg(feature = "compress-zlib")]
pub(crate) mod gcz;
pub(crate) mod iso;
pub(crate) mod nfs;
pub(crate) mod nkit;
pub(crate) mod split;
pub(crate) mod tgc;
pub(crate) mod wbfs;
pub(crate) mod wia;

pub(crate) fn resolve_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    // Browser WASI has no canonicalize syscall; its virtual filesystem validates paths on access.
    #[cfg(target_family = "wasm")]
    {
        Ok(path.to_path_buf())
    }
    #[cfg(not(target_family = "wasm"))]
    {
        std::fs::canonicalize(path)
    }
}
