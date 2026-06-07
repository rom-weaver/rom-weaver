use super::nod_shared::nod_extract_only_handler;
use super::*;

nod_extract_only_handler!(WBFS_NOD_CORE, WbfsContainerHandler, &WBFS, NodFormat::Wbfs);
