use super::nod_shared::nod_extract_only_handler;
use super::*;

nod_extract_only_handler!(
    NFS_NOD_CORE,
    NfsContainerHandler,
    &NFS,
    NodFormat::Nfs,
    RomWeaverError::Validation(
        "nfs compression is not supported; nfs can only be decompressed with `extract`".into(),
    )
);
